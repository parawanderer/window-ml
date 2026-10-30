// sw-fetch-url.ts — ml.fetch's one entry in the worker: who may fetch what, then the fetch.

import { isSelfSourceUrl } from "../agent/self-source";
import { BUILD_INFO } from "../build-info.gen";
import { isCurrentPage } from "../dom/dom";
import { senderTrust, takeCredFetch, takeOnceFetch, tabGrants, fetchConsent } from "./sw-consent";
import { fetchRenderedContent, fetchUrlContent } from "./sw-fetch";
import { getConfig } from "./sw-llm";
import type { FetchResult } from "../contract";
import { pageValueSession, activeRuns } from "./sw-runs";
import { judgeCall, fetchFacts } from "./sw-policies";
import { storeFetchedBody, claimValue } from "./sw-values";
import { hopIsOwn, RedirectRefused, type HopJudge } from "./sw-redirects";

/** Who an `ml.fetch` is for: a page through the relay, or a run's tool answered in the worker. */
export interface FetchCaller {
    /** The tab it is for: its consent, its grants, and where a stored table's key is disclosed. */
    tabId?: number;
    /** The URL of the frame it came from, for the same-origin and own-page rules. */
    frameUrl?: string;
    /** The tab's URL, when there is no frame URL. */
    tabUrl?: string;
    /** Not a trusted surface: it needs a grant or a consent for anything but its own origin. */
    untrusted: boolean;
    /** The approvals this caller may use, when they are not the tab's: whether `url` was consented to, and spending a
     *  one-time as-you grant for it. Absent: the tab's (`fetchConsent`, `takeCredFetch`), as for a page. */
    consented?: (url: string) => boolean;
    takeCred?: (url: string) => boolean;
    /** Record a stored table's key as disclosed to the tab (`pageValueSession`), which entitles a page-hosted run there
     *  to read it. False for a run's own fetch in the worker: the key never reaches the page. */
    disclose: boolean;
}

/** Whether the person's policies withdraw the tab's remembered consent for this fetch: an `ask` or a `deny` matches it,
 *  judged over the global policies and those of every run the tab hosts. A store not loaded yet withdraws it too. */
function withdrawn(tabId: number, url: string, rendered: boolean): boolean {
    const facts = fetchFacts(url, { credentials: false, rendered });
    const runs: (string | undefined)[] = [undefined, ...(activeRuns.get(tabId) ?? [])];
    return runs.some((r) => { const d = judgeCall(r, "fetch", facts).decision; return d === "ask" || d === "deny"; });
}

/** A fetch through the page relay, as the router hands it over. */
export async function pageFetchCaller(sender: chrome.runtime.MessageSender): Promise<FetchCaller> {
    return { tabId: sender.tab?.id, frameUrl: sender.url, tabUrl: sender.tab?.url, untrusted: await senderTrust(sender) === "untrusted", disclose: true };
}

/**
 * `ml.fetch(url, opts)`: the consent checks, then the fetch.
 * @param payload `{ url, credentials?, rendered?, format? }` as `FETCH_URL` carries it
 * @param caller who it is for
 * @returns the result, or the refusal or failure to show
 */
