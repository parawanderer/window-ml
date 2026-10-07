// print.ts — the read-only survey's print boundary: how a large `ml.current` message row prints, and the notes that
// say where a printed view differs from the value.

/** Characters of text above which a message row prints as a summary (see `Evaluator.printable`). */
export const ABRIDGE_OVER = 300;

/** Characters of a large message's content shown in its summary. */
const ABRIDGE_PREVIEW = 120;

/** How a large message row PRINTS: what it is, how big, the start of it, and the exact expression that prints it all.
 *  Fields in the order a reader scans them; nothing padded, since a model reads it. */
export function abridgeRow(m: Record<string, unknown>, index: number): unknown {
    const content = typeof m.content === "string" ? m.content : "";
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : null;
    const callsText = calls ? JSON.stringify(calls) : "";
    const chars = content.length + callsText.length;
    if (chars <= ABRIDGE_OVER) return m;
    const images = Array.isArray(m.images) ? m.images.length : 0;
    // Point at the part that is LARGE. A tool-calling assistant turn often has empty content and long arguments, and
    // "print .content for all 0 chars" (what this said first, caught by the demo) sends the reader to nothing.
    const [part, text] = content.length >= callsText.length ? ["content", content] : ["tool_calls", callsText];
    return {
        role: m.role,
        ...(typeof m.tool_call_id === "string" ? { tool_call_id: m.tool_call_id } : {}),
        ...(calls ? { tool_calls: calls.length } : {}),
        ...(images ? { images } : {}),
        chars,
        preview: text.length > ABRIDGE_PREVIEW ? `${text.slice(0, ABRIDGE_PREVIEW)}…` : text,
        abridged: `print ml.current.messages[${index}].${part} for all ${text.length} chars`,
    };
}

/** One substitution the print boundary made: WHERE (a JSONPath into what was printed) and HOW the printed object
 *  differs from the value. Derived, never written: see `Evaluator.printable`. */
export interface PrintSwap {
    path: string; removed: string[]; added: string[]; retyped: { key: string; was: string; now: string }[];
    /** What was printed: `console.log` (with its argument number when there were several) or the returned value. */
    where: string;
    /** The view's compact JSON, exactly as it appears in the printed text, so a caller that CUTS the text can tell
     *  whether the reader saw this substitution at all, and say nothing about one it did not. */
    json: string;
}

