// move-run.ts — move a run to another tab the person chose, between its turns or between the steps of a running one
// (docs/spec/MOVE_RUN.md, shapes (a) and (b)).

import { activeRuns, bgRuns, firstTurnLeftTabs, noTabReplay, releaseRunTab, isWorkerRun, makeWorkerRun, rekeyRunInbox, runControllers, runRebuilds, runInboxes, runReplayBuffer, startingControllers, tabHasBgRun, trackRun } from "./sw-runs";
import type { RebuildConfig } from "../contract";
import { adoptOnTab } from "./adopt-run";
import { delegateSend } from "./delegate-send";
import { cancelPageTasks } from "./sw-tasks";
import { pushReplay } from "../contract/contract-run";
import { clearArrival, watchBetweenTurns } from "./nav-arrival";
import { grantRunOrigin } from "./worker-tools";
import { recordRunLog } from "./sw-run-log";
import { toPageUi } from "./sw-side-panel";
import { relayDebugEvent } from "./sw-debug";
import { defineState } from "../state-registry";
import { isNoTab } from "./no-tab";
import { refreshTaskRow } from "./sw-task-rows";

/** The replay ring's cap, as `bufferReplay` keeps it (sw-runs.ts). */
const REPLAY_CAP = 400;

/** What the tab a run left is told, on its card and panel. Names no site: it is said on the old tab's page. */
export const MOVED_AWAY = "This session was moved to another tab. Continue it there, or bring it back here with \"Bring a session here\".";

/** What a move answers: done, queued until the running turn's current step ends, or refused, each with the sentence the
 *  person reads. */
export type MoveOutcome = { moved: true } | { queued: string } | { refused: string };

/** What the person is told when the run they moved has a turn running. */
export const MOVE_QUEUED = "The session is running: it moves to this tab when its current step ends.";

const RUNNING = "That session is starting: wait for its turn to begin or end, then move it.";

/** The moves the person asked for while the run's turn ran, by run: the destination tab. Applied at the turn's next step
 *  boundary ({@link applyLiveMove}) or, when the turn ends first, after it ({@link moveAfterTurn}); a later ask replaces
 *  an earlier one. `nav` marks the tab a run with no tab opened with `navigate` (no-tab-nav.ts), which the model is told
 *  as its own navigation. */
const queuedMoves = new Map<string, { tab: number; nav?: true }>();
defineState({
    id: "run.queuedMove", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "The tab the person moved the run to while its turn ran, which it moves to when its current step ends.",
    read: ({ runId }) => (runId ? queuedMoves.get(runId)?.tab : undefined),
});

defineState({
    id: "run.moved", scope: "session", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "That the person moved the run to another tab since its last turn, which its next turn tells the model.",
    read: ({ runId }) => (runId ? bgRuns.get(runId)?.moved : undefined),
});
defineState({
    id: "run.leftTabs", scope: "session", realm: "worker", audience: "human", lostOn: ["worker-eviction", "browser-restart"],
    describe: "The tabs the person moved the run off, so a message typed on one is told the session moved. A turn's checkpoint keeps them through an eviction mid-turn; between turns, and in a saved session, they are lost.",
    read: ({ runId }) => (runId ? bgRuns.get(runId)?.leftTabs : undefined),
});

/**
 * The note the model reads at the start of a moved run's next turn: the tab it left and the one it is on now. A system
 * message, the worker's and never the person's words, sent to the model only: no page is sent it.
 * @param from the tab it left: its title and URL as the run last stored them
 * @param to the tab the person chose: its title and URL as the browser reports them
 * @returns the note
 */
export const movedNote = (from: { title?: string; url?: string }, to: { title: string; url: string }): string =>
    `[the person moved this run from tab "${from.title || from.url || "unknown"}"${from.url ? ` (${from.url})` : ""} to tab "${to.title}" (${to.url}); the previous page's state is not carried]`;

/**
 * The note the model reads once the tab its `navigate` opened from no tab holds the run (TABLESS_RUN.md, "`navigate`
 * from the detached state"). A system message, the worker's words.
 * @param to the tab it opened: its title and URL as the browser reports them
 * @returns the note
 */
export const navigatedNote = (to: { title: string; url: string }): string =>
    `[this run had no tab; its navigate opened tab "${to.title}" (${to.url}), and the run is on it now]`;

/**
 * The note the model reads when the tab its `navigate` opened from no tab could not take the run.
 * @param reason why, as the execution log records it
 * @returns the note
 */
