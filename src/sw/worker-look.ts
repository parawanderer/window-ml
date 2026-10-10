// worker-look.ts — the `look` tool of a run whose vision is the worker's: the same body, run in the worker over a vision host pinned to one document, with the page asked geometry only.

// In a run the worker built, or a page-built run handed to it (`makeWorkerRun`), a `look` call never reaches the page as
// a call: the run host runs it here (sw-run-host.ts). The tool is the page's own (`buildNativeLookTool` when the driver
// sees, `buildLookTool` with the run's reader otherwise) built over `workerVisionHost`, so the model is shown the text,
// the image or the reader's words it was shown before, while the capture, the crops, the stitch's compose, the reader's
// prompt and reply, and the legend's wording stay in the worker. The page answers layout questions, each checked
// (geometry-check.ts), and a malformed, slow or moved answer ends the call with a fixed sentence (`onWorkerHost`).

import type { MlApi, MlTool, PageToolEnvelope, ToolContext } from "../contract";
import type { VisionHost } from "../tools/vision-host";
import { buildLookTool } from "../tools/builtin-tools";
import { buildNativeLookTool } from "../ml/ml-vision";
import { defineTool } from "../ml/ml-tool-factories";
import { executeTool } from "../tools/tool-exec";
import { envelopeFrom } from "../agent/run-delegation";
import { onWorkerHost, workerVisionHost, type WorkerVisionHostOpts } from "./worker-vision-host";
import { ensureRunState, spendDelta, workerSpend } from "./worker-tools";

/** The result for a look with no document to pin it to: the browser does not say which page the tab holds. */
export const LOOK_NO_DOCUMENT = "Error: the browser does not say which page the tab holds now, so nothing was looked at. Look again.";

/** The result for a look in a run with no vision: its driver does not see and it has no reader. */
export const LOOK_NO_VISION = "Error: this run has no vision model, so nothing was looked at.";

/** The arguments of a `look` or `locate` an approval card or a pending step's preview may show the page: the target
 *  only, which the page resolves to a label (`targetRender`) and learns anyway from the geometry it is asked. Never the
 *  question or the description. */
export function lookPreviewArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof args?.selector === "string") out.selector = args.selector;
    if (typeof args?.index === "number") out.index = args.index;
    return out;
}

/**
 * Run one vision tool call of a run in the worker, over a host pinned to `documentId`: the call's spend is its
 * `subUsage`, and a refused call is `Error: ` plus the host's fixed sentence, never what the body made of half an answer.
 * Shared by `look` and `locate` (worker-locate.ts).
 * @param runId the run (its vision memory, its sub-call spend)
 * @param tabId the run's tab
 * @param documentId the tab's top-frame document the call is about
 * @param args the model's arguments
 * @param build the tool, over the call's host
 * @param tabUrl the tab's URL, for the run's worker state
 * @param opts the host's test seams
 * @param ctx what the tool reads of the run's context (locate: whether the driver sees)
 * @param done called with the host's refusal (null when the call completed), before the envelope is returned
 * @returns the envelope the page would have answered
 */
export async function runOnWorkerVision(runId: string, tabId: number, documentId: string, args: Record<string, unknown>, build: (host: VisionHost) => MlTool,
    tabUrl: () => string, opts: WorkerVisionHostOpts = {}, ctx?: Partial<ToolContext>, done?: (refused: string | null) => void): Promise<PageToolEnvelope> {
    // The reader's call is metered into the run's worker state, which a run with no other worker tool has none of yet.
    ensureRunState(runId, tabId, tabUrl);
    const before = workerSpend(runId);
    const host = workerVisionHost(runId, tabId, documentId, opts);
    const tool = build(host);
    const r = await onWorkerHost(host, () => executeTool(tool, args, ctx as ToolContext | undefined));
    done?.(typeof r === "string" ? r : null);
    const subUsage = spendDelta(before, workerSpend(runId));
    // A refused call is the host's fixed sentence, never what the body made of half an answer.
    const env: PageToolEnvelope = typeof r === "string" ? { result: `Error: ${r}` } : envelopeFrom(tool, args, r);
    if (subUsage) env.subUsage = subUsage;
    return env;
}

/**
 * Run one `look` call of a run in the worker, over a vision host pinned to `documentId`.
 * @param runId the run (its vision memory, its sub-call spend)
 * @param tabId the run's tab
 * @param documentId the tab's top-frame document the call is about (null: none known, nothing is looked at)
 * @param args the model's arguments (an `@tool:` image pointer already resolved to `_image` by the loop)
 * @param vision whether the driver sees (native look) and the run's reader (delegated look)
 * @param tabUrl the tab's URL, for the run's worker state
 * @param opts the host's test seams
 * @returns the envelope the page would have answered, with the call's spend as its `subUsage`
 */
export async function workerLook(runId: string, tabId: number, documentId: string | null | undefined, args: Record<string, unknown>,
    vision: { driverSees: boolean; visionModel: string | null }, tabUrl: () => string, opts: WorkerVisionHostOpts = {}): Promise<PageToolEnvelope> {
    if (!documentId) return { result: LOOK_NO_DOCUMENT };
    // A run with neither a driver that sees nor a reader has no `look`: nothing is captured for it.
    if (!vision.driverSees && !vision.visionModel) return { result: LOOK_NO_VISION };
    const ml = { defineTool } as unknown as MlApi;
    return runOnWorkerVision(runId, tabId, documentId, args,
        (host) => (vision.driverSees ? buildNativeLookTool(ml, { host }) : buildLookTool(ml, { model: vision.visionModel, host })), tabUrl, opts);
}
