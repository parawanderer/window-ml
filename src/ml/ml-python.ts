// ml-python.ts — the PYTHON surface of window.ml: running a snippet in the sandbox, and the page's reads of the tables
// its code names.
//
// `pythonExec` is the call. A cell reads a table with `ml.table(src)`. A page has no run the worker can read for at the
// call, so for a cell started here the page reads the sources the code writes as literals, before the cell
// (docs/spec/ML_TABLE.md, "Page callers"): `_hoistTable` judges ONE source by its shape (a table by value, a URL the
// page already fetched, a Google Sheet, a page table), exactly as the `tables` loader it replaced did, and
// `_resolveTable` is the DOM half of that. Lifted out of the object literal so they can live here; the members are
// still on `window.ml`, so `this` inside them is still the API object.
import { makeBackgroundTaskPromise } from "../bridge";
import type { TableValue, TableSource, MlApi, TablePreview, ShotBox } from "../contract";
import { googleSheetCsvUrl, nonEmptyTables, googleSheetId, elPath, queryAll, isElement, extractTable } from "../dom/dom";
import { mlFetchCache } from "./ml-fetch-cache";
import { tableLiterals, type TableLiteral } from "../python/table-literals";
import { isTable } from "../table/table-brand";
import { tableFromDelimited, castTableColumns } from "../table/table-data";

/** Is this a table handed over BY VALUE (see {@link TableValue})? The `Table` facade throws on keys it does not have, so
 *  it is recognised by its brand before anything probes it. */
export const isTableValue = (v: unknown): v is TableValue =>
    isTable(v) || (!!v && typeof v === "object" && !(typeof Element !== "undefined" && v instanceof Element)
        && Array.isArray((v as { columns?: unknown }).columns) && Array.isArray((v as { rows?: unknown }).rows));

// `value`: the whole table is in the value store under `key`, and the sandbox reads it there; only its preview rows (for the
// render) stay page-side, and they never travel with the run.
type LoadedTable = { source: TableSource; preview?: (string | number | boolean | null)[][]; rowCount?: number; data: { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string } | { kind: "value"; key: string; label: string; columns: string[]; delimiter?: string; headerless?: boolean } };

/**
 * Run a sandboxed Python snippet (Pyodide/WASM in an offscreen doc) with numpy, pandas and
 * Pillow. `image` (a CSS selector, an `@pt:`/`@box:` token, or an Element) is screenshotted and
 * injected as `img` (PIL.Image) + `img_np` (H×W×3 uint8). A cell reads a table with
 * `df = ml.table("<source>")`: from a page, only a source written as a literal in the code, which
 * this page reads before the cell runs. Needs the bundled Pyodide (`npm i` + `npm run fetch-pyodide`).
 *
 * @param {string} code Python. Reference `img`/`img_np`; `return` a value, or a base64
 *   image via `to_base64(...)`. `print()` output is captured as `stdout`.
 * @param {Object} [opts]
 * @param {string|Element} [opts.image] What to screenshot into the sandbox (omit for none).
 * @param {number} [opts.margin] For an `@pt` image: the crop radius (px) around the point.
 *   Defaults to the look-radius. Ignored for `@box`/selectors.
 * @returns {Promise<{ ok, value?, stdout, error?, inputImage?, inputTables? }>}
 *   `inputImage`/`inputTables` are what the sandbox saw (for the debug render).
 */
