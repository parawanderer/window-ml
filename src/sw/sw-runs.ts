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

import { dropLocalTools } from "./sw-local-tools";
import { bgRunResumable, pushReplay } from "../contract/contract-run";
import { moveTabKey } from "./tab-replaced";
import { recordRunLog } from "./sw-run-log";
import { type DerefRead } from "../contract/contract-pointers";
import { type NeutralMessage } from "../contract/contract-chat";
import { type StartRunPayload } from "../contract/contract-messages";
import { createNavBarrier } from "./nav-barrier";
import { releaseSessionValues } from "./sw-values";
import { TokenStore } from "../pointers/token-pipe";
import { defineState } from "../state-registry";
import { CHARS_PER_TOKEN, type CurrentSnapshot } from "../agent/current-context";
import { contextTextOf, pickMeta, pointerRow, preview } from "../agent/state-rows";

// Design A: the AbortController for each live background run, keyed by runId, so a CANCEL_RUN message
// (the HUD's "Cancel agent run") stops the loop at the next boundary AND kills a slow in-flight model
// call. Deleted when the run settles. Aborting resolves the loop as { cancelled: true } (partial transcript).
export const runControllers = new Map<string, AbortController>();

// Design A resume (Phase 2): after a background-hosted run settles, keep enough to CONTINUE it — the
// full message history + the original StartRunPayload (deps are rebuilt from it) + the owning tab. A
// RESUME_RUN {runId, task} re-enters the loop from this history. In-memory only, so it's subject to
// MV3 service-worker eviction (~30s idle) — resume works while the SW is warm (the common
// finish-then-follow-up flow); an evicted run reports an actionable error and the caller starts fresh.
export const bgRuns = new Map<string, { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("../contract").SubcallUsage }>();
defineState({
    id: "run.init", scope: "session", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "What the run was started with: the task, model, step budget, tool names and what it may do without asking.",
    read: ({ runId }) => {
        // `bgRuns` holds a run once a turn has settled; during the FIRST turn the payload is only the live turn's.
        const p = runId ? bgRuns.get(runId)?.p ?? turnByRun.get(runId)?.().payload : undefined;
        return p && {
            task: p.task, model: p.model, think: p.think, maxSteps: p.maxSteps, tools: p.tools.map((t) => t.name),
            images: p.images?.length ?? 0, surface: p.surface, unattended: !!p.unattended, toolTokens: !!p.toolTokens,
            autoApprove: { readonly: p.autoApproveReadonly, python: p.autoApprovePython, sameOriginAuth: !!p.autoApproveSameOriginAuth, selfSource: !!p.autoApproveSelfSource },
        };
    },
});
defineState({
    id: "run.sub", scope: "session", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "What the run's delegated sub-calls (vision, grounding) have spent.",
    read: ({ runId }) => (runId ? bgRuns.get(runId)?.sub : undefined),
});

/** Runs the WORKER assembled (sw-run-start.ts) whose first turn has not settled yet: `bgRuns` holds a run only once a
 *  turn has, and a page must not be able to drive one in that window either. */
export const workerRunsStarting = new Set<string>();

/**
 * Hand a stored run to the WORKER: from now on it is driven from the worker only, fans its own lifecycle events, asks
 * the page for its curated answer when a turn ends, and its page registers tools without a page-side resume handle.
 * For a run whose builder page is gone (a durable resume after an eviction always meets a fresh document; a saved
 * session adopted onto a tab), where nothing page-side is left to own it.
 * @param runId the run
 */
export function makeWorkerRun(runId: string): void {
    const stored = bgRuns.get(runId);
    if (stored) stored.p = { ...stored.p, builtBy: "worker", ...(stored.p.rebuild ? { rebuild: { ...stored.p.rebuild, builtBy: "worker" } } : {}) };
    const rb = runRebuilds.get(runId);
    if (rb) runRebuilds.set(runId, { ...rb, builtBy: "worker" });
}

/**
 * Whether the worker assembled this run (a run the user started from a surface, or a saved session adopted onto a
 * tab). Such a run is driven only from the worker: a PAGE may not start a turn in it, continue it or steer it, since
 * that would let the page decide what the person's run does (docs/spec/SITE_ACCESS.md, slice 0).
 * @param runId the run
 * @returns true for a worker-built run
 */
export function isWorkerRun(runId: unknown): boolean {
    return typeof runId === "string" && (workerRunsStarting.has(runId) || bgRuns.get(runId)?.p.builtBy === "worker");
}

