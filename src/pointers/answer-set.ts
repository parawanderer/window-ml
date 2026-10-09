// The run's ANSWER SET — the user-facing result of an `ml.agent` run, curated by the model.
//
// It replaces the old accumulate-only `answered: Node[]` + `answerMedia[]` pair with an ordered,
// heterogeneous set the model can MANAGE (add / remove / clear), driven from the `answer` tool or
// the run-bound `ml.answer` collection. An item is a live DOM element (→ the HUD's click-to-
// highlight), a piece of text/markdown, or — from step 3 of the tool-token work — a `@tool:` token
// referencing a prior step's output. It is deliberately framed as *user-facing and minimal*: what's
// in here is what the person who started the run sees, so the model is told to keep it matched to
// the ask, not dump everything it touched.
//
// This module is pure (no DOM/chrome calls of its own): element previews and media are computed by
// the caller and handed in, so it unit-tests standalone. Nodes ride along as opaque values.

import type { AgentOutput } from "../contract/contract-agent";
import type { AnswerMedia, TokenRender } from "../contract/contract-render";
import { TOKEN_HEX_SRC, TOOL_NAME_SRC } from "./token-id";
import { tokenIdsIn, resolveToken } from "./answer-tokens";

/** One item in the answer set. `element` carries live nodes (page-side only) + a serialized preview
 *  and optional media; `text` is literal markdown; `token` (step 3) references a tool step's output. */
export type AnswerItem =
    | { kind: "element"; nodes: unknown[]; preview: string; media?: AnswerMedia[]; note?: string }
    | { kind: "text"; text: string }
    | { kind: "token"; ref: string; preview?: string };

/** The sentinel that marks a tool-output reference (cf. `@pt:`/`@box:`). A CSS selector can't start with
 *  it (`@…` begins an at-rule, not a selector), so it unambiguously means "a token", never a selector. */
export const TOOL_TOKEN_PREFIX = "@tool:";

/**
 * Classify a STRING answer input (`ml.answer.add("…")` / the tool's `text`): a `@tool:` reference →
 * a token item, anything else → literal text. Elements are NOT handled here — the caller builds the
 * element item, because it needs a DOM preview + a media capture this pure module can't do. In `exec`
 * the model passes real Elements (already resolved via `ml.queryAll`), so there's no selector-string
 * to disambiguate; selectors only reach the `answer` TOOL, via its explicit `selector` param.
 */
export const answerItemFromString = (s: string, note?: string): AnswerItem =>
    s.startsWith(TOOL_TOKEN_PREFIX) ? { kind: "token", ref: s, ...(note ? { preview: note } : {}) } : { kind: "text", text: s };

/** The id inside a `@tool:<id>[:in|:out]` ref — a minted token OR a tool-name alias — or null if it isn't one. */
const idOfRef = (ref: string): string | null => ref.match(new RegExp(`^@tool:(${TOKEN_HEX_SRC}|${TOOL_NAME_SRC})`))?.[1] ?? null;

/**
 * Resolve the run's BOTTOM-OF-ANSWER markdown — the tool outputs the model EXPLICITLY DESIGNATED to render
 * UNDER its prose reply (token/text/element items it curated into the answer set via `ml.answer` / the `answer`
 * tool). DEDUP: a token already cited INLINE in `summary` is dropped here (it's expanded in place; a second copy
 * at the bottom is redundant). Element/text items always stay. Returns "" when there's nothing to append.
 *
 * There is deliberately NO auto-fallback: we never PROMOTE an output the model didn't designate to a user-facing
 * "Result". A `python_exec` scratchpad calc, or any uncited citable step, stays in the transcript — not under the
 * answer. The model has three explicit ways to surface a result (inline `![](@tool:…)`, the `answer` tool,
 * `ml.answer.add`); if it used none, the prose IS the answer, and we don't guess one for it.
 */
