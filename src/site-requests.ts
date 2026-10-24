// site-requests.ts — the rules for a site asking the person for access: one entry per origin, caps, expiry, answers.
//
// docs/spec/SITE_ACCESS.md "Requesting access", docs/spec/SITE_ACCESS_SLICE3.md 1.7 and PR 4. Pure: the worker
// (sw-access-requests.ts) stores what `askAccess` returns and supplies the facts only it can know (the origin from
// `sender`, the registrable domain, the gesture the content script saw, whether a running agent opened the page).

import type { AccessAnswer } from "./contract/contract-config";
import { levelsFor, type SiteLists, type SiteEdit } from "./site-access";

/** What an entry asks for: to use window.ml (perhaps with agents), or to approve its own actions. */
export type RequestKind = "access" | "selfApprove";

/** One request, as stored. `pending` waits in the toolbar button; `answered` is final (the lists hold what was
 *  decided); `expired` went unanswered for `REQUEST_TTL_MS` and may be asked once more, never a third time. */
export interface AccessRequest {
    origin: string;
    /** The registrable domain the caps count by (eTLD+1, or the host when it has none). */
    domain: string;
    kind: RequestKind;
    /** For an `access` entry: whether it also asked to start agents. */
    agents: boolean;
    /** The site's own words, cut to `REASON_MAX`; never shown as anything but a quote. */
    reason?: string;
    at: number;
    state: "pending" | "answered" | "expired";
    /** How many times the origin has asked for this kind: 2 after the one re-ask an expiry allows. */
    asks: number;
}

/** The stored layout of the request store, so a later build can tell what it reads. */
export const REQUESTS_SCHEMA = 1;

/** An entry as the popup and Settings list it: with whether its origin may already use window.ml, which decides the
 *  buttons (an allowed site asking for agents gets the agent level's button, not Allow). */
export interface WaitingRequest extends AccessRequest { allowed: boolean }

/** The store: every entry ever made, one per origin and kind. */
export interface RequestStore { v: typeof REQUESTS_SCHEMA; entries: AccessRequest[] }

/** How long a request nobody answers waits before it expires (rule 6: 7 days). */
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many pending entries in all (rule 6). */
export const MAX_PENDING = 5;
/** The longest reason kept, in characters (rule 7). */
export const REASON_MAX = 200;

/** What a page asked for, after the content script and the worker read it: never trusted beyond its shape. */
export interface AskInput { agents?: unknown; level?: unknown; reason?: unknown }

/** The facts the worker supplies, each from something the page cannot set. */
export interface AskFacts {
    origin: string;
    domain: string;
    /** The content script saw a real gesture on the page's own document (Q11). */
    gesture: boolean;
    /** Whether a site the person has not allowed may ask at all (the "Let sites ask for access" setting). */
    sitesMayAsk: boolean;
    /** A running agent's navigation reached this page (Q17): it is recorded, never shown as a prompt. */
    openedByAgent: boolean;
    now: number;
}

/** The refusal reasons a page reads (docs/spec/SITE_ACCESS_SLICE3.md 1.7). */
export const ASK_REFUSED = {
    gesture: "needs a user gesture",
    frame: "only a page's top frame on http or https can ask",
    full: "too many requests are waiting; try again later",
    off: "this browser does not take requests from sites",
    first: "ask for access first",
    openedByAgent: "this page was opened by a running agent",
} as const;

/**
 * The store as read back: an older or damaged value is an empty store, an entry missing a field is dropped.
 * @param raw what storage held
 * @returns a store this build can use
 */
export function readStore(raw: unknown): RequestStore {
    const r = raw as { v?: unknown; entries?: unknown } | null | undefined;
    if (!r || r.v !== REQUESTS_SCHEMA || !Array.isArray(r.entries)) return { v: REQUESTS_SCHEMA, entries: [] };
    const ok = (e: AccessRequest): boolean => !!e && typeof e.origin === "string" && typeof e.domain === "string"
        && (e.kind === "access" || e.kind === "selfApprove") && typeof e.at === "number"
        && (e.state === "pending" || e.state === "answered" || e.state === "expired") && typeof e.asks === "number";
    return { v: REQUESTS_SCHEMA, entries: (r.entries as AccessRequest[]).filter(ok).map((e) => ({ ...e, agents: e.agents === true })) };
}

