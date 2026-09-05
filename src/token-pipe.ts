// The POINTER layer behind `dereference`: what a `@tool:<id>` token points at, and how to read part of it.
//
// The pipe language itself is NOT here — it is `text-pipe.ts`, the existing modeled bash sub-dialect (its
// verbs are PIPE_CMDS there, the single source for every message and tool-parameter description that names
// them). This module adds only what a POINTER knows that a bare string doesn't:
//
//   • its TYPE (a table, an image, code, JSON, text) — so `keys` on a DataFrame means its COLUMNS, and the
//     model is told what it is holding before it decides how to slice it;
//   • WHEN it was captured — a pointer aliases a snapshot with no invalidation, so a DOM survey still resolves
//     long after the page changed under it. Every read says how old it is;
//   • two type-level casts the line dialect cannot express: `latex` and `img`.
//
// Pure: no DOM, no chrome, no I/O.

import { runPipe, splitStages } from "./text-pipe";
import type { DerefRead, DerefMeta, TokenKind } from "./contract";
export type { DerefRead, DerefMeta };
import { isTokenShape } from "./token-id";
import { lexicalSimilarity, type LexicalMetric } from "./label-match";

/** The tool name, shared by the loop (which answers it) and the toolset builder (which advertises it). */
export const DEREF_TOOL = "dereference";

/** Was this reference a tool NAME (the moving "latest call" alias) rather than the id it resolved to? The loop
 *  uses it to decide whether to hand the model the stable id — see the "Pinned:" line in agent-loop. */
export const isAliasRef = (ref: string, resolvedId: string): boolean => normRef(ref) !== resolvedId;

// TokenKind lives in contract.ts: the page↔background relay carries it now (see DerefMeta), and contract.ts
// cannot import from here. Re-exported so every existing importer is unaffected.
export type { TokenKind };

export interface TokenValue {
    id: string;
    tool: string;
    kind: TokenKind;
    /** Str-renderable: exactly what the model saw — already clipped to its context budget. */
    out: string;
    /** The FULLER capture the UI retained (UI_OUT_CAP), when there is more than the model was shown. This is
     *  the point of the pointer: the clipped copy is what the model already has, so dereferencing it would be
     *  useless. Reads prefer this, and say how much more it holds. */
    full?: string;
    /** The call/arguments — what `@tool:<id>:in` reads. */
    in?: string;
    /** The structural value when there is one, so the pipe needn't reparse a rendered grid. */
    table?: { columns: string[]; rows: unknown[][] };
    /** A `data:image/…;base64,…` URL when the step produced an image. */
    image?: string;
    /** A LaTeX rendering when the step produced one (a sympy return sets it). */
    latex?: string;
    /** The model's OWN short name for what this pointer holds, from `token: "the pricing table"`. Purely for
     *  the model: it is what turns a hex address into a named variable it can actually recall a step later,
     *  and it is matched by `nearest()` so half-remembering the NAME still lands. It is a CLAIM, not a fact —
     *  model-authored — so it is always shown BESIDE the derived description, never instead of it. */
    label?: string;
    t: number;
    step: number;
    /** The step's SEQ, when it has one — what a UI needs to scroll back to the call this came from. `step`
     *  is the loop's own counter and several records can share it; `seq` addresses one row. */
    seq?: number;
}

/** How much MORE the pointer holds than the model was shown — the sentence that tells it this read was worth
 *  a step. Empty when the model already has the whole value. */
export function extraBeyondModel(v: TokenValue): string {
    const extra = (v.full?.length ?? 0) - v.out.length;
    return extra > 0 ? ` — ${extra} chars MORE than you were shown (your copy was truncated)` : "";
}

/** A one-line description of what sits at a pointer — prefixed onto every read so the model knows what it is
 *  holding before it decides how to slice it. */
/** How long a self-authored label may be. It is a memo to itself, not prose — a cap keeps a model from
 *  stuffing a paragraph into every listing. */