export function finalizeAnswer(set: AnswerSet, summary: string): string {
    const inline = tokenIdsIn(summary);
    // Keep every item EXCEPT a token the prose already expands inline.
    const items = set.items.filter(it => !(it.kind === "token" && (() => { const id = idOfRef(it.ref); return id != null && inline.has(id); })()));
    return itemsToMarkdown(items);
}

/** Serialize answer-set items to markdown (shared by AnswerSet.toMarkdown + finalizeAnswer). Text verbatim;
 *  a token → the EMBED form `![preview](@tool:…)` so the bottom render EXPANDS the real output (a later pass
 *  inlines it); element → a bullet with its note/preview. */
function itemsToMarkdown(items: readonly AnswerItem[]): string {
    if (!items.length) return "";
    return items.map(it => {
        if (it.kind === "text") return it.text;
        if (it.kind === "token") return `![${it.preview || "result"}](${it.ref})`;
        return `- ${it.note ? `${it.note}: ` : ""}${it.preview}`;
    }).join("\n\n");
}

/** If a string is a JSON object/array, PARSE it to the real JS value (a python dict/list return comes back as a
 *  json.dumps'd string) — so a headless caller gets `{a:1}` / `[1,2]`, not `"{\"a\":1}"`. Non-JSON → the string. */
const parseMaybe = (s: string): unknown => {
    const t = (s || "").trim();
    if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { /* not json */ } }
    return s;
};

/** Turn one citable step's render (+ raw result) into a structured {@link AgentOutput} for `res.outputs`. */
function toOutput(r: TokenRender): AgentOutput {
    const base = { id: r.id, tool: r.tool };
    const d = r.render;
    if (d?.type === "python-out") {
        if (d.df) return { ...base, kind: "table", columns: d.df.columns, rows: d.df.rows };
        if (d.image) return { ...base, kind: "image", dataUrl: d.image };
        if (d.value != null) return { ...base, kind: "value", value: parseMaybe(d.value) };
    }
    if (d?.type === "table") return { ...base, kind: "table", columns: d.columns, rows: d.rows };
    if (d?.type === "elements") return { ...base, kind: "elements", items: d.items.map(i => ({ path: i.path, ...(i.text != null ? { text: i.text } : {}) })) };
    if (d?.type === "image") return { ...base, kind: "image", dataUrl: d.src };
    if (d?.type === "look") return { ...base, kind: "image", dataUrl: d.image };
    if (d?.type === "code") return { ...base, kind: "code", text: d.text, ...(d.lang ? { lang: d.lang } : {}) };
    return { ...base, kind: "value", value: parseMaybe(r.result ?? "") };   // no rich render → the raw result (parsed if JSON)
}

/**
 * Resolve the run's answer to STRUCTURED OUTPUTS for headless scripting: every `@tool:<id>` the final answer
 * actually cites — inline in `summary` (prose) OR at the bottom (`answerMd`: designated + auto-fallback) — mapped
 * to its step's data via `renders`. Appearance order (prose first), deduped. An id with no matching render is
 * skipped (a hallucinated token → nothing to hand back).
 */
export function resolveOutputs(answerMd: string, summary: string, renders: TokenRender[]): AgentOutput[] {
    const ids: string[] = [];
    for (const id of tokenIdsIn(summary)) if (!ids.includes(id)) ids.push(id);
    for (const id of tokenIdsIn(answerMd)) if (!ids.includes(id)) ids.push(id);
    const out: AgentOutput[] = [];
    // Resolve each cited id to its render — exact minted id first, else a tool-name alias → the tool's LAST render.
    for (const id of ids) { const r = resolveToken(id, renders, x => x.id, x => x.tool); if (r) out.push(toOutput(r)); }
    return out;
}

/** A compact, serializable view of one item — what `ml.answer` dumps and what a background run can
 *  cross the bus with (no live nodes). */
export interface AnswerItemView {
    i: number;
    kind: AnswerItem["kind"];
    preview: string;
}

