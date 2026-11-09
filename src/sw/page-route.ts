// page-route.ts — whether a person's message to a run or chat a PAGE built may be handed to the page its tab shows now.

// A page-built run or chat lives in its page, and the only way the worker hands it the person's message is to the
// document the tab shows NOW. That page may be another site's: the run navigated off its builder, or the hash came in
// with another tab's id, or the worker was evicted and no longer knows which tab or site built it. The one fact that
// decides it is who built the session, so it is recorded when the session starts, from what the browser stamped on
// the message (`sender.tab`, never the payload), and kept in storage.session so an eviction does not lose it.
//
// `pageRouteFor` is the one decision both channels ask (the tab's USER_RUN_ACTION and the panel's ML_SESSION_REMOTE,
// through `userRunAction`): the page frames the message only on the tab that built the session, on the site that built
// it, while that site may use window.ml. Anything else is not the page's: the worker drives the run if it holds it,
// and otherwise the message is refused with PAGE_GONE. No record is a mismatch.

import { defineState } from "../state-registry";
import { originOf } from "../site-access";
import { siteDecision } from "./sw-site-access";

/** The storage.session key holding every page-built session's builder, by hash. */
export const PAGE_BUILT_KEY = "ml_pagebuilt";
/** How many builders are kept; past it the oldest go first, and their sessions then take the worker's route or none. */
export const PAGE_BUILT_CAP = 500;

/** Who built a page-built session: its tab and that tab's top-frame origin, as the browser stamped the first message. */
export interface PageBuilder { tabId: number; origin: string; kind: "run" | "chat"; ts: number }

/** The sentence for a person's message that no page may frame and the worker does not hold. Names no site. */
export const PAGE_GONE = "The page that started this conversation is no longer open in this tab, so this message was not sent.";

/** A person's message refused because no page may frame it and the worker does not hold the run (PAGE_GONE). */
export class PageGone extends Error {
    constructor() { super(PAGE_GONE); this.name = "PageGone"; }
}

defineState({
    id: "run.builder", scope: "run", realm: "worker", audience: "human", lostOn: ["browser-restart"], heldOnly: true,
    describe: "The tab and site that built this page-built run or chat; the person's messages reach a page only there.",
    read: async ({ runId }) => (runId ? (await readAll())[runId] : undefined),
});

// Every write is a read-modify-write of one key, so the writes go one after another or two at once lose one.
let queue: Promise<unknown> = Promise.resolve();   // state: plumbing — orders this worker's writes to PAGE_BUILT_KEY

async function readAll(): Promise<Record<string, PageBuilder>> {
    try {
        const got = (await chrome.storage.session.get(PAGE_BUILT_KEY))[PAGE_BUILT_KEY];
        return got && typeof got === "object" ? got as Record<string, PageBuilder> : {};
    } catch { return {}; }
}

function edit(change: (all: Record<string, PageBuilder>) => boolean): Promise<void> {
    const next = queue.then(async () => {
        const all = await readAll();
        if (change(all)) await chrome.storage.session.set({ [PAGE_BUILT_KEY]: all });
    }).catch(() => { /* no session storage: nothing is recorded, so nothing is relayed */ });
    queue = next;
    return next;
}

/**
 * Record who built `hash`, once: the first stamp wins, so a later message (another tab's, a page the tab moved to)
 * cannot repoint it.
 * @param hash the run or chat
 * @param tabId the tab the browser says sent its first message
 * @param url that tab's URL, as the browser stamped it; a session from a non-http(s) page is not recorded
 * @param kind a run (START_RUN) or a chat (its first session event)
 */
export function notePageBuilt(hash: string, tabId: number | undefined, url: string | undefined, kind: PageBuilder["kind"]): Promise<void> {
    const origin = originOf(url);
    if (!hash || tabId == null || !origin) return Promise.resolve();
    return edit((all) => {
        if (all[hash]) return false;
        all[hash] = { tabId, origin, kind, ts: Date.now() };
        const keys = Object.keys(all);
        if (keys.length > PAGE_BUILT_CAP) for (const k of keys.sort((a, b) => all[a].ts - all[b].ts).slice(0, keys.length - PAGE_BUILT_CAP)) delete all[k];
        return true;
    });
}

/** Forget every session a closed tab built: its pages are gone, so no message to them may go to a page. */
export function forgetPageBuiltTab(tabId: number): Promise<void> {
    return edit((all) => {
        let changed = false;
        for (const [k, b] of Object.entries(all)) if (b.tabId === tabId) { delete all[k]; changed = true; }
        return changed;
    });
}

/** A tab Chrome handed a new id (a discard restored): its sessions' builder is the same tab under the new id. */
export function movePageBuiltTab(from: number, to: number): Promise<void> {
    return edit((all) => {
        let changed = false;
        for (const b of Object.values(all)) if (b.tabId === from) { b.tabId = to; changed = true; }
        return changed;
    });
}

/** Forget one session's builder, when the session is released. */
export function forgetPageBuilt(hash: string): Promise<void> {
    return edit((all) => (hash in all ? (delete all[hash], true) : false));
}

/** Who built `hash`, if a page did and it is still recorded. */
export async function pageBuilder(hash: string): Promise<PageBuilder | undefined> {
    await queue;
    return (await readAll())[hash];
}

/**
 * Whether the person's message to `hash`, sent for tab `tabId`, may be handed to the page that tab shows now: only
 * when that tab built the session, it still shows the builder's site, and that site may use window.ml.
 * @param hash the run or chat
 * @param tabId the tab the message would be relayed to
 * @param tabUrl that tab's URL now, as the browser reports it
 * @returns "page" to relay it, "off" when no page may have it
 */
export async function pageRouteFor(hash: string, tabId: number, tabUrl: string | undefined): Promise<"page" | "off"> {
    const built = await pageBuilder(hash);
    const here = originOf(tabUrl);
    if (!built || !here || built.tabId !== tabId || built.origin !== here) return "off";
    const decision = await siteDecision(here);
    return decision === "always" || decision === "session" ? "page" : "off";
}
