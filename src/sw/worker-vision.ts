// worker-vision.ts — the worker's half of a vision tool: a screenshot of the run's own tab and document with the extension's own UI masked out, and the vision model's sub-call metered into the run.

// Built for the worker's VisionHost (docs/spec/SITE_ACCESS.md, slice 2 part 3): in a worker-built run the page sees no
// capture, no change to its DOM around one, and no reader request. The verify after an action (worker-verify.ts) and
// `look` (worker-look.ts) use them; locate moves onto them in a later PR.

import type { Shot } from "../tools/vision-host";
import { oneShotRequest } from "../ml/ml-chat";
import { hintSession } from "../contract/contract-run";
import { imageSize } from "../session/session-commands";
import { cdpScreenshot } from "./sw-cdp";
import { CAPTURE_RETRIES, CAPTURE_RETRY_MS, captureOwnTab, NOT_SHOWING } from "./sw-capture";
import { getConfig } from "./sw-llm";
import { runChat } from "./worker-tools";
import { maskShot } from "./shot-mask";
import { workerRaster } from "../raster";
import type { ShotRects } from "../sidebar/shell-shot";
import type { VisionMemory } from "../contract/contract-render";
import { defineState } from "../state-registry";

/**
 * How long a debugger screenshot may take before the own-tab capture is tried instead. A shot of a showing tab, attach
 * included, takes well under a second; a tab in the background can hold `Page.captureScreenshot` until it next paints,
 * which for an occluded or throttled tab may be never. Five seconds is many times a real shot and still short beside a
 * tool call's own budget, so a stuck one costs the run seconds rather than the call.
 */
export const CDP_SHOT_MS = 5000;

/**
 * How long the shell has to say where the extension's UI is. It answers from the page's main thread, at once on an idle
 * page; a page that holds its main thread past this is refused a shot rather than given one with the UI unmasked.
 */
export const SHOT_RECTS_MS = 1000;

/** The sentence for a shell that did not say where the extension's UI is in time. */
const RECTS_SLOW = "Can't screenshot this tab: the page is too busy for window.ml to find its own panels on it (they would be in the shot). Retry once the page settles.";
/** The sentence for a tab whose document changed while the shot was taken. */
const NAVIGATED = "Can't screenshot this tab: it went to another page while the screenshot was being taken. Look again.";

/** The sentence for a run tab that is not showing when the debugger's screenshot also failed: the own-tab capture can't help. */
const cdpFailedNotShowing = (err: string): string => `Can't screenshot this tab: the debugger's screenshot failed (${err}), and without it a screenshot is only of the tab showing in its window, which this one isn't. Switch to it, or close Chrome DevTools on it if it's open, and retry.`;

/**
 * A screenshot of a run's tab, by its id, whatever the window shows. With "Debugger-based actions" on, the debugger
 * shoots that tab even in the background, bounded by `cdpTimeoutMs`; when it fails or runs out, and with the setting
 * off, `captureOwnTab` shoots it only while it is the one showing, and refuses otherwise. Never switches tabs.
 * @param tabId the run's tab
 * @param opts `cdpTimeoutMs`: the debugger shot's bound ({@link CDP_SHOT_MS})
 * @returns the PNG data URL and its pixel size, read from its header
 * @throws {@link NOT_SHOWING} (or its debugger-failed variant) for a tab not showing; the browser's error otherwise
 */
export async function captureRunTab(tabId: number, opts: { cdpTimeoutMs?: number } = {}): Promise<Required<Shot>> {
    const cfg = await getConfig();
    let cdpErr = "";
    if (cfg.cdp) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{ error: string }>((r) => { timer = setTimeout(() => r({ error: "it did not finish in time" }), opts.cdpTimeoutMs ?? CDP_SHOT_MS); });
        const shot = await Promise.race([cdpScreenshot(tabId).catch((e) => ({ error: String((e as Error)?.message || e) })), timeout]).finally(() => clearTimeout(timer));
        if ("ok" in shot) return sized(shot.dataUrl);
        cdpErr = shot.error;
    }
    for (let attempt = 0; ; attempt++) {
        try { return sized(await captureOwnTab(tabId)); }
        catch (e) {
            const msg = (e as Error)?.message || String(e);
            if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg) && attempt < CAPTURE_RETRIES) { await new Promise((r) => setTimeout(r, CAPTURE_RETRY_MS)); continue; }
            if (cdpErr && msg === NOT_SHOWING) throw new Error(cdpFailedNotShowing(cdpErr));
            throw e;
        }
    }
}

/** A capture's data URL with the pixel size its PNG header gives. */
function sized(dataUrl: string): Required<Shot> {
    const s = imageSize(dataUrl);
    if (!s) throw new Error("the screenshot is not an image this can read.");
    return { dataUrl, w: s.width, h: s.height };
}

/** The tab's top-frame document now, by the browser's answer (null when it gives none). */
export async function topDocument(tabId: number): Promise<string | null> {
    const f = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { documentId?: string } | null;
    return typeof f?.documentId === "string" ? f.documentId : null;
}

/**
 * Ask the tab's shell, in `documentId` only, where the extension's UI is. A send nothing receives means no content
 * script there, so no extension UI: null. One that answers in time is the answer. One that does neither is refused.
 * @param tabId the run's tab
 * @param documentId the document the shot is of
 * @param ms the bound ({@link SHOT_RECTS_MS})
 * @returns the shell's answer, or null for none
 * @throws {@link RECTS_SLOW} when the shell is there and did not answer in time
 */
