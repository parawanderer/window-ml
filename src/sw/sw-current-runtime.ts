// sw-current-runtime.ts — `ml.current.runtime` in the worker: this runtime's own description (`localRuntime()`,
// sw-sessions.ts), projected by `runtimeOf` (current-runtime.ts), added to a run's snapshot and to the Run state panel.

import { defineState } from "../state-registry";
import { localDescription } from "./sw-sessions";
import { runtimeOf } from "../agent/current-runtime";
import type { CurrentRuntime, CurrentSnapshot } from "../agent/current-context";

/** This runtime, now. */
export function currentRuntime(): CurrentRuntime {
    return runtimeOf(localDescription());
}

/**
 * The snapshot with its `runtime` added, on a copy.
 * @param current the snapshot as the host made it
 */
export function withRuntime(current: CurrentSnapshot): CurrentSnapshot {
    return { ...current, runtime: currentRuntime() };
}

defineState({
    id: "run.runtime", scope: "browser", realm: "worker", audience: "model", lostOn: [],
    exposedAs: "ml.current.runtime",
    describe: "What the runtime the run executes in can do, read now: its kind, and each capability it reports to its clients as a boolean, with the inbox's setup problems by code and title.",
    read: () => currentRuntime(),
});
