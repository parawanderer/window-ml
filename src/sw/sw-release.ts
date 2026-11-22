// sw-release.ts — the release of a run whose tab closed: its deadline, the alarm that keeps it, and the release itself.

// A tab closing does not end the runs it held (their stored sessions stay), but their Python names, `@tool:` values and
// tasks are memory nobody will read once nobody comes back. Each run gets a deadline of `closedRunGraceMin` minutes
// (docs/spec/ASYNC_CALLS.md, "A run whose tab closed: the release"). The deadline is `ml_release_due:<runId>` in session
// storage, so a worker evicted meanwhile still releases on time: one alarm, `ml-release`, is set to the earliest, and a
// worker that starts releases whatever came due while it was gone. A person who reopens the run, moves it, or sends it a
// message cancels it; at release time the run's tab is asked for again, so a missed cancel releases nothing alive.

import { defineState } from "../state-registry";
import { DEFAULT_CONFIG } from "../contract/contract-config";
import { activeRuns, bgRuns, releaseSessionTokens, runControllers, runInboxes, startingControllers, type ReleaseReason } from "./sw-runs";
import { onTaskCounts, taskCounts } from "./sw-tasks";
import { refreshTaskRow } from "./sw-task-rows";

/** What a stored deadline holds. `due` is null while the run still has a running task: the entry says the tab closed, and
 *  the deadline is set when the last task ends (a worker evicted in between still knows to set it). */
export interface ReleaseEntry { due: number | null; closedAt: number }

const PREFIX = "ml_release_due:";
const KEY = (runId: string): string => `${PREFIX}${runId}`;
const ALARM = "ml-release";
/** The longest grace the setting allows, in minutes (a day). */
const MAX_GRACE_MIN = 1440;

defineState({
    id: "run.releaseDue", scope: "run", realm: "worker", audience: "human", lostOn: ["browser-restart"],
    describe: "When the run's tab closed and when its Python names, stored values and background tasks will be released if nobody comes back. Kept in session storage (`ml_release_due:<runId>`), so a worker eviction does not lose it; a browser restart does.",
    read: async ({ runId }) => (runId ? (await readEntry(runId)) ?? undefined : undefined),
});

let chain: Promise<unknown> = Promise.resolve();   // state: plumbing — one write to the deadlines at a time, so the alarm is set from what was written
/** Run `f` after every earlier write to the deadlines has finished; a failure of `f` does not stop the next one. */
function serial<T>(f: () => Promise<T>): Promise<T> {
    const next = chain.then(f, f);
    chain = next.catch(() => undefined);
    return next;
}

/** A stored value as an entry, or null for anything of another shape (a forged or older key). */
function asEntry(v: unknown): ReleaseEntry | null {
    const e = v as Partial<ReleaseEntry> | null;
    if (!e || typeof e !== "object") return null;
    if (!(e.due === null || (typeof e.due === "number" && Number.isFinite(e.due)))) return null;
    if (typeof e.closedAt !== "number" || !Number.isFinite(e.closedAt)) return null;
    return { due: e.due, closedAt: e.closedAt };
}

async function readEntry(runId: string): Promise<ReleaseEntry | null> {
    try { return asEntry((await chrome.storage.session.get(KEY(runId)))?.[KEY(runId)]); } catch { return null; }
}

async function readAll(): Promise<Map<string, ReleaseEntry>> {
    const out = new Map<string, ReleaseEntry>();
    let all: Record<string, unknown> = {};
    try { all = (await chrome.storage.session.get(null)) ?? {}; } catch { /* no storage: nothing is set */ }
    for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(PREFIX)) continue;
        const e = asEntry(v);
        if (e) out.set(k.slice(PREFIX.length), e);
    }
    return out;
}

async function writeEntry(runId: string, e: ReleaseEntry | null): Promise<void> {
    try { await (e ? chrome.storage.session.set({ [KEY(runId)]: e }) : chrome.storage.session.remove(KEY(runId))); } catch { /* memory holds nothing else: the deadline is lost with the write */ }
}

/** The grace period in ms: the person's `closedRunGraceMin` (0 to 1440 minutes), else the default. */
export async function releaseGraceMs(): Promise<number> {
    let v: unknown = DEFAULT_CONFIG.closedRunGraceMin;
    try { v = (await chrome.storage.sync.get({ closedRunGraceMin: DEFAULT_CONFIG.closedRunGraceMin }))?.closedRunGraceMin; } catch { /* the default */ }
    const n = typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_GRACE_MIN ? v : DEFAULT_CONFIG.closedRunGraceMin;
    return Math.round(n * 60_000);
}

/** Whether the run has no tab a turn could run on: the worker holds none for it, or the one it holds is gone. A run the
 *  worker no longer holds (it started since, and a settled run is not read back) has one only if some tab still tracks it.
 *  Kept to one function so the lane that exports `runHasNoTab` from sw-runs.ts can replace it. */
