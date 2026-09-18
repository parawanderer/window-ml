// ml-python.ts — the PYTHON surface of window.ml: running a snippet in the sandbox, and getting tables into it.
//
// `pythonExec` is the call; the other two exist because the sandbox has no network and no DOM, so every
// DataFrame it sees has to be resolved and parsed on this side first. `_loadTable` dispatches ONE `tables:`
// source by its shape (a table by value, a URL the run already fetched, a Google Sheet, a page table) and
// `_resolveTable` is the DOM half of that. Lifted out of the object literal so they can live here; the
// members are still on `window.ml`, so `this` inside them is still the API object.
import { makeBackgroundTaskPromise } from "./bridge";
import type { TableValue, TableSource, MlApi, TablePreview, ShotBox } from "./contract";
import { googleSheetCsvUrl, nonEmptyTables, googleSheetId, elPath, queryAll, isElement, extractTable } from "./dom";
import { mlFetchCache } from "./ml-fetch-cache";
import { pyVarNameError } from "./python-env";
import { isTable } from "./table-brand";
import { tableFromDelimited, castTableColumns } from "./table-data";

/** Is this a table handed over BY VALUE (see {@link TableValue})? The `Table` facade throws on keys it does not have, so
 *  it is recognised by its brand before anything probes it. */
const isTableValue = (v: unknown): v is TableValue =>
    isTable(v) || (!!v && typeof v === "object" && !(typeof Element !== "undefined" && v instanceof Element)
        && Array.isArray((v as { columns?: unknown }).columns) && Array.isArray((v as { rows?: unknown }).rows));

// `value`: the whole table is in the value store under `key`, and the sandbox reads it there; only its preview rows (for the
// render) stay page-side, and they never travel with the run.
type LoadedTable = { name: string; source: TableSource; preview?: (string | number | boolean | null)[][]; rowCount?: number; data: { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string } | { kind: "value"; key: string; label: string; columns: string[]; delimiter?: string; headerless?: boolean } };

/**
 * Run a sandboxed Python snippet (Pyodide/WASM in an offscreen doc) with numpy +
 * Pillow — for pixel/array/spatial work Python does better than JS. `image` (a CSS
 * selector, an `@pt:`/`@box:` token, or an Element) is screenshotted and injected as
 * `img` (PIL.Image) + `img_np` (H×W×3 uint8). The sandbox has NO network/filesystem/
 * DOM access. Needs the bundled Pyodide (`npm i` + `npm run fetch-pyodide`).
 *
 * @param {string} code Python. Reference `img`/`img_np`; `return` a value, or a base64
 *   image via `to_base64(...)`. `print()` output is captured as `stdout`.
 * @param {Object} [opts]
 * @param {string|Element} [opts.image] What to screenshot into the sandbox (omit for none).
 * @param {"readonly"|"full"} [opts.mode] `"readonly"` (default) hardens the sandbox — no
 *   network, no JS/extension scope — so it's a pure function over the injected data;
 *   `"full"` leaves those bridges intact (network etc.), and the agent tool always asks
 *   for approval before a full-mode run.
 * @param {number} [opts.margin] For an `@pt` image: the crop radius (px) around the point.
 *   Defaults to the look-radius. Ignored for `@box`/selectors.
 * @param {string|Element|Object} [opts.tables] Spreadsheet/table data to load as pandas
 *   DataFrame(s). A single source (a CSS selector for a page table, a Google Sheets URL, or
 *   `"current"`) → loaded as `df`; a map `{ name: source }` → loaded under those variable
 *   names (so you can join them). A Sheets URL is fetched with the user's Google login; an
 *   external one requires approval. Each arrives ALREADY parsed — reference it, don't re-load it.
 * @returns {Promise<{ ok, value?, stdout, error?, inputImage?, inputTables? }>}
 *   `inputImage`/`inputTables` are what the sandbox saw (for the debug render).
 */