// Inspecting the answer set (`ml.answer` dump, the tool's echo) must stay SMALL — the model shouldn't
// spend its context re-reading a giant pandas table it already produced. So a preview is a single
// clamped line, and a dump NEVER carries the item's heavy payload: an element's base64 `media`/live
// `nodes` and a token's referenced OUTPUT are excluded — a token keeps only its `@tool:` ref + a short
// label, the real output stays one step back in the transcript, reachable by that ref.
const PREVIEW_MAX = 80;
const clampPreview = (s: string): string => s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + "…" : s;
const previewOf = (it: AnswerItem): string => clampPreview(
    it.kind === "text" ? it.text
        : it.kind === "token" ? (it.preview ? `${it.ref} — ${it.preview}` : it.ref)
            : it.preview);

/**
 * The run's curated answer set. Ordered; add appends, remove/clear curate. `ml.answer` and the
 * `answer` tool are two front doors to one instance per run.
 */
export class AnswerSet {
    readonly items: AnswerItem[] = [];

    /** Append an item. Returns its index. */
    add(item: AnswerItem): number {
        this.items.push(item);
        return this.items.length - 1;
    }

    /** Remove by index, by a `@tool:` ref / exact text, or by a predicate. Returns how many were removed. */
    remove(which: number | string | ((it: AnswerItem, i: number) => boolean)): number {
        let idx: number[];
        if (typeof which === "number") {
            idx = which >= 0 && which < this.items.length ? [which] : [];
        } else if (typeof which === "string") {
            idx = this.items.flatMap((it, i) =>
                ((it.kind === "token" && it.ref === which) || (it.kind === "text" && it.text === which)) ? [i] : []);
        } else {
            idx = this.items.flatMap((it, i) => which(it, i) ? [i] : []);
        }
        // Splice high→low so earlier indices stay valid.
        for (const i of idx.sort((a, b) => b - a)) this.items.splice(i, 1);
        return idx.length;
    }

    /** Drop everything. */
    clear(): void { this.items.length = 0; }

    /** Remember the set as it is now; the returned function puts it back. For an attempt that must leave nothing
     *  behind when it fails (a read-only survey that falls back to approval). */
    checkpoint(): () => void {
        const saved = this.items.slice();
        return () => { this.items.length = 0; this.items.push(...saved); };
    }

    get length(): number { return this.items.length; }

    /** The indexed, serializable view the model inspects (`ml.answer` dump / the tool's echo). */
    dump(): AnswerItemView[] {
        return this.items.map((it, i) => ({ i, kind: it.kind, preview: previewOf(it) }));
    }

    /** All live nodes across element items, in order (→ AgentResult.elements). */
    elements(): unknown[] {
        return this.items.flatMap(it => it.kind === "element" ? it.nodes : []);
    }

    /** All serialized element visuals (→ the HUD completion card). */
    media(): AnswerMedia[] {
        return this.items.flatMap(it => it.kind === "element" && it.media ? it.media : []);
    }

    /**
     * The set resolved to markdown (→ AgentResult.answer, the export). Text items verbatim; element
     * items as a bullet with their note/preview; token items as their `@tool:` link so a later pass
     * (step 3's mdSink) can inline the real output. Empty set → "".
     */
    toMarkdown(): string {
        return itemsToMarkdown(this.items);
    }
}

/* --------------------------- the model-facing facade --------------------------- */

/** The RESTRICTED view of the answer set the model gets as `ml.answer` — curate only. Deliberately
 *  a small surface: NO `elements()`/`media()`/`items` (those hand back live nodes / base64, an escape
 *  + context-spam risk); dumping yields only the compact indexed previews. */