export const pythonExec = async function(this: MlApi, code: string, { image = null, margin = 0, onStdout = undefined, _pointers = undefined }: { image?: string | Element | null; margin?: number; onStdout?: (chunk: string, ts?: number) => void; _pointers?: Record<string, TableValue | { error: string }> } = {}): Promise<{ ok: boolean; value?: unknown; stdout: string; stdoutDropped?: number; error?: string; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; bootMs?: number; runMs?: number }> {
    // raw: the sandbox must see the container's/point's actual pixels — NOT the
    // look-verify overlay (the drawn @box outline / @pt marker) or its padding.
    // `margin` sets the crop radius around an @pt (default: the look-radius).
    const img = image != null ? await this.screenshot(image as string | Element, { raw: true, margin }) : null;
    // The image's crop transform (viewport top-left + dpr), so a cast:'pt'/'box' can project
    // the sandbox's IMAGE-pixel coordinate back to the viewport (else @pt/@box click off-target
    // on a dpr>1 display / an offset element). Computed AFTER the shot (post scroll-into-view).
    const imageBox = image != null ? this._shotBox(image as string | Element, margin) : null;
    const hoisted = await hoistTables(this, code, _pointers);
    // bootMs/runMs come back from the WORKER (the executor): a cold start is charged to the call
    // that paid for it, so a first run does not report the runtime download as its own script time.
    const r = await makeBackgroundTaskPromise("PYTHON_EXEC_REQUEST", "PYTHON_EXEC_RESPONSE",
        { code, image: img, stream: !!onStdout, ...(hoisted.length ? { hoisted: hoisted.map((h) => h.answer ? { src: h.src, opts: h.opts, answer: { source: h.answer.source, data: h.answer.data } } : { src: h.src, opts: h.opts, error: h.error }) } : {}) },
        undefined, null,
        // LIVE stdout (opt-in): each PYTHON_STREAM chunk for this run → onStdout (the tool's ctx.stream).
        onStdout ? { type: "PYTHON_STREAM", onProgress: (d) => onStdout(String((d as { chunk?: string }).chunk ?? ""), (d as { ts?: number }).ts) } : undefined) as { ok: boolean; value?: unknown; stdout: string; stdoutDropped?: number; error?: string; table?: { columns: string[]; rows: (string | number | boolean | null)[][]; rowCount?: number }; valueKey?: string; render?: "latex" | "img" | "figure"; bootMs?: number; runMs?: number };
    const extra: { inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | boolean | null)[][] } } = {};
    if (img) extra.inputImage = img;
    if (imageBox) extra.imageBox = imageBox;   // for cast:'pt'/'box' → project image px → viewport
    // A returned DataFrame → the UI renders a real table. Past its preview it carries the whole frame's row count, and
    // the value-store key its pointer will name.
    if (r.table) extra.resultTable = { ...r.table, ...(r.valueKey ? { value: r.valueKey } : {}) };
    const read = hoisted.flatMap((h) => h.answer ? [{ src: h.src, answer: h.answer }] : []);
    if (read.length) extra.inputTables = read.map(({ src, answer: l }) => ({
        name: src, source: l.source,
        ...(l.data.kind === "rows" ? { columns: l.data.columns, rows: l.data.rows } : l.data.kind === "value" ? { columns: l.data.columns, rows: l.preview ?? [], ...(l.rowCount != null ? { rowCount: l.rowCount } : {}) } : { html: true }),
    }));
    return Object.keys(extra).length ? { ...r, ...extra } : r;
};

/**
 * The tables a page-started cell's code names as `ml.table("…")` literals (table-literals.ts), each read here before the
 * cell by `_hoistTable`, the judgement a `tables` source had (ML_TABLE.md, "Page callers"). An `@tool:` pointer is the
 * table the run's loop resolved for it (`pointers`), or the fault it found; one it did not resolve is left out, and the
 * cell's call raises. A source
 * the page cannot read is left out too, so the cell's call raises with the reason it did not read, at the line that
 * names it, rather than the whole cell failing for a read in a branch that never runs.
 * @param ml the page's `window.ml`
 * @param code the cell
 * @param pointers the run's tables for the `@tool:` literals, by reference
 * @returns each literal read, with its options and answer
 */
export async function hoistTables(ml: MlApi, code: string, pointers?: Record<string, TableValue | { error: string }>): Promise<HoistedTable[]> {
    const out: HoistedTable[] = [];
    for (const { src, opts } of tableLiterals(code)) {
        const s = src.trim();
        // A page-started cell has no /files, and an `@file:` pointer is one.
        if (/^@file:|^\/files(\/|$)/.test(s)) { out.push({ src, opts, error: `ml.table(${JSON.stringify(s)}): a cell started from a page has no /files/; read an attached file in an agent run's python_exec.` }); continue; }
        const by = /^@tool:/.test(s) ? pointers?.[s] : s;
        if (by === undefined) continue;   // a pointer the loop did not resolve: the cell's call raises
        if (typeof by === "object" && "error" in by) { out.push({ src, opts, error: by.error }); continue; }
        try { out.push({ src, opts, answer: await ml._hoistTable(by, opts) }); }
        catch (e) { out.push({ src, opts, error: (e as Error)?.message || String(e) }); }
    }
    return out;
}

