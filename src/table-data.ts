// The one place a TABLE is produced and described, whatever it was parsed from — the Google Sheets CSV
// export, a fetched .csv/.tsv, a DOM `<table>` (walked in dom.ts, shaped here), and later Parquet. Before
// this module the CSV handling was three unrelated fragments: a hand-written RFC-4180 reader for the Sheets
// export, a comma-only `looksCsv` sniff driving content classification, and numeric casting for pandas —
// which is why a semicolon-separated file classified as "text" while a `.tsv` classified as "csv" and then
// parsed on commas. One representation ({@link TableLike}) and one parser now serve all of them.
//
// DELIMITED PARSING IS PAPA PARSE'S, not ours. Discovering a separator, RFC-4180 quoting (embedded
// delimiters, newlines, doubled quotes) and reporting malformed rows is a solved, heavily-exercised
// problem, and the hand-written reader only looked adequate because its one caller was always commas.
// What stays ours is the part that is about THIS project: which cells become numbers (below), and what a
// model is shown of a table it did not fetch.
import Papa from "papaparse";
import { brandTable, brandStored } from "./table-brand";
// The TABLE TYPES live in contract.ts, not here: they cross the message channel (a fetch result, a pointer
// read, an agent output) and `agent_api_docs` is generated from that file, so a type defined here would be
// invisible to the model that has to use it. This module owns the PARSERS; contract.ts owns the shape.
import type { TableLike, TableCell, TableDtype, Table } from "./contract";
export type { TableLike, TableCell, TableDtype, Table };

/** The most LINES a parse keeps, header included — so a table with a header carries one row fewer. A bound
 *  on MEMORY, not on what a model sees (that is the preview's job, and much smaller): a fetched CSV is meant
 *  to be handed to `python_exec` whole, so this sits far above realistic files and exists only so a
 *  pathological body cannot exhaust the worker. Hitting it sets `truncated`, never silently drops. */
export const MAX_TABLE_ROWS = 200_000;

/** Delimiters worth guessing between, in preference order — Papa's default set minus its ASCII record/unit
 *  separators (nothing serves those over HTTP) . `|` is included because pipe-separated exports are real,
 *  but it is also what a Markdown table looks like, which {@link looksCsv} has to rule out. */
const DELIMITERS = [",", "\t", ";", "|"];

/** A Markdown table's separator row (`|---|:---:|`) — the one shape that parses as clean pipe-delimited data
 *  and is not data at all. Checked when a pipe delimiter is guessed during CLASSIFICATION; an explicit
 *  `delimiter: "|"` is taken at its word. */
const MD_RULE_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** Lex delimited text into raw string rows, discovering the delimiter unless one is given. Thin over Papa:
 *  the only thing added is the row cap. Empty lines are dropped ("greedy" — including whitespace-only ones,
 *  which a trailing newline and a hand-edited file both produce). Pure. */
export function parseDelimited(text: string, delimiter?: string, maxRows = MAX_TABLE_ROWS): { rows: string[][]; delimiter: string; truncated: boolean; total: number } {
    const out = Papa.parse<string[]>(String(text ?? ""), {
        delimiter: delimiter ?? "",          // "" = discover it
        delimitersToGuess: DELIMITERS,
        skipEmptyLines: "greedy",
        // Never dynamicTyping: it casts PER CELL, so one "N/A" in a numeric column yields a column of mixed
        // numbers and strings. castTableColumns decides per COLUMN, which is what pandas needs.
    });
    // One line over the cap, so a header row does not cost a data row; tableFromDelimited caps the BODY. `total`
    // is every line Papa read — the cap bounds what is kept, never what is counted, since the whole text was
    // lexed either way and the count is what lets a prefix say what it is a prefix of.
    const rows = out.data.slice(0, maxRows + 1);
    return { rows, delimiter: out.meta.delimiter || ",", truncated: out.data.length > maxRows + 1, total: out.data.length };
}

/** Parse RFC-4180 CSV → an array of rows (each an array of string cells), header row included. Handles
 *  quoted fields with embedded commas, newlines, and doubled `""` quotes. Comma-separated unless
 *  `delimiter` says otherwise. Pure. */
export function parseCsv(text: string, delimiter = ","): string[][] {
    return parseDelimited(text, delimiter).rows;
}

/** Delimited text → a {@link TableLike}: the first row becomes the header, the rest are rows, and numeric
 *  columns are cast for pandas unless `raw`. `delimiter` overrides discovery (a caller that KNOWS, like the
 *  Sheets export, should say so rather than let a comma-less first line be guessed at). Pure. */
