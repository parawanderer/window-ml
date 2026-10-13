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
 * The one origin a self-approval whitelist entry (`pageApprovalDomains`) trusts. A bare host, as the settings store it,
 * means `https://host` on the default port: never plain http (whoever can tamper with an http connection would be
 * trusted), never another port, never a subdomain. An entry written as an origin (`http://127.0.0.1:5123`) trusts
 * exactly that origin. Anything else (a bare host with a port or a path, another scheme, not a string) trusts nothing,
 * as the host match before it never honoured those either.
 * @param entry one entry of the whitelist
 * @returns the origin, or null
 */
export function selfApprovalOrigin(entry: unknown): string | null {
    if (typeof entry !== "string") return null;
    const s = entry.trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        const o = originOf(s);
        if (!o) return null;
        // An origin, with at most a trailing slash: a path would name a page, and the whitelist is not per page.
        const u = new URL(s);
        return u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password ? o : null;
    }
    const o = originOf(`https://${s}`);
    // A bare host only: the parsed hostname must be the whole entry (no port, no path, no credentials).
    return o && new URL(o).hostname === s.toLowerCase() ? o : null;
}

/**
 * Whether a host name is loopback: `localhost` (and a `*.localhost` name, which browsers resolve to it), an address in
 * `127.0.0.0/8`, or `[::1]`. A browser treats these as secure contexts even over http, and no one on the network can
 * answer for them.
 * @param host a URL's `hostname` (IPv6 in brackets)
 * @returns true for a loopback name
 */
export function isLoopbackHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Whether an origin is on the self-approval whitelist, for the whitelist's own readers (`selfApproves`). An entry
 * covers the one origin `selfApprovalOrigin` names, and a bare LOOPBACK host (`localhost`, `127.0.0.1`, `[::1]`) also
 * covers that host over http and on any port, which is what it meant before the whitelist was read by origin: no
 * network attacker can answer for loopback, so http there opens nothing to one, and narrowing it would silently stop
 * every local dev server and self-hosted UI working. Every port of it is still only as trusted as the site gate makes
 * it: `selfApproves` also needs the gate's approval, which the whitelist implies only for `selfApprovalOrigin`'s origin.
 * @param origin the origin
 * @param selfGateHosts the `pageApprovalDomains` setting
 * @returns true when an entry trusts this origin to self-approve
 */
export function onSelfApprovalList(origin: string, selfGateHosts: readonly unknown[]): boolean {
    let host = "";
    try { host = new URL(origin).hostname; } catch { /* not an origin */ }
    return selfGateHosts.some((e) => {
        const o = selfApprovalOrigin(e);
        if (o === origin) return true;
        // A bare loopback entry: any http(s) port of that exact host. An entry written as an origin stays that origin.
        return o != null && typeof e === "string" && !/:\/\//.test(e) && isLoopbackHost(host) && new URL(o).hostname === host;
    });
}

/**
 * Whether the gate's implied approval covers an origin: exactly one entry's origin (`selfApprovalOrigin`), never the
 * wider loopback reading `onSelfApprovalList` gives a bare loopback host, so the whitelist never lets a page on
 * another port use window.ml that the person did not allow.
 * @param origin the origin
 * @param selfGateHosts the `pageApprovalDomains` setting
 * @returns true when an entry names this origin
 */
function impliesApproval(origin: string, selfGateHosts: readonly unknown[]): boolean {
    return selfGateHosts.some((e) => selfApprovalOrigin(e) === origin);
}

/**
 * What the lists say about an origin. An origin on the self-approval whitelist (`pageApprovalDomains`, sites trusted to
 * supply their own approval gate) is approved: that list is a stronger trust than this one, so being on it implies
 * approval. Which origin an entry means is `selfApprovalOrigin`'s rule.
 * @param lists the three lists
 * @param origin the origin
 * @param selfGateHosts the `pageApprovalDomains` setting
 * @returns the decision
 */
export function decide(lists: SiteLists, origin: string, selfGateHosts: readonly unknown[] = []): SiteDecision {
    if (lists.denied.includes(origin)) return "denied";
    if (lists.always.includes(origin)) return "always";
    if (lists.session.includes(origin)) return "session";
    if (impliesApproval(origin, selfGateHosts)) return "always";
    return "unknown";
}

/**
 * Whether a sender may act as a site on the self-approval whitelist: answer its own approval prompts, and use the
 * privileged handlers without a per-call grant. The ONE rule every reader of `pageApprovalDomains` applies, so none can
 * disagree with the site gate: the sender's origin is the one the gate reads (`grantableOrigin`: top frame, http(s),
 * not opaque), it is on the whitelist (`onSelfApprovalList`), and the gate approves it, always or for this session (a
 * denial wins).
 * @param lists the three lists
 * @param sender the browser's facts about the sender
 * @param selfGateHosts the `pageApprovalDomains` setting
 * @returns true when the sender self-approves
 */
export function selfApproves(lists: SiteLists, sender: SenderFacts, selfGateHosts: readonly unknown[]): boolean {
    const g = grantableOrigin(sender);
    if ("refused" in g) return false;
    if (!onSelfApprovalList(g.origin, selfGateHosts)) return false;
    const d = decide(lists, g.origin, selfGateHosts);
    return d === "always" || d === "session";
}

/**
 * The origins a person allowed to use window.ml whose host is a bare entry on the self-approval whitelist, but which
 * that entry no longer makes self-approving: plain http or another port of a non-loopback host. Before the whitelist
 * was read by origin, those self-approved by host; now each needs its own entry. Settings and the popup list them with
 * a button that adds the exact origin, so an install that relied on one is told, and nothing is trusted silently.
 * @param lists the three lists
 * @param selfGateHosts the `pageApprovalDomains` setting
 * @returns the origins, sorted, each once
 */
export function uncoveredApprovals(lists: SiteLists, selfGateHosts: readonly unknown[]): string[] {
    const bare = new Set(selfGateHosts.filter((e): e is string => typeof e === "string" && !/:\/\//.test(e) && selfApprovalOrigin(e) != null).map((e) => e.trim().toLowerCase()));
    const out = new Set<string>();
    for (const o of [...lists.always, ...lists.session]) {
        if (lists.denied.includes(o) || onSelfApprovalList(o, selfGateHosts)) continue;
        let host = "";
        try { host = new URL(o).hostname; } catch { continue; }
        if (bare.has(host)) out.add(o);
    }
    return [...out].sort();
}

/**
 * Read what a person typed into the self-approval whitelist as the entry to store. A site on https's default port is
 * stored as its bare host, as every earlier build stored it; anything else (plain http, another port) is stored as its
 * origin, which trusts exactly that origin (`selfApprovalOrigin`). Typed as `originFromInput` reads it: a bare host
 * means https, so `http://` must be written out.
 * @param input what was typed
 * @returns the entry, or null for anything that is not an http(s) site
 */
export function whitelistEntryFromInput(input: string): string | null {
    const o = originFromInput(input);
    if (!o) return null;
    const u = new URL(o);
    return u.protocol === "https:" && !u.port ? u.hostname : o;
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