export const navDroppedNote = (reason: string): string =>
    `[the tab your navigate opened could not take this run (${reason}); the run still has no tab, and its page tools still need one]`;

/**
 * Take the note a move left for a run's next turn, once.
 * @param runId the run
 * @returns the note, or undefined when the run was not moved since its last turn
 */
export function takeMovedNote(runId: string): string | undefined {
    const snap = bgRuns.get(runId);
    const note = snap?.moved;
    if (snap) delete snap.moved;
    return note;
}

/**
 * Re-home a settled run onto another tab, between its turns: its stored snapshot's tab, its replay ring, its arrival
 * watcher, its start origin, and a note for the model. Nothing else filed under the old tab moves, and nothing filed
 * under the new tab is overwritten; the old tab is left as it is. The caller has proved the person asked
 * (`isExtensionSender`): nothing here reads a page.
 * @param runId the run
 * @param toTabId the tab the person chose
 * @returns moved, or why not
 */
export async function moveRun(runId: string, toTabId: number, opts: { nav?: true } = {}): Promise<MoveOutcome> {
    if (startingControllers.has(runId)) return { refused: RUNNING };
    if (runControllers.has(runId) || runInboxes.has(runId)) return queueLiveMove(runId, toTabId);
    const snap = bgRuns.get(runId);
    if (!snap) return { refused: "This browser no longer holds that session in memory; resume it instead." };
    const from = snap.tabId;
    if (from === toTabId) return { moved: true };
    const tab = await Promise.resolve(chrome.tabs.get(toTabId)).catch(() => undefined);
    // The URL and title are the browser's, never something a page said about itself.
    const url = tab?.url || "";
    if (!tab || !/^https?:/i.test(url)) return { refused: "A session can only move to an ordinary web page (http or https)." };
    // A turn may have started during the await: it takes the move at its first step boundary instead.
    if (startingControllers.has(runId)) return { refused: RUNNING };
    if (runControllers.has(runId) || bgRuns.get(runId) !== snap) return queueLiveMove(runId, toTabId);
    // A page-built run is the worker's from here on, as at a navigation onto a site that may not use window.ml.
    if (!isWorkerRun(runId)) makeWorkerRun(runId);
    const left = { title: snap.p.pageTitle, url: snap.p.pageUrl };
    snap.tabId = toTabId;
    const origin = new URL(url).origin;
    snap.p = { ...snap.p, pageOrigin: origin, pageUrl: url, pageTitle: tab.title || undefined };
    // The person choosing the tab is the consent the cross-domain gate asks for (agent-tools.md, "Variant B").
    grantRunOrigin(runId, origin);
    snap.moved = opts.nav ? navigatedNote({ title: tab.title || url, url }) : movedNote(left, { title: tab.title || url, url });
    // Brought back to a tab it left, that tab is its own again.
    // From no tab there is no tab it left (no-tab.ts).
    snap.leftTabs = [...(snap.leftTabs ?? []).filter((t) => t !== toTabId), ...(isNoTab(from) ? [] : [from])];
    // The destination's card shows the session now, from its history, as a re-adopting page's does.
    for (const event of moveReplay(runId, from, toTabId)) toPageUi(toTabId, { type: "ML_DEBUG_TO_PAGE", event }, { frameId: 0 });
    // A run resumed onto a tab with no turn since (`adoptSession` tracks it there) is registered on the old tab: let it go.
    releaseRunTab(from, runId);
    // The tab it left keeps the session on screen: say where it went, there only (not its replay, which a page can read).
    const leftNote = { kind: "agent-note", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: MOVED_AWAY };
    toPageUi(from, { type: "ML_DEBUG_TO_PAGE", event: leftNote });
    relayDebugEvent(from, leftNote);
    // The old tab's page no longer holds the run, and the next turn's start judges the new tab's.
    clearArrival(runId);
    watchBetweenTurns(toTabId, runId);
    recordRunLog(runId, { subsystem: "tab", kind: "moved", detail: { from, to: toTabId } });
    // A run that had no tab has one now: its session row stops saying so.
    if (isNoTab(from)) void refreshTaskRow(runId);
    return { moved: true };
}

/** Take a run's events out of one tab's replay ring into another's, so the destination page rebuilds its card; returns
 *  the events taken. */