export function tableFromDelimited(text: string, opts: { delimiter?: string; raw?: boolean; header?: boolean | "auto"; maxRows?: number } = {}): TableLike {
    const maxRows = opts.maxRows ?? MAX_TABLE_ROWS;
    const { rows: all, delimiter, total } = parseDelimited(text, opts.delimiter, maxRows);
    // Whether row 0 is a HEADER or the first record. Getting this wrong is not a cosmetic error: treating a
    // data row as a header eats a record AND names the columns after its values, and the table then renders
    // perfectly while being quietly short one row — wrong in the way that looks right.
    const header = opts.header === undefined || opts.header === "auto" ? hasHeaderRow(all) : opts.header;
    const columns = header ? namedColumns(all[0] || []) : positionalColumns(all[0]?.length || 0);
    const body = (header ? all.slice(1) : all).slice(0, maxRows);
    // The SOURCE's data rows, not the kept ones: past the cap, `shape` must still say how big the file is.
    const rowCount = total - (header ? 1 : 0);
    // Pad ragged rows to the header width so every row can be indexed by column position. Papa reports
    // these as errors; we do not reject on them, because a single malformed line in a large export should
    // cost that line's tail, not the whole table.
    const width = columns.length;
    const padded = width ? body.map(r => r.length === width ? r : Array.from({ length: width }, (_, i) => r[i] ?? "")) : body;
    const rows = opts.raw ? padded : castTableColumns(columns, padded);
    return { ...tableOf(columns, rows, Math.max(rowCount, rows.length)), delimiter, ...(header ? {} : { headerless: true }) };
}

/** Positional column names for a table with no header row — `0`, `1`, `2`, exactly what `read_csv(header=None)`
 *  produces, so the frame a model sees is one it already knows how to index. Pure. */
export function positionalColumns(width: number): string[] {
    return Array.from({ length: width }, (_, i) => String(i));
}

/** Does row 0 look like a HEADER rather than the first record? The argument is `csv.Sniffer.has_header`'s:
 *  a header is text where the body is data, so the evidence is per column — a column whose BODY parses as
 *  numbers but whose first cell does not is a header cell; one that parses as a number just like the rows
 *  under it is a record.
 *
 *  Ties and all-text tables default to TRUE, which is the safer of the two wrong answers: a header mistaken
 *  for data costs one junk row at the top of the frame, visibly; data mistaken for a header DELETES a record
 *  and mislabels every column, invisibly. Pure. */
export function hasHeaderRow(rows: string[][]): boolean {
    if (rows.length < 2) return true;               // nothing to compare against
    const [first, ...body] = rows;
    let forHeader = 0, against = 0;
    for (let c = 0; c < first.length; c++) {
        // Is this column NUMERIC in the body? Same 90% rule the cast uses, so the two cannot disagree about
        // what a numeric column is.
        let seen = 0, numeric = 0;
        for (const r of body) {
            const v = String(r[c] ?? "").trim();
            if (!v) continue;
            seen++;
            if (parseNumericCell(v) != null) numeric++;
        }
        if (!seen || numeric / seen < 0.9) continue;   // a text column tells us nothing either way
        if (parseNumericCell(String(first[c] ?? "").trim()) == null) forHeader++; else against++;
    }
    return forHeader >= against;
}

/** Assemble a {@link TableLike} from columns + already-cast rows — the one place `shape` and `dtypes` are
 *  derived, so every producer (CSV, a DOM table, a binary format) describes itself identically. Pass
 *  `rowCount` when `rows` is a PREFIX of a larger table: `shape` then reports the true size and `truncated`
 *  is set, rather than the frame quietly describing the sample as though it were the whole. Pure. */
export function tableOf(columns: string[], rows: TableCell[][], rowCount?: number): TableLike {
    const total = rowCount ?? rows.length;
    return {
        columns, rows, shape: [total, columns.length], dtypes: dtypesOf(columns, rows),
        ...(total > rows.length ? { truncated: true } : {}),
    };
}

/** Header labels made usable as keys, the way pandas does it: a blank becomes `Unnamed: <position>`, and a
 *  repeat gets a numeric suffix (`a`, `a.1`) rather than silently overwriting the first — which is what a
 *  plain `Record<string, …>` of dtypes would otherwise do to a CSV with two columns called "total". Pure. */
