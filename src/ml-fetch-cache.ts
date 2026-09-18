// ml-fetch-cache.ts — the page's ONE cache of successful `ml.fetch` results, and its memory budget.
//
// Its own module because two readers need it and they must not import each other: `ml.fetch`/`_fetchCached`
// in injected.ts write and read it, and `_loadTable` in ml-python.ts reads it to answer a `tables:` source
// that names a URL the run already fetched. Holding it in either of those files makes the other import that
// file, and the two import each other back.

import { makeBackgroundTaskPromise } from "./bridge";
import { FetchCache, estimateFetchResultBytes } from "./fetch-cache";

/** The page fetch cache's estimated memory budget. Enough for the table a step just fetched plus a few smaller
 *  bodies; far below what an unbounded session used to accumulate in the user's tab. */
const FETCH_CACHE_BUDGET_BYTES = 64_000_000;

// Results of successful `ml.fetch(url)` calls, keyed by URL. Populated when a fetch resolves (the fetch
// itself was already approved/consented to reach the background), so a follow-up READONLY `exec` that
// re-reads the same URL gets the cached result with NO approval — the `_fetchCached` reader the read-only
// dialect's `ml.fetch` is bound to. The python_exec+Google-Sheet parallel: approve the source ONCE, then
// operate on it freely. Page-scoped (module lifetime); holds only public, uncredentialed, non-rendered bytes
// (a credentialed / rendered fetch is authenticated or session-bound → NEVER cached).
// BUDGETED (fetch-cache.ts): it was a bare Map that kept every fetched body — and every parsed CSV's rows —
// in the user's tab for the life of the page. The most recent fetch is always kept, since the next step
// reading it is the handoff this cache exists for; evicted URLs are remembered so a miss can say so.
// Each budget eviction goes to the housekeeping log (docs/dev/housekeeping.md), reported from here because the
// cache lives in the page: the worker stamps it page-origin, and only this tab reads its key (the URL) back.
export const mlFetchCache = new FetchCache<import("./contract").FetchResult>(FETCH_CACHE_BUDGET_BYTES, estimateFetchResultBytes, undefined, (key, bytes) => {
    makeBackgroundTaskPromise("HOUSEKEEPING_REPORT_REQUEST", "HOUSEKEEPING_REPORT_RESPONSE", { subsystem: "fetch-cache", kind: "evict", reason: "budget", key, bytes, detail: { budgetBytes: FETCH_CACHE_BUDGET_BYTES } }).catch(() => { /* a log, never worth a failure */ });
});