async function askRects(tabId: number, documentId: string, ms: number): Promise<ShotRects | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const SLOW = Symbol("slow");
    const r = await Promise.race([
        // Only "nothing is listening" means no content script. Any other failure (the shell threw, the port closed) is
        // not an answer, and is refused below as one that can't be read rather than read as "no UI".
        Promise.resolve().then(() => chrome.tabs.sendMessage(tabId, { type: "SHOT_RECTS" }, { frameId: 0, documentId }))
            .then((a) => ({ a: a ?? {} }), (e) => (/Receiving end does not exist/i.test(String((e as Error)?.message ?? e)) ? null : { a: {} })),
        new Promise<typeof SLOW>((res) => { timer = setTimeout(() => res(SLOW), ms); }),
    ]).finally(() => clearTimeout(timer));
    if (r === SLOW) throw new Error(RECTS_SLOW);
    return r ? (r.a as ShotRects) : null;
}

/**
 * {@link captureRunTab} of the run's document with the extension's own UI masked out, changing nothing on the page.
 * The shell (the tab's content script) says where the sidebar, the run card, the image viewer, the hover highlight and
 * any extension frame sit, before and after the capture, and the union of both is painted opaque in the worker. Pinned
 * to the top frame's document: a commit during the shot, or a different document after it, refuses the shot.
 * @param tabId the run's tab
 * @param opts `rectsMs`: the bound on each of the shell's answers ({@link SHOT_RECTS_MS}); `cdpTimeoutMs` as
 *   {@link captureRunTab}; `documentId`: the document the shot must be of (refused when the tab holds another)
 * @returns the masked capture
 * @throws when the document changed, the shell did not answer in time or unreadably, or the mask covers most of the shot
 */
export async function workerShot(tabId: number, opts: { rectsMs?: number; cdpTimeoutMs?: number; documentId?: string } = {}): Promise<Required<Shot>> {
    const doc = await topDocument(tabId);
    if (!doc) throw new Error("Can't screenshot this tab: the browser does not say which page it holds.");
    // A shot asked for one document (a vision call whose geometry came from it) is of that document or of nothing.
    if (opts.documentId !== undefined && doc !== opts.documentId) throw new Error(NAVIGATED);
    let moved = false;
    const onCommitted = (d: { tabId: number; frameId: number }): void => { if (d.tabId === tabId && d.frameId === 0) moved = true; };
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    try {
        const ms = opts.rectsMs ?? SHOT_RECTS_MS;
        const before = await askRects(tabId, doc, ms);
        const shot = await captureRunTab(tabId, opts);
        const after = await askRects(tabId, doc, ms);
        // A commit, even one back to the same document from the back-forward cache, means the pixels may be another page's.
        if (moved || (await topDocument(tabId)) !== doc) throw new Error(NAVIGATED);
        const masked = await maskShot(shot, [before, after], workerRaster);
        return { dataUrl: masked.dataUrl, w: masked.w, h: masked.h };
    } finally {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
    }
}

/**
 * A vision sub-call of a run, asked by the worker: the request `oneShotRequest` builds (the one the page's `ml.chat`
 * sends for the same inputs), in the run's session, sent and counted into the run's sub-call spend.
 * @param runId the run whose spend it counts into
 * @param prompt the question
 * @param o the images, the model (null for the configured one), the reply's token cap and the context size
 * @returns the model's reply
 * @throws when this worker holds no worker-tool state for the run, or the call fails
 */
export function workerVisionChat(runId: string, prompt: string, o: { images: string[]; model: string | null; maxTokens: number | null; numCtx: number | null }): Promise<string> {
    return runChat(runId, oneShotRequest(prompt, { images: o.images, model: o.model, maxTokens: o.maxTokens, numCtx: o.numCtx, session: hintSession(runId) }));
}

/** Each run's vision memory in the worker, for the one document it is about: the spots look and locate already showed
 *  its driver there, and the boundary notes already appended. A new document starts it empty (what page A showed must
 *  not suppress page B's feedback). Worker memory only, so an eviction forgets it and a repeated crop or note is shown
 *  again. */
const memories = new Map<string, { documentId: string; memory: VisionMemory }>();   // see the defineState below

defineState({
    id: "run.vision", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction", "navigation"], heldOnly: true,
    describe: "The spots look and locate already showed the model on the run's current page, and the iframe and shadow-root notes already given there, so neither is repeated.",
    read: ({ runId }) => {
        const m = runId ? memories.get(runId)?.memory : undefined;
        return m ? { seen: m.seen.map((p) => ({ x: p.x, y: p.y })), boundariesSeen: [...(m.boundariesSeen ?? [])] } : undefined;
    },
});

/** A run's vision memory in the worker for `documentId`, made empty on first use and whenever the document changes. */
export function visionMemoryFor(runId: string, documentId: string): VisionMemory {
    let m = memories.get(runId);
    if (!m || m.documentId !== documentId) { m = { documentId, memory: { seen: [], boundariesSeen: new Set() } }; memories.set(runId, m); }
    return m.memory;
}

/** Forget a run's vision memory, when its worker tools are dropped. */
export function dropVisionMemory(runId: string): void { memories.delete(runId); }

/** Forget every run's vision memory: what an eviction does (the eviction test hook). */
export function dropAllVisionMemory(): void { memories.clear(); }
