// sw-runs.ts — WHAT THE WORKER KNOWS ABOUT A RUN: the lifecycle state behind every background-hosted run, and the
// pointer store that outlives each of its turns.
//
// Extracted from background.ts, which is the message ROUTER. This is the state that router mutates: which runs exist,
// which tab hosts each, what a fresh document needs to re-adopt one after a navigation, what a late-loading page
// replays to rebuild its corner card, and which pointers a session still answers for.
//
// The thing to hold in mind is that NONE of it survives the worker being evicted, which MV3 does without warning. So
// a live run is also SNAPSHOT to chrome.storage.local (`persistRun`) before its first step and after each one, and
// `hydratePersistedRuns` rebuilds the maps when the worker starts again. In-memory state is the fast path; the
// snapshot is what makes an interrupted run resumable rather than lost.
//
// Two lifetimes that are easy to conflate, and the bugs came from conflating them: a TURN ends with `untrackRun`,
// while the SESSION — its pointer store, its claimed values — lives until its `bgRuns` entry is purged or the
// token-store LRU drops it. Dropping the pointers in the turn's finally emptied them between turns, which is the
// exact failure the session-scoped store was introduced to fix.

import { type NeutralMessage, bgRunResumable, pushReplay, type DerefRead } from "./contract";
import { type StartRunPayload } from "./contract-messages";
import { createNavBarrier } from "./nav-barrier";
import { releaseSessionValues } from "./sw-values";
import { TokenStore } from "./token-pipe";

// Design A: the AbortController for each live background run, keyed by runId, so a CANCEL_RUN message
// (the HUD's "Cancel agent run") stops the loop at the next boundary AND kills a slow in-flight model
// call. Deleted when the run settles. Aborting resolves the loop as { cancelled: true } (partial transcript).
export const runControllers = new Map<string, AbortController>();

// Design A resume (Phase 2): after a background-hosted run settles, keep enough to CONTINUE it — the
// full message history + the original StartRunPayload (deps are rebuilt from it) + the owning tab. A
// RESUME_RUN {runId, task} re-enters the loop from this history. In-memory only, so it's subject to
// MV3 service-worker eviction (~30s idle) — resume works while the SW is warm (the common
// finish-then-follow-up flow); an evicted run reports an actionable error and the caller starts fresh.
export const bgRuns = new Map<string, { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("./contract").SubcallUsage }>();

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

/** Snapshot a live run to storage so a worker evicted mid-run can resume it: called before the first step and
 *  after each one. The in-memory maps are the fast path; this is what makes an interrupted run resumable. */
export const persistRun = (runId: string, snap: BgRunSnap): void => {
    // Stamp version + a fresh timestamp on every write so hydrate can tell a live (evicted-seconds-ago) run
    // from a zombie (bgRunResumable), and reject a cross-version snapshot outright.
    try { void chrome.storage?.local?.set({ [BGRUN_KEY(runId)]: { ...snap, version: EXT_VERSION, ts: Date.now() } }); } catch { /* storage unavailable */ }
};

/** Drop a settled run's storage snapshot — it is only there to survive an eviction, and the run no longer can. */
export const deleteRun = (runId: string): void => {
    try { void chrome.storage?.local?.remove(BGRUN_KEY(runId)); } catch { /* storage unavailable */ }
};

// Purge EVERY persisted background run (storage + any already-hydrated in-memory state). Called on an
// extension install/update (a deliberate reload / a version bump): in-flight runs must NOT survive it — their
// snapshot may be from old code, and a reload is often exactly how you try to kill a runaway.
export async function purgeAllBgRuns(): Promise<void> {
    try {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all || {}).filter(k => k.startsWith("ml_bgrun_"));
        if (keys.length) await chrome.storage.local.remove(keys);
    } catch { /* storage unavailable */ }
    // Drop anything hydrate already loaded this spawn so a page load can't re-adopt + resume it.
    for (const runId of [...hydratedRuns]) {
        const snap = bgRuns.get(runId);
        if (snap) untrackRun(snap.tabId, runId);
        bgRuns.delete(runId); hydratedRuns.delete(runId); releaseSessionTokens(runId);
    }
    resurrectedRuns.clear();
}

