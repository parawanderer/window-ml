// sw-offscreen.ts — the extension's ONE offscreen document, created lazily and reused. A service worker cannot run
// WASM or start a dedicated worker, so both things that need one live there: the Python sandbox (python_exec) and the
// session archive's SQLite. Chrome allows one offscreen document per extension, so they share it rather than each
// creating its own.

let offscreenReady: Promise<void> | null = null;

/** Drop the cached "the offscreen document exists", so the next call creates it again: it was torn down. */
export function forgetOffscreen(): void {
    offscreenReady = null;
}

/** The one offscreen document, created once: it hosts the Python sandbox's worker and the session archive's. */
export function ensureOffscreen(): Promise<void> {
    if (offscreenReady) return offscreenReady;
    offscreenReady = (async () => {
        if (await chrome.offscreen.hasDocument?.()) return;
        try {
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: [chrome.offscreen.Reason.WORKERS],
                justification: "Runs the sandboxed Python (Pyodide/WASM) for python_exec, and the SQLite session archive.",
            });
        } catch (e) {
            if (!(await chrome.offscreen.hasDocument?.())) throw e;   // tolerate a concurrent create
        }
    })();
    offscreenReady.catch(() => { offscreenReady = null; });   // let a failed create be retried
    return offscreenReady;
}
