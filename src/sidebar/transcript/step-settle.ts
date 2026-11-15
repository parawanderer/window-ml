// step-settle.ts — when a tool step may join a group of calls in the calm chat: not while it is still moving.
//
// A step joining a group is drawn as a member of that group, which is a different place in the tree: the step is built again, closed.
// So a step that is still open for the person who has just decided it, or that is only just now being asked about, must not be
// grouped under them: an approved code step stays open to run and then folds by itself, and a step is `pending` a beat before the
// event that makes it ask for approval. Grouping on that beat put the whole turn into a group for one render and took it out again.

import type { AgentStep } from "../store";

/** How long, in ms, a step that has just started is left alone: the event that says it is waiting for approval follows its start. */
export const STEP_YOUNG_MS = 300;
/** How long, in ms, a step that was waiting for a person is left alone once it has settled: its code stays open for a beat and folds. */
export const GROUP_AFTER_MS = 1300;

// state: ui — what each step of each run was last seen doing and when (by `hash:seq`), as this client saw it
const seen = new Map<string, { run: boolean; gated: boolean; at: number; streamed: boolean }>();
// state: ui — the turns (`hash:step`) whose calls were drawn as they were written: a live cell stands in for the step through its first beat
const streamed = new Set<string>();

/** Notes that turn `step` of run `hash` was streamed, so its steps wait out their first beat behind the cell that is still drawn for them. */
export function noteStreamed(hash: string, step: number): void {
    if (streamed.size > 500) streamed.clear();
    streamed.add(`${hash}:${step}`);
}

/** Whether the person is needed for the step right now: its own gate, or a command inside it. */
const asks = (st: AgentStep): boolean => (!!st.awaitingApproval && !!st.pending) || !!st.asks?.some((a) => a.state === "pending");

/**
 * Notes what a run's steps are doing, once per render. A step first seen already settled has been settled for as long as it has
 * been there (a transcript opened later): it is not made to wait. Returns how many ms until the next step is let go, 0 for none.
 */
export function noteSteps(hash: string, steps: readonly AgentStep[], now = Date.now()): number {
    if (seen.size > 2000) seen.clear();
    let next = 0;
    for (const st of steps) {
        if (!st.tool || st.seq == null) continue;
        const key = `${hash}:${st.seq}`;
        const run = !!st.pending;
        const gated = asks(st);
        const was = seen.get(key);
        if (!was) seen.set(key, { run, gated, at: run ? now : 0, streamed: streamed.has(`${hash}:${st.step}`) });
        else if (was.run !== run) { was.run = run; was.at = now; was.gated ||= gated; }
        else if (gated) was.gated = true;
        const wait = settlesIn(key, st, now);
        if (wait > 0 && (!next || wait < next)) next = wait;
    }
    return next;
}

/** Milliseconds until this step may join a group: 0 when it may now (or was never seen to move). */
export function settlesIn(key: string, st: AgentStep, now = Date.now()): number {
    const was = seen.get(key);
    if (!was || !was.at) return 0;
    // Only a streamed turn has a live cell to cover its first beat; elsewhere a step that has just started is drawn at once, as it was.
    const need = st.pending ? (was.gated ? Infinity : was.streamed ? STEP_YOUNG_MS : 0) : was.gated ? GROUP_AFTER_MS : 0;
    return need === Infinity ? 0 : Math.max(0, was.at + need - now);
}

/** Whether `st` of run `hash` has to be left out of a group for now. A step that waits for a person is out already; this is for the beats around it. */
export function isSettling(hash: string, st: AgentStep, now = Date.now()): boolean {
    if (st.seq == null) return false;
    const was = seen.get(`${hash}:${st.seq}`);
    if (!was) return false;
    if (st.pending && was.gated) return true;   // approved and running: its code is still open
    return settlesIn(`${hash}:${st.seq}`, st, now) > 0;
}

/**
 * Whether `st` has only just started and has not yet said whether it will ask: the event that makes a step wait for approval follows
 * the one that starts it, and for that beat it would draw as a running row, to open a moment later. What a live cell waits out.
 */
export function isYoung(hash: string, st: AgentStep, now = Date.now()): boolean {
    if (st.seq == null || !st.pending || st.awaitingApproval || st.approval) return false;
    const was = seen.get(`${hash}:${st.seq}`);
    return !!was && was.streamed && !was.gated && !!was.at && was.at + STEP_YOUNG_MS > now;
}
