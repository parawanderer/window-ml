// Background service worker: owns config, builds per-format request bodies,
// extracts replies, and makes the privileged (host-permissioned) fetches. All
// server JSON is genuinely opaque, so it's typed `any`; our own data uses the
// shared contract types.
import type { NeutralMessage, ToolCall, TokenUsage, StartRunPayload, SetApprovalPayload, CancelRunPayload, ResumeRunPayload, InjectMessagePayload, ApprovalDecision } from "./contract";
import { modelFilterAllows, bgRunResumable, pushReplay, UI_OUT_CAP } from "./contract";   // single source of truth (see contract.ts)
import { runBackgroundAgent } from "./agent-host";   // design A: the background-hosted agent loop
import type { ToolMeta } from "./agent-loop";
import { externalSheetIds, googleSheetId, clipOut } from "./dom";   // track approved external sheets across a run + the choke-point grants
// The model-facing cap cdpEval clips its console to (exec's default per-slot cap) — the UI keeps far more, so
// `seen` marks where the model's copy stopped, exactly like the main-world exec path.
const CDP_EXEC_CAP = 500;
import { extractGrants } from "./grant-extract";   // button #3: static egress-grant extraction for "Approve + remember"
import { createNavBarrier } from "./nav-barrier";   // cross-page persistence: hold delegated tools while a run's tab navigates
import { isSelfSourceUrl } from "./self-source";   // trusted-side enforcement of the self-source auto-approve (uncredentialed own-repo reads)
import { BUILD_INFO } from "./build-info.gen";
import { browserInfo } from "./util";   // the fork's settings scheme (page-context Browser line)
import { ensureDebuggerAttached, releaseDebugger, cdpClick, cdpEval, cdpScreenshot, cdpShadowResolve, cdpKeyType } from "./sw-cdp";   // CDP/debugger layer (strict-CSP exec, trusted click/type, host-grant-free screenshot)
import { fetchUrlContent, fetchRenderedContent, fetchSheetCsv, SHEET_URL_OK, sheetNameFromDisposition } from "./sw-fetch";   // outbound fetch layer (ml.fetch, rendered fetch, credentialed Google Sheets CSV)
import { fetchOllamaInfo, getConfig, fetchLLM, streamLLM, streamAgentTurn, prepareRequest, residentModels, modelCapabilities, listAvailableModels, listServerTools, setModel, listLoadedModels, unloadModels } from "./sw-llm";   // LLM request/response layer (config, per-format request build, chat calls, model plumbing)


// In-flight FETCH_LLM AbortControllers, keyed by the page's requestId, so an ABORT_TASK message
// (ml.agent's signal fired) can cancel the actual fetch. Deleted when the request settles.
const inflight = new Map<string, AbortController>();

// Design A: pending background-run approvals, keyed by `${runId}:${seq}`, resolved by a SET_APPROVAL
// message the sidebar app sends (origin-authed by the shell — it only forwards a decision from the real
// extension iframe). The approve/deny decision is made here and never crosses the page: the point of A.
// Each entry keeps the resolver AND a serializable DESCRIPTOR (what's being approved) so an EXTERNAL
// approver — the `__mlApprovals` IPC channel below — can enumerate and decide gates exactly like the UI.
interface PendingApprovalDescriptor { key: string; runId: string; seq: number; step: number; tool: string; arguments: Record<string, unknown>; ts: number; routing: "ui" | "both" | "external"; }
// A gate is reachable by the external channel ONLY if its run OPTED IN (approvalRouting "both"/"external").
// A default "ui" run's gate can't be silently approved from outside — the driver must declare intent.
const externallyResolvable = (d: PendingApprovalDescriptor): boolean => d.routing === "both" || d.routing === "external";
interface PendingApproval { resolve: (d: ApprovalDecision) => void; descriptor: PendingApprovalDescriptor; }
const pendingApprovals = new Map<string, PendingApproval>();

// Resolve a pending gate by key — the SINGLE path both the origin-authed SET_APPROVAL message and the
// external `__mlApprovals` channel funnel through, so a decision from either resolves the gate everywhere
// (the same "one press resolves every surface" property, now extended to an out-of-browser approver).
// Returns false if the key is unknown (already resolved / cancelled). The stored resolver applies any side
// effects (e.g. remembering an approved sheet) and unblocks the loop.
function resolveApproval(key: string, decision: ApprovalDecision): boolean {
    const entry = pendingApprovals.get(key);
    if (!entry) return false;
    pendingApprovals.delete(key);
    entry.resolve(decision);
    return true;
}

// The EXTERNAL approval channel (idea #2). Reachable ONLY from the service-worker realm — Playwright's
// `serviceWorker.evaluate(...)` today, a desktop orchestrator via onMessageExternal / native messaging
// later — NEVER from the page main world (a web page has no chrome.runtime and can't reach this realm), so
// it grants no new power to a hostile page: it's the same unforgeable gate, opened by an automated driver
// instead of a human click. `list()` enumerates the pending gates (with what each is approving); `resolve()`
// approves/denies one by key. A driver can therefore run the whole agent HEADLESS while the browser gate
// still blocks until the driver decides. See docs / tests/e2e for the harness wiring.
(globalThis as unknown as { __mlApprovals?: unknown }).__mlApprovals = {
    // Only OPTED-IN gates (approvalRouting "both"/"external") are visible/resolvable here — a default "ui"
    // run stays human-only, so an orchestrator can't approve a run that never asked to be driven externally.
    list: (): PendingApprovalDescriptor[] => [...pendingApprovals.values()].map(v => v.descriptor).filter(externallyResolvable),
    resolve: (key: string, decision: boolean | ApprovalDecision): boolean => {
        const entry = pendingApprovals.get(key);
        if (!entry || !externallyResolvable(entry.descriptor)) return false;   // unknown, or a UI-only gate
        const norm: ApprovalDecision = (decision === true || (typeof decision === "object" && !!decision && (decision as { approved?: boolean }).approved))
            ? { approved: true, source: "external" }
            : { approved: false, feedback: (typeof decision === "object" && decision && (decision as { feedback?: string }).feedback) || undefined, source: "external" };
        return resolveApproval(key, norm);
    },
};

// Design A: the AbortController for each live background run, keyed by runId, so a CANCEL_RUN message
// (the HUD's "Cancel agent run") stops the loop at the next boundary AND kills a slow in-flight model
// call. Deleted when the run settles. Aborting resolves the loop as { cancelled: true } (partial transcript).
const runControllers = new Map<string, AbortController>();

// Design A resume (Phase 2): after a background-hosted run settles, keep enough to CONTINUE it — the
// full message history + the original StartRunPayload (deps are rebuilt from it) + the owning tab. A
// RESUME_RUN {runId, task} re-enters the loop from this history. In-memory only, so it's subject to
// MV3 service-worker eviction (~30s idle) — resume works while the SW is warm (the common
// finish-then-follow-up flow); an evicted run reports an actionable error and the caller starts fresh.
const bgRuns = new Map<string, { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("./contract").SubcallUsage }>();

// ---- Durable resume ----
// A LIVE run's resumable snapshot is also mirrored to chrome.storage.local, so a re-spawned SW (MV3 evicts
// ~30s idle) can rehydrate an in-flight run instead of losing it. Storage holds ONLY running runs — deleted
// the moment a run settles; the in-memory bgRuns above additionally keeps COMPLETED runs for a follow-up
// RESUME (still eviction-bound, as before). Snapshot shape == a bgRuns entry.
type BgRunSnap = { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("./contract").SubcallUsage; version?: string; ts?: number };
const BGRUN_KEY = (runId: string): string => `ml_bgrun_${runId}`;
// This extension build's version — stamped on every snapshot so a snapshot written by a PREVIOUS version
// (a reload/update happened) is recognised and invalidated on hydrate rather than silently resumed.
const EXT_VERSION: string = (() => { try { return chrome.runtime?.getManifest?.().version || ""; } catch { return ""; } })();
const persistRun = (runId: string, snap: BgRunSnap): void => {
    // Stamp version + a fresh timestamp on every write so hydrate can tell a live (evicted-seconds-ago) run
    // from a zombie (bgRunResumable), and reject a cross-version snapshot outright.
    try { void chrome.storage?.local?.set({ [BGRUN_KEY(runId)]: { ...snap, version: EXT_VERSION, ts: Date.now() } }); } catch { /* storage unavailable */ }
};
const deleteRun = (runId: string): void => {
    try { void chrome.storage?.local?.remove(BGRUN_KEY(runId)); } catch { /* storage unavailable */ }
};
// Purge EVERY persisted background run (storage + any already-hydrated in-memory state). Called on an
// extension install/update (a deliberate reload / a version bump): in-flight runs must NOT survive it — their
// snapshot may be from old code, and a reload is often exactly how you try to kill a runaway.
async function purgeAllBgRuns(): Promise<void> {
    try {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all || {}).filter(k => k.startsWith("ml_bgrun_"));
        if (keys.length) await chrome.storage.local.remove(keys);
    } catch { /* storage unavailable */ }
    // Drop anything hydrate already loaded this spawn so a page load can't re-adopt + resume it.
    for (const runId of [...hydratedRuns]) {
        const snap = bgRuns.get(runId);
        if (snap) untrackRun(snap.tabId, runId);
        bgRuns.delete(runId); hydratedRuns.delete(runId);
    }
    resurrectedRuns.clear();
}
// On SW startup: rehydrate any in-flight runs from storage into bgRuns + re-track them against their tab
// (activeRuns/runRebuilds) so the nav sensor + re-adopt find them. A run then continues via the existing
// resume path (page-driven today; auto-resume-on-readopt is the next slice). No-op on a first, clean spawn.
// Runs loaded from storage on THIS SW spawn = INTERRUPTED (evicted mid-flight, never settled — their storage
// snapshot outlived them). A fresh page re-adopt AUTO-RESUMES these (part 2); a run that merely COMPLETED
// (its snapshot was deleted in the finally) is not here, so it's never re-driven.
const hydratedRuns = new Set<string>();
// Runs RESURRECTED from storage after an SW respawn (hydrated → auto-resumed). CONTENT_READY moves a runId
// here as it marks the adopt `resume:true` (and clears it from hydratedRuns). RESUME_RUN reads it to know
// the surface LOST this run's session (the respawn wiped in-memory + the replay buffer), so it must RE-EMIT
// the `agent` start — a visible, Stoppable row — instead of silently resuming into a ghost.
const resurrectedRuns = new Set<string>();
async function hydratePersistedRuns(): Promise<void> {
    try {
        const all = await chrome.storage.local.get(null);
        for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith("ml_bgrun_") || !v) continue;
            const snap = v as BgRunSnap;
            const runId = snap.p?.runId;
            if (!runId || typeof snap.tabId !== "number" || bgRuns.has(runId)) continue;
            // Invalidate a snapshot from a different extension version (reload/update) or a stale one (zombie):
            // delete the storage key and never resume it. Un-stamped legacy snapshots fail the version check
            // here too — the self-heal for zombies written before this guard existed.
            if (!bgRunResumable(snap, EXT_VERSION, Date.now())) { deleteRun(runId); continue; }
            bgRuns.set(runId, snap);
            hydratedRuns.add(runId);
            if (snap.p.crossPage !== false) trackRun(snap.tabId, runId, snap.p.rebuild);
        }
    } catch { /* storage unavailable / empty */ }
}
// Resolves once the startup rehydrate is done — CONTENT_READY awaits it so a page loading right after an SW
// respawn doesn't miss the in-flight run (the respawn race).
const hydrationDone: Promise<void> = (typeof chrome !== "undefined" && chrome.storage?.local) ? hydratePersistedRuns() : Promise.resolve();

// TEST-ONLY (reachable only from the SW realm via serviceWorker.evaluate, like __mlApprovals — no page can
// reach it, and nothing in prod calls it): simulate an MV3 eviction by dropping all in-memory run state, then
// re-hydrating from storage as a respawn would. An orphaned (gate-suspended) loop is left dangling exactly as
// a real eviction leaves it — its finally never runs, so the storage snapshot survives. Lets an e2e exercise
// durable resume without waiting ~30s for a real eviction.
(globalThis as unknown as { __mlEvictForTest?: unknown }).__mlEvictForTest = async (): Promise<void> => {
    runControllers.clear(); runInboxes.clear(); bgRuns.clear(); activeRuns.clear();
    runRebuilds.clear(); runReplayBuffer.clear(); pendingApprovals.clear(); hydratedRuns.clear(); resurrectedRuns.clear(); readoptPageInfo.clear();
    await hydratePersistedRuns();
};
// TEST-ONLY: seed a minimal resumable bgRun for a tab, so a unit test can exercise the "don't wipe a tab that
// still has a recoverable run" guard (resetDebug / tabHasBgRun) without driving a whole run to completion.
(globalThis as unknown as { __mlSeedBgRunForTest?: unknown }).__mlSeedBgRunForTest = (tabId: number, runId: string): void => {
    bgRuns.set(runId, { p: { runId } as unknown as StartRunPayload, tabId, messages: [] });
};

// Per-run steering inbox (a.say() mid-run): the SW-side twin of the page loop's control.inbox. INJECT_MESSAGE
// pushes here (only the owning tab may); the run's loop drains it at each step boundary (deps.drainInbox).
// Present only while a run is live (set at start, deleted in finally).
const runInboxes = new Map<string, { tabId: number; queue: { id?: string; text: string }[] }>();

