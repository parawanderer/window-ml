// sw-shared-watches.ts — the watches a person SHARED with the model from the Run state panel, given to a worker-hosted
// run as `ml.current.debug.userWatches` (docs/spec/STATE_INSPECTOR.md, "Watches"): a channel from the person to the
// model, opt-in per watch. The list is the panel's, kept in chrome.storage.local beside the watches themselves.

import { defineState } from "../state-registry";
import { evalShared, watchList, MAX_SHARED_WATCHES, SHARED_WATCHES_KEY, WATCH_STEPS, type WatchJs } from "../state-watch";
import { evalReadonly, NeedsPage } from "../readonly-exec";
import { contextByRun } from "./sw-runs";
import type { CurrentSnapshot, UserWatch } from "../agent/current-context";

/** The shared expressions, as stored; empty when there are none or storage cannot be read. */
export async function sharedWatches(): Promise<string[]> {
    try {
        const d = await chrome.storage.local.get(SHARED_WATCHES_KEY);
        return watchList(d?.[SHARED_WATCHES_KEY]).slice(0, MAX_SHARED_WATCHES);
    } catch { return []; }
}

/**
 * The shared watches over one snapshot, in the read-only dialect with nothing bound but `ml.current` itself.
 * @param current the snapshot the model reads, without `debug`
 * @param exprs the shared expressions
 */
export async function userWatches(current: CurrentSnapshot, exprs: readonly string[]): Promise<UserWatch[]> {
    const js: WatchJs = async (code) => {
        try {
            return (await evalReadonly(code, null, {}, undefined, { realm: "worker", current, stepBudget: WATCH_STEPS })).value;
        } catch (e) {
            if (e instanceof NeedsPage) throw new Error("a watch reads the run's state, not the page");
            throw e;
        }
    };
    return evalShared(current, exprs, js, Date.now());
}

/**
 * The snapshot with `debug.userWatches` added: what a worker-hosted run's `ml.current` is. Always present there, empty
 * when nothing is shared, so a script reading it never has to guard for its absence.
 * @param current the snapshot as the loop made it
 */
export async function withUserWatches(current: CurrentSnapshot): Promise<CurrentSnapshot> {
    const exprs = await sharedWatches();
    return { ...current, debug: { userWatches: exprs.length ? await userWatches(current, exprs) : [] } };
}

defineState({
    id: "debug.userWatches", scope: "browser", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.debug.userWatches",
    describe: "The watches you shared with the model, each with its value over what the model reads. Evaluated while a turn runs.",
    read: async ({ runId }) => {
        const live = runId ? contextByRun.get(runId) : undefined;
        const exprs = live ? await sharedWatches() : [];
        return live && exprs.length ? userWatches(live(), exprs) : undefined;
    },
});
