// The POINTER layer behind `dereference`: what a `@tool:<id>` token points at, and how to read part of it.
//
// The pipe language itself is NOT here — it is `text-pipe.ts`, the existing modeled bash sub-dialect
// (grep · head · tail · wc · sort · uniq, plus the structural keys · values · schema · type · `.path` stages
// added for this). This module adds only what a POINTER knows that a bare string doesn't:
//
//   • its TYPE (a table, an image, code, JSON, text) — so `keys` on a DataFrame means its COLUMNS, and the
//     model is told what it is holding before it decides how to slice it;
//   • WHEN it was captured — a pointer aliases a snapshot with no invalidation, so a DOM survey still resolves
//     long after the page changed under it. Every read says how old it is;
//   • two type-level casts the line dialect cannot express: `latex` and `img`.
//
// Pure: no DOM, no chrome, no I/O.

import { runPipe } from "./text-pipe";

/** The tool name, shared by the loop (which answers it) and the toolset builder (which advertises it). */
export const DEREF_TOOL = "dereference";

/** What the value at a pointer actually IS. The loop already knows — it holds the step's `RenderDescriptor` —
 *  so the pointer carries the type rather than flattening everything to a string the model must re-sniff. The
 *  value stays str-renderable regardless (`out` is always readable); the type just makes the pipe smarter. */
export type TokenKind = "text" | "json" | "table" | "image" | "code";

export interface TokenValue {
    id: string;
    tool: string;
    kind: TokenKind;
    /** Str-renderable: what the model saw, or would see. Always present, whatever the kind. */
    out: string;
    /** The call/arguments — what `@tool:<id>:in` reads. */
    in?: string;
    /** The structural value when there is one, so the pipe needn't reparse a rendered grid. */
    table?: { columns: string[]; rows: unknown[][] };
    /** A `data:image/…;base64,…` URL when the step produced an image. */
    image?: string;
    /** A LaTeX rendering when the step produced one (a sympy return sets it). */
    latex?: string;
    t: number;
    step: number;
}

/** A one-line description of what sits at a pointer — prefixed onto every read so the model knows what it is
 *  holding before it decides how to slice it. */
export function describeToken(v: TokenValue): string {
    if (v.kind === "table" && v.table) {
        const cols = v.table.columns.slice(0, 6).join(", ");
        return `a ${v.table.rows.length}x${v.table.columns.length} table (${cols}${v.table.columns.length > 6 ? ", …" : ""})`;
    }
    if (v.kind === "image") return "an image";
    if (v.kind === "json") return `JSON, ${v.out.length} chars`;
    if (v.kind === "code") return `code, ${v.out.split("\n").length} lines`;
    return `text, ${v.out.length} chars / ${v.out.split("\n").length} lines`;
}

/** How much of a base64 image to show: enough to identify the media type, far short of flooding the context
 *  with pixels the model cannot read as text anyway. */
export const IMG_PREVIEW_CHARS = 96;

/** The two casts the line dialect cannot express, because they read the POINTER'S TYPE rather than operating on
 *  lines. Returns null when the stage isn't one of these, so it falls through to the line dialect unchanged.
 *  Throws (the dialect's contract) when the cast doesn't fit the value. */
function typeCast(v: TokenValue, stage: string): string | null {
    const cmd = stage.trim().toLowerCase();
    if (cmd === "latex") {
        if (!v.latex) throw new Error("`latex` — this output has no LaTeX form (only a symbolic result, e.g. a sympy return, has one).");
        return v.latex;
    }
    if (cmd === "img" || cmd === "image") {
        if (!v.image) throw new Error("`img` — this output isn't an image.");
        // NEVER return the whole thing: a base64 payload is tens of thousands of tokens with nothing in them
        // the model can perceive. Say plainly that it IS base64 image data, how big it is, show only enough of
        // the prefix to identify the media type, and point at what to do instead of reading pixels as text.
        const kb = Math.round(v.image.length / 1024);
        return `[base64 image data — a data: URL, ${v.image.length} chars (~${kb} KB), TRUNCATED below. `
            + `This is not readable as text: show it with ![caption](@tool:${v.id}:out), or use \`look\` to have it described.]\n`
            + `${v.image.slice(0, IMG_PREVIEW_CHARS)}…`;
    }
    return null;
}

/** The text a pointer enters the pipeline as. A table enters as JSON so the structural stages act on it
 *  (`keys` → its columns); everything else enters as its readable form. */
export function pipeInput(v: TokenValue, slot: "in" | "out" = "out"): string {
    if (slot === "in") return v.in ?? "";
    if (v.kind === "table" && v.table) return JSON.stringify({ columns: v.table.columns, rows: v.table.rows }, null, 2);
    return v.out;
}

/** Read a pointer through `pipe`. A leading `latex` / `img` cast is applied first (it needs the typed value);
 *  everything after is the ordinary text-pipe dialect. Any stage that fails THROWS with an actionable message —
 *  the dialect's existing contract — and the caller turns that into a tool error the model can correct. */
