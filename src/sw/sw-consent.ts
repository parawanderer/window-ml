// sw-consent.ts — WHO IS ALLOWED TO ASK: the service worker's approval gates and its per-tab consent ledgers
// (docs/spec/CHOKEPOINT_CONSENT_SPEC.md).
//
// Extracted from background.ts, which is the message ROUTER; this is the layer every privileged branch of that
// router consults before doing anything. Two halves that answer different questions:
//
//   - A pending GATE, and who may resolve it (`pendingApprovals`, `resolveApproval`, `externallyResolvable`). A
//     background-hosted run's approvals live here rather than in the page, which is the whole of design A: the
//     decision never crosses into a document the page controls. A gate is reachable from the external `__mlApprovals`
//     channel only if its run OPTED IN, so a default run cannot be approved from outside.
//   - What a TAB has already been allowed (`fetchConsent`, `credFetchGrants`, `pendingGrants`, `grantsFor`), and how
//     much a sender is trusted at all (`senderTrust`).
//
// The invariant the whole file exists for: the client-side approval in injected.ts does NOT protect these handlers.
// A hostile page reaches the background directly through the content-script relay, so a privileged or credentialed
// operation must be authorized HERE, at the choke point, against `sender` — which Chrome sets and a page cannot forge.

import type { ApprovalDecision } from "../contract/contract-agent";
import { selfApprovalFacts, senderSelfApproves } from "./sw-site-access";
import { defineState } from "../state-registry";
import { judgeCall, onPoliciesChanged, type PolicyConsumer } from "./sw-policies";
import type { EffectsData, Placement } from "../effects";

// Design A: pending background-run approvals, keyed by `${runId}:${seq}`, resolved by a SET_APPROVAL
// message the sidebar app sends (origin-authed by the shell — it only forwards a decision from the real
// extension iframe). The approve/deny decision is made here and never crosses the page: the point of A.
// Each entry keeps the resolver AND a serializable DESCRIPTOR (what's being approved) so an EXTERNAL
// approver — the `__mlApprovals` IPC channel below — can enumerate and decide gates exactly like the UI.
/** The fields every pending approval has, a step's own gate or a nested ask. */
interface PendingApprovalBase {
    key: string; runId: string; seq: number; step: number; tool: string; arguments: Record<string, unknown>; ts: number; routing: "ui" | "both" | "external";
    /** Present only on a NESTED ask (sw-asks.ts): a call made from inside the running step `seq`; the key is then
     *  `${runId}:${seq}#${askId}`. */
    askId?: string;
    /** Where the call runs, for the built-in default's bound. */
    placement?: Placement;
}

/**
 * What one pending approval is about. A card a policy may decide names its `consumer` (`fetch`, `sh`), and then its
 * `facts` (the policy's `c`: plain data the WORKER resolved, never the page's or the model's word) MUST carry
 * `effects`, which the type enforces (the ruling on #719): a card without them is never judged again
 * (`rejudgePending` leaves it to the person), so building one for a judged consumer is a mistake caught here, not a
 * card that silently misses a policy change. Any other gate names no consumer; its facts, if any, are only shown.
 */
export type PendingApprovalDescriptor = PendingApprovalBase & (
    | { consumer: PolicyConsumer; facts: Record<string, unknown> & { effects: EffectsData } }
    | { consumer?: undefined; facts?: Record<string, unknown> }
);

// A gate is reachable by the external channel ONLY if its run OPTED IN (approvalRouting "both"/"external").
// A default "ui" run's gate can't be silently approved from outside — the driver must declare intent.
export const externallyResolvable = (d: PendingApprovalDescriptor): boolean => d.routing === "both" || d.routing === "external";

interface PendingApproval { resolve: (d: ApprovalDecision) => void; descriptor: PendingApprovalDescriptor; }