export async function runLacksTab(runId: string): Promise<boolean> {
    const held = bgRuns.get(runId);
    if (!held) return ![...activeRuns.values()].some((ids) => ids.has(runId));
    const id = held.tabId;
    if (typeof id !== "number" || id < 0) return true;
    try { return !(await chrome.tabs.get(id)); } catch { return true; }
}

/** A turn of the run is live or starting: such a run is never released. */
const turnLive = (runId: string): boolean => runControllers.has(runId) || runInboxes.has(runId) || startingControllers.has(runId);

/** Set the one alarm to the earliest deadline, or clear it when none is set. */
async function reschedule(): Promise<void> {
    const dues = [...(await readAll()).values()].map((e) => e.due).filter((d): d is number => d !== null);
    try {
        if (!dues.length) await chrome.alarms?.clear(ALARM);
        else await chrome.alarms?.create(ALARM, { when: Math.min(...dues) });
    } catch { /* no alarms (a test harness): the next worker start releases what is due */ }
}

/**
 * The deadline a run's session row shows (`releaseAt`): set only while a deadline is.
 * @param runId the run
 */
export async function releaseAtOf(runId: string): Promise<number | undefined> {
    const e = await readEntry(runId);
    return e && e.due !== null ? e.due : undefined;
}

/**
 * Start a run's deadline: now plus the grace. A run with a running task gets an entry with no deadline yet, which
 * {@link onTaskCounts} fills in when its last task ends. With a grace of 0 the run is released at once.
 * @param runId the run
 * @param closedAt when its tab closed, kept as it was for a deadline that is set again
 */
export async function armRelease(runId: string, closedAt = Date.now()): Promise<void> {
    const grace = await releaseGraceMs();
    const hold = taskCounts(runId).running > 0;
    await serial(async () => {
        await writeEntry(runId, { due: hold ? null : Date.now() + grace, closedAt });
        await reschedule();
    });
    void refreshTaskRow(runId);
    if (!hold && grace === 0) await releaseDue();
}

/**
 * Remove a run's deadline: the run is on a tab again (an adopt, a move, a resume) or a turn started. Cheap when none is set.
 * @param runId the run
 */
export async function cancelRelease(runId: string): Promise<void> {
    const had = await serial(async () => {
        const e = await readEntry(runId);
        if (!e) return false;
        await writeEntry(runId, null);
        await reschedule();
        return true;
    });
    if (had) void refreshTaskRow(runId);
}

/**
 * A tab closed: each run the worker holds on it gets its deadline, unless a turn is live on it (the turn's end sets one,
 * {@link rearmAfterTurn}).
 * @param tabId the closed tab
 */
export async function onTabClosed(tabId: number): Promise<void> {
    const runs = [...bgRuns].filter(([id, r]) => r.tabId === tabId && !turnLive(id)).map(([id]) => id);
    await Promise.all(runs.map((id) => armRelease(id)));
}

/**
 * A turn ended: a run still on no tab, and with no running task, gets a fresh deadline of now plus the grace. A running task
 * defers it to the task's end.
 * @param runId the run
 */
export async function rearmAfterTurn(runId: string): Promise<void> {
    if (!bgRuns.has(runId) || !(await runLacksTab(runId))) return;
    await armRelease(runId);
}

/**
 * Release one run now. Refused while a turn is live. The stored run and its transcript stay.
 * @param runId the run
 * @param reason what released it: `tab-closed` (the deadline) or `person` (Stop)
 * @returns whether it was released
 */
export async function releaseRun(runId: string, reason: ReleaseReason): Promise<boolean> {
    if (turnLive(runId)) return false;
    releaseSessionTokens(runId, reason);
    await serial(async () => { await writeEntry(runId, null); await reschedule(); });
    void refreshTaskRow(runId);
    return true;
}

/**
 * Release every run whose deadline has come, then set the alarm again. A run with a turn live, a running task or a tab (asked
 * for again here) is not released and loses its entry: a turn's end and a task's end set a new one.
 */
export async function releaseDue(): Promise<void> {
    const now = Date.now();
    const due = [...(await readAll())].filter(([, e]) => e.due !== null && e.due <= now).map(([id]) => id);
    for (const runId of due) {
        const alive = turnLive(runId) || taskCounts(runId).running > 0 || !(await runLacksTab(runId));
        if (alive) { await cancelRelease(runId); continue; }
        await releaseRun(runId, "tab-closed");
    }
    await serial(reschedule);
}

/** Worker start, after the runs are read back: release what came due while no worker was running, and set the alarm. */
export function restoreReleases(): Promise<void> { return releaseDue().catch(() => undefined); }

onTaskCounts((runId, c) => {
    if (c.running > 0) return;
    void (async () => {
        const e = await readEntry(runId);
        // Only a run whose tab closed with a task running holds an entry with no deadline.
        if (e && e.due === null && (await runLacksTab(runId))) await armRelease(runId, e.closedAt);
    })();
});

try { chrome.alarms?.onAlarm.addListener((a) => { if (a.name === ALARM) void releaseDue(); }); } catch { /* no alarms (a test harness) */ }