/** A JSONPath member step for a key: `.name` when it is an identifier, else bracket notation (RFC 9535). */
export function jsonPathKey(k: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k).replace(/^"|"$/g, "'")}]`;
}

/** Several keys at one place, as a JSONPath: one is a member step, more are a bracketed union. */
function jsonPathKeys(keys: string[]): string {
    return keys.length === 1 ? jsonPathKey(keys[0]) : `[${keys.map((k) => `'${k.replace(/'/g, "\\'")}'`).join(",")}]`;
}

const kindName = (x: unknown): string => x === null ? "null" : Array.isArray(x) ? "array" : typeof x;

/** "an array", "a number": the notes are read by a model, and "a array" reads as a slip. */
const article = (kind: string): string => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

/** How a printed view differs from the value it stands for, field by field. */
export function diffSwap(path: string, before: Record<string, unknown>, after: Record<string, unknown>, where: string): PrintSwap {
    const removed = Object.keys(before).filter((k) => !(k in after));
    const added = Object.keys(after).filter((k) => !(k in before));
    const retyped = Object.keys(before).filter((k) => k in after && kindName(before[k]) !== kindName(after[k]))
        .map((k) => ({ key: k, was: kindName(before[k]), now: kindName(after[k]) }));
    return { path, removed, added, retyped, where, json: safeStr(after) };
}

/** The notes a reader gets for a print's substitutions: one line per KIND of change, its places as one JSONPath
 *  (`$[0,3]` when they are siblings, else listed), so the model can tell exactly which parts of what it was shown are
 *  a view and not the value. `where` says what was printed (`console.log` or the returned value). */
export function describeSwaps(swaps: readonly PrintSwap[]): string[] {
    const groups = new Map<string, { swap: PrintSwap; paths: string[] }>();
    for (const sw of swaps) {
        const sig = JSON.stringify([sw.where, sw.removed, sw.added, sw.retyped]);
        const g = groups.get(sig);
        if (g) g.paths.push(sw.path); else groups.set(sig, { swap: sw, paths: [sw.path] });
    }
    return [...groups.values()].map(({ swap, paths }) => {
        // One path when the places are siblings at ONE index (`$[0,3]`, `$[0,3].m`), else each place in full: a key
        // appended to a LIST of paths would attach to the last one only, and the others would be wrong JSONPath.
        const union = unionPath(paths);
        // Listed places are capped like a union's indices are (see indexSelector): the notes sit AFTER the clip, so
        // an uncapped list would flood exactly the output the clip protects.
        const listed = paths.length > MAX_NOTE_PLACES ? paths.slice(0, MAX_NOTE_PLACES) : paths;
        const more = union ? "" : paths.length > listed.length ? ` (${paths.length} places; the first ${listed.length} named)` : "";
        const at = (suffix: string) => union ? `${union}${suffix}` : listed.map((p) => `${p}${suffix}`).join(", ") + more;
        const replaced = [
            ...(swap.removed.length ? [at(jsonPathKeys(swap.removed))] : []),
            ...swap.retyped.map((r) => `${at(jsonPathKey(r.key))} (${article(r.was)} in the value, ${article(r.now)} here)`),
        ];
        const virtual = swap.added.length ? `virtual ${at(jsonPathKeys(swap.added))}` : "";
        return `[${swap.where} printed a VIEW: ${replaced.join(" and ") || at("")} REPLACED by ${virtual || "a summary"}; the value is unchanged, so print a path to see it]`;
    });
}

/** Paths that are the same except for ONE array index, as one JSONPath with a union there (`$[0].m` and `$[3].m` →
 *  `$[0,3].m`). Null when they differ in any other way. */
function unionPath(paths: readonly string[]): string | null {
    const segs = paths.map((p) => p.match(/^\$|\[\d+\]|\.[A-Za-z_$][\w$]*|\['(?:[^'\\]|\\.)*'\]/g) ?? []);
    if (paths.length === 1) return paths[0];
    if (segs.some((s) => s.join("") !== paths[segs.indexOf(s)] || s.length !== segs[0].length)) return null;
    const differ = segs[0].map((_, i) => segs.some((s) => s[i] !== segs[0][i]));
    if (differ.filter(Boolean).length !== 1) return null;
    const at = differ.indexOf(true);
    if (!segs.every((s) => /^\[\d+\]$/.test(s[at]))) return null;
    return [...segs[0].slice(0, at), indexSelector(segs.map((s) => Number(s[at].slice(1, -1)))), ...segs[0].slice(at + 1)].join("");
}

/** Places a note will name, at most, before it says how many it left out. */
const MAX_NOTE_PLACES = 8;

/** Array indices as ONE bracketed JSONPath selection (RFC 9535), as short as it can be said exactly: a run of three or
 *  more at a constant step is a slice (`0:40`, `0:200:2`), the rest are listed. If that still has more than
 *  MAX_NOTE_PLACES parts, the first ones are named and the count says how many there were, so a context of 200 summarised
 *  messages cannot turn a one-line note into a flood. */
function indexSelector(nums: number[]): string {
    const xs = [...new Set(nums)].sort((a, b) => a - b);
    const parts: string[] = [];
    for (let i = 0; i < xs.length;) {
        let j = i + 1;
        const step = xs[i + 1] - xs[i];
        while (j < xs.length && xs[j] - xs[j - 1] === step) j++;
        if (j - i >= 3) { parts.push(step === 1 ? `${xs[i]}:${xs[j - 1] + 1}` : `${xs[i]}:${xs[j - 1] + 1}:${step}`); i = j; }
        else { parts.push(String(xs[i])); i++; }
    }
    if (parts.length <= MAX_NOTE_PLACES) return `[${parts.join(",")}]`;
    return `[${parts.slice(0, MAX_NOTE_PLACES).join(",")}] (${xs.length} places; the first of them named)`;
}

/** JSON for a printed value, falling back to `String` for what JSON cannot hold (a cycle, a BigInt). */
export function safeStr(x: unknown): string { try { return JSON.stringify(x); } catch { return String(x); } }
