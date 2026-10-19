// worker-tools.ts — builtin tools of a worker-built run that never read the page, built to run in the worker.

// A tool run in the page puts what it reads into the page's world: a `fetch_url` of another site, or a credentialed
// read, sat in the page's realm and its fetch cache, readable by anything on the page (docs/spec/SITE_ACCESS.md,
// slice 2 part 2). These are the same tools, from the same factories, given an `ml` whose members the worker answers
// itself: the descriptor the model is shown and the run's approval are unchanged, and only where the body runs moves.

import { judgeCall, fetchFacts, runPolicies } from "./sw-policies";
import { checkProposal } from "./policy-proposal";
import { proposePolicyTool } from "../tools/propose-policy-tool";
import type { FetchLlmPayload, FetchResult, MlApi, MlTool, ShotBox, SubcallUsage, TokenUsage } from "../contract";
import type { MintToken } from "../python/python-tool";
import { spendOf } from "../contract/contract-chat";
import { fetchTool, defineTool, pythonTool, type KeepText } from "../ml/ml-tool-factories";
import { storeText } from "./sw-values";
import { _loadTable, isTableValue, tableSpecs } from "../ml/ml-python";
import { googleSheetCsvUrl, googleSheetId } from "../dom/dom";
import { runPython } from "./sw-python";
import { workerVisionChat } from "./worker-vision";
import { fetchSheetCsv } from "./sw-fetch";
import { tableFromDelimited } from "../table/table-data";
import { derivedFetchFields, cacheCopy, fetchIsCacheable } from "../ml/fetch-result";
import { hintSession } from "../contract/contract-run";
import { isCurrentPage } from "../dom/dom";
import { fetchUrlFor } from "./sw-fetch-url";
import { apiDocsTool } from "../tools/api-docs-tool";
import { WORKER_BUILTINS } from "../tools/tool-registry";
import { makeDomTools } from "../tools/tools";
import { workerAnswerTool } from "./worker-answer";
import { publicConfig } from "../contract/contract-config";
import { senderSelfApproves } from "./sw-site-access";
import { invocationInfo } from "./sw-invocation";
import { senderTrust } from "./sw-consent";
import { htmlToMarkdownOffscreen } from "./sw-offscreen";
import { fetchLLM, getConfig } from "./sw-llm";
import { typeFromExtension } from "../dom/dom";
import type { PageTableData } from "./worker-page-read";

/** The builtin tools a worker-built run executes in the worker rather than the page. `look` and `locate` are built per
 *  call, over a vision host pinned to the call's document (worker-look.ts, worker-locate.ts); naming them here gives a
 *  run whose only worker tool they are the state their model calls are metered into from the start. */
export const WORKER_TOOL_NAMES: ReadonlySet<string> = WORKER_BUILTINS;   // the registry's realm "worker"

/** What a run's worker tools ask of the worker's vision (worker-media.ts) and of the run's page (worker-page-read.ts),
 *  handed in by whoever builds the run's tools (sw-local-tools.ts), so this module reaches neither: python_exec's `image`
 *  shot from the worker's own capture with its crop transform, a `cast`'s token minted in the page's registry, a page
 *  table read from the page's DOM, and the page's live document for a `fetch_url` session render of it. */
export interface WorkerPyMedia {
    image(image: string, margin: number): Promise<{ image: string; imageBox: ShotBox | null; documentId: string }>;
    mint: MintToken;
    /** a page table (a CSS selector, or `"current"`), as the page reads it, checked */
    table?(src: string, raw: boolean): Promise<{ label: string; data: PageTableData }>;
    /** the HTML of the document the tab holds now, checked, refused unless the tab is on `url` */
    document?(url: string): Promise<string>;
}

/** What one run's worker tools share: the tab they act for, its fetch cache, and the spend of their model calls. */
interface RunCtx {
    runId: string; tabId: number; tabUrl: () => string; python: boolean; cache: Map<string, FetchResult>; spent: SubcallUsage;
    /** URLs the person approved this run's fetch_url to read, remembered for the run (a repeat auto-approves). */
    consented: Set<string>;
    /** As-you (credentialed) fetches the person approved, each spent by the one call it was approved for. */
    credOnce: Set<string>;
    /** What the python_exec call now running was approved for: external sheet ids, and the code of a cell outside the dialect. Set around the
     *  one call (`grantRunPython`), never on the tab. */
    pyCall?: { sheets: Set<string>; code: string | null; step?: { seq: number; local: { step: number; seq: number } } };
    /** Its python_exec's image and cast (none: a call with an `image` is refused). */
    media?: WorkerPyMedia;
}

