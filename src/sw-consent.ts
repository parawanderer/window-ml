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

import type { ApprovalDecision } from "./contract-agent";
import { getConfig } from "./sw-llm";

// Design A: pending background-run approvals, keyed by `${runId}:${seq}`, resolved by a SET_APPROVAL
// message the sidebar app sends (origin-authed by the shell — it only forwards a decision from the real
// extension iframe). The approve/deny decision is made here and never crosses the page: the point of A.
// Each entry keeps the resolver AND a serializable DESCRIPTOR (what's being approved) so an EXTERNAL
// approver — the `__mlApprovals` IPC channel below — can enumerate and decide gates exactly like the UI.
export interface PendingApprovalDescriptor { key: string; runId: string; seq: number; step: number; tool: string; arguments: Record<string, unknown>; ts: number; routing: "ui" | "both" | "external"; }

// A gate is reachable by the external channel ONLY if its run OPTED IN (approvalRouting "both"/"external").
// A default "ui" run's gate can't be silently approved from outside — the driver must declare intent.
export const externallyResolvable = (d: PendingApprovalDescriptor): boolean => d.routing === "both" || d.routing === "external";

interface PendingApproval { resolve: (d: ApprovalDecision) => void; descriptor: PendingApprovalDescriptor; }

/** Every background-run gate waiting on a human, keyed `${runId}:${seq}`. The one place a run's approvals live. */
export const pendingApprovals = new Map<string, PendingApproval>();

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

// ---- Choke-point consent (docs/spec/CHOKEPOINT_CONSENT_SPEC.md) ----
// The boundary for the credentialed/unbounded ops lives HERE, not in the bypassable client-side approval.
// A privileged call passes iff: a trusted surface (sender.tab == null), a whitelisted domain, or a per-call
// grant the design-A loop minted after an iframe approval. Grants are scoped to the approved tool's
// delegation (minted in delegateTool, cleared when it returns), keyed by (tabId, resource).
// `fetchOpen` = an approved `exec` is running: its inline `ml.fetch()` calls are allowed FOR THIS RUN (the
// human approved the code containing them). Ephemeral like the rest — cleared when the exec delegation
// returns; persisting a fetched URL for the session is the separate, explicit button-#3 path (not this).
type TabGrants = { sheets: Set<string>; pyCode: Set<string>; fetchOpen?: boolean; serverTools: Set<string> };

/** What a tab has been allowed for the session, per grant kind — the ledger `grantsFor` reads and a resolved
 *  approval grows. A page never writes it: only a background run's own `resolve` does. */
export const pendingGrants = new Map<number, TabGrants>();

// PERSISTENT per-tab consent for `ml.fetch` — the exact URLs the user has approved fetching this session
// (per-URL, not per-origin: the human sees + approves each). Grown ONLY inside a background run's approval
// `resolve` (unforgeable — a page can't add to it); read by the FETCH_URL handler to authorise an untrusted
// page's fetch and by `fetchNeedsConsent` to auto-approve a repeat. Cleared when the tab closes.
export const fetchConsent = new Map<number, Set<string>>();

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

// button #3 ("Approve + remember"): persist a gated call's static egress grants for the session. Keyed by
// `kind` so a new egress kind is one case here + one extractor in grant-extract.ts + one UI branch. Called
// ONLY from a run's approval `resolve` on a positive persist decision (unforgeable — grants are re-derived
// background-side from the call, never trusted from the message).
export const persistGrants = (tabId: number, grants: import("./contract").PersistGrant[]): void => {
    for (const g of grants) {
        if (g.kind === "fetch-url") for (const u of g.urls) consentFetch(tabId, u);
    }
};

/** The grant key for one server-tool call: the bundle, the function AND the arguments. Hashing the whole
 *  call rather than the tool id is the point — approving "run the search tool for THIS query" must not
 *  authorise running it for another one. Key order is normalised so an equivalent object still matches. */
export const serverToolKey = (toolId: string, name: string, args: Record<string, unknown>): string => {
    let a = "";
    try { a = JSON.stringify(args, Object.keys(args || {}).sort()); } catch { a = String(args); }
    return `${toolId}\u0000${name}\u0000${a}`;
};

/** This tab's grant ledger, created empty on first ask — so a caller never has to know whether one exists yet. */
export const grantsFor = (tabId: number): TabGrants => {
    let g = pendingGrants.get(tabId);
    if (!g) { g = { sheets: new Set(), pyCode: new Set(), serverTools: new Set() }; pendingGrants.set(tabId, g); }
    return g;
};

/** Hostname of the message's real sender (the browser-stamped tab URL — a page can't forge it). */
function senderHost(sender: chrome.runtime.MessageSender): string {
    try { return new URL(sender.tab?.url || sender.url || "").hostname.toLowerCase(); } catch { return ""; }
}

/** Trust tier of a message's sender: `surface` = internal extension page (fully trusted); `whitelisted` =
 *  a domain the user trusts to self-gate; `untrusted` = a page that must present a per-call grant. Uses the
 *  same origin derivation GET_CONFIG does for `pageApprovalAllowed`. */
export async function senderTrust(sender: chrome.runtime.MessageSender): Promise<"surface" | "whitelisted" | "untrusted"> {
    if (sender.tab == null) return "surface";
    const host = senderHost(sender);
    const cfg = await getConfig();
    return host && (cfg.pageApprovalDomains || []).includes(host) ? "whitelisted" : "untrusted";
}