export interface AnswerFacade {
    /** Add a result: a live Element (or array of them), a `@tool:` token string, or literal text. Returns the index. */
    add(x: unknown): number;
    /** Remove an item by index, or by a `@tool:` ref / exact text. Returns how many were removed. */
    remove(which: number | string): number;
    /** Empty the set. */
    clear(): void;
    /** The compact indexed view (never nodes/media/content) — what inspecting `ml.answer` shows. */
    dump(): AnswerItemView[];
    /** How many items are in the set. */
    readonly length: number;
}

/** A DOM element, by duck-type (nodeType 1) — no `Element` import, works in jsdom + real DOM. */
const isElement = (x: unknown): boolean => !!x && typeof x === "object" && (x as { nodeType?: number }).nodeType === 1;

/**
 * Build the `ml.answer` facade over a set. `previewEl` renders a live element to a short preview (the caller
 * injects a DOM-aware one, e.g. `elLine`); media isn't captured here (that's async — an `ml.answer.add(el)`
 * stores the node for the HUD highlight, the screenshot crop only comes via the `answer` TOOL path).
 *
 * Null-prototype + a `toJSON` that returns the compact dump, so returning `ml.answer` bare from `exec`
 * serializes to the indexed previews — never the heavy nodes/media.
 */
export function makeAnswerFacade(set: AnswerSet, previewEl: (el: any) => string = () => "element"): AnswerFacade {
    const f = Object.create(null) as AnswerFacade & { toJSON(): AnswerItemView[] };
    f.add = (x: unknown): number => {
        if (typeof x === "string") return set.add(answerItemFromString(x));
        const arr = Array.isArray(x) ? x : [x];
        if (arr.length && arr.every(isElement))
            return set.add({ kind: "element", nodes: arr, preview: arr.length === 1 ? previewEl(arr[0]) : `${arr.length} element(s)` });
        return set.add({ kind: "text", text: String(x) });   // anything else (a number, …) → literal text
    };
    f.remove = (which: number | string): number => set.remove(which);
    f.clear = (): void => { set.clear(); };
    f.dump = (): AnswerItemView[] => set.dump();
    f.toJSON = (): AnswerItemView[] => set.dump();
    Object.defineProperty(f, "length", { get: () => set.length, enumerable: true });
    return f;
}

/** A compact, model-facing echo of the current answer set (indexed, clamped previews — never the
 *  heavy media/nodes). Shown after every `answer` op so the model can see what it's curating. */
export const answerEcho = (set: AnswerSet): string =>
    set.length ? set.dump().map(d => `  [${d.i}] ${d.kind}: ${d.preview}`).join("\n") : "  (empty)";

/* ------------------------------ the answer tool's core ------------------------------ */

/** The `answer` tool's arguments. */
export interface AnswerArgs {
    selector?: string; index?: number; note?: string; show?: "inline" | "highlight";
    text?: string; remove?: number | number[]; clear?: boolean;
}

/** What a selector designation found where it was resolved: how many matched, and the element item's parts. */
export interface AnswerSelection { count: number; nodes?: unknown[]; preview?: string; media?: AnswerMedia[] }

/**
 * Apply one `answer` tool call to a set and say what it did, the way the model is echoed it. Shared by the page's tool
 * and the worker's, which differ only in where a selector is resolved (`select`, which may throw a selector error).
 * `clear` first, then whatever else the call carries: `{ clear: true, text }` is "replace the answer with this" (it used
 * to return early, and Gemini Flash's text was dropped on two turns running). Every op the call carries is applied in
 * order — models send `{ text, selector }` to add both at once — and a bad selector is noted, not fatal.
 * @param set the run's answer set
 * @param args the call
 * @param select resolves a selector to the element item's parts
 * @returns the model's echo, and the media a selector added
 */