const runs = new Map<string, RunCtx>();   // state: plumbing — per run, dropped with its local tools

/** The sub-call spend of a run's worker tools so far, for the delta a tool call reports (`subUsage`). */
export function workerSpend(runId: string): SubcallUsage | undefined {
    const s = runs.get(runId)?.spent;
    return s && { ...s, byModel: s.byModel?.map((m) => ({ ...m })), calls_: s.calls_?.slice() };
}

/**
 * What a run's worker tools spent between two reads of {@link workerSpend}, per model too: the `subUsage` a call reports.
 * @param before the spend before the call
 * @param after the spend after it
 * @returns the delta, or undefined when no model call was made
 */
export function spendDelta(before: SubcallUsage | undefined, after: SubcallUsage | undefined): SubcallUsage | undefined {
    if (!after || after.calls <= (before?.calls ?? 0)) return undefined;
    const prev = new Map((before?.byModel ?? []).map((m) => [m.model, m]));
    const byModel = (after.byModel ?? []).map((m) => ({ model: m.model, prompt: m.prompt - (prev.get(m.model)?.prompt ?? 0), completion: m.completion - (prev.get(m.model)?.completion ?? 0), calls: m.calls - (prev.get(m.model)?.calls ?? 0) })).filter((m) => m.calls > 0);
    const calls_ = (after.calls_ ?? []).slice(before?.calls_?.length ?? 0);
    return { prompt: after.prompt - (before?.prompt ?? 0), completion: after.completion - (before?.completion ?? 0), calls: after.calls - (before?.calls ?? 0), ...(byModel.length ? { byModel } : {}), ...(calls_.length ? { calls_ } : {}) };
}

/**
 * Give a run the worker-tool state its worker-side model calls are counted in, when it has none: a run with none of the
 * worker tools still makes vision sub-calls here (the verify after an action).
 * @param runId the run
 * @param tabId its tab
 * @param tabUrl its tab's URL
 */
export function ensureRunState(runId: string, tabId: number, tabUrl: () => string): void {
    if (!runs.has(runId)) runs.set(runId, newRunCtx(runId, tabId, tabUrl, false));
}

/** Fresh worker-tool state for a run. */
const newRunCtx = (runId: string, tabId: number, tabUrl: () => string, python: boolean): RunCtx =>
    ({ runId, tabId, tabUrl, python, cache: new Map(), spent: { prompt: 0, completion: 0, calls: 0 }, consented: new Set(), credOnce: new Set() });

/** A successful default-mode fetch this run already made, for a read-only survey's `ml.fetch` (never egresses). */
export function workerFetchCached(runId: string, url: string): FetchResult | undefined {
    return runs.get(runId)?.cache.get(url);
}

/**
 * Record the person's approval of this run's worker-side `fetch_url`. The RUN's, never the tab's: a grant on the tab is
 * one any script on it could spend through its own `FETCH_URL` while the run is there (on an approved site, which may
 * send it), or spend first, racing the worker's call for a one-time as-you read.
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

/** Grant the python_exec call about to run in the worker what its approval covers, and the step it runs in (its `ml`
 *  calls' asks are shown there); `null` ends the call's grant. */
export function grantRunPython(runId: string, grant: { sheets: string[]; code: string | null; step?: { seq: number; local: { step: number; seq: number } } } | null): void {
    const ctx = runs.get(runId);
    if (ctx) ctx.pyCall = grant ? { sheets: new Set(grant.sheets), code: grant.code, ...(grant.step ? { step: grant.step } : {}) } : undefined;
}

/** Whether this run's worker-side fetch_url was already approved for `url` (a new one goes to the gate). */
export function runFetchConsented(runId: string, url: string): boolean | undefined {
    return runs.get(runId)?.consented.has(url);
}

/** Whether a person's policy (not the built-in default) allows this run an uncredentialed fetch of `url`. */
function policyAllows(runId: string, url: string): boolean {
    const j = judgeCall(runId, "fetch", fetchFacts(url));
    return j.decision === "allow" && j.by !== "builtin";
}

/** Forget a run's worker-tool state, with its local tools. */
export function dropWorkerTools(runId: string): void { runs.delete(runId); }

/**
 * Send one model request for a run's worker tool and count what it spent into the run's sub-call tally: the one path
 * every worker-side sub-call takes (fetch_url's reader, the vision calls), so each lands in `subUsage` the same way.
 * @param ctx the run's worker-tool state
 * @param payload the request, as a page would send it in FETCH_LLM
 * @returns the reply's text
 */