// ---- Cross-page persistence (Variant A; design tmp/cross-page-agent.md) ----
// A background-hosted run delegates each DOM tool to its tab by tabId. When the page NAVIGATES the old
// document — and the toolset it registered — is destroyed and the new document loads a fresh, EMPTY toolset;
// firing the next delegated tool into that gap hits "no active agent run on this page". The barrier holds a
// delegated send while the tab is mid-navigation and releases when the new document RE-ADOPTS the run
// (rebuilds + re-registers its toolset — the CONTENT_READY → adopt round-trip). `activeRuns` maps a tab to
// the run ids it hosts so the webNavigation sensor knows which tabs to watch. See nav-barrier.ts.
const navBarrier = createNavBarrier();
const activeRuns = new Map<number, Set<string>>();   // tabId → runIds hosted in that tab
// The rebuild-config for each LIVE cross-page run (runId → RebuildConfig), set at START and cleared in the
// run's finally. bgRuns only stores a snapshot at run COMPLETION, so a MID-run navigation reads this instead.
const runRebuilds = new Map<string, import("./contract").RebuildConfig>();
// Overlay/off REPLAY buffer (cross-page): a background-hosted, cross-page-capable run's FULL debug-event
// stream per tab, so a FRESH page after a same-site navigation can rebuild the run's card MID-run (with its
// history) instead of only catching the tail. Kept separate from the DevTools debugBuffer (further below) so
// the two surfaces' replay don't entangle. Bounded ring; cleared when the tab's runs end (untrackRun).
const runReplayBuffer = new Map<number, unknown[]>();
const REPLAY_CAP = 400;   // drop-oldest (screenshots are big)
const STREAM_EMIT_MS = 90;   // min gap between live `agent-stream` deltas — smooth enough to read, not a flood
// The destination page's pageInfo, captured on re-adopt (RUN_READOPTED) and consumed ONCE by the navigate
// tool call awaiting it — so a nav's result carries the new page's context (orient-on-nav). Keyed by tab.
const readoptPageInfo = new Map<number, string>();
// captureVisibleTab quota backoff: retry a rate-limited screenshot (~2/sec cap) rather than failing the step.
const CAPTURE_RETRIES = 5;       // ~5 tries…
const CAPTURE_RETRY_MS = 550;    // …spaced just over the 1s/2-call window → clears the transient quota
const bufferReplay = (tabId: number, event: unknown): void => {
    let buf = runReplayBuffer.get(tabId);
    if (!buf) { buf = []; runReplayBuffer.set(tabId, buf); }
    pushReplay(buf, event, REPLAY_CAP);
};
const trackRun = (tabId: number, runId: string, rebuild?: import("./contract").RebuildConfig): void => {
    const s = activeRuns.get(tabId) ?? new Set<string>();
    // A fresh run on an IDLE tab starts a clean replay buffer — drop a prior COMPLETED run's retained history
    // (see untrackRun) so a new run's replay isn't polluted by the last one's. But a RESUME of a run still in
    // bgRuns (a follow-up turn under the SAME hash) MUST keep the buffer: a resume never re-emits the `agent`
    // start, so if the turn then navigates, the destination page's card has NO session to rebuild from and
    // shows blank (the reported "HUD gone after a resume that navigates"). Same run resuming → keep; a
    // different new run → wipe.
    if (!s.size && !bgRuns.has(runId)) runReplayBuffer.delete(tabId);
    s.add(runId); activeRuns.set(tabId, s);
    if (rebuild) runRebuilds.set(runId, rebuild);
};
// True if a COMPLETED-but-resumable run still lives on this tab (bgRuns keeps a snapshot at completion for a
// follow-up resume). Such a run's HUD replay buffer must survive untrackRun so a page that loads LATE (on-click
// site access, or a reload after the run finished) can still rebuild its corner card. Dropped on tab close /
// after a one-time completed replay / when a fresh run starts.
const tabHasBgRun = (tabId: number): boolean => { for (const r of bgRuns.values()) if (r.tabId === tabId) return true; return false; };
const untrackRun = (tabId: number, runId: string): void => {
    runRebuilds.delete(runId);
    derefByRun.delete(runId);   // the run's pointers die with it — a later read must not resolve against it

    const s = activeRuns.get(tabId);
    if (!s) return;
    s.delete(runId);
    if (!s.size) {
        activeRuns.delete(tabId); navBarrier.forget(tabId); readoptPageInfo.delete(tabId);
        // Keep the replay buffer if a just-completed run is still resumable on this tab (bgRuns.set ran in the
        // run's .then, before this .finally) — a late/reloaded page replays it once (CONTENT_READY). Else drop it.
        if (!tabHasBgRun(tabId)) runReplayBuffer.delete(tabId);
    }
};
// EVERY RUN_TOOL_IN_PAGE send goes through this: it waits out any in-flight navigation on the tab before
// delegating. On a tab with no navigation pending, whenReady resolves immediately (zero cost) — so a
// single-page run is unaffected.
const delegateSend = (tabId: number, msg: unknown): Promise<any> =>
    navBarrier.whenReady(tabId).then(() => chrome.tabs.sendMessage(tabId, msg));

// The navigation SENSOR: a committed MAIN-frame navigation on a tab that hosts a live run means its document
// (and registered toolset) is going away → engage the barrier so the next delegated tool waits for re-adopt.
// Sub-frame navigations (frameId != 0) don't replace the run's document, so they're ignored.
if (typeof chrome !== "undefined" && chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((d) => {
        if (d.frameId === 0 && activeRuns.has(d.tabId)) navBarrier.noteNavigating(d.tabId);
    });
}
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => { activeRuns.delete(tabId); navBarrier.forget(tabId); readoptPageInfo.delete(tabId); fetchConsent.delete(tabId); credFetchGrants.delete(tabId); runReplayBuffer.delete(tabId); releaseDebugger(tabId); });
}

// ---- Choke-point consent (docs/spec/CHOKEPOINT_CONSENT_SPEC.md) ----
// The boundary for the credentialed/unbounded ops lives HERE, not in the bypassable client-side approval.
// A privileged call passes iff: a trusted surface (sender.tab == null), a whitelisted domain, or a per-call
// grant the design-A loop minted after an iframe approval. Grants are scoped to the approved tool's
// delegation (minted in delegateTool, cleared when it returns), keyed by (tabId, resource).
// `fetchOpen` = an approved `exec` is running: its inline `ml.fetch()` calls are allowed FOR THIS RUN (the
// human approved the code containing them). Ephemeral like the rest — cleared when the exec delegation
// returns; persisting a fetched URL for the session is the separate, explicit button-#3 path (not this).
type TabGrants = { sheets: Set<string>; pyCode: Set<string>; fetchOpen?: boolean };
const pendingGrants = new Map<number, TabGrants>();
// PERSISTENT per-tab consent for `ml.fetch` — the exact URLs the user has approved fetching this session
// (per-URL, not per-origin: the human sees + approves each). Grown ONLY inside a background run's approval
// `resolve` (unforgeable — a page can't add to it); read by the FETCH_URL handler to authorise an untrusted
// page's fetch and by `fetchNeedsConsent` to auto-approve a repeat. Cleared when the tab closes.
const fetchConsent = new Map<number, Set<string>>();
const consentFetch = (tabId: number, url: string): void => {
    let s = fetchConsent.get(tabId);
    if (!s) { s = new Set(); fetchConsent.set(tabId, s); }
    s.add(url);
};
// ONE-TIME per-URL grants for a CREDENTIALED ml.fetch (fetch-as-the-user). Minted ONLY when a `fetch_url`
// call with credentials is APPROVED, and CONSUMED on the fetch — never persisted (unlike fetchConsent), so a
// credentialed fetch ALWAYS re-prompts. `execOpen`/`fetchConsent` deliberately do NOT authorize credentialed
// (it spends the user's cookies — too sensitive for the broad exec grant or a remembered consent).
const credFetchGrants = new Map<number, Set<string>>();
const grantCredFetch = (tabId: number, url: string): void => {
    let s = credFetchGrants.get(tabId);
    if (!s) { s = new Set(); credFetchGrants.set(tabId, s); }
    s.add(url);
};
/** Consume a one-time credentialed grant for (tabId, url): true if it existed (and is now spent), else false. */
const takeCredFetch = (tabId: number | undefined, url: string): boolean => {
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
const persistGrants = (tabId: number, grants: import("./contract").PersistGrant[]): void => {
    for (const g of grants) {
        if (g.kind === "fetch-url") for (const u of g.urls) consentFetch(tabId, u);
    }
};
const grantsFor = (tabId: number): TabGrants => {
    let g = pendingGrants.get(tabId);
    if (!g) { g = { sheets: new Set(), pyCode: new Set() }; pendingGrants.set(tabId, g); }
    return g;
};

/** Hostname of the message's real sender (the browser-stamped tab URL — a page can't forge it). */
function senderHost(sender: chrome.runtime.MessageSender): string {
    try { return new URL(sender.tab?.url || sender.url || "").hostname.toLowerCase(); } catch { return ""; }
}

/** Trust tier of a message's sender: `surface` = internal extension page (fully trusted); `whitelisted` =
 *  a domain the user trusts to self-gate; `untrusted` = a page that must present a per-call grant. Uses the
 *  same origin derivation GET_CONFIG does for `pageApprovalAllowed`. */
async function senderTrust(sender: chrome.runtime.MessageSender): Promise<"surface" | "whitelisted" | "untrusted"> {
    if (sender.tab == null) return "surface";
    const host = senderHost(sender);
    const cfg = await getConfig();
    return host && (cfg.pageApprovalDomains || []).includes(host) ? "whitelisted" : "untrusted";
}

/** SSRF denylist for the uncredentialed image fetch: refuse loopback / private / link-local / metadata
 *  hosts (and non-http schemes / unparseable URLs), so a page can't probe the user's internal network
 *  through the extension's `<all_urls>` reach. */
function isBlockedFetchTarget(rawUrl: string): boolean {
    let u: URL;
    try { u = new URL(rawUrl); } catch { return true; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
    if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("::ffff:127.")) return true;   // IPv6 link-local / ULA / mapped-loopback
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = +m[1], b = +m[2];
        if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
    }
    return false;
}

// PDF-export docs awaiting their print.html tab (key → rendered HTML + its TTL timer). Kept out of the URL
// because a session doc with inlined screenshots is large; the tab fetches it by key, and it's deleted on
// read (the timer cleared then) or after a TTL so a dismissed export never leaks.
const pendingPrints = new Map<string, { html: string; timer: ReturnType<typeof setTimeout> }>();

// LIVE python_exec stdout streaming: maps a run's streamId (the page requestId) → its tabId, so a PY_STDOUT
// chunk the offscreen doc forwards can be relayed to the RIGHT page. Set when a streaming PYTHON_EXEC starts,
// deleted when it resolves. Only populated for opt-in streaming runs (a bounded, short-lived map).
const pyStreamTabs = new Map<string, number>();