export async function answerCall(set: AnswerSet, args: AnswerArgs, select: (selector: string, index: number | undefined, note: string | undefined, show: AnswerArgs["show"]) => Promise<AnswerSelection>): Promise<{ content: string; media?: AnswerMedia[] }> {
    const { selector, index, note, show, text, remove, clear } = args;
    if (clear) set.clear();
    if (clear && text == null && selector == null) return { content: "Answer cleared.\n  (empty)" };
    const notes: string[] = clear ? ["cleared"] : [];
    if (remove != null) {
        const idxs = Array.isArray(remove) ? remove : [remove];
        let removed = 0;
        for (const i of idxs.slice().sort((a, b) => b - a)) removed += set.remove(i);   // high→low: indices stay valid
        notes.push(`removed ${removed}`);
    }
    if (text != null) {
        // A `@tool:` string → a token designation (its output renders at the BOTTOM of the answer);
        // `note` becomes its caption there. Anything else → a literal text line.
        set.add(answerItemFromString(text, note));
        notes.push(text.startsWith("@tool:") ? "added output" : "added text");
    }
    let media: AnswerMedia[] | undefined;
    if (selector != null) {
        let found: AnswerSelection | null = null;
        try { found = await select(selector, index, note, show); } catch (e) { notes.push(`selector error: ${(e as Error).message}`); }
        if (found) {
            if (!found.count) notes.push(`"${selector}" matched nothing`);
            else {
                media = found.media && found.media.length ? found.media : undefined;
                set.add({ kind: "element", nodes: found.nodes ?? [], preview: found.preview ?? `${found.count} element(s)`, ...(media ? { media } : {}), ...(note ? { note } : {}) });
                notes.push(`added ${found.count} element(s)${note ? ` — ${note}` : ""}`);
            }
        }
    }
    return { content: `${notes.length ? notes.join("; ") + ". " : ""}Answer set (${set.length}):\n${answerEcho(set)}`, ...(media ? { media } : {}) };
}

/* ------------------------- the worker's set, as a page-side script sees it ------------------------- */

/** One item of a worker-held set as it is sent to the page with an approved exec: its kind, and what the page may
 *  see of it. A text item's content is the run's (the model may have written it from another site), so it is not sent. */
export type AnswerShapeItem = { kind: "text" } | { kind: "token"; ref: string; preview?: string } | { kind: "element"; preview: string };

/** An item as an operation carries it back: an element by its preview, never its nodes, which stay on the page. */
export type AnswerOpItem = { kind: "text"; text: string } | { kind: "token"; ref: string; preview?: string } | { kind: "element"; preview: string; note?: string };

/** One change a page-side script made to the set, replayed by the worker on the real one. */
export type AnswerOp = { op: "add"; item: AnswerOpItem } | { op: "remove"; which: number | string } | { op: "clear" };

/** What a page-side script reads for a text item it cannot see. */
const HIDDEN_PREVIEW = "(text, kept by the worker)";

/**
 * The set an approved exec of a worker-built run is given on the page: the worker's set as far as the page may see it,
 * recording every change in order for the worker to replay (worker-answer.ts). `.length` and indices are answered here,
 * synchronously, as before. A text item the page was not shown has no content here: a `remove("…")` by text matches
 * only the items this script can see, and the worker's replay matches all of them.
 */
export class AnswerLog extends AnswerSet {
    readonly ops: AnswerOp[] = [];
    readonly #hidden = new WeakSet<AnswerItem>();

