// sw-access-requests.ts — the worker's store of sites asking for access (`ml.requestAccess`): storage, expiry, answers.
//
// docs/spec/SITE_ACCESS_SLICE3.md PR 4. The rules are site-requests.ts's; this module keeps the store in
// `chrome.storage.local` (a request outlives the worker and the browser: it waits up to 7 days), runs every change one at
// a time, and tells the badge when what is waiting changes. Nothing here opens a window or takes focus (rule 5).

import { getDomain } from "tldts";
import { askAccess, answerRequest, expire, pendingRequests, readStore, settleByLists, type AskInput, type RequestDecision, type RequestStore, type WaitingRequest } from "../site-requests";
import { type AccessAnswer } from "../contract/contract-config";
import { changesSiteAccess, levelsFor, type SiteLists } from "../site-access";
import { editSiteAccess, readSiteLists } from "./sw-site-access";
import { defineState } from "../state-registry";

/** The local key holding the request store. */
export const REQUESTS_KEY = "ml_site_requests";   // state: declared below (site.requests)

let queue: Promise<unknown> = Promise.resolve();   // state: plumbing
const listeners: (() => void)[] = [];   // state: plumbing

/** Run one change after the last, so two asks never both read the store before either wrote it. */
function serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
}

/**
 * The registrable domain (eTLD+1) the caps count by, from the Public Suffix List with its private part, so every
 * `*.github.io` site is its own (Q10). A host with none (an IP address, `localhost`) counts as itself.
 * @param origin an origin
 * @returns the domain
 */
export function registrableDomain(origin: string): string {
    const host = new URL(origin).hostname;
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** The store as stored, expired and settled against the lists; written back when that changed anything. */
async function load(lists: SiteLists): Promise<RequestStore> {
    const raw = (await chrome.storage.local.get(REQUESTS_KEY).catch(() => ({} as Record<string, unknown>)))[REQUESTS_KEY];
    const e = expire(readStore(raw), Date.now());
    const s = settleByLists(e.store, lists);
    if (e.changed || s.changed) await save(s.store);
    return s.store;
}

/** Write the store, and tell whoever draws what is waiting. */
async function save(store: RequestStore): Promise<void> {
    await chrome.storage.local.set({ [REQUESTS_KEY]: store });
    for (const f of listeners) f();
}

/**
 * Call `f` whenever the waiting requests may have changed: a new one, an answer, an expiry, a change to the lists.
 * @param f the listener
 */
export function onRequestsChanged(f: () => void): void { listeners.push(f); }

/**
 * Answer one `ml.requestAccess` call (site-requests.ts `askAccess`), storing the entry it makes.
 * @param input what the page asked for
 * @param facts the asker's origin, and what only the worker and the content script know about it
 * @returns the answer the page reads
 */
export function requestAccess(input: AskInput, facts: { origin: string; gesture: boolean; openedByAgent: boolean; sitesMayAsk: boolean }): Promise<AccessAnswer> {
    return serially(async () => {
        const lists = await readSiteLists();
        const store = await load(lists);
        const r = askAccess(store, lists, input, { ...facts, domain: registrableDomain(facts.origin), now: Date.now() });
        if (r.store !== store) await save(r.store);
        return r.answer;
    });
}

/** The waiting entries, each with whether its origin may already use window.ml. */
function waiting(store: RequestStore, lists: SiteLists): WaitingRequest[] {
    return pendingRequests(store, Date.now()).map((e) => {
        const use = levelsFor(lists, e.origin).use;
        return { ...e, allowed: use === "always" || use === "session" };
    });
}

/**
 * Apply the person's answer to a waiting request: the list edits it makes, then the entry marked answered.
 * @param origin the entry's origin
 * @param decision what the person chose
 * @returns the requests still waiting
 */
export function decideRequest(origin: string, decision: RequestDecision): Promise<WaitingRequest[]> {
    return serially(async () => {
        const lists = await readSiteLists();
        const r = answerRequest(await load(lists), lists, origin, decision, Date.now());
        for (const edit of r.edits) await editSiteAccess(edit);
        await save(r.store);
        return waiting(r.store, await readSiteLists());
    });
}

/**
 * The requests waiting for the person, oldest first.
 * @returns them
 */
export function waitingRequests(): Promise<WaitingRequest[]> {
    return serially(async () => { const lists = await readSiteLists(); return waiting(await load(lists), lists); });
}

// A change to the lists from anywhere (the popup's "This site", Settings, another window) may settle a request.
chrome.storage?.onChanged?.addListener((changes, area) => {
    if (changesSiteAccess(changes, area)) void waitingRequests().then(() => { for (const f of listeners) f(); }, () => undefined);
});

defineState({
    id: "site.requests", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "Sites asking for access (ml.requestAccess): one entry per origin and kind, waiting up to 7 days.",
    read: async () => { const l = await waitingRequests().catch(() => []); return l.length ? l.map((e) => ({ origin: e.origin, kind: e.kind, agents: e.agents, at: e.at })) : undefined; },
});
