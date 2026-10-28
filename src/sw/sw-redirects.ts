// sw-redirects.ts — a worker fetch that follows a redirect only to a hop it judged, reading each hop's target through webRequest.
//
// docs/spec/SITE_PRESENCE.md, "Redirects on auto-approved fetches". A worker `fetch` with `redirect: "manual"` answers an
// opaque response with no `Location`; `webRequest.onHeadersReceived` with `extraHeaders` reports the worker's own request
// (tabId -1, the extension as its initiator) with its status and `Location`, before `fetch` resolves (measured on Chromium
// 151, 50 of 50). So the worker fetches each hop with `manual`, reads the hop's target from that event, judges it, and
// requests the target itself only when the judge says so. Events carry no handle on the `fetch` that caused them, so a hop
// is matched to its fetch by URL, and two fetches of one URL run one at a time. A hop whose target cannot be read is
// refused, never followed.

import { getDomain } from "tldts";

/** One redirect hop: the URL that answered 3xx, and where it pointed (`null` when the target could not be read). */
export interface Hop { from: string; to: string | null }

/** Whether a fetch may follow a hop; a refused hop's target is never requested. */
export type HopJudge = (hop: { from: string; to: string }) => boolean;

/** A fetch stopped at a hop its judge refused, or whose target could not be read. */
export class RedirectRefused extends Error {
    constructor(readonly hop: Hop) {
        super(hop.to ? `redirect to ${hop.to} refused` : "redirect with an unreadable target refused");
        this.name = "RedirectRefused";
    }
}

/** The most hops one fetch follows, as Chrome's own follow stops at 20. */
export const MAX_HOPS = 20;

/** The registrable domain (eTLD+1, private suffixes included), or the host when it has none (an IP, `localhost`). */
function siteOf(u: URL): string {
    return getDomain(u.hostname, { allowPrivateDomains: true }) ?? u.hostname;
}

/**
 * Whether a hop needs no approval: it stays on the same registrable domain, or upgrades http to https on the same host.
 * @param from the URL that redirected
 * @param to its target
 * @returns true for a hop any judge follows
 */
export function hopIsOwn(from: string, to: string): boolean {
    let a: URL, b: URL;
    try { a = new URL(from); b = new URL(to); } catch { return false; }
    if (b.protocol !== "http:" && b.protocol !== "https:") return false;
    if (a.protocol === "http:" && b.protocol === "https:" && a.hostname === b.hostname) return true;
    // An https page that redirects down to http is not upgraded by this rule; it is judged on its site like any other.
    return siteOf(a) === siteOf(b);
}

/** The key a hop is matched by: the URL as the network sees it, without its fragment. */
function keyOf(url: string): string {
    try { const u = new URL(url); u.hash = ""; return u.href; } catch { return url; }
}

/** The target each in-flight manual fetch's 3xx named, by URL; `undefined` until the headers event arrives. */
const awaiting = new Map<string, { location?: string | null }>();   // state: plumbing
/** The fetch of each URL that is in flight, so a second fetch of it waits rather than sharing its headers event. */
const busy = new Map<string, Promise<unknown>>();   // state: plumbing
let watching = false;   // state: plumbing

/** Read a 3xx's target for a fetch this module is waiting on: only the worker's own requests (no tab, our initiator). */
function onHeaders(d: chrome.webRequest.OnHeadersReceivedDetails): undefined {
    if (d.tabId !== -1 || d.statusCode < 300 || d.statusCode >= 400) return undefined;
    if (d.initiator && d.initiator !== new URL(chrome.runtime.getURL("")).origin) return undefined;
    const slot = awaiting.get(keyOf(d.url));
    if (!slot) return undefined;
    const locs = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === "location");
    // Two Location headers, or a second 3xx for the same URL while one is waiting, is ambiguous: refuse rather than guess.
    slot.location = slot.location === undefined && locs.length === 1 && locs[0].value ? new URL(locs[0].value, d.url).href : null;
    return undefined;
}

/** Register the headers listener, once, at the worker's top level (an MV3 listener added later misses a cold start). */
export function watchRedirects(): void {
    if (watching || !globalThis.chrome?.webRequest?.onHeadersReceived) return;
    watching = true;
    chrome.webRequest.onHeadersReceived.addListener(onHeaders, { urls: ["<all_urls>"], tabId: -1 }, ["responseHeaders", "extraHeaders"]);
}

/** One `manual` fetch of `url`, after any other fetch of the same URL has finished; a 3xx answers its target too. */
async function hopOnce(url: string, init: RequestInit): Promise<{ res: Response; next?: string | null }> {
    const key = keyOf(url);
    while (busy.has(key)) await busy.get(key)!.catch(() => undefined);
    const slot: { location?: string | null } = {};
    const run = (async () => {
        awaiting.set(key, slot);
        try {
            const res = await fetch(url, { ...init, redirect: "manual" });
            return res.type === "opaqueredirect" ? { res, next: slot.location ?? null } : { res };
        } finally { awaiting.delete(key); }
    })();
    busy.set(key, run);
    try { return await run; } finally { if (busy.get(key) === run) busy.delete(key); }
}

/**
 * GET `url`, following each redirect hop only when `judge` allows it: a refused hop's target is never requested.
 * @param url the first URL
 * @param init the request's options (`redirect` is replaced)
 * @param judge whether to follow a hop
 * @returns the last response, with `redirected` set when a hop was followed
 * @throws RedirectRefused at a refused hop or one whose target could not be read; an Error past {@link MAX_HOPS}
 */
export async function judgedFetch(url: string, init: RequestInit, judge: HopJudge): Promise<Response> {
    let at = url;
    for (let hops = 0; hops <= MAX_HOPS; hops++) {
        const { res, next } = await hopOnce(at, init);
        if (res.type !== "opaqueredirect") {
            // A fetch that followed on its own (a stub, a browser that ignores `manual`) is held to the same rule after the
            // fact: the request went, but nothing of its answer is used.
            const landed = res.url || at;
            if (keyOf(landed) !== keyOf(at) && !judge({ from: at, to: landed })) { void res.body?.cancel().catch(() => {}); throw new RedirectRefused({ from: at, to: landed }); }
            if (hops > 0) Object.defineProperty(res, "redirected", { value: true });
            return res;
        }
        if (!next) throw new RedirectRefused({ from: at, to: null });
        if (!judge({ from: at, to: next })) throw new RedirectRefused({ from: at, to: next });
        at = next;
    }
    throw new Error("too many redirects");
}
