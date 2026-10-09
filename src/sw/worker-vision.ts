// worker-vision.ts — the worker's half of a vision tool: a screenshot of the run's own tab with the sidebar hidden through the extension's shell, and the vision model's sub-call metered into the run.

// Built for the worker's VisionHost (docs/spec/SITE_ACCESS.md, slice 2 part 3): in a worker-built run the page sees no
// capture, no sidebar handshake and no reader request. Nothing calls these yet; look, locate and verify move onto them
// in later PRs.

import type { Shot } from "../tools/vision-host";
import { oneShotRequest } from "../ml/ml-chat";
import { hintSession } from "../contract/contract-run";
import { imageSize } from "../session/session-commands";
import { cdpScreenshot } from "./sw-cdp";
import { CAPTURE_RETRIES, CAPTURE_RETRY_MS, captureOwnTab, NOT_SHOWING } from "./sw-capture";
import { getConfig } from "./sw-llm";
import { runChat } from "./worker-tools";

/**
 * How long a debugger screenshot may take before the own-tab capture is tried instead. A shot of a showing tab, attach
 * included, takes well under a second; a tab in the background can hold `Page.captureScreenshot` until it next paints,
 * which for an occluded or throttled tab may be never. Five seconds is many times a real shot and still short beside a
 * tool call's own budget, so a stuck one costs the run seconds rather than the call.
 */
export const CDP_SHOT_MS = 5000;

/** How long the worker waits for the shell to say the sidebar is hidden before capturing anyway: the page path's wait. */
export const SHOT_HIDE_MS = 200;

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

/**
 * {@link captureRunTab} with the debug sidebar hidden around it, through the extension's own shell (the tab's content
 * script) and never the page: `SHOT_HIDE` to the top frame, answered once the sidebar is hidden and has painted, then
 * the capture, then `SHOT_SHOW`, sent whatever the capture did. A shell that does not answer within `hideMs` (none
 * mounted, a tab that does not paint) is not waited for: the capture goes anyway, as the page's own path does.
 * @param tabId the run's tab
 * @param opts `hideMs`: the wait for the shell ({@link SHOT_HIDE_MS}); `cdpTimeoutMs` as {@link captureRunTab}
 * @returns the capture
 */
export async function workerShot(tabId: number, opts: { hideMs?: number; cdpTimeoutMs?: number } = {}): Promise<Required<Shot>> {
    // One id per shot: the shell lifts this shot's hide only, and drops it on its own if the show never comes.
    const id = crypto.randomUUID();
    const send = (type: "SHOT_HIDE" | "SHOT_SHOW") => Promise.resolve().then(() => chrome.tabs.sendMessage(tabId, { type, id }, { frameId: 0 })).catch(() => undefined);
    try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([send("SHOT_HIDE"), new Promise((r) => { timer = setTimeout(r, opts.hideMs ?? SHOT_HIDE_MS); })]).finally(() => clearTimeout(timer));
        return await captureRunTab(tabId, opts);
    } finally {
        void send("SHOT_SHOW");
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
