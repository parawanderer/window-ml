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
// The TABLE TYPES live in contract.ts, not here: they cross the message channel (a fetch result, a pointer
// read, an agent output) and `agent_api_docs` is generated from that file, so a type defined here would be
// invisible to the model that has to use it. This module owns the PARSERS; contract.ts owns the shape.
import type { TableLike, TableCell, TableDtype } from "./contract";
export type { TableLike, TableCell, TableDtype };

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
export function parseDelimited(text: string, delimiter?: string): { rows: string[][]; delimiter: string; truncated: boolean } {
    const out = Papa.parse<string[]>(String(text ?? ""), {
        delimiter: delimiter ?? "",          // "" = discover it
        delimitersToGuess: DELIMITERS,
        skipEmptyLines: "greedy",
        // Never dynamicTyping: it casts PER CELL, so one "N/A" in a numeric column yields a column of mixed
        // numbers and strings. castTableColumns decides per COLUMN, which is what pandas needs.
    });
    const rows = out.data.slice(0, MAX_TABLE_ROWS);
    return { rows, delimiter: out.meta.delimiter || ",", truncated: out.data.length > MAX_TABLE_ROWS };
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
export function tableFromDelimited(text: string, opts: { delimiter?: string; raw?: boolean; header?: boolean | "auto" } = {}): TableLike {
    const { rows: all, delimiter, truncated } = parseDelimited(text, opts.delimiter);
    // Whether row 0 is a HEADER or the first record. Getting this wrong is not a cosmetic error: treating a
    // data row as a header eats a record AND names the columns after its values, and the table then renders
    // perfectly while being quietly short one row — wrong in the way that looks right.
    const header = opts.header === undefined || opts.header === "auto" ? hasHeaderRow(all) : opts.header;
    const columns = header ? namedColumns(all[0] || []) : positionalColumns(all[0]?.length || 0);
    const body = header ? all.slice(1) : all;
    // Pad ragged rows to the header width so every row can be indexed by column position. Papa reports
    // these as errors; we do not reject on them, because a single malformed line in a large export should
    // cost that line's tail, not the whole table.
    const width = columns.length;
    const padded = width ? body.map(r => r.length === width ? r : Array.from({ length: width }, (_, i) => r[i] ?? "")) : body;
    const rows = opts.raw ? padded : castTableColumns(columns, padded);
    return { ...tableOf(columns, rows), delimiter, ...(header ? {} : { headerless: true }), ...(truncated ? { truncated: true } : {}) };
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

/** The dtype pandas will infer for each column of `rows`. Mirrors `read_csv`: a column of whole numbers is
 *  `int64`, but one blank cell in it forces `float64` (NaN is a float), and anything non-numeric is `object`.
 *  Read off the CAST values, so this describes what a consumer actually gets rather than what the file
 *  looked like. Pure. */
export function dtypesOf(columns: string[], rows: TableCell[][]): Record<string, TableDtype> {
    const out: Record<string, TableDtype> = {};
    columns.forEach((name, c) => {
        let numeric = 0, ints = 0, nulls = 0, seen = 0;
        for (const r of rows) {
            const v = r[c];
            seen++;
            if (v == null || v === "") { nulls++; continue; }
            if (typeof v === "number") { numeric++; if (Number.isInteger(v)) ints++; }
        }
        const values = seen - nulls;
        out[name] = values === 0 || numeric < values ? "object"
            : ints === numeric && nulls === 0 ? "int64"
            : "float64";
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
        ...(opts.source ? [`Whole table cached: pass ${opts.source} to python_exec's \`tables\` for all ${nrows.toLocaleString("en-US")} rows as a DataFrame (no refetch, no read_csv).`] : []),
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

/** Parquet's DECLARED types → pandas dtypes, with the same NaN rule as everywhere else: an integer column
 *  holding a null is `float64`, because that is what it becomes in a DataFrame. Pure. */
function parquetDtypes(columns: string[], fields: { element: { type?: string } }[], rows: TableCell[][]): Record<string, TableDtype> {
    const out: Record<string, TableDtype> = {};
    columns.forEach((name, c) => {
        const t = String(fields[c]?.element?.type || "");
        const hasNull = rows.some(r => r[c] == null);
        out[name] = t === "BOOLEAN" ? "bool"
            : /^(INT32|INT64|INT96)$/.test(t) ? (hasNull ? "float64" : "int64")
            : /^(FLOAT|DOUBLE)$/.test(t) ? "float64"
            : "object";
    });
    return out;
}

// ---- Other binary formats (Arrow IPC / Feather, and whatever comes next) ----
//
// Adding one means writing a single function beside `tableFromParquet` — `tableFromX(bytes): TableLike` —
// and a classification cue. Nothing else in the codebase changes: the fetch result, the model-facing
// preview, the pointer store, the sidebar render and the `python_exec` handoff all speak TableLike, and
// none of them asks where a table came from.
//
// The work each new format actually needs:
//
// 1. **A decoder that clears MV3's CSP.** Pure JS, no wasm, no `new Function`. For Arrow IPC/Feather that is
//    `apache-arrow` (the official JS implementation) — much larger than hyparquet, which is why it is worth
//    waiting for a real use case rather than adding speculatively.
// 2. **Classification, on bytes.** A `ContentKind`, a Content-Type and extension in dom.ts, and a magic-byte
//    check like `looksParquet` (Arrow IPC files start `ARROW1`). The text sniffs in `typeFromContent` are no
//    help: a binary body that reached them as a string is already corrupt (see the "no TextDecoder anywhere
//    near binary" trap in AGENTS.md), which is why the binary branch happens in sw-fetch BEFORE classification.
// 3. **Honest `shape` and `truncated`.** Report the file's real row count even when only a prefix was
//    decoded, exactly as the Parquet path does — a preview that describes what it managed to read, rather
//    than what is there, is how a model comes to answer a question about 10,000 rows of a 10,000,000-row file.
// 4. **dtypes from the format's own schema**, never from `castTableColumns`. That function exists because CSV
//    has no types to read; a format that declares them should be believed instead.
//
// The one thing NOT to reach for here is zero-copy handoff to Pyodide (Arrow's real attraction). That is a
// different and much bigger piece of work than parsing — it belongs with the cross-runtime notes in
// `docs/dev/python-sandbox.md`, not in a parser.