async function meteredChat(ctx: RunCtx, payload: FetchLlmPayload): Promise<string> {
    const r = await fetchLLM(payload) as { content?: string | null; model?: string | null; usage?: TokenUsage | null };
    const p = r.usage?.promptTokens || 0, c = r.usage?.completionTokens || 0;
    const s = ctx.spent;
    s.prompt += p; s.completion += c; s.calls += 1;
    const model = r.model || payload.model || "unknown";
    const row = (s.byModel ??= []).find((m) => m.model === model);
    if (row) { row.prompt += p; row.completion += c; row.calls += 1; } else s.byModel.push({ model, prompt: p, completion: c, calls: 1 });
    // The call itself, as the page's meter keeps it (bus.ts): spend reads its price snapshot and raw usage from here.
    (s.calls_ ??= []).push({ model, ts: Date.now(), ms: r.usage?.genMs ?? 0, prompt: p, completion: c, ...spendOf(r.usage) });
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
            // A SESSION RENDER OF THE PAGE THE RUN IS ON: what the page's own `ml.fetch` answers from its live DOM, with
            // no request and no grant (injected.ts). The worker asks the page for that document's HTML, as plain data,
            // and runs the rest of the tool here, so an `ask` over it is the worker's model call, not the page's.
            if (credentials && rendered && tabUrl && isCurrentPage(String(url), tabUrl)) {
                if (!ctx.media?.document) throw new Error("the page the run is on cannot be read here.");
                const text = await ctx.media.document(tabUrl);
                const live: FetchResult = { url: tabUrl, status: 200, ok: true, type: "html", typeByHeader: null, typeByContent: "html",
                    typeByExtension: typeFromExtension(tabUrl), contentType: "text/html", text, rendered: true, live: true };
                const md = await htmlToMarkdownOffscreen(text).catch(() => undefined);
                derivedFetchFields(live, { markdown: () => md, python: ctx.python });
                return live;
            }
            const trust = await senderTrust({ tab: { id: ctx.tabId, url: tabUrl } as chrome.tabs.Tab, url: tabUrl });
            const r = await fetchUrlFor({ url: String(url), credentials, rendered, format }, {
                tabId: ctx.tabId, frameUrl: tabUrl, tabUrl, untrusted: trust === "untrusted", disclose: false,
                // The run's own approvals, which no page can reach (grantRunFetch), and its policies (sw-policies.ts), judged
                // here again at the choke point rather than trusted from the gate's earlier answer.
                consented: (u) => ctx.consented.has(u) || policyAllows(ctx.runId, u),
                takeCred: (u) => ctx.credOnce.delete(u),
            });
            if (r.error || !r.data) throw new Error(r.error || `the fetch of "${url}" returned nothing`);
            const data = r.data;
            const md = data.type === "html" && typeof data.text === "string" && data.markdown === undefined ? await htmlToMarkdownOffscreen(data.text) : undefined;
            derivedFetchFields(data, { markdown: () => md, python: ctx.python });
            // The page's cache rule, the same function.
            if (fetchIsCacheable(data, { credentials, rendered, format })) ctx.cache.set(String(url), cacheCopy(data));
            return data;
        },
        // No page here: python_exec's selector warning finds nothing (a send naming a selector goes to the page).
        _queryAll: () => [],
        // fetch_url's whole body past its preview, kept in the value store for the pointer the step mints.
        _keepText: storeText satisfies KeepText,
        pythonExec: (code: string, opts: { image?: unknown; margin?: number; tableRaw?: boolean; tables?: unknown; onStdout?: (chunk: string, ts?: number) => void } = {}) => workerPython(ctx, code, opts),
        // A cast's token goes into the page's registry, where a click resolves it (python-tool.ts `MintToken`).
        _mintToken: ((q, documentId) => {
            if (!ctx.media) return Promise.reject(new Error("no page to mint the token in."));
            return ctx.media.mint(q, documentId);
        }) satisfies MintToken,
        // With `images` (python_exec's verify, asking a vision reader about a chart) it is the vision chat look uses.
        chat: (prompt: string, opts: { model?: string | null; extend?: "utility" | null; numCtx?: number | null; images?: string[]; maxTokens?: number | null } = {}): Promise<string> => opts.images?.length
            ? workerVisionChat(ctx.runId, prompt, { images: opts.images, model: opts.model ?? null, maxTokens: opts.maxTokens ?? null, numCtx: opts.numCtx ?? null })
            : meteredChat(ctx, {
            messages: [{ role: "user", content: prompt }], model: opts.model ?? null, extend: opts.extend ?? null,
            numCtx: opts.numCtx ?? null, think: false, hint: { use: "agent", session: hintSession(ctx.runId) },
        }),
    } as unknown as MlApi;
}