export const LABEL_MAX = 60;
/** Clean a model-supplied label: single line, trimmed, capped. Empty → undefined (no label at all). */
export function cleanLabel(raw: unknown): string | undefined {
    const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
    return t || undefined;
}

export function describeToken(v: TokenValue): string {
    const text = v.full ?? v.out;
    if (v.kind === "table" && v.table) {
        const cols = v.table.columns.slice(0, 6).join(", ");
        return `a ${v.table.rows.length}x${v.table.columns.length} table (${cols}${v.table.columns.length > 6 ? ", …" : ""})`;
    }
    if (v.kind === "image") return "an image";
    if (v.kind === "json") return `JSON, ${text.length} chars`;
    if (v.kind === "code") return `code, ${text.split("\n").length} lines`;
    return `text, ${text.length} chars / ${text.split("\n").length} lines`;
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
    return v.full ?? v.out;
}

/** Read a pointer through `pipe`. A leading `latex` / `img` cast is applied first (it needs the typed value);
 *  everything after is the ordinary text-pipe dialect. Any stage that fails THROWS with an actionable message —
 *  the dialect's existing contract — and the caller turns that into a tool error the model can correct. */
export function derefPipe(v: TokenValue, slot: "in" | "out", pipe?: string | string[] | null): string {
    const stages = pipeStages(pipe);
    // With NO pipe the model wants the value as it would read it — the rendered table, not the {columns,rows}
    // JSON that only exists so the structural stages have something to work on.
    if (!stages.length) return slot === "in" ? (v.in ?? "") : (v.full ?? v.out);
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
    // The remaining stages go through as an ARRAY, never re-joined into a string: joining and letting runPipe
    // re-split is what used to tear `grep -E 'error|warn'` into two stages (silently returning nothing, or —
    // for `'head|tail'` — a plausible wrong answer).
    return rest.length ? runPipe(text, rest) : text;
}

/** Resolve a `pipe` argument to its STAGES — the canonical form for EXECUTION. A string is split on unquoted
 *  `|` (quote-aware, via the dialect's own splitter); an array is already one stage per entry and is passed
 *  through untouched, so an entry may contain a bare `|` (regex alternation) with no quoting at all. Blank
 *  entries are dropped so a conditionally-built array doesn't produce an empty stage.
 *
 *  Never re-join these for execution — see {@link derefPipe}. */
export function pipeStages(pipe: string | string[] | null | undefined): string[] {
    if (Array.isArray(pipe)) return pipe.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    return typeof pipe === "string" && pipe.trim() ? splitStages(pipe) : [];
}

/** The pipe as ONE human-readable line, for DISPLAY only — the sidebar's `bash` block, the approval card, the
 *  export. Deliberately lossy: a stage containing an unquoted `|` reads ambiguously here, which is fine for a
 *  label and is exactly why {@link pipeStages} is what execution uses. Never throws (a malformed pipe still
 *  has to render), so it does not validate quoting. */
export function displayPipe(pipe: string | string[] | null | undefined): string {
    if (Array.isArray(pipe)) return pipe.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).join(" | ");
    return typeof pipe === "string" ? pipe : "";
}

/** A run's captured outputs. Keyed by id, with the tool name as a secondary alias resolving to the LATEST call
 *  of that tool — the same aliasing the answer tokens already accept (`@tool:python_exec`), so the model can
 *  dereference by the name it remembers instead of a hex id it never saw. */
export class TokenStore {
    private byId = new Map<string, TokenValue>();

    /** How many pointers a store keeps. A store lives for a whole SESSION (every turn of an agent handle), not
     *  one turn, and an entry can carry a big `full` capture or a screenshot data URL — so it has to be bounded
     *  or a long conversation grows without limit. ~10 turns of heavy tool use at the default 20-step cap. */
    static readonly CAP = 200;

    // Eviction is LRU, and a READ counts as a use — a pointer the model keeps consulting must not be dropped
    // before ones it has never looked at. Tracked SEPARATELY from `byId`'s insertion order, because that order
    // is what makes the tool-name alias mean "the latest CALL": refreshing it on a read would make an old
    // python_exec output masquerade as the newest one.
    private used = new Map<string, number>();
    private clock = 0;

