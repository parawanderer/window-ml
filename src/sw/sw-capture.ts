// sw-capture.ts — a screenshot of the tab that asked for it, never of another tab that happens to be showing.

/** Why a tab that is not showing gets no screenshot: without the debugger, the browser shoots whatever its window shows. */
export const NOT_SHOWING = "Can't screenshot this tab: it isn't the one showing in its window, and without the debugger a screenshot is of whatever tab is showing. Switch to it, or turn on \"Debugger-based actions and user scripts\" in window.ml Settings → Advanced.";

/**
 * `captureVisibleTab` for one tab. It takes a WINDOW and shoots the tab that window shows, so it is taken only while
 * `tabId` is that tab, and thrown away if the window showed another tab at any point while it was taken.
 * @param tabId the tab the screenshot is for (the sender's own)
 * @returns the PNG as a data URL
 * @throws {@link NOT_SHOWING} when the tab is not the one showing, before or during the capture; or the browser's error
 */
export async function captureOwnTab(tabId: number): Promise<string> {
    const before = await chrome.tabs.get(tabId);
    if (!before.active) throw new Error(NOT_SHOWING);
    let switched = false;
    const onActivated = (info: { tabId: number; windowId: number }): void => { if (info.windowId === before.windowId) switched = true; };
    chrome.tabs.onActivated.addListener(onActivated);
    try {
        const shot = await chrome.tabs.captureVisibleTab(before.windowId, { format: "png" });
        const after = await chrome.tabs.get(tabId).catch(() => null);
        if (switched || !after?.active || after.windowId !== before.windowId) throw new Error(NOT_SHOWING);
        return shot;
    } finally {
        chrome.tabs.onActivated.removeListener(onActivated);
    }
}