export function namedColumns(raw: string[]): string[] {
    const seen = new Map<string, number>(), out: string[] = [];
    raw.forEach((c, i) => {
        const base = String(c ?? "").trim() || `Unnamed: ${i}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.push(n ? `${base}.${n}` : base);
    });
    return out;
}

/** The dtype pandas 3 gives each column of `rows` when they become `pd.DataFrame(rows)` — which is what a table
 *  becomes in `python_exec`. MEASURED against pandas 3.0.2 rather than recalled, because two of the rules surprise:
 *
 *  | values | dtype |
 *  | --- | --- |
 *  | whole numbers | `int64` — `float64` if any cell is null |
 *  | any fractional number | `float64` |
 *  | strings | `str`, with or without nulls |
 *  | booleans | `bool` — but `object` if any cell is null |
 *  | all null, or a mix of kinds | `object` |
 *
 *  `str` is pandas 3's name; pandas 2 said `object`, and so did this function, which is what the preview told
 *  the model while the real DataFrame printed `str`. An empty string is a STRING here, not a null: a numeric
 *  column's blanks are already nulls by the time this runs (the cast makes them so), and a text column's
 *  empty cells stay strings in the DataFrame too. Read off the CAST values, so this describes what a consumer
 *  actually gets. Pure. */
export function dtypesOf(columns: string[], rows: TableCell[][]): Record<string, TableDtype> {
    const out: Record<string, TableDtype> = {};
    columns.forEach((name, c) => {
        let ints = 0, floats = 0, strs = 0, bools = 0, nulls = 0, other = 0;
        for (const r of rows) {
            const v = r[c];
            if (v == null) nulls++;
            else if (typeof v === "number") { if (Number.isInteger(v)) ints++; else floats++; }
            else if (typeof v === "string") strs++;
            else if (typeof v === "boolean") bools++;
            else other++;
        }
        const nums = ints + floats;
        const kinds = (nums ? 1 : 0) + (strs ? 1 : 0) + (bools ? 1 : 0) + (other ? 1 : 0);
        out[name] = kinds !== 1 ? "object"                                  // all null, or mixed
            : nums ? (floats || nulls ? "float64" : "int64")
            : strs ? "str"
            : bools ? (nulls ? "object" : "bool")
            : "object";
    });
    return out;
}

/** Does the head of a body look like delimited data? True when a delimiter is discoverable and the first
 *  few lines agree on a field count of ≥2 — the signal that the Content-Type is generic (text/plain) but
 *  the body is a table. A Markdown table is excluded: it parses as clean pipe-delimited data, so without
 *  this check a `.md` document that opens with a table would classify as CSV. Pure. */
export function looksCsv(head: string): boolean {
    return sniffDelimiter(head) !== null;
}

/** The delimiter a body appears to use, or null when it does not look delimited at all. Consistency is what
 *  decides: Papa falls back to a comma (with an error) when it cannot guess, so a one-column file and a page
 *  of prose both "parse" as a single column — which is exactly the shape this must reject. Pure. */
export function sniffDelimiter(head: string): string | null {
    const lines = String(head ?? "").split(/\r?\n/).filter(l => l.trim()).slice(0, 6);
    if (lines.length < 2) return null;
    const sample = lines.join("\n");
    const { rows, delimiter } = parseDelimited(sample);
    if (rows.length < 2) return null;
    const width = rows[0].length;
    if (width < 2 || !rows.every(r => r.length === width)) return null;
    // A column that is EMPTY in every row means the delimiter split something that was not a table. This is
    // what a page of code looks like to a semicolon: `const x = 1;` and `export default x;` both "parse" as
    // two consistent fields whose second is blank. A real export can carry an empty column, but not as the
    // whole of what makes it look delimited.
    for (let c = 0; c < width; c++) if (rows.every(r => !String(r[c] ?? "").trim())) return null;
    // A Markdown table: `| a | b |` over `|---|---|`. Data, to this parser; prose, to everyone else.
    if (delimiter === "|" && lines.some(l => MD_RULE_ROW.test(l))) return null;
    return delimiter;
}

/** Parse a table cell as a number, tolerating corporate formatting — thousands commas,
 *  currency ($€£¥), a trailing %, whitespace, and accounting parens ((150) → -150). Returns
 *  null when it isn't a clean int/decimal (names, alphanumeric IDs, blanks). Pure. */
export function parseNumericCell(v: string): number | null {
    let s = String(v == null ? "" : v).trim();
    if (!s) return null;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) s = "-" + paren[1];
    s = s.replace(/[,$€£¥%\s]/g, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;   // int/decimal only — no "1e3"/"421A"/leading-word
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Auto-cast the NUMERIC columns of an extracted table so pandas infers int64/float64 (else
 *  every cell is a string and df.sum() string-CONCATENATES). Per column: if ≥90% of non-empty
 *  cells parse as numbers, coerce the whole column to number|null (blank/stray → null, pandas
 *  NaN); otherwise leave it as strings (names, and IDs/ZIPs where a leading zero would drop —
 *  pass tableRaw to skip casting for those). Returns a NEW rows array. Pure. */
export function castTableColumns(columns: string[], rows: string[][]): TableCell[][] {
    // Counted, never spread: `Math.max(...rows.map(…))` passes one argument per row, which overflows the
    // stack somewhere in the tens of thousands. This function used to be fed DOM tables, capped at 5,000
    // rows; a fetched CSV has no such ceiling, and the row-cap test is what found it.
    let width = columns.length;
    for (const r of rows) if (r.length > width) width = r.length;
    const out: TableCell[][] = rows.map(r => r.slice());
    for (let c = 0; c < width; c++) {
        let nonEmpty = 0, numeric = 0;
        for (const r of rows) {
            const s = r[c] == null ? "" : String(r[c]).trim();
            if (!s) continue;
            nonEmpty++;
            if (parseNumericCell(s) != null) numeric++;
        }
        if (nonEmpty === 0 || numeric / nonEmpty < 0.9) continue;   // not a numeric column
        for (const r of out) {
            const s = r[c] == null ? "" : String(r[c]).trim();
            r[c] = s ? parseNumericCell(s) : null;   // non-numeric outlier → null (pandas NaN)
        }
    }
    return out;
}

/** How many rows a preview shows by default — pandas' own `df.head()` default, for the same reason it
 *  chose it: enough to see the shape of each column, few enough to cost nothing. */
export const PREVIEW_ROWS = 5;

/** How many rows of a table a RENDER descriptor carries — what the sidebar draws, the debug stream ships
 *  and the JSON export embeds. Far above a preview (a reader scrolls; a model does not) and far below a
 *  whole file, which belongs in neither an export nor a replay buffer. The full table stays in the fetch
 *  cache, where `python_exec` reads it by URL. */
export const RENDER_TABLE_ROWS = 200;

/** A table's STRUCTURE without its rows — its shape and its pandas dtypes. The table answer to "what is the
 *  schema of this", and the one string three callers were each building for themselves: `fetch_url`'s
 *  `schema: true`, a pointer's `.schema()`, and `ml.schema`. Pure. */
export function tableShape(t: TableLike): string {
    return `table shape: (${t.shape[0]}, ${t.shape[1]})\ndtypes: ${t.columns.map(c => `${c} ${t.dtypes[c]}`).join(", ")}`;
}

/** What a MODEL is shown of a table it did not fetch: the header, the first rows, and the two facts a
 *  sample cannot carry — the real shape and the dtypes. Reads as a `df.head()` because everything it
 *  names is pandas' (`shape`, `dtypes`, `[N rows x M columns]`), so a model can act on it without
 *  learning anything from us, and the handle line lets it operate on the WHOLE table rather than these rows.
 *
 *  Deliberately NOT pandas' aligned repr: alignment is padding, and padding is pure context cost on a
 *  model-facing string (AGENTS.md). The rows are CSV-dense and quoted where a cell needs it. Pure. */
export function tablePreview(t: TableLike, opts: { rows?: number; source?: string } = {}): string {
    const n = Math.max(0, opts.rows ?? PREVIEW_ROWS);
    const shown = t.rows.slice(0, n);
    const [nrows, ncols] = t.shape;
    const cell = (v: TableCell): string => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [t.columns.join(","), ...shown.map(r => r.map(cell).join(","))];
    const dtypes = t.columns.map(c => `${c} ${t.dtypes[c]}`).join(", ");
    const more = nrows > shown.length ? ` (first ${shown.length})` : "";
    return [
        lines.join("\n"),
        `[${nrows.toLocaleString("en-US")} rows x ${ncols} columns]${more}`,
        `dtypes: ${dtypes}`,
        ...(t.headerless ? ["NOTE: no header row was detected, so the columns are numbered by position (as read_csv(header=None)). Nothing was dropped. If the first row IS a header, re-fetch with \"header\": true."] : []),
        ...(t.truncated ? [`NOTE: only the first ${MAX_TABLE_ROWS.toLocaleString("en-US")} rows were parsed; the source has more.`] : []),
        // What python_exec gets from the cache is what was KEPT. Past the cap that is a prefix, and the hint must say
        // so rather than promise every row the shape counts.
        ...(opts.source ? [t.truncated
            ? `Cached: pass ${opts.source} to python_exec's \`tables\` for the first ${t.rows.length.toLocaleString("en-US")} rows as a DataFrame (a prefix of the ${nrows.toLocaleString("en-US")}; no refetch, no read_csv).`
            : `Whole table cached: pass ${opts.source} to python_exec's \`tables\` for all ${nrows.toLocaleString("en-US")} rows as a DataFrame (no refetch, no read_csv).`] : []),
    ].join("\n");
}


