// worker-page-read.ts — what a worker tool asks a run's page about the page's own content: a page table for python_exec, the live document for a fetch_url session render.

// Before site-access part 5 a worker-built run's python_exec over a page table, and its fetch_url session render of the
// page it is on, ran IN the page, and the page then sent `PYTHON_EXEC`/`FETCH_SHEET`/`FETCH_LLM` for them, which only
// the run-tab allowance (`RUN_TAB_TYPES`) let an unapproved page send. They now run in the worker (worker-tools.ts), and
// the page is asked only for what is its own: the table's cells, or its document's HTML, as plain data
// (`RUN_TOOL_IN_PAGE { runId, pageRead }`, answered by run-delegation.ts). Nothing of the call (the code, the question,
// the run's other tables) is sent. Each answer is pinned to the document the tab held when it was asked, bounded in
// time and size, and rebuilt field by field before a tool reads it: the page may misreport only its own content.

import type { PageReadRequest, PageToolEnvelope } from "../contract/contract-messages";
import { delegateSend } from "./delegate-send";
import { topDocument } from "./worker-vision";

/** How long the page has to answer: a large table is read from the DOM in well under a second. */
export const PAGE_READ_MS = 15_000;
/** The most columns, cells and characters a page table may have; a larger answer is refused whole. */
export const PAGE_TABLE_CAPS = { columns: 2_000, cells: 4_000_000, cell: 100_000, html: 16_000_000 } as const;
/** The longest document a session render reads (characters of HTML). */
export const PAGE_HTML_MAX = 16_000_000;

/** The sentence for an answer that was malformed or too large. */
export const PAGE_READ_REFUSED = "the page's answer was malformed or too large, so it was not used.";
/** The sentence for a page that did not answer in time. */
export const PAGE_READ_SLOW = "the page did not answer in time, so nothing from it was used. Retry once the page settles.";
/** The sentence for a page that changed while it was asked. */
export const PAGE_READ_MOVED = "the page changed while it was being read (it navigated, or was reloaded), so nothing from it was used. Run it again.";
/** The sentence for a tab whose document the browser does not name. */
export const PAGE_READ_NO_DOCUMENT = "the browser does not say which page the tab holds now, so the page was not read. Run it again.";

/** A page table's data, as `_loadTable` loads a page table (ml-python.ts). */
export type PageTableData = { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string };

/**
 * Ask the run's page one question about its content, pinned to the document the tab holds now.
 * @param runId the run
 * @param tabId its tab
 * @param req the question
 * @param ms the bound on the answer
 * @returns the page's answer, unchecked
 * @throws a sentence when the page cannot be asked, is too slow, or changed meanwhile
 */
async function ask(runId: string, tabId: number, req: PageReadRequest, ms: number): Promise<NonNullable<PageToolEnvelope["pageRead"]>> {
    const documentId = await topDocument(tabId);
    if (!documentId) throw new Error(PAGE_READ_NO_DOCUMENT);
    const SLOW = Symbol("slow");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sent = delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, pageRead: req } }, documentId);
    sent.catch(() => { /* a late failure after the timeout is already refused */ });
    let env: unknown;
    try { env = await Promise.race([sent, new Promise<typeof SLOW>((r) => { timer = setTimeout(() => r(SLOW), ms); })]); }
    catch { throw new Error((await topDocument(tabId).catch(() => null)) === documentId ? PAGE_READ_REFUSED : PAGE_READ_MOVED); }
    finally { clearTimeout(timer); }
    if (env === SLOW) throw new Error(PAGE_READ_SLOW);
    if ((await topDocument(tabId).catch(() => null)) !== documentId) throw new Error(PAGE_READ_MOVED);
    const r = (env as { pageRead?: unknown } | null)?.pageRead;
    if (!r || typeof r !== "object") throw new Error(PAGE_READ_REFUSED);
    return r as NonNullable<PageToolEnvelope["pageRead"]>;
}

/** The page's error sentence, bounded and on one line, as the tool's own words about the page. */
const pageError = (e: unknown): string | null => (typeof e === "string" ? e.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").slice(0, 300) : null);

/**
 * Rebuild a page's table field by field: the shape `_resolveTable` returns, within {@link PAGE_TABLE_CAPS}, or null.
 * @param got the page's `pageRead.table`
 * @returns the table's label and data, or null for anything else
 */
export function checkPageTable(got: unknown): { label: string; data: PageTableData } | null {
    if (!got || typeof got !== "object") return null;
    const g = got as { label?: unknown; data?: unknown };
    const label = typeof g.label === "string" ? g.label.slice(0, 1000) : null;
    const d = g.data as { kind?: unknown; columns?: unknown; rows?: unknown; html?: unknown } | null;
    if (label === null || !d || typeof d !== "object") return null;
    if (d.kind === "html") return typeof d.html === "string" && d.html.length <= PAGE_TABLE_CAPS.html ? { label, data: { kind: "html", html: d.html } } : null;
    if (d.kind !== "rows" || !Array.isArray(d.columns) || !Array.isArray(d.rows) || d.columns.length > PAGE_TABLE_CAPS.columns) return null;
    if (!d.columns.every((c) => typeof c === "string" && c.length <= PAGE_TABLE_CAPS.cell)) return null;
    const cell = (v: unknown): boolean => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= PAGE_TABLE_CAPS.cell);
    let cells = 0;
    const rows: (string | number | boolean | null)[][] = [];
    for (const row of d.rows) {
        if (!Array.isArray(row) || row.length > PAGE_TABLE_CAPS.columns) return null;
        cells += row.length;
        if (cells > PAGE_TABLE_CAPS.cells || !row.every(cell)) return null;
        rows.push(row.slice() as (string | number | boolean | null)[]);
    }
    return { label, data: { kind: "rows", columns: (d.columns as string[]).slice(), rows } };
}

/**
 * A page table for a python_exec the worker runs, read by the run's page from its DOM and checked here.
 * @param runId the run
 * @param tabId its tab
 * @param src a CSS selector, or `"current"` (the page's one table)
 * @param raw keep every cell a string
 * @param ms the bound on the page's answer
 * @returns the table's label and data
 * @throws the page's own sentence (no match, an empty table), or this module's (slow, moved, malformed)
 */
export async function workerPageTable(runId: string, tabId: number, src: string, raw: boolean, ms = PAGE_READ_MS): Promise<{ label: string; data: PageTableData }> {
    const r = await ask(runId, tabId, { kind: "table", src, raw }, ms);
    const err = pageError(r.error);
    if (err !== null) throw new Error(err);
    const t = checkPageTable(r.table);
    if (!t) throw new Error(`pythonExec tables — ${PAGE_READ_REFUSED}`);
    return t;
}

/**
 * The HTML of the document the run's page holds now, for a `fetch_url` session render of that page, checked here.
 * @param runId the run
 * @param tabId its tab
 * @param ms the bound on the page's answer
 * @returns the document's HTML (its doctype first)
 * @throws a sentence when the page could not be read
 */
export async function workerPageDocument(runId: string, tabId: number, ms = PAGE_READ_MS): Promise<string> {
    const r = await ask(runId, tabId, { kind: "document" }, ms);
    const err = pageError(r.error);
    if (err !== null) throw new Error(err);
    if (typeof r.html !== "string" || r.html.length > PAGE_HTML_MAX) throw new Error(PAGE_READ_REFUSED);
    return r.html;
}
