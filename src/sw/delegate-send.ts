// delegate-send.ts — the one way the worker sends a message into a run's tab and waits for the page's answer: held while the tab navigates, watched while it waits.

import type { HousekeepingReport } from "../log/housekeeping";
import { type TabState, watchWhileWaiting, PageUnreachable, PING_TIMEOUT_MS } from "./page-reachable";
import { noteRunMechanic, navBarrier } from "./sw-runs";
import { READOPT_TIMEOUT_MS } from "./nav-barrier";

// EVERY RUN_TOOL_IN_PAGE send goes through this: it waits out any in-flight navigation on the tab before
// delegating. On a tab with no navigation pending, whenReady resolves immediately (zero cost) — so a
// single-page run is unaffected.
//
// …and then WATCHES the tab while it waits, because the send has a third outcome besides answering and
// rejecting: a tab the browser put to sleep in the background still has a registered receiver, so the call
// simply sits. One measured run spent 13m57s inside a `pageInfo` here and was released by the person opening
// the tab. `page-reachable.ts` has the reasoning; what it costs a healthy call is one `chrome.tabs.get`, plus a ping
// on a browser that reports the tab unfrozen.
const tabState = async (tabId: number): Promise<TabState> => {
    let tab: chrome.tabs.Tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { return "gone"; }   // the id no longer resolves: closed, or replaced by a discard under a new id
    if (tab.discarded) return "asleep";
    // Measured (tests/e2e/page-health.spec.mjs, CDP Page.crash): a dead renderer leaves the tab `unloaded` and not
    // discarded. A navigating tab reads `loading`.
    if (tab.status === "unloaded") return "crashed";
    // Frozen, or a browser that does not say: no ping can tell busy from frozen, so the cap decides as before.
    if ((tab as { frozen?: boolean }).frozen !== false) return "awake";
    return await answersPing(tabId) ? "awake" : "unresponsive";
};

/** Whether the tab's content script answers a question it answers synchronously (PRESENCE_CHECK, content.ts), so
 *  whether the page's main thread is running at all. A refusal (no receiver: a document mid-swap) is not a missed
 *  ping; only silence is. */
const answersPing = (tabId: number): Promise<boolean> => new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), PING_TIMEOUT_MS) as unknown as { unref?: () => void };
    t.unref?.();
    chrome.tabs.sendMessage(tabId, { type: "PRESENCE_CHECK" }, { frameId: 0 }).then(() => resolve(true), () => resolve(true));
});

/** Chrome's words for a send whose receiving document went away: a navigation, or a renderer that died. */
export const CHANNEL_GONE = /message channel closed|Receiving end does not exist|No tab with id/i;

/** After a send lost its channel, whether the tab's renderer crashed rather than navigated. Asked once and at once:
 *  the tab already read unloaded in both measured crashes (page-health.spec.mjs C1, C2), and any wait here delays a
 *  navigation's handling past a fast new page's re-adopt, which the barrier then refuses. A miss falls back to the
 *  navigation path, as before. */
const crashedAfter = async (tabId: number): Promise<boolean> => {
    try { const t = await chrome.tabs.get(tabId); return t.status === "unloaded" && !t.discarded; }
    catch { return false; }
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
 *  (see above). Also how the worker pushes a run's toolset into a tab (sw-run-start.ts `adoptOnTab`). `beforeSend`, if
 *  given, runs just before each send, after every wait, and refuses it by throwing or rejecting. */
export const delegateSend = async (tabId: number, msg: unknown, documentId?: string, beforeSend?: () => void | Promise<void>): Promise<any> => {
    // THE RUN'S LOG, not the transcript: a step already shows how long a tool took. What it cannot show is that
    // the wait was the browser rather than the tool — a navigation being committed, a discarded tab rebuilt, a
    // page that stopped answering. Those are the lines someone asking "where did the time go" comes for.
    const detail = sendDetail(tabId, msg);
    const note = (kind: string, extra: Partial<HousekeepingReport> = {}): void =>
        noteRunMechanic(tabId, { ...extra, subsystem: "page", kind, detail: { ...detail, ...extra.detail } });
    // A tool call that waited out the barrier with no re-adopt goes to a page that never registered the run, which
    // answers "no active agent run … (it may have ended)": wrong about the run, and paid for with a 15 s wait per send
    // of the step (#1034, a page blocking the re-adopt: four for one click). The barrier now waits a navigation out
    // once, and that answer (`noRun`) after it ends the tool saying the page did not take the run back, with the
    // barrier's bound as the time it had. Still sent, not refused here: a page whose CSP keeps our page script from
    // running (raw.githubusercontent.com) never re-adopts either, and the content script's own answer names the CSP.
    const held = Date.now();
    const ready = await navBarrier.whenReady(tabId);
    const waited = Date.now() - held;
    if (waited >= BARRIER_NOTE_MS) note("held", { reason: "navigating", ms: waited });
    const unadopted = (answer: unknown, wasReady: boolean, extra: Partial<HousekeepingReport> = {}): unknown => {
        if (wasReady || (answer as { noRun?: unknown } | undefined)?.noRun !== true) return answer;
        note("unreachable", { ...extra, level: "error", reason: "unadopted" });
        throw new PageUnreachable("unadopted", READOPT_TIMEOUT_MS);
    };
    // Pinned to a document, a send the tab can no longer deliver there is refused by the browser rather than delivered
    // to whatever document the tab holds now (an approved exec routed for one page, sw-isolated-exec.ts).
    // `beforeSend` may refuse the send by throwing, checked at each send after the waits (a run handed to the worker
    // meanwhile, sw-run-host.ts).
    // Awaited, then sent in the same turn: nothing else of this worker runs between the check and the send.
    const send = async () => { await beforeSend?.(); return documentId ? chrome.tabs.sendMessage(tabId, msg, { documentId }) : chrome.tabs.sendMessage(tabId, msg); };
    try { return unadopted(await watchWhileWaiting(send(), () => tabState(tabId)), ready); }
    catch (e) {
        // A lost channel is a navigation unless the tab says its renderer died: then every later send fails the same way,
        // and waiting out the navigation barrier for a page that will not come is 15 s each time.
        if (!(e instanceof PageUnreachable) && CHANNEL_GONE.test((e as Error)?.message || String(e)) && await crashedAfter(tabId)) {
            note("unreachable", { level: "error", reason: "crashed", ms: Date.now() - held - waited });
            throw new PageUnreachable("crashed", Date.now() - held - waited);
        }
        if (!(e instanceof PageUnreachable) || e.state !== "asleep") {
            if (e instanceof PageUnreachable && e.state === "unadopted") throw e;
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
        const rebuilt = await navBarrier.whenReady(tabId);
        // No reason when the reload worked, the browser's own word for it when it did not: an absent reason
        // reads as "and then it was fine", which is what the next line is about to confirm or deny.
        note("reloaded", ok ? {} : { level: "error", reason: "gone" });
        const from = Date.now();
        try {
            const answer = unadopted(await watchWhileWaiting(send(), () => tabState(tabId)), rebuilt, { detail: { retried: true } });
            // The story needs its ending. Without this the log reads "discarded, reloaded" and then stops, and
            // whether the run went on is left to be inferred from what did NOT appear underneath it.
            note("recovered", { ms: Date.now() - from });
            return answer;
        } catch (again) {
            if (again instanceof PageUnreachable && again.state !== "unadopted") note("unreachable", { level: "error", reason: again.state, ms: again.waitedMs, detail: { retried: true } });
            throw again;
        }
    }
};
