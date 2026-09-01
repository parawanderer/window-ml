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

import type { AnswerMedia } from "./contract";

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
export const answerItemFromString = (s: string): AnswerItem =>
    s.startsWith(TOOL_TOKEN_PREFIX) ? { kind: "token", ref: s } : { kind: "text", text: s };

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
        if (!this.items.length) return "";
        return this.items.map(it => {
            if (it.kind === "text") return it.text;
            if (it.kind === "token") return `[${it.preview || "result"}](${it.ref})`;
            return `- ${it.note ? `${it.note}: ` : ""}${it.preview}`;
        }).join("\n\n");
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
