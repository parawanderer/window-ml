// nav-handover.ts — hands a page-built run to the worker when its tab commits a document whose site may not use window.ml.

// A run a PAGE built (an approved page's own `ml.agent`) is driven by that page and runs its tools with the page's
// vision, python and fetch. Once the run navigates onto a site that is not approved, nothing page-side may own it any
// more, and its tools would send from an unapproved page (docs/spec/SITE_ACCESS.md, slice 2 part 5). So at the
// browser's own report of the commit (`webNavigation.onCommitted`, which no page can stop or fake) the run becomes the
// worker's (`makeWorkerRun`), as an eviction's durable resume makes it, and continues as a worker-hosted run. The
// destination's re-adopt (CONTENT_READY) and every tool send of the run wait for the decision, so nothing of the run
// reaches the new document before it is made.

import { activeRuns, bgRuns, isWorkerRun, makeWorkerRun } from "./sw-runs";
import { pageApproved } from "./sw-isolated-exec";
import { recordRunLog } from "./sw-run-log";

/** The hand-over decision in flight for each tab, from its last main-frame commit. */
const pending = new Map<number, Promise<string[]>>();   // state: plumbing

/** The page-built runs on a tab, live (`activeRuns`) or settled and still resumable there (`bgRuns`). */
function pageBuiltRunsOn(tabId: number): string[] {
    const ids = new Set<string>(activeRuns.get(tabId) ?? []);
    for (const [runId, snap] of bgRuns) if (snap.tabId === tabId) ids.add(runId);
    return [...ids].filter((runId) => !isWorkerRun(runId));
}

/**
 * Hand every page-built run on a tab to the worker when the tab's top frame now holds `url` and its site may not use
 * window.ml. One way: a run handed over stays the worker's when the tab returns to an approved site.
 * @param tabId the tab
 * @param url the URL of the document the tab committed, as the browser reported it
 * @returns the runs handed over by this call
 */
export function handOverOnCommit(tabId: number, url: string | undefined): Promise<string[]> {
    const prior = pending.get(tabId) ?? Promise.resolve([]);
    const next = prior.catch(() => []).then(async () => {
        if (!pageBuiltRunsOn(tabId).length) return [];
        // A URL that cannot be read is not approved: refusing is the safe side.
        const approved = url ? await pageApproved(url).catch(() => false) : false;
        if (approved) return [];
        // Read again after the await: a run may have settled, or been handed over by another path, meanwhile.
        const handed = pageBuiltRunsOn(tabId);
        for (const runId of handed) {
            makeWorkerRun(runId);
            recordRunLog(runId, { subsystem: "routing", kind: "handed-to-worker", reason: "navigated-to-unapproved-site", detail: { origin: originOrNone(url) } });
        }
        return handed;
    });
    pending.set(tabId, next);
    void next.finally(() => { if (pending.get(tabId) === next) pending.delete(tabId); });
    return next;
}

/**
 * Wait for the tab's hand-over decision, if one is in flight: whatever is about to reach the tab for a run must be
 * decided under the rule the run is now under.
 * @param tabId the tab
 */
export async function handOverSettled(tabId: number): Promise<void> {
    await pending.get(tabId)?.catch(() => []);
}

/** The origin of a URL for the log, or "none". */
function originOrNone(url: string | undefined): string {
    try { return url ? new URL(url).origin : "none"; } catch { return "none"; }
}
