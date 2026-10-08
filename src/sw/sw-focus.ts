// sw-focus.ts — WHERE THE USER IS, read from the browser for `chat_metadata`: the focused window, if any, and its
// active tab. The rules about what a run may be told are `userFocusLine` (user-focus.ts); this only reads.

import { userFocusLine, type FocusDetail, type FocusSnapshot } from "./user-focus";
import { getConfig } from "./sw-llm";

/** The browser's focus right now. Never rejects: a browser that will not say is "nothing to report". */
export async function readFocus(): Promise<FocusSnapshot | null> {
    try {
        const w = await chrome.windows.getLastFocused({ populate: true });
        const at = Date.now();
        // `getLastFocused` answers with the last focused window even when another APPLICATION has focus; `focused`
        // is what says whether the user is in the browser at all.
        if (!w?.focused) return { browserFocused: false, at };
        const t = w.tabs?.find((x) => x.active);
        return {
            browserFocused: true,
            at,
            ...(t?.id != null ? { tab: { tabId: t.id, url: t.url || t.pendingUrl || "", title: t.title || "", incognito: !!w.incognito } } : {}),
        };
    } catch { return null; }
}

/**
 * The `user focus` line for a run, or null: nothing to say (the user is on the agent's tab), the setting is off, or
 * the browser would not answer. `agentTabId` is null for a run with no tab.
 */
export async function focusLineFor(runHash: string, agentTabId: number | null, detail: FocusDetail): Promise<string | null> {
    const cfg = await getConfig().catch(() => null);
    if (cfg && cfg.agentSeesFocus === false) return null;
    return userFocusLine(await readFocus(), { agentTabId, runHash, detail, chatPageUrl: chrome.runtime.getURL("chat.html") });
}
