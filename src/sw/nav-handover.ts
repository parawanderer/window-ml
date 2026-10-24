// nav-handover.ts — hands a page-built run to the worker when its tab commits a document whose site may not use window.ml.

// A run a PAGE built (an approved page's own `ml.agent`) is driven by that page and runs its tools with the page's
// vision, python and fetch. Once the run navigates onto a site that is not approved, nothing page-side may own it any
// more, and its tools would send from an unapproved page (docs/spec/SITE_ACCESS.md, slice 2 part 5). So at the
// browser's own report of the commit (`webNavigation.onCommitted`, which no page can stop or fake) the run becomes the
// worker's (`makeWorkerRun`), as an eviction's durable resume makes it, and continues as a worker-hosted run. The
// destination's re-adopt (CONTENT_READY) and every tool send of the run wait for the decision, so nothing of the run
// reaches the new document before it is made.
//
// A revoke is the same decision with no navigation (owner's decision 2026-10-12): when the person takes away the
// approval of the site a page-built run's tab is on (any path that changes the lists or the self-approval whitelist:
// the popup, DevTools Settings, a denial, another surface or a sync, all of which reach `chrome.storage.onChanged`),
// `handOverOnRevoke` decides every tab holding a page-built run from the document it shows now. And every tool send
// decides again before it goes (`handOverSettled`), so a send made before the storage event arrives, or after a
// worker restart, is decided under the lists as they are.

import { activeRuns, bgRuns, hydrationDone, isWorkerRun, makeWorkerRun } from "./sw-runs";
import { pageApproved } from "./sw-isolated-exec";
import { recordRunLog } from "./sw-run-log";

/** The hand-over decision in flight for each tab, from its last main-frame commit. */
const pending = new Map<number, Promise<string[]>>();   // state: plumbing
/** The top-frame URL each tab's last decision was made for: what a hand-over at a send is logged as (`handOverSettled`). */
const decidedUrl = new Map<number, string>();   // state: plumbing

/** The page-built runs on a tab, live (`activeRuns`) or settled and still resumable there (`bgRuns`). */
function pageBuiltRunsOn(tabId: number): string[] {
    const ids = new Set<string>(activeRuns.get(tabId) ?? []);
    for (const [runId, snap] of bgRuns) if (snap.tabId === tabId) ids.add(runId);
    return [...ids].filter((runId) => !isWorkerRun(runId));
}

/** Why a run was handed over, for the execution log. */
type HandOverReason = "navigated-to-unapproved-site" | "site-revoked" | "site-not-approved";

/**
 * Hand every page-built run on a tab to the worker when the tab's top frame now holds `url` and its site may not use
 * window.ml. One way: a run handed over stays the worker's when the tab returns to an approved site.
 * @param tabId the tab
 * @param url the URL of the document the tab committed, as the browser reported it
 * @returns the runs handed over by this call
 */
export function handOverOnCommit(tabId: number, url: string | undefined): Promise<string[]> {
    return decideTab(tabId, url, "navigated-to-unapproved-site");
}

/**
 * Decide one tab: queued behind any decision already in flight for it, so two never interleave.
 * @param tabId the tab
 * @param url the URL of the document the tab holds
 * @param reason what the log says, if the runs are handed over
 * @returns the runs handed over by this call
 */
function decideTab(tabId: number, url: string | undefined, reason: HandOverReason): Promise<string[]> {
    const prior = pending.get(tabId) ?? Promise.resolve([]);
    const next = prior.catch(() => []).then(async () => {
        // The commit may be the event that woke this worker: until the runs an eviction interrupted are restored from
        // storage, the maps read empty and the run on the tab would be missed.
        await hydrationDone.catch(() => {});
        decidedUrl.set(tabId, url ?? "");
        if (!pageBuiltRunsOn(tabId).length) return [];
        // A URL that cannot be read is not approved: refusing is the safe side.
        const approved = url ? await pageApproved(url).catch(() => false) : false;
        if (approved) return [];
        // Read again after the await: a run may have settled, or been handed over by another path, meanwhile.
        const handed = pageBuiltRunsOn(tabId);
        for (const runId of handed) {
            makeWorkerRun(runId);
            recordRunLog(runId, { subsystem: "routing", kind: "handed-to-worker", reason, detail: { origin: originOrNone(url) } });
        }
        return handed;
    });
    pending.set(tabId, next);
    void next.finally(() => { if (pending.get(tabId) === next) pending.delete(tabId); });
    return next;
}

/** The URL of the tab's top frame now, as the browser reports it; null when the tab is gone, "" when it has no URL. */
async function topFrameUrl(tabId: number): Promise<string | null> {
    const frame = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { url?: unknown } | null;
    if (!frame) return null;
    return typeof frame.url === "string" ? frame.url : "";
}

/**
 * Wait for the tab's hand-over decision, and decide it again from the document the tab shows now: whatever is about to
 * reach the tab for a run must be decided under the rule the run is now under.
 * @param tabId the tab
 */
export async function handOverSettled(tabId: number): Promise<void> {
    await pending.get(tabId)?.catch(() => []);
    // From the document the tab shows NOW, every time: a top-frame document can arrive without the main-frame commit
    // this module listens for (a prerendered page commits in its own frame tree, frameId != 0, and its activation fires
    // none), a commit can be lost (a worker woken by it), and the site can be revoked with no navigation at all, its
    // storage event still on its way or fired at a worker that has since been evicted.
    if (!pageBuiltRunsOn(tabId).length) return;
    const url = await topFrameUrl(tabId);
    // No frame: the tab is gone, and nothing can reach it. A frame without a readable URL is decided as unapproved.
    if (url === null) return;
    const last = decidedUrl.get(tabId);
    await decideTab(tabId, url || undefined, last === undefined ? "site-not-approved" : last === url ? "site-revoked" : "navigated-to-unapproved-site").catch(() => []);
}

/**
 * The approved set changed (a revoke, a denial, a whitelist entry removed, from any surface): decide every tab holding a
 * page-built run from the document it shows now, and hand the runs on a tab whose site may no longer use window.ml to
 * the worker. Nothing the page does is read, so it can neither stop nor delay this.
 * @returns the runs handed over
 */
export async function handOverOnRevoke(): Promise<string[]> {
    await hydrationDone.catch(() => {});
    const tabs = new Set<number>(activeRuns.keys());
    for (const snap of bgRuns.values()) tabs.add(snap.tabId);
    const handed = await Promise.all([...tabs].filter((tabId) => pageBuiltRunsOn(tabId).length).map(async (tabId) => {
        const url = await topFrameUrl(tabId);
        return url === null ? [] : decideTab(tabId, url || undefined, "site-revoked").catch(() => [] as string[]);
    }));
    return handed.flat();
}

/** The origin of a URL for the log, or "none". */
function originOrNone(url: string | undefined): string {
    try { return url ? new URL(url).origin : "none"; } catch { return "none"; }
}

/** Forget a closed tab's last decision. */
export function forgetHandOverTab(tabId: number): void { decidedUrl.delete(tabId); }
