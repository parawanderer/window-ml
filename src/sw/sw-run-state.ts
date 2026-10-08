// sw-run-state.ts — DUMP_RUN_STATE: the state inspector's read of one run, assembled from the state registry
// (state-registry.ts) in the worker, plus what the run's PAGE holds (its answer set, its `@pt`/`@box` tokens), asked of
// the tab the run is on. Extension pages only, like DUMP_RUN_LOG: the grants and the mailbox are the person's to see,
// and a page could otherwise read another tab's run.

import { pageStateFrom, readState, readableMembers, type StateEntry, type StateMember } from "../state-registry";
import { hydrationDone, stateKeyFor } from "./sw-runs";
import { senderOrigin } from "./sw-housekeeping";

/** A declared member, whether or not it holds anything for this run, so the pane can show an empty one as empty. */
export type RunStateMember = StateMember;

/** How long the page gets to answer. A state read is a walk over a few maps; a page that takes longer is busy or gone,
 *  and the pane re-reads in two seconds anyway. */
export const PAGE_STATE_TIMEOUT_MS = 1500;

/** What DUMP_RUN_STATE answers with. */
export interface RunStateDump {
    /** When it was read: the pane says how old what it shows is. */
    ts: number;
    /** Every member a person may see, the worker's and then the page's, each in id order. */
    members: RunStateMember[];
    /** What the members that hold something for this run hold. */
    entries: StateEntry[];
    /** Why the page's members are missing, when the run has a tab and its page did not answer. */
    pageError?: string;
}

/** Ask the run's tab what its page holds for the run. Never wakes a discarded tab: reading state must not reload a
 *  page, which is what a delegated tool send does (`delegateSend`). */
async function askPage(tabId: number, runId: string, taken: ReadonlySet<string>): Promise<{ members: StateMember[]; entries: StateEntry[] } | { error: string }> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { error: "the run's tab is closed" };
    if (tab.discarded) return { error: "the run's tab is asleep (discarded by the browser); it is not woken to be read" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: "RUN_STATE_IN_PAGE", payload: { runId } }).catch(() => null),
        new Promise<"timeout">((done) => { timer = setTimeout(() => done("timeout"), PAGE_STATE_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (answer === "timeout") return { error: "the page did not answer in time" };
    return pageStateFrom(answer, taken) ?? { error: "the page did not answer" };
}

/** DUMP_RUN_STATE: every readable member of one run's state, as of now. */
export async function handleRunStateDump(payload: unknown, sender: chrome.runtime.MessageSender): Promise<{ data?: RunStateDump; error?: string }> {
    if (senderOrigin(sender) === "page") return { error: "Refused: the run's state is for extension pages." };
    const run = typeof (payload as { run?: unknown } | null)?.run === "string" ? (payload as { run: string }).run : "";
    // On a fresh worker the run maps are empty until hydration settles, which would read as "this run holds nothing".
    await hydrationDone;
    const members = readableMembers("worker");
    if (!run) return { data: { ts: Date.now(), members, entries: [] } };
    const key = stateKeyFor(run);
    const entries = await readState(key, "human", "worker");
    if (key.tabId == null) return { data: { ts: Date.now(), members, entries } };
    const page = await askPage(key.tabId, run, new Set(members.map((m) => m.id)));
    if ("error" in page) return { data: { ts: Date.now(), members, entries, pageError: page.error } };
    return { data: { ts: Date.now(), members: [...members, ...page.members], entries: [...entries, ...page.entries] } };
}