// ---- Parquet ----
//
// A binary table format needs a decoder; there is no parsing one by hand. `hyparquet` is MIT, pure JS, no
// wasm and no `new Function`, so it clears MV3's CSP where `parquet-wasm` does not. Two things make it a
// better fit here than the CSV path it joins: the footer carries the row count and the SCHEMA, so `shape`
// and `dtypes` are read rather than inferred, and row groups are addressable, so a preview decodes the
// first rows instead of the file.

/** Parquet's magic, at BOTH ends of the file — `PAR1`. The footer copy is what makes it a reliable check
 *  rather than a guess: a truncated or HTML-error-page body fails it. */
const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31];

/** Does this look like a Parquet file? Checked on BYTES — a Parquet body read as text is already corrupt,
 *  which is why this cannot live in `typeFromContent` beside the text sniffs. Pure. */
export function looksParquet(bytes: ArrayBuffer): boolean {
    const b = new Uint8Array(bytes);
    if (b.length < 8) return false;
    return PARQUET_MAGIC.every((c, i) => b[i] === c) && PARQUET_MAGIC.every((c, i) => b[b.length - 4 + i] === c);
}

/** Parquet bytes → a {@link TableLike}, with `shape` and `dtypes` taken from the file's own schema rather
 *  than inferred from values — the one respect in which a binary format is strictly better than CSV here.
 *  Only the first {@link MAX_TABLE_ROWS} rows are decoded; `shape` still reports the file's true row count,
 *  so a preview of a 10-million-row file says so instead of describing what it managed to read. */
export async function tableFromParquet(bytes: ArrayBuffer, opts: { maxRows?: number } = {}): Promise<TableLike> {
    // DYNAMIC on purpose, and load-bearing rather than stylistic. This module is reachable from the PAGE
    // bundle (dom.ts → classification → injected.ts), which never decodes Parquet; a static import would put
    // the decoder in `injected.js` for every page the extension touches. Deferred, esbuild tree-shakes it out
    // of any bundle whose entry does not call this, so it ships only in `background.js`, where it runs.
    const { parquetMetadata, parquetSchema, parquetReadObjects } = await import("hyparquet");
    const meta = parquetMetadata(bytes);
    const total = Number(meta.num_rows);
    // Top-level fields only. A nested/repeated group has no flat column to put in a DataFrame, and pandas
    // would hold it as an object of dicts anyway — so it is named and its values pass through as-is.
    const fields = parquetSchema(meta).children;
    const columns = namedColumns(fields.map(f => f.element.name));
    const keep = Math.min(total, opts.maxRows ?? MAX_TABLE_ROWS);
    const objects = keep > 0 ? await parquetReadObjects({ file: bytes, rowStart: 0, rowEnd: keep }) : [];
    const rows: TableCell[][] = objects.map(o => fields.map(f => cellOf((o as Record<string, unknown>)[f.element.name])));
    return {
        columns, rows, shape: [total, columns.length],
        dtypes: parquetDtypes(columns, fields, rows),
        ...(keep < total ? { truncated: true } : {}),
    };
}

