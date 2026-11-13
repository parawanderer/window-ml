// move-run.ts — move a run between its turns to another tab the person chose (docs/spec/MOVE_RUN.md, shape (a)).

import { activeRuns, bgRuns, releaseRunTab, isWorkerRun, makeWorkerRun, runControllers, runInboxes, runReplayBuffer, startingControllers, tabHasBgRun } from "./sw-runs";
import { pushReplay } from "../contract/contract-run";
import { clearArrival, watchBetweenTurns } from "./nav-arrival";
import { grantRunOrigin } from "./worker-tools";
import { recordRunLog } from "./sw-run-log";
import { toPageUi } from "./sw-side-panel";
import { relayDebugEvent } from "./sw-debug";
import { defineState } from "../state-registry";

/** The replay ring's cap, as `bufferReplay` keeps it (sw-runs.ts). */
const REPLAY_CAP = 400;

/** What the tab a run left is told, on its card and panel. Names no site: it is said on the old tab's page. */
export const MOVED_AWAY = "This session was moved to another tab. Continue it there, or bring it back here with \"Bring a session here\".";

/** What a move answers: done, or refused with the sentence the person reads. */
export type MoveOutcome = { moved: true } | { refused: string };

defineState({
    id: "run.moved", scope: "session", realm: "worker", audience: "model", lostOn: ["worker-eviction"],
    describe: "That the person moved the run to another tab since its last turn, which its next turn tells the model.",
    read: ({ runId }) => (runId ? bgRuns.get(runId)?.moved : undefined),
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
export async function moveRun(runId: string, toTabId: number): Promise<MoveOutcome> {
    if (runControllers.has(runId) || runInboxes.has(runId) || startingControllers.has(runId)) return { refused: "That session is running: wait for its turn to end, or stop it, then move it." };
    const snap = bgRuns.get(runId);
    if (!snap) return { refused: "This browser no longer holds that session in memory; resume it instead." };
    const from = snap.tabId;
    if (from === toTabId) return { moved: true };
    const tab = await Promise.resolve(chrome.tabs.get(toTabId)).catch(() => undefined);
    // The URL and title are the browser's, never something a page said about itself.
    const url = tab?.url || "";
    if (!tab || !/^https?:/i.test(url)) return { refused: "A session can only move to an ordinary web page (http or https)." };
    // A turn may have started during the await.
    if (runControllers.has(runId) || startingControllers.has(runId) || bgRuns.get(runId) !== snap) return { refused: "That session is running: wait for its turn to end, or stop it, then move it." };
    // A page-built run is the worker's from here on, as at a navigation onto a site that may not use window.ml.
    if (!isWorkerRun(runId)) makeWorkerRun(runId);
    const left = { title: snap.p.pageTitle, url: snap.p.pageUrl };
    snap.tabId = toTabId;
    const origin = new URL(url).origin;
    snap.p = { ...snap.p, pageOrigin: origin, pageUrl: url, pageTitle: tab.title || undefined };
    // The person choosing the tab is the consent the cross-domain gate asks for (agent-tools.md, "Variant B").
    grantRunOrigin(runId, origin);
    snap.moved = movedNote(left, { title: tab.title || url, url });
    // Brought back to a tab it left, that tab is its own again.
    snap.leftTabs = [...(snap.leftTabs ?? []).filter((t) => t !== toTabId), from];
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
    return { moved: true };
}

/** Take a run's events out of one tab's replay ring into another's, so the destination page rebuilds its card; returns
 *  the events taken. */
function moveReplay(runId: string, from: number, to: number): unknown[] {
    const old = runReplayBuffer.get(from);
    if (!old) return [];
    const mine = (e: unknown): boolean => (e as { id?: unknown })?.id === runId;
    const taken = old.filter(mine);
    if (!taken.length) return [];
    const kept = old.filter((e) => !mine(e));
    if (kept.length || activeRuns.has(from) || tabHasBgRun(from)) runReplayBuffer.set(from, kept);
    else runReplayBuffer.delete(from);
    const dest = runReplayBuffer.get(to) ?? [];
    for (const e of taken) pushReplay(dest, e, REPLAY_CAP);
    runReplayBuffer.set(to, dest);
    return taken;
}