export function derefPipe(v: TokenValue, slot: "in" | "out", pipe?: string | null): string {
    const stages = (pipe ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    // With NO pipe the model wants the value as it would read it — the rendered table, not the {columns,rows}
    // JSON that only exists so the structural stages have something to work on.
    if (!stages.length) return slot === "in" ? (v.in ?? "") : v.out;
    let text = pipeInput(v, slot);
    let i = 0;
    for (; i < stages.length; i++) {
        const cast = typeCast(v, stages[i]);
        if (cast === null) break;
        text = cast;
    }
    const rest = stages.slice(i);
    // A cast further down the pipeline would have nothing typed left to act on (the value is text by then), so
    // refuse it explicitly rather than letting the line dialect report it as an unknown command.
    for (const later of rest) {
        if (/^(latex|img|image)$/i.test(later))
            throw new Error(`\`${later}\` only works as the FIRST stage — it reads the output's type, not the text an earlier stage produced.`);
    }
    return rest.length ? runPipe(text, rest.join(" | ")) : text;
}

/** A run's captured outputs. Keyed by id, with the tool name as a secondary alias resolving to the LATEST call
 *  of that tool — the same aliasing the answer tokens already accept (`@tool:python_exec`), so the model can
 *  dereference by the name it remembers instead of a hex id it never saw. */
export class TokenStore {
    private byId = new Map<string, TokenValue>();

    note(v: TokenValue): void { this.byId.set(v.id, v); }

    /** Resolve `@tool:<id>`, a bare id, or a tool-name alias. Null when nothing matches. */
    get(ref: string): TokenValue | null {
        const id = normRef(ref);
        const exact = this.byId.get(id);
        if (exact) return exact;
        const ofTool = [...this.byId.values()].filter((v) => v.tool === id);
        return ofTool.length ? ofTool[ofTool.length - 1] : null;
    }

    /** The captured pointers most similar to a reference that didn't resolve. Models hallucinate token-SHAPED
     *  ids — six plausible hex characters that were never minted — so a bare "no such pointer" just invites
     *  another guess. Ranked by edit distance over the id, with the tool name considered too (a model that
     *  half-remembers "the python one" gets steered there). */
    nearest(ref: string, limit = 3): TokenValue[] {
        const q = normRef(ref).toLowerCase();
        if (!q) return this.all().slice(-limit);
        return this.all()
            .map((v) => ({ v, d: Math.min(editDistance(q, v.id), editDistance(q, v.tool.toLowerCase())) }))
            .sort((a, b) => a.d - b.d || b.v.step - a.v.step)
            .slice(0, limit)
            .map((x) => x.v);
    }

    /** Which slot a reference asks for — `:in` cites the call, `:out` (the default) the result. */
    static slotOf(ref: string): "in" | "out" { return /:in$/.test(String(ref).trim()) ? "in" : "out"; }

    /** Everything captured, oldest first. */
    all(): TokenValue[] { return [...this.byId.values()].sort((a, b) => a.step - b.step); }

    get size(): number { return this.byId.size; }
}

/** Beyond this, a "nearest" pointer isn't a typo of what was asked for — it's an unrelated id that merely
 *  happens to be closest. Worth saying, because a fabricated pointer and a mistyped one need different fixes. */
const FAR_ENOUGH_TO_BE_UNRELATED = 3;

/** The message for a pointer that doesn't resolve, modelled on a MEMORY FAULT — the model has dereferenced an
 *  address that was never mapped, which is a concept it already understands precisely. The framing is doing real
 *  work: it names the failure in terms that make the fix obvious, instead of a generic "not found".
 *
 *  Every part earns its place. The candidates are what a hallucinated id most likely meant. `edit_dist` is shown
 *  because it lets the model judge the suggestion rather than trust the ranking: distance 1 is a typo it should
 *  just correct, distance 5 means it likely invented the id and should re-run the tool. And the last line says
 *  the fault is RECOVERABLE — without it, a model pattern-matching "fault" to a segfault may report a crash or
 *  abandon the task, which is the one way this framing could backfire. */
export function memoryFault(ref: string, near: TokenValue[], currentStep: number): string {
    const head = `MemoryFault: pointer '@tool:${normRef(ref)}' does not exist.`;
    if (!near.length) return `${head}\nNothing has been captured in this run yet, so there is no pointer to read. Run a tool first.`;
    const q = normRef(ref).toLowerCase();
    const rows = near.map((v) => {
        const back = currentStep - v.step;
        const where = back <= 0 ? "this step" : `${back} step${back === 1 ? "" : "s"} back`;
        return { left: `  - @tool:${v.id}`, mid: `(${where}: ${v.tool})`, d: Math.min(editDistance(q, v.id), editDistance(q, v.tool.toLowerCase())) };
    });
    const w = Math.max(...rows.map((r) => r.mid.length));
    const body = rows.map((r) => `${r.left} ${r.mid.padEnd(w)} [edit_dist=${r.d}]`).join("\n");
    const unrelated = rows.every((r) => r.d > FAR_ENOUGH_TO_BE_UNRELATED)
        ? "\nNone of these is close, so you may be recalling an output from an earlier turn or inventing the id."
        : "";
    return `${head}\nNearest valid pointers:\n${body}${unrelated}\nThis is recoverable: retry with one of these, or re-run the tool if you need the data fresh.`;
}

const normRef = (ref: string): string => String(ref).trim().replace(/^@tool:/, "").replace(/:(in|out)$/, "");

/** Levenshtein distance — tiny inputs (a 6-hex id or a tool name), so the simple row form is fine. */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++)
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = row;
    }
    return prev[b.length];
}
