// site-access.ts — which sites may use `window.ml`, as pure functions over the approved and denied lists.
//
// docs/spec/SITE_ACCESS.md. Every message a PAGE starts is refused by the background unless the page's origin is
// approved (sw-site-access.ts applies this at the router). What is here decides nothing on its own and touches no
// browser API, so the rules can be tested exhaustively: what an origin is, which senders can ever be granted, how the
// lists answer for an origin, and how an edit changes them.

/** Where each list is kept. `always`, `denied` and `selfApprove` persist in `chrome.storage.local`; `session` lives in
 *  `chrome.storage.session` and is gone when the browser restarts. `agents` is kept in both: the level of an origin
 *  allowed only for this session is in the session area, so it goes with that approval; every other origin's is local.
 *  Never `sync`: a decision about this browser's backend has no business following someone to a machine with a
 *  different one. */
export const SITE_ACCESS_KEYS = {
    always: "ml_site_always", session: "ml_site_session", denied: "ml_site_denied",
    agents: "ml_site_agents", selfApprove: "ml_site_selfapprove",
    /** Local: set by a migration that moved a whitelist, with the entries it could not carry over, until Settings'
     *  notice is dismissed. Here so every editor refreshes when it changes. */
    upgradeNotice: "ml_site_upgrade_notice",
} as const;

/** The local key holding which layout of the lists is stored (`SITE_SCHEMA`); absent before slice 3. */
export const SITE_SCHEMA_KEY = "ml_site_schema";   // state: fixed
/** The layout this build writes: 2 moved the self-approval whitelist to local origins and added the agent level. */
export const SITE_SCHEMA = 2;

/** Whether a site may start the extension's agent: each start asks the person, starts without asking, or is refused
 *  without asking. No entry means "off": it may not start agents and is not denied. */
export type AgentLevel = "ask" | "always" | "denied";

/** The lists. `always`, `session` and `denied` are sets of origins (`scheme://host[:port]`); `agents` maps an origin to
 *  its agent level; `selfApprove` is the origins trusted to answer their own approval prompts. */
export interface SiteLists { always: string[]; session: string[]; denied: string[]; agents: Record<string, AgentLevel>; selfApprove: string[] }

/** What the lists say about one origin. A denial wins over an approval, so an origin on both is refused. */
export type SiteDecision = "always" | "session" | "denied" | "unknown";

/** What an origin may do, as the person sees it: use window.ml, start agents, approve its own actions. */
export interface SiteLevels { use: SiteDecision; agents: AgentLevel | "off"; selfApprove: boolean }

const AGENT_LEVELS: readonly AgentLevel[] = ["ask", "always", "denied"];

/** The lists with every field present: a store written by an older build, or a caller passing the three old lists,
 *  has no `agents` or `selfApprove`. */
function full(lists: Partial<SiteLists>): SiteLists {
    return {
        always: lists.always ?? [], session: lists.session ?? [], denied: lists.denied ?? [],
        agents: lists.agents ?? {}, selfApprove: lists.selfApprove ?? [],
    };
}

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
    // A trailing dot names the same DNS name (`x.test.` is `x.test`), so it trusts the site written without it. A
    // wildcard, or any character a host name cannot hold, is never a site: dropped.
    const host = s.toLowerCase().replace(/\.$/, "");
    if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(host)) return null;
    const o = originOf(`https://${host}`);
    // A bare host only: the parsed hostname must be the whole entry (no port, no path, no credentials).
    return o && new URL(o).hostname === host ? o : null;
}

/**
 * What an origin may do. Self-approval implies the rest: an origin on `selfApprove` may use window.ml and starts agents
 * without asking (slice 3, Q6), because a site trusted to answer its own approval prompts already runs its own loop.
 * A denial wins over everything, self-approval included. An origin that may not use window.ml starts no agents.
 * @param lists the lists
 * @param origin the origin
 * @returns its three levels
 */
export function levelsFor(lists: Partial<SiteLists>, origin: string): SiteLevels {
    const l = full(lists);
    if (l.denied.includes(origin)) return { use: "denied", agents: "off", selfApprove: false };
    const self = l.selfApprove.includes(origin);
    const use: SiteDecision = l.always.includes(origin) ? "always" : l.session.includes(origin) ? "session" : self ? "always" : "unknown";
    if (use === "unknown") return { use, agents: "off", selfApprove: false };
    const stored = Object.prototype.hasOwnProperty.call(l.agents, origin) ? l.agents[origin] : undefined;
    return { use, agents: self ? "always" : AGENT_LEVELS.includes(stored as AgentLevel) ? stored as AgentLevel : "off", selfApprove: self };
}

/**
 * Whether a sender may act as a site on the self-approval list: answer its own approval prompts, and use the
 * privileged handlers without a per-call grant. The ONE rule every reader of the list applies, so none can disagree with
 * the site gate: the sender's origin is the one the gate reads (`grantableOrigin`: top frame, http(s), not opaque), and
 * `levelsFor` says it self-approves (on the list, and not denied).
 * @param lists the lists
 * @param sender the browser's facts about the sender
 * @returns true when the sender self-approves
 */
export function selfApproves(lists: Partial<SiteLists>, sender: SenderFacts): boolean {
    const g = grantableOrigin(sender);
    return !("refused" in g) && levelsFor(lists, g.origin).selfApprove;
}

/**
 * The origins a person allowed to use window.ml whose host self-approves over https on the default port, but which
 * are not on the self-approval list themselves: plain http or another port of that host, loopback included. Before the
 * whitelist was read by origin (#628), those self-approved by host; now each needs its own entry. Settings lists them
 * with a button that adds the exact origin, so an install that relied on one is told, and nothing is trusted silently.
 * @param lists the lists
 * @returns the origins, sorted, each once
 */