/** One literal a page read before its cell: the table, or why it was not read, which the cell's call raises. */
export type HoistedTable = { src: string; opts: TableLiteral["opts"] } & ({ answer: LoadedTable; error?: undefined } | { answer?: undefined; error: string });

/**
 * The URL a table source names when it is a PATH on the page's site (`/sales.csv`, `./data.csv`, `../data.csv`),
 * resolved against the page, or null when it is not one: a URL, a CSS selector, `current`, or a page not on the web. A
 * path is told from a selector by how it starts, since no CSS selector starts with `/`, `./` or `../`; `x.csv` IS a
 * selector (element `x`, class `csv`) and stays one. `//host/x` is protocol-relative, another origin, and is not a path.
 * The one rule for both hosts: the page's `_hoistTable` and the worker's reader (worker-tools.ts `workerTableRead`), so a
 * source loads the same table, or is refused with the same reason, wherever the run's Python runs.
 * @param src the source as the model wrote it
 * @param pageHref the URL of the page the run is on
 * @returns the absolute URL on the page's origin, or null
 */
export function sitePathUrl(src: string, pageHref: string): string | null {
    if (!/^(?:\.{1,2})?\/(?!\/)/.test(src)) return null;
    let page: URL;
    try { page = new URL(pageHref); } catch { return null; }
    if (!/^https?:$/.test(page.protocol)) return null;
    const url = new URL(src, page);
    return url.origin === page.origin ? url.href : null;
}

/**
 * Read ONE `ml.table` source for a page-started cell, before it runs, to `{ source, data }`, dispatching by the value's
 * shape: `'current'` or a Google Sheets URL → fetch its CSV; a path on the page's site (`sitePathUrl`) → the page's
 * fetched copy of it; anything else → a DOM selector/Element (a page table). The judgement a `tables` source had, unchanged
 * (ML_TABLE.md, "Page callers"); worker-tools.ts `workerTableRead` is the same rule for a run's cell, read at the call.
 * `source` carries the provenance for the debug render's label + tooltip. Page-side; async (sheets go through the
 * background fetch).
 */