/**
 * Expire every pending entry older than `REQUEST_TTL_MS`.
 * @param store the store
 * @param now the time
 * @returns the store after, and whether anything changed
 */
export function expire(store: RequestStore, now: number): { store: RequestStore; changed: boolean } {
    let changed = false;
    const entries = store.entries.map((e) => {
        if (e.state !== "pending" || now - e.at < REQUEST_TTL_MS) return e;
        changed = true;
        return { ...e, state: "expired" as const };
    });
    return { store: { v: REQUESTS_SCHEMA, entries }, changed };
}

/**
 * The entries waiting for the person, oldest first.
 * @param store the store
 * @param now the time (an entry past its expiry is not waiting, even before `expire` stored that)
 * @returns the pending entries
 */
export function pendingRequests(store: RequestStore, now: number): AccessRequest[] {
    return store.entries.filter((e) => e.state === "pending" && now - e.at < REQUEST_TTL_MS).sort((a, b) => a.at - b.at);
}

/** The agent part of an answer for an origin that may use window.ml. */
function agentsAnswer(lists: Partial<SiteLists>, origin: string, entry: AccessRequest | undefined, now: number): "granted" | "pending" | "denied" | "off" {
    const a = levelsFor(lists, origin).agents;
    if (a === "ask" || a === "always") return "granted";
    if (a === "denied") return "denied";
    return entry?.agents && entry.state === "pending" && now - entry.at < REQUEST_TTL_MS ? "pending" : "off";
}

/**
 * Answer one `ml.requestAccess` call, and the store after it. Rules (docs/spec/SITE_ACCESS.md "Requesting access"):
 * one entry per origin and kind, ever (a later call answers the current state and shows nothing new); a denial is
 * final; a new entry needs a gesture and room under the caps (one pending per registrable domain, `MAX_PENDING` in all);
 * an entry nobody answers expires and the origin may ask once more; self-approval only from an origin already allowed.
 * An origin that may use window.ml and asks for agents its level already settles gets that answer with no entry.
 * @param store the store
 * @param lists the site lists now
 * @param input what the page asked for
 * @param facts what the worker knows about the asker
 * @returns the answer, the store after (the same object when nothing changed), and the entry it made, if any
 */
export function askAccess(store: RequestStore, lists: Partial<SiteLists>, input: AskInput, facts: AskFacts): { answer: AccessAnswer; store: RequestStore; created?: AccessRequest } {
    const { origin, now } = facts;
    const levels = levelsFor(lists, origin);
    const kind: RequestKind = input.level === "self-approve" ? "selfApprove" : "access";
    const wantsAgents = kind === "access" && input.agents === true;
    const entry = store.entries.find((e) => e.origin === origin && e.kind === kind);
    const live = entry && entry.state === "pending" && now - entry.at >= REQUEST_TTL_MS ? { ...entry, state: "expired" as const } : entry;
    const same = (answer: AccessAnswer) => ({ answer, store });

    if (levels.use === "denied") return same({ state: "denied" });
    if (kind === "selfApprove") {
        if (levels.use === "unknown") return same({ state: "refused", reason: ASK_REFUSED.first });
        if (levels.selfApprove) return same({ state: "granted", agents: "granted" });
        if (live?.state === "pending") return same({ state: "pending" });
        if (live?.state === "answered") return same({ state: "denied" });
    } else if (levels.use !== "unknown") {
        const agents = agentsAnswer(lists, origin, live, now);
        // Nothing to ask: no agents wanted, or the level already says. An agents entry the person answered "no" to is the
        // level "denied" (the lists say it); one answered otherwise is whatever the level is now.
        if (!wantsAgents || agents !== "off" || live?.state === "answered" || (live?.state === "expired" && live.asks >= 2)) return same({ state: "granted", agents });
    } else {
        if (live?.state === "pending") return same({ state: "pending" });
        // Answered and not on any list: the person allowed it and later revoked it. It asked once.
        if (live?.state === "answered") return same({ state: "denied" });
    }
    // A new entry, or the one re-ask an expiry allows. Past the second expiry the origin has asked twice: denied by
    // default, which a page cannot tell from the person's denial (rule 2).
    if (live?.state === "expired" && live.asks >= 2) return same({ state: "denied" });
    if (facts.openedByAgent) return same({ state: "refused", reason: ASK_REFUSED.openedByAgent });
    if (kind === "access" && levels.use === "unknown" && !facts.sitesMayAsk) return same({ state: "refused", reason: ASK_REFUSED.off });
    if (!facts.gesture) return same({ state: "refused", reason: ASK_REFUSED.gesture });
    const pending = pendingRequests(store, now).filter((e) => !(e.origin === origin && e.kind === kind));
    if (pending.length >= MAX_PENDING || pending.some((e) => e.domain === facts.domain)) return same({ state: "refused", reason: ASK_REFUSED.full });
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, REASON_MAX) : undefined;
    const created: AccessRequest = {
        origin, domain: facts.domain, kind, agents: wantsAgents, ...(reason ? { reason } : {}),
        at: now, state: "pending", asks: (live?.asks ?? 0) + 1,
    };
    const entries = [...store.entries.filter((e) => !(e.origin === origin && e.kind === kind)), created];
    const answer: AccessAnswer = kind === "access" && levels.use !== "unknown" ? { state: "granted", agents: "pending" } : { state: "pending" };
    return { answer, store: { v: REQUESTS_SCHEMA, entries }, created };
}

