// job-registry.ts — every job that acts on someone's data ON ITS OWN (compaction, eviction, sweeps), declared next to
// the job, so the Background work section lists what is declared rather than a hand-kept list (docs/dev/housekeeping.md).
//
// The housekeeping log says what HAPPENED; a job's status says what is happening or waiting NOW. The two meet here: a
// job's live answer (running, how much waits, when it is next due) comes from the job, and everything about past runs
// (the last one, whether it finished or was cut off) is DERIVED from the log, never kept a second time. A pass the
// worker was stopped in the middle of has a start record and no end record, and nothing has to survive the worker for
// that to be seen.

import type { HousekeepingEvent } from "./log/housekeeping";

/** What a job is doing. `waiting`: it has work and will start on its own; `interrupted`: its last pass started and
 *  never ended, and no pass is running now (it resumes on its next trigger); `failed`: its last pass ended in error. */
export type JobState = "idle" | "waiting" | "running" | "failed" | "interrupted";

/** Which housekeeping records belong to a job. Kinds are listed, not matched by subsystem alone: one subsystem can hold
 *  several jobs (`sessions` holds compaction and eviction). */
export interface JobLog {
    subsystem: string;
    /** The record a pass opens with. Absent for a job that only logs each thing it did (an eviction). */
    start?: string;
    /** Records that end a pass well, or for a job without `start`, each one a run. */
    done: string[];
    /** Records that end a pass in error. */
    failed?: string[];
    /** Other records of the job, shown with it but deciding nothing (one per session compacted). */
    also?: string[];
}

/** What the job itself knows right now. Plain data; every field optional, and absent means "not known", not zero. */
export interface JobLive {
    running?: boolean;
    /** How many things wait for it, in `pendingLabel`'s unit. */
    pending?: number;
    pendingLabel?: string;
    /** Epoch ms of the next time it starts on its own. */
    nextDue?: number;
    /** Why the work waiting cannot be done until a person acts (a folder whose permission lapsed). */
    blocked?: string;
}

/** One job's declaration. */
export interface JobDecl {
    /** Dotted, unique: `sessions.compact-images`. */
    id: string;
    /** What a person calls it. */
    title: string;
    /** When it runs, as a sentence. */
    trigger: string;
    log: JobLog;
    /** The job's own answer, now. May be async (an alarm's next time is). */
    live?: () => JobLive | Promise<JobLive>;
}

/** The last run as the log tells it. */
export interface JobRun {
    t: number;
    ok: boolean;
    kind: string;
    ms?: number;
    bytes?: number;
    detail?: Record<string, string | number | boolean>;
}

/** One job's status: plain data, safe to send to any extension page. */
export interface JobStatus {
    id: string;
    title: string;
    trigger: string;
    subsystem: string;
    /** Every kind of record the job writes, so a reader can pick its records out of the log. */
    kinds: string[];
    state: JobState;
    pending?: number;
    pendingLabel?: string;
    nextDue?: number;
    /** See {@link JobLive.blocked}. */
    blocked?: string;
    lastRun?: JobRun;
    /** When the pass that never ended started (state `interrupted`, or `running` again after one). */
    interruptedAt?: number;
    /** The job's live answer threw: the state is then the log's alone. */
    error?: string;
}

const registry = new Map<string, JobDecl>(); // state: fixed

/**
 * Declare a job. Call it at module load, beside the job, so the declaration cannot drift from what it describes.
 * @param decl the declaration
 * @returns the same declaration
 */
export function defineJob(decl: JobDecl): JobDecl {
    if (registry.has(decl.id)) throw new Error(`job ${decl.id} is declared twice`);
    registry.set(decl.id, decl);
    return decl;
}

/** Every declared job, in declaration order (the order a person reads them in). */
export const declaredJobs = (): JobDecl[] => [...registry.values()];

/** Forget every declaration. Tests only: a module's declarations run once per load. */
export function resetJobRegistry(): void { registry.clear(); }

/** Every kind of record a job writes. */
export const jobKinds = (log: JobLog): string[] => [...(log.start ? [log.start] : []), ...log.done, ...(log.failed || []), ...(log.also || [])];

/** Whether a housekeeping record is one of this job's. */
export const isJobEvent = (log: JobLog, e: Pick<HousekeepingEvent, "subsystem" | "kind">): boolean =>
    e.subsystem === log.subsystem && jobKinds(log).includes(e.kind);

/**
 * A job's status from its live answer and the log, oldest record first. Pure: the whole rule is here.
 *
 * Running wins. Otherwise an open pass (a start with no end after it) means the worker was stopped in it:
 * `interrupted`. Otherwise a last run that failed is `failed` until a later one succeeds. Otherwise work waiting is
 * `waiting`, and nothing is `idle`. A log written before the job logged anything gives no last run, never a wrong one.
 * @param decl the job
 * @param live what the job says now, or undefined when it said nothing (or threw)
 * @param events the housekeeping log, oldest first
 */
export function jobStatus(decl: JobDecl, live: JobLive | undefined, events: readonly HousekeepingEvent[]): Omit<JobStatus, "error"> {
    const { log } = decl;
    let open: number | undefined;
    let last: JobRun | undefined;
    for (const e of events) {
        if (e.subsystem !== log.subsystem) continue;
        const ok = log.done.includes(e.kind), bad = !!log.failed?.includes(e.kind);
        if (e.kind === log.start) open = e.t;
        else if (ok || bad) {
            open = undefined;
            last = { t: e.t, ok, kind: e.kind, ...(e.ms != null ? { ms: e.ms } : {}), ...(e.bytes != null ? { bytes: e.bytes } : {}), ...(e.detail ? { detail: { ...e.detail } } : {}) };
        }
    }
    const pending = live?.pending;
    const state: JobState = live?.running ? "running"
        : open != null ? "interrupted"
            : last && !last.ok ? "failed"
                : pending ? "waiting" : "idle";
    return {
        id: decl.id, title: decl.title, trigger: decl.trigger, subsystem: log.subsystem, kinds: jobKinds(log), state,
        ...(pending != null ? { pending } : {}),
        ...(live?.pendingLabel ? { pendingLabel: live.pendingLabel } : {}),
        ...(live?.nextDue != null ? { nextDue: live.nextDue } : {}),
        ...(live?.blocked ? { blocked: live.blocked } : {}),
        ...(last ? { lastRun: last } : {}),
        // A running pass that is not the open one would have closed it; an open record while running is its own start.
        ...(open != null && !live?.running ? { interruptedAt: open } : {}),
    };
}

/**
 * Every declared job's status, read against one copy of the log. A job whose live answer throws is still listed, with
 * the log's view and the error, since a job missing from the list reads as one that does not exist.
 * @param events the housekeeping log, oldest first
 */
export async function readJobs(events: readonly HousekeepingEvent[]): Promise<JobStatus[]> {
    const out: JobStatus[] = [];
    for (const d of declaredJobs()) {
        let live: JobLive | undefined, error: string | undefined;
        try { live = d.live ? structuredClone(await d.live()) : undefined; }
        catch (e) { error = e instanceof Error ? e.message : String(e); }
        out.push({ ...jobStatus(d, live, events), ...(error ? { error } : {}) });
    }
    return out;
}