// ---- Durable resume ----
// A LIVE run's resumable snapshot is also mirrored to chrome.storage.local, so a re-spawned SW (MV3 evicts
// ~30s idle) can rehydrate an in-flight run instead of losing it. Storage holds ONLY running runs — deleted
// the moment a run settles; the in-memory bgRuns above additionally keeps COMPLETED runs for a follow-up
// RESUME (still eviction-bound, as before). Snapshot shape == a bgRuns entry.
type BgRunSnap = { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("../contract").SubcallUsage; version?: string; ts?: number };

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

/**
 * The model a person switched a run to (`session.model`), by run. Read at every model call, so a running loop takes it
 * at its next step, and applied when a finished run is resumed or a handle starts its next turn with the model it was
 * built with. Kept in storage, since the switch has to outlive the worker the way the run does.
 */
const runModels = new Map<string, string>();
const RUN_MODELS_KEY = "ml_run_models";
/** More would be sessions nobody switches back to; the oldest go first. */
const RUN_MODELS_MAX = 200;
defineState({
    id: "run.model", scope: "session", realm: "worker", audience: "model", lostOn: [],
    describe: "The model a person switched the run to, which its next model call uses.",
    read: ({ runId }) => (runId ? runModels.get(runId) : undefined),
});
try {
    void chrome.storage?.local?.get(RUN_MODELS_KEY).then((got) => {
        const saved = (got?.[RUN_MODELS_KEY] ?? {}) as Record<string, string>;
        for (const [runId, model] of Object.entries(saved)) if (!runModels.has(runId) && typeof model === "string") runModels.set(runId, model);
    }).catch(() => { /* storage unavailable: switches made before the restart are lost */ });
} catch { /* no storage (a test harness) */ }

function saveRunModels(): void {
    while (runModels.size > RUN_MODELS_MAX) runModels.delete(runModels.keys().next().value!);
    try { void chrome.storage?.local?.set({ [RUN_MODELS_KEY]: Object.fromEntries(runModels) }).catch(() => {}); } catch { /* storage unavailable */ }
}

/** The model a run was switched to, or undefined when nobody switched it. */
export const runModelFor = (runId: string): string | undefined => runModels.get(runId);

/** Switch a run's model from its next model call, and its resumable snapshot with it. */
export function switchRunModel(runId: string, model: string): void {
    runModels.delete(runId);   // re-inserted last, so the cap drops the oldest switch rather than this one
    runModels.set(runId, model);
    const held = bgRuns.get(runId);
    if (held) held.p = { ...held.p, model };
    saveRunModels();
}

/** Forget a run's switch: the session was deleted. */
export function forgetRunModel(runId: string): void {
    if (runModels.delete(runId)) saveRunModels();
}

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
defineState({
    id: "run.interrupted", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "Whether a worker restart interrupted the run, and whether it was resumed afterwards.",
    read: ({ runId }) => (runId && (hydratedRuns.has(runId) || resurrectedRuns.has(runId))
        ? { resumed: resurrectedRuns.has(runId) } : undefined),
});

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
export const runInboxes = new Map<string, { tabId: number; queue: { id?: string; text: string; origin?: import("../contract/contract-run").PromptOrigin }[] }>();
defineState({
    id: "run.mailbox", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction", "turn-end"],
    describe: "Messages sent to the run that it has not read yet; it reads them at its next step.",
    read: ({ runId }) => runId ? runInboxes.get(runId)?.queue.map((m) => ({ text: m.text, origin: m.origin ?? null })) : undefined,
});

// ---- Cross-page persistence (Variant A; design tmp/cross-page-agent.md) ----
// A background-hosted run delegates each DOM tool to its tab by tabId. When the page NAVIGATES the old
// document — and the toolset it registered — is destroyed and the new document loads a fresh, EMPTY toolset;
// firing the next delegated tool into that gap hits "no active agent run on this page". The barrier holds a
// delegated send while the tab is mid-navigation and releases when the new document RE-ADOPTS the run
// (rebuilds + re-registers its toolset — the CONTENT_READY → adopt round-trip). `activeRuns` maps a tab to
// the run ids it hosts so the webNavigation sensor knows which tabs to watch. See nav-barrier.ts.
export const navBarrier = createNavBarrier();

export const activeRuns = new Map<number, Set<string>>();   // tabId → runIds hosted in that tab

/** Records a mechanic for whichever run(s) this TAB is hosting — the shape every tab-keyed emitter needs, since
 *  the machinery that reloads a discarded tab or attaches a debugger is addressed to a tab and the log is read
 *  per run. Silent when no run is on the tab: this log is a run's, and there is no run to tell. */