// On SW startup: rehydrate any in-flight runs from storage into bgRuns + re-track them against their tab
// (activeRuns/runRebuilds) so the nav sensor + re-adopt find them. A run then continues via the existing
// resume path (page-driven today; auto-resume-on-readopt is the next slice). No-op on a first, clean spawn.
// Runs loaded from storage on THIS SW spawn = INTERRUPTED (evicted mid-flight, never settled — their storage
// snapshot outlived them). A fresh page re-adopt AUTO-RESUMES these (part 2); a run that merely COMPLETED
// (its snapshot was deleted in the finally) is not here, so it's never re-driven.
export const hydratedRuns = new Set<string>();

// Runs RESURRECTED from storage after an SW respawn (hydrated → auto-resumed). CONTENT_READY moves a runId
// here as it marks the adopt `resume:true` (and clears it from hydratedRuns). RESUME_RUN reads it to know
// the surface LOST this run's session (the respawn wiped in-memory + the replay buffer), so it must RE-EMIT
// the `agent` start — a visible, Stoppable row — instead of silently resuming into a ghost.
export const resurrectedRuns = new Set<string>();

/** Rebuild the run maps from storage when the worker starts again, so a run the eviction interrupted is resumable
 *  rather than lost. Awaited through `hydrationDone` by anything that would otherwise read an empty map. */