export const _hoistTable = async function(this: MlApi, src: string | Element | TableValue, opts: TableLiteral["opts"] = {}): Promise<LoadedTable> {
    const raw = !!opts.raw;
    const delimited = { ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}), ...(opts.header !== undefined ? { header: opts.header } : {}) };
    const notDelimited = (what: string): void => {
        if (opts.delimiter !== undefined || opts.header !== undefined) throw new Error(`ml.table: ${what} names its own columns, so delimiter and header do not apply. Drop them, or read a CSV.`);
    };
    // A TABLE BY VALUE: a pointer's table the loop resolved, or a table a page script already holds. Whole tables
    // only. A prefix analysed as a DataFrame gives confident wrong numbers (a sum over the first 200 of 48,231
    // rows), so it is refused with the forms that load the rest.
    if (isTableValue(src)) {
        notDelimited("a pointer's table");
        const facade = isTable(src);
        const pointer = facade ? undefined : src.pointer;
        const what = pointer ?? "this table";
        const total = src.shape?.[0];
        const preview = src.truncated || (typeof total === "number" && total > src.rows.length);
        // A preview whose whole table is STORED: the sandbox reads the stored bytes (the background checks the
        // caller is entitled to them — a run it hosts, or the tab it gave the key to). The columns and split
        // decisions go along, so pandas names and parses it as the preview did.
        if (preview && !facade && src.value)
            return { source: { kind: "pointer", label: pointer ?? "a table value" }, preview: src.rows as (string | number | boolean | null)[][], ...(typeof total === "number" ? { rowCount: total } : {}),
                data: { kind: "value", key: src.value, label: what, columns: [...src.columns], ...(src.delimiter ? { delimiter: src.delimiter } : {}), ...(src.headerless ? { headerless: true } : {}) } };
        if (preview)
            throw new Error(`ml.table — ${what} holds ${src.rows.length.toLocaleString("en-US")} of ${typeof total === "number" ? total.toLocaleString("en-US") : "more"} rows, a preview rather than the whole table, so it is not read. Read the URL fetch_url read, ml.table("<the url>"), for the whole parsed table.`);
        return { source: { kind: "pointer", label: pointer ?? "a table value" }, data: { kind: "rows", columns: [...src.columns], rows: src.rows as (string | number | boolean | null)[][] } };
    }
    const isCurrent = src === "current";
    // A URL THE RUN ALREADY FETCHED. `fetch_url` parses a CSV into a TableLike and the fetch cache holds
    // it, so naming that URL here loads the WHOLE table as a DataFrame with no second request, no
    // re-parse, and no `read_csv` in the sandbox (which has no network anyway). The cache is the gate:
    // a URL that was never fetched is refused rather than fetched, so this cannot become an egress that
    // skips the approval `fetch_url` went through.
    // A path on this page's site ("/sales.csv", "./data.csv") is that URL (`sitePathUrl`, which the worker's loader
    // shares): models pass the path the task named after fetch_url read it absolute. The cache stays the gate.
    if (typeof src === "string" && typeof location !== "undefined") src = sitePathUrl(src, location.href) ?? src;
    if (typeof src === "string" && /^https?:\/\//i.test(src) && !googleSheetCsvUrl(src)) {
        const cached = mlFetchCache.get(src);
        if (cached?.table) {
            // The cache's parse is the table; a caller's own delimiter, header or raw parses its text again for this call.
            const t = (raw || opts.delimiter !== undefined || opts.header !== undefined) && typeof cached.text === "string" && !cached.truncated
                ? tableFromDelimited(cached.text, { raw, ...delimited }) : cached.table;
            return { source: { kind: "fetch", label: cached.url }, data: { kind: "rows", columns: t.columns, rows: t.rows } };
        }
        throw new Error(cached
            ? `ml.table — "${src}" was fetched but isn't a table (type: ${cached.type}). Only a CSV/TSV reads as a table.`
            // EVICTED is not NEVER FETCHED. Telling a model a URL it fetched two steps ago was never
            // fetched sends it hunting for a mistake it did not make.
            : mlFetchCache.wasEvicted(src)
                ? `ml.table — "${src}" was fetched earlier, but its parsed table has since been dropped from the page's fetch cache to keep memory bounded. Call fetch_url on it again (it is already approved), then read it here.`
                // NOT "in this run": the cache is the PAGE's, so a URL the run fetched before it navigated is gone too.
                : `ml.table — "${src}" is not in this page's fetch cache: it was not fetched here, it was fetched with credentials:true or rendered:true (those reads are never cached), or it was fetched on a page the run has since left (the cache does not survive a navigation). Call fetch_url on it without credentials or rendered, then read it here.`);
    }
    if (isCurrent || (typeof src === "string" && googleSheetCsvUrl(src))) {
        const target = isCurrent ? (typeof location !== "undefined" ? location.href : "") : String(src);
        const csvUrl = googleSheetCsvUrl(target);
        if (!csvUrl) {
            notDelimited("a page table");
            if (isCurrent) return pageTable(this, "current", raw);
            throw new Error(`ml.table — "${String(src)}" isn't a Google Sheets URL.`);
        }
        const { csv, name: sheetName } = await makeBackgroundTaskPromise<{ csv: string; name: string | null }>("FETCH_SHEET_REQUEST", "FETCH_SHEET_RESPONSE", { url: csvUrl });
        // The Sheets export is ALWAYS comma-separated, so it is named rather than discovered: a sheet
        // whose first row holds no comma (one column, or a title cell) would otherwise be guessed at.
        const sheet = tableFromDelimited(csv, { delimiter: opts.delimiter ?? ",", raw, ...(opts.header !== undefined ? { header: opts.header } : {}) });
        const source: TableSource = isCurrent
            ? { kind: "sheet-current", label: (typeof document !== "undefined" && document.title) ? document.title : "current sheet" }
            : { kind: "sheet-external", label: googleSheetId(String(src)) || String(src), name: sheetName };   // label = id (for the link), name = the real title (chip)
        return { source, data: { kind: "rows", columns: sheet.columns, rows: sheet.rows } };
    }
    notDelimited("a page table");
    if (typeof src === "string") return pageTable(this, src, raw);
    return { source: { kind: "dom", label: elPath(src) }, data: this._resolveTable(src, raw) };
};

/**
 * A table of THIS page, read from its DOM: a CSS selector's first match, or `"current"` (the page's one non-empty
 * `<table>`, the shorthand the tool advertises only when there is exactly one). The one reader for a page table, used by
 * `_hoistTable` and, for a run whose python_exec runs in the worker, by the page's answer to the worker's question
 * (run-delegation.ts `pageRead`), so both read a page table the same way. Not a Google Sheet's `current`: that is fetched.
 * @param ml the page's `window.ml`
 * @param src a CSS selector, or `"current"`
 * @param raw keep every cell a string
 * @returns the table's provenance and data
 * @throws a sentence naming what is wrong (no match, no table, an empty or ambiguous one)
 */
