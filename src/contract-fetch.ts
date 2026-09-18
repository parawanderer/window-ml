// contract-fetch.ts — a FETCHED thing and what it turned out to be: bodies, negotiation, and tables.
//
// FetchResult is the one answer shape for every fetch mode (plain, rendered, credentialed, self-source), and
// ContentKind is how it says what it got. TableLike is the ONE table representation every producer converges
// on -- a fetched CSV, a DOM table, a Sheets export, a pointer read -- with Table as the read-only facade a
// caller is handed. They belong together because a table is usually the interesting thing a fetch RETURNED,
// and the two were written against each other. No imports: this module is a leaf, which is why it is the one
// place a parser can be pointed at without dragging the rest of the contract in.
/** Build an `Accept-Language` header value from the browser's language list (navigator.languages), the way a
 *  real browser sends it: the first language at q=1.0, each later one at a descending q-weight (floored at
 *  0.1). ["en-US","en","fr"] → "en-US,en;q=0.9,fr;q=0.8". Dedupes, trims, drops empties. Pure (unit-tested);
 *  used to make an ml.fetch request look like it came from the user's own browser. Empty list → "". */
export function acceptLanguageFrom(langs: string[]): string {
    const seen = new Set<string>();
    const clean = (langs || []).map(l => (l || "").trim()).filter(l => l !== "" && !seen.has(l) && (seen.add(l), true));
    return clean.map((l, i) => i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`).join(",");
}

/** What DOCUMENT a fetch goes and gets — a fetch-level concern, so it is the one option shared by `ml.fetch`
 *  and the `fetch_url` tool. `"markdown"` (the default) runs the negotiation ladder for the site's OWN
 *  Markdown; `"html"` skips it entirely and returns the original markup in one plain GET. Data bodies
 *  (json/csv/code) are unaffected either way. This REPLACED `raw`, which straddled the line between "what do
 *  we fetch" and "what does the model receive" and so read as a second, overlapping knob. */
export type FetchFormat = "markdown" | "html";

/** One rung of the Markdown ladder, as it actually ran. Recorded for every attempt — including the ones that
 *  were skipped — because the failure modes here are INVISIBLE in the body alone: a stub twin is a valid 200
 *  Markdown document that is simply the wrong page, and a site-authored twin is content written specifically
 *  to be read by agents (GitBook appends an "Agent Instructions" section), so "which URL did these bytes come
 *  from" is provenance for an injection surface, not decoration. */
export interface FetchAttempt {
    /** `accept` = the same URL with `Accept: text/markdown`; `declared` = the `<link rel="alternate">` the
     *  page named; `sibling` = the derived `.md`/`index.md`; `convert` = our own HTML→Markdown. */
    strategy: "accept" | "declared" | "sibling" | "convert";
    url: string;
    status?: number;
    contentType?: string;
    bytes?: number;
    ms?: number;
    outcome: "hit" | "not-markdown" | "error" | "skipped";
    /** Why, when the outcome needs one ("not attempted — already resolved", a cross-origin declaration). */
    note?: string;
}

/** The ladder's trace: what was tried, what worked, what was never needed. */
export interface FetchNegotiation {
    wanted: FetchFormat;
    attempts: FetchAttempt[];
    resolvedBy: FetchAttempt["strategy"];
}

/** The result of `ml.fetch(url)`. Content type is resolved BOTH ways so a mislabel is visible: `type` is the
 *  final pick (header when specific, else the content sniff), `typeByHeader`/`typeByContent` are the raw
 *  signals. `json` is pre-parsed when `type === "json"`. `text` is the raw body (size-capped → `truncated`). */
/** A cell after casting: a number for a numeric column, null for a blank (pandas NaN), a real boolean where
 *  the SOURCE declared one (Parquet does; CSV has no types to declare), else the raw string. */
export type TableCell = string | number | boolean | null;

/** The pandas dtype a column will have once these rows reach a DataFrame. Deliberately pandas' OWN names
 *  rather than ours: the audience is a model that has read a great deal of pandas and none of this codebase,
 *  and `int64` needs no explanation where `"integer"` would invite the question of what we mean by it. */
// pandas 3's names specifically: a text column is `str` (pandas 2 said `object`), and `object` is left for
// what pandas 3 still calls that — an all-null column, a boolean column with a null, a mix of kinds.
export type TableDtype = "int64" | "float64" | "bool" | "str" | "object";

/** A parsed table, however it was produced (CSV/TSV text, a DOM table, later Parquet). The shape
 *  `python_exec` loads as a DataFrame, and the shape the fetch preview renders — so a table crosses from
 *  a fetch to pandas without being re-serialized to text and re-parsed on the other side.
 *
 *  **It is deliberately a pandas DataFrame's surface**: `shape`, `columns` and `dtypes` mean exactly what
 *  they mean in pandas, down to `shape` being `[rows, columns]` and an all-integer column with one blank
 *  being `float64` (a NaN forces the float, as it does in `read_csv`). A model that has never seen this type
 *  can therefore guess it correctly instead of learning it, and the preview it is shown is pandas' own repr.
 *  The one difference is that `rows` is positional data rather than an index — there is no row index here.
 *
 *  WHERE ONE COMES FROM, and what to do with it:
 *
 *      const r = await ml.fetch(url);          // a .csv/.tsv/.parquet URL
 *      r.table.shape                           // [48231, 5] — the FILE's rows, not a preview's
 *      r.table.dtypes.price                    // "float64"
 *      const i = r.table.columns.indexOf("qty");
 *      r.table.rows.filter(row => row[i] > 5)  // plain arrays: filter/map/reduce as usual
 *      r.table.col("qty")                      // or through the Table facade: col / select / records / head
 *
 *  A pointer to a table resolves to the same object — `@tool:abc1234.table` inside `exec` (pre-resolved, so
 *  no `await` is needed for a literal reference) — and both are readable from the read-only `exec` dialect,
 *  which auto-approves. The table is READ-ONLY there: it belongs to the run's captured output, so mutating
 *  it is refused; copy it (`rows.slice()`) if you need to build on it.
 *
 *  For real analysis, hand the URL to `python_exec`'s `tables` (`tables: { df: "<the url>" }`): the parsed
 *  table loads from the fetch cache as an actual pandas DataFrame, with no second request and no `read_csv`. */
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
    /** The source had NO header row, so `columns` are positional (`0`, `1`, `2`) — `read_csv(header=None)`.
     *  Recorded rather than left implicit: a reader who sees numeric column names should be able to tell that
     *  it was DECIDED, not that the header was lost. */
    headerless?: boolean;
}

/** A {@link TableLike} as a caller actually receives it — from `ml.fetch(url).table` or a pointer's `.table` —
 *  with the four operations its pandas-shaped description suggests, and a LOUD failure on anything else:
 *
 *      t.col("price")               // one column's values → [9.99, 13.49, …]
 *      t.select(["region", "qty"])  // a column subset as a new Table — the spelling of df[["region", "qty"]]
 *      t.records()                  // rows as objects keyed by column → [{ region: "north", qty: 3 }, …]
 *      t.head(10)                   // the first 10 rows as a new Table, like df.head(10)
 *
 *  It is NOT a DataFrame: `t.price`, `t[["a", "b"]]`, `t.groupby(…)` throw an error naming the nearest real
 *  spelling rather than returning `undefined`. For grouping, joins and the rest of pandas, hand the source URL to
 *  `python_exec`'s `tables`. Read-only: writing to it throws; copy what you need first. Available in the
 *  read-only `exec` dialect, where a call that would build more than a million cells at once asks first.
 *
 *  A STORED table (a pointer's preview whose whole table is kept: `rows.length < shape[0]`) reads every row, so
 *  `col`, `select`, `records` and a `head` longer than `rows` return promises: `await t.col("revenue")`. `rows` is
 *  still the preview. The read-only dialect awaits them for you. */
export interface Table extends TableLike {
    /** One column's values, by name. `t.col("revenue")` → `[9.99, 13.49, …]`. Throws on an unknown name. */
    col(name: string): TableCell[];
    /** A column SUBSET as a new table — `df[["a", "b"]]`. Keeps the source's row count and dtypes. */
    select(names: string[]): Table;
    /** Rows as objects keyed by column name — what most JavaScript actually wants. */
    records(): Record<string, TableCell>[];
    /** The first `n` rows as a new table (default 5), like `df.head()`: its `shape` counts only those rows. */
    head(n?: number): Table;
}

/** What a fetched body turned out to BE, resolved once and then trusted. Decided from the response header,
 *  else from the content structure, else from the URL extension, else text -- never re-sniffed downstream,
 *  because two places guessing separately is how the same body parses two ways. */
export type ContentKind = "json" | "csv" | "parquet" | "arrow" | "html" | "xml" | "markdown" | "code" | "text" | "binary";

/** The ONE answer shape for every fetch mode: plain, rendered, credentialed, self-source. A caller reads the
 *  same fields whichever path served it, and the fields that are mode-specific are absent rather than faked,
 *  so "this fetch could not tell you" is distinguishable from "the answer was empty". */
export interface FetchResult {
    url: string;              // the response URL (after any redirects)
    status: number;           // HTTP status code
    ok: boolean;              // status in 200–299
    type: ContentKind;        // the resolved kind (header, else structured content, else URL extension, else text)
    language?: string;        // for type === "code": the language from the URL extension ("typescript", "python", …)
    typeByHeader: ContentKind | null;   // null = the header was generic (text/plain, octet-stream, …)
    typeByContent: ContentKind;         // the structural content sniff
    typeByExtension: { type: ContentKind; language?: string } | null;   // the URL-extension cue
    contentType: string;      // the raw Content-Type header
    text: string;             // the body, raw (capped)
    markdown?: string;        // for type === "html": a clean Markdown distillation (scripts/nav/chrome stripped),
                              // attached by ml.fetch so any caller reads the content without re-converting; `.text` is still the raw HTML
    json?: unknown;           // parsed JSON when type === "json" and it parsed
    schema?: string;          // a compact TS-like SHAPE of `json` (see dom.ts jsonShape) — the structure to
                              // write code against without the whole payload; present iff `json` is set
    /** For type === "csv": the body PARSED, with the delimiter discovered (`,` `\t` `;` `|`) and numeric
     *  columns cast — a pandas-shaped {@link TableLike} (`shape`, `columns`, `dtypes`, `rows`). The CSV
     *  counterpart of `json`/`schema`, and for the same reason: a caller that has to re-split the text is one
     *  that will get the separator wrong. Attached page-side by `ml.fetch` (like `markdown`), so the rows
     *  never cross the message channel — `.text` still holds the raw body. Handed to the caller as a
     *  {@link Table}: the data plus `col` / `select` / `records` / `head`. */
    table?: Table | TableLike;
    truncated?: boolean;      // the body was clipped to the size cap
    valueKey?: string;        // value-store key of the WHOLE body when `table` is a preview (past the parse cap). Disclosing it
                              // to a tab is what entitles that tab to read the value back (background.ts, pageValueSession).
    bodyLines?: number;       // for a CSV/TSV whose `text` is a prefix of a body read whole: the whole body's line count
    redirected?: boolean;     // the request followed ≥1 redirect (`url` above is the FINAL landing URL — the
                              // intermediate chain isn't visible to fetch; a redirect log needs chrome.webRequest)
    /** The Markdown ladder's trace, when negotiation ran (absent for `format: "html"` and for data bodies that
     *  never negotiate). `resolvedBy` says which rung produced `text` — in particular whether the Markdown is
     *  the SITE's or our own Turndown reduction, which is the difference that matters when debugging why a
     *  model missed a detail. */
    negotiation?: FetchNegotiation;
    rendered?: boolean;       // the body is the SETTLED DOM after the page's JS ran in a background tab (rendered
                              // mode), not the raw HTTP response — so client-rendered/SPA content is present
    /** The body is the LIVE DOM of the page the call was made from, serialized — no request was made. This is
     *  how `rendered + credentials` ("its JS run, in my session") is answered for the page you are ON: that
     *  is the DOM already in front of you, so it is read rather than loaded a second time. It includes whatever
     *  changed since load and overlays are not stripped. Also the only way to read a local `file:` page. */
    live?: boolean;
    /** A SAFELIST of NON-SENSITIVE response headers — the ONLY headers ever exposed. Auth-bearing headers
     *  (Cookie, Set-Cookie, Authorization, WWW-Authenticate, CSRF/API-key headers, …) are STRUCTURALLY excluded
     *  and never appear here, so a fetch can never leak the user's session. Each field is absent when the server
     *  didn't send it. (Rendered mode is a DOM snapshot, not an HTTP response, so it has none of these.) */
    headers?: {
        link?: string;               // RFC-5988 pagination (rel="next"/"last") — count or page through a list API
        etag?: string;               // opaque version tag (caching / optimistic concurrency)
        lastModified?: string;       // the resource's last-modified date
        retryAfter?: string;         // 429/503 backoff — seconds, or an HTTP date
        contentLength?: string;      // the server's declared body size in bytes
        contentDisposition?: string; // e.g. `attachment; filename="report.zip"` — the intended download filename
        cacheControl?: string;       // cache directives (max-age, no-store, …)
        date?: string;               // the server's response date
    };
}

/** A serializable description of how to render a tool step in the debug sidebar.
 *  Data, never code — it crosses the window bus and the sidebar owns the actual
 *  UI (safe: only known `type`s render; unknown/absent → the default In:/Out:
 *  view). A tool's `render` produces one page-side; built-ins auto-derive
 *  image/elements from the envelope. */
/** Where a `python_exec` DataFrame came from — for the debug render's source label + tooltip.
 *  `dom` = a table on the current page (label = the selector); `sheet-current` = the Google Sheet
 *  you're on (label = its page title); `sheet-external` = a Google Sheet fetched by URL with the
 *  user's approval (label = its spreadsheet id); `fetch` = a CSV/table already fetched by `fetch_url`
 *  and read back out of the fetch cache (label = its URL), so no second request was made. */
export interface TableSource { kind: "dom" | "sheet-current" | "sheet-external" | "fetch" | "pointer"; label: string; name?: string | null; }

/** A table handed to `ml.pythonExec` BY VALUE rather than by where it lives: a {@link TableLike} (a fetched table, the
 *  `Table` facade `ml.fetch` returns, a pointer's table) carrying its rows. It loads only when it is the WHOLE table:
 *  a prefix (`truncated`, or fewer rows than `shape` says) is refused rather than analysed as if it were complete.
 *  `pointer` names the `@tool:` it was resolved from, for the error and the log. */
export type TableValue = Pick<TableLike, "columns" | "rows"> & Partial<Pick<TableLike, "shape" | "truncated" | "delimiter" | "headerless">> & { pointer?: string; value?: string };

/** One loaded DataFrame for the `python-in` render: its variable name, its source, and either a
 *  rows preview (`columns`+`rows`) or `html: true` (loaded via `pd.read_html`, no clean preview). */
export interface TablePreview { name: string; source: TableSource; columns?: string[]; rows?: (string | number | boolean | null)[][]; html?: boolean; rowCount?: number; }
