// A tiny, dependency-free interpreter for the READ-ONLY `exec` dialect — the
// stereotypical DOM surveys the agent writes constantly:
//
//   Array.from(document.querySelectorAll('input')).filter(el => …).map(el => ({…}))
//
// It walks an AST we parse ourselves and calls real methods by reflection, so
// (1) it is the whitelist — only the modeled dialect runs; (2) it NEVER compiles
// a string, so Trusted Types (`require-trusted-types-for 'script'`) is bypassed;
// (3) it is safe by MEDIATION — every property read is denylisted and every call
// is allowlisted to read/query/pure methods, so the auto-approved path can read
// the DOM and compute but call nothing with an effect. `window`/`fetch`/`Function`
// are never in scope and are unreachable through the object graph.
//
// Anything outside the dialect throws `NotInDialect`; any blocked access throws
// `Denied`. Callers treat BOTH as "fall back to the normal approval + eval path"
// — safe because the interpreter is side-effect-free, so a failed attempt does
// nothing observable. See docs/spec/READONLY_EXEC_SPEC.md.
//
// The evaluator is a GENERATOR: `yield`ing a value asks the driver to await it, so
// `await` works (the agent's own read-only `ml` introspection is async). There are two
// drivers — `runAsync` at the top level, and `runSync` for the arrows a host method
// invokes (`.map`/`.filter` call their callback synchronously, so an `await` in there
// can't be honoured and throws NotInDialect → the whole survey falls back to approval).
//
// This file is the ENTRY (`evalReadonly`) and re-exports the public names; the pieces live in readonly-exec/:
// limits.ts (refusals + halting bounds), tokenizer.ts, parser.ts, policy.ts (what may be read/called/built + the
// `ml` facade), print.ts (the print boundary) and evaluator.ts (the evaluator + its two drivers).
import type { CurrentSnapshot } from "./current-context";   // a TYPE: erased, so it adds nothing at runtime
import { NotInDialect, Denied, NeedsPage } from "./readonly-exec/limits";
import { tokenize } from "./readonly-exec/tokenizer";
import { Parser } from "./readonly-exec/parser";
import { ReadonlyRealm, mlFacade } from "./readonly-exec/policy";
import { PrintSwap, safeStr } from "./readonly-exec/print";
import { Evaluator, runAsync } from "./readonly-exec/evaluator";

export { NotInDialect, Denied, NeedsPage, STEP_BUDGET, MAX_COLLECTION, MAX_STORED_CELLS, MAX_STRING, MAX_CALL_DEPTH, PIPE_CHARS_PER_STEP, riskyRegex } from "./readonly-exec/limits";
export { ML_READONLY_METHODS } from "./readonly-exec/policy";
export type { ReadonlyRealm } from "./readonly-exec/policy";
export { ABRIDGE_OVER, describeSwaps } from "./readonly-exec/print";
export type { PrintSwap } from "./readonly-exec/print";

// -------------------------------------------------------------------- entry ---

/**
 * Evaluate a read-only survey. `document` and the read-only slice of `ml`
 * ({@link ML_READONLY_METHODS}, omitted when `ml` is absent) are the only host objects
 * injected; all other globals are this module's own (safe) intrinsics. Returns the
 * program value plus any captured console output. Rejects with NotInDialect / Denied on
 * anything outside the dialect or blocked — callers fall back to approval+eval.
 *
 * @param opts.checkpoint Called before the survey runs; returns a function that undoes whatever the survey changed
 *   through `answerFacade`. Called when the survey fails, so a fall-back to approval starts from where it began.
 * @param opts.stepBudget Overrides {@link STEP_BUDGET} — for tests, which exercise the same mechanism at a size that
 *   does not cost seconds per case.
 */
