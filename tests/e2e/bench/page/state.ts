// state.ts — the shape of what the bench pushes to its page (over SSE) and bakes into report.html: run.mjs builds it,
// the page only reads it.

import type { ResourceEvent } from "../../../../src/resource/resource-timeline";

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
    checks?: { id: string; turn: number; quote: string; note: string; here: boolean; still: boolean | null }[];
}

export interface BenchState {
    name: string;
    description?: string;
    dims: string[];
    columns: { key: string; label: string; digits: number }[];
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
    /** each run's events (the resource panel's derivation), by its place in `runs`; cached runs have none */
    timeline?: { runs: { index: number; events: ResourceEvent[] }[]; now: number } | null;
    /** where run paths are served from: "/artifacts/" live, "" in a saved report */
    artifactBase?: string;
}
