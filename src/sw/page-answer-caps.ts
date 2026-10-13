// page-answer-caps.ts — a page's answer to a delegated tool call, held to the caps the worker applies to page data it reads itself (pageRead).

// The page answers every call a run delegates to it (RUN_TOOL_IN_PAGE), and every field of that answer is the page's to
// write: its render slots (`renderIn`/`renderOut`) become the step's pointer and the sidebar's view, and its `result`
// is the text the model reads. Before this, both were kept whole, bounded only by Chrome's 64 MiB message cap: a
// 300,000-row table in the pointer, a 20 MB capture beside it, and the whole text in the model's context. Owner decision
// 2026-10-13: the same caps as `pageRead` (`PAGE_TABLE_CAPS`, worker-page-read.ts), one constant for both. A table over
// them is cut to fit and keeps its SOURCE's row count; a text or picture over the size is dropped and the model told;
// the text result is clipped the way a tool's output is (`clipOut`). Every cut is a `page`/`answer-capped` record in the
// run's execution log.

import { PAGE_TABLE_CAPS } from "./worker-page-read";
import { clipOut } from "../dom/dom";
import { OUTPUT_CAP, resolveOutputCap, type OutputCapTool } from "../contract/contract-pointers";
import { UI_OUT_CAP } from "../contract/contract-chat";

/** One kind of cut made to a page's answer, counted: `what` is a lowercase slug (the execution log's `reason`). */
export interface PageAnswerCut {
    /** `renderIn`, `renderOut`, or `envelope` for the answer's own fields. */
    slot: string;
    /** The field cut, as a path inside the slot (`rows`, `df.rows`, `tables.0.rows`, `capture`, `image`, `result`). */
    field: string;
    what: "rows" | "columns" | "cell" | "cell-type" | "text" | "image" | "result";
    /** The size before (rows, columns, cells or characters) and after. */
    from: number;
    to: number;
}

/** The fields of a render descriptor that hold a picture: dropped whole when over the size, never cut. */
const PICTURE_FIELDS = new Set(["image", "src", "rawImage"]);

/** The list fields of a descriptor that are not tables, by descriptor type: held to a table's caps, an entry as a row. */
const LIST_FIELDS: Record<string, readonly string[]> = { keyval: ["pairs"], elements: ["items"], "exec-out": ["stdoutNotes", "valueNotes"] };

/**
 * A descriptor's list (a keyval's pairs, an elements' items, an exec-out's notes) within the table caps: entries past
 * `PAGE_TABLE_CAPS.rows` dropped, and a string longer than `PAGE_TABLE_CAPS.cell` cut, whether it is the entry itself or
 * one of the entry's own fields (a pair's halves, an item's `path`/`text`).
 * @param list the list as the page sent it
 * @param note records a cut
 * @returns `list` itself when nothing was over, else a copy within the caps
 */
function capPageList(list: unknown[], note: (what: PageAnswerCut["what"], from: number, to: number) => void): unknown[] {
    const C = PAGE_TABLE_CAPS;
    let long = 0;
    const cut = (s: unknown): unknown => { if (typeof s === "string" && s.length > C.cell) { long++; return s.slice(0, C.cell); } return s; };
    const entry = (e: unknown): unknown => {
        if (Array.isArray(e)) { const c = e.map(cut); return c.some((x, i) => x !== e[i]) ? c : e; }
        if (e && typeof e === "object") {
            const o = e as Record<string, unknown>;
            let c: Record<string, unknown> | null = null;
            for (const [k, v] of Object.entries(o)) { const w = cut(v); if (w !== v) (c ??= { ...o })[k] = w; }
            return c ?? e;
        }
        return cut(e);
    };
    const kept = list.length > C.rows ? list.slice(0, C.rows) : list;
    const out = kept.map(entry);
    if (kept !== list) note("rows", list.length, C.rows);
    if (long) note("cell", long, C.cell);
    return kept === list && !long ? list : out;
}

/**
 * The most characters of a page's text result the model reads for one call: the panel's cap (`UI_OUT_CAP`), or, for a
 * tool with a model cap of its own (`OUTPUT_CAP`), room for what its producer legitimately writes: two slots (console
 * and value, or stdout and value) clipped at the call's cap, and the notes around them.
 * @param name the tool
 * @param args the call's arguments (`maxChars` raises the cap for exec and python_exec)
 * @returns the cap in characters
 */
export function pageResultCap(name: string, args: Record<string, unknown> | undefined): number {
    if (!Object.prototype.hasOwnProperty.call(OUTPUT_CAP, name)) return UI_OUT_CAP;
    const a = args && typeof args === "object" ? args : {};
    return Math.max(UI_OUT_CAP, 3 * resolveOutputCap(name as OutputCapTool, a.maxChars, a.maxCharsReason).cap);
}

/** The sentence the model reads, after its copy of the result, for a part of the page's answer that was dropped. */
export const droppedNote = (field: string, chars: number): string =>
    `[the page's answer carried ${field} of ${chars} chars, over the ${PAGE_TABLE_CAPS.html}-char limit for a page's answer, so it was dropped.]`;