export const noteRunMechanic = (tabId: number, report: Parameters<typeof recordRunLog>[1]): void => {
    for (const runId of activeRuns.get(tabId) ?? []) recordRunLog(runId, report);
};

// A PAGE-HOSTED run's loop lives in the page, so there is no runId the worker can vouch for: `derefByRun` is empty and
// `activeRuns` holds only runs WE host. Its values are therefore held for the TAB, under this session name. Nothing the
// page sends names it — the worker claims a value at the moment it DISCLOSES that value's key to the tab (the only way
// a key ever reaches a page), so a claim is a record of what this worker handed over rather than an assertion by the
// page, and a key from anywhere else reads nothing. Released when the document that was handed it goes: a page-hosted
// loop dies with its document, so a main-frame navigation ends the entitlement along with the run that held it.
export const pageValueSession = (tabId: number): string => `page:${tabId}`;

// The rebuild-config for each LIVE cross-page run (runId → RebuildConfig), set at START and cleared in the
// run's finally. bgRuns only stores a snapshot at run COMPLETION, so a MID-run navigation reads this instead.
export const runRebuilds = new Map<string, import("../contract").RebuildConfig>();

// Overlay/off REPLAY buffer (cross-page): a background-hosted, cross-page-capable run's FULL debug-event
// stream per tab, so a FRESH page after a same-site navigation can rebuild the run's card MID-run (with its
// history) instead of only catching the tail. Kept separate from the DevTools debugBuffer (further below) so
// the two surfaces' replay don't entangle. Bounded ring; cleared when the tab's runs end (untrackRun).
export const runReplayBuffer = new Map<number, unknown[]>();

const REPLAY_CAP = 400;   // drop-oldest (screenshots are big)

// The document each tab's replay was last sent to. A page sends CONTENT_READY whenever it likes (PAGE_ADOPT_HELLO), and
// each one replayed the whole history into the card again, which repeats every unsequenced row the person reads.
export const replayedTo = new Map<number, string>();   // state: plumbing

// The destination page's pageInfo, captured on re-adopt (RUN_READOPTED) and consumed ONCE by the navigate
// tool call awaiting it — so a nav's result carries the new page's context (orient-on-nav). Keyed by tab, with the
// document that sent it, so a caller can refuse the one its navigation left.
export const readoptPageInfo = new Map<number, { info: string; doc?: string }>();

/** Keep one event in a tab's replay ring, so a page that loads LATE can rebuild the run's corner card. */
export const bufferReplay = (tabId: number, event: unknown): void => {
    let buf = runReplayBuffer.get(tabId);
    if (!buf) { buf = []; runReplayBuffer.set(tabId, buf); }
    pushReplay(buf, event, REPLAY_CAP);
};

// KEEPING A RUN'S TAB. The browser discards a background tab under memory pressure (and, with Memory Saver on,
// just for being in the background a while), which takes the document — and with it the toolset the run delegates
// to — without any navigation to notice. `autoDiscardable: false` is the one hint Chrome offers, and a tab hosting
// a run is the clearest case there is for it: the person is waiting on work happening in there.
//
// The pin has to be UNDONE, including when this worker never gets the chance. The ids are kept in
// storage.session, which outlives an eviction and does not outlive the browser — the same life as the flag
// itself — so `reconcileTabPins` on the next worker can release a tab whose run did not come back with it.
const PINNED_TABS = "ml_pinned_tabs";

const setPinned = async (tabId: number, on: boolean): Promise<void> => {
    try {
        await chrome.tabs.update(tabId, { autoDiscardable: !on });
        const held = new Set<number>(((await chrome.storage.session.get(PINNED_TABS))[PINNED_TABS] as number[] | undefined) || []);
        if (on) held.add(tabId); else held.delete(tabId);
        await chrome.storage.session.set({ [PINNED_TABS]: [...held] });
    } catch { /* the tab went: nothing to pin, and nothing to release */ }
};

/** Ask the browser not to discard a tab while we are hosting a run in it (and to stop asking once we are not). */
export const keepTabAwake = (tabId: number, on: boolean): void => { void setPinned(tabId, on); };

/** Release every tab this worker's PREDECESSOR pinned and did not get to release — an eviction mid-run leaves the
 *  flag set with nobody left who knows why. Run after the rehydrate, so a run that came back keeps its tab. */
