// sw-open-chat.ts — open the chat page, or focus it where it is already open, at a view an extension surface names:
// the popup's two buttons and a `window-ml:` link on the HUD card (OPEN_CHAT_PAGE, docs/spec/LINKS.md).

import { parseAddress } from "../link-address";

/**
 * The chat page's hash for an address an extension surface asked to open: `""` for none (the page as it opens), the
 * address as a hash where it is one a link resolves (`parseAddress`), or null to refuse. The URL is always ours,
 * `chat.html` and this hash: nothing the sender sends becomes a URL.
 * @param address what follows `window-ml:`, or absent for the page itself
 */
export function chatHashFor(address: unknown): string | null {
    if (address === undefined || address === "") return "";
    if (typeof address !== "string" || !parseAddress(address)) return null;
    return `#/${address}`;
}

/**
 * Open the chat page in a tab of its own, or focus it where it is already open, at `hash`. Focused rather than opened
 * twice: it is one view of this browser's sessions, and two of them would each hold their own port and scroll position.
 * @param hash from `chatHashFor`
 */
export async function openChatPage(hash: string): Promise<void> {
    const url = chrome.runtime.getURL("chat.html");
    // This extension's own open tabs, by their document URL: an open chat puts its route in the hash (`chat.html#/…`),
    // and `chrome.tabs.query({ url })` matched only the bare URL, so it missed that page and opened a second one (a URL
    // pattern did not match it either).
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
    const open = contexts.find((c) => c.tabId >= 0 && (c.documentUrl ?? "").split("#")[0] === url);
    if (!open) { await chrome.tabs.create({ url: url + hash }); return; }
    // A hash-only change: the page reads it on `hashchange`, so it is not reloaded.
    await chrome.tabs.update(open.tabId, { active: true, ...(hash ? { url: url + hash } : {}) });
    // In another window, the tab is only active THERE; bring that window forward too.
    if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
}