/**
 * The page context a page answers when a run is pushed into it (ADOPT_RUN_NOW, joined to a worker-built run's system
 * prompt) or re-adopted after a navigation (RUN_READOPTED, folded into the `navigate` result): text the model reads, held
 * to the cap of a tool's text result (`clipOut` at `UI_OUT_CAP`). Anything but a string is no context.
 * @param info what the page answered
 * @returns the context to use, or undefined for none
 */
export function capPageContext(info: unknown): string | undefined {
    return typeof info === "string" && info ? clipOut(info, UI_OUT_CAP) : undefined;
}

type Cell = string | number | boolean | null;

/**
 * A table from a page, within {@link PAGE_TABLE_CAPS}: at most `columns` columns and `rows` rows, rows kept from the top
 * while the cells fit `cells`, a cell string cut to `cell` characters and any other non-scalar cell made null (pageRead
 * refuses both). A table cut short keeps its SOURCE's row count in `rowCount`: the page's own when it is a whole
 * number no smaller than the rows it sent, else the rows it sent.
 * @param t the table's fields (`columns`, `rows`, `rowCount`)
 * @param note records a cut
 * @returns `t` itself when nothing was over, else a copy within the caps
 */
export function capPageTable<T extends { columns?: unknown; rows?: unknown; rowCount?: unknown }>(t: T, note: (field: string, what: PageAnswerCut["what"], from: number, to: number) => void): T {
    if (!t || typeof t !== "object" || !Array.isArray(t.rows)) return t;
    const C = PAGE_TABLE_CAPS;
    let changed = false;
    let columns = t.columns;
    if (Array.isArray(columns)) {
        const fixed = columns.slice(0, C.columns).map((c) => (typeof c === "string" && c.length > C.cell ? c.slice(0, C.cell) : c));
        if (columns.length > C.columns) { note("columns", "columns", columns.length, C.columns); changed = true; }
        if (fixed.some((c, i) => c !== (columns as unknown[])[i])) changed = true;
        if (changed) columns = fixed;
    }
    const src = t.rows as unknown[];
    const rows: unknown[] = [];
    let cells = 0, longCells = 0, oddCells = 0;
    for (const row of src) {
        if (rows.length >= C.rows) break;
        const r = Array.isArray(row) ? row : [];
        if (cells + Math.min(r.length, C.columns) > C.cells) break;
        let out: Cell[] | null = r.length > C.columns ? (r.slice(0, C.columns) as Cell[]) : null;
        const width = Math.min(r.length, C.columns);
        for (let i = 0; i < width; i++) {
            const v = r[i];
            let w: Cell | undefined;
            if (typeof v === "string") { if (v.length > C.cell) { w = v.slice(0, C.cell); longCells++; } }
            else if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) { w = null; oddCells++; }
            if (w !== undefined) { out ??= r.slice(0, width) as Cell[]; out[i] = w; }
        }
        if (!Array.isArray(row)) { oddCells++; out = []; }
        if (out) changed = true;
        rows.push(out ?? row);
        cells += width;
    }
    if (rows.length < src.length) { note("rows", "rows", src.length, rows.length); changed = true; }
    if (longCells) note("rows", "cell", longCells, C.cell);
    if (oddCells) note("rows", "cell-type", oddCells, 0);
    if (!changed) return t;
    const claimed = t.rowCount;
    const rowCount = typeof claimed === "number" && Number.isInteger(claimed) && claimed >= src.length ? claimed : src.length;
    return { ...t, columns, rows, ...(rows.length < src.length || "rowCount" in t ? { rowCount } : {}), ...((t as { type?: unknown }).type === "table" && rowCount > rows.length ? { truncated: true } : {}) } as T;
}

/**
 * A page's render descriptor within the caps: its tables through {@link capPageTable} (a `table`, a python frame `df`,
 * the frames a `python-in` loaded, a `locate`'s substeps' strings), and any string field longer than
 * `PAGE_TABLE_CAPS.html` dropped.
 * @param d the descriptor
 * @param note records a cut (`field`, `what`, `from`, `to`)
 * @returns `d` itself when nothing was over, else a copy
 */
