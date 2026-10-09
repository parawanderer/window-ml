// worker-tools.ts — builtin tools of a worker-built run that never read the page, built to run in the worker.

// A tool run in the page puts what it reads into the page's world: a `fetch_url` of another site, or a credentialed
// read, sat in the page's realm and its fetch cache, readable by anything on the page (docs/spec/SITE_ACCESS.md,
// slice 2 part 2). These are the same tools, from the same factories, given an `ml` whose members the worker answers
// itself: the descriptor the model is shown and the run's approval are unchanged, and only where the body runs moves.

import type { FetchLlmPayload, FetchResult, MlApi, MlTool, SubcallUsage } from "../contract";
import { fetchTool, defineTool, pythonTool } from "../ml/ml-tool-factories";
import { _loadTable, isTableValue, tableSpecs } from "../ml/ml-python";
import { googleSheetCsvUrl, googleSheetId } from "../dom/dom";
import { runPython } from "./sw-python";
import { fetchSheetCsv } from "./sw-fetch";
import { tableFromDelimited } from "../table/table-data";
import { derivedFetchFields, cacheCopy } from "../ml/fetch-result";
import { hintSession } from "../contract/contract-run";
import { isCurrentPage } from "../dom/dom";
import { fetchUrlFor } from "./sw-fetch-url";
import { apiDocsTool } from "../tools/api-docs-tool";
import { makeDomTools } from "../tools/tools";
import { workerAnswerTool } from "./worker-answer";
import { publicConfig } from "../contract/contract-config";
import { invocationInfo } from "./sw-invocation";
import { senderTrust } from "./sw-consent";
import { htmlToMarkdownOffscreen } from "./sw-offscreen";
import { fetchLLM, getConfig } from "./sw-llm";

/** The builtin tools a worker-built run executes in the worker rather than the page. */
export const WORKER_TOOL_NAMES: ReadonlySet<string> = new Set(["fetch_url", "python_exec", "agent_api_docs", "answer"]);

/** What one run's worker tools share: the tab they act for, its fetch cache, and the spend of their model calls. */
interface RunCtx {
    runId: string; tabId: number; tabUrl: () => string; python: boolean; cache: Map<string, FetchResult>; spent: SubcallUsage;
    /** URLs the person approved this run's fetch_url to read, remembered for the run (a repeat auto-approves). */
    consented: Set<string>;
    /** As-you (credentialed) fetches the person approved, each spent by the one call it was approved for. */
    credOnce: Set<string>;
    /** What the python_exec call now running was approved for: external sheet ids, and full-mode code. Set around the
     *  one call (`grantRunPython`), never on the tab. */
    pyCall?: { sheets: Set<string>; code: string | null };
}

const runs = new Map<string, RunCtx>();   // state: plumbing — per run, dropped with its local tools

/** The sub-call spend of a run's worker tools so far, for the delta a tool call reports (`subUsage`). */
export function workerSpend(runId: string): SubcallUsage | undefined {
    const s = runs.get(runId)?.spent;
    return s && { ...s, byModel: s.byModel?.map((m) => ({ ...m })) };
}

/** A successful default-mode fetch this run already made, for a read-only survey's `ml.fetch` (never egresses). */
export function workerFetchCached(runId: string, url: string): FetchResult | undefined {
    return runs.get(runId)?.cache.get(url);
}

/**
 * Record the person's approval of this run's worker-side `fetch_url`. The RUN's, never the tab's: a grant on the tab is
 * one any script on it could spend through its own `FETCH_URL` while the run is there (it is in `RUN_TAB_TYPES`), or
 * spend first, racing the worker's call for a one-time as-you read.
 * @param runId the run
 * @param url the approved URL
 * @param credentials an as-you fetch: one call, never remembered
 * @returns false when this worker holds no state for the run, and nothing was granted
 */
export function grantRunFetch(runId: string, url: string, credentials: boolean): boolean {
    const ctx = runs.get(runId);
    if (!ctx) return false;
    (credentials ? ctx.credOnce : ctx.consented).add(url);
    return true;
}

/** Grant the python_exec call about to run in the worker what its approval covers; `null` ends the call's grant. */
export function grantRunPython(runId: string, grant: { sheets: string[]; code: string | null } | null): void {
    const ctx = runs.get(runId);
    if (ctx) ctx.pyCall = grant ? { sheets: new Set(grant.sheets), code: grant.code } : undefined;
}

