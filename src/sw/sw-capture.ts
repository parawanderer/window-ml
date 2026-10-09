// sw-capture.ts — a screenshot of the tab that asked for it, never of another tab that happens to be showing.

/** Why a tab that is not showing gets no screenshot: without the debugger, the browser shoots whatever its window shows. */
export const NOT_SHOWING = "Can't screenshot this tab: it isn't the one showing in its window, and without the debugger a screenshot is of whatever tab is showing. Switch to it, or turn on \"Debugger-based actions and user scripts\" in window.ml Settings → Advanced.";

/**
 * `captureVisibleTab` for one tab. It takes a WINDOW and shoots the tab that window shows, so it is taken only while
 * `tabId` is that tab, and thrown away if the window showed another tab at any point while it was taken.
 * @param tabId the tab the screenshot is for (the sender's own)
 * @param opts the image format (PNG by default)
 * @returns the image as a data URL
 * @throws {@link NOT_SHOWING} when the tab is not the one showing, before or during the capture; or the browser's error
 */
export async function captureOwnTab(tabId: number, opts: { format: "png" | "jpeg"; quality?: number } = { format: "png" }): Promise<string> {
    const before = await chrome.tabs.get(tabId);
    if (!before.active) throw new Error(NOT_SHOWING);
    let switched = false;
    const onActivated = (info: { tabId: number; windowId: number }): void => { if (info.windowId === before.windowId) switched = true; };
    chrome.tabs.onActivated.addListener(onActivated);
    try {
        let shot: string;
        // A capture that fails while the window shows another tab fails about THAT tab: its error is not the page's to read.
        try { shot = await chrome.tabs.captureVisibleTab(before.windowId, opts); }
        catch (e) {
            const now = switched ? null : await chrome.tabs.get(tabId).catch(() => null);
            if (switched || !now?.active || now.windowId !== before.windowId) throw new Error(NOT_SHOWING);
            throw e;
        }
        const after = await chrome.tabs.get(tabId).catch(() => null);
        if (switched || !after?.active || after.windowId !== before.windowId) throw new Error(NOT_SHOWING);
        return shot;
    } finally {
        chrome.tabs.onActivated.removeListener(onActivated);
    }
}
