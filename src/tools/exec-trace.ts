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
    return rawEvalPos(stack)?.line ?? null;
}

/** The same frame as {@link rawEvalLine}, with its 1-based column.
 * @param stack the error's stack
 * @returns the line and column, or null when the stack has no frame in the evaluated source */
export function rawEvalPos(stack: string | undefined): { line: number; col: number } | null {
    if (!stack) return null;
    for (const frame of stack.split("\n").slice(1)) {
        const all = [...frame.matchAll(/<anonymous>:(\d+):(\d+)/g)];
        if (all.length) { const m = all[all.length - 1]; return { line: Number(m[1]), col: Number(m[2]) }; }
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

// The column shift is only on line 1, where the fast path's wrapper prepends `void (__mlRan = true);` to the source.
// Measured the same way as the line offset, and memoised beside it.
const colOffsets = new Map<string, number | null>();   // state: cache
/** A probe on line 1 whose error is constructed at column 7 (the `new`), where V8 places the frame. */
const COL_PROBE = "throw new Error('ml-probe');";

/**
 * How many columns the wrapper adds to LINE 1 of the source, measured by throwing from a known column inside the
 * real construct.
 * @param kind which wrapper the call used
 * @param params the parameter list the call used
 * @returns the shift, or null when the probe could not be measured (then no column on line 1 is trusted)
 */
export async function evalColOffset(kind: "eval" | "async", params: string[]): Promise<number | null> {
    const key = `${kind}:${params.length}`;
    if (colOffsets.has(key)) return colOffsets.get(key) ?? null;
    let measured: number | null = null;
    try {
        if (kind === "eval") evalWrapper(params)(...params.map(() => undefined)).run(COL_PROBE);
        else await asyncWrapper(params, COL_PROBE)(...params.map(() => undefined));
    } catch (e) {
        const at = rawEvalPos((e as Error)?.stack);
        if (at) measured = at.col - 7;
    }
    colOffsets.set(key, measured);
    return measured;
}

/** A line longer than this gets a piece of itself in the error: past it, a line number no longer says where. */
const EXCERPT_FROM = 100;
/** How much of the line the piece keeps on each side of the failure. */
const EXCERPT_SIDE = 40;

/**
 * Where on a LONG line a failure is, as a short piece of the line with `▶` before the failing spot. Models read
 * tokens, not characters, so a column number is no use to them; the code around it is. A short line needs nothing
 * past its number.
 * @param line the source line that failed
 * @param col its 1-based column
 * @returns the piece, or null for a short line or a column outside it
 */
export function lineExcerpt(line: string, col: number): string | null {
    if (line.length <= EXCERPT_FROM || col < 1 || col > line.length) return null;
    const i = col - 1, start = Math.max(0, i - EXCERPT_SIDE), end = Math.min(line.length, i + EXCERPT_SIDE);
    const piece = `${line.slice(start, i)}▶${line.slice(i, end)}`.replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${piece}${end < line.length ? "…" : ""}`;
}

/**
 * The piece of the model's own line that failed, for a long line ({@link lineExcerpt}); null whenever the column
 * cannot be known, for the reason {@link execErrorLine} gives a null line.
 * @param stack the error's stack
 * @param kind which wrapper the call used
 * @param params the parameter list the call used
 * @param src the model's source
 * @returns the piece, or null
 */
export async function execErrorExcerpt(
    stack: string | undefined, kind: "eval" | "async", params: string[], src: string,
): Promise<string | null> {
    const raw = rawEvalPos(stack);
    if (!raw) return null;
    const lines = src.split("\n");
    const line = raw.line - await evalLineOffset(kind, params);
    if (line < 1 || line > lines.length) return null;
    let col = raw.col;
    if (line === 1) { const shift = await evalColOffset(kind, params); if (shift == null) return null; col -= shift; }
    return lineExcerpt(lines[line - 1], col);
}

/**
 * Where a read-only survey threw, as the interpreter stamped it on the error (`mlLine`, `mlExcerpt`): the suffix the
 * error text carries, and the line for the rendered code.
 * @param e what the survey threw
 * @returns the line (or null) and the text to append to the error's message
 */
export function surveyWhere(e: unknown): { at: number | null; where: string } {
    const { mlLine, mlExcerpt } = (e ?? {}) as { mlLine?: number; mlExcerpt?: string };
    const at = mlLine || null;
    return { at, where: `${at ? ` (line ${at})` : ""}${at && mlExcerpt ? `\nat: ${mlExcerpt}` : ""}` };
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
