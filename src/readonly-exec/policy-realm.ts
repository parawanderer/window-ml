// policy-realm.ts — evaluating a policy: a function over one call's resolved facts, run in the dialect's `policy` realm.
//
// docs/spec/POLICIES.md, "The policy realm". A policy runs on every gated call, in the approval path, so it must be pure,
// must halt and must be unable to do anything but answer: it is a script of the read-only dialect, with no `ml`, no
// DOM and no clock, whose only root is `c`. `c` refuses a field it does not have, and `==`/`!=` are refused, so the two
// quiet mistakes that turn a rule into a grant (a typo'd field, a coercing compare) are a BROKEN policy instead. Anything
// that goes wrong is no opinion: a broken policy fails closed, and the caller stores the reason against it.

import { NotInDialect, Denied } from "./limits";
import { tokenize } from "./tokenizer";
import { Parser, Node } from "./parser";
import { Evaluator, runSync } from "./evaluator";
import { effectSet, EffectsData } from "../effects";

/** What a policy says about a call when it holds. */
export type PolicyEffect = "allow" | "deny";

/** One evaluation: the decision, or `undefined` for no opinion, and why the policy is broken when it is. */
export type PolicyResult = { decision: PolicyEffect | undefined; broken?: string };

/** The step budget of one policy evaluation. Policies run on every gated call, often several per call, so this is a
 *  fraction of a survey's: a predicate over an argv or an effect set uses a few hundred. */
export const POLICY_STEPS = 50_000;

/** How many parsed policies are kept, by source. A policy is parsed once and evaluated on every call. */
const PARSE_CACHE_SIZE = 256;

// state: cache — parses by source text; losing it costs a re-parse.
const parsed = new Map<string, { ast: Node } | { error: string }>();

/** Parse a policy once, caching the tree (or the parse error) by its source. */
function parse(source: string): Node {
    let hit = parsed.get(source);
    if (hit) { parsed.delete(source); parsed.set(source, hit); }   // most recently used last
    else {
        try {
            const ast = new Parser(tokenize(source)).parseProgram();
            // Refused when PARSED, not only when reached: a `==` on a branch most calls skip would otherwise leave the
            // policy looking sound until the one call that takes it. (The evaluator refuses it too, keyed on the realm.)
            const loose = findNode(ast, (n) => n.type === "Binary" && (n.op === "==" || n.op === "!="));
            hit = loose ? { error: `not allowed in a policy: ${loose.op} coerces; compare with ${loose.op}=` } : { ast };
        } catch (e) { hit = { error: reason(e) }; }
        parsed.set(source, hit);
        if (parsed.size > PARSE_CACHE_SIZE) parsed.delete(parsed.keys().next().value as string);
    }
    if ("error" in hit) throw new PolicyParseError(hit.error);
    return hit.ast;
}

/** A parse failure, carrying the reason already worded for the person. */
class PolicyParseError extends Error {}

/** The first node of the tree, in source order, that `pred` holds for. */
function findNode(node: unknown, pred: (n: Node) => boolean): Node | undefined {
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
        for (const x of node) { const f = findNode(x, pred); if (f) return f; }
        return undefined;
    }
    if (typeof (node as Node).type === "string" && pred(node as Node)) return node as Node;
    for (const v of Object.values(node)) { const f = findNode(v, pred); if (f) return f; }
    return undefined;
}

/** The text stored against a broken policy. */
function reason(e: unknown): string {
    if (e instanceof PolicyParseError) return e.message;
    if (e instanceof NotInDialect || e instanceof Denied) return `not allowed in a policy: ${e.message}`;
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return `threw ${String(e)}`;
}

/** The pure builtins a policy may use. No `ml`, no `document`, no `console`, no `Date` (the clock is not a fact of the
 *  call), no `Promise` (a policy answers synchronously). */
function policyRoot(): Record<string, unknown> {
    const root: Record<string, unknown> = Object.create(null);
    Object.assign(root, { Array, Object, JSON, Math, String, Number, Boolean, parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity });
    return root;
}

/** Build `c` from the consumer's facts: a deep, frozen copy whose every object and array is a STRICT facade, so
 *  reading a field the call does not have is a refusal. `effects`, when present, is the effect set's policy view
 *  (effects.ts), whose `has` and `uses` are the only callables `c` holds. The caller's facts are never touched. */
function buildFacade(ev: Evaluator, facts: Record<string, unknown>): Record<string, unknown> {
    const seen = new Map<object, object>();
    const copy = (v: unknown, depth: number): unknown => {
        if (typeof v === "function") throw new TypeError("a policy's facts are data: a function is not one");
        if (v === null || typeof v !== "object") return v;
        if (depth > 32) throw new TypeError("a policy's facts are nested too deeply");
        const got = seen.get(v);
        if (got) return got;
        if (Array.isArray(v)) {
            const a: unknown[] = [];
            seen.set(v, a);
            for (const x of v) a.push(copy(x, depth + 1));
            return Object.freeze(ev.markStrict(a));
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) throw new TypeError("a policy's facts are plain objects and arrays");
        const o: Record<string, unknown> = Object.create(null);
        seen.set(v, o);
        for (const k of Object.keys(v)) o[k] = copy((v as Record<string, unknown>)[k], depth + 1);
        return Object.freeze(ev.markStrict(o));
    };
    const { effects, ...rest } = facts;
    const c = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(rest)) c[k] = copy(rest[k], 1);
    if (effects !== undefined) {
        const s = effectSet(effects as EffectsData);
        const view: Record<string, unknown> = Object.create(null);
        Object.assign(view, { unknown: s.unknown, pairs: copy(s.pairs, 2), reads: copy(s.reads, 2), writes: copy(s.writes, 2), has: s.has, uses: s.uses });
        c.effects = Object.freeze(ev.markStrict(view));
    }
    return Object.freeze(ev.markStrict(c));
}

/**
 * Evaluate one policy over one call. `source` is a dialect script whose value is a function, `(c) => …`, returning
 * `true` when the policy holds (the answer is then `effect`) and `false` when it does not (no opinion). ANY other
 * outcome is no opinion plus `broken`: a parse or dialect refusal, a runtime throw, the step budget or call depth
 * spent, reading a field `c` does not have, `==`/`!=`, or a result that is not a boolean (`c.paths.length && …`
 * returns a number). The facts are copied, so nothing a policy does reaches them.
 */
export function evalPolicy(source: string, facts: Record<string, unknown>, effect: PolicyEffect = "allow",
    opts: { stepBudget?: number } = {}): PolicyResult {
    try {
        const ast = parse(source);
        const ev = new Evaluator(null, opts.stepBudget ?? POLICY_STEPS, "policy");
        const c = buildFacade(ev, facts);
        const fn = runSync(ev.eval(ast, Object.create(policyRoot())));
        const out = runSync(ev.callOwn(fn, [c]));
        if (typeof out !== "boolean") return { decision: undefined, broken: `returned ${out === null ? "null" : typeof out}, not true or false` };
        return { decision: out ? effect : undefined };
    } catch (e) {
        return { decision: undefined, broken: reason(e) };
    }
}
