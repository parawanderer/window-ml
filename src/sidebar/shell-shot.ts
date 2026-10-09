// shell-shot.ts — hiding the debug sidebar around a screenshot: the page's handshake and the worker's, kept apart so a page cannot bring the sidebar back into a shot the worker is taking.

// Two parties ask the shell to hide the sidebar. A page-hosted vision tool asks over the page's window
// (`__mlSidebarShot: "hide"|"show"`), a channel any script on the page can post to. The worker asks over
// chrome.runtime (`SHOT_HIDE`/`SHOT_SHOW`, worker-vision.ts `workerShot`), which no page reaches. Each party's hide is
// held separately and the sidebar shows only when neither holds one, so the page's "show" lifts the page's own hide and
// nothing else.

/** What the shell hides for a shot and brings back after: the sidebar, the off-mode card, the lightbox, the hover box. */
export interface ShotSurface {
    /** Hide everything that would land in a capture (called again while already hidden: must be idempotent). */
    hide(): void;
    /** Bring it back. */
    show(): void;
}

/** How long a worker's hide is held with no `SHOT_SHOW`: past the worker's longest shot (a 5 s debugger bound plus the
 *  quota retries), so a worker evicted mid-shot does not leave the sidebar hidden for good. */
export const WORKER_SHOT_HOLD_MS = 15_000;

/** The two frames a hide waits before it is acknowledged, so the hidden state has painted before the capture fires. */
const afterTwoFrames = (fn: () => void): void => { requestAnimationFrame(() => requestAnimationFrame(fn)); };

/**
 * Whether a chrome.runtime message to this content script came from the extension's worker: this extension's id and
 * no tab. A page has no way onto this channel; the sidebar's own frame and the extension's pages have a tab.
 * @param sender the message's sender, as the browser reports it
 * @returns true for the worker
 */
export function fromWorker(sender: chrome.runtime.MessageSender | undefined): boolean {
    return !!sender && sender.id === chrome.runtime.id && !sender.tab;
}

/** The shell's shot handling, from {@link shotGate}. */
export interface ShotGate {
    /** The page's `__mlSidebarShot: "hide"`: hide, then `ack` after two frames. */
    pageHide(ack: () => void): void;
    /** The page's `__mlSidebarShot: "show"`: lifts the page's hide only. */
    pageShow(): void;
    /**
     * A `SHOT_HIDE` or `SHOT_SHOW` from chrome.runtime. Ignored unless it is from the worker and names its shot.
     * @returns true when `sendResponse` will be called later (an accepted hide), for the listener to return
     */
    onRuntime(msg: { type?: unknown; id?: unknown }, sender: chrome.runtime.MessageSender | undefined, sendResponse: (r?: unknown) => void): boolean;
    /** Whether a worker's shot is holding the sidebar hidden (tests). */
    workerHolding(): boolean;
}

/**
 * The shell's shot handling over the elements it hides.
 * @param surface what to hide and show
 * @param holdMs how long a worker's hide is held without its show ({@link WORKER_SHOT_HOLD_MS})
 * @returns the handlers the shell's two listeners call
 */
export function shotGate(surface: ShotSurface, holdMs = WORKER_SHOT_HOLD_MS): ShotGate {
    let pageHidden = false;   // state: ui — the page's own hide, lifted by its show
    const workerShots = new Map<string, ReturnType<typeof setTimeout>>();   // state: ui — the worker's shots in progress, each lifted by its own SHOT_SHOW or its hold running out
    const apply = (): void => { if (pageHidden || workerShots.size) surface.hide(); else surface.show(); };
    const endWorkerShot = (id: string): void => {
        const t = workerShots.get(id);
        if (t === undefined) return;
        clearTimeout(t);
        workerShots.delete(id);
        apply();
    };
    return {
        pageHide(ack) { pageHidden = true; apply(); afterTwoFrames(ack); },
        pageShow() { pageHidden = false; apply(); },
        onRuntime(msg, sender, sendResponse) {
            if (!fromWorker(sender) || typeof msg.id !== "string" || !msg.id || msg.id.length > 64) return false;
            const id = msg.id;
            if (msg.type === "SHOT_SHOW") { endWorkerShot(id); return false; }
            if (msg.type !== "SHOT_HIDE") return false;
            clearTimeout(workerShots.get(id));
            workerShots.set(id, setTimeout(() => endWorkerShot(id), holdMs));
            apply();
            afterTwoFrames(() => sendResponse({ hidden: true }));
            return true;
        },
        workerHolding: () => workerShots.size > 0,
    };
}
