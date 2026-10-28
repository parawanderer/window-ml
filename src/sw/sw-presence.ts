// sw-presence.ts — which pages get window.ml's main-world scripts: registering them for the visible origins only.
//
// docs/spec/SITE_PRESENCE.md, step 2. A page sees window.ml only when its origin may use it (`visibleOrigins`); every
// other page is HIDDEN and gets nothing of ours in its main world until the person starts a run there, when the worker
// injects the same two files into that one document (`injectPageScripts`). The scripts are registered, never named in
// the manifest, so the list follows the person's grants: re-synced when the worker starts and whenever the site lists
// change. A session grant's scripts are registered for the session only, so a browser restart forgets them with it.
//
// Between the two is the STUB (`ASK_SCRIPT_FILES`): a page whose origin the person marked visible, or any page when
// "Let sites ask for access" is on, gets a `window.ml` that can only call `requestAccess()`. Allowed and denied origins
// are left out of its registration, so an allowed page gets the full API alone and a denied one nothing.

import { visibleOrigins, askOrigins, presenceOf, originMatchPattern, originOf, type Presence } from "../site-access";
import { readSiteLists } from "./sw-site-access";

/** The main-world files, in order: the closed-root capture first, so it records roots before window.ml claims its reader. */
export const PAGE_SCRIPT_FILES = ["shadow-patch.js", "injected.js"];   // state: fixed

/** The stub's main-world file: `window.ml` with `requestAccess` and nothing else. */
export const ASK_SCRIPT_FILES = ["ask.js"];   // state: fixed

/** The registration ids: one for grants that last, one for the session's, one for the stub. */
const REGISTRATION = { lasting: "ml-main-lasting", session: "ml-main-session", ask: "ml-main-ask" } as const;   // state: fixed

/** Every http(s) page, for the stub when every site may ask. */
const EVERY_SITE = ["http://*/*", "https://*/*"];   // state: fixed

/** The sync config key of "Let sites ask for access" (`MlConfig.siteRequests`). */
export const SITE_REQUESTS_KEY = "siteRequests";   // state: fixed

/**
 * The "Let sites ask for access" setting, read from storage on every call (no copy to go stale on eviction).
 * @returns true when every site that may not use window.ml yet may ask
 */
export async function sitesMayAsk(): Promise<boolean> {
    if (typeof chrome === "undefined" || !chrome.storage?.sync) return false;
    const v = await chrome.storage.sync.get(SITE_REQUESTS_KEY).catch(() => ({} as Record<string, unknown>));
    return v[SITE_REQUESTS_KEY] === true;
}

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
        const registered = await chrome.scripting.getRegisteredContentScripts();
        const have = new Set(registered.map((s) => s.id));
        // What the stub covered until now: Chrome keeps the registration across worker evictions and browser restarts, so
        // it is the record of which open pages may hold the stub, and only those are told when their origin is hidden.
        const before = registered.find((s) => s.id === REGISTRATION.ask);
        const askedBefore = (origin: string): boolean => {
            const m = originMatchPattern(origin);
            return !!before && !!m && (before.matches ?? []).some((x) => x === m || EVERY_SITE.includes(x)) && !(before.excludeMatches ?? []).includes(m);
        };
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
        const lists = await readSiteLists();
        const everySite = await sitesMayAsk();
        const marked = askOrigins(lists);
        if (have.has(REGISTRATION.ask)) await chrome.scripting.unregisterContentScripts({ ids: [REGISTRATION.ask] });
        if (everySite || marked.length) {
            // Every pattern of an origin that gets the full API or nothing is excluded, so the stub never lands beside
            // injected.js and never on a denied site. Exclusions are by exact origin, as the full registration's matches are.
            const excluded = [...v.lasting, ...v.session, ...lists.denied].map(originMatchPattern).filter((m): m is string => !!m);
            await chrome.scripting.registerContentScripts([{
                id: REGISTRATION.ask, matches: everySite ? EVERY_SITE : marked.map(originMatchPattern).filter((m): m is string => !!m),
                ...(excluded.length ? { excludeMatches: [...new Set(excluded)] } : {}),
                js: ASK_SCRIPT_FILES, world: "MAIN", runAt: "document_start", allFrames: false, persistAcrossSessions: true,
            }]);
        }
        await showInOpenTabs((origin) => presenceOf(lists, origin, everySite), askedBefore);
    });
    return syncing;
}

/**
 * A registration applies from the next navigation, so a page already open would wait for a reload. Each open tab is
 * brought to what its origin's presence is now. One that should have the full API and has no page script gets it, and
 * its gate opened: one told it was hidden, one showing the stub (a site the person just allowed from its own request,
 * whose next call should work with no reload), and one that loaded while this sync ran. One that should ask gets the
 * stub and `PRESENCE_ASK`. One that is hidden now, on an origin the stub covered until now, is told `PRESENCE_HIDE`, so a
 * stub it loaded with is heard no more; every other hidden page hears nothing.
 * Each step names the document whose origin was read, so a tab that navigated meanwhile is given nothing. Asked of the
 * content script, which only the worker reaches: no state of ours to lose on eviction.
 * @param presenceNow an origin's presence, as the lists and the setting say now
 * @param askedBefore whether the stub's registration covered an origin before this sync
 * @returns once every tab has been seen to
 */