function moveReplay(runId: string, from: number, to: number): unknown[] {
    // From no tab, the run's own ring (sw-runs.ts `noTabReplay`) is taken whole.
    const own = isNoTab(from) ? noTabReplay.get(runId) : undefined;
    if (own) noTabReplay.delete(runId);
    const old = own ?? runReplayBuffer.get(from);
    if (!old) return [];
    const mine = (e: unknown): boolean => (e as { id?: unknown })?.id === runId;
    const taken = old.filter(mine);
    if (!taken.length) return [];
    const kept = old.filter((e) => !mine(e));
    if (own) { /* the run's own ring: nothing of another run's to keep */ }
    else if (kept.length || activeRuns.has(from) || tabHasBgRun(from)) runReplayBuffer.set(from, kept);
    else runReplayBuffer.delete(from);
    const dest = runReplayBuffer.get(to) ?? [];
    for (const e of taken) pushReplay(dest, e, REPLAY_CAP);
    runReplayBuffer.set(to, dest);
    return taken;
}

/**
 * Queue a move for a run whose turn is running (MOVE_RUN.md, shape (b), slice 2). Nothing moves now: a call of the
 * current step may be on the old page, or waiting at a gate there. The turn takes it at its next step boundary.
 * @param runId the run
 * @param toTabId the tab the person chose
 * @returns queued, moved (back to the tab it is on, which cancels a queued move), or why not
 */
async function queueLiveMove(runId: string, toTabId: number): Promise<MoveOutcome> {
    // A page script's run answers to that page, which waits on its result: it moves only once that turn has ended.
    if (!isWorkerRun(runId)) return { refused: "A run a page script started moves only between its turns: wait for its turn to end, then move it." };
    if (runInboxes.get(runId)?.tabId === toTabId) { queuedMoves.delete(runId); return { moved: true }; }
    // Started not to leave its page (`navigate: false`): nothing rebuilds its tools on another one mid-turn.
    if (!runRebuilds.has(runId)) return { refused: "This run was started to stay on its page: wait for its turn to end, then move it." };
    const tab = await Promise.resolve(chrome.tabs.get(toTabId)).catch(() => undefined);
    if (!tab || !/^https?:/i.test(tab.url || "")) return { refused: "A session can only move to an ordinary web page (http or https)." };
    // The turn ended during the await: a move between turns, as the person asked.
    if (!runControllers.has(runId) && !runInboxes.has(runId)) return moveRun(runId, toTabId);
    queuedMoves.set(runId, { tab: toTabId });
    recordRunLog(runId, { subsystem: "tab", kind: "move-queued", detail: { to: toTabId } });
    return { queued: MOVE_QUEUED };
}

/**
 * Queue the move onto the tab a running turn with no tab opened with `navigate` (no-tab-nav.ts): applied, as a person's
 * move is, at the turn's next step boundary, or after the turn when it ended first. A later move the person asks for
 * replaces it.
 * @param runId the run
 * @param toTabId the tab the navigate opened
 */
export function queueNavMove(runId: string, toTabId: number): void {
    queuedMoves.set(runId, { tab: toTabId, nav: true });
    recordRunLog(runId, { subsystem: "tab", kind: "move-queued", reason: "navigate", detail: { to: toTabId } });
}

/** What a running turn lends {@link applyLiveMove}: the tab it is on, the page it shows, and how to re-point the turn's own
 *  page fields and consent at the destination. */
export interface LiveTurn {
    /** the tab the turn is on now (its tab cell's binding) */
    tabId: () => number;
    /** the page the turn is on, as the run last stored it */
    page: () => { title?: string; url?: string };
    /** what a page needs to rebuild the run's toolset; undefined for a run that opted out of cross-page persistence */
    rebuild: () => RebuildConfig | undefined;
    /** re-point the turn's stored page (`pageOrigin`, `pageUrl`, `pageTitle`) and its turn-local consent at the destination */
    onPage: (page: { origin: string; url: string; title?: string }) => void;
}

/**
 * Apply a move the person queued while this turn ran, at a step boundary: every call of the previous step has answered
 * and the next model request has not gone out, so nothing in flight points at the old tab. The destination page is
 * adopted first; a move it cannot take is dropped, logged, and the run stays where it is. Then, for this run only: its
 * tracking entry and pin, its replay ring, its inbox and the turn's tab cell (the tab binding, the worker tools, the CDP
 * attach, the arrival watcher), its start origin, and its page-bound tasks, cancelled (ASYNC_CALLS.md, rule 4a).
 * @param runId the run
 * @param turn the running turn
 * @returns the note for the model and the destination's page context, or undefined when no move was queued or it was
 *   dropped
 */
