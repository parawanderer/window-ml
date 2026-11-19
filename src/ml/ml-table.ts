// ml-table.ts — `ml.table(src)`, the JS member a script reads a whole table with (docs/spec/ML_TABLE.md).
//
// One source rule for every caller: `tableSource` names what a source IS, `tableSourceAsks` says whether reading it
// needs the person, and the read-only dialect's facade asks the second before it calls the first. The answer is always
// a fresh `Table` whose rows are a copy, so an edit to it never reaches the page, the fetch cache or the stored value.

import { makeBackgroundTaskPromise } from "../bridge";
import type { MlApi, FetchResult, TableValue } from "../contract";
import type { Table, TableLike } from "../contract/contract-fetch";
import { googleSheetCsvUrl, isElement, elPath } from "../dom/dom";
import { mlFetchCache } from "./ml-fetch-cache";
import { pageTable } from "./ml-python";
import { isTable, isStoredTable } from "../table/table-brand";
import { asTable, tableFromDelimited, tableOf } from "../table/table-data";
import { currentHasTool } from "../tools/tool-exec";

/** What a `ml.table` source is, by its shape. `url` is resolved (a site path made absolute, a fetch result's URL). */
export type TableSourceKind =
    | { kind: "page"; selector: string }          // a CSS selector, or `current` on a page that is not a Sheet
    | { kind: "element"; el: Element }
    | { kind: "sheet"; csvUrl: string; current: boolean }
    | { kind: "url"; url: string }                // an http(s) URL; read only from the run's fetch cache
    | { kind: "pointer"; ref: string }            // `@tool:<id>`
    | { kind: "table"; table: Table | TableValue } // a table value already in hand
    | { kind: "files"; path: string }             // a path under /files/
    | { kind: "bad"; why: string };

/** Options `ml.table` takes. `delimiter` and `header` apply to delimited text (a fetched CSV, a Sheet). */
export type TableOpts = { raw?: boolean; delimiter?: string; header?: boolean };

const FETCH_RESULT_KEYS = ["url", "status", "type"] as const;

/** Is this a fetch result? Read by own data properties only, so a getter on a page object is never run. */
function fetchResultUrl(v: object): string | null {
    const own = (k: string): unknown => Object.getOwnPropertyDescriptor(v, k)?.value;
    if (typeof own("url") !== "string" || typeof own("status") !== "number" || typeof own("type") !== "string") return null;
    return own("url") as string;
}

/**
 * Name what a source is, by its shape alone. Pure but for `location` (a site path is that site's URL, and `current`
 * on a Sheet is the Sheet). A fetch result is read by its URL, never by its `.text` or `.table`.
 * @param src what the caller passed
 * @returns the source's kind, or `bad` with a sentence
 */
export function tableSource(src: unknown): TableSourceKind {
    if (isTable(src)) return { kind: "table", table: src as Table };
    if (isElement(src)) return { kind: "element", el: src };
    if (src !== null && typeof src === "object") {
        const url = fetchResultUrl(src);
        if (url !== null) return tableSource(url);
        const own = (k: string): unknown => Object.getOwnPropertyDescriptor(src, k)?.value;
        if (Array.isArray(own("columns")) && Array.isArray(own("rows"))) return { kind: "table", table: src as TableValue };
        return { kind: "bad", why: `ml.table takes a source string, a fetch result or a table, got an object with no ${FETCH_RESULT_KEYS.join("/")} and no columns/rows.` };
    }
    if (typeof src !== "string" || !src.trim()) return { kind: "bad", why: `ml.table takes a source string (a CSS selector, "current", a URL, "@tool:<id>" or a /files/ path), got ${src === "" ? "an empty string" : typeof src}.` };
    const s = src.trim();
    if (/^\/files(\/|$)/.test(s)) return { kind: "files", path: s };
    if (/^@tool:/.test(s)) return { kind: "pointer", ref: s };
    const here = typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.href : null;
    if (s === "current") {
        const csvUrl = here ? googleSheetCsvUrl(here) : null;
        return csvUrl ? { kind: "sheet", csvUrl, current: true } : { kind: "page", selector: "current" };
    }
    // A path on this page's site ("/sales.csv", "./data.csv") is that URL: no selector starts with "/" or "./".
    const abs = /^\.?\/(?!\/)/.test(s) && here ? new URL(s, here).href : s;
    if (/^https?:\/\//i.test(abs)) {
        const csvUrl = googleSheetCsvUrl(abs);
        return csvUrl ? { kind: "sheet", csvUrl, current: false } : { kind: "url", url: abs };
    }
    return { kind: "page", selector: s };
}

/**
 * Whether reading this source needs the person, by ML_TABLE.md's source table. `null`: it is read with no ask. A
 * string: why it asks. Used by the read-only dialect before it reads, and by nothing that reads (the read itself
 * refuses what it cannot answer).
 * @param k the source, from {@link tableSource}
 * @returns null, or the reason it asks
 */
export function tableSourceAsks(k: TableSourceKind): string | null {
    switch (k.kind) {
        case "page": case "element": case "pointer": case "table": return null;
        // The run's approved store lives with the run, not here; until the dialect can read it a Sheet asks, which is
        // the safe side of the rule (a gap asks, never runs).
        case "sheet": return `ml.table(${k.current ? '"current"' : "a Sheets URL"}) reads a Google Sheet — it needs approval`;
        case "url": return mlFetchCache.get(k.url) ? null : `ml.table(${JSON.stringify(k.url)}) is not in this page's fetch cache — fetch it once (approved), then re-reads are free`;
        case "files": return null;   // refused outright by the read, not asked
        case "bad": return null;
    }
}

