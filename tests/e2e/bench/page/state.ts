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
    /** it errored because the backend refused for a rate limit (metrics.mjs `isRateLimit`) */
    rateLimited?: boolean;
    /** kept open after the sweep to go on talking to (bench/hold.mjs): the command that sends it a message */
    held?: string;
    succeeded?: boolean | null;
    steps?: number;
    secs?: number | null;
    cached?: boolean;
    /** not selected by this invocation (`--only`, `--models`): an earlier one of the same spec and build ran it */
    onDisk?: boolean;
    /** the run's directory, relative to the sweep; set as soon as the run starts */
    path?: string;
    hash?: string | null;
    startedAt?: number;
    models?: { driver?: string | null; vision?: string | null; utility?: string | null } | null;
    live?: { step?: number; maxSteps?: number; tool?: string; last?: string; pending?: boolean };
    focus?: { step: number; tool?: string; why: string } | null;
    /** whether its model turns were to be streamed, and whether they were (metrics.mjs `streamUse`) */
    stream?: { asked: boolean | null; deltas: number; streamed: boolean; turns: number; turnsWithUsage: number } | null;
    turns?: { answer: string; tools: string[]; capped: boolean; expect?: boolean; why?: string; expectError?: string; n?: number }[];
    /** turns asked only because an answer called for them (an interview's `followUps`), under the turn they followed */
    followUps?: { after: number; n: number; ask: string; answer: string; tools: string[]; capped: boolean }[];
    /** how many of its checked turns came out as expected */
    expects?: { passed: number; total: number };
    /** turns someone added after the run's own, while it was held open (bench/hold.mjs): never part of the interview */
    continued?: { turn: number; ask: string; at: string | null; answer: string; tools: string[]; capped: boolean }[];
    checks?: { id: string; turn: number; quote: string; note: string; by: string; at: string | null; here: boolean; still: boolean | null }[];
}

/** One sweep's record, as sweeps.mjs keeps it (without the spec's text). */
export interface SweepRecord { at: string; by: string; specHash: string; fingerprint: string; dirty: boolean; spec: string;
    /** where the spec file was on disk; null for a record from before it was kept */
    onDisk?: string | null }

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
    /** runs in the sweep's directory from an earlier spec or build: listed, never counted (sweeps.mjs `sortOnDisk`) */
    older?: { path: string; taskId: string | null; combo: Record<string, unknown> | null; repeat: number | null }[];
    spec?: SpecState | null;
    /** each run's events (the resource panel's derivation), by its place in `runs`; cached runs have none */
    timeline?: { runs: { index: number; events: ResourceEvent[] }[]; now: number } | null;
    /** where run paths are served from: "/artifacts/" live, "" in a saved report */
    artifactBase?: string;
    /** the scoreboard's line for each driver model of the sweep, when the runs are logged */
    scores?: SweepScores | null;
    /** models the server lists as cloud (not Ollama's), drawn in their own shade (palette.ts `cloudModels`) */
    cloud?: string[];
    /** names that are a script, not a model (a seeded run's first turn), drawn neutral (palette.ts `scriptedModels`) */
    scripted?: string[];
    /** the repository's web URL (origin's, as gen-build-info reads it), for links to a commit and a file at it */
    repo?: string | null;
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
    tasks: { key: string; task: string; taskHash: string; shown: string | null; text: string; variant: string; scored: boolean; runs: number; models: number; passed: number; scoredRuns: number;
        difficulty: { b: number; se: number; lo: number; hi: number } | null; medianTokens: number | null }[];
    /** the regression suite's verdict on the newest build and μ over builds (regress.mjs); null without two builds' runs */
    regression?: RegressionReport | null;
}

/** A posterior from the regression fit: the estimate, its spread and interval, P(> 0), and P(> the smallest counted shift). */
export interface Shift { v: number; sd: number; lo: number; hi: number; pUp: number; pReal?: number }

/** One task's line in a regression verdict. */
export interface RegressionTask {
    key: string; task: string; taskHash: string; text: string; delta: Shift; detectable: number | null;
    models: { model: string; base: { passed: number; runs: number }; now: { passed: number; runs: number } }[];
    fell: string[]; flagged: boolean; oneModel: boolean;
}

/** The regression suite on the scoreboard (regress.mjs `regressionReport`). */
export interface RegressionReport {
    verdict: {
        build: string; baseline: string[]; builds: string[]; mu: Shift; flagged: boolean; tasks: RegressionTask[];
        unmatched: { key: string; side: "now" | "base" }[]; runs: { now: number; base: number };
        method: { minShift: number; tau: number; tauSd: number; priorSd: number; z: number; q: number; buildP: number; power: number; alpha: number; converged: boolean };
    };
    history: { build: string; at: string; mu: Shift; flagged: boolean; tasks: { key: string; task: string; delta: Shift; flagged: boolean }[] }[];
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
