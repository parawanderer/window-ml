// WHICH LINE OF THE MODEL'S JS THREW.
//
// `exec` reported `e.message` and dropped the stack, so a JS failure said WHAT went wrong and never WHERE —
// on a twenty-line script that is most of the answer missing. Python has said which line for a while (it
// gets one from CPython); this is the same thing for the other half, and it is what feeds a clickable line
// into the rendered code, the same as a traceback frame.
//
// The awkward part is that the line in the stack is not the model's line: the source runs inside a wrapper,
// and `exec`'s two paths wrap it differently — an indirect `eval` inside a `Function`, or an
// `AsyncFunction` BODY when the source uses top-level await/return. The offsets are MEASURED at runtime
// rather than written down: a constant would be a guess about a wrapper whose shape depends on the
// parameter list, and it would drift silently with the engine rather than fail loudly.

/** The deepest frame inside the evaluated source, as a 1-based line — or null when the stack has none.
 *
 *  The first stack frame is the innermost. A V8 frame for evaluated code ends in `<anonymous>:LINE:COL`,
 *  and the same frame can mention `<anonymous>` more than once (`eval at <anonymous> (…), <anonymous>:3:6`),
 *  so it is the LAST match on the line that locates the code. */
export function rawEvalLine(stack: string | undefined): number | null {
    if (!stack) return null;
    for (const frame of stack.split("\n").slice(1)) {
        const all = [...frame.matchAll(/<anonymous>:(\d+):\d+/g)];
        if (all.length) return Number(all[all.length - 1][1]);
    }
    return null;
}

/**
 * The fast path's wrapper: `new Function(...params, …)` returning a CLOSURE that direct-evals the source, so the code
 * sees the parameters in scope. The closure is reachable by a page function the code calls (its `.caller`, or a stack
 * trace's `getFunction()`, the wrapper being sloppy), so it is ONE-SHOT: called again, it throws, and the page cannot
 * evaluate code of its own beside the collector, `state` and `ml`. Its `.caller.arguments` is only `src`, which
 * PAGE_TOOL_RUN already shows the page. `ran()` says whether the source started, so a SyntaxError it throws while it
 * runs is told from one it threw at parse time (only the second may be retried as an async body).
 * @param params the names the source sees (`state`, `ml`, `console`)
 * @returns a function taking their values, which returns the one-shot evaluator and its `ran`
 */
export function evalWrapper(params: string[]): (...values: unknown[]) => { run: (src: string) => unknown; ran: () => boolean } {
    const make = new Function(...params, `let __mlSpent = false, __mlRan = false;
return { run: function (src) { if (__mlSpent) throw new TypeError("spent"); __mlSpent = true; return eval("void (__mlRan = true);" + src); }, ran: () => __mlRan };`) as (...values: unknown[]) => { run: (src: string) => unknown; ran: () => boolean };
    return make;
}

/**
 * The async path's wrapper, for a source with top-level `await` or `return`: an async function whose body is the source
 * in a block of its own (so a `const console` in it does not collide with the parameter), made ONE-SHOT by a guard it
 * calls first, since a page function the code calls reaches it through `.caller` or `getFunction()`.
 * @param params the names the source sees
 * @param body the function body
 * @returns the async function, callable once
 */
export function asyncWrapper(params: string[], body: string): (...values: unknown[]) => Promise<unknown> {
    let spent = false;
    const guard = (): void => { if (spent) throw new TypeError("spent"); spent = true; };
    return (new Function("__mlGuard", `return async function (${params.join(", ")}) { __mlGuard(); {
${body}
} };`) as (g: () => void) => (...values: unknown[]) => Promise<unknown>)(guard);
}

// Memoised per (kind, parameter count): it is a property of the engine and the wrapper shape, never of the
// source, so it is measured once and reused for every later failure.
const offsets = new Map<string, number>();
/** A probe whose `throw` is on line 2, so a measured offset of zero is distinguishable from having failed
 *  to measure at all. */
const PROBE = "\nthrow new Error('ml-probe');";

/** How many lines the wrapper adds, measured by throwing from a known line inside the REAL construct — with
 *  the same parameter list the real call uses, since that is what the wrapper's own first line contains.
 *  Async because the async path's wrapper only throws when its promise is awaited. Returns 0 if the probe
 *  itself cannot be measured, which degrades to "the line as the engine reported it" rather than to a lie:
 *  `execErrorLine` refuses anything outside the source either way. */
export async function evalLineOffset(kind: "eval" | "async", params: string[]): Promise<number> {
    const key = `${kind}:${params.length}`;
    const known = offsets.get(key);
    if (known != null) return known;
    let measured = 0;
    try {
        if (kind === "eval") {
            evalWrapper(params)(...params.map(() => undefined)).run(PROBE);
        } else {
            await asyncWrapper(params, PROBE)(...params.map(() => undefined));
        }
    } catch (e) {
        const at = rawEvalLine((e as Error)?.stack);
        if (at != null) measured = at - 2;   // the probe throws on line 2 of the source it stands in for
    }
    offsets.set(key, measured);
    return measured;
}

/** The model's own line for a failure, or null when it cannot be known. Null is the honest answer: a wrong
 *  line number is worse than none, because the reader goes and looks at it, finds ordinary code, and
 *  concludes the tooling is broken rather than that the number was.
 *
 *  `lines` is how many lines the source has. A frame from INSIDE something the code called (a page library,
 *  a `ml.*` method) maps outside that range, and is refused for the same reason. */
export async function execErrorLine(
    stack: string | undefined, kind: "eval" | "async", params: string[], lines: number,
): Promise<number | null> {
    const raw = rawEvalLine(stack);
    if (raw == null) return null;
    const line = raw - await evalLineOffset(kind, params);
    return line >= 1 && line <= lines ? line : null;
}