function capRender(d: unknown, note: (field: string, what: PageAnswerCut["what"], from: number, to: number) => void): unknown {
    if (!d || typeof d !== "object" || Array.isArray(d)) return d;
    const r = d as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    const set = (k: string, v: unknown): void => { out ??= { ...r }; if (v === undefined) delete out[k]; else out[k] = v; };
    const strings = (o: Record<string, unknown>, at: string, put: (k: string) => void): void => {
        for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v.length > PAGE_TABLE_CAPS.html) {
            note(`${at}${k}`, PICTURE_FIELDS.has(k) ? "image" : "text", v.length, 0);
            put(k);
        }
    };
    strings(r, "", (k) => set(k, undefined));
    const sub = (field: string) => (f: string, w: PageAnswerCut["what"], a: number, b: number) => note(`${field}.${f}`, w, a, b);
    if (r.type === "table") {
        const t = capPageTable(r, note);
        if (t !== r) { set("columns", t.columns); set("rows", t.rows); if ("rowCount" in t) set("rowCount", t.rowCount); if ("truncated" in t) set("truncated", t.truncated); }
    }
    if (r.type === "python-out" && r.df && typeof r.df === "object") {
        const df = capPageTable(r.df as { rows?: unknown }, sub("df"));
        if (df !== r.df) set("df", df);
    }
    if (r.type === "python-in" && Array.isArray(r.tables)) {
        const tables = r.tables.map((t, i) => (t && typeof t === "object" ? capPageTable(t as { rows?: unknown }, sub(`tables.${i}`)) : t));
        if (tables.some((t, i) => t !== (r.tables as unknown[])[i])) set("tables", tables);
    }
    // Own keys only: a page's `type` can be any string, `constructor` included.
    for (const k of Object.prototype.hasOwnProperty.call(LIST_FIELDS, String(r.type)) ? LIST_FIELDS[String(r.type)] : []) {
        const list = r[k];
        if (!Array.isArray(list)) continue;
        const capped = capPageList(list, (w, a, b) => note(k, w, a, b));
        if (capped !== list) set(k, capped);
    }
    if (r.type === "locate" && Array.isArray(r.substeps)) {
        const steps = r.substeps.map((s, i) => {
            if (!s || typeof s !== "object") return s;
            let c: Record<string, unknown> | null = null;
            strings(s as Record<string, unknown>, `substeps.${i}.`, (k) => { c ??= { ...(s as Record<string, unknown>) }; delete c[k]; });
            return c ?? s;
        });
        if (steps.some((s, i) => s !== (r.substeps as unknown[])[i])) set("substeps", steps);
    }
    return out ?? d;
}

/**
 * A page's answer to a delegated call, held to the caps the worker applies to page data it reads itself: each render
 * slot through {@link capRender}, an inline `image`/`images` entry over the size dropped, and the text `result` clipped
 * to {@link pageResultCap} with `clipOut`, followed by a {@link droppedNote} for each part dropped. Anything that is not
 * an object is returned as it came.
 * @param env what the page answered
 * @param name the tool called
 * @param args the call's arguments
 * @param onCut called once per kind of cut, for the execution log
 * @returns `env` itself when nothing was over, else a copy within the caps
 */
export function capPageAnswer<T>(env: T, name: string, args: Record<string, unknown> | undefined, onCut?: (cut: PageAnswerCut) => void): T {
    if (!env || typeof env !== "object") return env;
    const e = env as Record<string, unknown>;
    const cuts: PageAnswerCut[] = [];
    const out: Record<string, unknown> = { ...e };
    let changed = false;
    for (const slot of ["renderIn", "renderOut"]) {
        if (!(slot in e)) continue;
        const capped = capRender(e[slot], (field, what, from, to) => cuts.push({ slot, field, what, from, to }));
        if (capped !== e[slot]) { out[slot] = capped; changed = true; }
    }
    if (typeof e.image === "string" && e.image.length > PAGE_TABLE_CAPS.html) {
        cuts.push({ slot: "envelope", field: "image", what: "image", from: e.image.length, to: 0 });
        delete out.image; delete out.imageLabel; changed = true;
    }
    if (Array.isArray(e.images)) {
        const kept = e.images.filter((im, i) => {
            const s = (im as { image?: unknown } | null)?.image;
            if (typeof s === "string" && s.length > PAGE_TABLE_CAPS.html) { cuts.push({ slot: "envelope", field: `images.${i}`, what: "image", from: s.length, to: 0 }); return false; }
            return true;
        });
        if (kept.length !== e.images.length) { out.images = kept; changed = true; }
    }
    // A result that is not a string is read as the loop reads it (`String`, agent-loop.ts `withText`): an array of strings
    // joins into one text, so it is clipped as that text. One that cannot be made a string is left to the loop, whose
    // `withText` throw becomes the step's error result.
    let raw: string | undefined;
    try { raw = typeof e.result === "string" ? e.result : e.result === undefined ? undefined : String(e.result); } catch { raw = undefined; }
    if (raw !== undefined) {
        const cap = pageResultCap(name, args);
        const dropped = cuts.filter((c) => c.what === "text" || c.what === "image").map((c) => droppedNote(c.slot === "envelope" ? c.field : `${c.slot}.${c.field}`, c.from));
        const clipped = clipOut(raw, cap);
        if (clipped !== raw) cuts.push({ slot: "envelope", field: "result", what: "result", from: raw.length, to: cap });
        const text = dropped.length ? `${clipped}\n\n${dropped.join("\n")}` : clipped;
        if (text !== e.result) { out.result = text; changed = true; }
    }
    for (const c of cuts) onCut?.(c);
    return (changed ? out : env) as T;
}