/** Copy a table so the caller owns it: new row arrays, new column list. The source is never handed out. */
function fresh(t: TableLike): Table {
    return asTable({ ...t, columns: [...t.columns], rows: t.rows.map(r => [...r]), ...(t.dtypes ? { dtypes: { ...t.dtypes } } : {}) }, { python: currentHasTool("python_exec") });
}

/** Delimited text → a fresh Table, with the caller's overrides. */
function fromText(text: string, opts: TableOpts, delimiter?: string): Table {
    return fresh(tableFromDelimited(text, { raw: !!opts.raw, ...(opts.delimiter ?? delimiter ? { delimiter: opts.delimiter ?? delimiter } : {}), ...(typeof opts.header === "boolean" ? { header: opts.header } : {}) }));
}

/**
 * Read a whole table: `ml.table(src, { raw, delimiter, header })`. `src` is a CSS selector or `"current"` (a page
 * table, or the Sheet you are on), an http(s) URL this page already fetched (read from the fetch cache, never
 * fetched), a fetch result (read by its URL), a Google Sheets URL, `"@tool:<id>"`, or a table value. `raw` keeps every
 * cell a string; `delimiter` and `header` override discovery for delimited text. The answer is a `Table` you own:
 * editing it changes nothing else, and a second read returns the source again.
 * @param src the source
 * @param opts `raw`, `delimiter`, `header`
 * @returns the table
 * @throws a sentence naming what is wrong and what to call instead
 */
export const table = async function(this: MlApi, src: unknown, opts: TableOpts = {}): Promise<Table> {
    const o: TableOpts = opts && typeof opts === "object" ? { raw: !!opts.raw, ...(typeof opts.delimiter === "string" ? { delimiter: opts.delimiter } : {}), ...(typeof opts.header === "boolean" ? { header: opts.header } : {}) } : {};
    const k = tableSource(src);
    const notDelimited = (what: string): void => {
        if (o.delimiter !== undefined || o.header !== undefined) throw new Error(`ml.table: ${what} names its own columns, so delimiter and header do not apply. Drop them, or read a CSV.`);
    };
    switch (k.kind) {
        case "bad": throw new Error(k.why);
        case "files": throw new Error(`ml.table(${JSON.stringify(k.path)}): /files/ is not readable from here yet. Read a page table, a URL this page fetched, a Sheet or a pointer.`);
        case "url": {
            const cached = mlFetchCache.get(k.url);
            if (!cached) throw new Error(mlFetchCache.wasEvicted(k.url)
                ? `ml.table — "${k.url}" was fetched earlier, but it has since been dropped from the page's fetch cache to keep memory bounded. Fetch it again (it is already approved), then read it here.`
                : `ml.table — "${k.url}" is not in this page's fetch cache: it was not fetched here, it was fetched with credentials or rendered (never cached), or it was fetched on a page the run has since left. Fetch it without credentials or rendered, then read it here.`);
            if (cached.type !== "csv" || typeof cached.text !== "string") throw new Error(`ml.table — "${k.url}" was fetched but is not a table (type: ${cached.type}). Only a CSV/TSV reads as a table.`);
            // A body clipped at the fetch cap is a prefix, and a prefix read as the table gives confident wrong numbers.
            if (cached.truncated) throw new Error(`ml.table — "${k.url}" was fetched clipped at the size cap, so the page holds only its first rows. Read the fetch's "@tool:<id>" pointer, whose whole table is stored.`);
            const parsed = (cached as FetchResult).table;
            // The cache's own parse when nothing is overridden; a fresh parse of the kept text when something is.
            if (!o.raw && o.delimiter === undefined && o.header === undefined && parsed) return fresh(parsed);
            return fromText(cached.text, o);
        }
        case "sheet": {
            const { csv } = await makeBackgroundTaskPromise<{ csv: string; name: string | null }>("FETCH_SHEET_REQUEST", "FETCH_SHEET_RESPONSE", { url: k.csvUrl });
            // The Sheets export is always comma-separated, so it is named, not discovered.
            return fromText(csv, o, ",");
        }
        case "pointer": {
            if (typeof this.dereference !== "function") throw new Error(`ml.table(${JSON.stringify(k.ref)}): a pointer is only live inside an ml.agent run.`);
            const d = await this.dereference(k.ref);
            const t = (d as { table?: Table }).table;
            if (!t) throw new Error(`ml.table(${JSON.stringify(k.ref)}): that output is not a table.`);
            notDelimited("a pointer's table");
            if (o.raw) throw new Error(`ml.table(${JSON.stringify(k.ref)}, { raw }): a stored table keeps the types it was read with. Read its source URL with raw instead.`);
            // A stored table's reads go to the value store and answer new arrays each time, so it is handed out as is;
            // a whole one is copied.
            return isStoredTable(t) ? t : fresh(t);
        }
        case "table": {
            notDelimited("a table value");
            const t = k.table as TableLike;
            const total = t.shape?.[0];
            if (t.truncated || (typeof total === "number" && total > t.rows.length))
                throw new Error(`ml.table: this table holds ${t.rows.length.toLocaleString("en-US")} of ${typeof total === "number" ? total.toLocaleString("en-US") : "more"} rows, a preview. Pass the URL it was fetched from, or its "@tool:<id>", to read every row.`);
            return fresh(tableOf([...t.columns], t.rows, total));
        }
        case "page": case "element": {
            notDelimited("a page table");
            const read = k.kind === "page" ? pageTable(this, k.selector, !!o.raw) : { source: { label: elPath(k.el) }, data: this._resolveTable(k.el, !!o.raw) };
            if (read.data.kind !== "rows") throw new Error(`ml.table: "${read.source.label}" has merged or nested cells, so it does not read as rows. Read it in python_exec with pd.read_html, or point at a simpler table.`);
            return fresh(tableOf(read.data.columns, read.data.rows));
        }
    }
};
