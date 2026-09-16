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

/** A cell after casting: a number for a numeric column, null for a blank (pandas NaN), else the raw string. */
export type TableCell = string | number | null;

/** The pandas dtype a column will have once these rows reach a DataFrame. Deliberately pandas' OWN names
 *  rather than ours: the audience is a model that has read a great deal of pandas and none of this codebase,
 *  and `int64` needs no explanation where `"integer"` would invite the question of what we mean by it. */
export type TableDtype = "int64" | "float64" | "object";

/** A parsed table, however it was produced (CSV/TSV text, a DOM table, later Parquet). The shape
 *  `python_exec` loads as a DataFrame, and the shape the fetch preview renders — so a table crosses from
 *  a fetch to pandas without being re-serialized to text and re-parsed on the other side.
 *
 *  **It is deliberately a pandas DataFrame's surface**: `shape`, `columns` and `dtypes` mean exactly what
 *  they mean in pandas, down to `shape` being `[rows, columns]` and an all-integer column with one blank
 *  being `float64` (a NaN forces the float, as it does in `read_csv`). A model that has never seen this type
 *  can therefore guess it correctly instead of learning it, and the preview it is shown is pandas' own repr.
 *  The one difference is that `rows` is positional data rather than an index — there is no row index here. */
export interface TableLike {
    /** Header labels, de-duplicated the way pandas does it (`a`, `a.1`) and with blanks named `Unnamed: N`,
     *  so every label is usable as a key. Empty (not absent) when the source had no header row. */
    columns: string[];
    /** `[rows, columns]`, as `df.shape`. The row count is the SOURCE's — larger than `rows.length` when
     *  {@link truncated}, so a preview can say what it is a preview OF. A model told "10 of 48,231 rows"
     *  reasons differently from one handed 10 rows and no count. */
    shape: [number, number];
    /** Column name → the dtype pandas will infer, as `df.dtypes`. Describes what a consumer WILL get from
     *  these rows, not a guess about the file: the cast below is what makes it true. */
    dtypes: Record<string, TableDtype>;
    /** Data rows, header excluded. Ragged rows are padded to the header width so a consumer can index safely. */
    rows: TableCell[][];
    /** What the fields were separated by, for a delimited source ("," "\t" ";" "|"). Absent for a DOM table.
     *  Worth surfacing: it is the discovered value, and a wrong guess is the failure a reader should be able
     *  to see rather than infer from mangled columns. */
    delimiter?: string;
    /** `rows` was capped at {@link MAX_TABLE_ROWS} — the table is a prefix of the source, not the whole of it. */
    truncated?: boolean;
}

/** The most rows a parsed table keeps. A bound on MEMORY, not on what a model sees (that is the preview's
 *  job, and much smaller): a fetched CSV is meant to be handed to `python_exec` whole, so this sits far
 *  above realistic files and exists only so a pathological body cannot exhaust the worker. */
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
export function tableFromDelimited(text: string, opts: { delimiter?: string; raw?: boolean } = {}): TableLike {
    const { rows: all, delimiter, truncated } = parseDelimited(text, opts.delimiter);
    const columns = namedColumns(all[0] || []);
    const body = all.slice(1);
    // Pad ragged rows to the header width so every row can be indexed by column position. Papa reports
    // these as errors; we do not reject on them, because a single malformed line in a large export should
    // cost that line's tail, not the whole table.
    const width = columns.length;
    const padded = width ? body.map(r => r.length === width ? r : Array.from({ length: width }, (_, i) => r[i] ?? "")) : body;
    const rows = opts.raw ? padded : castTableColumns(columns, padded);
    return { ...tableOf(columns, rows), delimiter, ...(truncated ? { truncated: true } : {}) };
}

/** Assemble a {@link TableLike} from columns + already-cast rows — the one place `shape` and `dtypes` are
 *  derived, so every producer (CSV, a DOM table, a binary format) describes itself identically. Pure. */
export function tableOf(columns: string[], rows: TableCell[][]): TableLike {
    return { columns, rows, shape: [rows.length, columns.length], dtypes: dtypesOf(columns, rows) };
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
    const width = Math.max(columns.length, ...rows.map(r => r.length), 0);
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

/** What a MODEL is shown of a table it did not fetch: the header, the first rows, and the two facts a
 *  sample cannot carry — the real shape and the dtypes. Reads as a `df.head()` because everything it
 *  names is pandas' (`shape`, `dtypes`, `[N rows x M columns]`), so a model can act on it without
 *  learning anything from us, and the handle line lets it operate on the WHOLE table rather than these rows.
 *
 *  Deliberately NOT pandas' aligned repr: alignment is padding, and padding is pure context cost on a
 *  model-facing string (AGENTS.md). The rows are CSV-dense and quoted where a cell needs it. Pure. */
export function tablePreview(t: TableLike, opts: { rows?: number; handle?: string } = {}): string {
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
        ...(t.truncated ? [`NOTE: only the first ${MAX_TABLE_ROWS.toLocaleString("en-US")} rows were parsed; the source has more.`] : []),
        ...(opts.handle ? [`The WHOLE table (not just these rows) is ${opts.handle} — pass it to python_exec as a table to get it as a pandas DataFrame.`] : []),
    ].join("\n");
}

// ---- BINARY table formats (Parquet, Arrow, …): the extension point, not yet built ----
//
// Everything above turns TEXT into a TableLike. A binary format needs one more function beside it —
// `tableFromBytes(bytes: ArrayBuffer, kind): TableLike` — and then nothing else in the codebase changes:
// the fetch result, the model-facing preview, the pointer store and the `python_exec` handoff all speak
// TableLike already. What each format actually costs:
//
// **Parquet** — needs a decoder; there is no parsing it by hand. `hyparquet` (MIT, ~10 KB, pure JS, no wasm
// and no `new Function`, so it clears MV3's CSP where `parquet-wasm` does not) reads the footer for the
// schema and row count WITHOUT reading the row groups, which maps exactly onto what a preview wants: the
// column names, types and `rowCount` come back exact rather than inferred, and only the first row group has
// to be decoded to show a head. The body must reach it as BYTES — `ml.fetch` currently does `res.text()`
// unconditionally, so this needs an arraybuffer path through `rawGet`/`buildResult` (see the "no TextDecoder
// anywhere near binary" trap in AGENTS.md; a Parquet body run through `text()` is already corrupt by the
// time it is classified, which is also why sniffing its magic bytes cannot be bolted onto `typeFromContent`).
// Classification is otherwise easy and unusually reliable: `application/vnd.apache.parquet`, a `.parquet`
// extension, or the `PAR1` magic at BOTH ends of the file.
//
// **Arrow IPC / Feather** — the same shape, with `apache-arrow` (the official JS implementation) instead.
// It is a much larger dependency than hyparquet, so it is worth waiting for a real use case; the format's
// value here would be zero-copy handoff to Pyodide, which is a different (and bigger) piece of work than
// parsing — see the note on cross-runtime passing in `docs/dev/python-sandbox.md`.
//
// **What a new format owes this module**: a `TableLike` with `columns`, `rows`, an exact `rowCount`, and
// `truncated` set honestly when it only decoded a prefix. Column TYPES are the one place a binary format is
// strictly better than CSV — they are declared, not guessed — so when `dtypes` lands on TableLike it should
// be populated from the file's own schema rather than from `castTableColumns`, which exists precisely
// because CSV has no types to read.
