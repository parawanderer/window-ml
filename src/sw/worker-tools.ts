// worker-tools.ts — builtin tools of a worker-built run that never read the page, built to run in the worker.

// A tool run in the page puts what it reads into the page's world: a `fetch_url` of another site, or a credentialed
// read, sat in the page's realm and its fetch cache, readable by anything on the page (docs/spec/SITE_ACCESS.md,
// slice 2 part 2). These are the same tools, from the same factories, given an `ml` whose members the worker answers
// itself: the descriptor the model is shown and the run's approval are unchanged, and only where the body runs moves.

import type { FetchResult, MlApi, MlTool, SubcallUsage } from "../contract";
import { fetchTool, defineTool } from "../ml/ml-tool-factories";
import { derivedFetchFields, cacheCopy } from "../ml/fetch-result";
import { hintSession } from "../contract/contract-run";
import { isCurrentPage } from "../dom/dom";
import { fetchUrlFor } from "./sw-fetch-url";
import { apiDocsTool } from "../tools/api-docs-tool";
import { publicConfig } from "../contract/contract-config";
import { invocationInfo } from "./sw-invocation";
import { senderTrust } from "./sw-consent";
import { htmlToMarkdownOffscreen } from "./sw-offscreen";
import { fetchLLM, getConfig } from "./sw-llm";

/** The builtin tools a worker-built run executes in the worker rather than the page. */
export const WORKER_TOOL_NAMES: ReadonlySet<string> = new Set(["fetch_url", "agent_api_docs"]);

/** What one run's worker tools share: the tab they act for, its fetch cache, and the spend of their model calls. */
interface RunCtx {
    runId: string; tabId: number; tabUrl: () => string; python: boolean; cache: Map<string, FetchResult>; spent: SubcallUsage;
    /** URLs the person approved this run's fetch_url to read, remembered for the run (a repeat auto-approves). */
    consented: Set<string>;
    /** As-you (credentialed) fetches the person approved, each spent by the one call it was approved for. */
    credOnce: Set<string>;
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
        chat: async (prompt: string, opts: { model?: string | null; extend?: "utility" | null; numCtx?: number | null } = {}): Promise<string> => {
            const r = await fetchLLM({
                messages: [{ role: "user", content: prompt }], model: opts.model ?? null, extend: opts.extend ?? null,
                numCtx: opts.numCtx ?? null, think: false, hint: { use: "agent", session: hintSession(ctx.runId) },
            }) as { content?: string | null; model?: string | null; usage?: { promptTokens?: number; completionTokens?: number } | null };
            const p = r.usage?.promptTokens || 0, c = r.usage?.completionTokens || 0;
            const s = ctx.spent;
            s.prompt += p; s.completion += c; s.calls += 1;
            const model = r.model || opts.model || "unknown";
            const row = (s.byModel ??= []).find((m) => m.model === model);
            if (row) { row.prompt += p; row.completion += c; row.calls += 1; } else s.byModel.push({ model, prompt: p, completion: c, calls: 1 });
            return String(r.content ?? "");
        },
    } as unknown as MlApi;
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
    return wanted.map((n) => (n === "fetch_url" ? fetchTool.call(ml) : n === "agent_api_docs" ? apiDocsTool(defineTool, docs) : null)).filter((t): t is MlTool => !!t);
}
