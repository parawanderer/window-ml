// sw-presence.ts — which pages get window.ml's main-world scripts: registering them for the visible origins only.
//
// docs/spec/SITE_PRESENCE.md, step 2. A page sees window.ml only when its origin may use it (`visibleOrigins`); every
// other page is HIDDEN and gets nothing of ours in its main world until the person starts a run there, when the worker
// injects the same two files into that one document (`injectPageScripts`). The scripts are registered, never named in
// the manifest, so the list follows the person's grants: re-synced when the worker starts and whenever the site lists
// change. A session grant's scripts are registered for the session only, so a browser restart forgets them with it.

import { visibleOrigins, originMatchPattern, originOf, levelsFor } from "../site-access";
import { readSiteLists } from "./sw-site-access";

/** The main-world files, in order: the closed-root capture first, so it records roots before window.ml claims its reader. */
export const PAGE_SCRIPT_FILES = ["shadow-patch.js", "injected.js"];   // state: fixed

/** The registration ids: one for grants that last, one for the session's. */
const REGISTRATION = { lasting: "ml-main-lasting", session: "ml-main-session" } as const;   // state: fixed

let syncing: Promise<void> = Promise.resolve();   // state: plumbing

/**
 * Register the main-world scripts for exactly the visible origins, replacing what was registered. Runs one at a time,
 * and a caller that awaits it knows the next navigation uses the new list (measured: an awaited update applies to the
 * next navigation, an unawaited one may not).
 * @returns once the registrations match the lists
 */
export function syncPresence(): Promise<void> {
    syncing = syncing.catch(() => undefined).then(async () => {
        if (typeof chrome === "undefined" || !chrome.scripting?.registerContentScripts) return;
        const v = visibleOrigins(await readSiteLists());
        const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
        for (const scope of ["lasting", "session"] as const) {
            const id = REGISTRATION[scope];
            const matches = [...new Set(v[scope].map(originMatchPattern).filter((m): m is string => !!m))];
            if (have.has(id)) await chrome.scripting.unregisterContentScripts({ ids: [id] });
            if (!matches.length) continue;
            await chrome.scripting.registerContentScripts([{
                id, matches, js: PAGE_SCRIPT_FILES, world: "MAIN", runAt: "document_start", allFrames: false,
                persistAcrossSessions: scope === "lasting",
            }]);
        }
        await showInOpenTabs([...v.lasting, ...v.session]);
    });
    return syncing;
}

/**
 * A registration applies from the next navigation, so a page already open on an origin just allowed would wait for a
 * reload. Each such tab whose page script is not there gets it now, and then its gate opened: one told it was hidden,
 * and one that loaded while this sync ran (told it is visible, before the registration covered it, so no page script
 * said hello). Asked of the content script, which only the worker reaches: no state of ours to lose on eviction.
 * @param origins the visible origins
 * @returns once every such tab has been seen to
 */
async function showInOpenTabs(origins: string[]): Promise<void> {
    if (!origins.length || !chrome.tabs?.query) return;
    const patterns = origins.map(originMatchPattern).filter((m): m is string => !!m);
    const tabs = await chrome.tabs.query({ url: patterns }).catch(() => [] as chrome.tabs.Tab[]);
    await Promise.all(tabs.map(async (tab) => {
        if (tab.id == null || !origins.includes(originOf(tab.url) ?? "")) return;
        try {
            const r = await chrome.tabs.sendMessage(tab.id, { type: "PRESENCE_CHECK" }, { frameId: 0 }) as { gate?: string; alive?: boolean } | undefined;
            if (!(r?.gate === "closed" || (r?.gate === "open" && r.alive === false))) return;
            await injectPageScripts(tab.id);
            await chrome.tabs.sendMessage(tab.id, { type: "PRESENCE_OPEN" }, { frameId: 0 });
        } catch { /* no content script there (a reload will bring the registered scripts) */ }
    }));
}

/**
 * Whether an origin's pages get the main-world scripts on their own (registered), as the lists say now.
 * @param url the page's URL
 * @returns true for a visible origin
 */
export async function isVisible(url: string | undefined): Promise<boolean> {
    const origin = originOf(url);
    if (!origin) return false;
    const use = levelsFor(await readSiteLists(), origin).use;
    return use === "always" || use === "session";
}

/**
 * Put the main-world scripts into the document a tab shows now, for a run the person started on a hidden page. The page
 * has been running its own code, so it can watch this happen: from here on it sees what a page with window.ml sees.
 * A closed shadow root the page attached before this is not captured.
 * @param tabId the tab
 * @param documentId the document to put them in, when known, so a tab that navigated meanwhile is not given them
 * @returns once both files have run in the top frame
 * @throws when the extension may not script the tab or the document is gone
 */
export async function injectPageScripts(tabId: number, documentId?: string): Promise<void> {
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId };
    await chrome.scripting.executeScript({ target, world: "MAIN", files: PAGE_SCRIPT_FILES });
}