/** A Map that says when it changed: every path that opens or closes a gate writes the map, so its listeners hear all. */
class WatchedMap<K, V> extends Map<K, V> {
    readonly listeners: (() => void)[] = [];
    private changed(): void { for (const f of this.listeners ?? []) { try { f(); } catch { /* one listener's failure is not the rest's */ } } }
    override set(k: K, v: V): this { super.set(k, v); this.changed(); return this; }
    override delete(k: K): boolean { const had = super.delete(k); if (had) this.changed(); return had; }
    override clear(): void { super.clear(); this.changed(); }
}

/** Every background-run gate waiting on a human, keyed `${runId}:${seq}`. The one place a run's approvals live. */
export const pendingApprovals = new WatchedMap<string, PendingApproval>();

/**
 * Hear every gate open and close (the badge counts those waiting on a closed side panel).
 * @param f the listener
 */
export function onApprovalsChanged(f: () => void): void {
    pendingApprovals.listeners.push(f);
}
defineState({
    id: "run.approvals", scope: "run", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "The calls the run is waiting on you to approve: the tool, its arguments, the step, and since when.",
    read: ({ runId }) => {
        const open = [...pendingApprovals.values()].map((e) => e.descriptor).filter((d) => d.runId === runId);
        return open.length ? open.map((d) => ({ tool: d.tool, arguments: d.arguments, step: d.step, seq: d.seq, since: d.ts })) : undefined;
    },
});

// Resolve a pending gate by key — the SINGLE path both the origin-authed SET_APPROVAL message and the
// external `__mlApprovals` channel funnel through, so a decision from either resolves the gate everywhere
// (the same "one press resolves every surface" property, now extended to an out-of-browser approver).
// Returns false if the key is unknown (already resolved / cancelled). The stored resolver applies any side
// effects (e.g. remembering an approved sheet) and unblocks the loop.
export function resolveApproval(key: string, decision: ApprovalDecision): boolean {
    const entry = pendingApprovals.get(key);
    if (!entry) return false;
    pendingApprovals.delete(key);
    entry.resolve(decision);
    return true;
}

/**
 * Judge every card still showing again, after a policy changed (POLICIES.md, "A change takes effect at once"): a new
 * `deny` refuses it and a new `allow` answers it, and the card closes saying which policy did. Only a card whose
 * descriptor carries `consumer` and `facts` is judged, the facts the worker resolved when it opened. A store not yet
 * loaded, an `ask` policy (it resolves nothing, and it beats an `allow`), the built-in default and no answer leave the
 * card for the person.
 * @returns how many cards a policy answered
 */
export function rejudgePending(): number {
    let n = 0;
    for (const [key, { descriptor: d }] of [...pendingApprovals]) {
        // Facts without resolved effects are left to the person: a person's `allow` that never reads `c.effects` would
        // otherwise answer a call whose effects nobody resolved, the case the built-in default sends to a card.
        if ((d.consumer !== "fetch" && d.consumer !== "sh") || !d.facts || d.facts.effects === undefined) continue;
        const j = judgeCall(d.runId, d.consumer, d.facts, d.placement);
        if (!j.by || j.by === "builtin" || (j.decision !== "allow" && j.decision !== "deny")) continue;
        const said = `the policy "${j.by.label}" ${j.decision === "deny" ? "refuses" : "allows"} it`;
        if (resolveApproval(key, j.decision === "deny" ? { approved: false, source: "policy", feedback: said } : { approved: true, source: "policy" })) n++;
    }
    return n;
}
onPoliciesChanged(() => { rejudgePending(); });

// ---- Choke-point consent (docs/spec/CHOKEPOINT_CONSENT_SPEC.md) ----
// The boundary for the credentialed/unbounded ops lives HERE, not in the bypassable client-side approval.
// A privileged call passes iff: a trusted surface (sender.tab == null), a whitelisted domain, or a per-call
// grant the design-A loop minted after an iframe approval. Grants are scoped to the approved tool's
// delegation (minted in delegateTool, cleared when it returns), keyed by (tabId, resource).
// `fetchUrls` = an approved `exec` is running: its inline `ml.fetch()` of the URLs it spells out as literals is allowed
// for this call (the person approved the code naming them; `fetchUrlLiterals`, parsed here, never the page's word).
// Only those: the page shares the tab, so an open grant let it fetch anything while any exec ran. Ephemeral like the
// rest, cleared when the exec delegation returns; persisting a URL for the session is button #3 (not this).
type TabGrants = { sheets: Set<string>; pyCode: Set<string>; fetchUrls?: Set<string>; serverTools: Set<string> };