    note(v: TokenValue): void {
        this.byId.delete(v.id);   // re-noting an id moves it to the END, so the tool-name alias still means "latest"
        this.byId.set(v.id, v);
        this.used.set(v.id, ++this.clock);
        while (this.byId.size > TokenStore.CAP) {
            // The least recently USED (noted or read), not simply the oldest.
            let oldest: string | null = null, min = Infinity;
            for (const id of this.byId.keys()) { const u = this.used.get(id) ?? 0; if (u < min) { min = u; oldest = id; } }
            if (oldest == null) break;
            this.byId.delete(oldest); this.used.delete(oldest);
        }
    }

    /** Resolve `@tool:<id>`, a bare id, or a tool-name alias. Null when nothing matches. */
    /** A label must score at least this well to be resolved without being asked about. Measured on the
     *  motivating cases: correct matches score 0.68-1.00 under the default metric, wrong ones 0.36 or below. */
    private static readonly LABEL_MIN = 0.5;
    /** …AND it must lead the runner-up by this much. The threshold alone is not the guard — the danger is two
     *  SIMILAR labels ("model_fit_linear" / "model_fit_quadratic"), where the best candidate may clear any
     *  absolute bar and still be a coin flip. Requiring separation encodes "never silently pick between two
     *  plausible symbols" directly, instead of approximating it with a distance number. */
    private static readonly LABEL_MARGIN = 0.15;

    /** The best SOFT label match, when one is safe to resolve without asking. Applies only to the QUOTED
     *  label form: an id-shaped ref that misses must stay missed (its checksum and the sparse id space are
     *  what make a corrupted id fail loudly), and a bare ref is a tool alias with nothing to be fuzzy about. */
    private fuzzyLabel(query: string, metric?: LexicalMetric): { value: TokenValue; score: number } | null {
        const scored = [...this.byId.values()]
            .filter((v) => v.label)
            .map((v) => ({ value: v, score: lexicalSimilarity(metric, query, v.label!) }))
            .sort((a, b) => b.score - a.score);
        if (!scored.length) return null;
        const [best, second] = scored;
        if (best.score < TokenStore.LABEL_MIN) return null;
        if (second && best.score - second.score < TokenStore.LABEL_MARGIN) return null;   // too close to call
        return best;
    }

    /** The LATEST value whose own label matches, or null. Latest-wins mirrors the tool-name alias ("that
     *  tool's most recent call"), so the two named forms behave the same way when reused. */
    private byLabel(label: string): TokenValue | null {
        const want = labelKey(label);
        if (!want) return null;
        const hits = [...this.byId.values()].filter((v) => v.label && labelKey(v.label) === want);
        return hits.length ? hits[hits.length - 1] : null;
    }

    /** Resolve `@tool:<id>`, a bare id, a tool-name alias, or the model's own LABEL — quoted
     *  (`@tool:"the sales table"`, unambiguous) or, as a last resort, bare. Null when nothing matches.
     *
     *  A label is the most reliable handle a model has, because it CHOSE it at the moment it knew what the
     *  output was for: it is recalled rather than transcribed, so it degrades gracefully where a hex id
     *  degrades into garbage. Before this, a labelled output could be named in a fault's candidate list but
     *  not actually resolved — the store knew the name and still refused it.
     *
     *  Order matters. A QUOTED ref is a label lookup and nothing else. An UNQUOTED one tries id, then tool
     *  name, then label — label last, so a label can never shadow a real id or a tool alias. */
    get(ref: string): TokenValue | null { return this.resolveRef(ref).value; }

