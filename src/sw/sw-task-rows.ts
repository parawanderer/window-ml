// sw-task-rows.ts — a session's background tasks on its index row: the counts from the task table, and whether the run has a tab.

import type { SessionServer } from "../session/session-server";
import { hydrateTasks, onTaskCounts, taskCounts } from "./sw-tasks";
import { bgRuns } from "./sw-runs";

let server: SessionServer | undefined;   // state: plumbing — the session server rows are set on, bound once at worker start

/** Whether the run has a tab a turn could start on: the one the worker holds it on, else the one its row names. */
async function hasTab(hash: string): Promise<boolean> {
    const id = bgRuns.get(hash)?.tabId ?? server?.index.list().find((r) => r.id.hash === hash)?.page?.tabId;
    if (typeof id !== "number") return false;
    try { return !!(await chrome.tabs.get(id)); } catch { return false; }
}

/**
 * Put a run's task counts and tab state on its session row (`SessionSummary.background`), read from the task table now.
 * @param hash the run's session hash
 */
export async function refreshTaskRow(hash: string): Promise<void> {
    if (!server) return;
    const early = taskCounts(hash);
    if (early.running + early.waiting === 0) { server.background(hash, null); return; }
    const tab = await hasTab(hash);
    // The table may have moved on while the tab was asked: the row says what it holds now.
    const c = taskCounts(hash);
    server.background(hash, c.running + c.waiting === 0 ? null : { ...c, ...(tab ? {} : { noTab: true as const }) });
}

/**
 * After the index is restored, once at worker start: every `ml_tasks:*` table in session storage is read back and its run's
 * row set, so a worker that was evicted shows what its runs still have in flight. A row that carries a marker with no table
 * behind it is cleared.
 */
export async function syncTaskRows(): Promise<void> {
    if (!server) return;
    let all: Record<string, unknown> = {};
    try { all = (await chrome.storage.session.get(null)) ?? {}; } catch { /* no storage: the rows are what this worker sees */ }
    const runs = Object.keys(all).filter((k) => k.startsWith("ml_tasks:")).map((k) => k.slice("ml_tasks:".length));
    await Promise.all(runs.map((r) => hydrateTasks(r).catch(() => undefined)));
    const marked = server.index.list().filter((r) => r.background).map((r) => r.id.hash);
    await Promise.all([...new Set([...runs, ...marked])].map(refreshTaskRow));
}

/**
 * Wire the rows: a run's counts changing, or a tab closing, refreshes the row. Called once, by the module that owns the server.
 * @param s the session server
 */
export function bindTaskRows(s: SessionServer): void {
    server = s;
    onTaskCounts((runId) => { void refreshTaskRow(runId); });
    if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
        chrome.tabs.onRemoved.addListener((tabId) => {
            const runs = new Set<string>();
            for (const [hash, r] of bgRuns) if (r.tabId === tabId) runs.add(hash);
            for (const r of s.index.list()) if (r.background && r.page?.tabId === tabId) runs.add(r.id.hash);
            for (const hash of runs) void refreshTaskRow(hash);
        });
    }
}
