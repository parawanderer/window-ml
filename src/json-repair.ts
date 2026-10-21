// Reading a JSON value whose TEXT was cut short. A tool's value is clipped for the UI (`clipOut` appends
// `… [first K of M chars]`), so the most interesting outputs are exactly the ones `JSON.parse` refuses. This keeps
// every value that arrived WHOLE and closes whatever was still open at the cut, so the sidebar can draw a tree of
// the part that exists. Pure, so it is tested directly.

/** The note `clipOut` (dom.ts) appends to a clipped string, in BOTH its forms: `[first K of M chars]` now, and
 *  `[+N chars truncated]` before 2026-10-06, which saved sessions and exports still hold. */
const CLIP_NOTE = /… \[(?:\+(\d+) chars truncated|first (\d+) of (\d+) chars)\]$/;

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
    /** With `keepOpenString`: the text was cut inside a string VALUE, which is kept as far as it arrived (the last
     *  member at `cutPath`). Absent otherwise. */
    openString?: true;
}

/** How to read the cut. */
export interface LooseJsonOptions {
    /** Keep a string VALUE cut in half, as far as it arrived, rather than dropping it. For text that is still being
     *  WRITTEN (a tool call's arguments as the model streams them), where the half-written string is the news; a
     *  clipped value keeps the default, since its cut string is a fragment of something that will never arrive.
     *  A half-written escape at the very end is held back, and a half-written KEY is still dropped. */
    keepOpenString?: boolean;
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
 * @param opts {@link LooseJsonOptions}.
 * @returns The container, or null when the text is not (the start of) a JSON object or array.
 */
export function parseLooseJson(text: string, opts: LooseJsonOptions = {}): LooseJson | null {
    const note = CLIP_NOTE.exec(text);
    const body = note ? text.slice(0, note.index) : text;
    const droppedChars = !note ? null : note[1] != null ? Number(note[1]) : Number(note[3]) - Number(note[2]);
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
            if (j >= body.length) {
                // The cut is inside this string: drop it, unless it is a value the caller wants kept as it stands.
                if (opts.keepOpenString && top && !(top.close === "}" && top.expectKey)) {
                    const kept = closeOpenString(body.slice(i + 1));
                    if (kept == null) break;
                    const at = top.close === "}" ? top.lastKey : top.count;
                    const cutPath = stack.slice(1).map(f => f.at as string | number);
                    const closed = body.slice(0, i) + JSON.stringify(kept) + stack.map(f => f.close).reverse().join("");
                    try {
                        const v = JSON.parse(closed);
                        if (v && typeof v === "object" && at != null) return { value: v, droppedChars, repaired: true, cutPath, openString: true };
                    } catch { /* fall back to dropping it */ }
                }
                break;
            }
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

/** The decoded text of a string whose closing quote has not arrived: `raw` is everything after the opening quote. A
 *  trailing escape still being written (`\`, `\u00`) is held back until its next characters decide it. Null when the
 *  text is not a JSON string's inside at all. */
function closeOpenString(raw: string): string | null {
    const m = /\\(u[0-9a-fA-F]{0,3})?$/.exec(raw);
    // An even run of backslashes before the match is escaped backslashes, not an open escape.
    let body = raw;
    if (m) {
        let n = 0;
        for (let k = m.index - 1; k >= 0 && raw[k] === "\\"; k--) n++;
        if (n % 2 === 0) body = raw.slice(0, m.index);
    }
    try { return JSON.parse(`"${body}"`); } catch { return null; }
}
