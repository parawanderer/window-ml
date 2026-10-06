// site-access.ts — which sites may use `window.ml`, as pure functions over the approved and denied lists.
//
// docs/spec/SITE_ACCESS.md. Every message a PAGE starts is refused by the background unless the page's origin is
// approved (sw-site-access.ts applies this at the router). What is here decides nothing on its own and touches no
// browser API, so the rules can be tested exhaustively: what an origin is, which senders can ever be granted, how the
// lists answer for an origin, and how an edit changes them.

/** Where each list is kept. `always` and `denied` persist in `chrome.storage.local`; `session` lives in
 *  `chrome.storage.session` and is gone when the browser restarts. Never `sync`: a decision about this browser's
 *  backend has no business following someone to a machine with a different one. */
export const SITE_ACCESS_KEYS = { always: "ml_site_always", session: "ml_site_session", denied: "ml_site_denied" } as const;

/** The three lists, each a set of origins (`scheme://host[:port]`). */
export interface SiteLists { always: string[]; session: string[]; denied: string[] }

/** What the lists say about one origin. A denial wins over an approval, so an origin on both is refused. */
export type SiteDecision = "always" | "session" | "denied" | "unknown";

/**
 * The origin of an http(s) URL, as the browser writes it (`https://example.com`, default port dropped), or null for
 * anything that can never be granted: another scheme, an opaque origin, a string that is not a URL.
 * @param url a URL or an origin
 * @returns the origin, or null
 */
export function originOf(url: string | undefined | null): string | null {
    if (!url || url === "null") return null;
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        return u.origin;
    } catch { return null; }
}

/** The fields of a message sender this module reads: all of them set by the browser, none by the page. */
export interface SenderFacts { origin?: string; url?: string; frameId?: number }

/**
 * The origin a page's message speaks for, or why it can never be granted: an opaque origin (a sandboxed frame, a
 * `data:` or `about:blank` document), a scheme other than http(s), or any frame but the top one. A cross-origin iframe
 * never inherits its parent's approval, so a sub-frame is refused whatever its origin is.
 * @param sender the browser's facts about the sender
 * @returns `{ origin }`, or `{ refused }` with the reason
 */
export function grantableOrigin(sender: SenderFacts): { origin: string } | { refused: string } {
    if (sender.frameId != null && sender.frameId !== 0) return { refused: "only a page's top frame can use window.ml" };
    if (sender.origin === "null") return { refused: "an opaque origin (a sandboxed frame or a data: document) cannot use window.ml" };
    const origin = originOf(sender.origin || sender.url);
    return origin ? { origin } : { refused: "only an http or https page can use window.ml" };
}

/**
 * What the lists say about an origin. A host on `pageApprovalDomains` (sites trusted to supply their own approval
 * gate) is approved over HTTPS only: that list is a stronger trust than this one, so being on it implies approval, but
 * it is keyed by host, and extending it to plain http would trust whoever can tamper with an http connection to it.
 * @param lists the three lists
 * @param origin the origin
 * @param selfGateHosts the `pageApprovalDomains` setting
 * @returns the decision
 */
export function decide(lists: SiteLists, origin: string, selfGateHosts: readonly string[] = []): SiteDecision {
    if (lists.denied.includes(origin)) return "denied";
    if (lists.always.includes(origin)) return "always";
    if (lists.session.includes(origin)) return "session";
    try {
        const u = new URL(origin);
        if (u.protocol === "https:" && selfGateHosts.includes(u.hostname)) return "always";
    } catch { /* not an origin */ }
    return "unknown";
}

/** A change to the lists, as the settings and the popup ask for one. */
export type SiteEdit =
    | { op: "allow"; origin: string; scope: "session" | "always" }
    | { op: "deny"; origin: string }
    | { op: "revoke"; origin: string }
    | { op: "undeny"; origin: string };

/**
 * Apply one edit. Allowing lifts a denial and moves the origin to the chosen scope only; denying removes any approval;
 * revoking removes an approval and leaves the origin unknown (it may ask again); un-denying the same for a denial.
 * @param lists the lists before
 * @param edit the change
 * @returns the lists after (new arrays; the input is not changed)
 */
export function applyEdit(lists: SiteLists, edit: SiteEdit): SiteLists {
    const without = (xs: string[]): string[] => xs.filter((x) => x !== edit.origin);
    const add = (xs: string[]): string[] => [...without(xs), edit.origin].sort();
    switch (edit.op) {
        case "allow": return {
            always: edit.scope === "always" ? add(lists.always) : without(lists.always),
            session: edit.scope === "session" ? add(lists.session) : without(lists.session),
            denied: without(lists.denied),
        };
        case "deny": return { always: without(lists.always), session: without(lists.session), denied: add(lists.denied) };
        case "revoke": return { ...lists, always: without(lists.always), session: without(lists.session) };
        case "undeny": return { ...lists, denied: without(lists.denied) };
    }
}

/**
 * Read what a person typed into the settings as an origin: a bare host means https, a full URL keeps its scheme and
 * port, and a path is dropped. Null for anything that is not an http(s) site.
 * @param input what was typed
 * @returns the origin, or null
 */
export function originFromInput(input: string): string | null {
    const s = input.trim();
    if (!s) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    const o = originOf(withScheme);
    if (!o) return null;
    // A host with no dot is a typo far more often than an intranet name; localhost is the one exception worth keeping.
    const host = new URL(o).hostname;
    return host.includes(".") || host === "localhost" || /^\[.*\]$/.test(host) ? o : null;
}