// Pointer resolvers for background-hosted runs, keyed by runId — handed over by the loop at start (tokenSink)
// so a page-side tool's `ml.dereference` can read THIS run's captured outputs. Deleted when the run ends.
const derefByRun = new Map<string, (ref: string, pipe?: string) => string>();
// LIVE tool-output streaming on the BACKGROUND path: the in-flight delegated tool's onStream, keyed by runId.
// The loop delegates tool calls SEQUENTIALLY (one in flight per run), so runId alone correlates a page-posted
// PAGE_TOOL_STREAM chunk to the right callback. Set in delegateTool while a streaming call runs, deleted after.
const delegateStreams = new Map<string, (chunk: string, ts?: number) => void>();
const PRINT_DOC_TTL_MS = 60_000;
function dropPrintDoc(key: string): void {
    const e = pendingPrints.get(key);
    if (e) { clearTimeout(e.timer); pendingPrints.delete(key); }
}

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    // The content-script shell forwards each __mlDebug event here so a DevTools panel
    // (which can't see page window-messages) can mirror the overlay's stream. Fire-and-
    // forget — no response. RESET clears a tab's buffer on navigation (fresh page).
    if (message.type === "ML_DEBUG_EVENT") { if (sender.tab?.id != null) relayDebugEvent(sender.tab.id, message.event); return; }
    // Await the startup rehydrate before deciding whether to wipe: right after an SW respawn (e.g. a site-access
    // grant cycled the worker), a fresh page's ML_DEBUG_RESET can RACE hydratePersistedRuns — if it wins,
    // activeRuns/bgRuns are still empty and it wipes an interrupted run's session before it's re-tracked.
    if (message.type === "ML_DEBUG_RESET") { const tid = sender.tab?.id; if (tid != null) void hydrationDone.then(() => resetDebug(tid)); return; }
    // DevTools-panel hover-highlight reverse channel: the panel (a devtools page) can't reach the
    // inspected page, so it asks us to relay its highlight request to that tab's content-script shell,
    // which draws the box. Only the extension can call a typed background message like this — a web page
    // has no chrome.runtime path to it — and drawing is a read-only pointer-events:none overlay anyway.
    if (message.type === "ML_HL_REMOTE" && typeof message.tabId === "number") {
        try { void chrome.tabs.sendMessage(message.tabId, { type: "ML_HL_REMOTE", ref: message.ref }).catch(() => {}); } catch { /* tab gone */ }
        return;
    }
    // DevTools session composer → the inspected tab's shell → the page's handle registry (say/run/cancel).
    // The panel is an extension page (can chrome.runtime.sendMessage); the inspected page has no such path,
    // so it can't forge this. Same relay shape as ML_HL_REMOTE.
    if (message.type === "ML_SESSION_REMOTE" && typeof message.tabId === "number") {
        try { void chrome.tabs.sendMessage(message.tabId, { type: "ML_SESSION_TO_PAGE", action: message.action, hash: message.hash, text: message.text, images: message.images }).catch(() => {}); } catch { /* tab gone */ }
        return;
    }
    // PDF export prints from a REAL browser tab, not the sidebar app's own frame: window.print() is
    // suppressed for a frame inside DOCKED DevTools (the panel surface), so PDF export there silently did
    // nothing (markdown export worked — it downloads via <a download>). The app (either surface) posts its
    // rendered doc here; we stash it and open a bundled print.html tab keyed to it, which renders + prints +
    // closes itself. A page can't usefully abuse this — it prints an extension-rendered doc into its OWN tab.
    if (message.type === "PRINT_SESSION" && typeof message.payload?.html === "string") {
        const key = Math.random().toString(36).slice(2, 10);
        const timer = setTimeout(() => pendingPrints.delete(key), PRINT_DOC_TTL_MS);   // never leak a doc whose tab never fetched it
        pendingPrints.set(key, { html: message.payload.html, timer });
        chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?k=${key}`), active: true }).catch(() => dropPrintDoc(key));
        return;
    }
    // print.html fetches its doc ONCE, by key (deleted on read, TTL timer cleared — one tab, one fetch).
    if (message.type === "GET_PRINT_DOC" && typeof message.k === "string") {
        const entry = pendingPrints.get(message.k);
        dropPrintDoc(message.k);
        sendResponse({ html: entry ? entry.html : null });
        return;   // synchronous response
    }
    // print.html closes its own tab after printing (belt-and-suspenders to its window.close()).
    if (message.type === "CLOSE_PRINT_TAB") {
        if (sender.tab?.id != null) chrome.tabs.remove(sender.tab.id).catch(() => {});
        return;
    }
    if (message.type === "SET_APPROVAL") {
        // The surface's approve/deny for a pending background-run gate. Reaches here only from a TRUSTED
        // extension context: the content-script shell (overlay) or panel.ts (devtools) — each forwards it
        // ONLY for a message from the real extension-iframe app (e.source === frame). A web page can't
        // forge it: it's not an extension context (can't chrome.runtime.sendMessage), and SET_APPROVAL is
        // not a content-relayed HANDLE_MAP type — so a page-set window.confirm / hostile approve() can't
        // reach here even though the page knows its own runId. Design A's crux.
        const p = message.payload as SetApprovalPayload;
        resolveApproval(`${p.runId}:${p.seq}`, p.decision ? { approved: true, source: "user", persist: p.persist } : { approved: false, feedback: p.feedback, source: "user" });
        return;   // fire-and-forget
    }
    if (message.type === "CONTENT_READY") {
        // Cross-page persistence: a fresh document loaded in a tab. If it still hosts live cross-page run(s),
        // reply with each run's rebuild-config so the new page re-adopts (rebuilds + re-registers its
        // toolset). A fresh content script on a tab with active runs MEANS the document was replaced (the old
        // page is gone), so this fires the re-adopt regardless of the barrier's exact state. Empty otherwise.
        const tabId = sender.tab?.id;
        // Await the startup rehydrate first — a page loading right after an SW respawn must see the in-flight
        // runs storage restored, or it would miss the re-adopt + auto-resume.
        void hydrationDone.then(() => {
            const ids = tabId != null ? activeRuns.get(tabId) : undefined;
            // `resume` marks an INTERRUPTED (evicted) run — the fresh page auto-continues it (durable resume).
            const adopt: { runId: string; rebuild: import("./contract").RebuildConfig; resume?: boolean }[] = [];
            const seen = new Set<string>();
            const addAdopt = (runId: string, rebuild: import("./contract").RebuildConfig): void => {
                if (seen.has(runId)) return;
                seen.add(runId);
                const resume = hydratedRuns.has(runId) && !runControllers.has(runId);   // evicted & not running → re-drive
                if (resume) { hydratedRuns.delete(runId); resurrectedRuns.add(runId); }   // auto-resume ONCE; RESUME_RUN re-emits its `agent` start
                adopt.push({ runId, rebuild, resume: resume || undefined });
            };
            if (ids) for (const runId of ids) { const rebuild = runRebuilds.get(runId); if (rebuild) addAdopt(runId, rebuild); }
            // ALSO re-adopt recently-COMPLETED-but-resumable runs on this tab (bgRuns): a HUD run that navigated
            // and then FINISHED (its fast final answer needs no delegation, so the loop never waits for the new
            // page) would otherwise leave the destination page with no resume handle — and a composer follow-up
            // would be dropped. Re-adopting registers the toolset + the by-hash resume handle. (Not `resume`:
            // a completed run isn't in hydratedRuns, so it re-adopts but doesn't auto-re-drive.)
            if (tabId != null) for (const [runId, snap] of bgRuns) {
                if (snap.tabId === tabId && snap.p.rebuild) addAdopt(runId, snap.p.rebuild);
            }
            sendResponse({ adopt });
            // Overlay/off HUD replay-across-nav: stream the run's buffered history so the fresh card/overlay
            // rebuilds MID-run (start + every step so far), not just post-nav events. The shell buffers these
            // __mlFromBg events while its iframe mounts, absorbing an ordering race against the handshake.
            // Fires for a LIVE run (every nav) AND — the on-click/late-injection fix — for a page that loads
            // AFTER the run finished: a completed run re-adopted from bgRuns replays its history ONCE so the
            // destination page still gets its card + final answer (else the corner card is blank there).
            const hasActive = !!(ids && ids.size);
            if (tabId != null && adopt.length) {
                const history = runReplayBuffer.get(tabId) || [];
                if (history.length) {
                    for (const event of history) chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
                    // A COMPLETED-only re-adopt (no live run) has served its purpose — drop the buffer so a later
                    // reload doesn't re-show a finished card. A live run keeps its buffer for the next nav.
                    if (!hasActive) runReplayBuffer.delete(tabId);
                }
            }
        });
        return true;   // async: sendResponse fires after hydration resolves
    }
    if (message.type === "RUN_READOPTED") {
        // The fresh document re-registered a run's toolset → release the navigation barrier so the held
        // delegated tool runs against the new page. Keyed by tab (the barrier is per-tab). Fire-and-forget.
        const tabId = sender.tab?.id;
        const pageInfo = (message.payload as { pageInfo?: string })?.pageInfo;
        if (tabId != null) {
            // Stash the new page's context BEFORE releasing the barrier, so the `navigate` tool call awaiting
            // re-adoption reads it and folds it into its result (orient-on-nav — see the navigate branch below).
            if (pageInfo) readoptPageInfo.set(tabId, pageInfo);
            navBarrier.noteReadopted(tabId);
        }
        return;
    }
    if (message.type === "CANCEL_RUN") {
        // The HUD's "Cancel agent run" (relayed by the trusted content-script shell). Abort the run's
        // controller → the loop stops at the next boundary and resolves { cancelled: true }; the model
        // call in flight is aborted too. A page can't forge this (no chrome.runtime path), and even a
        // forged cancel only aborts that page's own run — harmless.
        const runId = (message.payload as CancelRunPayload)?.runId;
        const ctl = runControllers.get(runId);
        if (ctl) ctl.abort();
        // If the run is BLOCKED on an OPEN approval gate, aborting the controller alone can't unblock it — the
        // gate promise only resolves via SET_APPROVAL. So resolve any pending gate for this run now with an
        // explicit CANCELLATION (`{ approved:false, cancelled:true }`), NOT a bare `false`: the loop then exits
        // as cancelled even when the controller is GONE (an evicted/re-adopted run, where `ctl` above is
        // undefined so the signal never aborts). A bare `false` there read as a DENY → the loop stepped on
        // forever ("auto-denied + can't Stop", the reported bug). A later SET_APPROVAL click finds no entry — a
        // harmless no-op.
        for (const [key, entry] of [...pendingApprovals]) {
            if (key.startsWith(`${runId}:`)) { pendingApprovals.delete(key); entry.resolve({ approved: false, cancelled: true }); }
        }
        return;   // fire-and-forget
    }
    if (message.type === "CANCEL_ALL_RUNS") {
        // The popup's "Stop all agent runs" panic button — the guaranteed kill switch for a runaway that has
        // no visible surface (e.g. a resumed run whose card never mounted). Abort every live controller,
        // resolve every open approval gate, and purge all persisted snapshots so nothing re-adopts + resumes.
        const n = runControllers.size;
        for (const [, ctl] of [...runControllers]) { try { ctl.abort(); } catch { /* already gone */ } }
        for (const [key, entry] of [...pendingApprovals]) { pendingApprovals.delete(key); try { entry.resolve(false); } catch { /* gone */ } }
        void purgeAllBgRuns();
        sendResponse({ data: { cancelled: n } });
        return true;
    }
    if (message.type === "CDP_CLICK") {
        // Click a RESERVED surface (cross-origin iframe / declarative-or-native closed shadow) at a viewport
        // coordinate via CDP — the only mechanism that reaches it with a trusted, hit-tested event.
        // CHOKE-POINT: this is privileged (attaches the debugger) so it must NOT be page-forgeable. An
        // UNTRUSTED page is refused; a `surface` (internal extension page — the approval UI) or a
        // `whitelisted` origin (the user trusts it to self-gate) may initiate it, and the per-click approval
        // still governs upstream. Gated behind the off-by-default `cdpClick` flag. A page targets only its
        // OWN tab (sender.tab.id); a surface passes the inspected tabId in the payload.
        (async () => {
            const cfg = await getConfig();
            if (!cfg.cdp) { sendResponse({ error: "Debugger-based actions (CDP) are off — enable them in window.ml Settings → Advanced." }); return; }
            if (await senderTrust(sender) === "untrusted") { sendResponse({ error: "Refused: a reserved-element (CDP) click can't be initiated by this page." }); return; }
            const p = (message.payload || {}) as { x?: number; y?: number; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;   // a page → its own tab; a trusted surface → the payload's
            if (typeof tabId !== "number" || typeof p.x !== "number" || typeof p.y !== "number") { sendResponse({ error: "CDP_CLICK needs a tab and numeric x/y." }); return; }
            sendResponse(await cdpClick(tabId, p.x, p.y));
        })();
        return true;   // async
    }
    if (message.type === "CDP_SHADOW_RESOLVE") {
        // READ-ONLY resolve of a `>>>` selector across sealed (closed/declarative) shadow roots via CDP — the
        // discovery half of the sealed-shadow reach (describeElement inside a host the JS path can't enter).
        // Gated on the off-by-default `cdp` flag (the debugger banner is the visible signal); a page targets
        // only its OWN tab. NOT senderTrust-gated: it only READS same-document, same-origin content the page's
        // own server authored (no cross-origin gain), and its output (describe lines + coordinates) is not
        // actionable on its own — CDP_CLICK stays untrusted-refused, and a synthetic click on a sealed host
        // can't reach the inner control. The privileged CLICK still flows through the trusted envelope path.
        (async () => {
            const cfg = await getConfig();
            if (!cfg.cdp) { sendResponse({ error: "Debugger-based actions (CDP) are off — enable them in window.ml Settings → Advanced to reach sealed shadow roots." }); return; }
            const p = (message.payload || {}) as { selector?: string; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;
            if (typeof tabId !== "number" || typeof p.selector !== "string") { sendResponse({ error: "CDP_SHADOW_RESOLVE needs a tab and a selector." }); return; }
            const r = await cdpShadowResolve(tabId, p.selector);
            sendResponse("error" in r ? { error: r.error } : { data: r.matches });
        })();
        return true;   // async
    }
    if (message.type === "INJECT_MESSAGE") {
        // a.say() steering a RUNNING background run: push the text into that run's inbox → the loop drains it
        // at the next step boundary. Only the OWNING tab may steer; an unknown/finished run is a no-op (the
        // page's run()-flush safety net picks up anything that lands too late).
        const p = message.payload as InjectMessagePayload;
        const inbox = runInboxes.get(p.runId);
        const injected = !!(inbox && inbox.tabId === sender.tab?.id && typeof p.text === "string");
        if (injected) inbox!.queue.push({ id: p.sayId, text: p.text });
        sendResponse({ data: injected });
        return true;
    }
    if (message.type === "START_RUN" || message.type === "RESUME_RUN") {
        // Design A: run an ml.agent loop HERE (extension origin), delegating each tool back to the page
        // (RUN_TOOL_IN_PAGE) and gating approval through the sidebar. The page built the toolset + system
        // prompt (it has the DOM/config/factories) and registered the live tools under runId; we hold only
        // serializable descriptors. sender.tab.id is the delegation + debug-fanout target.
        const tabId = sender.tab?.id;
        if (tabId == null) { sendResponse({ error: `${message.type} must come from a tab (content script).` }); return true; }
        // RESUME continues a stored run: reuse its original StartRunPayload (deps rebuild from it) + its
        // accumulated history, overriding only the task with the follow-up. Only the owning tab may resume.
        let p: StartRunPayload;
        let resumeMessages: NeutralMessage[] | undefined;
        let priorSub: import("./contract").SubcallUsage | undefined;   // a resumed session's accumulated sub-call spend
        let resumeOriginalTask: string | undefined;   // the run's ORIGINAL task (rp.task is the follow-up; empty on an auto-resume)
        if (message.type === "RESUME_RUN") {
            const rp = message.payload as ResumeRunPayload;
            const stored = bgRuns.get(rp.runId);
            if (!stored) { sendResponse({ error: `No resumable run "${rp.runId}" in the background — it may have been evicted; start a new run.` }); return true; }
            if (stored.tabId !== tabId) { sendResponse({ error: `Run "${rp.runId}" belongs to another tab.` }); return true; }
            p = { ...stored.p, task: rp.task };
            resumeOriginalTask = stored.p.task;
            resumeMessages = stored.messages;
            priorSub = stored.sub;
        } else {
            p = message.payload as StartRunPayload;
            // A createAgent handle sends its prior history (control.messages) so the background CONTINUES
            // it — the page stays authoritative across turns, and the updated history rides back below.
            resumeMessages = p.resumeMessages;
            // A handle's 2nd+ turn re-enters via START_RUN (NOT RESUME_RUN), so seed the sub-call tally from
            // the stored run too — else subTally resets to 0 each turn and chat_metadata reports "none" on a
            // continued turn even after prior turns spent thousands (the UI chip hid this: it reads the last
            // non-empty step, which still holds the prior turn's total). First turn → no stored run → 0.
            priorSub = bgRuns.get(p.runId)?.sub;
        }
        const runId = p.runId;
        const stepBase = p.stepBase || 0, seqBase = p.seqBase || 0;   // offsets for a handle's continued turns
        let runMaxStep = 0, runMaxSeq = 0;   // this run's max step/seq (raw) → returned so the page advances its bases
        // The session's DELEGATED vision sub-call spend, summed from each delegated tool's envelope delta (the
        // page meters it in bus.ts; the SW can't read that, so each call reports its own). Feeds chat_metadata
        // + the UI "+N sub" chip on the background path, matching the page loop. CUMULATIVE across the session:
        // seeded from the resumed run's stored tally (a per-turn reset would make chat_metadata report "none"
        // on a turn that hadn't yet made a sub-call, even after prior turns spent thousands), persisted below.
        const subTally = { prompt: priorSub?.prompt || 0, completion: priorSub?.completion || 0, calls: priorSub?.calls || 0 };
        // Per-vision-model breakdown of the tally (chat_metadata "which model cost what"), seeded from the
        // resumed run's stored breakdown and merged from each delegated tool's byModel delta. A Map for O(1)
        // merge; snapSub() flattens it to a plain SubcallUsage for events/storage (deep — no shared refs).
        const subByModel = new Map<string, { prompt: number; completion: number; calls: number }>();
        for (const bm of priorSub?.byModel || []) subByModel.set(bm.model, { prompt: bm.prompt, completion: bm.completion, calls: bm.calls });
        const addSub = (s: import("./contract").SubcallUsage | undefined): void => {
            if (!s || !s.calls) return;
            subTally.prompt += s.prompt; subTally.completion += s.completion; subTally.calls += s.calls;
            for (const bm of s.byModel || []) {
                const cur = subByModel.get(bm.model) || { prompt: 0, completion: 0, calls: 0 };
                cur.prompt += bm.prompt; cur.completion += bm.completion; cur.calls += bm.calls; subByModel.set(bm.model, cur);
            }
        };
        // Serialized visuals of `answer`-designated elements (data URLs), accumulated from each delegated
        // answer envelope → attached to the run's result + agent-result for the HUD completion card.
        const runAnswerMedia: import("./contract").AnswerMedia[] = [];
        // Flatten the tally to a serializable SubcallUsage (fresh objects → safe to store/emit repeatedly).
        const snapSub = (): import("./contract").SubcallUsage => ({
            ...subTally,
            ...(subByModel.size ? { byModel: [...subByModel.entries()].map(([model, u]) => ({ model, ...u })) } : {}),
        });
        const abortCtl = new AbortController();   // CANCEL_RUN aborts this → the loop resolves { cancelled }
        // Set once this run's page navigates: the page-side caller that normally emits the lifecycle
        // agent/agent-result (overlay/devtools) is then GONE (its context died with the old document), so the
        // BACKGROUND must fan the terminal result to the destination page instead — else the run finishes but
        // no surface ever learns it did (the observer/HUD sat on "running"). See emitLifecycle below.
        let hasNavigated = false;
        runControllers.set(runId, abortCtl);
        runInboxes.set(runId, { tabId, queue: [] });   // a.say() steering lands here while the run is live
        // Register the run against its tab so the navigation sensor watches it — UNLESS the run opted out of
        // cross-page persistence (navigate: false), in which case a nav simply ends it (no barrier, no adopt).
        if (p.crossPage !== false) trackRun(tabId, runId, p.rebuild);
        // Durable resume: snapshot the run NOW (before the first step) + after each step (the checkpoint dep),
        // so an SW evicted mid-run rehydrates from storage. Cleared when the run settles (finally).
        persistRun(runId, { p, tabId, messages: resumeMessages || [], sub: snapSub() });
        const toolMetas: ToolMeta[] = p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, capabilities: t.capabilities }));
        const toolDefs = p.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
        const approvedSheets = new Set<string>();   // external sheets approved this run (isSheetApproved)
        // Cross-origin navigation consent: origins this run may navigate to WITHOUT re-prompting — seeded
        // with the start origin, and each cross-origin nav the user approves is added (so repeat navs to it
        // skip the gate). A run that didn't opt into crossOrigin never gates (its tool refuses cross-origin).
        const consentedOrigins = new Set<string>();
        if (p.pageOrigin) consentedOrigins.add(p.pageOrigin);
        const navNeedsConsent = (url: string): boolean => {
            if (!p.crossOrigin) return false;   // can't cross origins → tool refuses cross-origin; same-site fine → no gate
            try {
                if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return false;   // relative → same-origin
                const dest = new URL(url.startsWith("//") ? "https:" + url : url);
                return !consentedOrigins.has(dest.origin);   // a NEW cross-origin → gate; an already-consented one → no
            } catch { return false; }   // unparseable → the tool will error; no pointless gate
        };
        // Debug fan-out for this run → the active surface.
        //  · overlay: re-post to the PAGE window (ML_DEBUG_TO_PAGE → content.js → the shell → the iframe
        //    app), where the overlay app is mounted.
        //  · devtools: there's no iframe app on the page — fan straight to the panel via relayDebugEvent
        //    (→ the ml-devtools ports + the per-tab replay buffer, so a panel opened mid-run catches up).
        //    The page-emitted `agent`/`agent-result` events already reach the panel via the shell's
        //    __mlDebug→ML_DEBUG_EVENT forward; this covers the background-emitted agent-STEP events.
        // Fan a run's step events to the page. overlay AND off both stream to the page window
        // (ML_DEBUG_TO_PAGE → the shell → the iframe app) — off renders them in the corner CARD, a
        // curated view of the same data; devtools fans to the panel. The card mounts itself lazily on the
        // first of these (tagged `__mlFromBg` by content.ts) and self-reveals for a pending gate / the
        // final answer, so a no-approval off run streams to a hidden, cheap-to-mount card.
        const emitStep = (ev: Record<string, unknown>): void => {
            // Once the run is aborted (CANCEL_RUN), stop fanning steps: an in-flight tool's DONE resolves
            // AFTER the abort (the page tool round-trip isn't cancellable), and a straggler landing after the
            // page's cancelled result would wrongly re-show "running" in the panel. Drop it at the source.
            if (abortCtl.signal.aborted) return;
            // Offset this turn's step/seq past the handle's prior turns so the sidebar's turn groups stay
            // distinct (the background twin of the page loop's control.stepBase/seqBase). Track the raw max
            // so the page can advance its bases for the next turn (returned in the response below).
            const rawStep = (ev.step as number) || 0;
            if (rawStep > runMaxStep) runMaxStep = rawStep;
            const rawSeq = ev.seq as number | undefined;
            if (rawSeq != null && rawSeq > runMaxSeq) runMaxSeq = rawSeq;
            const step = stepBase + rawStep;
            const seq = rawSeq != null ? seqBase + rawSeq : rawSeq;
            const event = {
                kind: "agent-step", id: runId, ts: Date.now(), save: false,
                session: { hash: runId, turn: step }, ...ev, step, localStep: rawStep, seq,
                // Running per-turn delegated-sub-call tally so the UI "+N sub" chip works on the background
                // path too (the page path attaches subcallUsage() the same way). Omit when nothing delegated.
                ...(subTally.calls ? { subUsage: snapSub() } : {}),
            };
            // Always fan to the PAGE (overlay / off card). For devtools ALSO fan to the panel — and the
            // page fan lets the optional corner card coexist with the panel (agentHudInDevtools); the
            // shell drops the page copy when no card is mounted, and never loops it back to the panel.
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone / no receiver */ });
            // ALWAYS feed a connected DevTools panel (no-op if none). A background-hosted run is the SOLE source
            // of its events — the shell tags them __mlFromBg and never re-forwards them as ML_DEBUG_EVENT, so
            // this can't double-relay. Gating on `surface === "devtools"` left an off/card run's panel (if the
            // user also has one open) stuck on the connect-time replay — the "panel stopped updating" bug.
            relayDebugEvent(tabId, event);
            // Cross-page: remember this step so a fresh page after a nav can rebuild the card mid-run.
            if (p.crossPage !== false) bufferReplay(tabId, event);
        };
        // Fan a lightweight run event verbatim (no step/seq offset) to every surface — used for the
        // "seen" indicator (agent-say-seen), which keys off its own id, not a step position.
        const fanEvent = (event: Record<string, unknown>): void => {
            if (abortCtl.signal.aborted) return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            relayDebugEvent(tabId, event);   // always feed a connected panel (see emitStep — no double, no-op if none)
            if (p.crossPage !== false) bufferReplay(tabId, event);
        };
        // OFF mode: the corner card is fed ENTIRELY by this background stream, because the page's own
        // debug bus (bus.ts) stays dormant in off mode — no `present` handshake, so its emitDebug is a
        // no-op and off mode keeps its zero-cost footprint until a privileged run actually starts. So for
        // OFF we emit the run's lifecycle (start + result) here too; overlay gets them from the page's bus
        // and devtools from the panel forward, so emitting them here as well would double up — off only.
        const emitLifecycle = (event: Record<string, unknown>): void => {
            // Buffer FIRST (before any fan decision) so the replay stream includes the `agent` start + result
            // even on an overlay run where the page-side caller — not this — is what fans them live. Without
            // the start event a re-adopted card can't rebuild the session.
            if (p.crossPage !== false) bufferReplay(tabId, event);
            // "off": the page-side caller emits nothing, so the background always fans lifecycle events.
            // overlay/devtools: the caller normally emits them page-side (incl. the panel, via the shell
            // forwarder) — EXCEPT once the run has navigated, when that caller's context is gone, so the
            // background fans to the destination page instead. UNLIKE per-step events (background-only source),
            // lifecycle is ALSO emitted page-side here, so relaying it below early would DOUBLE in the panel.
            if (p.surface !== "off" && !hasNavigated) return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            // We're the SOLE fanner in this branch (off, or overlay/devtools post-nav), so feed a connected panel
            // too — regardless of surface. Gating on `devtools` left an off/card run's answer never reaching a
            // connected panel (stuck on "running"). No double (page-side isn't fanning here); no-op without a panel.
            relayDebugEvent(tabId, event);
        };
        // Only a FRESH run announces the session start; a RESUME continues an existing sidebar/card
        // session (re-emitting `agent` would wipe its accumulated steps), so it streams new steps + a
        // fresh agent-result under the same hash instead. EXCEPTION (fix C): a run RESURRECTED from storage
        // after an SW respawn has NO surface session anymore (memory + replay buffer were wiped), so it must
        // re-announce — else it drives INVISIBLY with no Stop button (the runaway-run bug). Use the ORIGINAL
        // task (rp.task is the empty auto-resume follow-up), and fanEvent (not emitLifecycle, whose overlay/
        // devtools gate would suppress it) so the row appears on every surface. The reducer's don't-wipe merge
        // makes this safe if a stray session somehow survived.
        const resurrected = resurrectedRuns.has(runId);
        resurrectedRuns.delete(runId);
        const startEvent = {
            kind: "agent", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
            task: resurrected ? (resumeOriginalTask ?? p.task) : p.task, model: p.model, maxSteps: p.maxSteps,
            resumed: resurrected || undefined,   // the sidebar can mark it "resumed after interruption"
            config: {
                system: p.systemPrompt, customSystem: false,
                tools: p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, vision: t.capabilities.includes("vision"), description: t.description, parameters: t.parameters, summary: t.summary })),
                maxSteps: p.maxSteps, think: p.think, env: true, vision: null, hints: null, unattended: p.unattended, silent: p.silent,
                stream: p.stream,
            },
        };
        if (!resumeMessages) emitLifecycle(startEvent);
        else if (resurrected) fanEvent(startEvent);   // resurrected: no page-side caller emitted a start → fan it ourselves
        runBackgroundAgent(
            { task: p.task, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython, autoApproveSameOriginAuth: p.autoApproveSameOriginAuth, autoApproveSelfSource: p.autoApproveSelfSource, unattended: p.unattended, toolTokens: p.toolTokens, stream: p.stream, runId, seqBase, resumeMessages, images: p.images },
            {
                callModel: async (messages, opts) => {
                    // Thread the run's abort signal so a CANCEL_RUN kills a slow in-flight generation, not
                    // just stops at the next step boundary.
                    if (p.stream) {
                        // Opt-in streaming: emit the thinking/reply LIVE (throttled) so a long reasoning phase
                        // shows its text instead of a frozen token count. streamAgentTurn accumulates tool_calls
                        // too, so the loop still gets its authoritative { content, tool_calls } at the end.
                        const rawStep = (opts?.step as number) || 0, step = stepBase + rawStep;
                        let last = 0;
                        const flush = (acc: { reasoning: string; content: string }): void => {
                            if (abortCtl.signal.aborted) return;
                            last = Date.now();
                            fanEvent({ kind: "agent-stream", id: runId, ts: last, save: false, session: { hash: runId, turn: step }, step, localStep: rawStep,
                                ...(acc.reasoning ? { reasoning: acc.reasoning } : {}), ...(acc.content ? { content: acc.content } : {}) });
                        };
                        const r = await streamAgentTurn({ messages, tools: toolDefs, model: p.model, think: p.think },
                            (acc) => { if (Date.now() - last >= STREAM_EMIT_MS) flush(acc); }, abortCtl.signal);
                        flush({ reasoning: r.reasoning || "", content: r.content || "" });   // final: land the last delta even if throttled
                        return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                    }
                    const r = await fetchLLM({ messages, tools: toolDefs, model: p.model, think: p.think, raw: true }, abortCtl.signal) as { content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null };
                    return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                },
                delegateTool: async (name, args, onStream) => {
                    // Live output: register this call's stream sink under the runId so a PAGE_TOOL_STREAM chunk
                    // the page posts mid-run reaches the loop's throttled fan. Cleared in the finally below.
                    if (onStream) delegateStreams.set(runId, onStream);
                    // Reaching here means the call is AUTHORIZED (approved / auto / cached alike). Mint the
                    // choke-point grants for the privileged sub-ops this tool will make, bound to the exact
                    // resources in its args — an untrusted page's FETCH_SHEET / full PYTHON_EXEC checks them.
                    // Scoped to this delegation: cleared in `finally`, so a later call needs its own approval.
                    // An APPROVED exec may fetch inline (ml.fetch): the human saw the code, so allow its fetches
                    // for THIS run (ephemeral — cleared below). Persisting a URL is button #3, not this.
                    if (name === "exec") grantsFor(tabId).fetchOpen = true;
                    if (name === "python_exec") {
                        const g = grantsFor(tabId);
                        for (const id of externalSheetIds(args)) g.sheets.add(id);
                        if ((args as { mode?: string }).mode === "full") g.pyCode.add(String((args as { code?: unknown }).code ?? ""));
                    }
                    try {
                        // A delegated call can race a NAVIGATION — the tool's own action submits a form / follows a
                        // link, or the page redirects mid-call (common after an approval gate holds the call: e.g.
                        // google.com settling while `type` waited to be approved). The content script's channel then
                        // closes and Chrome's raw "message channel closed…" error is useless to the model. RECOGNISE
                        // it as a navigation: wait for the new document to settle (re-adopt) and hand back the new
                        // page's context — actionable, and safe (no blind retry that could double-submit a form).
                        const CHANNEL_GONE = /message channel closed|Receiving end does not exist|No tab with id/i;
                        let env: Partial<import("./contract").PageToolEnvelope>;
                        try {
                            env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, stream: !!onStream } }) as Partial<import("./contract").PageToolEnvelope>;
                        } catch (e) {
                            const emsg = (e as Error)?.message || String(e);
                            if (!CHANNEL_GONE.test(emsg)) {
                                env = { result: `Error: could not reach the page to run "${name}" (${emsg}).` };
                            } else {
                                // The page navigated out from under the call. Its pageInfo may already be here (a fast
                                // re-adopt beat us); else engage the barrier and wait for it (bounded by the barrier's
                                // own timeout, then a generic "still loading" note).
                                let info = readoptPageInfo.get(tabId);
                                if (!info) { navBarrier.noteNavigating(tabId); await navBarrier.whenReady(tabId); info = readoptPageInfo.get(tabId); }
                                readoptPageInfo.delete(tabId);
                                hasNavigated = true;   // the run moved pages → the terminal result must fan to the new page
                                env = { result: `The page navigated while running "${name}" — the action triggered a navigation, or the page redirected mid-call.${info ? `\n\nYou are now on the new page:\n${info}` : " The new page is still loading — wait, then look."}\n\nNOTE: "${name}" may NOT have taken effect on the previous page. Verify the CURRENT page (look / findByText) and re-run "${name}" here if the change didn't happen.` };
                            }
                        }
                        addSub(env?.subUsage);   // this tool's own delegated vision sub-call spend (look/locate)
                        if (env?.answerMedia?.length) runAnswerMedia.push(...env.answerMedia);   // answer's element visuals → HUD card
                        // Cross-page: the `navigate` tool DEFERS the real location change a tick, so its result
                        // returns before the document unloads. Engage the barrier NOW — not only via the async
                        // webNavigation.onCommitted, which can lose the race to the loop's next (fast, local)
                        // model call + tool delegation, letting the next tool fire into the dying document.
                        // The next delegateSend then waits for the new page to re-adopt. Skip an errored nav.
                        if (name === "navigate" && !String(env?.result || "").startsWith("Error")) {
                            navBarrier.noteNavigating(tabId); hasNavigated = true;
                            // Orient-on-nav: WAIT for the new document to re-adopt, then fold its pageInfo into
                            // THIS tool's result — so the model's next turn already knows where it landed instead
                            // of spending a look()/pageInfo turn to find out. The barrier's own timeout is the
                            // fallback (a nav that never re-adopts → whenReady resolves, no pageInfo → plain result).
                            if (env) {
                                await navBarrier.whenReady(tabId);
                                const info = readoptPageInfo.get(tabId); readoptPageInfo.delete(tabId);
                                if (info) env.result = `${env.result || ""}\n\nYou are now on the new page:\n${info}`;
                                // verify → fold a view of the DESTINATION page into the result, captured on the NEW
                                // page after re-adopt (same await path as the click/type verify). "viewport" (or
                                // legacy true) = a SCREENSHOT (vision inline / a delegated description for a text
                                // driver); "text" / "text-all" = the page distilled to MARKDOWN (fetch_url's HTML→MD;
                                // cheaper, no vision — "text" strips nav/chrome, "text-all" keeps it). Best-effort.
                                const rawVerify = (args as { verify?: unknown })?.verify;
                                const verify = rawVerify === true ? "viewport" : typeof rawVerify === "string" ? rawVerify : null;
                                // `pipe` scans the text-verify Markdown (text/text-all only) — threaded to the page.
                                const navPipe = typeof (args as { pipe?: unknown })?.pipe === "string" ? (args as { pipe: string }).pipe : undefined;
                                if (verify && !navBarrier.isNavigating(tabId)) {
                                    const payload = verify === "text" ? { runId, verifyText: "strip" as const, verifyPipe: navPipe }
                                        : verify === "text-all" ? { runId, verifyText: "all" as const, verifyPipe: navPipe }
                                        : { runId, verifyViewport: true };
                                    const v = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                    if (v && (v.image || v.feedback || v.result)) {
                                        if (v.result) env.result = `${env.result || ""}\n\n${v.result}`;
                                        env.image = v.image; env.imageLabel = v.imageLabel; env.feedback = v.feedback;
                                        addSub(v.subUsage);
                                    }
                                }
                                // `pipe` only filters the TEXT verify — if it was passed WITHOUT verify:"text"/"text-all"
                                // (a "viewport" screenshot, or no verify at all), say so instead of silently dropping it.
                                if (navPipe && verify !== "text" && verify !== "text-all" && env)
                                    env.result = `${env.result || ""}\n\n(Note: your \`pipe\` was NOT applied — it filters only the verify:"text"/"text-all" Markdown. ${verify === "viewport" ? "You requested a \"viewport\" screenshot, which can't be piped." : "You didn't request a text verify."} Re-navigate with verify:"text" to use it.)`;
                            }
                        }
                        // RESERVED-surface click: the page couldn't synth-click a cross-origin iframe / sealed
                        // shadow target and handed back a CDP-click coordinate. The click was ALREADY approved
                        // above, and the trusted background performs the CDP click (the page can't). Gated on
                        // the off-by-default `cdpClick` flag (cdpClick() itself checks the debugger permission).
                        if (env?.cdpClick) {
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nThis needs a debugger (CDP) click, which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced (cross-origin iframes / sealed shadow roots).`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpClick(tabId, env.cdpClick.x, env.cdpClick.y);
                            const ok = "ok" in r;
                            if (!ok) return { result: (r as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                            // The click succeeded. If `verify` was asked, ring the PAGE back to capture the area at
                            // the click point NOW (it couldn't run inline — the click was deferred to us). Merge its
                            // image/description/feedback so the model gets the result in THIS step, not a stray look().
                            let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                            if (env.cdpClick.verify) {
                                const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyAt: { x: env.cdpClick.x, y: env.cdpClick.y } } })
                                    .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                            }
                            // Append the page-side stuck-loop re-snap nudge (a repeat @pt click) to the SUCCESS result.
                            const tail = env.cdpClick.verify ? "" : " Re-run look to see the result.";
                            return { result: `Clicked the reserved target at (${env.cdpClick.x}, ${env.cdpClick.y}) via the debugger.${tail}${env.cdpClick.hint || ""}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // SEALED-SHADOW click: a `>>>` selector targeted content inside a closed/declarative shadow
                        // root the page couldn't enter. The click was ALREADY approved above; the trusted background
                        // RESOLVES the selector via CDP (which pierces closed roots) to a viewport coordinate, then
                        // CDP-clicks it — so a sealed root never dead-ends at locate/@pt. Same `cdp`-flag gate + verify
                        // ring-back as the reserved cdpClick path above.
                        if (env?.cdpShadowClick) {
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nReaching a sealed shadow root needs a debugger (CDP) click, which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const resolved = await cdpShadowResolve(tabId, env.cdpShadowClick.selector);
                            if ("error" in resolved) return { result: `${env.result || ""}\n\n${resolved.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const m = resolved.matches[env.cdpShadowClick.index || 0];
                            if (!m) return { result: `${env.result || ""}\n\nThe debugger couldn't reach "${env.cdpShadowClick.selector}" inside the sealed shadow root (no match). Check the selector, or fall back to locate/@pt.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpClick(tabId, m.cx, m.cy);
                            if (!("ok" in r)) return { result: (r as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                            let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                            if (env.cdpShadowClick.verify) {
                                const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyAt: { x: m.cx, y: m.cy } } })
                                    .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                            }
                            const tail = env.cdpShadowClick.verify ? "" : " Re-run look to see the result.";
                            return { result: `Clicked ${m.line} inside a sealed shadow root via the debugger (at ${m.cx}, ${m.cy}).${tail}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // TRUSTED KEYBOARD: type into a canvas / WebGL / remote-desktop surface or a sealed field
                        // via CDP (real, isTrusted key events synthetic KeyboardEvents can't produce). Focus modes:
                        // a sealed `>>>` selector (CDP-resolve → click to focus) · an `@pt` (CDP-click to focus) ·
                        // or NEITHER (the page's current focus). Same `cdp`-flag gate + verify ring-back as cdpClick.
                        if (env?.cdpType) {
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nTrusted keyboard input (for a canvas / WebGL / remote-desktop / sealed target) needs a debugger (CDP), which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const t = env.cdpType;
                            let fx = t.x, fy = t.y, where = "the page's current focus";
                            if (t.selector) {
                                const resolved = await cdpShadowResolve(tabId, t.selector);
                                if ("error" in resolved) return { result: `${env.result || ""}\n\n${resolved.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                                const m = resolved.matches[t.index || 0];
                                if (!m) return { result: `${env.result || ""}\n\nThe debugger couldn't reach "${t.selector}" inside the sealed shadow root (no match).`, renderIn: env.renderIn, renderOut: env.renderOut };
                                fx = m.cx; fy = m.cy; where = `${m.line} (sealed shadow root)`;
                            } else if (typeof fx === "number" && typeof fy === "number") { where = `the target at (${fx}, ${fy})`; }
                            // Establish focus with a TRUSTED click when we have a coordinate (@pt or a resolved sealed field).
                            if (typeof fx === "number" && typeof fy === "number") {
                                const c = await cdpClick(tabId, fx, fy);
                                if (!("ok" in c)) return { result: (c as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                            }
                            const typed = await cdpKeyType(tabId, t.text, t.submit);
                            if (!("ok" in typed)) return { result: (typed as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                            let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                            if (t.verify) {
                                // The verify PICTURE: the whole element (selector/canvas → verifyElement), the focused
                                // element (@focus → verifyFocus), else the point crop (an @pt / sealed field, by coords).
                                const payload = t.verifyElement ? { runId, verifyElement: t.verifyElement }
                                    : t.verifyFocus ? { runId, verifyFocus: true }
                                    : typeof fx === "number" && typeof fy === "number" ? { runId, verifyAt: { x: fx, y: fy } }
                                    : { runId, verifyViewport: true };
                                const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                            }
                            const shown = t.text.length > 60 ? t.text.slice(0, 60) + "…" : t.text;
                            const tail = t.verify ? "" : " Re-run look to see the result.";
                            return { result: `Typed "${shown}" into ${where} via the debugger (trusted keyboard, additive).${t.submit ? " Submitted (Enter)." : ""}${tail}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // STRICT-PAGE exec: main-world eval was CSP/TT-blocked and the page handed back a cdpExec
                        // signal. UNFORGEABLE: we re-run the exact source the human APPROVED — `args.js`, from the
                        // gate above — NEVER the page-echoed `env.cdpExec.source`, so this can only ever execute
                        // the approved code; and there is no page-reachable CDP-exec message, so the ONLY path is
                        // here, after the approval. No approved `js` → refuse (never CDP-eval a page value).
                        if (env?.cdpExec) {
                            const approvedSource = typeof (args as { js?: unknown })?.js === "string" ? (args as { js: string }).js : null;
                            if (!approvedSource) return { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut };
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nRunning it needs Debugger-based actions (CDP), which are OFF — enable them in window.ml Settings → Advanced (the debugger clears the page's CSP/Trusted-Types), or fall back to a read-only survey / ml.fetch.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpEval(tabId, approvedSource, onStream);
                            if ("ok" in r) {
                                // Rebuild the Out cell from the CDP run's own console/value. `env.renderOut` is
                                // the page's CSP-BLOCKED render (an exec-out carrying that error), so forwarding
                                // it would show a red "this page blocks eval" next to a successful result — and
                                // would wipe the output the user just watched stream in.
                                const stdout = r.logs.join("\n");
                                const seen = Math.min(stdout.length, CDP_EXEC_CAP);
                                return { result: r.text, renderIn: env.renderIn,
                                    renderOut: { type: "exec-out", stdout: clipOut(stdout, UI_OUT_CAP), seen, value: r.value } };
                            }
                            return { result: `${env.result || ""}\n\n${r.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // The page already computed the rendered In/Out slots (descriptorFor) — forward them so
                        // the sidebar shows the rich view. `image` rides along for INLINE VISION (native look):
                        // the loop injects it into the model's next turn (pushToolImages).
                        return { result: env?.result || `Error: the page returned nothing for tool "${name}".`, renderIn: env?.renderIn, renderOut: env?.renderOut, feedback: env?.feedback, image: env?.image, imageLabel: env?.imageLabel, images: env?.images };
                    } finally {
                        pendingGrants.delete(tabId);   // grants were for THIS approved call's sub-ops only
                        if (onStream) delegateStreams.delete(runId);   // the call is done — stop routing live chunks to it
                    }
                },
                // Pre-run In render for a PENDING step (streaming runs): ask the page to compute the tool's
                // In descriptor without running it, so a step you watch stream shows exec's beautified JS /
                // python's code cell from the start instead of raw JSON args. Best-effort — raw args on failure.
                renderFor: async (name, args) => {
                    const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, renderOnly: true } })
                        .catch(() => null) as { renderIn?: import("./contract").RenderDescriptor } | null;
                    return env?.renderIn;
                },
                // Read-only try (exec only, and only when the user enabled autoApproveReadonly): ask the
                // page to run the call through the mediated interpreter — side-effect-free, so if it's
                // in-dialect it BOTH auto-approves AND returns the result, and the human gate is skipped.
                // Keep this run's pointer resolver so a page-side tool's `ml.dereference` (DEREF_TOKEN) can
                // read the outputs THIS run captured. Dropped in the run's finally, with the other per-run state.
                tokenSink: (fn) => { derefByRun.set(runId, fn); },
                tryReadonly: p.autoApproveReadonly ? async (name, args) => {
                    if (name !== "exec") return null;
                    const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, readonlyTry: true } })
                        .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                    return env && env.readonly ? { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut, reused: env.reused } : null;
                } : undefined,
                // Doomed-action precheck (click/type): ask the page to resolve the target side-effect-free.
                // A non-null error → the gate is SKIPPED and the error returned. Only delegated for tools
                // that HAVE a precheck (avoids a useless round-trip on every gated call).
                precheck: async (name, args) => {
                    if (!p.tools.some((t) => t.name === name && t.precheck)) return null;
                    const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, precheck: true } })
                        .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                    return env && env.precheckFailed ? (env.result || "") : null;
                },
                approve: async ({ tool, arguments: args, seq, step }) => {
                    // Ask the page to compute the In render for THIS call (without running the tool) so the
                    // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                    // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                    let renderIn: unknown;
                    try {
                        const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: tool, args, renderOnly: true } }) as { renderIn?: unknown };
                        renderIn = env?.renderIn;
                    } catch { /* page gone → no preview, fall back to raw args */ }
                    // Key by the OFFSET seq — the same value the app sees on the emitted step (emitStep
                    // offsets raw→seqBase+raw) and echoes back in SET_APPROVAL. Keying by the raw seq meant a
                    // follow-up turn (seqBase>0) never matched → the gate hung forever ("stuck on Approve" on
                    // turn 2+). Turn 1 worked only because seqBase==0. (Mirror emitStep's null-guard exactly.)
                    const gateSeq = seq != null ? seqBase + seq : seq;
                    const key = `${runId}:${gateSeq}`;
                    // button #3: statically extract the persistable egress grants (e.g. this exec's inline
                    // ml.fetch literals) ONCE, background-side. The SAME list feeds the descriptor/step the
                    // human reviews AND the persistence below, so what's shown IS what's remembered.
                    const grants = extractGrants(tool, args);
                    return new Promise<ApprovalDecision>((resolve) => {
                        pendingApprovals.set(key, {
                            resolve: (decision) => {
                                const ok = decision === true || (typeof decision === "object" && !!decision && decision.approved);
                                if (ok && tool === "python_exec") for (const id of externalSheetIds(args)) approvedSheets.add(id);
                                // Approving a cross-origin nav consents to that ORIGIN for the rest of the run
                                // (repeat navs to it then skip the gate).
                                if (ok && tool === "navigate") { try { consentedOrigins.add(new URL(String((args as { url?: unknown }).url ?? "")).origin); } catch { /* relative/bad url — nothing to remember */ } }
                                // Approving a fetch_url: a CREDENTIALED one (fetch-as-the-user — raw cookies, or a
                                // rendered load in your session) mints a ONE-TIME grant, NEVER persisted, so it
                                // always re-prompts. An UNCREDENTIALED one (a raw uncredentialed GET, or an
                                // INCOGNITO rendered load — no session, lower risk) consents to that EXACT url for
                                // the session (repeat fetches auto-approve — the rememberable path).
                                if (ok && tool === "fetch_url") {
                                    const u = String((args as { url?: unknown }).url ?? "");
                                    if (u) { if ((args as { credentials?: unknown }).credentials) grantCredFetch(tabId, u); else consentFetch(tabId, u); }
                                }
                                // button #3: "Approve + remember" — also persist the exec's static ml.fetch
                                // literals for the session (a positive `persist` decision only).
                                if (ok && typeof decision === "object" && decision.persist) persistGrants(tabId, grants);
                                // Clear the gate on EVERY surface the INSTANT it's decided — not only when the
                                // tool's DONE lands (which for a slow fetch is seconds off). Without this, a
                                // second UI (the other of DevTools panel / HUD card) kept showing approve/deny
                                // until the tool finished. This patches the pending step to non-awaiting on all
                                // surfaces (same seq); the DONE later fills the result. Fired BEFORE resolve() so
                                // it precedes the tool run.
                                // A CANCEL (Stop) resolves the gate with `{ cancelled:true }` — show "cancelled",
                                // not "denied", so a Stop doesn't flash a false accusation before the loop's own
                                // cancelled DONE lands.
                                const cancelledDecision = typeof decision === "object" && !!decision && !!decision.cancelled;
                                emitStep({ step, seq, pending: true, awaitingApproval: false, approval: cancelledDecision ? "cancelled" : ok ? "user" : "denied", tool, arguments: args });
                                resolve(decision);
                            },
                            // What the external approver sees when it enumerates gates (the UI shows the same
                            // via the emitStep below). args are already sanitized page-side for the render.
                            descriptor: { key, runId, seq: gateSeq ?? -1, step: step ?? -1, tool, arguments: args, ts: Date.now(), routing: p.approvalRouting || "ui" },
                        });
                        // Patch the pending step to show approve/deny (awaitingApproval) + the In preview. ALL
                        // three surfaces render it identically from this one step: overlay/off in the page
                        // iframe (slide-out panel vs corner card), devtools in the panel. The off-mode card
                        // reveals ITSELF on this step — no separate modal message — and the decision returns via
                        // the same origin-authed SET_APPROVAL, so the gate is unforgeable across every surface.
                        // approvalRouting "external" SUPPRESSES the UI buttons (the gate still blocks — only the
                        // __mlApprovals channel resolves it); "ui"/"both" show them as before.
                        emitStep({ step, seq, pending: true, awaitingApproval: p.approvalRouting !== "external", approvalExternal: p.approvalRouting === "external" || undefined, tool, arguments: args, renderIn, grants: grants.length ? grants : undefined });
                    });
                },
                isSheetApproved: (id) => approvedSheets.has(id),
                navNeedsConsent,   // cross-origin nav → gate; same-site / already-consented → auto (see consentedOrigins)
                fetchNeedsConsent: (url) => !fetchConsent.get(tabId)?.has(url),   // a NEW url → gate; an already-approved one → auto
                // An UNCREDENTIALED fetch to an origin the run is at / has been consented to (relative, or in
                // consentedOrigins — seeded with the start origin) is FREE: the page can already fetch its own
                // origin, so it's no escalation. Used by the auto-approve (no prompt), like a same-origin navigate.
                fetchSameOrigin: (url: string): boolean => {
                    try {
                        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return true;   // relative → the page's own origin
                        return consentedOrigins.has(new URL(url.startsWith("//") ? "https:" + url : url).origin);
                    } catch { return false; }
                },
                checkpoint: (messages) => persistRun(runId, { p, tabId, messages, sub: snapSub() }),   // durable resume snapshot per step
                // This turn's delegated vision sub-call tally (accumulated from each delegated tool's envelope
                // delta in delegateTool) — so chat_metadata reports the real number on the background path too.
                subcallTokens: () => snapSub(),
                emit: (ev) => emitStep(ev as Record<string, unknown>),
                drainInbox: () => {   // a.say() steering (INJECT_MESSAGE); draining flips the "seen" indicator
                    const items = (runInboxes.get(runId)?.queue || []).splice(0);
                    for (const it of items) if (it.id) fanEvent({ kind: "agent-say-seen", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, sayId: it.id });
                    return items.map(it => it.text);
                },
                signal: abortCtl.signal,
                // chat_metadata: the run's model FACTS from the SW's caches (the loop supplies the live
                // token/message counts). The SW can also read the URL → name the backend. Degrades to null.
                chatMeta: async () => {
                    const model = p.model || null;
                    const est = (s: unknown) => (s ? Math.round(String(s).length / 4) : 0);   // ~chars/4, no tokenizer
                    let toolJson = ""; try { toolJson = JSON.stringify(p.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))); } catch { /* skip */ }
                    const config = await getConfig();
                    const fmt = config.apiFormat, url = config.chatUrl || "";
                    const backend = fmt === "ollama" ? "Ollama (native)"
                        : /open-?webui|\/api\/chat\/completions/i.test(url) ? "OpenWebUI (server-side tools available)"
                        : "OpenAI-compatible";
                    const overhead = { systemTokens: est(p.systemPrompt), toolTokens: est(toolJson), backend };
                    if (!model) return { model, contextWindow: null, capabilities: null, ...overhead };
                    const [capabilities, resident] = await Promise.all([
                        modelCapabilities(config, model).catch(() => null),
                        residentModels(config).catch(() => [] as { model?: string; name?: string; context_length?: number; size_vram?: number }[]),
                    ]);
                    const norm = (s: string) => s.replace(/:latest$/, "");
                    const lm = resident.find(x => x.model === model || x.name === model || norm(x.model || x.name || "") === norm(model));
                    const contextWindow = lm && typeof lm.context_length === "number" ? lm.context_length : null;
                    const vramGB = lm && lm.size_vram ? +(lm.size_vram / 1e9).toFixed(1) : null;
                    const local = capabilities !== null;   // caps came back from Ollama /api/show → resident/local
                    return { model, contextWindow, capabilities, vramGB, local, ...overhead };
                },
            },
        )
            .then(({ result: res, messages }) => {
                // Keep the run resumable: stash its full history + payload (deps rebuild from it) so a later
                // RESUME_RUN can continue it. Overwrites the prior turn's snapshot (same runId). SW-eviction
                // may drop this — resume then reports an actionable error (see bgRuns). `sub` carries the
                // cumulative sub-call tally so a resumed turn's chat_metadata keeps reporting the session total.
                // ADVANCE the stored step/seq base past THIS turn's extents: a follow-up that routes through
                // RESUME_RUN (a HUD composer follow-up AFTER the run navigated — the page handle died, so it goes
                // agentRegistry.resume → RESUME_RUN, not the page's control.stepBase path) must continue AFTER the
                // prior turns. Without this it reused base 0 and the new turn's steps collided at step/seq 1 with
                // turn 1's — the reducer patches by seq, so the follow-up's tool steps OVERWROTE turn 1's and
                // vanished from the sidebar/panel (and scrambled the export's chat-log order).
                const resumeP = { ...p, stepBase: stepBase + runMaxStep, seqBase: seqBase + runMaxSeq };
                bgRuns.set(runId, { p: resumeP, tabId, messages, sub: snapSub() });
                const answerMedia = runAnswerMedia.length ? runAnswerMedia : undefined;
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps },
                    summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, answerMedia,
                });
                // Sync the run's final history back so a createAgent handle's control.messages stays live,
                // + this run's step/seq extents so the page advances its bases for the NEXT turn's offset. The
                // answer element visuals ride on `res` too, so the page-side caller's own agent-result carries them.
                sendResponse({ data: { ...res, answerMedia }, messages, stepCount: runMaxStep, seqCount: runMaxSeq });
            })
            .catch((err) => {
                // A fatal loop error — surface it to the off-mode card (the page's bus is dormant there,
                // so injected can't), then reject the round-trip (injected re-throws → ml.agent rejects).
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
                    summary: "", steps: 0, hitCap: false, error: err?.message || String(err),
                });
                sendResponse({ error: err?.message || String(err) });
            })
            .finally(() => { runControllers.delete(runId); runInboxes.delete(runId); untrackRun(tabId, runId); deleteRun(runId); releaseDebugger(tabId); });   // detach the run's CDP debugger (attached once, reused across execs/clicks)
        return true;   // async: sendResponse fires when the whole run finishes
    }
    if (message.type === "PYTHON_EXEC") {
        // Route the sandboxed-Python run to the offscreen Pyodide host (the service worker can't run WASM).
        // CHOKE-POINT: FULL (unhardened) mode is network at the extension origin — gate it. Readonly is a
        // network-nulled sandbox (safe for any caller); full is allowed only from a trusted surface, a
        // whitelisted domain, or with a per-call grant for THIS code. An untrusted page without one is
        // REJECTED (a clear error, not a silent readonly downgrade).
        (async () => {
            const wantsFull = message.payload?.hardened === false;
            if (wantsFull) {
                const trust = await senderTrust(sender);
                if (trust === "untrusted") {
                    const code = String(message.payload?.code ?? "");
                    if (!(sender.tab?.id != null && pendingGrants.get(sender.tab.id)?.pyCode.has(code))) {
                        sendResponse({ error: "Refused: network-enabled (full) Python needs approval on this page — run it through an agent and approve it, or add this site to the approval whitelist." });
                        return;
                    }
                }
            }
            // LIVE stdout streaming (opt-in): record streamId→tab so a PY_STDOUT chunk reaches this page.
            const streamId: string | undefined = message.payload?.stream ? message.requestId : undefined;
            if (streamId && sender.tab?.id != null) pyStreamTabs.set(streamId, sender.tab.id);
            const payload = { type: "PY_RUN", code: message.payload?.code, image: message.payload?.image ?? null, hardened: message.payload?.hardened !== false, tables: message.payload?.tables ?? null, stream: !!streamId, streamId };
            const attempt = () => ensureOffscreen().then(() => chrome.runtime.sendMessage(payload));
            attempt()
                .catch((err) => {
                    // The offscreen doc can be gone (SW slept and the doc was torn down, or a stale cached-
                    // ready) → "Receiving end does not exist." Drop the cache, recreate, retry ONCE.
                    if (!/Receiving end does not exist|Could not establish connection/.test(String(err?.message || err))) throw err;
                    offscreenReady = null;
                    return attempt();
                })
                .then((res) => sendResponse({ data: res }))
                .catch((err) => sendResponse({ error: err?.message || String(err) }))
                .finally(() => { if (streamId) pyStreamTabs.delete(streamId); });
        })();
        return true;   // async
    }
    // A page-side tool of a background-hosted run calling `ml.dereference`. Answered only for a run WE are
    // hosting, from that run's own pointer store — the resolver the loop handed us at start (tokenSink).
    if (message.type === "DEREF_TOKEN") {
        const fn = derefByRun.get(String(message.runId || ""));
        if (!fn) { sendResponse({ error: `No active background run "${message.runId}" to read pointers from.` }); return true; }
        try { sendResponse({ value: fn(String(message.ref || ""), String(message.pipe || "")) }); }
        catch (e) { sendResponse({ error: (e as Error)?.message || String(e) }); }
        return true;
    }
    if (message.type === "PAGE_TOOL_STREAM") {
        // A LIVE output chunk from a DELEGATED page tool (its ctx.stream) → hand it to the in-flight call's
        // sink, which is the loop's throttled fan → an agent-step `streamOutput` delta on every surface.
        // Keyed by runId: the loop delegates tool calls sequentially, so one is in flight per run.
        const sink = delegateStreams.get(message.runId);
        if (sink) { try { sink(String(message.chunk ?? ""), typeof message.ts === "number" ? message.ts : undefined); } catch { /* a bad sink must not break the run */ } }
        return false;
    }
    if (message.type === "PY_STDOUT") {
        // A live stdout chunk from the offscreen Pyodide host → relay to the run's page (keyed by streamId), which
        // resolves it as a PYTHON_EXEC_RESPONSE progress event to the awaiting ml.pythonExec (→ the tool's ctx.stream).
        const tabId = pyStreamTabs.get(message.streamId);
        if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "PYTHON_STREAM", requestId: message.streamId, chunk: message.chunk, ts: message.ts }).catch(() => { /* page gone → drop */ });
        return false;
    }
    if (message.type === "FETCH_SHEET") {
        // Fetch a Google Sheet's CSV export CREDENTIALED (the user's own Google session), so it works on
        // private corporate sheets — the DOM path is useless (Sheets is canvas). CHOKE-POINT: the host-lock
        // stops general SSRF, but the sheet id is caller-chosen and this spends the user's cookies — so an
        // untrusted page may only read a sheet it holds a per-call grant for (minted when its agent run
        // approved it). A trusted surface / whitelisted domain is unrestricted (host-lock still applies).
        (async () => {
            const url = message.payload?.url || "";
            if (await senderTrust(sender) === "untrusted") {
                const id = googleSheetId(url);
                if (!(id && sender.tab?.id != null && pendingGrants.get(sender.tab.id)?.sheets.has(id))) {
                    sendResponse({ error: "Refused: this sheet hasn't been approved for this page — run it through an agent and approve it, or add this site to the approval whitelist." });
                    return;
                }
            }
            try { sendResponse({ data: await fetchSheetCsv(url) }); }   // { csv, name } — name from Content-Disposition
            catch (err) { sendResponse({ error: (err as Error)?.message || String(err) }); }
        })();
        return true;   // async
    }
    if (message.type === "FETCH_URL") {
        // ml.fetch(url): a GET the agent uses to READ content the page can't (a raw file, a JSON API, another
        // site) — bypasses CORS via host permissions. Uncredentialed by default (no cookies); `credentials`
        // sends the user's session and `rendered` loads it in a tab so its JS runs (see the branches). CHOKE-POINT:
        // there's no URL host-lock (arbitrary URLs are the point), so the boundary IS the consent — an
        // untrusted page may fetch only a URL the user approved for THIS tab (grown in a run's approval,
        // unforgeable). A trusted surface / whitelisted domain is unrestricted. Only http(s) targets.
        (async () => {
            const url = String((message.payload as { url?: unknown })?.url || "");
            const credentials = !!(message.payload as { credentials?: unknown })?.credentials;
            const rendered = !!(message.payload as { rendered?: unknown })?.rendered;
            let scheme = "";
            try { scheme = new URL(url).protocol; } catch { sendResponse({ error: `Refused: "${url}" is not a valid URL.` }); return; }
            if (scheme !== "http:" && scheme !== "https:") { sendResponse({ error: `Refused: ml.fetch supports only http(s) URLs (got "${scheme}").` }); return; }
            const tabId = sender.tab?.id;
            const untrusted = await senderTrust(sender) === "untrusted";
            // SAME-ORIGIN as the sender's page: a free read (the page can already `fetch()` its own origin, and
            // navigate there is free) — applies to a plain GET AND a rendered load. Used by the gate below AND
            // the render dispatch (a same-origin render uses the SESSION tab, not incognito — no leak, you're
            // already signed in there).
            const sameOriginAsSender = (() => { try { return !!sender.url && new URL(url, sender.url).origin === new URL(sender.url).origin; } catch { return false; } })();
            const cfg = await getConfig();   // the same-origin as-you opt-in + the cdp render setting
            // CREDENTIALED (fetch-as-the-user — a raw GET with cookies, OR a rendered load in a NORMAL tab that
            // carries the session) → a "read any URL as you" primitive, so an untrusted page needs a ONE-TIME
            // per-URL grant (minted by an approved fetch_url, consumed here). EXCEPTION: a SAME-ORIGIN as-you fetch
            // is allowed WITHOUT a grant when the user opted into `autoApproveSameOriginAuth` (Advanced). Cross-
            // origin always needs the grant; execOpen/consent never authorize the credentialed path.
            if (credentials) {
                const sameOriginAuthOk = !!cfg.autoApproveSameOriginAuth && sameOriginAsSender;
                if (untrusted && !sameOriginAuthOk && !takeCredFetch(tabId, url)) {
                    sendResponse({ error: `Refused: an as-you fetch of "${url}" wasn't approved. A fetch AS THE USER (${rendered ? "rendered in your session" : "cookies"}) must be approved per-URL via the fetch_url tool; it can't run inline in exec or reuse a prior grant.` });
                    return;
                }
            } else {
                // UNCREDENTIALED: fetchOpen = an approved exec is running (its inline fetches are the human-approved
                // code); per-URL consent = the human approved EXACTLY this url (and it's remembered). SAME-ORIGIN is
                // FREE (no grant) — including a same-origin RENDER (it renders in your own session, no more than a
                // free same-origin navigate). A CROSS-origin uncredentialed render runs in INCOGNITO (no session) and
                // takes the rememberable consent path, same as a raw cross-origin GET.
                const execOpen = tabId != null && !!pendingGrants.get(tabId)?.fetchOpen;
                // SELF-SOURCE: an uncredentialed, non-rendered read of the agent's OWN repo source (committed files
                // / structural API, NOT a prose endpoint) is allowed WITHOUT a per-URL grant, gated on the config
                // flag. Enforced HERE, trusted-side (the client autoApprove only skips the prompt; the background is
                // the authority — a forged "self-source" can't make this true for a non-self URL). See self-source.ts.
                const selfSrc = !!cfg.autoApproveSelfSource && !rendered && isSelfSourceUrl(url, BUILD_INFO.repoUrl);
                if (untrusted && !sameOriginAsSender && !execOpen && !selfSrc && !(tabId != null && fetchConsent.get(tabId)?.has(url))) {
                    sendResponse({ error: `Refused: "${url}" hasn't been approved for fetching on this page. Use the fetch_url tool (each new URL is approved once, then remembered for the session), or call ml.fetch inside an approved exec.` });
                    return;
                }
            }
            const execOpen = tabId != null && !!pendingGrants.get(tabId)?.fetchOpen;
            try {
                // rendered: an uncredentialed render is INCOGNITO (session-less — a safe read, which is why a
                // same-origin one is free); a credentialed render uses the SESSION tab (as-you → always prompts).
                // A session (non-incognito) render is NEVER free. The `cdp` setting lets it emulate foreground so
                // a backgrounded tab's gated loads fire.
                const data = rendered ? await fetchRenderedContent(url, !credentials, !!cfg.cdp) : await fetchUrlContent(url, credentials);
                // Redirect guard: a per-URL-consented fetch (NOT a surface/whitelisted/exec one) that ends on a
                // DIFFERENT, un-consented origin followed a redirect off the approved resource — withhold the body
                // (a consented public URL could redirect to a private/other target). The GET already happened but
                // no data leaves, and returning nothing is safe. exec (execOpen) trusts the code's own redirects.
                if (untrusted && !execOpen) {
                    let sameOrigin = true;
                    try { sameOrigin = new URL(data.url).origin === new URL(url).origin; } catch { /* keep true */ }
                    if (!sameOrigin && !fetchConsent.get(tabId!)?.has(data.url)) {
                        sendResponse({ error: `"${url}" redirected to a different origin (${(() => { try { return new URL(data.url).origin; } catch { return data.url; } })()}), which hasn't been approved. Fetch that URL directly to approve it.` });
                        return;
                    }
                }
                sendResponse({ data });
            }
            catch (err) {
                const m = (err as Error)?.message || String(err);
                // A redirect loop / too-many-redirects surfaces as a generic "Failed to fetch" (Chrome opaques the
                // reason), so we can only HINT at it — the exact hops aren't visible to fetch.
                sendResponse({ error: `Could not fetch "${url}" (${m}). Possible causes: a redirect loop / too many redirects (the chain isn't visible to the extension), the extension lacking host access (grant "On all sites"), or the URL being unreachable.` });
            }
        })();
        return true;   // async
    }
    if (message.type === "OPEN_EXTENSIONS_PAGE") {
        // Deep-link to THIS extension's details page (where "Allow in Incognito" lives) — opened for the
        // Settings/popup "Incognito rendering" button. EXTENSION-ORIGIN ONLY (a page can't reach
        // chrome.runtime.onMessage, but guard anyway): the URL is derived here (browser-correct scheme +
        // chrome.runtime.id), never taken from the sender, so this can't be turned into an "open any URL".
        if (!(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ error: "refused" }); return true; }
        let scheme = "chrome"; try { scheme = browserInfo().scheme; } catch { /* default */ }
        chrome.tabs.create({ url: `${scheme}://extensions/?id=${chrome.runtime.id}` })
            .then(() => sendResponse({ data: true }))
            .catch((e) => sendResponse({ error: (e as Error)?.message || String(e) }));
        return true;   // async
    }
    if (message.type === "FETCH_SHEET_TITLE") {
        // TITLE-ONLY, pre-approval: the approval card fetches just the sheet name so the USER sees WHICH
        // sheet they're granting (the MODEL never gets it). INTERNAL-ONLY — it's not in the content relay.
        // Gate on the sender's ORIGIN, not on sender.tab: the DevTools panel is a top-level extension page
        // (sender.tab == null), but the overlay/off-mode card is our extension-origin IFRAME embedded in a
        // page tab (sender.tab is SET, sender.url is our origin). The old `sender.tab != null` guard wrongly
        // refused that embedded card, so the HUD showed the generic "Google Sheet" instead of the real title.
        // A web page can't reach chrome.runtime.onMessage at all; a content script's sender.url is the page url.
        if (!(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ data: null }); return true; }
        const id = String(message.payload?.id || "").trim();
        const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=0`;
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !SHEET_URL_OK.test(url)) { sendResponse({ data: null }); return true; }
        fetch(url, { method: "HEAD", credentials: "include" })
            .then((res) => sendResponse({ data: res.ok ? sheetNameFromDisposition(res.headers.get("content-disposition")) : null }))
            .catch(() => sendResponse({ data: null }));
        return true;   // async
    }
    if (message.type === "ABORT_TASK") {
        // Cancel an in-flight task by its requestId (currently only FETCH_LLM registers a
        // controller). Fire-and-forget — no sendResponse, so don't keep the channel open.
        const ctl = inflight.get(message.payload?.requestId);
        if (ctl) { ctl.abort(); inflight.delete(message.payload.requestId); }
        return;
    }
    if (message.type === "FETCH_LLM") {
        // Register an AbortController keyed by requestId so an ABORT_TASK (from ml.agent's signal)
        // can kill the in-flight fetch — don't leave a slow local generation running after cancel.
        const rid: string | undefined = message.requestId;
        const ctl = new AbortController();
        if (rid) inflight.set(rid, ctl);
        const done = () => { if (rid) inflight.delete(rid); };
        fetchLLM(message.payload, ctl.signal)
            // raw (ml.step) returns { content, tool_calls } as data; normal chat
            // returns the content string, with sources alongside only when present.
            .then((result: any) => {
                if (message.payload.raw) return sendResponse({ data: result });
                const resp: any = { data: result.content, model: result.model ?? null };
                if (result.sources && result.sources.length) resp.sources = result.sources;
                if (result.reasoning) resp.reasoning = result.reasoning;
                if (result.usage) resp.usage = result.usage;
                sendResponse(resp);
            })
            .catch(err => sendResponse({ error: err.message }))
            .finally(done);
        return true; // Keep channel open for async fetch

    } else if (message.type === "LIST_MODELS") {
        // Config overrides are only honored from the extension's own pages
        // (popup); pages relaying through the content script (sender.tab set)
        // must not be able to point the saved API key at another host.
        // Filter the returned list by the model-filter whitelist too, so a page's
        // ml.models() never even SEES an excluded (e.g. cloud) model, and the settings
        // datalists only offer allowed ones. Enforcement still lives in prepareRequest;
        // this is the "don't surface it" half.
        Promise.all([listAvailableModels(sender.tab ? {} : (message.payload || {})), getConfig()])
            .then(([{ ids, ollamaModels }, cfg]) => {
                const keep = (m: string) => modelFilterAllows(m, cfg.modelFilter);
                sendResponse({ data: ids.filter(keep), ollamaModels: ollamaModels ? ollamaModels.filter(keep) : null });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "OLLAMA_INFO") {
        // Read-only machine CAPACITY (per-device VRAM, system RAM). No sender gating, for the same reason as
        // OLLAMA_PS: it exposes nothing about the URL or key, only what hardware the box has. Resolves to null
        // when the route isn't served, which the page must read as "unknown", never as zero.
        fetchOllamaInfo()
            .then(info => sendResponse({ data: info }))
            .catch(e => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;
    } else if (message.type === "LIST_SERVER_TOOLS") {
        // Read-only discovery of what `toolIds` accepts. No sender gating: the tool
        // list is scoped to the saved API key by OpenWebUI itself (its access control),
        // and names/specs are no more secret than the model list — the URL and key stay
        // behind the worker either way.
        listServerTools()
            .then(tools => sendResponse({ data: tools }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "SET_MODEL") {
        setModel(message.payload && message.payload.model)
            .then(model => sendResponse({ data: model }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "GET_MODEL") {
        getConfig()
            .then(config => sendResponse({ data: config.model }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "GET_INVOCATION") {
        // How to open the HUD on THIS install. The shortcut is user-rebindable at
        // chrome://extensions/shortcuts, so we report what chrome.commands says is bound RIGHT NOW
        // (and whether that still matches the manifest) rather than letting anything hardcode
        // "Alt+Space" — a stale answer sends the user to a key that does nothing. Non-secret:
        // it's the user's own UI affordance, so no sender gating.
        const manifest = chrome.runtime.getManifest?.() || {} as chrome.runtime.Manifest;
        const suggested = manifest.commands?.["open-composer"]?.suggested_key;
        const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent || "");
        const defaultShortcut = (typeof suggested === "string" ? suggested
            : (isMac ? suggested?.mac : suggested?.default) || suggested?.default) || "";
        // contextMenus is a permission-gated API, so the manifest declaring it is a truthful proxy
        // for "the right-click entry exists" — this line turns itself on when that feature lands.
        const contextMenu = (manifest.permissions || []).includes("contextMenus");
        Promise.resolve(chrome.commands?.getAll?.() ?? [])
            .then((cmds: chrome.commands.Command[]) => {
                const shortcut = cmds.find(c => c.name === "open-composer")?.shortcut || "";
                sendResponse({ data: { shortcut, defaultShortcut, isDefault: !!shortcut && shortcut === defaultShortcut, contextMenu } });
            })
            .catch(() => sendResponse({ data: { shortcut: "", defaultShortcut, isDefault: false, contextMenu } }));
        return true;

    } else if (message.type === "GET_CONFIG") {
        // Non-secret config the page may read (model/OCR model/format). The URL
        // and API key are deliberately withheld — see the security invariants.
        getConfig()
            .then(config => {
                // Compute whether THIS page's origin is on the user's page-approval whitelist. The origin
                // comes from the trusted `sender` (the content script's tab URL), NOT anything the page
                // sends — so a page can't claim to be whitelisted. Only the boolean crosses to the page;
                // the domain list never does.
                let pageApprovalAllowed = false;
                try {
                    const url = sender.tab?.url || sender.url || "";
                    const host = url ? new URL(url).hostname : "";
                    pageApprovalAllowed = !!host && (config.pageApprovalDomains || []).includes(host);
                } catch { /* opaque/blank origin → not allowed */ }
                sendResponse({ data: {
                    model: config.model, ocrModel: config.ocrModel, ocrNumCtx: config.ocrNumCtx, apiFormat: config.apiFormat,
                    defaultModelVision: config.defaultModelVision,
                    utilityModel: config.utilityModel, utilityNumCtx: config.utilityNumCtx, utilityForceCpu: config.utilityForceCpu,
                    autoApproveReadonly: config.autoApproveReadonly, autoApprovePython: config.autoApprovePython,
                    autoApproveSameOriginAuth: config.autoApproveSameOriginAuth, autoApproveSelfSource: config.autoApproveSelfSource,
                    pierceClosedShadow: config.pierceClosedShadow, cdp: config.cdp,
                    groundingEnabled: config.groundingEnabled, groundingModel: config.groundingModel,
                    groundingRange: config.groundingRange, debugMode: config.debugMode, pageApprovalAllowed,
                } });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "MODEL_CAPS") {
        getConfig()
            .then(config => modelCapabilities(config, (message.payload && message.payload.model) || config.model))
            .then(caps => sendResponse({ data: caps }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "OLLAMA_PS") {
        listLoadedModels()
            .then(models => sendResponse({ data: models }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "OLLAMA_UNLOAD") {
        unloadModels(message.payload && message.payload.model)
            .then(unloaded => sendResponse({ data: unloaded }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "FETCH_IMAGE_B64") {
        // Uncredentialed (no auth-data leak), but a "read any URL's bytes" primitive at the extension
        // origin — so an SSRF denylist keeps a page from probing/reading the user's internal network.
        if (isBlockedFetchTarget(message.payload?.url || "")) {
            sendResponse({ error: "Refused: cannot fetch a private / loopback / link-local / metadata address." });
            return true;
        }
        fetch(message.payload.url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.blob();
            })
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    // Returns "data:image/jpeg;base64,..."
                    sendResponse({ data: reader.result });
                };
                reader.readAsDataURL(blob);
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "CAPTURE_TAB") {
        // Screenshot the visible viewport so the page can crop it to an element.
        // Privileged: pages can't capture pixels, and a cross-origin canvas would
        // taint — same escalation the FETCH_IMAGE_B64 fetch already grants. For a
        // page-relayed message sender.tab is set; its windowId targets the tab.
        const doCapture = () => sender.tab
            ? chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
            : chrome.tabs.captureVisibleTab({ format: "png" });
        (async () => {
            const cfg = await getConfig();
            const tabId = sender.tab?.id;
            // PREFER CDP when it's enabled: Page.captureScreenshot captures the SAME viewport at the SAME device
            // pixel ratio as captureVisibleTab (verified: 800x600@2 → 1600x1200), so the coordinate math is
            // identical — but it works on strict / "On click" pages with NO host grant (the debugger is exempt,
            // like exec/click) and is NOT subject to captureVisibleTab's ~2/sec quota. The debugger is attached
            // once per run (reused), so a multi-look run shows the infobar steadily rather than per-shot.
            let cdpErr = "";
            if (cfg.cdp && tabId != null) {
                const shot = await cdpScreenshot(tabId);
                if ("ok" in shot) { sendResponse({ data: shot.dataUrl }); return; }
                cdpErr = shot.error;   // attach conflict (real DevTools open) / no debugger permission → fall back below
            }
            // Fallback (CDP off, or its attach failed): captureVisibleTab. Chrome RATE-LIMITS it (~2/sec —
            // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); a burst of look()/locate() trips a TRANSIENT quota error
            // the model can't act on, so wait out the ~1s window and retry a few times before surfacing it.
            for (let attempt = 0; ; attempt++) {
                try { sendResponse({ data: await doCapture() }); return; }
                catch (err) {
                    const emsg = (err as Error)?.message || String(err);
                    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(emsg) && attempt < CAPTURE_RETRIES) {
                        await new Promise(r => setTimeout(r, CAPTURE_RETRY_MS)); continue;
                    }
                    // captureVisibleTab needs activeTab OR <all_urls> specifically (Chromium's
                    // kActiveTabOrAllUrls) — a per-HOST grant like github.com does NOT satisfy it, and "On click"
                    // withholds <all_urls> while a navigation revokes activeTab. The clean fix is the debugger
                    // (exempt), so steer to CDP; a per-host grant would be a dead end.
                    if (/all_urls|activeTab|permission is required/i.test(emsg)) {
                        const cdpNote = cdpErr
                            ? ` The debugger route (CDP) is enabled but couldn't attach here (${cdpErr}) — close Chrome DevTools on this tab if it's open, then retry.`
                            : " Easiest fix: enable \"Debugger-based actions (CDP)\" in window.ml Settings → Advanced — then look/locate screenshot via the debugger (exempt from site access), exactly how exec works here.";
                        sendResponse({ error:
                            `Can't screenshot this page — captureVisibleTab needs "On all sites" access; a per-site grant like this host does NOT enable it.${cdpNote} ` +
                            "Alternatively set the extension's site access to \"On all sites\" (right-click the toolbar icon → \"This can read and change " +
                            "site data\" → \"On all sites\"). Then ask me to look again."
                        });
                        return;
                    }
                    sendResponse({ error: emsg }); return;
                }
            }
        })();
        return true;

    } else if (message.type === "SAVE_SESSION") {
        // Persist a { save:true } chat session so ml.resumeChat can rehydrate it
        // across reloads/tabs. Page-provided message history + createChat options
        // — no secrets (URL/key never live in a session). Main world can't touch
        // storage, hence this round-trip.
        const { hash, session } = message.payload || {};
        chrome.storage.local.set({ [`ml_session_${hash}`]: session })
            .then(() => sendResponse({ data: true }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "GET_SESSION") {
        const key = `ml_session_${(message.payload || {}).hash}`;
        chrome.storage.local.get(key)
            .then((d: any) => sendResponse({ data: d[key] || null }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

// Streaming uses a Port instead of the one-shot sendMessage/sendResponse, so
// tokens can arrive as many messages. The content script opens the port and
// posts { payload }; we stream { type: "chunk", delta } and finish with
// { type: "done", content, sources, model } or { type: "error", error }. A connected
// port also keeps the MV3 service worker alive for the request's duration.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "LLM_STREAM") return;
    // The Port IS the cancellation channel: content.js disconnects it when the caller aborts
    // (ml.chat's signal) → abort the streaming fetch so a slow generation stops. `closed` guards
    // against posting to the dead port after a disconnect.
    const ctl = new AbortController();
    let closed = false;
    port.onDisconnect.addListener(() => { closed = true; ctl.abort(); });
    port.onMessage.addListener((message: any) => {
        streamLLM(message.payload, (delta) => { if (!closed) port.postMessage({ type: "chunk", delta }); }, ctl.signal)
            .then(({ content, sources, model, reasoning, usage }) => { if (!closed) port.postMessage({ type: "done", content, sources, model, reasoning, usage }); })
            .catch((err) => { if (!closed) port.postMessage({ type: "error", error: err.message }); });
    });
});

// ---- DevTools panel debug stream (opt-in second surface for the sidebar) ----
// The in-page overlay receives __mlDebug via window-messages; a DevTools panel can't, so
// the content-script shell also forwards each event here (ML_DEBUG_EVENT). We buffer per
// inspected tab — a panel opened mid-run replays what it missed (the overlay never needs
// this, it's always mounted) — and fan out to any connected panel for that tab.
const devtoolsPorts = new Map<number, Set<chrome.runtime.Port>>();
const debugBuffer = new Map<number, unknown[]>();
const DEBUG_BUFFER_CAP = 500;   // drop-oldest ring; screenshots are big, so keep it modest

function relayDebugEvent(tabId: number, event: unknown): void {
    let buf = debugBuffer.get(tabId);
    if (!buf) { buf = []; debugBuffer.set(tabId, buf); }
    buf.push(event);
    if (buf.length > DEBUG_BUFFER_CAP) buf.splice(0, buf.length - DEBUG_BUFFER_CAP);
    const ports = devtoolsPorts.get(tabId);
    if (ports) for (const p of ports) { try { p.postMessage({ __mlDebug: event }); } catch { /* port closing */ } }
}

// A fresh page mount (shell remount → ML_DEBUG_RESET) clears the buffer AND tells any
// connected panel to drop its stale sessions — the panel's app outlives a page reload, so
// without this it keeps the prior load's data while new events pile on under it.
function resetDebug(tabId: number): void {
    // A cross-page run's shell remounts on the new page and fires ML_DEBUG_RESET — but the run may STILL be
    // live (activeRuns) OR resumable (bgRuns: completed-but-follow-up-able, or INTERRUPTED by an SW restart —
    // e.g. a mid-run site-access grant that cycled the worker). In any of those the session is on disk / in
    // bgRuns and about to recover, so keep its history: a late CS injection's reset must NOT drop the panel/HUD
    // session out from under a run that's coming back (the reported "the session vanished after I granted the
    // site" bug). Only a tab with NO run at all clears.
    if (activeRuns.has(tabId) || tabHasBgRun(tabId)) return;
    debugBuffer.delete(tabId);
    const ports = devtoolsPorts.get(tabId);
    if (ports) for (const p of ports) { try { p.postMessage({ reset: true }); } catch { /* port closing */ } }
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "ml-devtools") return;
    let tabId: number | null = null;
    port.onMessage.addListener((msg: any) => {
        if (msg?.type === "ml-devtools-init" && typeof msg.tabId === "number") {
            const tid: number = msg.tabId;   // const local: TS narrows it (a captured `let` wouldn't)
            tabId = tid;
            let set = devtoolsPorts.get(tid);
            if (!set) { set = new Set(); devtoolsPorts.set(tid, set); }
            set.add(port);
            port.postMessage({ replay: debugBuffer.get(tid) || [] });   // catch a late-opened panel up
        }
    });
    port.onDisconnect.addListener(() => {
        const tid = tabId;
        if (tid == null) return;
        const set = devtoolsPorts.get(tid);
        if (set) { set.delete(port); if (!set.size) devtoolsPorts.delete(tid); }
    });
});

// The Spotlight command bar keyboard shortcut (manifest `commands`, default Alt+Space, user-rebindable
// at chrome://extensions/shortcuts). Tell the active tab's shell to open the HUD composer; the shell
// no-ops unless the HUD is the active surface. `chrome.commands` may be absent in a test harness.
chrome.commands?.onCommand.addListener((command, tab) => {
    if (command === "open-composer" && tab?.id != null)
        chrome.tabs.sendMessage(tab.id, { type: "ML_OPEN_COMPOSER" }).catch(() => { /* no content script on this tab */ });
});

// Right-click "Ask window.ml about this" — the content-script shell resolves the clicked element's
// semantic container + clean context and opens the Commander pre-loaded with it (see shell.ts). Created on
// install (persists); re-created defensively in case the item was cleared. contextMenus may be absent in tests.
chrome.runtime.onInstalled?.addListener((details) => {
    // A deliberate reload or an update (NOT an idle SW respawn — that never fires onInstalled): invalidate any
    // in-flight background run. Its snapshot may be from OLD code, and this is often how you kill a runaway —
    // it must never silently resume across the reload. hydrate() may have loaded old snapshots into memory a
    // moment ago on this same spawn; purge those too.
    if (details?.reason === "install" || details?.reason === "update") void purgeAllBgRuns();
    try {
        chrome.contextMenus?.removeAll?.(() => {
            // Fresh run.
            chrome.contextMenus?.create({ id: "ml-ask-about-this", title: "Ask window.ml about this…", contexts: ["all"] });
            // Append to the run already open in the HUD (steer if running, follow-up if idle). Falls back to a
            // fresh composer page-side when nothing's open, so it's never a dead entry.
            chrome.contextMenus?.create({ id: "ml-add-to-run", title: "Add this to the current window.ml run…", contexts: ["all"] });
        });
    } catch { /* not available */ }
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (tab?.id == null) return;
    if (info.menuItemId === "ml-ask-about-this")
        chrome.tabs.sendMessage(tab.id, { type: "ML_ASK_ABOUT_THIS" }).catch(() => { /* no content script on this tab */ });
    else if (info.menuItemId === "ml-add-to-run")
        chrome.tabs.sendMessage(tab.id, { type: "ML_ADD_TO_CURRENT_RUN" }).catch(() => { /* no content script on this tab */ });
});

// ---- Offscreen Pyodide host (python_exec) ----
// The service worker can't run WASM, so python_exec runs in an offscreen document
// (extension-origin, 'wasm-unsafe-eval' CSP). Created lazily on first use, reused after.
let offscreenReady: Promise<void> | null = null;
function ensureOffscreen(): Promise<void> {
    if (offscreenReady) return offscreenReady;
    offscreenReady = (async () => {
        if (await chrome.offscreen.hasDocument?.()) return;
        try {
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: [chrome.offscreen.Reason.WORKERS],
                justification: "Runs the sandboxed Python (Pyodide/WASM) execution for the python_exec tool.",
            });
        } catch (e) {
            if (!(await chrome.offscreen.hasDocument?.())) throw e;   // tolerate a concurrent create
        }
    })();
    offscreenReady.catch(() => { offscreenReady = null; });   // let a failed create be retried
    return offscreenReady;
}
