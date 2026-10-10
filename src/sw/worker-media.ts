// worker-media.ts — the images a run whose vision is the worker's hands on that are not a vision tool's: the answer's HUD media and python_exec's `image`, each cropped from the worker's own capture, with the page asked geometry only.

// The answer tool (worker-answer.ts) asks the page to resolve a selector; for such a run the page captures nothing and
// answers each element's shape only (tools.ts `answerMediaShape`). Each item's image is cropped here, from a masked
// capture of the document the page answered in (worker-vision.ts `workerShot`), over the same vision host look and
// locate use (worker-vision-host.ts), so the page answers only where each element is. An `<img>` is cropped like any
// element: the worker never fetches a src the page names (the owner's answer 2 on site-access part 3), so the HUD card
// shows the image as the page drew it, at its drawn size, not its source file.
//
// A python_exec with `image` runs in the worker (worker-tools.ts): its image is shot here as the page's `ml.pythonExec`
// shoots it (`raw`, with `margin` for an `@pt`), with the crop transform its `cast` projects through: the rect it cropped
// (`shootWithBox`), never a second answer from the page, and
// a `cast` mints its `@pt`/`@box` in the PAGE's registry through the `mint` geometry op, pinned to the document the
// image came from, so a click on the token resolves where the image was taken.

import type { AnswerMedia, ShotBox } from "../contract";
import { shootWithBox } from "../ml/ml-vision";
import { MAX_IMAGE } from "./worker-answer";
import { onWorkerHost, workerVisionHost, type WorkerVisionHostOpts } from "./worker-vision-host";
import { topDocument } from "./worker-vision";
import type { WorkerPyMedia } from "./worker-tools";

/** The python_exec error for an image with no document to pin it to. */
export const PY_IMAGE_NO_DOCUMENT = "the browser does not say which page the tab holds now, so the image was not taken. Run it again.";
/** The python_exec error for a cast with no document to mint its token in. */
export const PY_MINT_NO_DOCUMENT = "the browser does not say which page the tab holds now, so no token was minted. Run it again.";

/**
 * Crop each answer media item from the worker's capture of `documentId`: item i is the `index`th match of `selector`
 * (the call's own index), else its i-th, shot as `ml.screenshot(el, { noOverlay: true })` shoots an element (scrolled
 * into view, cropped to its box). An item that can't be shot (gone, too small, off-screen, a refused call, a document
 * change) keeps its chip with no image, as a failed page crop does. Everything else of an item is the page's shape,
 * already checked (worker-answer.ts `checkSelection`).
 * @param runId the run
 * @param tabId the run's tab
 * @param documentId the document the page answered in (null: none known, no images)
 * @param selector the model's selector
 * @param index the model's index, if any
 * @param media the page's items, each with an empty image
 * @param opts the host's test seams
 * @returns the items with their images
 */
export async function workerAnswerMedia(runId: string, tabId: number, documentId: string | null, selector: string, index: number | undefined,
    media: AnswerMedia[], opts: WorkerVisionHostOpts = {}): Promise<AnswerMedia[]> {
    if (!documentId) return media.map((m) => ({ ...m, image: "" }));
    const host = workerVisionHost(runId, tabId, documentId, opts);
    try {
        const out: AnswerMedia[] = [];
        for (const [i, m] of media.entries()) {
            let image = "";
            if (!host.refusal()) {
                try { image = await host.shoot(selector, { index: index ?? i, noOverlay: true }); } catch { image = ""; }
            }
            // A refusal met while shooting this item (a document change) means its crop may be another page's.
            if (host.refusal() || image.length > MAX_IMAGE) image = "";
            out.push({ ...m, image });
        }
        return out;
    } finally { host.end(); }
}

/**
 * The image a python_exec loads, shot in the worker: the raw crop of `image` (a selector's first match, or an
 * `@pt`/`@box` token) from a masked capture of the tab's document, and the crop transform a `cast` projects through.
 * @param runId the run
 * @param tabId the run's tab
 * @param image the call's `image`
 * @param margin the call's `margin` (an `@pt`'s crop radius)
 * @param opts the host's test seams
 * @returns the PNG data URL, its crop transform (the rect it cropped), and the document
 * @throws the shot's error (no match, too small) or the host's refusal, as the page's pythonExec throws its screenshot's
 */
export async function workerPythonImage(runId: string, tabId: number, image: string, margin: number, opts: WorkerVisionHostOpts = {}): Promise<{ image: string; imageBox: ShotBox | null; documentId: string }> {
    const documentId = await topDocument(tabId);
    if (!documentId) throw new Error(PY_IMAGE_NO_DOCUMENT);
    const host = workerVisionHost(runId, tabId, documentId, opts);
    const r = await onWorkerHost(host, async () => {
        const shot = await shootWithBox(host, image, { raw: true, margin });
        return { image: shot.dataUrl, imageBox: shot.box };
    });
    if (typeof r === "string") throw new Error(r);
    return { ...r, documentId };
}

/**
 * Mint a python_exec `cast`'s token in the page's registry (the `mint` geometry op, checked: a token of the asked
 * kind), pinned to `documentId` (the image's), else the tab's document now.
 * @param runId the run
 * @param tabId the run's tab
 * @param q the point or box, in viewport CSS px
 * @param documentId the document the coordinates are about (null: the tab's document now)
 * @param opts the host's test seams
 * @returns the token
 * @throws when the page's answer is refused, or the tab holds another document
 */
export async function workerMint(runId: string, tabId: number, q: { pt: { x: number; y: number } } | { box: { left: number; top: number; right: number; bottom: number } },
    documentId: string | null, opts: WorkerVisionHostOpts = {}): Promise<string> {
    const doc = documentId ?? await topDocument(tabId);
    if (!doc) throw new Error(PY_MINT_NO_DOCUMENT);
    const host = workerVisionHost(runId, tabId, doc, opts);
    const r = await onWorkerHost(host, async () => (await host.geo.mint(q)).token);
    const refused = host.refusal();
    if (refused) throw new Error(refused);
    return r;
}

/**
 * A run's python_exec image and cast through the worker's vision over its tab: what the run's worker tools are built
 * with (worker-tools.ts `buildWorkerTools`), wherever they are built (sw-run-start.ts, sw-run-host.ts).
 * @param runId the run
 * @param tabId the run's tab
 * @returns the python_exec media
 */
export function pyMediaFor(runId: string, tabId: number): WorkerPyMedia {
    return { image: (image, margin) => workerPythonImage(runId, tabId, image, margin), mint: (q, doc) => workerMint(runId, tabId, q, doc) };
}
