// Reading a JSON value whose TEXT was cut short. A tool's value is clipped for the UI (`clipOut` appends
// `… [+N chars truncated]`), so the most interesting outputs are exactly the ones `JSON.parse` refuses. This keeps
// every value that arrived WHOLE and closes whatever was still open at the cut, so the sidebar can draw a tree of
// the part that exists. Pure, so it is tested directly.

/** The note `clipOut` (dom.ts) appends to a clipped string. */
const CLIP_NOTE = /… \[\+(\d+) chars truncated\]$/;

/** A parsed (possibly repaired) JSON container. */
export interface LooseJson {
    /** The object or array, closed at the last value that arrived whole when the text was cut. */
    value: object;
    /** Characters dropped after the text, from the clip note; null when there was no note. */
    droppedChars: number | null;
    /** True when the text was not valid JSON on its own and had to be closed. */
    repaired: boolean;
    /** Keys from the root to the innermost container still open at the cut (empty: the root itself). Null when
     *  nothing was open, i.e. the text was whole. */
    cutPath: (string | number)[] | null;
}

// `at`: this container's key or index in its parent. `lastKey`: the key most recently read inside it.
type Frame = { close: "}" | "]"; at: string | number | null; lastKey: string | null; expectKey: boolean; count: number };

/**
 * Parse `text` as a JSON object or array, repairing a cut-off tail. Returns null for anything that is not a
 * container (a scalar, prose, a Python repr): there is no tree to draw for those.
 *
 * The repair never invents a value. It walks the text once, remembers the last point at which every value
 * so far was complete (just after a value, or just after an opening bracket), cuts there, and appends the
 * closing brackets that were open at that point. A string, number or key cut in half is dropped whole.
 *
 * @param text The value's text, optionally ending in `clipOut`'s note.
 * @returns The container, or null when the text is not (the start of) a JSON object or array.
 */
export function parseLooseJson(text: string): LooseJson | null {
    const note = CLIP_NOTE.exec(text);
    const body = note ? text.slice(0, note.index) : text;
    const droppedChars = note ? Number(note[1]) : null;
    const start = body.search(/\S/);
    if (start < 0 || (body[start] !== "{" && body[start] !== "[")) return null;
    try {
        const v = JSON.parse(body);
        return v && typeof v === "object" ? { value: v, droppedChars, repaired: false, cutPath: null } : null;
    } catch { /* cut short, or not JSON at all: try to close it */ }

    const stack: Frame[] = [];
    let safeAt = -1, safeStack: Frame[] = [];
    const markSafe = (at: number): void => { safeAt = at; safeStack = stack.map(f => ({ ...f })); };
    // A value finished at `at`: the enclosing container has one more member, and everything so far is whole.
    const valueDone = (at: number): void => {
        const top = stack[stack.length - 1];
        if (top) top.count++;
        markSafe(at);
    };
    let i = start;
    while (i < body.length) {
        const c = body[i];
        const top = stack[stack.length - 1];
        if (c === " " || c === "\n" || c === "\r" || c === "\t") { i++; continue; }
        if (c === "{" || c === "[") {
            // The member this container occupies in its parent: a key read earlier, or the next array index.
            const at = top ? (top.close === "}" ? top.lastKey : top.count) : null;
            stack.push({ close: c === "{" ? "}" : "]", at, lastKey: null, expectKey: c === "{", count: 0 });
            markSafe(i + 1);
            i++; continue;
        }
        if (c === "}" || c === "]") {
            if (!top || top.close !== c) return null;   // mismatched: not JSON, so do not pretend
            stack.pop();
            valueDone(i + 1);
            i++; continue;
        }
        if (c === ",") { if (top) top.expectKey = top.close === "}"; i++; continue; }
        if (c === ":") { if (top) top.expectKey = false; i++; continue; }
        if (c === "\"") {
            let j = i + 1;
            while (j < body.length && body[j] !== "\"") j += body[j] === "\\" ? 2 : 1;
            if (j >= body.length) break;   // the cut is inside this string: drop it
            if (top && top.close === "}" && top.expectKey) {
                try { top.lastKey = JSON.parse(body.slice(i, j + 1)); } catch { return null; }
            } else valueDone(j + 1);
            i = j + 1; continue;
        }
        const lit = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(body.slice(i, i + 64));
        if (!lit) {
            // The cut is inside a literal (`fal`, `-`, `1e`): drop it. Anything else is not JSON.
            if (/^(-?[\d.eE+-]*|t(r(u)?)?|f(a(l(s)?)?)?|n(u(l)?)?)$/.test(body.slice(i))) break;
            return null;
        }
        const end = i + lit[0].length;
        if (end >= body.length) break;   // a number at the very end may be missing digits: drop it
        valueDone(end);
        i = end;
    }
    if (safeAt < 0 || !safeStack.length) return null;
    // Where each container open at the cut sits in its parent. The root has no parent.
    const cutPath = safeStack.slice(1).map(f => f.at as string | number);
    const closed = body.slice(0, safeAt) + safeStack.map(f => f.close).reverse().join("");
    try {
        const v = JSON.parse(closed);
        return v && typeof v === "object" ? { value: v, droppedChars, repaired: true, cutPath } : null;
    } catch { return null; }
}