export const pythonExec = async function(this: MlApi, code: string, { image = null, mode = "readonly", margin = 0, tableRaw = false, tables = null, onStdout = undefined }: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | TableValue | Record<string, string | Element | TableValue> | null; onStdout?: (chunk: string, ts?: number) => void } = {}): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; bootMs?: number; runMs?: number }> {
    // raw: the sandbox must see the container's/point's actual pixels — NOT the
    // look-verify overlay (the drawn @box outline / @pt marker) or its padding.
    // `margin` sets the crop radius around an @pt (default: the look-radius).
    const img = image != null ? await this.screenshot(image as string | Element, { raw: true, margin }) : null;
    // The image's crop transform (viewport top-left + dpr), so a cast:'pt'/'box' can project
    // the sandbox's IMAGE-pixel coordinate back to the viewport (else @pt/@box click off-target
    // on a dpr>1 display / an offset element). Computed AFTER the shot (post scroll-into-view).
    const imageBox = image != null ? this._shotBox(image as string | Element, margin) : null;
    // `tables` is a single source (→ `df`) OR a map { name: source }. Normalize to an ordered
    // [name, src] list; every source auto-dispatches by shape (a Sheets URL / 'current' →
    // sheet, else a DOM selector/Element) so one call can join a page table and a sheet.
    const specs: { name: string; src: string | Element | TableValue }[] = [];
    // Args arrive off the wire as JSON, so `tables` can be any shape regardless of the declared type.
    // An ARRAY is neither documented form, but models write `tables: ["current"]` — the schema is a
    // `oneOf`, and wrapping a lone value in a list is an easy slip. A ONE-element array is unambiguous
    // (it IS the single source), so take it rather than burning a turn. More than one carries no NAMES,
    // which is the entire point of the map form, so say that — instead of letting Object.entries turn
    // the indices into "0"/"1" and reporting `"0" isn't a valid Python variable name`, a name the model
    // never wrote and could not act on (it retried the same call and looped).
    let tableArg: unknown = tables;
    if (Array.isArray(tableArg)) {
        if (tableArg.length === 0) tableArg = null;
        else if (tableArg.length === 1) tableArg = tableArg[0];
        else throw new Error(`pythonExec tables: got an array of ${tableArg.length} sources, which carries no variable NAMES — a list can't say what to call each DataFrame. Pass a MAP so each one has a name you can use in the code, e.g. {"sales": ${JSON.stringify(String(tableArg[0]))}, "targets": ${JSON.stringify(String(tableArg[1]))}}. For ONE table, pass the source string on its own and it loads as \`df\`.`);
    }
    if (tableArg != null) {
        if (typeof tableArg === "string" || (typeof Element !== "undefined" && tableArg instanceof Element) || isTableValue(tableArg)) specs.push({ name: "df", src: tableArg as string | Element | TableValue });
        else if (typeof tableArg !== "object") throw new Error(`pythonExec tables: expected a source string or a {name: source} map, got ${typeof tableArg}.`);
        else for (const [name, src] of Object.entries(tableArg as Record<string, string | TableValue>)) {
            const nameErr = pyVarNameError(name);
            if (nameErr) throw new Error(`pythonExec tables: ${nameErr}`);
            specs.push({ name, src });
        }
    }
    const loaded: LoadedTable[] = [];
    for (const spec of specs) loaded.push(await this._loadTable(spec.name, spec.src, tableRaw));

    // Alias each df in the `tables` dict by its SOURCE string too (e.g. a single source "current"
    // → tables['current']): a model that passed `"tables": "current"` naturally reaches for
    // tables['current'], not the internal `df` name. Accommodate it (string sources only).
    // bootMs/runMs come back from the WORKER (the executor): a cold start is charged to the call
    // that paid for it, so a first run does not report the runtime download as its own script time.
    const r = await makeBackgroundTaskPromise("PYTHON_EXEC_REQUEST", "PYTHON_EXEC_RESPONSE",
        { code, image: img, hardened: mode !== "full", stream: !!onStdout, tables: loaded.map((l, i) => ({ name: l.name, data: l.data, alias: typeof specs[i].src === "string" ? specs[i].src as string : null })) },
        undefined, null,
        // LIVE stdout (opt-in): each PYTHON_STREAM chunk for this run → onStdout (the tool's ctx.stream).
        onStdout ? { type: "PYTHON_STREAM", onProgress: (d) => onStdout(String((d as { chunk?: string }).chunk ?? ""), (d as { ts?: number }).ts) } : undefined) as { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | boolean | null)[][]; rowCount?: number }; valueKey?: string; render?: "latex" | "img"; bootMs?: number; runMs?: number };
    const extra: { inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | boolean | null)[][] } } = {};
    if (img) extra.inputImage = img;
    if (imageBox) extra.imageBox = imageBox;   // for cast:'pt'/'box' → project image px → viewport
    // A returned DataFrame → the UI renders a real table. Past its preview it carries the whole frame's row count, and
    // the value-store key its pointer will name.
    if (r.table) extra.resultTable = { ...r.table, ...(r.valueKey ? { value: r.valueKey } : {}) };
    if (loaded.length) extra.inputTables = loaded.map(l => ({
        name: l.name, source: l.source,
        ...(l.data.kind === "rows" ? { columns: l.data.columns, rows: l.data.rows } : l.data.kind === "value" ? { columns: l.data.columns, rows: l.preview ?? [], ...(l.rowCount != null ? { rowCount: l.rowCount } : {}) } : { html: true }),
    }));
    return Object.keys(extra).length ? { ...r, ...extra } : r;
};