/** What each approved call now running on a tab was allowed, per call: a tab can host two runs, and one call ending must
 *  not take away another's grants. Minted by `grantsFor`, read through `tabGrants`, dropped by `dropCallGrants` when the
 *  call returns. A page never writes it: only a background run's own delegation does. */
export const pendingGrants = new Map<number, Map<object, TabGrants>>();
defineState({
    id: "grants.call", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "What the call now running on the run's tab was allowed when it was approved: sheets, Python code, server tools, fetches inside it.",
    read: ({ tabId }) => {
        const g = tabId == null ? undefined : tabGrants(tabId);
        return g && { sheets: [...g.sheets], pythonCode: g.pyCode.size, serverTools: [...g.serverTools], fetchOpen: !!g.fetchUrls?.size, fetchUrls: [...(g.fetchUrls ?? [])] };
    },
});

// PERSISTENT per-tab consent for `ml.fetch` — the exact URLs the user has approved fetching this session
// (per-URL, not per-origin: the human sees + approves each). Grown ONLY inside a background run's approval
// `resolve` (unforgeable — a page can't add to it); read by the FETCH_URL handler to authorise an untrusted
// page's fetch and by `fetchNeedsConsent` to auto-approve a repeat. Cleared when the tab closes.
export const fetchConsent = new Map<number, Set<string>>();
defineState({
    id: "grants.fetch", scope: "tab", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "URLs approved for fetching from the run's tab, which a repeat fetch does not ask about again until the tab closes.",
    read: ({ tabId }) => { const s = tabId == null ? undefined : fetchConsent.get(tabId); return s?.size ? [...s] : undefined; },
});

/** Remember that this tab may fetch this exact URL for the rest of the session (the repeat-fetch auto-approve). */
export const consentFetch = (tabId: number, url: string): void => {
    let s = fetchConsent.get(tabId);
    if (!s) { s = new Set(); fetchConsent.set(tabId, s); }
    s.add(url);
};

// ONE-TIME per-URL grants for a CREDENTIALED ml.fetch (fetch-as-the-user). Minted ONLY when a `fetch_url`
// call with credentials is APPROVED, and CONSUMED on the fetch — never persisted (unlike fetchConsent), so a
// credentialed fetch ALWAYS re-prompts. `execOpen`/`fetchConsent` deliberately do NOT authorize credentialed
// (it spends the user's cookies — too sensitive for the broad exec grant or a remembered consent).
export const credFetchGrants = new Map<number, Set<string>>();
defineState({
    id: "grants.credentialedFetch", scope: "tab", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "Approved fetches with your cookies, each usable once and not yet used.",
    read: ({ tabId }) => { const s = tabId == null ? undefined : credFetchGrants.get(tabId); return s?.size ? [...s] : undefined; },
});

/** Mint the ONE-TIME grant for a credentialed (as-the-user) fetch of this URL, consumed by `takeCredFetch`. */
export const grantCredFetch = (tabId: number, url: string): void => {
    let s = credFetchGrants.get(tabId);
    if (!s) { s = new Set(); credFetchGrants.set(tabId, s); }
    s.add(url);
};

/** Consume a one-time credentialed grant for (tabId, url): true if it existed (and is now spent), else false. */
export const takeCredFetch = (tabId: number | undefined, url: string): boolean => {
    if (tabId == null) return false;
    const s = credFetchGrants.get(tabId);
    if (!s?.has(url)) return false;
    s.delete(url);
    return true;
};

/** One-time grants for an UNCREDENTIALED fetch that an `ask` policy put to the person: approving the card runs that one
 *  call and remembers nothing, so the next fetch of the URL asks again (docs/spec/POLICIES.md, the `ask` answer). */