export async function applyLiveMove(runId: string, turn: LiveTurn): Promise<{ note: string; pageInfo?: string } | undefined> {
    const queued = queuedMoves.get(runId);
    if (!queued) return undefined;
    queuedMoves.delete(runId);
    const { tab: to, nav } = queued;
    const from = turn.tabId();
    if (to === from) return undefined;
    // A person's move that cannot be made is the person's to see (the log); a navigate's is the model's, which was told it went.
    const drop = (reason: string): { note: string } | undefined => {
        recordRunLog(runId, { level: "warn", subsystem: "tab", kind: "move-dropped", reason, detail: { from, to, ...(nav ? { navigate: true } : {}) } });
        return nav ? { note: navDroppedNote(reason) } : undefined;
    };
    const tab = await Promise.resolve(chrome.tabs.get(to)).catch(() => undefined);
    const url = tab?.url || "";
    if (!tab || !/^https?:/i.test(url)) return drop("not-a-page");
    const rebuild = turn.rebuild();
    if (!rebuild) return drop("no-rebuild");
    const r = await adoptOnTab(to, runId, rebuild).catch((e) => ({ error: String((e as Error)?.message || e) }));
    if (r.error) return drop("no-adopt");
    const pageInfo = "pageInfo" in r ? r.pageInfo : undefined;
    // Filed under the destination before its replay arrives: a first turn's `trackRun` wipes an idle tab's ring.
    trackRun(to, runId, rebuild);
    const left = turn.page();
    for (const event of moveReplay(runId, from, to)) toPageUi(to, { type: "ML_DEBUG_TO_PAGE", event }, { frameId: 0 });
    releaseRunTab(from, runId);
    // The old page's hold on the run goes; the cell re-arms the turn's arrival judge on the new tab.
    clearArrival(runId);
    rekeyRunInbox(runId, to);
    const origin = new URL(url).origin;
    grantRunOrigin(runId, origin);
    turn.onPage({ origin, url, title: tab.title || undefined });
    const snap = bgRuns.get(runId);
    if (snap) {
        snap.tabId = to;
        snap.p = { ...snap.p, pageOrigin: origin, pageUrl: url, pageTitle: tab.title || undefined };
    }
    // Brought back to a tab it left, that tab is its own again. A first turn has no `bgRuns` entry yet: its turn's end
    // takes them from `firstTurnLeftTabs` (`keptOnRebuild`).
    // From no tab there is no tab it left (no-tab.ts).
    const leftTabs = [...((snap?.leftTabs ?? firstTurnLeftTabs.get(runId)) ?? []).filter((t) => t !== to), ...(isNoTab(from) ? [] : [from])];
    if (snap) snap.leftTabs = leftTabs;
    else firstTurnLeftTabs.set(runId, leftTabs);
    // The old page's registration of the run ends, as a turn's end ends it; nothing it answers is read.
    void delegateSend(from, { type: "RUN_TOOL_IN_PAGE", payload: { runId, finish: true } }).catch(() => null);
    const leftNote = { kind: "agent-note", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: MOVED_AWAY };
    toPageUi(from, { type: "ML_DEBUG_TO_PAGE", event: leftNote });
    relayDebugEvent(from, leftNote);
    void cancelPageTasks(runId);
    recordRunLog(runId, { subsystem: "tab", kind: "moved", ...(nav ? { reason: "navigate" } : {}), detail: { from, to, live: true } });
    // A run that had no tab has one now: its session row stops saying so.
    if (isNoTab(from)) void refreshTaskRow(runId);
    const dest = { title: tab.title || url, url };
    return { note: nav ? navigatedNote(dest) : movedNote(left, dest), ...(pageInfo ? { pageInfo } : {}) };
}

/**
 * A move queued during a turn that ended before its next step boundary: made now, between turns, as {@link moveRun}
 * makes it. Called once the turn has settled.
 * @param runId the run
 */
export function moveAfterTurn(runId: string): void {
    const queued = queuedMoves.get(runId);
    if (!queued) return;
    queuedMoves.delete(runId);
    const to = queued.tab;
    void moveRun(runId, to, queued.nav ? { nav: true } : {}).then((r) => {
        if ("refused" in r) recordRunLog(runId, { level: "warn", subsystem: "tab", kind: "move-dropped", reason: "after-turn", detail: { to } });
    }, () => recordRunLog(runId, { level: "warn", subsystem: "tab", kind: "move-dropped", reason: "after-turn", detail: { to } }));
}