/** One decoded Parquet value → a cell. BigInt becomes a number because that is what survives the trip to
 *  pandas and to JSON (an INT64 beyond 2^53 loses precision, which is worth it against a value that cannot
 *  be serialized at all); bytes become text; anything structural is left to JSON. Pure. */
function cellOf(v: unknown): TableCell {
    if (v == null) return null;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (v instanceof Uint8Array) { try { return new TextDecoder().decode(v); } catch { return String(v); } }
    if (v instanceof Date) return v.toISOString();
    try { return JSON.stringify(v); } catch { return String(v); }
}

/** Parquet's DECLARED types → pandas dtypes, where the declaration decides: booleans, integers and floats,
 *  with the same null rules `dtypesOf` measured (an integer column with a null is `float64`; a boolean one is
 *  `object`). Every other declared type reaches the rows as strings — text, dates as ISO strings, nested values
 *  as JSON — so those columns are described by their VALUES, the same way a CSV's are. Pure. */
function parquetDtypes(columns: string[], fields: { element: { type?: string } }[], rows: TableCell[][]): Record<string, TableDtype> {
    const byValue = dtypesOf(columns, rows);
    const out: Record<string, TableDtype> = {};
    columns.forEach((name, c) => {
        const t = String(fields[c]?.element?.type || "");
        const hasNull = rows.some(r => r[c] == null);
        out[name] = t === "BOOLEAN" ? (hasNull ? "object" : "bool")
            : /^(INT32|INT64|INT96)$/.test(t) ? (hasNull ? "float64" : "int64")
            : /^(FLOAT|DOUBLE)$/.test(t) ? "float64"
            : byValue[name];
    });
    return out;
}

// ---- Arrow IPC (File and Stream formats; Feather v2 is the File format) ----

const ARROW_FILE_MAGIC = [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31];   // "ARROW1"

/** Does this body START like an Arrow IPC FILE? Magic at the start only — the File format's footer is not
 *  magic-marked. The Stream format has no magic at all, so a stream is recognised by its media type or
 *  extension, and the decode then settles it. */
export function looksArrowFile(bytes: ArrayBuffer): boolean {
    const b = new Uint8Array(bytes);
    return b.length >= ARROW_FILE_MAGIC.length && ARROW_FILE_MAGIC.every((c, i) => b[i] === c);
}

/** Arrow IPC bytes (File or Stream) → a {@link TableLike}, like `tableFromParquet`: `shape` is the file's real
 *  row count, dtypes are READ from its schema, and only the first {@link MAX_TABLE_ROWS} rows become cells.
 *  Throws when the bytes are not Arrow. */
export async function tableFromArrow(bytes: ArrayBuffer, opts: { maxRows?: number } = {}): Promise<TableLike> {
    // DYNAMIC for the same reason as hyparquet above: this module reaches the page bundle, and the decoder
    // (~220 KB minified) belongs only in `background.js`. Its one `new Function` is in the table BUILDER, which
    // a reader never calls, so MV3's CSP is not in play.
    const { tableFromIPC } = await import("apache-arrow");
    const table = tableFromIPC(new Uint8Array(bytes));
    const fields = table.schema.fields;
    const columns = namedColumns(fields.map(f => f.name));
    const total = table.numRows;
    const keep = Math.min(total, opts.maxRows ?? MAX_TABLE_ROWS);
    const vectors = fields.map((_, c) => table.getChildAt(c));
    const kinds = fields.map(f => arrowKind(f.type));
    const rows: TableCell[][] = [];
    for (let r = 0; r < keep; r++) rows.push(vectors.map((v, c) => arrowCell(v?.get(r), kinds[c])));
    return {
        columns, rows, shape: [total, columns.length],
        dtypes: arrowDtypes(columns, kinds, rows),
        ...(keep < total ? { truncated: true } : {}),
    };
}

/** What an Arrow type is, for the two decisions made about it: how its values become cells and which pandas
 *  dtype it declares. */
type ArrowKind = "int" | "float" | "bool" | "str" | "time" | "other";
function arrowKind(type: { typeId: number; dictionary?: unknown; valueType?: unknown }): ArrowKind {
    // Type ids from the Arrow spec (apache-arrow's `Type` enum); a dictionary is described by its VALUES.
    const t = (type as { dictionary?: { typeId: number } }).dictionary ?? type;
    switch (t.typeId) {
        case 2: return "int";                       // Int (8/16/32/64, signed or not)
        case 3: return "float";                     // FloatingPoint
        case 6: return "bool";                      // Bool
        case 5: case 20: case 24: return "str";     // Utf8, LargeUtf8, Utf8View
        case 8: case 9: case 10: return "time";     // Date, Time, Timestamp
        default: return "other";
    }
}

/** One Arrow value → a cell. Times become ISO strings (Arrow JS hands back epoch milliseconds for dates and
 *  timestamps), everything else goes through `cellOf`, as Parquet's do. */