    /** {@link get}, plus HOW it resolved — so a caller can hand back the canonical handle. An unquoted label
     *  works but teaches nothing; the reply says what the quoted form would have been, the same way reading
     *  through a tool-name alias hands over the stable id. */
    resolveRef(ref: string, metric?: LexicalMetric): { value: TokenValue | null; via: "id" | "tool" | "label"; matched?: string; score?: number } {
        const { label, id } = parseRef(ref);
        const touch = (v: TokenValue | null): TokenValue | null => { if (v) this.used.set(v.id, ++this.clock); return v; };
        // THREE DISJOINT FORMS, dispatched on SHAPE rather than tried in order:
        //   @tool:"a label"   quoted     -> the model's own label
        //   @tool:a1b2c3f     token-shaped -> a minted id
        //   @tool:python_exec bare       -> a tool alias, that tool's latest call
        // Dispatching on form rather than falling through means each spelling has exactly ONE meaning, so
        // there is no precedence rule to teach and nothing can shadow anything. It also keeps a corrupted id
        // in the id branch — it MISSES and faults, instead of being retried as a tool or a label and possibly
        // resolving to something unrelated. (Rests on ids and tool names being distinguishable by shape: no
        // tool is named as seven hex characters. Asserted in tests, not assumed.)
        if (label != null) {
            const exact = this.byLabel(label);
            if (exact) return { value: touch(exact), via: "label" };
            // No exact symbol. A near match is resolved only when it is BOTH good and unambiguous — and it is
            // always announced, never silent: an address dereference must not quietly change which data the
            // computation runs on.
            const soft = this.fuzzyLabel(label, metric);
            return soft
                ? { value: touch(soft.value), via: "label", matched: soft.value.label, score: soft.score }
                : { value: null, via: "label" };
        }
        if (isTokenShape(id)) return { value: touch(this.byId.get(id) ?? null), via: "id" };
        const ofTool = [...this.byId.values()].filter((v) => v.tool === id);
        return { value: touch(ofTool.length ? ofTool[ofTool.length - 1] : null), via: "tool" };
    }

