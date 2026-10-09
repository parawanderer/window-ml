// sw-run-state.ts — DUMP_RUN_STATE: the state inspector's read of one run, assembled from the state registry
// (state-registry.ts) in the worker, plus what the run's PAGE holds (its answer set, its `@pt`/`@box` tokens), asked of
// the tab the run is on. Extension pages only, like DUMP_RUN_LOG: the grants and the mailbox are the person's to see,
// and a page could otherwise read another tab's run.

import { readState, readableMembers, membersFor, withPageState, type StateEntry, type StateMember } from "../state-registry";
import { contextByRun, hydrationDone, stateKeyFor } from "./sw-runs";
import { senderOrigin } from "./sw-housekeeping";
import { CONSOLE_STEPS, evalConsole, evalWatch, stateTree, treeShape, WATCH_STEPS, watchList, type ConsoleJs, type ConsoleResult, type WatchJs, type WatchResult, type WatchShape } from "../state-watch";
import { evalReadonly, NeedsPage } from "../readonly-exec";
import { runLog } from "./sw-run-log";
import { sessionServer } from "./sw-sessions";
import { withUserWatches } from "./sw-shared-watches";

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
    /** The panel's watches, each over this snapshot (state-watch.ts), in the order they were sent. */
    watches?: WatchResult[];
    /** The shape of what a watch reads (`inspector`, and `ml.current` while a turn runs), for completing one as it is
     *  typed. Keys and kinds only: the live context's values reach the panel only through a watch the person wrote. */
    shape?: WatchShape;
    /** The console entry sent with this read, run once over the same snapshot as the watches. */
    console?: ConsoleResult;
}

/** Ask the run's tab what its page holds for the run. Never wakes a discarded tab: reading state must not reload a
 *  page, which is what a delegated tool send does (`delegateSend`). */
async function askPage(tabId: number, runId: string): Promise<{ raw: unknown } | { error: string }> {
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
    return answer ? { raw: answer } : { error: "the page did not answer" };
}

/** DUMP_RUN_STATE: every readable member of one run's state, as of now, and the panel's watches over it. */
export async function handleRunStateDump(payload: unknown, sender: chrome.runtime.MessageSender): Promise<{ data?: RunStateDump; error?: string }> {
    if (senderOrigin(sender) === "page") return { error: "Refused: the run's state is for extension pages." };
    const p = (payload ?? {}) as { run?: unknown; watches?: unknown; console?: unknown };
    const run = typeof p.run === "string" ? p.run : "";
    // On a fresh worker the run maps are empty until hydration settles, which would read as "this run holds nothing".
    await hydrationDone;
    const snap = await snapshot(run);
    // Evaluated HERE, over exactly what the panel is about to draw: the person's whole snapshot, since the panel is theirs.
    // A watch shared with the model will be evaluated over the model's members only (spec, "Watches").
    const watches = watchList(p.watches);
    const entry = typeof p.console === "string" ? p.console : undefined;
    // `ml.current` in a watch is the LIVE snapshot, the object the model reads, made once for every watch of this read.
    const live = run ? contextByRun.get(run) : undefined;
    // With the shared watches in it, as the model's own read has them (sw-shared-watches.ts).
    const current = live ? await withUserWatches(live({ log: await runLog.forRun(run) })) : undefined;
    const tree = stateTree(snap.members, snap.entries, current === undefined ? undefined : JSON.parse(JSON.stringify(current)));
    const shape = treeShape(tree);
    if (!watches.length && entry === undefined) return { data: { ts: Date.now(), ...snap, shape } };
    // Neither a watch nor the console has a page: what it reads is the run's state, in this realm.
    const dialect = async (code: string, inspector: unknown, stepBudget: number, onLog?: (line: string) => void) => {
        try {
            return (await evalReadonly(code, null, {}, undefined, { realm: "worker", current, globals: { inspector }, stepBudget, onLog })).value;
        } catch (e) {
            if (e instanceof NeedsPage) throw new Error("this reads the run's state, not the page: the page is not reachable from here");
            throw e;
        }
    };
    const js: WatchJs = (code, inspector) => dialect(code, inspector, WATCH_STEPS);
    const results: WatchResult[] = [];
    for (const w of watches) results.push(await evalWatch(tree, w, js));   // one at a time: each has its own step budget
    const runEntry: ConsoleJs = (code, inspector, onLog) => dialect(code, inspector, CONSOLE_STEPS, onLog);
    const consoleResult = entry === undefined ? undefined : await evalConsole(tree, entry, runEntry);
    return { data: { ts: Date.now(), ...snap, ...(watches.length ? { watches: results } : {}), shape, ...(consoleResult ? { console: consoleResult } : {}) } };
}

/** One run's members and what they hold: the worker's, and the page's when the run has a tab that answers. */
async function snapshot(run: string): Promise<{ members: StateMember[]; entries: StateEntry[]; pageError?: string }> {
    if (!run) return { members: readableMembers("worker"), entries: [] };
    const key = stateKeyFor(run);
    const entries = await readState(key, "human", "worker");
    const members = membersFor("worker", entries);
    // WHO HOSTS THE LOOP is the session index's word, from where each event came from (session-index.ts), never the
    // page's. A page-hosted run's messages, pointers and mailbox are the page's: it may answer for those worker ids,
    // but only where the worker itself holds nothing for this run, and the row says it came from the page.
    const binding = sessionServer.index.binding(run);
    const pageHosts = binding?.hostedBy === "page";
    const tabId = key.tabId ?? (pageHosts ? binding?.tabId : undefined);
    if (tabId == null) return { members, entries };
    const page = await askPage(tabId, run);
    if ("error" in page) return { members, entries, pageError: page.error };
    return withPageState({ members, entries }, page.raw, pageHosts) ?? { members, entries, pageError: "the page's answer was not a state snapshot" };
}