function arrowCell(v: unknown, kind: ArrowKind): TableCell {
    if (v == null) return null;
    if (kind === "time" && (typeof v === "number" || typeof v === "bigint")) {
        const d = new Date(Number(v));
        return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
    }
    return cellOf(v);
}

/** Arrow's DECLARED types → pandas dtypes, with pandas' null rules, exactly as `parquetDtypes` does it: what
 *  `pyarrow`'s `to_pandas()` produces for the same file. Other types are described by their values. */
function arrowDtypes(columns: string[], kinds: ArrowKind[], rows: TableCell[][]): Record<string, TableDtype> {
    const byValue = dtypesOf(columns, rows);
    const out: Record<string, TableDtype> = {};
    columns.forEach((name, c) => {
        const hasNull = rows.some(r => r[c] == null);
        const k = kinds[c];
        out[name] = k === "bool" ? (hasNull ? "object" : "bool")
            : k === "int" ? (hasNull ? "float64" : "int64")
            : k === "float" ? "float64"
            : k === "str" ? "str"
            : byValue[name];
    });
    return out;
}

// ---- Other binary formats (whatever comes next) ----
//
// Arrow IPC above is the worked example of adding one: a `tableFromX(bytes): TableLike` beside Parquet's, a
// `ContentKind` + Content-Type + extension in dom.ts, and a branch in sw-fetch's `rawGet` that recognises the
// format ON BYTES before any text decode. Nothing else changes: the preview, the pointer store, the sidebar and the
// `python_exec` handoff all speak TableLike. Keep the three rules those two follow — the decoder dynamically
// imported (CSP-clean, out of the page bundle), `shape` the file's real row count however much is decoded, and
// dtypes from the format's own schema rather than `castTableColumns`.

// ---- The table FACADE ----
//
// `TableLike` is plain data, and describing it in pandas' vocabulary (`shape`, `dtypes`, `columns`) invites
// pandas' SYNTAX, which it does not have. A model that reaches for `t[["a","b"]]` or `t.revenue` gets
// `undefined` from plain JavaScript — and `undefined` flows onward silently into an answer, which is the
// plausible-wrong-answer shape this codebase keeps designing out. The description created that expectation,
// so the type owes an answer to it.
//
// Two halves, and the second is the load-bearing one:
//
//   1. A SMALL REAL SURFACE — the four operations worth having without a DataFrame: one column's values, a
//      column subset, rows as objects, and a head. Everything here returns plain data or another TableLike.
//   2. A THROW on anything else, instead of `undefined`. Property access cannot fail on its own in JS, so
//      this needs a Proxy — which is the entire reason the facade is a wrapper rather than a few helpers.

// `Table`, the facade's type, lives in contract.ts beside TableLike, for the same reason TableLike does: the
// model reads its API docs from that file.

/** Thrown when something asks a table facade for pandas. Carries the attempted key so the message can name
 *  it, because "not a DataFrame" without "you wrote `t.revenue`" is a puzzle rather than an answer. */
export class NotATable extends Error {
    constructor(message: string, readonly key: string) { super(message); this.name = "NotATable"; }
}

// Everything the facade answers to. A key outside this set is a mistake worth reporting, not a miss.
const TABLE_KEYS = new Set(["columns", "rows", "shape", "dtypes", "delimiter", "truncated", "headerless",
    "col", "select", "records", "head"]);

// INTEROP keys that must never throw, because the language and the platform read them speculatively on
// objects they know nothing about: `then` decides whether `await` treats this as a thenable (throwing there
// would break `await someTable`), `toJSON` is read by JSON.stringify, and the rest are printing/equality
// plumbing. They answer `undefined`, which is what a plain object would have answered.
const INTEROP_KEYS = new Set(["then", "toJSON", "constructor", "valueOf", "toString", "inspect",
    "nodeType", "$$typeof", "_owner", "props"]);

/** Wrap a {@link TableLike} so it has the four operations its pandas-shaped description implies — and so that
 *  asking it for anything more says so instead of answering `undefined`.
 *
 *  `python` says whether `python_exec` is actually available to the caller, because the error's advice
 *  ("use python_exec for real pandas") is worse than useless when the tool is not in the run's toolset —
 *  the same gate `fetch_url`'s pipe error uses before pointing at `exec`.
 *
 *  The facade does NOT survive a structured clone (methods never do), so it is rebuilt at each boundary,
 *  exactly as `DerefText` is. Pass the underlying `TableLike` across a boundary, wrap on arrival.
 *
 *  `readColumns` makes a STORED table (POINTER_VALUES slice 7): given for a preview whose whole table is in the value
 *  store, `col`, `select`, `records` and a `head` longer than the preview read every row through it, and so return
 *  PROMISES. `rows` stays the preview. A missed `await` is told so rather than handed `undefined`. */