export async function evalReadonly(code: string, doc: Document | null, ml?: unknown, answerFacade?: unknown,
    opts: { checkpoint?: () => () => void; stepBudget?: number; realm?: ReadonlyRealm; current?: CurrentSnapshot } = {}): Promise<{ value: unknown; logs: string[]; reused: string[]; prints: { console: PrintSwap[]; value: PrintSwap[] } }> {
    const realm: ReadonlyRealm = opts.realm ?? "page";
    const logs: string[] = [];
    // Printed through the evaluator's print boundary once it exists (it abridges `ml.current.messages` rows).
    let printable: (v: unknown, swaps: PrintSwap[], where: string) => unknown = (v) => v;
    // What the print boundary changed, STRUCTURED. The caller writes the notes (`describeSwaps`), because only it knows
    // where it will cut the output: a note about a part the reader never received is noise.
    const prints: { console: PrintSwap[]; value: PrintSwap[] } = { console: [], value: [] };
    // A statement, not an expression: it returned `logs.push`'s count, so a survey ending in `console.log(…)` had the
    // VALUE 1 (seen in the ml.current demo) where JavaScript gives `undefined`.
    const rec = (...a: unknown[]): void => {
        logs.push(a.map((x, i) => {
            if (typeof x === "string") return x;
            return safeStr(printable(x, prints.console, a.length > 1 ? `console.log argument ${i + 1}` : "console.log"));
        }).join(" "));
    };
    const reused: string[] = [];   // ml.fetch cache hits — URLs this survey re-read from a prior approval
    // The pipe charges the step budget, which lives on the evaluator built below: the meter forwards to it once it exists.
    let charge: (steps: number) => void = () => {};
    let facade = mlFacade(ml, reused, answerFacade, { charge: (n) => charge(n) }, realm);
    if (!facade && opts.current) facade = Object.create(null);
    const root: Record<string, unknown> = Object.create(null);
    Object.assign(root, {
        Array, Object, JSON, Math, String, Number, Boolean, Promise,
        parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
        console: { log: rec, info: rec, warn: rec, error: rec, debug: rec },
    });
    if (facade) root.ml = facade;
    if (realm === "worker") {
        // THE PAGE'S ROOTS ARE TRIPWIRES in the worker: the name exists, so `in` finds it, and READING it defers the
        // survey to the page. The worker has no DOM, and the page has no run context, so a survey that needs both
        // trips here and is refused there: it reaches the human whatever order it touches them in.
        for (const name of ["document", "getComputedStyle"])
            Object.defineProperty(root, name, { enumerable: true, get() { throw new NeedsPage(`'${name}' is the page's`); } });
    } else {
        root.document = doc;
        // getComputedStyle bound to the view (never exposed itself, so calling it can't hand back `window`).
        // Its CSSStyleDeclaration reads are mediated like any other object; the walk-back to window is denied.
        const view = doc?.defaultView;
        if (view && typeof view.getComputedStyle === "function") root.getComputedStyle = view.getComputedStyle.bind(view);
    }
    const ast = new Parser(tokenize(code)).parseProgram();
    // THE SCRIPT GETS ITS OWN FRAME over the host's. `root` is where `document`, `ml` and `Math` live and it has a
    // null prototype, which is what marks a name as the environment's rather than the script's — so the script
    // must not declare INTO it, or its own top-level `let` would be indistinguishable from `document` and could
    // not be assigned to. (Shadowing a host name is then possible and harmless: `const document = …` writes to
    // the child, the host binding is untouched, and nothing outside the evaluator can see either.)
    const top: Record<string, unknown> = Object.create(root);
    // A FAILED ATTEMPT LEAVES NOTHING BEHIND. That is what makes trying the interpreter first safe, and `ml.answer`
    // is the one thing a survey can change: an add before a fall-back would outlive it, and the human would then be
    // asked to approve a script whose first half had already run. The caller's checkpoint restores it.
    const restore = opts.checkpoint?.();
    const ev = new Evaluator(facade, opts.stepBudget, realm);
    charge = (n) => ev.spend(n);
    if (opts.current && facade) facade.current = ev.adoptCurrent(opts.current);
    printable = (v, swaps, where) => ev.printable(v, swaps, where);
    try {
        const value = await runAsync(ev.eval(ast, top));
        return { value: ev.printable(value, prints.value, "the returned value"), logs, reused, prints };
    } catch (e) {
        restore?.();
        // WHERE it threw, for a RUNTIME error. A refusal is about the script's shape and needs no line; a
        // throw is about one statement, and "line 4" is the difference between a targeted fix and a rewrite
        // — which the model used to get for free, because a throwing survey escalated and the approved path
        // read the line off a real stack. It is answered here now, so the line has to come from here.
        if (!(e instanceof NotInDialect) && !(e instanceof Denied) && e instanceof Error && ev.line) {
            (e as Error & { mlLine?: number }).mlLine = ev.line;
        }
        throw e;
    }
}