/** How the person answers an entry, from the popup or Settings. `agents` is the "Let it start agents too" box. */
export type RequestDecision =
    | { kind: "access"; answer: "session" | "always"; agents?: boolean }
    | { kind: "access"; answer: "agents" }
    | { kind: "access"; answer: "deny" }
    | { kind: "selfApprove"; answer: "allow" | "deny" };

/**
 * The list edits one answer makes, and the store after it. Only a pending entry can be answered; anything else is no
 * edit. Denying a plain request denies the origin; denying an agents request from an origin that may already use
 * window.ml sets its agent level to "denied"; denying self-approval leaves the origin's other levels as they are and
 * keeps the entry answered, which is final.
 * @param store the store
 * @param lists the site lists now
 * @param origin the entry's origin
 * @param decision what the person chose
 * @param now the time
 * @returns the edits to apply in order, and the store after
 */
export function answerRequest(store: RequestStore, lists: Partial<SiteLists>, origin: string, decision: RequestDecision, now: number): { edits: SiteEdit[]; store: RequestStore } {
    const entry = pendingRequests(store, now).find((e) => e.origin === origin && e.kind === decision.kind);
    if (!entry) return { edits: [], store };
    const use = levelsFor(lists, origin).use;
    const allowed = use === "always" || use === "session";
    let edits: SiteEdit[];
    if (decision.kind === "selfApprove") {
        edits = decision.answer === "allow" && allowed ? [{ op: "selfApprove", origin, on: true }] : [];
    } else if (decision.answer === "deny") {
        edits = allowed ? (entry.agents ? [{ op: "agents", origin, level: "denied" }] : []) : [{ op: "deny", origin }];
    } else if (decision.answer === "agents") {
        edits = allowed ? [{ op: "agents", origin, level: "ask" }] : [];
    } else {
        edits = [
            ...(allowed ? [] : [{ op: "allow", origin, scope: decision.answer } as SiteEdit]),
            ...(entry.agents && decision.agents === true ? [{ op: "agents", origin, level: "ask" } as SiteEdit] : []),
        ];
    }
    const entries = store.entries.map((e) => (e === entry ? { ...e, state: "answered" as const } : e));
    return { edits, store: { v: REQUESTS_SCHEMA, entries } };
}

/**
 * Mark answered every pending entry the lists already settle, so a request the person decided some other way (the
 * popup's "This site" block, Settings) stops waiting: an origin denied, an access request whose origin may now use
 * window.ml (with an agent level, when it asked for agents), a self-approval request whose origin now self-approves or
 * may no longer use window.ml.
 * @param store the store
 * @param lists the site lists now
 * @returns the store after, and whether anything changed
 */
export function settleByLists(store: RequestStore, lists: Partial<SiteLists>): { store: RequestStore; changed: boolean } {
    let changed = false;
    const entries = store.entries.map((e) => {
        if (e.state !== "pending") return e;
        const l = levelsFor(lists, e.origin);
        const allowed = l.use === "always" || l.use === "session";
        const settled = l.use === "denied"
            || (e.kind === "access" && allowed && (!e.agents || l.agents !== "off"))
            || (e.kind === "selfApprove" && (l.selfApprove || !allowed));
        if (!settled) return e;
        changed = true;
        return { ...e, state: "answered" as const };
    });
    return { store: changed ? { v: REQUESTS_SCHEMA, entries } : store, changed };
}
