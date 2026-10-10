// worker-locate.ts — the `locate` tool of a run whose vision is the worker's: the same body, run in the worker over a vision host pinned to one document, with the page asked geometry only.

// In a run the worker built, or a page-built run handed to it (`makeWorkerRun`), a `locate` call never reaches the page
// as a call: the run host runs it here (sw-run-host.ts). The tool is the page's own (`buildLocateTool`) with the run's
// reader and grounding model, built over `workerVisionHost`, so the model is shown the text, the crop or the reader's
// words it was shown before. The capture, the badges, the grid, the letterbox and the highlight are drawn by the worker's
// raster; the reader's and the grounding model's prompts and replies stay in the worker; the grounding cache and the
// vision memory are the run's, per document, in the worker. The page answers layout questions (the scope's box, the
// candidate marks, a box or a cell snapped to the DOM, a minted `@pt`/`@box` token, the legend), each checked
// (geometry-check.ts). Nothing the page answers reaches a reader's or grounding model's prompt: those carry the model's
// own description and arguments only.

import type { MlApi, PageToolEnvelope } from "../contract";
import { buildLocateTool } from "../tools/builtin-tools";
import { defineTool } from "../ml/ml-tool-factories";
import type { VisionHost } from "../tools/vision-host";
import type { WorkerVisionHostOpts } from "./worker-vision-host";
import { groundCacheFor, keepGroundCache } from "./worker-vision";
import { runOnWorkerVision } from "./worker-look";
import { modelName, rangeOf } from "./run-vision";

/** The result for a locate with no document to pin it to: the browser does not say which page the tab holds. */
export const LOCATE_NO_DOCUMENT = "Error: the browser does not say which page the tab holds now, so nothing was located. Locate again.";

/** The result for a locate in a run with no model to read the screen: no reader and no grounding model. */
export const LOCATE_NO_VISION = "Error: this run has no vision model, so nothing was located.";

/** The run's vision facts a worker locate is built from (the run's rebuild config, the worker's own copy). */
export interface LocateVision {
    /** Whether the driver sees the pixels itself: a located point's crop goes to it inline, else the reader describes it. */
    driverSees: boolean;
    /** The run's reader (the driver itself when it sees). */
    visionModel: string | null;
    /** The grounding model, when the person configured one. */
    groundingModel: string | null;
    /** The grounding model's coordinate range. */
    groundingRange?: number;
}

/**
 * Run one `locate` call of a run in the worker, over a vision host pinned to `documentId`.
 * @param runId the run (its vision memory, its grounding cache, its sub-call spend)
 * @param tabId the run's tab
 * @param documentId the tab's top-frame document the call is about (null: none known, nothing is located)
 * @param args the model's arguments
 * @param vision the run's reader, grounding model and whether the driver sees ({@link LocateVision})
 * @param tabUrl the tab's URL, for the run's worker state
 * @param opts the host's test seams
 * @returns the envelope the page would have answered, with the call's spend as its `subUsage`
 */
export async function workerLocate(runId: string, tabId: number, documentId: string | null | undefined, args: Record<string, unknown>,
    vision: LocateVision, tabUrl: () => string, opts: WorkerVisionHostOpts = {}): Promise<PageToolEnvelope> {
    if (!documentId) return { result: LOCATE_NO_DOCUMENT };
    // A page-built run handed to the worker carries the facts its page wrote: only a model name is a model, and only a
    // whole range a range (it is printed into the grounding model's prompt).
    vision = { driverSees: vision.driverSees === true, visionModel: modelName(vision.visionModel), groundingModel: modelName(vision.groundingModel), groundingRange: rangeOf(vision.groundingRange) };
    // The page's run offers locate only with a reader; a run handed over without one, and with no grounding model either,
    // has nothing to read the screen with: nothing is captured for it.
    if (!vision.visionModel && !vision.groundingModel) return { result: LOCATE_NO_VISION };
    const ml = { defineTool } as unknown as MlApi;
    // The call reads and adds to a copy of the run's grounding cache for this document; what it added is kept only when
    // it completes, so a refused call leaves nothing behind (as the run's vision memory, `commit`).
    const groundCache = groundCacheFor(runId, documentId);
    const build = (host: VisionHost) =>
        buildLocateTool(ml, { model: vision.visionModel, groundingModel: vision.groundingModel, groundingRange: vision.groundingRange, host, groundCache });
    return runOnWorkerVision(runId, tabId, documentId, args, build, tabUrl, opts, { driverSees: vision.driverSees, visionModel: vision.visionModel },
        (refused) => { if (!refused) keepGroundCache(runId, documentId, groundCache, tabId); });
}
