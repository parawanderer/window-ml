// state.ts — the shape of what the bench pushes to its page (over SSE) and bakes into report.html: run.mjs builds it,
// the page only reads it.

import type { ResourceEvent } from "../../../../src/resource/resource-timeline";
import type { Capacity } from "../../../../src/resource/resource-capacity";
import type { ResourceSample } from "../../../../src/resource/resource-model";

export interface Agg { mean: number | null; sd: number | null; n: number }

export interface RunState {
    combo: Record<string, string | number | boolean>;
    taskId: string;
    repeat: number;
    state: "pending" | "running" | "done";
    /** what a person's mark names this run by: the `model` value, else the whole combination */
    who: string;
    ok?: boolean;
    succeeded?: boolean | null;
    steps?: number;
    secs?: number | null;
    cached?: boolean;
    /** the run's directory, relative to the sweep; set as soon as the run starts */
    path?: string;
    hash?: string | null;
    startedAt?: number;
    models?: { driver?: string | null; vision?: string | null; utility?: string | null } | null;
    live?: { step?: number; maxSteps?: number; tool?: string; last?: string; pending?: boolean };
    focus?: { step: number; tool?: string; why: string } | null;
    turns?: { answer: string; tools: string[]; capped: boolean }[];
    checks?: { id: string; turn: number; quote: string; note: string; by: string; at: string | null; here: boolean; still: boolean | null }[];
}

/** One sweep's record, as sweeps.mjs keeps it (without the spec's text). */
export interface SweepRecord { at: string; by: string; specHash: string; fingerprint: string; dirty: boolean; spec: string }

/** Which spec this sweep ran and what changed since the sweep before (sweeps.mjs `specProvenance`). */
export interface SpecState extends SweepRecord {
    source: string;
    sweeps: number;
    previous: SweepRecord | null;
    /** null on the first sweep */
    changed: boolean | null;
    diff: ({ kind: "same"; text: string; a: number; b: number } | { kind: "del"; text: string; a: number } | { kind: "add"; text: string; b: number } | { kind: "gap"; skipped: number })[] | null;
    tooBig: boolean;
    stat: { added: number; removed: number } | null;
    history: SweepRecord[];
}

export interface BenchState {
    name: string;
    description?: string;
    dims: string[];
    columns: { key: string; label: string; about?: string; digits: number }[];
    runs: RunState[];
    rows: { combo: Record<string, unknown>; taskId: string; agg: Record<string, Agg> & { runs: number; errors: number } }[];
    started: number;
    finished: number | null;
    jobs: number;
    dirty?: boolean;
    pdf?: boolean;
    /** the question each turn of each interview asked, by task id */
    interviews?: Record<string, string[]>;
    skipped?: { model: string; why: string }[];
    spec?: SpecState | null;
    /** each run's events (the resource panel's derivation), by its place in `runs`; cached runs have none */
    timeline?: { runs: { index: number; events: ResourceEvent[] }[]; now: number } | null;
    /** where run paths are served from: "/artifacts/" live, "" in a saved report */
    artifactBase?: string;
    /** the scoreboard's line for each driver model of the sweep, when the runs are logged */
    scores?: SweepScores | null;
    /** the box's memory over the sweep (resource-poll.mjs), each distinct capacity once; null without readings */
    resources?: PackedSamples | null;
}

/** A model's score on the scoreboard (scores.mjs `scoreboard`): θ relative to the average task, and its chance there. */
export interface Score { theta: number; se: number; lo: number; hi: number; chance: number; chanceLo: number; chanceHi: number }

/** One model's line on the scoreboard. */
export interface ScoreModel {
    key: string; model: string; digest: string | null; quant: string | null; params: string | null; local: boolean | null;
    runs: number; scored: number; passed: number; errored: number; unscored: number; tasks: number;
    score: Score | null;
    bloat: { ratio: number; runs: number } | null;
    medianTokens: number | null;
    first: string; last: string;
}

/** The scoreboard page's state (scores.mjs `scoreboard`), baked into scores.html as `window.__BENCH_SCORES__`. */
export interface ScoreBoard {
    /** the SQLite log, relative to the repo */
    db: string;
    generated: string;
    totals: { runs: number; fitted: number; models: number; tasks: number; unscored: number; errored: number; scoredTasks: number };
    method: { priorSd: number; z: number; minScored: number; converged: boolean; iterations: number };
    /** what each number is, by column: the tooltips, and scores.md's notes */
    about: Record<string, string>;
    models: ScoreModel[];
    tasks: { key: string; task: string; taskHash: string; text: string; variant: string; scored: boolean; runs: number; models: number; passed: number; scoredRuns: number;
        difficulty: { b: number; se: number; lo: number; hi: number } | null; medianTokens: number | null }[];
}

/** The sweep page's view of the scoreboard: each driver model's line, and where the scoreboard is. */
export interface SweepScores { href: string; about: Record<string, string>; minScored: number; models: Record<string, ScoreModel> }

/** Resource samples as the harness sends them: each sample names its capacity by index (`c`). */
export interface PackedSamples {
    capacities: Capacity[];
    samples: (Omit<ResourceSample, "capacity"> & { c: number })[];
    /** the box's own events from its stream (loads, evictions, serving spans, any client's generations); absent when polled */
    events?: ResourceEvent[];
}