export function asTable(t: TableLike, opts: { python?: boolean; readColumns?: StoredColumnReader } = {}): Table {
    const reader = opts.readColumns && (t.truncated || t.rows.length < t.shape[0]) ? opts.readColumns : undefined;
    opts = { python: opts.python };   // a table built FROM a read is whole, so it carries no reader
    const target: Table = {
        ...t,
        col(name: string): TableCell[] {
            const i = t.columns.indexOf(name);
            if (i < 0) throw new NotATable(`No column "${name}". This table has: ${t.columns.join(", ")}.`, name);
            return t.rows.map(r => r[i]);
        },
        select(names: string[]): Table {
            if (!Array.isArray(names)) throw new NotATable(`select() takes a list of column names — \`t.select(["a", "b"])\`. For one column's values, \`t.col(${JSON.stringify(String(names))})\`.`, "select");
            const idx = names.map(n => {
                const i = t.columns.indexOf(n);
                if (i < 0) throw new NotATable(`No column "${n}". This table has: ${t.columns.join(", ")}.`, n);
                return i;
            });
            // Through tableOf, so the subset describes itself the way every other table does — and keeps the
            // SOURCE's row count, since selecting columns does not change how many rows there are.
            // The SOURCE's dtypes, not re-measured: a subset does not change what a column holds, and re-reading a
            // prefix could disagree with the whole (a null past the prefix makes int64 float64).
            return asTable({ ...derived([...names], t.rows.map(r => idx.map(i => r[i])), t.shape[0], names), ...(t.headerless ? { headerless: true } : {}) }, opts);
        },
        records(): Record<string, TableCell>[] {
            return t.rows.map(r => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
        },
        head(n = PREVIEW_ROWS): Table {
            // `shape` is the HEAD's own, not the source's — `df.head(2).shape` is `(2, cols)` in pandas, and a
            // head that claimed the whole table's row count would be the sample-as-the-whole bug again, this
            // time introduced by the very method whose job is to take a sample. (`select` is the opposite
            // case: choosing columns does not change how many rows there are, so it keeps the source count.)
            // Except when the table is itself a PREFIX shorter than the head asked for: then the head is as
            // long as the source says, and it is still missing rows, so it keeps saying so.
            const want = Math.min(Math.max(0, Math.floor(Number(n)) || 0), t.shape[0]);
            return asTable({ ...derived([...t.columns], t.rows.slice(0, want), want, t.columns), ...(t.delimiter ? { delimiter: t.delimiter } : {}) }, opts);
        },
    };
    // A new table over a subset of this one's rows or columns. Always a COPY of the column list — the facade
    // is read-only at its top level, but an array handed out would be the source's own, and an approved script
    // pushing to it would rewrite the cached table under every later reader.
    function derived(columns: string[], rows: TableCell[][], rowCount: number, from: string[]): TableLike {
        const dtypes = Object.fromEntries(from.map((c, i) => [columns[i], t.dtypes?.[c] ?? "object"])) as Record<string, TableDtype>;
        // Built directly rather than through tableOf, which would measure dtypes it is about to be told.
        return { columns, rows, shape: [rowCount, columns.length], dtypes, ...(rowCount > rows.length ? { truncated: true } : {}) };
    }
    if (reader) {
        const known = (n: string) => { if (!t.columns.includes(n)) throw new NotATable(`No column "${n}". This table has: ${t.columns.join(", ")}.`, n); };
        const whole = (names: string[], cols: Record<string, TableCell[]>, rowCount: number, take = rowCount): Table =>
            asTable({ ...derived([...names], Array.from({ length: Math.min(take, rowCount) }, (_, r) => names.map((n) => cols[n][r])), Math.min(take, rowCount), names), ...(t.headerless ? { headerless: true } : {}) }, opts);
        const syncHead = target.head;
        target.col = ((name: string) => {
            known(name);
            return request(reader([name]).then((r) => r.columns[name]), `t.col(${JSON.stringify(name)})`);
        }) as unknown as Table["col"];
        target.select = ((names: string[]) => {
            if (!Array.isArray(names)) throw new NotATable(`select() takes a list of column names — \`t.select(["a", "b"])\`.`, "select");
            names.forEach(known);
            return request(reader(names).then((r) => whole(names, r.columns, r.rowCount)), `t.select(${JSON.stringify(names)})`);
        }) as unknown as Table["select"];
        target.records = (() => request(reader(t.columns).then((r) =>
            Array.from({ length: r.rowCount }, (_, i) => Object.fromEntries(t.columns.map((c) => [c, r.columns[c][i]])))), "t.records()")) as unknown as Table["records"];
        // A head the preview already holds IS those rows, so it stays synchronous; only a longer one is a request.
        target.head = ((n = PREVIEW_ROWS) => {
            const want = Math.min(Math.max(0, Math.floor(Number(n)) || 0), t.shape[0]);
            if (want <= t.rows.length) return syncHead(n);
            return request(reader(t.columns).then((r) => whole(t.columns, r.columns, r.rowCount, want)), `t.head(${want})`);
        }) as unknown as Table["head"];
    }
    // BRANDED, so the read-only dialect can recognise it by identity rather than by shape — see
    // table-brand.ts for why a property or a well-known symbol would be a hole rather than a check.
    const facade = brandTable(new Proxy(target, {
        get(obj, key, recv) {
            if (typeof key === "symbol" || TABLE_KEYS.has(key) || INTEROP_KEYS.has(key)) return Reflect.get(obj, key, recv);
            throw new NotATable(pandasHint(String(key), t, !!opts.python), String(key));
        },
        // A miss must be loud on the way in too: `"revenue" in t` answering false is fine, but writing to a
        // table that is not yours should not silently succeed.
        set(_obj, key) {
            throw new NotATable(`This table is read-only — it holds output a step already produced. Copy what you need (\`t.rows.slice()\`) and build on that.`, String(key));
        },
        // The other two ways to change an object's own keys, refused the same way: a `delete t.rows` that
        // succeeded would leave a facade whose description no longer matches its data.
        deleteProperty(_obj, key) {
            throw new NotATable(`This table is read-only — \`delete\` cannot remove \`${String(key)}\` from it.`, String(key));
        },
        defineProperty(_obj, key) {
            throw new NotATable(`This table is read-only — it holds output a step already produced.`, String(key));
        },
    }));
    return reader ? brandStored(facade) : facade;
}

/** Reads named columns of a stored table, every row: the page's line to the value store, bound to the run that holds it. */
export type StoredColumnReader = (names: string[]) => Promise<{ rowCount: number; columns: Record<string, TableCell[]> }>;

/** Members a script reaches for on a column or a table when it forgot the `await`. Each throws on a pending read. */
const MISSED_AWAIT = ["length", "map", "filter", "forEach", "reduce", "slice", "indexOf", "includes", "join", "at", "find", "some", "every", "rows", "columns", "shape", "dtypes", "0"];

/** A stored-table read, as the promise it is, which says so when used as its result. */
function request<T>(p: Promise<T>, spelling: string): Promise<T> {
    const missed = `${spelling} reads a stored table, so it is a request that returns a promise: write \`await ${spelling}\`.`;
    for (const k of MISSED_AWAIT) Object.defineProperty(p, k, { get() { throw new NotATable(missed, k); } });
    return p;
}

/** The message a pandas reach gets. Names what was written, says what this is, and points at the nearest
 *  thing that exists — a bare "not supported" leaves the caller to guess which of five spellings is right. */
function pandasHint(key: string, t: TableLike, python: boolean): string {
    const known = t.columns.includes(key);
    // `t[["a","b"]]` arrives here as the key "a,b" — an array stringifies on property access — so a comma is
    // the tell for the exact pandas idiom this is most likely to be.
    const looksSelect = key.includes(",") && key.split(",").every(k => t.columns.includes(k.trim()));
    const nearest = looksSelect ? `t.select([${key.split(",").map(k => JSON.stringify(k.trim())).join(", ")}])`
        : known ? `t.col(${JSON.stringify(key)})`
        : null;
    return [
        `This is a lightweight table facade, not a pandas DataFrame — \`${looksSelect ? `t[[${key.split(",").map(k => JSON.stringify(k.trim())).join(", ")}]]` : `t.${key}`}\` is not something it answers to.`,
        nearest ? `Use \`${nearest}\`.` : `It has: columns, rows, shape, dtypes, and col(name) / select(names) / records() / head(n).`,
        python ? "For real pandas — grouping, joins, pivots, resampling — pass the table's source to python_exec's `tables` and work on the DataFrame there." : "",
    ].filter(Boolean).join(" ");
}

/** The most cells one stored-table read may return: a column is a request, not a license to ship a whole table page-side. */
export const MAX_STORED_READ_CELLS = 5_000_000;

/**
 * NAMED COLUMNS OF A STORED TABLE, every row (POINTER_VALUES slice 7): what `t.col` / `t.select` / `t.records` on a stored
 * table's facade ask for. Decodes the bytes in the format they were stored in, uncapped, with the same parsers the preview
 * came from, so a column reads as its preview did: a delimited body is split by the preview's `delimiter` and header
 * decision, and cast per column. Throws on an unknown name (listing the real ones), on a read past
 * {@link MAX_STORED_READ_CELLS}, and on a format it does not read.
 */
export async function storedColumns(bytes: ArrayBuffer, format: string, names: string[], opts: { delimiter?: string; headerless?: boolean } = {}): Promise<{ rowCount: number; columns: Record<string, TableCell[]> }> {
    let t: TableLike;
    if (format === "csv" || format === "tsv") {
        // Stored as the text it arrived as: this is a decode of a known text body, not a sniff of unknown bytes.
        const text = new TextDecoder().decode(bytes);
        t = tableFromDelimited(text, { delimiter: opts.delimiter ?? (format === "tsv" ? "\t" : undefined), header: !opts.headerless, maxRows: Number.MAX_SAFE_INTEGER });
    } else if (format === "parquet") {
        t = await tableFromParquet(bytes, { maxRows: Number.MAX_SAFE_INTEGER });
    } else if (format === "arrow-file" || format === "arrow-stream") {
        t = await tableFromArrow(bytes, { maxRows: Number.MAX_SAFE_INTEGER });
    } else {
        throw new Error(`a stored table in a format that cannot be read by column: ${format}`);
    }
    const idx = names.map((n) => {
        const i = t.columns.indexOf(n);
        if (i < 0) throw new NotATable(`No column "${n}". This table has: ${t.columns.join(", ")}.`, n);
        return i;
    });
    if (t.rows.length * idx.length > MAX_STORED_READ_CELLS)
        throw new Error(`reading ${names.length === 1 ? `column "${names[0]}"` : `${names.length} columns`} of this stored table would return ${(t.rows.length * idx.length).toLocaleString("en-US")} cells, more than one read hands back (${MAX_STORED_READ_CELLS.toLocaleString("en-US")}). Compute over it in python_exec instead (tables: { df: "@tool:…" }).`);
    return { rowCount: t.rows.length, columns: Object.fromEntries(names.map((n, j) => [n, t.rows.map((r) => r[idx[j]])])) };
}