export async function fetchUrlFor(payload: unknown, caller: FetchCaller): Promise<{ data?: FetchResult; error?: string }> {
    const message = { payload };
    {
        const url = String((message.payload as { url?: unknown; })?.url || "");
        const credentials = !!(message.payload as { credentials?: unknown; })?.credentials;
        const rendered = !!(message.payload as { rendered?: unknown; })?.rendered;
        // Only "html" opts OUT of the Markdown ladder; anything else (absent, junk) takes the default.
        const format = (message.payload as { format?: unknown; })?.format === "html" ? "html" as const : "markdown" as const;
        let scheme = "";
        try { scheme = new URL(url).protocol; } catch { return { error: `Refused: "${url}" is not a valid URL.` }; }
        if (scheme !== "http:" && scheme !== "https:") {
            // A local file is refused because it could be ANY file on the machine — and Chrome's fetch has no
            // file scheme anyway. The one file:// read that works is a session render of the page the call
            // came from, answered page-side from its live DOM and never reaching here. So a file: URL here is
            // either another file, or this page in a mode that would need its BYTES; the refusal says which,
            // and names the mode that works, so the model does not retry the same thing.
            const from = caller.frameUrl ?? caller.tabUrl ?? ""; // the frame's URL, else its tab's
            const own = from.startsWith("file:") && isCurrentPage(url, from);
            return {
                error: scheme !== "file:"
                    ? `Refused: ml.fetch supports only http(s) URLs (got "${scheme}").`
                    : own
                        ? `Refused: "${url}" is the page you are on, but a local file's bytes cannot be fetched. Use rendered: true with credentials: true to get its live DOM.`
                        : `Refused: ml.fetch cannot read local files ("${url}"). The only one it reads is the page you are on${from.startsWith("file:") ? ` (${from.replace(/#.*$/, "")})` : ""}, with rendered: true and credentials: true.`
            };
        }
        const tabId = caller.tabId;
        const untrusted = caller.untrusted;
        // SAME-ORIGIN as the sender's page: a free read (the page can already `fetch()` its own origin, and
        // navigate there is free) — applies to a plain GET AND a rendered load. Used by the gate below AND
        // the render dispatch (a same-origin render uses the SESSION tab, not incognito — no leak, you're
        // already signed in there).
        const sameOriginAsSender = (() => { try { return !!caller.frameUrl && new URL(url, caller.frameUrl).origin === new URL(caller.frameUrl).origin; } catch { return false; } })();
        const cfg = await getConfig(); // the self-source setting + the cdp render setting





        // CREDENTIALED (fetch-as-the-user — a raw GET with cookies, OR a rendered load in a NORMAL tab that
        // carries the session) → a "read any URL as you" primitive, so an untrusted page needs a ONE-TIME
        // per-URL grant (minted by an approved fetch_url, consumed here), or an origin grant (a navigate the person
        // approved, `takeCred`). EXCEPTION: a SAME-ORIGIN as-you fetch is free, as navigating there is: the page the
        // run is on, read in another mode (docs/spec/POLICIES.md, "One free tier"). Cross-origin always needs a grant;
        // execOpen/consent never authorize the credentialed path.
        if (credentials) {
            // THE SENDER'S OWN PAGE, as a raw GET: the page can already `fetch(location.href, {credentials:
            // "include"})` itself, so it gains nothing here. Judged against the sender's REAL frame URL — the
            // loop's auto-approve only skipped a prompt. A RENDER of it is not included: that would open a
            // second tab of the page (re-running its scripts), which the page side never asks for — it
            // answers a session render of itself from its live DOM.
            const ownPage = !rendered && !!caller.frameUrl && isCurrentPage(url, caller.frameUrl);
            if (untrusted && !sameOriginAsSender && !ownPage && !(caller.takeCred ? caller.takeCred(url) : takeCredFetch(tabId, url))) {
                return { error: `Refused: an as-you fetch of "${url}" wasn't approved. A fetch AS THE USER (${rendered ? "rendered in your session" : "cookies"}) must be approved per-URL via the fetch_url tool; it can't run inline in exec or reuse a prior grant.` };
            }
        } else {
            // UNCREDENTIALED: an approved exec running whose code spells this URL out (`fetchUrls`); per-URL consent = the
            // human approved EXACTLY this url (and it's remembered). SAME-ORIGIN is
            // FREE (no grant) — including a same-origin RENDER (it renders in your own session, no more than a
            // free same-origin navigate). A CROSS-origin uncredentialed render runs in INCOGNITO (no session) and
            // takes the rememberable consent path, same as a raw cross-origin GET.
            const execOpen = tabId != null && !!tabGrants(tabId)?.fetchUrls?.has(url);
            // SELF-SOURCE: an uncredentialed, non-rendered read of the agent's OWN repo source (committed files
            // / structural API, NOT a prose endpoint) is allowed WITHOUT a per-URL grant, gated on the config
            // flag. Enforced HERE, trusted-side (the client autoApprove only skips the prompt; the background is
            // the authority — a forged "self-source" can't make this true for a non-self URL). See self-source.ts.
            const selfSrc = !!cfg.autoApproveSelfSource && !rendered && isSelfSourceUrl(url, BUILD_INFO.repoUrl);
            // A consent the tab REMEMBERS is an approval from an earlier call, so a person's `ask` or `deny` over the fetch
            // withdraws it: the page's script is refused and the agent's fetch_url puts the call to the person. The free
            // tiers above are not judged: the page can make those reads itself with a plain fetch(), so no card there
            // could stop it (docs/dev/policies.md, "What an ask cannot reach").
            const remembered = !caller.consented && tabId != null && !!fetchConsent.get(tabId)?.has(url) && !withdrawn(tabId, url, rendered);
            if (untrusted && !sameOriginAsSender && !execOpen && !selfSrc && !(caller.consented ? caller.consented(url) : tabId != null && (remembered || takeOnceFetch(tabId, url)))) {
                const inExec = tabId != null && !!tabGrants(tabId)?.fetchUrls;
                return { error: inExec
                    ? `Refused: "${url}" is not spelled out in the approved script, so it was not approved. Write the URL as a string literal in ml.fetch("…"), or fetch it with the fetch_url tool.`
                    : `Refused: "${url}" hasn't been approved for fetching on this page. Use the fetch_url tool (each new URL is approved once, then remembered for the session), or call ml.fetch("…") with the URL spelled out inside an approved exec.` };
            }
        }
        const execOpen = tabId != null && !!tabGrants(tabId)?.fetchUrls?.has(url);
        // Whether a URL a redirect reached was approved for this caller, as the first URL was above.
        const approved = (u: string): boolean => caller.consented ? caller.consented(u) : tabId != null && !!fetchConsent.get(tabId)?.has(u);
        // Every hop of an untrusted caller's fetch is judged before its target is requested: the same site, an http to
        // https upgrade of the host, or a URL already approved (docs/spec/SITE_PRESENCE.md, "Redirects on auto-approved
        // fetches"). An approved exec's literal URLs keep following, as a trusted surface's do.
        const judge: HopJudge | undefined = untrusted && !execOpen ? ({ from, to }) => hopIsOwn(from, to) || approved(to) : undefined;
        try {
            // rendered: an uncredentialed render is INCOGNITO (session-less — a safe read, which is why a
            // same-origin one is free); a credentialed render uses the SESSION tab (as-you → always prompts).
            // A session (non-incognito) render is NEVER free. The `cdp` setting lets it emulate foreground so
            // a backgrounded tab's gated loads fire.
            // A table whose preview is not the whole of it hands back its body; it is stored only once the result is
            // actually released below.
            const kept: { body?: import("./sw-fetch").FetchedBody; } = {};
            const data = rendered ? await fetchRenderedContent(url, !credentials, !!cfg.cdp, judge) : await fetchUrlContent(url, credentials, format, (b) => { kept.body = b; }, judge);
            // Redirect guard: a per-URL-consented fetch (NOT a surface/whitelisted/exec one) that ends on a
            // DIFFERENT, un-consented origin followed a redirect off the approved resource — withhold the body
            // (a consented public URL could redirect to a private/other target). The GET already happened but
            // no data leaves, and returning nothing is safe. exec (execOpen) trusts the code's own redirects.
            // The belt behind the hop judge: whatever the chain did, a body whose last URL is outside the judged set (the
            // same origin, an approved URL, or the same site as the first URL) is withheld.
            if (untrusted && !execOpen) {
                let sameOrigin = true;
                try { sameOrigin = new URL(data.url).origin === new URL(url).origin; } catch { /* keep true */ }
                if (!sameOrigin && !approved(data.url) && !hopIsOwn(url, data.url)) {
                    if (caller.disclose) return { error: `Refused: "${url}" redirected to a different origin on another site, which hasn't been approved, so its answer was withheld.` };
                    return { error: `"${url}" redirected to a different origin (${(() => { try { return new URL(data.url).origin; } catch { return data.url; } })()}), which hasn't been approved. Fetch that URL directly to approve it.` };
                }
            }
            if (kept.body) {
                const key = await storeFetchedBody(kept.body, data.url);
                // Handing the key over IS the claim (see pageValueSession): this is the only way a key reaches a
                // page, so recording it here is what later lets that tab's PAGE-HOSTED run read the value, with no
                // claim message to forge and no page-supplied run id to trust. A background-hosted run claims it
                // again under its own session when the pointer is stored, which is what survives a navigation.
                if (key) { data.valueKey = key; if (tabId != null && caller.disclose) claimValue(key, pageValueSession(tabId)); }
            }
            return { data };
        }
        catch (err) {
            // A refused hop's target was never requested. A page is told only that it was another site: it could not have
            // read that Location itself (its own fetch sees an opaque redirect), and the model and the person can.
            if (err instanceof RedirectRefused) {
                const to = err.hop.to;
                if (!to) return { error: `Refused: "${url}" redirected, but the extension could not read where to, so the redirect was not followed.` };
                return { error: caller.disclose
                    ? `Refused: "${url}" redirected to a different origin on another site, which hasn't been approved, so the redirect was not followed.`
                    : `Refused: "${url}" redirected to "${to}", which hasn't been approved, so the redirect was not followed. Fetch "${to}" directly to approve it.` };
            }
            const m = (err as Error)?.message || String(err);
            // A redirect loop / too-many-redirects surfaces as a generic "Failed to fetch" (Chrome opaques the
            // reason), so we can only HINT at it — the exact hops aren't visible to fetch.
            return { error: `Could not fetch "${url}" (${m}). Possible causes: a redirect loop / too many redirects (the chain isn't visible to the extension), the extension lacking host access (grant "On all sites"), or the URL being unreachable.` };
        }
    }
}
