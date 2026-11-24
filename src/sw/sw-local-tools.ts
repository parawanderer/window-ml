// sw-local-tools.ts — the tools of a run that the WORKER executes itself instead of delegating them to the page.
//
// A run the worker built (sw-run-start.ts, docs/spec/SITE_ACCESS.md slice 0) delegates its builtin tools to the page
// like any other background run, because they act on the page. Its REMOTE tools (a server-tool bundle's functions)
// do not touch the page: they call the backend with the user's key, and building them needs the backend's tool list.
// So they are registered here at start and every send of one of them is answered here, through the same
// `executeTool` and envelope the page's delegation uses (run-delegation.ts). So are the builtin tools that never read
// the page (worker-tools.ts `WORKER_TOOL_NAMES`), which would otherwise put what they read into the page's world.

import type { MlApi, MlTool, PageToolEnvelope, StartRunPayload } from "../contract";
import { buildServerTools } from "../tools/builtin-tools";
import { descriptorFor } from "../tools/render-descriptor";
import { envelopeFrom } from "../agent/run-delegation";
import { countDocsStreak, executeTool, toolContext } from "../tools/tool-exec";
import { listServerTools } from "./sw-llm";
import { workerMl } from "./worker-ml";
import { dropAnswer } from "./worker-answer";
import { dropVisionMemory } from "./worker-vision";
import { buildWorkerTools, dropWorkerTools, spendDelta, workerSpend, workerToolTexts, WORKER_TOOL_NAMES, type WorkerPyMedia } from "./worker-tools";
import { modelFacing } from "../agent/run-assembly";

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

/** The texts of the tools registered to run here for `runId` (the test hook's view of what executes). */
export function localToolTexts(runId: string): { name: string; description: string; parameters: unknown }[] {
    return Object.values(localToolsets.get(runId)?.byName ?? {}).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Forget a run's local tools, when the run is deleted. */
export function dropLocalTools(runId: string): void { localToolsets.delete(runId); dropWorkerTools(runId); dropAnswer(runId); dropVisionMemory(runId); }

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
 * @param media python_exec's image and cast through the worker's vision over the run's tab (worker-media.ts), given by
 *   the run host so this module does not import the vision host
 */
export async function ensureLocalTools(runId: string, p: StartRunPayload, tabId: number, tabUrl: () => string, media?: WorkerPyMedia): Promise<void> {
    if (localToolsets.has(runId)) return;
    const offered = new Set(p.tools.filter((t) => t.remote).map((t) => t.name));
    const builtin = buildWorkerTools(runId, tabId, tabUrl, p.tools.map((t) => t.name), media);
    if (!offered.size && !builtin.length) return;
    const bundleIds = [...new Set(p.tools.flatMap((t) => (t.remote ? [t.remote.toolId] : [])))];
    const bundles = offered.size ? await listServerTools().catch(() => []) : [];
    const tools = buildServerTools(workerMl(tabUrl()) as unknown as MlApi, bundles, bundleIds, []).filter((t) => offered.has(t.name));
    registerLocalTools(runId, [...tools, ...builtin], { model: p.model, driverSees: !!p.rebuild?.driverSees, visionModel: p.rebuild?.visionModel ?? null });
}

/** Whether a worker-built run's send of `name` belongs here: a remote tool, or a builtin that never reads the page. */
export function runsInWorker(p: StartRunPayload, name: string | undefined): boolean {
    return !!name && p.tools.some((t) => t.name === name && (!!t.remote || WORKER_TOOL_NAMES.has(name)));
}

/**
 * The tools a run the worker built and drives is shown: each tool the worker runs (`runsInWorker`) with the text of the
 * tool that runs, built by the same factory on the worker's `ml` and passed through the same chain `assembleRun` uses,
 * in place of the text its payload stored. The payload's text was written at the start from the `ml` the worker
 * assembles with, which is not the one its tools run on (python_exec read as a page-hosted run's: stateless, no
 * `/files`), and a stored session keeps it; read here at every turn, an old session reads the right text too.
 * @param runId the run
 * @param p its payload
 * @returns its descriptors, the worker's tools' texts in place
 */
export function workerFacing(runId: string, p: StartRunPayload): StartRunPayload["tools"] {
    const built = workerToolTexts(runId, p.tools.filter((t) => !t.remote).map((t) => t.name));
    if (!built.length) return p.tools;
    const ours = new Set(built.map((t) => t.name));
    // The stored descriptors stand in for the rest: the chain reads which tools the set holds (agent_api_docs, exec).
    const rest = p.tools.filter((t) => !ours.has(t.name)) as unknown as MlTool[];
    const shown = modelFacing([...built, ...rest], { unattended: !!p.unattended, autoRO: !!p.autoApproveReadonly, autoPy: !!p.autoApprovePython, toolTokens: !!p.toolTokens });
    const byName = new Map(shown.filter((t) => ours.has(t.name)).map((t) => [t.name, t]));
    return p.tools.map((t) => {
        const w = byName.get(t.name);
        return w ? { ...t, description: w.description, parameters: w.parameters } : t;
    });
}

/** Count a call the worker runs outside the run's local tools (`look`, worker-look.ts) towards agent_api_docs's
 *  streak, as `runLocalTool` counts a call the page runs. */
export function noteLocalStep(runId: string, name: string): void {
    const set = localToolsets.get(runId);
    if (set) countDocsStreak(toolContext(set.byName).docsMemory!, name);
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
    const args = send.args || {};
    // A local tool runs here whole: what it needs of the page (a page table, the live document for a session render of
    // the page the run is on) it asks for as plain data (worker-page-read.ts), so no send of it goes to the page.
    if (!set || !tool) {
        // A call the page runs is still a step of this run: agent_api_docs, run here, counts it towards its dedup.
        if (set && send.name && !send.renderOnly && !send.precheck && !send.readonlyTry) countDocsStreak(toolContext(set.byName).docsMemory!, send.name);
        return null;
    }
    if (send.renderOnly) return { result: "", renderIn: descriptorFor(tool, { result: "" }, args).in };
    if (send.precheck) return { result: "", precheckFailed: false };   // a remote tool has no doomed-action precheck
    if (send.readonlyTry) return { result: "", readonly: false };     // only `exec` has a read-only try
    const ctx = toolContext(set.byName, set.model, null, set.driverSees, set.visionModel);
    const before = workerSpend(send.runId);
    const env = envelopeFrom(tool, args, await executeTool(tool, args, ctx, onStream));
    // What its own model calls spent (fetch_url's reader), as the page reports a delegated tool's: the delta.
    const spent = before ? spendDelta(before, workerSpend(send.runId)) : undefined;
    if (spent) env.subUsage = spent;
    return env;
}