    constructor(shape: readonly AnswerShapeItem[]) {
        super();
        for (const s of shape) {
            if (s.kind === "text") { const it: AnswerItem = { kind: "text", text: "\u0000" }; this.#hidden.add(it); this.items.push(it); }
            else if (s.kind === "token") this.items.push({ kind: "token", ref: s.ref, ...(s.preview ? { preview: s.preview } : {}) });
            else this.items.push({ kind: "element", nodes: [], preview: s.preview });
        }
    }

    override add(item: AnswerItem): number {
        this.ops.push({ op: "add", item: item.kind === "element" ? { kind: "element", preview: item.preview, ...(item.note ? { note: item.note } : {}) } : item.kind === "token" ? { kind: "token", ref: item.ref, ...(item.preview ? { preview: item.preview } : {}) } : { kind: "text", text: item.text } });
        return super.add(item);
    }

    override remove(which: number | string | ((it: AnswerItem, i: number) => boolean)): number {
        if (typeof which === "number" || typeof which === "string") this.ops.push({ op: "remove", which });
        return super.remove(typeof which === "string" ? (it: AnswerItem) => !this.#hidden.has(it) && ((it.kind === "token" && it.ref === which) || (it.kind === "text" && it.text === which)) : which);
    }

    override clear(): void { this.ops.push({ op: "clear" }); super.clear(); }

    override checkpoint(): () => void {
        const restore = super.checkpoint(), n = this.ops.length;
        return () => { restore(); this.ops.length = n; };
    }

    override dump(): AnswerItemView[] {
        return super.dump().map((v) => (this.#hidden.has(this.items[v.i]) ? { ...v, preview: HIDDEN_PREVIEW } : v));
    }
}

/** The shape of a set, as {@link AnswerLog} is built from it. */
export function answerShape(set: AnswerSet): AnswerShapeItem[] {
    return set.items.map((it) => it.kind === "text" ? { kind: "text" as const }
        : it.kind === "token" ? { kind: "token" as const, ref: it.ref, ...(it.preview ? { preview: it.preview } : {}) }
            : { kind: "element" as const, preview: it.preview });
}

/** The most operations one call may report, and the longest string an operation may carry. */
const MAX_OPS = 200, MAX_TEXT = 20_000, MAX_SHORT = 1_000;

/**
 * Replay what a page-side script did to the set on the real one. The operations are the PAGE's report: it can forge or
 * edit them, which changes only the person-facing answer, as any script in an approved exec's world could already. So
 * each is checked for shape and size, and a report with one malformed operation is dropped whole.
 * @param set the worker's set
 * @param ops what the page reported
 * @returns how many were applied, or the reason none were
 */
export function replayAnswerOps(set: AnswerSet, ops: unknown): { applied: number } | { refused: string } {
    if (!Array.isArray(ops)) return { refused: "not a list" };
    if (ops.length > MAX_OPS) return { refused: `${ops.length} operations, over ${MAX_OPS}` };
    const str = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;
    const okItem = (it: unknown): it is AnswerOpItem => {
        const i = it as Record<string, unknown> | null;
        if (!i || typeof i !== "object") return false;
        if (i.kind === "text") return str(i.text, MAX_TEXT);
        if (i.kind === "token") return str(i.ref, MAX_SHORT) && i.ref.startsWith(TOOL_TOKEN_PREFIX) && (i.preview === undefined || str(i.preview, MAX_SHORT));
        if (i.kind === "element") return str(i.preview, MAX_SHORT) && (i.note === undefined || str(i.note, MAX_SHORT));
        return false;
    };
    const ok = (o: unknown): o is AnswerOp => {
        const x = o as Record<string, unknown> | null;
        if (!x || typeof x !== "object") return false;
        if (x.op === "clear") return true;
        if (x.op === "remove") return (Number.isInteger(x.which) && (x.which as number) >= 0) || str(x.which, MAX_TEXT);
        if (x.op === "add") return okItem(x.item);
        return false;
    };
    if (!ops.every(ok)) return { refused: "a malformed operation" };
    for (const o of ops as AnswerOp[]) {
        if (o.op === "clear") set.clear();
        else if (o.op === "remove") set.remove(o.which);
        else {
            const it = o.item;
            set.add(it.kind === "element" ? { kind: "element", nodes: [], preview: it.preview, ...(it.note ? { note: it.note } : {}) }
                : it.kind === "token" ? { kind: "token", ref: it.ref, ...(it.preview ? { preview: it.preview } : {}) }
                    : { kind: "text", text: it.text });
        }
    }
    return { applied: ops.length };
}