/**
 * Resolve ONE `tables` source to a loaded DataFrame spec `{ name, source, data }`, dispatching
 * by the value's shape: `'current'` or a Google Sheets URL → fetch its CSV; anything else →
 * a DOM selector/Element (a page table). `source` carries the provenance for the debug
 * render's label + tooltip. Page-side; async (sheets go through the background fetch).
 */
export const _loadTable = async function(this: MlApi, name: string, src: string | Element | TableValue, raw = false): Promise<LoadedTable> {
    // A TABLE BY VALUE: a pointer's table the loop resolved, or a table a page script already holds. Whole tables
    // only. A prefix analysed as a DataFrame gives confident wrong numbers (a sum over the first 200 of 48,231
    // rows), so it is refused with the forms that load the rest.
    if (isTableValue(src)) {
        const facade = isTable(src);
        const pointer = facade ? undefined : src.pointer;
        const what = pointer ?? "this table";
        const total = src.shape?.[0];
        const preview = src.truncated || (typeof total === "number" && total > src.rows.length);
        // A preview whose whole table is STORED: the sandbox reads the stored bytes (the background checks the
        // caller is entitled to them — a run it hosts, or the tab it gave the key to). The columns and split
        // decisions go along, so pandas names and parses it as the preview did.
        if (preview && !facade && src.value)
            return { name, source: { kind: "pointer", label: pointer ?? "a table value" }, preview: src.rows as (string | number | boolean | null)[][], ...(typeof total === "number" ? { rowCount: total } : {}),
                data: { kind: "value", key: src.value, label: what, columns: [...src.columns], ...(src.delimiter ? { delimiter: src.delimiter } : {}), ...(src.headerless ? { headerless: true } : {}) } };
        if (preview)
            throw new Error(`pythonExec tables — ${what} holds ${src.rows.length.toLocaleString("en-US")} of ${typeof total === "number" ? total.toLocaleString("en-US") : "more"} rows, a preview rather than the whole table, so it is not loaded. Pass the URL fetch_url read (tables: {df: "<the url>"}) to load the whole parsed table.`);
        return { name, source: { kind: "pointer", label: pointer ?? "a table value" }, data: { kind: "rows", columns: [...src.columns], rows: src.rows as (string | number | boolean | null)[][] } };
    }
    const isCurrent = src === "current";
    // A URL THE RUN ALREADY FETCHED. `fetch_url` parses a CSV into a TableLike and the fetch cache holds
    // it, so naming that URL here loads the WHOLE table as a DataFrame with no second request, no
    // re-parse, and no `read_csv` in the sandbox (which has no network anyway). The cache is the gate:
    // a URL that was never fetched is refused rather than fetched, so this cannot become an egress that
    // skips the approval `fetch_url` went through.
    if (typeof src === "string" && /^https?:\/\//i.test(src) && !googleSheetCsvUrl(src)) {
        const cached = mlFetchCache.get(src);
        if (cached?.table) {
            const t = cached.table;
            return { name, source: { kind: "fetch", label: cached.url }, data: { kind: "rows", columns: t.columns, rows: t.rows } };
        }
        throw new Error(cached
            ? `pythonExec tables — "${src}" was fetched but isn't a table (type: ${cached.type}). Only a CSV/TSV parses into a DataFrame this way.`
            // EVICTED is not NEVER FETCHED. Telling a model a URL it fetched two steps ago was never
            // fetched sends it hunting for a mistake it did not make.
            : mlFetchCache.wasEvicted(src)
                ? `pythonExec tables — "${src}" was fetched earlier, but its parsed table has since been dropped from the page's fetch cache to keep memory bounded. Call fetch_url on it again (it is already approved), then pass the URL here.`
                : `pythonExec tables — "${src}" hasn't been fetched in this run. Call fetch_url on it first; its parsed table is then loaded from the cache.`);
    }
    if (isCurrent || (typeof src === "string" && googleSheetCsvUrl(src))) {
        const target = isCurrent ? (typeof location !== "undefined" ? location.href : "") : String(src);
        const csvUrl = googleSheetCsvUrl(target);
        if (!csvUrl) {
            // `current` on a NON-sheet page → the page's single non-empty <table> (the shorthand
            // the tool only advertises when there's exactly one). 0 or >1 → say so, steer to a selector.
            if (isCurrent) {
                const tables = typeof document !== "undefined" ? nonEmptyTables(document) : [];
                if (tables.length === 1) {
                    const data = this._resolveTable(tables[0], raw);
                    return { name, source: { kind: "dom", label: "current page table" }, data };
                }
                throw new Error(tables.length === 0
                    ? "pythonExec tables:'current' — this page is neither a Google Sheet nor has a table with data. Pass a CSS selector."
                    : `pythonExec tables:'current' — this page has ${tables.length} tables (ambiguous). Pass a CSS selector to pick one.`);
            }
            throw new Error(`pythonExec — "${String(src)}" isn't a Google Sheets URL.`);
        }
        const { csv, name: sheetName } = await makeBackgroundTaskPromise<{ csv: string; name: string | null }>("FETCH_SHEET_REQUEST", "FETCH_SHEET_RESPONSE", { url: csvUrl });
        // The Sheets export is ALWAYS comma-separated, so it is named rather than discovered: a sheet
        // whose first row holds no comma (one column, or a title cell) would otherwise be guessed at.
        const sheet = tableFromDelimited(csv, { delimiter: ",", raw });
        const source: TableSource = isCurrent
            ? { kind: "sheet-current", label: (typeof document !== "undefined" && document.title) ? document.title : "current sheet" }
            : { kind: "sheet-external", label: googleSheetId(String(src)) || String(src), name: sheetName };   // label = id (for the link), name = the real title (chip)
        return { name, source, data: { kind: "rows", columns: sheet.columns, rows: sheet.rows } };
    }
    const data = this._resolveTable(src, raw);
    return { name, source: { kind: "dom", label: typeof src === "string" ? src : elPath(src) }, data };
};

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
            if (!isElement(el)) throw new Error(`ml.pythonExec tables: "${target}" is not a valid CSS selector. Pass a BARE selector (e.g. \`#sales\` or \`table#sales\`), NOT a quoted string.`);
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
