// sw-shared-watches.ts — the watches a person SHARED with the model from the Run state panel, given to a worker-hosted
// run as `ml.current.debug.userWatches` (docs/spec/STATE_INSPECTOR.md, "Watches"): a channel from the person to the
// model, opt-in per watch. The list is the panel's, kept in chrome.storage.local beside the watches themselves.

import { defineState } from "../state-registry";
import { evalShared, watchList, watchNotes, MAX_SHARED_WATCHES, SHARED_WATCHES_KEY, WATCH_NOTES_KEY, WATCH_STEPS, type WatchJs } from "../state-watch";
import { evalReadonly, NeedsPage } from "../readonly-exec";
import { contextByRun } from "./sw-runs";
import type { CurrentSnapshot, UserWatch } from "../agent/current-context";

/** The shared expressions and the person's notes on them, as stored; empty when there are none or storage cannot be read. */
export async function sharedWatches(): Promise<{ exprs: string[]; notes: Record<string, string> }> {
    try {
        const d = await chrome.storage.local.get([SHARED_WATCHES_KEY, WATCH_NOTES_KEY]);
        return { exprs: watchList(d?.[SHARED_WATCHES_KEY]).slice(0, MAX_SHARED_WATCHES), notes: watchNotes(d?.[WATCH_NOTES_KEY]) };
    } catch { return { exprs: [], notes: {} }; }
}

/**
 * The shared watches over one snapshot, in the read-only dialect with nothing bound but `ml.current` itself.
 * @param current the snapshot the model reads, without `debug`
 * @param exprs the shared expressions
 * @param notes the person's note on each, by expression
 */
export async function userWatches(current: CurrentSnapshot, exprs: readonly string[], notes: Readonly<Record<string, string>> = {}): Promise<UserWatch[]> {
    const js: WatchJs = async (code) => {
        try {
            return (await evalReadonly(code, null, {}, undefined, { realm: "worker", current, stepBudget: WATCH_STEPS })).value;
        } catch (e) {
            if (e instanceof NeedsPage) throw new Error("a watch reads the run's state, not the page");
            throw e;
        }
    };
    return evalShared(current, exprs, js, notes);
}

/**
 * The snapshot with `debug.userWatches` added: what a worker-hosted run's `ml.current` is. Always present there, empty
 * when nothing is shared, so a script reading it never has to guard for its absence.
 * @param current the snapshot as the loop made it
 */
export async function withUserWatches(current: CurrentSnapshot): Promise<CurrentSnapshot> {
    const { exprs, notes } = await sharedWatches();
    return { ...current, debug: { userWatches: exprs.length ? await userWatches(current, exprs, notes) : [] } };
}

defineState({
    id: "debug.userWatches", scope: "browser", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.debug.userWatches",
    describe: "The watches you shared with the model, each with its value over what the model reads. Evaluated while a turn runs.",
    read: async ({ runId }) => {
        const live = runId ? contextByRun.get(runId) : undefined;
        const { exprs, notes } = live ? await sharedWatches() : { exprs: [], notes: {} };
        return live && exprs.length ? userWatches(live(), exprs, notes) : undefined;
    },
});
