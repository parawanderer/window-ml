// delegate-send.ts — the one way the worker sends a message into a run's tab and waits for the page's answer: held while the tab navigates, watched while it waits.

import type { HousekeepingReport } from "../log/housekeeping";
import { type TabState, watchWhileWaiting, PageUnreachable } from "./page-reachable";
import { noteRunMechanic, navBarrier } from "./sw-runs";

// EVERY RUN_TOOL_IN_PAGE send goes through this: it waits out any in-flight navigation on the tab before
// delegating. On a tab with no navigation pending, whenReady resolves immediately (zero cost) — so a
// single-page run is unaffected.
//
// …and then WATCHES the tab while it waits, because the send has a third outcome besides answering and
// rejecting: a tab the browser put to sleep in the background still has a registered receiver, so the call
// simply sits. One measured run spent 13m57s inside a `pageInfo` here and was released by the person opening
// the tab. `page-reachable.ts` has the reasoning; what it costs a healthy call is one `chrome.tabs.get`.
const tabState = async (tabId: number): Promise<TabState> => {
    try { return (await chrome.tabs.get(tabId)).discarded ? "asleep" : "awake"; }
    catch { return "gone"; }   // the id no longer resolves: closed, or replaced by a discard under a new id
};

// A barrier wait shorter than this is the ordinary cost of a page committing a navigation, and saying so every
// time would bury the waits that mattered.
const BARRIER_NOTE_MS = 250;

/** What a delegated send is about, for the run's log: the tool's own name, which cannot be a record's `reason`
 *  (those are lowercase slugs and a tool is `pageInfo` or `python_exec`), so it travels in `detail`. */
const sendDetail = (tabId: number, msg: unknown): Record<string, string | number> => {
    const name = (msg as { payload?: { name?: unknown } })?.payload?.name;
    return { tab: tabId, ...(typeof name === "string" && name ? { tool: name } : {}) };
};

/** Send a message into a run's tab and wait for the page's answer, the way every delegated tool call is sent: held
 *  while the tab navigates, and watched while it waits, so a discarded tab is rebuilt and a frozen one is bounded
 *  (see above). Also how the worker pushes a run's toolset into a tab (sw-run-start.ts `adoptOnTab`). */
export const delegateSend = async (tabId: number, msg: unknown, documentId?: string): Promise<any> => {
    // THE RUN'S LOG, not the transcript: a step already shows how long a tool took. What it cannot show is that
    // the wait was the browser rather than the tool — a navigation being committed, a discarded tab rebuilt, a
    // page that stopped answering. Those are the lines someone asking "where did the time go" comes for.
    const detail = sendDetail(tabId, msg);
    const note = (kind: string, extra: Partial<HousekeepingReport> = {}): void =>
        noteRunMechanic(tabId, { ...extra, subsystem: "page", kind, detail: { ...detail, ...extra.detail } });
    const held = Date.now();
    await navBarrier.whenReady(tabId);
    const waited = Date.now() - held;
    if (waited >= BARRIER_NOTE_MS) note("held", { reason: "navigating", ms: waited });
    // Pinned to a document, a send the tab can no longer deliver there is refused by the browser rather than delivered
    // to whatever document the tab holds now (an approved exec routed for one page, sw-isolated-exec.ts).
    const send = () => (documentId ? chrome.tabs.sendMessage(tabId, msg, { documentId }) : chrome.tabs.sendMessage(tabId, msg));
    try { return await watchWhileWaiting(send(), () => tabState(tabId)); }
    catch (e) {
        if (!(e instanceof PageUnreachable) || e.state !== "asleep") {
            if (e instanceof PageUnreachable) note("unreachable", { level: "error", reason: e.state, ms: e.waitedMs });
            throw e;
        }
        // A DISCARDED tab has no document, so there is nothing to preserve and a reload costs nothing that is
        // not already lost — which is the whole reason this is safe to do without asking. Reloading is also the
        // one way to touch the tab that does not take the person's screen away from them, and the new document
        // re-adopts the run on CONTENT_READY, which is exactly what the barrier waits for. One retry: if the
        // page cannot answer after being rebuilt, the tool fails with a sentence instead of looping.
        note("discarded", { level: "warn", ms: e.waitedMs });
        navBarrier.noteNavigating(tabId);
        const ok = await chrome.tabs.reload(tabId).then(() => true, () => false);
        await navBarrier.whenReady(tabId);
        // No reason when the reload worked, the browser's own word for it when it did not: an absent reason
        // reads as "and then it was fine", which is what the next line is about to confirm or deny.
        note("reloaded", ok ? {} : { level: "error", reason: "gone" });
        const from = Date.now();
        try {
            const answer = await watchWhileWaiting(send(), () => tabState(tabId));
            // The story needs its ending. Without this the log reads "discarded, reloaded" and then stops, and
            // whether the run went on is left to be inferred from what did NOT appear underneath it.
            note("recovered", { ms: Date.now() - from });
            return answer;
        } catch (again) {
            if (again instanceof PageUnreachable) note("unreachable", { level: "error", reason: again.state, ms: again.waitedMs, detail: { retried: true } });
            throw again;
        }
    }
};