/** Whether this run's worker-side fetch_url was already approved for `url` (a new one goes to the gate). */
export function runFetchConsented(runId: string, url: string): boolean | undefined {
    return runs.get(runId)?.consented.has(url);
}

/** Forget a run's worker-tool state, with its local tools. */
export function dropWorkerTools(runId: string): void { runs.delete(runId); }

/** Whether a send must still go to the page: a session render of the page the run is on is answered from its live DOM,
 *  which is that page's own content and only exists there. */
export function pageOnlyFetch(args: Record<string, unknown> | undefined, tabUrl: string): boolean {
    return !!args?.credentials && !!args?.rendered && typeof args?.url === "string" && !!tabUrl && isCurrentPage(args.url, tabUrl);
}

/** Whether a python_exec send needs the page: a screenshot (`image`), a page table by CSS selector, or `current` (the
 *  page's own sheet or table). A table by value, a URL the run fetched and an external sheet do not, and neither does a
 *  `@tool:` table pointer: the loop resolves it to a table by value before the call is sent, but the precheck reads the
 *  args before that, so the raw pointer string must not count as a selector (agent-loop.ts `resolveTablePointers`). */
export function pageOnlyPython(args: Record<string, unknown> | undefined): boolean {
    if (args?.image) return true;
    const t = args?.tables;
    const sources = typeof t === "string" ? [t] : Array.isArray(t) ? t : t && typeof t === "object" ? Object.values(t) : [];
    return sources.some((src) => typeof src === "string" && (src === "current" || (!/^https?:\/\//i.test(src) && !/^\s*@tool:/.test(src))));
}

/** Whether a worker tool's send of `name` with `args` must go to the page instead. */
export function pageOnlySend(name: string | undefined, args: Record<string, unknown> | undefined, tabUrl: string): boolean {
    return name === "fetch_url" ? pageOnlyFetch(args, tabUrl) : name === "python_exec" ? pageOnlyPython(args) : false;
}

/**
 * Send one model request for a run's worker tool and count what it spent into the run's sub-call tally: the one path
 * every worker-side sub-call takes (fetch_url's reader, the vision calls), so each lands in `subUsage` the same way.
 * @param ctx the run's worker-tool state
 * @param payload the request, as a page would send it in FETCH_LLM
 * @returns the reply's text
 */
async function meteredChat(ctx: RunCtx, payload: FetchLlmPayload): Promise<string> {
    const r = await fetchLLM(payload) as { content?: string | null; model?: string | null; usage?: { promptTokens?: number; completionTokens?: number } | null };
    const p = r.usage?.promptTokens || 0, c = r.usage?.completionTokens || 0;
    const s = ctx.spent;
    s.prompt += p; s.completion += c; s.calls += 1;
    const model = r.model || payload.model || "unknown";
    const row = (s.byModel ??= []).find((m) => m.model === model);
    if (row) { row.prompt += p; row.completion += c; row.calls += 1; } else s.byModel.push({ model, prompt: p, completion: c, calls: 1 });
    return String(r.content ?? "");
}

/**
 * {@link meteredChat} for a run by id: a request built elsewhere (the vision sub-calls' `oneShotRequest`), counted into
 * that run's sub-call spend.
 * @param runId the run
 * @param payload the request
 * @returns the reply's text
 * @throws when this worker holds no worker-tool state for the run (never sent unmetered)
 */
export function runChat(runId: string, payload: FetchLlmPayload): Promise<string> {
    const ctx = runs.get(runId);
    if (!ctx) return Promise.reject(new Error(`no worker state for run ${runId}: its model call was not sent.`));
    return meteredChat(ctx, payload);
}

/**
 * The `ml` a worker tool of one run is given: `fetch` through the same consent checks a page's would pass (the run's
 * approval minted them for its tab), its derived fields with Markdown from the offscreen document, and `chat` for
 * `fetch_url`'s reader, metered as the run's sub-call spend.
 */
function runMl(ctx: RunCtx): MlApi {
    return {
        defineTool,
        fetch: async (url: string, opts: { credentials?: boolean; rendered?: boolean; format?: string } = {}): Promise<FetchResult> => {
            const credentials = !!opts.credentials, rendered = !!opts.rendered;
            const format = opts.format === "html" ? "html" : "markdown";
            const tabUrl = ctx.tabUrl();
            const trust = await senderTrust({ tab: { id: ctx.tabId, url: tabUrl } as chrome.tabs.Tab, url: tabUrl });
            const r = await fetchUrlFor({ url: String(url), credentials, rendered, format }, {
                tabId: ctx.tabId, frameUrl: tabUrl, tabUrl, untrusted: trust === "untrusted", disclose: false,
                // The run's own approvals, which no page can reach (grantRunFetch).
                consented: (u) => ctx.consented.has(u),
                takeCred: (u) => ctx.credOnce.delete(u),
            });
            if (r.error || !r.data) throw new Error(r.error || `the fetch of "${url}" returned nothing`);
            const data = r.data;
            const md = data.type === "html" && typeof data.text === "string" && data.markdown === undefined ? await htmlToMarkdownOffscreen(data.text) : undefined;
            derivedFetchFields(data, { markdown: () => md, python: ctx.python });
            // The page's cache rule: a successful uncredentialed, non-rendered, default-format read only.
            if (data.ok && !credentials && !rendered && format === "markdown") ctx.cache.set(String(url), cacheCopy(data));
            return data;
        },
        // No page here: python_exec's selector warning finds nothing (a send naming a selector goes to the page).
        _queryAll: () => [],
        pythonExec: (code: string, opts: { mode?: "readonly" | "full"; tableRaw?: boolean; tables?: unknown; onStdout?: (chunk: string, ts?: number) => void } = {}) => workerPython(ctx, code, opts),
        chat: (prompt: string, opts: { model?: string | null; extend?: "utility" | null; numCtx?: number | null } = {}): Promise<string> => meteredChat(ctx, {
            messages: [{ role: "user", content: prompt }], model: opts.model ?? null, extend: opts.extend ?? null,
            numCtx: opts.numCtx ?? null, think: false, hint: { use: "agent", session: hintSession(ctx.runId) },
        }),
    } as unknown as MlApi;
}

/** One `tables` source, loaded in the worker: a table by value (the page's own loader, which needs no DOM), a URL this
 *  run's fetch_url read (its cache), or an external Google Sheet, read with the person's cookies only when this call was
 *  approved for it. */
async function workerTable(ctx: RunCtx, name: string, src: unknown, raw: boolean): Promise<Awaited<ReturnType<typeof _loadTable>>> {
    if (isTableValue(src)) return _loadTable.call({} as MlApi, name, src, raw);   // the by-value branch reads no DOM
    // A source is a URL string or nothing: a wrapped one (`[url]`, `{s:[url]}`) is NOT coerced back with
    // String(src). The gate's scan finds a sheet at any depth now (externalSheetIds), so the person sees it
    // before this runs; this refusal is the second line — a shape no loader was written for must not become a
    // credentialed read through a coercion nobody approved (red-team T2 on #442).
    if (typeof src !== "string") throw new Error(`pythonExec tables — "${name}" is not a loadable source: pass a URL string or a table value, not a ${Array.isArray(src) ? "list" : typeof src}.`);
    const url = src;
    const csvUrl = googleSheetCsvUrl(url);
    if (csvUrl) {
        const id = googleSheetId(url);
        const tabUrl = ctx.tabUrl();
        const trusted = (await senderTrust({ tab: { id: ctx.tabId, url: tabUrl } as chrome.tabs.Tab, url: tabUrl })) !== "untrusted";
        if (!trusted && !(id && ctx.pyCall?.sheets.has(id))) throw new Error("Refused: this sheet hasn't been approved for this run's python_exec.");
        const { csv, name: sheetName } = await fetchSheetCsv(csvUrl);
        const sheet = tableFromDelimited(csv, { delimiter: ",", raw });
        return { name, source: { kind: "sheet-external", label: id || url, name: sheetName }, data: { kind: "rows", columns: sheet.columns, rows: sheet.rows } };
    }
    const cached = ctx.cache.get(url);
    if (cached?.table) return { name, source: { kind: "fetch", label: cached.url }, data: { kind: "rows", columns: cached.table.columns, rows: cached.table.rows } };
    throw new Error(cached
        ? `pythonExec tables — "${url}" was fetched but isn't a table (type: ${cached.type}). Only a CSV/TSV parses into a DataFrame this way.`
        : `pythonExec tables — "${url}" is not among this run's fetches. Call fetch_url on it, then pass the URL here.`);
}

/** `ml.pythonExec` for a run's python_exec in the worker: its tables loaded here, then `runPython` with the run as the
 *  caller (full mode only for the code this call was approved for), live stdout straight to the call's output. */
async function workerPython(ctx: RunCtx, code: string, opts: { mode?: "readonly" | "full"; tableRaw?: boolean; tables?: unknown; onStdout?: (chunk: string, ts?: number) => void }) {
    // The page's shape rule, so `[[url]]` (a list once unwrapped, its key "0" no variable name) is refused as it is there.
    const specs: [string, unknown][] = tableSpecs(opts.tables ?? null).map(({ name, src }) => [name, src]);
    const loaded = [];
    for (const [name, src] of specs) loaded.push(await workerTable(ctx, name, src, !!opts.tableRaw));
    // Not derived from anything the page knows (the run id reaches it): a stream id it cannot name.
    const requestId = `wpy-${crypto.randomUUID()}`;
    const r = await runPython({
        code, image: null, hardened: opts.mode !== "full", stream: !!opts.onStdout,
        tables: loaded.map((l, i) => ({ name: l.name, data: l.data, alias: typeof specs[i][1] === "string" ? specs[i][1] : null })),
    }, requestId, {
        ownSurface: false, tabId: ctx.tabId, disclose: false,
        untrusted: async () => (await senderTrust({ tab: { id: ctx.tabId, url: ctx.tabUrl() } as chrome.tabs.Tab, url: ctx.tabUrl() })) === "untrusted",
        pyCodeOk: (c) => ctx.pyCall?.code === c,
        valueOk: (holders) => holders.includes(ctx.runId),
        ...(opts.onStdout ? { stream: opts.onStdout } : {}),
    });
    if (r.error !== undefined) throw new Error(r.error);
    const res = r.data as { table?: { columns: string[]; rows: unknown[][] }; valueKey?: string } & Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    if (res?.table) extra.resultTable = { ...res.table, ...(res.valueKey ? { value: res.valueKey } : {}) };
    if (loaded.length) extra.inputTables = loaded.map((l) => ({
        name: l.name, source: l.source,
        ...(l.data.kind === "rows" ? { columns: l.data.columns, rows: l.data.rows } : l.data.kind === "value" ? { columns: l.data.columns, rows: l.preview ?? [], ...(l.rowCount != null ? { rowCount: l.rowCount } : {}) } : { html: true }),
    }));
    return { ...res, ...extra };
}

/**
 * Build the worker tools a run offers, each from the page's own factory.
 * @param runId the run
 * @param tabId its tab
 * @param tabUrl the tab's URL now (read at each call: the run navigates)
 * @param names the run's tool names; only those in {@link WORKER_TOOL_NAMES} are built
 * @returns the tools to register as the run's local tools
 */
export function buildWorkerTools(runId: string, tabId: number, tabUrl: () => string, names: readonly string[]): MlTool[] {
    const wanted = names.filter((n) => WORKER_TOOL_NAMES.has(n));
    if (!wanted.length) return [];
    const ctx: RunCtx = runs.get(runId) ?? { runId, tabId, tabUrl, python: names.includes("python_exec"), cache: new Map(), spent: { prompt: 0, completion: 0, calls: 0 }, consented: new Set(), credOnce: new Set() };
    ctx.tabId = tabId; ctx.tabUrl = tabUrl;
    runs.set(runId, ctx);
    const ml = runMl(ctx);
    // agent_api_docs reads the shortcut and the config here, where the page would have asked for them by message.
    const docs = { invocation: invocationInfo, config: async () => publicConfig(await getConfig(), ctx.tabUrl()) };
    // answer keeps the run's set here, with the page's descriptor (what the model is shown); worker-answer.ts.
    const pageAnswer = () => makeDomTools(defineTool).find((t) => t.name === "answer")!;
    return wanted.map((n) => (n === "fetch_url" ? fetchTool.call(ml) : n === "python_exec" ? pythonTool.call(ml) : n === "agent_api_docs" ? apiDocsTool(defineTool, docs) : n === "answer" ? workerAnswerTool(runId, pageAnswer()) : null)).filter((t): t is MlTool => !!t);
}