/** One `tables` source, loaded in the worker: a table by value (the page's own loader, which needs no DOM), a URL this
 *  run's fetch_url read (its cache), a Google Sheet (an external one, or `"current"` on a sheet's page), read with the
 *  person's cookies only when this call was approved for it, or a page table (a CSS selector, or `"current"` on any other
 *  page), which the page reads from its DOM and the worker checks (worker-page-read.ts). */
async function workerTable(ctx: RunCtx, name: string, src: unknown, raw: boolean): Promise<Awaited<ReturnType<typeof _loadTable>>> {
    if (isTableValue(src)) return _loadTable.call({} as MlApi, name, src, raw);   // the by-value branch reads no DOM
    // A source is a URL string or nothing: a wrapped one (`[url]`, `{s:[url]}`) is NOT coerced back with
    // String(src). The gate's scan finds a sheet at any depth now (externalSheetIds), so the person sees it
    // before this runs; this refusal is the second line — a shape no loader was written for must not become a
    // credentialed read through a coercion nobody approved (red-team T2 on #442).
    if (typeof src !== "string") throw new Error(`pythonExec tables — "${name}" is not a loadable source: pass a URL string or a table value, not a ${Array.isArray(src) ? "list" : typeof src}.`);
    // `current` on a Google Sheet's page is that sheet, as the page's loader reads it (ml-python.ts `_loadTable`).
    const sheetPage = src === "current" && googleSheetCsvUrl(ctx.tabUrl()) ? ctx.tabUrl() : null;
    const url = sheetPage ?? src;
    const csvUrl = /^https?:\/\//i.test(url) ? googleSheetCsvUrl(url) : null;
    if (csvUrl) {
        const id = googleSheetId(url);
        const tabUrl = ctx.tabUrl();
        const trusted = (await senderTrust({ tab: { id: ctx.tabId, url: tabUrl } as chrome.tabs.Tab, url: tabUrl })) !== "untrusted";
        if (!trusted && !(id && ctx.pyCall?.sheets.has(id))) throw new Error("Refused: this sheet hasn't been approved for this run's python_exec.");
        const { csv, name: sheetName } = await fetchSheetCsv(csvUrl);
        const sheet = tableFromDelimited(csv, { delimiter: ",", raw });
        return { name, source: sheetPage ? { kind: "sheet-current", label: "current sheet" } : { kind: "sheet-external", label: id || url, name: sheetName }, data: { kind: "rows", columns: sheet.columns, rows: sheet.rows } };
    }
    // A page table: read by the page from its own DOM, the one thing about this call it is asked.
    if (!/^https?:\/\//i.test(url)) {
        if (/^\s*@tool:/.test(url)) throw new Error(`pythonExec tables — "${url}" is a pointer that was not resolved to a table. Pass it as tables: {df: "@tool:<id>"} for a table a tool returned.`);
        if (!ctx.media?.table) throw new Error(`pythonExec tables — "${url}" is a page table, and this run cannot read the page here.`);
        const t = await ctx.media.table(url, raw);
        return { name, source: { kind: "dom", label: t.label }, data: t.data };
    }
    const cached = ctx.cache.get(url);
    if (cached?.table) return { name, source: { kind: "fetch", label: cached.url }, data: { kind: "rows", columns: cached.table.columns, rows: cached.table.rows } };
    throw new Error(cached
        ? `pythonExec tables — "${url}" was fetched but isn't a table (type: ${cached.type}). Only a CSV/TSV parses into a DataFrame this way.`
        : `pythonExec tables — "${url}" is not among this run's fetches. Call fetch_url on it, then pass the URL here.`);
}

/** `ml.pythonExec` for a run's python_exec in the worker: its tables loaded here, then `runPython` with the run as the
 *  caller (a cell outside the dialect only for the code this call was approved for), live stdout straight to the call's output. */