    /** The captured pointers most similar to a reference that didn't resolve. Models hallucinate token-SHAPED
     *  ids — six plausible hex characters that were never minted — so a bare "no such pointer" just invites
     *  another guess. Ranked by edit distance over the id, with the tool name considered too (a model that
     *  half-remembers "the python one" gets steered there). */
    nearest(ref: string, limit = 3): TokenValue[] {
        const q = normRef(ref).toLowerCase();
        if (!q) return this.all().slice(-limit);
        return this.all()
            .map((v) => ({ v, d: distanceTo(q, v) }))
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
/** How a pointer is NAMED in a listing: its own label when it has one, else just the tool. The label is the
 *  model's own words, which is what makes a list of pointers readable a dozen steps later. */
export const nameOf = (v: TokenValue): string => v.label ? `${v.tool}: "${v.label}"` : v.tool;

/** A COMPACT type for a candidate list — what the value IS, in a few characters. {@link describeToken} is a
 *  sentence, which is right for the one pointer you actually read and wrong for a column of five. Knowing a
 *  candidate is a 12x3 table rather than a screenshot is often enough to pick correctly without reading any
 *  of them, which is the whole job of the list. */
export function shortType(v: TokenValue): string {
    if (v.kind === "table" && v.table) return `table ${v.table.rows.length}x${v.table.columns.length}`;
    if (v.kind === "image") return "image";
    if (v.kind === "code") return "code";
    if (v.kind === "json") return "json";
    const n = (v.full ?? v.out ?? "").length;
    return `text ${n.toLocaleString()} chars`;
}

export function memoryFault(ref: string, near: TokenValue[], currentStep: number): string {
    const head = `MemoryFault: pointer '@tool:${normRef(ref)}' does not exist.`;
    // The commonest near-miss now: the model wrote its own LABEL without quotes. A bare ref is a TOOL alias,
    // so it misses — but the store knows that label, and saying so in the canonical form teaches the syntax
    // in the same step it recovers. (Resolving it silently would work once and teach nothing.)
    const bare = normRef(ref);
    const labelled = near.find((v) => v.label && v.label.trim().toLowerCase().replace(/\s+/g, " ") === bare.trim().toLowerCase().replace(/\s+/g, " "));
    if (labelled) return `${head}\nThat is a LABEL, and a label must be quoted: read it with @tool:${JSON.stringify(labelled.label)} (an unquoted @tool:<name> means a TOOL's latest call).`;
    if (!near.length) return `${head}\nNothing has been captured in this run yet, so there is no pointer to read. Run a tool first.`;
    const q = normRef(ref).toLowerCase();
    const rows = near.map((v) => {
        const back = currentStep - v.step;
        const where = back <= 0 ? "this step" : `${back} step${back === 1 ? "" : "s"} back`;
        // The TYPE is what makes this list pickable: "a 12x3 table" vs "a screenshot" usually decides it
        // outright, where two similar-looking ids and step numbers do not.
        const d = distanceTo(q, v);
        return { line: `  - @tool:${v.id} (${where}: ${nameOf(v)}) ${shortType(v)} [dist ${d}]`, d };
    });
    // NOT column-aligned. Padding to a common width is a HUMAN scanning affordance, and this string is read
    // by a model — which parses the fields either way and pays for every space. On a three-candidate list the
    // padding was 10% of the message, and it grows with the label lengths. A mechanism whose whole purpose is
    // to stop the model re-emitting data should not spend context on whitespace. The human-facing view of the
    // same list is the sidebar/export, which can align in CSS for free.
    const body = rows.map((r) => r.line).join("\n");
    const unrelated = rows.every((r) => r.d > FAR_ENOUGH_TO_BE_UNRELATED)
        ? "\nNone of these is close, so you may be recalling an output from an earlier turn or inventing the id."
        : "";
    return `${head}\nNearest valid pointers:\n${body}${unrelated}\nThis is recoverable: retry with one of these, or re-run the tool if you need the data fresh.`;
}

/** Distance from a reference to a pointer, over its id, its tool name AND its own label — so "the pricing
 *  table" finds the pointer the model named that, even when the hex it wrote was invented. Substring hits on
 *  the label score 0: recalling the name exactly is a match, not an approximation. */
function distanceTo(q: string, v: TokenValue): number {
    const label = v.label?.toLowerCase() ?? "";
    if (q && label && label.includes(q)) return 0;
    return Math.min(editDistance(q, v.id), editDistance(q, v.tool.toLowerCase()), label ? editDistance(q, label) : Infinity);
}

const normRef = (ref: string): string => String(ref).trim().replace(/^@tool:/, "").replace(/:(in|out)$/, "");

/** A QUOTED reference — `@tool:"the sales table"` — names the model's own LABEL rather than an id or a tool.
 *  The quotes earn their place twice: they delimit a label containing spaces, and they make the lookup
 *  UNAMBIGUOUS, so a label that happens to read like a tool name or an id can never shadow one. Both quote
 *  styles are accepted because models mix them. */
const QUOTED = /^["'](.*)["']$/s;

/** Undo the escaping inside a quoted label: `\"` is a literal quote, `\\` a literal backslash. A label is
 *  free text the model wrote, so it can contain the delimiter; escaping is what makes the form closed rather
 *  than merely usually-right. Anything else after a backslash is left alone (a Windows path in a label should
 *  survive being read back). */
const unescapeLabel = (s: string): string => s.replace(/\\(["'\\])/g, "$1");

/** Compare labels forgivingly — case and inner whitespace are not what the model is trying to communicate,
 *  and the entire reason labels exist is that they are RECALLED rather than transcribed. */
const labelKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The LABEL a quoted reference names, or null if the reference isn't the quoted form. Exported so a caller
 *  can echo back what the model actually asked for when reporting a soft match. */
export const parseLabel = (ref: string): string | null => parseRef(ref).label ?? null;

/** Split a reference into "this is a label" vs "this is an id or a tool name". */
function parseRef(ref: string): { label?: string; id: string } {
    const bare = normRef(ref);
    const q = QUOTED.exec(bare);
    return q ? { label: unescapeLabel(q[1]), id: "" } : { id: bare };
}

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