async function showInOpenTabs(presenceNow: (origin: string) => Presence, askedBefore: (origin: string) => boolean): Promise<void> {
    if (!chrome.tabs?.query) return;
    const tabs = await chrome.tabs.query({ url: EVERY_SITE }).catch(() => [] as chrome.tabs.Tab[]);
    await Promise.all(tabs.map(async (tab) => {
        const listed = originOf(tab.url);
        if (tab.id == null || !listed) return;
        // A hidden tab is told only when the stub covered its origin until now: every other hidden page hears nothing.
        if (presenceNow(listed) === "hidden" && !askedBefore(listed)) return;
        const tabId = tab.id;
        try {
            const frame = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { documentId?: string; url?: string } | null;
            const documentId = frame?.documentId;
            const origin = originOf(frame?.url ?? tab.url);
            if (!origin) return;
            const shown = presenceNow(origin);
            const to = documentId ? { documentId } : { frameId: 0 };
            if (shown === "hidden") {
                if (askedBefore(origin)) await chrome.tabs.sendMessage(tabId, { type: "PRESENCE_HIDE" }, to).catch(() => undefined);
                return;
            }
            // The stub and the full API go only into the document whose origin was read: without its id, nothing is put in.
            if (!documentId) return;
            const r = await chrome.tabs.sendMessage(tabId, { type: "PRESENCE_CHECK" }, to) as { gate?: string; alive?: boolean; ask?: boolean } | undefined;
            if (shown === "full") {
                if (!(r?.gate === "closed" || (r?.gate === "open" && r.alive === false))) return;
                await injectPageScripts(tabId, documentId);
                await chrome.tabs.sendMessage(tabId, { type: "PRESENCE_OPEN" }, to);
            } else if (r?.gate === "closed" && r.ask !== true) {
                await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId!] }, world: "MAIN", files: ASK_SCRIPT_FILES });
                await chrome.tabs.sendMessage(tabId, { type: "PRESENCE_ASK" }, to);
            }
        } catch { /* no content script there, or the document is gone (a reload will bring the registered scripts) */ }
    }));
}

/**
 * Whether an origin's pages get the main-world scripts on their own (registered), as the lists say now.
 * @param url the page's URL
 * @returns true for a visible origin
 */
export async function isVisible(url: string | undefined): Promise<boolean> {
    return (await presence(url)) === "full";
}

/**
 * What a page at this URL gets of window.ml, as the lists and the "Let sites ask" setting say now.
 * @param url the page's URL
 * @returns the presence; anything that is not an http(s) page is hidden
 */
export async function presence(url: string | undefined): Promise<Presence> {
    const origin = originOf(url);
    if (!origin) return "hidden";
    return presenceOf(await readSiteLists(), origin, await sitesMayAsk());
}

/** The documents `injectPageScripts` has put the page scripts into, oldest first, so none is given them twice. Lost with
 *  the worker; a document that outlives it is asked about again only by a list change (showInOpenTabs). */
const injectedDocs = new Set<string>();   // state: plumbing
const INJECTED_DOCS_MAX = 512;   // state: fixed

/**
 * Put the main-world scripts into the document a tab shows now, for a run the person started on a hidden page. The page
 * has been running its own code, so it can watch this happen: from here on it sees what a page with window.ml sees.
 * A closed shadow root the page attached before this is not captured.
 * @param tabId the tab
 * @param documentId the document to put them in, when known, so a tab that navigated meanwhile is not given them
 * @returns once both files have run in the top frame, or at once for a document that already received them (so a
 *   resolved call means the scripts are there, not that they were injected now)
 * @throws when the extension may not script the tab or the document is gone
 */
export async function injectPageScripts(tabId: number, documentId?: string): Promise<void> {
    // A document is given them once: a second injected.js would replace window.ml and, after the re-arm, take the content
    // script's port from the first, orphaning a run on it (a repeated PAGE_SCRIPT_MISSING, or one racing showInOpenTabs).
    if (documentId) {
        if (injectedDocs.has(documentId)) return;
        injectedDocs.add(documentId);
        if (injectedDocs.size > INJECTED_DOCS_MAX) injectedDocs.delete(injectedDocs.values().next().value as string);
    }
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId };
    // First the content script drops any port the page handed it, so the one it takes next is injected.js's
    // (page-channel.ts). No answer (no content script there yet) is no harm: a fresh one is armed already.
    try {
        await chrome.tabs.sendMessage(tabId, { type: "PAGE_PORT_ARM" }, documentId ? { documentId } : { frameId: 0 }).catch(() => undefined);
        await chrome.scripting.executeScript({ target, world: "MAIN", files: PAGE_SCRIPT_FILES });
    } catch (e) {
        // Only a document that received them stays marked, or a later call would answer for scripts that are not there.
        if (documentId) injectedDocs.delete(documentId);
        throw e;
    }
}
