// sw-local-tools.ts — the tools of a run that the WORKER executes itself instead of delegating them to the page.
//
// A run the worker built (sw-run-start.ts, docs/spec/SITE_ACCESS.md slice 0) delegates its builtin tools to the page
// like any other background run, because they act on the page. Its REMOTE tools (a server-tool bundle's functions)
// do not touch the page: they call the backend with the user's key, and building them needs the backend's tool list.
// So they are registered here at start and every send of one of them is answered here, through the same
// `executeTool` and envelope the page's delegation uses (run-delegation.ts).

import type { MlApi, MlTool, PageToolEnvelope, StartRunPayload } from "../contract";
import { buildServerTools } from "../tools/builtin-tools";
import { descriptorFor } from "../tools/render-descriptor";
import { envelopeFrom } from "../agent/run-delegation";
import { executeTool, toolContext } from "../tools/tool-exec";
import { listServerTools } from "./sw-llm";
import { workerMl } from "./worker-ml";

/** What a run's local tools need to run: the tools by name, and the vision facts their ToolContext carries. */
interface LocalToolset { byName: Record<string, MlTool>; model: string | null; driverSees: boolean; visionModel: string | null; }

/** The local (remote-backed) tools of each worker-built run, keyed by run id. Set at start, dropped when the run is. */
const localToolsets = new Map<string, LocalToolset>();

/**
 * Register the tools of a run that the worker executes itself.
 * @param runId the run
 * @param tools the tools to run here (a worker-built run's remote tools)
 * @param facts the run's model and vision facts, for the tools' ToolContext
 */
export function registerLocalTools(runId: string, tools: MlTool[], facts: { model: string | null; driverSees: boolean; visionModel: string | null }): void {
    if (!tools.length) return;
    localToolsets.set(runId, { byName: Object.fromEntries(tools.map((t) => [t.name, t])), ...facts });
}

/** Forget a run's local tools, when the run is deleted. */
export function dropLocalTools(runId: string): void { localToolsets.delete(runId); }

/** Forget every run's local tools: what an eviction does to this memory (the eviction test hook). */
export function dropAllLocalTools(): void { localToolsets.clear(); }

/**
 * Make sure a worker-built run's remote tools are registered here, rebuilding them if this worker never had them: a
 * run rehydrated after an eviction, or a saved session resumed, carries their DESCRIPTORS in its payload (what the
 * model is shown) but not the tools. Rebuilt from the server's current bundles by the same `buildServerTools`, and
 * kept to exactly the names the run already offers, so a bundle that grew a function since does not widen the run.
 * @param runId the run
 * @param p its payload
 * @param tabUrl its tab's URL, for the worker's `ml`
 */
export async function ensureLocalTools(runId: string, p: StartRunPayload, tabUrl: string): Promise<void> {
    if (localToolsets.has(runId)) return;
    const offered = new Set(p.tools.filter((t) => t.remote).map((t) => t.name));
    if (!offered.size) return;
    const bundleIds = [...new Set(p.tools.flatMap((t) => (t.remote ? [t.remote.toolId] : [])))];
    const bundles = await listServerTools().catch(() => []);
    const tools = buildServerTools(workerMl(tabUrl) as unknown as MlApi, bundles, bundleIds, []).filter((t) => offered.has(t.name));
    registerLocalTools(runId, tools, { model: p.model, driverSees: !!p.rebuild?.driverSees, visionModel: p.rebuild?.visionModel ?? null });
}

/** One tool send, as `RUN_TOOL_IN_PAGE` carries it. */
interface ToolSend { runId: string; name?: string; args?: Record<string, unknown>; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; stream?: boolean; }

/**
 * Answer a tool send here if the tool is one of the run's local tools, mirroring what the page does for the same
 * send (run-delegation.ts): a render-only preview, a precheck, a read-only try, or the call itself.
 * @param send the send, as it would have gone to the page
 * @param onStream the call's live-output sink, when the loop asked for one
 * @returns the envelope, or null when the tool is not local and the send belongs to the page
 */
export async function runLocalTool(send: ToolSend, onStream?: (text: string, ts?: number) => void): Promise<PageToolEnvelope | null> {
    const set = localToolsets.get(send.runId);
    const tool = send.name ? set?.byName[send.name] : undefined;
    if (!set || !tool) return null;
    const args = send.args || {};
    if (send.renderOnly) return { result: "", renderIn: descriptorFor(tool, { result: "" }, args).in };
    if (send.precheck) return { result: "", precheckFailed: false };   // a remote tool has no doomed-action precheck
    if (send.readonlyTry) return { result: "", readonly: false };     // only `exec` has a read-only try
    const ctx = toolContext(set.byName, set.model, null, set.driverSees, set.visionModel);
    return envelopeFrom(tool, args, await executeTool(tool, args, ctx, onStream));
}
