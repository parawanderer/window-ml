// Line annotations for a rendered code block — the pure half of the "Explain" affordance in the panel.
// A utility model is shown the code AND what it produced, and answers with a note per interesting LINE;
// the panel draws those in the margin. Everything here is pure so it unit-tests without a browser: the
// prompt/schema construction, and the coercion of whatever the model actually returns into notes that can
// be drawn.
//
// WHY THE MARGIN, and why this file never touches the source: inserting a comment into the code would
// shift every line below it, which invalidates `py-format`'s line map and stops a traceback resolving
// (see src/line-map.ts). The annotation is drawn BESIDE the line and the source is byte-identical, so the
// code you read is still the code that ran.
import type { JsonSchema } from "../contract";

/** One margin note: which displayed line it is about, and the gloss. */
export interface LineNote { line: number; note: string; }

/** At most this many notes are drawn — past a handful the margin stops being a margin and the reader is
 *  just reading a second, less reliable copy of the program. */
export const MAX_NOTES = 8;
/** Per-note length cap. A note that wraps to three lines is an essay in a gutter. */
export const MAX_NOTE_CHARS = 120;

/** The reply shape the model is CONSTRAINED to (OpenAI strict mode: every property required, no extras).
 *  A free-text reply would have to be parsed out of prose, and a line number recovered by regex from prose
 *  is exactly the kind of confident-wrong number this whole subsystem exists to stop producing. */
export const NOTES_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        notes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    line: { type: "integer", description: "the line number, as numbered in the code given" },
                    note: { type: "string", description: "one short phrase about that line" },
                },
                required: ["line", "note"],
                additionalProperties: false,
            },
        },
    },
    required: ["notes"],
    additionalProperties: false,
};

/** The code as the model must see it: numbered EXACTLY as the panel draws it. The panel shows reflowed
 *  source (py-format / js-beautify), so numbering the original would have the annotator pointing at lines
 *  that moved — the note would land on the wrong row, silently. Number what is on screen. */
export const numberLines = (src: string): string =>
    src.split("\n").map((l, i) => `${i + 1}|${l}`).join("\n");

/** The utility-model call. `output` is what the code actually produced — with it the gloss can say what a
 *  line FOUND rather than what it would do, which is the whole reason this runs after the step and not on
 *  the approval card. */
export function notesMessages(lang: string, src: string, output?: string): { role: string; content: string }[] {
    const label = lang === "python" ? "Python" : "JavaScript";
    return [
        {
            role: "system",
            content: `You annotate ${label} for a reader skimming someone else's code. Pick at most ${MAX_NOTES} lines that are worth a note — the ones doing the real work, a subtle bit, or where it went wrong. Skip lines that read for themselves. Each note is one phrase under ${MAX_NOTE_CHARS} characters, no line number, no restating the syntax. Use the given line numbers exactly.`,
        },
        {
            role: "user",
            content: `Annotate this ${label}.\n\n${numberLines(src)}` + (output && output.trim() ? `\n\nIt produced:\n${output.slice(0, 600)}` : ""),
        },
    ];
}

/** Coerce a model reply into drawable notes. It is a MODEL's line numbers, so nothing here trusts them:
 *  a line outside the block is dropped rather than clamped (clamping invents a claim about a line the
 *  model never looked at), a repeat of a line already noted is dropped, and the whole thing is capped.
 *  Returns [] for anything unparseable — a failed annotation must degrade to "no notes", never to a
 *  wrong note beside real code. */
export function parseNotes(raw: string, lineCount: number): LineNote[] {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    // Some backends wrap the object in an array, or answer with the bare array.
    const obj = Array.isArray(parsed) ? { notes: parsed } : parsed;
    const arr = (obj && typeof obj === "object" ? (obj as { notes?: unknown }).notes : null);
    if (!Array.isArray(arr)) return [];
    const out: LineNote[] = [];
    const seen = new Set<number>();
    for (const it of arr) {
        if (!it || typeof it !== "object") continue;
        const rec = it as { line?: unknown; note?: unknown };
        const line = Math.trunc(Number(rec.line));
        const note = String(rec.note ?? "").trim().replace(/\s+/g, " ");
        if (!Number.isFinite(line) || line < 1 || line > lineCount) continue;
        if (!note || seen.has(line)) continue;
        seen.add(line);
        out.push({ line, note: note.length > MAX_NOTE_CHARS ? note.slice(0, MAX_NOTE_CHARS - 1).trimEnd() + "…" : note });
        if (out.length >= MAX_NOTES) break;
    }
    return out.sort((a, b) => a.line - b.line);
}

/** Notes as a lookup for the renderer. */
export const notesByLine = (notes: LineNote[]): Map<number, string> => new Map(notes.map(n => [n.line, n.note]));