async function workerPython(ctx: RunCtx, code: string, opts: { image?: unknown; margin?: number; tableRaw?: boolean; tables?: unknown; onStdout?: (chunk: string, ts?: number) => void }) {
    // The image first, as the page's pythonExec shoots it before loading its tables: from the worker's own capture.
    let shot: { image: string; imageBox: ShotBox | null; documentId: string } | null = null;
    if (opts.image != null && opts.image !== "") {
        if (typeof opts.image !== "string") throw new Error("python_exec image — pass a CSS selector or an @pt:/@box: token.");
        if (!ctx.media) throw new Error("python_exec image — no screenshot can be taken for this run here.");
        shot = await ctx.media.image(opts.image, typeof opts.margin === "number" && Number.isFinite(opts.margin) ? opts.margin : 0);
    }
    // The page's shape rule, so `[[url]]` (a list once unwrapped, its key "0" no variable name) is refused as it is there.
    const specs: [string, unknown, string?][] = tableSpecs(opts.tables ?? null).map(({ name, src, alias }) => [name, src, alias]);
    const loaded = [];
    for (const [name, src] of specs) loaded.push(await workerTable(ctx, name, src, !!opts.tableRaw));
    // Not derived from anything the page knows (the run id reaches it): a stream id it cannot name.
    const requestId = `wpy-${crypto.randomUUID()}`;
    const r = await runPython({
        code, image: shot?.image ?? null, stream: !!opts.onStdout,
        tables: loaded.map((l, i) => ({ name: l.name, data: l.data, alias: specs[i][2] ?? (typeof specs[i][1] === "string" ? specs[i][1] : null) })),
    }, requestId, {
        ownSurface: false, tabId: ctx.tabId, disclose: false,
        untrusted: async () => (await senderTrust({ tab: { id: ctx.tabId, url: ctx.tabUrl() } as chrome.tabs.Tab, url: ctx.tabUrl() })) === "untrusted",
        pyCodeOk: (c) => ctx.pyCall?.code === c, runGated: true,
        valueOk: (holders) => holders.includes(ctx.runId),
        wireRun: ctx.runId, tabUrl: ctx.tabUrl, ...(ctx.pyCall?.step ? { wireStep: ctx.pyCall.step } : {}),
        ...(opts.onStdout ? { stream: opts.onStdout } : {}),
    });
    if (r.error !== undefined) throw new Error(r.error);
    const res = r.data as { table?: { columns: string[]; rows: unknown[][] }; valueKey?: string } & Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    // What the sandbox saw, the crop transform a cast projects through, and the document a cast mints its token in.
    if (shot) { extra.inputImage = shot.image; extra.imageDocument = shot.documentId; if (shot.imageBox) extra.imageBox = shot.imageBox; }
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
 * @param media python_exec's image and cast in the worker (none: an `image` is refused)
 * @returns the tools to register as the run's local tools
 */
export function buildWorkerTools(runId: string, tabId: number, tabUrl: () => string, names: readonly string[], media?: WorkerPyMedia): MlTool[] {
    const wanted = names.filter((n) => WORKER_TOOL_NAMES.has(n));
    if (!wanted.length) return [];
    const ctx: RunCtx = runs.get(runId) ?? newRunCtx(runId, tabId, tabUrl, false);
    // State made earlier (by ensureRunState, for a verify) learns the run's tools here.
    ctx.tabId = tabId; ctx.tabUrl = tabUrl; ctx.python = names.includes("python_exec");
    if (media) ctx.media = media;
    runs.set(runId, ctx);
    const ml = runMl(ctx);
    // agent_api_docs reads the shortcut and the config here, where the page would have asked for them by message.
    const docs = { invocation: invocationInfo, config: async () => publicConfig(await getConfig(), await senderSelfApproves({ url: ctx.tabUrl() })) };
    // answer keeps the run's set here, with the page's descriptor (what the model is shown); worker-answer.ts.
    const pageAnswer = () => makeDomTools(defineTool).find((t) => t.name === "answer")!;
    // `look` and `locate` are none of these: the run host builds them for each call (worker-look.ts, worker-locate.ts).
    return wanted.map((n) => (n === "fetch_url" ? fetchTool.call(ml) : n === "python_exec" ? pythonTool.call(ml) : n === "agent_api_docs" ? apiDocsTool(defineTool, docs) : n === "answer" ? workerAnswerTool(runId, pageAnswer())
        : n === "propose_policy" ? proposePolicyTool(defineTool, { check: checkProposal, added: (q) => runPolicies(runId).some((r) => r.consumer === "fetch" && r.source === q.source && r.effect === q.effect) })
        : null)).filter((t): t is MlTool => !!t);
}