export function uncoveredApprovals(lists: Partial<SiteLists>): string[] {
    const l = full(lists);
    const parse = (o: string): URL | null => { try { return new URL(o); } catch { return null; } };
    const hostOf = (o: string): string | null => parse(o)?.hostname ?? null;
    const httpsHosts = new Set(l.selfApprove.map(parse).filter((u): u is URL => u?.protocol === "https:" && !u.port).map((u) => u.hostname));
    const out = new Set<string>();
    for (const o of [...l.always, ...l.session]) {
        if (l.denied.includes(o) || l.selfApprove.includes(o)) continue;
        const host = hostOf(o);
        if (host && httpsHosts.has(host)) out.add(o);
    }
    return [...out].sort();
}

/**
 * The lists in the slice 3 layout, from what the build before it stored: the gate's three lists, and the sync
 * whitelist of hosts (`pageApprovalDomains`). Each whitelist entry becomes the one origin it trusted
 * (`selfApprovalOrigin`: a bare host is `https://host` on the default port, loopback included; an entry stored as an
 * origin is that origin; anything else trusted nothing and is dropped). Every origin allowed before keeps agents with
 * start approval ("ask"); one allowed later gets "off". Nothing lands on the approved list, and no http origin is
 * inferred. Applying it twice gives what applying it once gave, and a level already stored is kept.
 * @param v1 the lists as stored (the slice 3 fields may be absent)
 * @param syncHosts the `pageApprovalDomains` setting, whatever shape it has
 * @returns the lists to store, and `dropped`: the entries that trusted nothing, as the person will be shown them
 */
export function migrateSiteLists(v1: Partial<SiteLists>, syncHosts: unknown): SiteLists & { dropped: string[] } {
    const l = full(v1);
    const agents: Record<string, AgentLevel> = { ...l.agents };
    for (const o of [...l.always, ...l.session]) if (!l.denied.includes(o) && !Object.prototype.hasOwnProperty.call(agents, o)) agents[o] = "ask";
    const entries = Array.isArray(syncHosts) ? syncHosts : [];
    const fromSync = entries.map(selfApprovalOrigin).filter((o): o is string => o != null);
    const dropped = entries.filter((e) => selfApprovalOrigin(e) == null && !(typeof e === "string" && !e.trim()))
        .map((e) => (typeof e === "string" ? e.trim() : JSON.stringify(e) ?? String(e)));
    return { ...l, agents, selfApprove: [...new Set([...l.selfApprove, ...fromSync])].sort(), dropped };
}

/** A change to the lists, as the settings and the popup ask for one. */
export type SiteEdit =
    | { op: "allow"; origin: string; scope: "session" | "always" }
    | { op: "deny"; origin: string }
    | { op: "revoke"; origin: string }
    | { op: "undeny"; origin: string }
    | { op: "agents"; origin: string; level: AgentLevel | "off" }
    | { op: "selfApprove"; origin: string; on: boolean };

/**
 * Apply one edit. Allowing lifts a denial and moves the origin to the chosen scope only, keeping its agent level when
 * it was already allowed (a site allowed fresh starts at "off"); denying removes every grant (the approvals, the agent
 * level and self-approval); revoking removes the same and leaves the origin unknown (it may ask again), so neither a
 * revoke nor a later "Stop denying" leaves self-approval behind; un-denying lifts a denial. `agents` sets the level of an origin that may use window.ml ("off" removes it; for any other origin it does
 * nothing); `selfApprove` adds or removes the origin from the self-approval list, which a denial still overrides. An
 * edit the rules do not know changes nothing.
 * @param lists the lists before
 * @param edit the change
 * @returns the lists after (new arrays; the input is not changed)
 */
export function applyEdit(lists: Partial<SiteLists>, edit: SiteEdit): SiteLists {
    const l = full(lists);
    const o = edit.origin;
    const without = (xs: string[]): string[] => xs.filter((x) => x !== o);
    const add = (xs: string[]): string[] => [...without(xs), o].sort();
    const agentsWithout = (): Record<string, AgentLevel> => Object.fromEntries(Object.entries(l.agents).filter(([k]) => k !== o));
    const copy = (): SiteLists => ({ always: [...l.always], session: [...l.session], denied: [...l.denied], agents: { ...l.agents }, selfApprove: [...l.selfApprove] });
    switch (edit.op) {
        case "allow": {
            if (edit.scope !== "always" && edit.scope !== "session") return copy();
            const wasAllowed = !l.denied.includes(o) && (l.always.includes(o) || l.session.includes(o));
            return {
                always: edit.scope === "always" ? add(l.always) : without(l.always),
                session: edit.scope === "session" ? add(l.session) : without(l.session),
                denied: without(l.denied),
                agents: wasAllowed ? { ...l.agents } : agentsWithout(),
                selfApprove: [...l.selfApprove],
            };
        }
        case "deny": return { always: without(l.always), session: without(l.session), denied: add(l.denied), agents: agentsWithout(), selfApprove: without(l.selfApprove) };
        case "revoke": return { ...copy(), always: without(l.always), session: without(l.session), agents: agentsWithout(), selfApprove: without(l.selfApprove) };
        case "undeny": return { ...copy(), denied: without(l.denied) };
        case "agents": {
            const lv = levelsFor(l, o).use;
            if (lv !== "always" && lv !== "session") return copy();
            if (edit.level === "off") return { ...copy(), agents: agentsWithout() };
            if (!AGENT_LEVELS.includes(edit.level)) return copy();
            return { ...copy(), agents: { ...agentsWithout(), [o]: edit.level } };
        }
        case "selfApprove": return { ...copy(), selfApprove: edit.on === true ? add(l.selfApprove) : without(l.selfApprove) };
        default: return copy();
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
