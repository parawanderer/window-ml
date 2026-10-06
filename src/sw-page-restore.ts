// sw-page-restore.ts — putting a tab's content scripts back when the extension moved underneath it.
//
// A content script lives as long as the extension that injected it. Reload or update the extension and every tab
// already open keeps its page and loses its listener, so the next `chrome.tabs.sendMessage` rejects with Chrome's
// "Could not establish connection. Receiving end does not exist." Nothing was wrong with the tab or the message.
// Shared by the chat page's page commands (`askPage`, sw-sessions.ts) and the worker's run start (sw-run-start.ts).
//
// WHAT RE-INJECTION CANNOT GIVE BACK: `shadow-patch.js` runs at `document_start` in the main world to record shadow
// roots as the page makes them. Injected after the page has loaded it only sees roots attached from then on, so a
// closed root created before this point stays unreachable until the tab is reloaded.

/** Chrome's own words for "that tab has nothing listening", which is not an error about the message. */
export const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

/** How long to wait for a re-injected content script to bring `window.ml` back, and how often to look. */
const REINJECT_READY_MS = 4000, REINJECT_POLL_MS = 100;

/**
 * Inject the manifest's content scripts into a tab again, and wait until `window.ml` exists in its main world. The
 * files come from the MANIFEST rather than a list here, so a content script added later is injected too.
 * @param tabId the tab
 * @returns true once the page's half is up, false if it did not come up in time
 * @throws when the extension may not script the tab at all
 */
export async function restoreContentScripts(tabId: number): Promise<boolean> {
    // `world` is in the manifest and not yet in the typings, so the entry is read through its own shape.
    type ContentScript = { js?: string[]; all_frames?: boolean; world?: "MAIN" | "ISOLATED" };
    for (const cs of (chrome.runtime.getManifest().content_scripts ?? []) as ContentScript[]) {
        if (!cs.js?.length) continue;
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: !!cs.all_frames },
            files: cs.js,
            ...(cs.world === "MAIN" ? { world: "MAIN" as const } : {}),
        });
    }
    // Wait for the MAIN world, not for the content script: the content script registers its listener before
    // `injected.js` has run, so a message sent on that signal reaches a page whose own handler is not there yet.
    // This is the same thing `openTab` waits for, for the same reason.
    const until = Date.now() + REINJECT_READY_MS;
    for (;;) {
        const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => !!(window as { ml?: unknown }).ml });
        if (probe?.result === true) break;
        if (Date.now() > until) return false;
        await new Promise((r) => setTimeout(r, REINJECT_POLL_MS));
    }
    return true;
}