export const onceFetchGrants = new Map<number, Set<string>>();
defineState({
    id: "grants.askedFetch", scope: "tab", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "Fetches an ask policy put to you and you approved, each usable once and not yet used.",
    read: ({ tabId }) => { const s = tabId == null ? undefined : onceFetchGrants.get(tabId); return s?.size ? [...s] : undefined; },
});

/** Mint the ONE-TIME grant for an uncredentialed fetch an `ask` policy raised, consumed by `takeOnceFetch`. */
export const grantOnceFetch = (tabId: number, url: string): void => {
    let s = onceFetchGrants.get(tabId);
    if (!s) { s = new Set(); onceFetchGrants.set(tabId, s); }
    s.add(url);
};

/** Consume a one-time asked-fetch grant for (tabId, url): true if it existed (and is now spent), else false. */
export const takeOnceFetch = (tabId: number | undefined, url: string): boolean => {
    if (tabId == null) return false;
    const s = onceFetchGrants.get(tabId);
    if (!s?.has(url)) return false;
    s.delete(url);
    return true;
};

/** The grant key for one server-tool call: the bundle, the function AND the arguments. Hashing the whole
 *  call rather than the tool id is the point — approving "run the search tool for THIS query" must not
 *  authorise running it for another one. Key order is normalised so an equivalent object still matches. */
export const serverToolKey = (toolId: string, name: string, args: Record<string, unknown>): string => {
    let a = "";
    try { a = JSON.stringify(args, Object.keys(args || {}).sort()); } catch { a = String(args); }
    return `${toolId}\u0000${name}\u0000${a}`;
};

/** One call's grant ledger on a tab, created empty on first ask — so a caller never has to know whether one exists yet.
 *  @param call the call's own key (an object made per call), so ending it drops only its grants */
export const grantsFor = (tabId: number, call: object): TabGrants => {
    let calls = pendingGrants.get(tabId);
    if (!calls) { calls = new Map(); pendingGrants.set(tabId, calls); }
    let g = calls.get(call);
    if (!g) { g = { sheets: new Set(), pyCode: new Set(), serverTools: new Set() }; calls.set(call, g); }
    return g;
};

/** Drop one call's grants when it returns; the tab's other calls keep theirs. */
export const dropCallGrants = (tabId: number, call: object): void => {
    const calls = pendingGrants.get(tabId);
    if (!calls) return;
    calls.delete(call);
    if (!calls.size) pendingGrants.delete(tabId);
};

/** What the calls now running on a tab were allowed, together: what a sub-op of any of them may do. Undefined when no
 *  call holds a grant. `fetchUrls` is present when any call is an exec (an exec's own `ml.fetch` is then refused with
 *  the exec's sentence rather than the plain one). */
export const tabGrants = (tabId: number): TabGrants | undefined => {
    const calls = pendingGrants.get(tabId);
    if (!calls?.size) return undefined;
    const all: TabGrants = { sheets: new Set(), pyCode: new Set(), serverTools: new Set() };
    for (const g of calls.values()) {
        for (const x of g.sheets) all.sheets.add(x);
        for (const x of g.pyCode) all.pyCode.add(x);
        for (const x of g.serverTools) all.serverTools.add(x);
        if (g.fetchUrls) { all.fetchUrls ??= new Set(); for (const x of g.fetchUrls) all.fetchUrls.add(x); }
    }
    return all;
};

/** Trust tier of a message's sender: `surface` = internal extension page (fully trusted); `whitelisted` =
 *  an origin the user trusts to self-gate; `untrusted` = a page that must present a per-call grant. `whitelisted` is
 *  `senderSelfApproves`, the one rule `pageApprovalAllowed` also reads: the whitelisted host's https origin only,
 *  top frame, and approved by the site gate. Never plain http, another port or a subdomain of it. */
export async function senderTrust(sender: chrome.runtime.MessageSender): Promise<"surface" | "whitelisted" | "untrusted"> {
    if (sender.tab == null) return "surface";
    return await senderSelfApproves(selfApprovalFacts(sender)) ? "whitelisted" : "untrusted";
}