export const reconcileTabPins = async (): Promise<void> => {
    try {
        const held: number[] = ((await chrome.storage.session.get(PINNED_TABS))[PINNED_TABS] as number[] | undefined) || [];
        const keep = held.filter((id) => activeRuns.has(id));
        for (const id of held) if (!activeRuns.has(id)) await chrome.tabs.update(id, { autoDiscardable: true }).catch(() => { /* gone */ });
        if (keep.length !== held.length) await chrome.storage.session.set({ [PINNED_TABS]: keep });
    } catch { /* no session storage, or no tabs: nothing to reconcile */ }
};

/** Register a run against its tab so the navigation sensor watches it, and decide what that tab's replay buffer
 *  keeps: a fresh run wipes it, a RESUME of the same run must not (a resume never re-emits the `agent` start). */
export const trackRun = (tabId: number, runId: string, rebuild?: import("../contract").RebuildConfig): void => {
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
    keepTabAwake(tabId, true);
    recordRunLog(runId, { subsystem: "tab", kind: "pinned", reason: "hosting", detail: { tab: tabId } });
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
    contextByRun.delete(runId);
    turnByRun.delete(runId);
    // NOT tokensByRun: this runs in each TURN's finally (the run stays resumable in bgRuns), so dropping the
    // pointer store here emptied it between turns — the exact bug the session-scoped store was meant to fix.
    // Its life is the SESSION's, so it is released with the bgRuns entry instead (see releaseSessionTokens).

    const s = activeRuns.get(tabId);
    if (!s) return;
    s.delete(runId);
    if (!s.size) {
        activeRuns.delete(tabId); navBarrier.forget(tabId); readoptPageInfo.delete(tabId);
        keepTabAwake(tabId, false);   // nothing of ours is waiting on this tab any more
        recordRunLog(runId, { subsystem: "tab", kind: "released", detail: { tab: tabId } });
        // Keep the replay buffer if a just-completed run is still resumable on this tab (bgRuns.set ran in the
        // run's .then, before this .finally) — a late/reloaded page replays it once (CONTENT_READY). Else drop it.
        if (!tabHasBgRun(tabId)) runReplayBuffer.delete(tabId);
    }
};

// Pointer resolvers for background-hosted runs, keyed by runId — handed over by the loop at start (tokenSink)
// so a page-side tool's `ml.dereference` can read THIS run's captured outputs. Deleted when the run ends.
export const derefByRun = new Map<string, (ref: string, pipe?: string | string[]) => DerefRead>();

/** The live turn's context snapshot per background-hosted run (the loop's `contextSink`): what `ml.current` and the
 *  state inspector read while a turn runs. A per-TURN closure like `derefByRun`, dropped with it in `untrackRun`;
 *  between turns `run.messages` reads the history `bgRuns` kept instead. */
export const contextByRun = new Map<string, (extra?: { model?: string | null; log?: readonly import("../log/run-log").RunLogEvent[] }) => CurrentSnapshot>();

/** What the live TURN holds that lives only in `hostRun`'s closure: what it was asked, and what it was allowed this
 *  turn without asking again. Set at the turn's start and dropped with it in `untrackRun`, like `contextByRun`. */
export const turnByRun = new Map<string, () => {
    task: string; images: number; origin: import("../contract/contract-run").PromptOrigin | null; startedTs: number; origins: string[]; sheets: string[];
    /** The payload the turn was hosted with: on a first turn, the only copy of the start payload (`bgRuns` has none yet). */
    payload: StartRunPayload;
}>();
defineState({
    id: "run.input", scope: "run", realm: "worker", audience: "model", lostOn: ["worker-eviction", "turn-end"],
    describe: "What the turn now running was asked: the prompt, how many images came with it, and where it was typed.",
    read: ({ runId }) => {
        const t = runId ? turnByRun.get(runId)?.() : undefined;
        return t && { task: t.task, images: t.images, origin: t.origin, startedTs: t.startedTs };
    },
});
defineState({
    id: "grants.turn", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction", "turn-end"],
    describe: "What this turn may do without asking again: the origins it may navigate to (and fetch from), and the spreadsheets approved for python_exec.",
    read: ({ runId }) => {
        const t = runId ? turnByRun.get(runId)?.() : undefined;
        return t && { origins: t.origins, sheets: t.sheets };
    },
});