export async function hydratePersistedRuns(): Promise<void> {
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

/** Resolves once the persisted runs are back in the maps. Await it before answering a question about which runs
 *  exist: on a fresh worker the maps are empty until this settles, which reads as "the run is gone". */
export const hydrationDone: Promise<void> = (typeof chrome !== "undefined" && chrome.storage?.local) ? hydratePersistedRuns() : Promise.resolve();

// Per-run steering inbox (a.say() mid-run): the SW-side twin of the page loop's control.inbox. INJECT_MESSAGE
// pushes here (only the owning tab may); the run's loop drains it at each step boundary (deps.drainInbox).
// Present only while a run is live (set at start, deleted in finally).
export const runInboxes = new Map<string, { tabId: number; queue: { id?: string; text: string }[] }>();

// ---- Cross-page persistence (Variant A; design tmp/cross-page-agent.md) ----
// A background-hosted run delegates each DOM tool to its tab by tabId. When the page NAVIGATES the old
// document — and the toolset it registered — is destroyed and the new document loads a fresh, EMPTY toolset;
// firing the next delegated tool into that gap hits "no active agent run on this page". The barrier holds a
// delegated send while the tab is mid-navigation and releases when the new document RE-ADOPTS the run
// (rebuilds + re-registers its toolset — the CONTENT_READY → adopt round-trip). `activeRuns` maps a tab to
// the run ids it hosts so the webNavigation sensor knows which tabs to watch. See nav-barrier.ts.
export const navBarrier = createNavBarrier();

export const activeRuns = new Map<number, Set<string>>();   // tabId → runIds hosted in that tab

// A PAGE-HOSTED run's loop lives in the page, so there is no runId the worker can vouch for: `derefByRun` is empty and
// `activeRuns` holds only runs WE host. Its values are therefore held for the TAB, under this session name. Nothing the
// page sends names it — the worker claims a value at the moment it DISCLOSES that value's key to the tab (the only way
// a key ever reaches a page), so a claim is a record of what this worker handed over rather than an assertion by the
// page, and a key from anywhere else reads nothing. Released when the document that was handed it goes: a page-hosted
// loop dies with its document, so a main-frame navigation ends the entitlement along with the run that held it.
export const pageValueSession = (tabId: number): string => `page:${tabId}`;

// The rebuild-config for each LIVE cross-page run (runId → RebuildConfig), set at START and cleared in the
// run's finally. bgRuns only stores a snapshot at run COMPLETION, so a MID-run navigation reads this instead.
export const runRebuilds = new Map<string, import("./contract").RebuildConfig>();

// Overlay/off REPLAY buffer (cross-page): a background-hosted, cross-page-capable run's FULL debug-event
// stream per tab, so a FRESH page after a same-site navigation can rebuild the run's card MID-run (with its
// history) instead of only catching the tail. Kept separate from the DevTools debugBuffer (further below) so
// the two surfaces' replay don't entangle. Bounded ring; cleared when the tab's runs end (untrackRun).
export const runReplayBuffer = new Map<number, unknown[]>();

const REPLAY_CAP = 400;   // drop-oldest (screenshots are big)

// The destination page's pageInfo, captured on re-adopt (RUN_READOPTED) and consumed ONCE by the navigate
// tool call awaiting it — so a nav's result carries the new page's context (orient-on-nav). Keyed by tab.
export const readoptPageInfo = new Map<number, string>();

/** Keep one event in a tab's replay ring, so a page that loads LATE can rebuild the run's corner card. */
export const bufferReplay = (tabId: number, event: unknown): void => {
    let buf = runReplayBuffer.get(tabId);
    if (!buf) { buf = []; runReplayBuffer.set(tabId, buf); }
    pushReplay(buf, event, REPLAY_CAP);
};

/** Register a run against its tab so the navigation sensor watches it, and decide what that tab's replay buffer
 *  keeps: a fresh run wipes it, a RESUME of the same run must not (a resume never re-emits the `agent` start). */
export const trackRun = (tabId: number, runId: string, rebuild?: import("./contract").RebuildConfig): void => {
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
export const tabHasBgRun = (tabId: number): boolean => { for (const r of bgRuns.values()) if (r.tabId === tabId) return true; return false; };

/** End a TURN: drop its per-turn resolver and its tab registration. Deliberately NOT the session's pointer store,
 *  whose life is the run's — see the header. */
export const untrackRun = (tabId: number, runId: string): void => {
    runRebuilds.delete(runId);
    derefByRun.delete(runId);   // the resolver is a per-TURN closure over that turn's loop — it must not outlive it
    // NOT tokensByRun: this runs in each TURN's finally (the run stays resumable in bgRuns), so dropping the
    // pointer store here emptied it between turns — the exact bug the session-scoped store was meant to fix.
    // Its life is the SESSION's, so it is released with the bgRuns entry instead (see releaseSessionTokens).

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

// Pointer resolvers for background-hosted runs, keyed by runId — handed over by the loop at start (tokenSink)
// so a page-side tool's `ml.dereference` can read THIS run's captured outputs. Deleted when the run ends.
export const derefByRun = new Map<string, (ref: string, pipe?: string | string[]) => DerefRead>();

// The `@tool:` pointer store per background-hosted run, kept ACROSS the turns of one session so a follow-up
// ("how did you compute that?") can still dereference the previous turn's output. Deliberately NOT a field on
// the bgRuns record: that record is JSON-checkpointed to storage for MV3 eviction, and a Map serializes to
// `{}` — it would rehydrate as a plain object and blow up on the first read. Bounded by TokenStore.CAP, and
// dropped with the run in untrackRun. An SW eviction loses it, like the rest of the run's in-memory state.
const tokensByRun = new Map<string, TokenStore>();

/** How many SESSIONS' pointer stores to keep. Each is itself capped (TokenStore.CAP); this bounds the number
 *  of them, so a service worker that outlives many runs can't accumulate without limit. */
const MAX_TOKEN_SESSIONS = 24;

/** This run's pointer store, created on the first turn and REUSED by every later turn of the same session. */
export const sessionTokens = (runId: string): TokenStore => {
    const existing = tokensByRun.get(runId);
    if (existing) { tokensByRun.delete(runId); tokensByRun.set(runId, existing); return existing; }   // keep it fresh
    const fresh = new TokenStore();
    tokensByRun.set(runId, fresh);
    while (tokensByRun.size > MAX_TOKEN_SESSIONS) releaseSessionTokens(tokensByRun.keys().next().value as string);
    return fresh;
};

/** Release a SESSION's pointers — only when the session itself is gone (its bgRuns entry dropped, or its store pushed
 *  out by newer sessions), never at the end of a turn. Paired with every `bgRuns.delete` so the two lifetimes cannot
 *  drift apart again. The stored values those pointers named go with them: nothing can address them any more. */
export function releaseSessionTokens(runId: string): void { tokensByRun.delete(runId); releaseSessionValues(runId); }