export function pageTable(ml: Pick<MlApi, "_resolveTable">, src: string, raw = false): Pick<LoadedTable, "source" | "data"> {
    if (src !== "current") return { source: { kind: "dom", label: src }, data: ml._resolveTable(src, raw) as LoadedTable["data"] };
    // 0 or >1 → say so, steer to a selector.
    const tables = typeof document !== "undefined" ? nonEmptyTables(document) : [];
    if (tables.length === 1) return { source: { kind: "dom", label: "current page table" }, data: ml._resolveTable(tables[0], raw) as LoadedTable["data"] };
    throw new Error(tables.length === 0
        ? "ml.table('current') — this page is neither a Google Sheet nor has a table with data. Pass a CSS selector."
        : `ml.table('current') — this page has ${tables.length} tables (ambiguous). Pass a CSS selector to pick one.`);
}

/**
 * Resolve a `table` target (selector/Element) to what the sandbox loads as `df`:
 * a structured `{ kind:"rows", columns, rows }` from a clean table/ARIA grid (numeric
 * columns cast page-side so pandas infers numbers, unless `raw`), else `{ kind:"html",
 * html }` (the element's outerHTML) for `pd.read_html`. Page-side.
 */
export const _resolveTable = function(target: string | Element, raw = false): { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string } {
    let el: Element | undefined;
    if (typeof target === "string") {
        try { el = queryAll(target)[0]; }
        catch {
            // Invalid CSS selector — almost always the model wrapped it in extra quotes ("table#sales"
            // instead of table#sales), producing a raw, opaque querySelectorAll SyntaxError. ACCOMMODATE:
            // strip surrounding quotes and retry; only if THAT still fails, give a clear, actionable error.
            const bare = target.replace(/^\s*['"`]+|['"`]+\s*$/g, "").trim();
            try { if (bare && bare !== target) el = queryAll(bare)[0]; } catch { /* still invalid */ }
            if (!isElement(el)) throw new Error(`ml.table: "${target}" is not a valid CSS selector. Pass a BARE selector (e.g. \`#sales\` or \`table#sales\`), NOT a quoted string.`);
        }
    } else el = target;
    if (!isElement(el)) throw new Error(`ml.pythonExec: no table element matches "${String(target)}".`);
    const t = extractTable(el);
    if (!t) {
        // extractTable couldn't parse it (spans/nested/non-table) → the pd.read_html fallback
        // over outerHTML. That only works if a NON-EMPTY <table> is actually present, so guard
        // the two ways it isn't — a collapsed/lazily-rendered table (the node exists, its rows
        // don't) is the common trigger — with an actionable message, instead of the obscure
        // pandas ValueError it becomes downstream ("No tables found matching pattern '.+'").
        const label = typeof target === "string" ? target : elPath(el);
        const tbl = el.matches("table") ? el : el.querySelector("table");
        if (!tbl) {
            // No <table> to read_html. An ARIA grid extractTable couldn't parse gets its own
            // message (read_html can't help it — it has no <table> tag by construction).
            if (el.matches("[role=table], [role=grid], [role=treegrid]") || el.querySelector("[role=table], [role=grid], [role=treegrid]"))
                throw new Error(`ml.pythonExec: "${label}" is an ARIA grid python_exec couldn't parse — it may be empty, virtualized, or missing role=row/cell markup. Reveal/scroll its rows into view, or target a clean <table>.`);
            throw new Error(`ml.pythonExec: "${label}" matched a <${el.tagName.toLowerCase()}> with no <table> inside — python_exec needs a <table> or a clean ARIA grid.`);
        }
        if (!tbl.querySelector("tr") || !(tbl.textContent || "").trim()) throw new Error(`ml.pythonExec: "${label}" matched an EMPTY table (no rows) — it may be collapsed or lazily rendered. Reveal it first (scroll it into view / click a "show"/"load" control), then retry.`);
        return { kind: "html", html: el.outerHTML };
    }
    return { kind: "rows", columns: t.columns, rows: raw ? t.rows : castTableColumns(t.columns, t.rows) };
};