defineState({
    id: "run.messages", scope: "session", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "The context the run's next model call gets, one row per message: who wrote it, its size, when, and from which step.",
    read: ({ runId }) => {
        if (!runId) return undefined;
        const live = contextByRun.get(runId)?.();
        if (live) return live.messages.map((m, i) => ({ role: m.role, text: preview(m), ...pickMeta(live.meta[i]) }));
        // Between turns: the history the run kept for a follow-up, with nothing known about each message but itself.
        return bgRuns.get(runId)?.messages.map((m) => ({ role: m.role, text: preview(m), tokens: Math.ceil(((typeof m.content === "string" ? m.content.length : 0) + JSON.stringify(m.tool_calls ?? "").length) / CHARS_PER_TOKEN), tokensBasis: "estimated", images: m.images?.length ?? 0 }));
    },
});

// The `@tool:` pointer store per background-hosted run, kept ACROSS the turns of one session so a follow-up
// ("how did you compute that?") can still dereference the previous turn's output. Deliberately NOT a field on
// the bgRuns record: that record is JSON-checkpointed to storage for MV3 eviction, and a Map serializes to
// `{}` — it would rehydrate as a plain object and blow up on the first read. Bounded by TokenStore.CAP, and
// dropped with the run in untrackRun. An SW eviction loses it, like the rest of the run's in-memory state.
const tokensByRun = new Map<string, TokenStore>();

/** How many SESSIONS' pointer stores to keep. Each is itself capped (TokenStore.CAP); this bounds the number
 *  of them, so a service worker that outlives many runs can't accumulate without limit. */
const MAX_TOKEN_SESSIONS = 24;
defineState({
    id: "run.pointers", scope: "session", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "The run's `@tool:` values: what each tool call returned, addressable by id, label or tool name.",
    read: ({ runId }) => {
        const all = runId ? tokensByRun.get(runId)?.all() : undefined;
        if (!all) return undefined;
        const text = contextText(runId!);
        return all.map((v) => pointerRow(v, text));
    },
});

/** The text of the run's context (the live turn's, or the history kept between turns), for finding which pointers it
 *  still mentions. Null when neither is held. */
function contextText(runId: string): string | null {
    const msgs = contextByRun.get(runId)?.().messages ?? bgRuns.get(runId)?.messages;
    return msgs ? contextTextOf(msgs) : null;
}

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
export function releaseSessionTokens(runId: string): void { tokensByRun.delete(runId); releaseSessionValues(runId); dropLocalTools(runId); }

// The navigation SENSOR: a committed MAIN-frame navigation on a tab that hosts a live run means its document
// (and registered toolset) is going away → engage the barrier so the next delegated tool waits for re-adopt.
// Sub-frame navigations (frameId != 0) don't replace the run's document, so they're ignored.
/** Each tab's current main-frame URL, as navigation reports it — so a background-hosted run can tell a fetch
 *  of the page it is ON from a fetch of the page it STARTED on (see `fetchIsCurrentPage`). History-API
 *  changes count too: an SPA moves between URLs without committing a navigation. */
export const tabPageUrl = new Map<number, string>();
defineState({
    id: "run.page", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "The tab the run is on and the page that tab shows now, which can differ from the page it started on.",
    read: ({ runId }) => {
        const tabId = runId ? bgRuns.get(runId)?.tabId : undefined;
        return tabId == null ? undefined : { tabId, url: tabPageUrl.get(tabId) ?? null };
    },
});

/** A tab Chrome has handed a NEW id (`chrome.tabs.onReplaced` — a discard restored, a prerender swapped in):
 *  move everything this module files under the old one, or the run it is hosting is orphaned under an id nothing
 *  will ever send again, and the restored page's CONTENT_READY finds nothing to re-adopt. The barrier is not
 *  moved: its state belongs to the document that went away. */
export const retabRuns = (from: number, to: number): number => {
    // Read before the move: afterwards nothing is filed under the old id, which is the whole problem being fixed.
    const hosted = [...(activeRuns.get(from) ?? [])];
    const moved = moveTabKey([activeRuns, runReplayBuffer, readoptPageInfo, tabPageUrl] as Array<Map<number, unknown>>, from, to);
    for (const runId of hosted) recordRunLog(runId, { subsystem: "tab", kind: "replaced", detail: { tab: to, wasTab: from } });
    for (const snap of bgRuns.values()) if (snap.tabId === from) snap.tabId = to;
    navBarrier.forget(from);
    return moved;
};

/** The key a state read for one run needs: the run, and the tab it is on (the grants are filed by tab). */
export const stateKeyFor = (runId: string): { runId: string; tabId?: number } => {
    // The tab HOSTING it now first: `bgRuns` holds a run only once a turn has settled, so a first turn has no entry yet.
    for (const [tabId, ids] of activeRuns) if (ids.has(runId)) return { runId, tabId };
    return { runId, tabId: bgRuns.get(runId)?.tabId };
};
