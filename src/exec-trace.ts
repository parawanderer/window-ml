// WHICH LINE OF THE MODEL'S JS THREW.
//
// `exec` reported `e.message` and dropped the stack, so a JS failure said WHAT went wrong and never WHERE —
// on a twenty-line script that is most of the answer missing. Python has said which line for a while; this
// is the same thing for the other half, and it is what feeds the line map into the rendered code.
//
// The awkward part is that the line number in the stack is not the model's line number: the source runs
// inside a wrapper, and each of `exec`'s two paths wraps it differently (an indirect `eval` inside a
// `Function`, or an `AsyncFunction` body when the source uses top-level await/return). The offsets are
// MEASURED at runtime rather than written down — a constant would be a guess about a wrapper whose shape
// depends on the parameter list, and would drift silently with the engine.

/** The deepest frame inside the evaluated source, as a 1-based line — or null when the stack has none.
 *
 *  The first stack frame is the innermost. A V8 frame for evaluated code ends in `<anonymous>:LINE:COL`,
 *  and the same frame can mention `<anonymous>` more than once (`eval at <anonymous> (…), <anonymous>:3:6`),
 *  so it is the LAST match on that line that locates the code. */
export function rawEvalLine(stack: string | undefined): number | null {
    if (!stack) return null;
    for (const frame of stack.split("\n").slice(1)) {
        const all = [...frame.matchAll(/<anonymous>:(\d+):\d+/g)];
        if (all.length) return Number(all[all.length - 1][1]);
    }
    return null;
}

/** How many lines the wrapper adds, measured by throwing from a known line inside the real construct.
 *  Memoised: it is a property of the engine and the wrapper, not of the source. */
const offsets = new Map<string, number>();
export function evalLineOffset(kind: "eval" | "async", params: string[]): number {
    const key = `${kind}:${params.length}`;
    const known = offsets.get(key);
    if (known != null) return known;
    // A probe whose throw is on line 2, so an offset of zero is distinguishable from a failure to measure.
    const probe = "\nthrow new Error('probe');";
    let measured = 0;
    try {
        if (kind === "eval") new Function("src", "return eval(src);")(probe);
        else {
            const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as { new (...a: string[]): (...a: unknown[]) => Promise<unknown> };
            // Constructed AND called: an AsyncFunction body only throws when awaited, and the stack we need
            // is the one from the rejection.
            throw new AsyncFunction(...params, probe);   // replaced below — see the catch
        }
    } catch (e) {
        if (typeof e === "function") {
            // The async path: run it and measure from the rejection, synchronously unavailable — so fall
            // back to the difference the construct is KNOWN to add and correct it on the first real error.
            measured = offsets.get(key) ?? 0;
        } else {
            const at = rawEvalLine((e as Error)?.stack);
            measured = at != null ? at - 2 : 0;   // the probe throws on line 2
        }
    }
    offsets.set(key, measured);
    return measured;
}

/** Teach the offset from a real failure whose true line is known. Used by the async path, where the wrapper
 *  cannot be probed synchronously. */
export function learnOffset(kind: "eval" | "async", params: string[], reported: number, actual: number): void {
    offsets.set(`${kind}:${params.length}`, reported - actual);
}

/** The model's own line for a failure, or null when it cannot be known. Null is the honest answer: a wrong
 *  line number is worse than none, because the reader goes and looks at it. */
export function execErrorLine(stack: string | undefined, offset: number, lines: number): number | null {
    const raw = rawEvalLine(stack);
    if (raw == null) return null;
    const line = raw - offset;
    // Outside the source is not a line of it — a frame from inside a library the code called, or an offset
    // that did not apply. Refuse rather than point somewhere.
    return line >= 1 && line <= lines ? line : null;
}
