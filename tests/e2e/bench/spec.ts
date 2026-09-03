// spec.ts — the TYPED configuration surface of the bench.
//
// A bench spec is a TypeScript module, not JSON, so filling one in is autocompleted and checked: the
// dimension keys you declared are the keys `apply()` receives, a dimension's literal values are the union
// its parameter accepts, and a task's `succeeded` predicate is typed against what it is actually handed.
// A typo in a dimension name is a compile error rather than a cell that silently never varies.
//
// Everything here is DATA plus two hooks (`apply`, `succeeded`). The runner does the walking; a spec never
// drives a browser itself, so a spec is readable as a description of an experiment.

/** A dimension is a named axis of the matrix: its values are the levels the sweep varies over. */
export type DimensionValue = string | number | boolean;
export type Dimensions = Record<string, readonly DimensionValue[]>;

/** One point in the matrix: each dimension bound to one of its values. */
export type Combo<D extends Dimensions> = { [K in keyof D]: D[K][number] };

/** How a run is scored. Handed to a task's `succeeded` predicate. */
export interface TaskOutcome {
    /** the model's final answer for the measured turn */
    answer: string;
    /** the tool steps it took (deduplicated, in order) */
    steps: { tool?: string; arguments?: Record<string, unknown>; result?: unknown }[];
    /** the raw debug events, if a predicate needs something the summary doesn't carry */
    events: Record<string, unknown>[];
    result: { summary?: string; steps?: number; cancelled?: boolean } | null;
}

/**
 * A history to install BEFORE the measured turn.
 *
 * Turn 1 runs against the scripted fake-LLM, so the experiment decides exactly what the model will find in
 * its context — a corrupted pointer, a tool call that failed, a large captured output. The backend then
 * swaps to the real model and the task runs as a follow-up in the SAME session. Nothing is fabricated: the
 * loop really produced that history, so the fault the model is recovering from is a real fault.
 *
 * This is what makes error-recovery measurable rather than incidental. Waiting for a real model to corrupt
 * an identifier by chance needs hundreds of runs; seeding the corruption measures the recovery directly.
 */
export interface BenchSeed {
    /** the task the scripted turn is given (it is the setup, and is never scored) */
    task: string;
    /** fake-LLM script steps: `{ content }`, `{ tool, args }`, or `(reqBody) => step` */
    script: unknown[];
}

export interface BenchTask {
    /** stable id — it names the cell's artifact directory, so changing it discards that cell's cache */
    id: string;
    /** the task given to the model */
    task: string;
    /** start route on the test site (e.g. "/spreadsheet"); see `GET /examples` for the list */
    start?: string;
    /** limit to this subset of domTools — a smaller system prompt and far fewer tokens per turn */
    tools?: string[] | null;
    /** wire python_exec as an extra tool */
    python?: boolean;
    /** enable tool tokens (pointers) */
    toolTokens?: boolean;
    /** a SECOND measured turn in the same session */
    followup?: string;
    /** install a history before the measured turn (see BenchSeed) */
    seed?: BenchSeed;
    /**
     * fake-LLM script for the measured turn, used only when no real backend is configured. It is what
     * makes a cell DETERMINISTIC: the same task can be scripted to re-emit, to cite, or to mistype an
     * identifier, so the metric extractors can be checked against a run whose answer is known before it
     * starts. Ignored against a real model, which writes its own.
     */
    script?: unknown[];
    /** extra ml.agent options for this task */
    agentOptions?: Record<string, unknown>;
    /** how long one run of this task may take before it is recorded as a timeout */
    timeoutMs?: number;
    /**
     * Did the run get the right answer? The bench cannot know what right looks like, so a task carries its
     * own predicate. A task WITHOUT one reports "not scored" rather than counting as a failure — which is
     * honest, and keeps a task usable for measuring behaviour (token cost, re-emission) when correctness
     * is not the question being asked.
     */
    succeeded?: (outcome: TaskOutcome) => boolean;
}

/** What a combination of dimension values DOES to a run. Returned by the spec's `apply`. */
export interface CellEffects {
    /**
     * esbuild `--define` values for a VARIANT BUILD of the extension. An experimental dimension belongs
     * here rather than in the product's config: the build takes ~25ms, and a hypothesis that may well
     * conclude "the current design was fine" should add zero product surface. Ship a real setting only if
     * the variant wins.
     */
    defines?: Record<string, string>;
    /** options merged into the ml.agent call */
    agentOptions?: Record<string, unknown>;
    /** override the backend for this cell (typically just the model) */
    backend?: { model?: string; chatUrl?: string; key?: string };
    /** override the task's tool subset */
    tools?: string[] | null;
    toolTokens?: boolean;
    python?: boolean;
}

export type ApprovePolicy = "auto" | "deny" | "readonly" | "hold";

export interface BenchSpec<D extends Dimensions = Dimensions> {
    /** names the sweep, and its artifact directory */
    name: string;
    description?: string;
    /**
     * Runs per cell. Models are stochastic: one run per cell measures sampling, not the thing under test.
     * Five is the floor at which a difference is worth believing; the report shows spread, not a point.
     */
    repeats?: number;
    /** default per-run timeout, overridable per task */
    timeoutMs?: number;
    /** approval policy for every run in the sweep */
    approve?: ApprovePolicy;
    /**
     * When to snapshot the BROWSER — every open page, a screenshot plus the DOM.
     *
     * `"failure"` (default) fires only when a run errored, timed out or threw. That is the case where the
     * transcript simply stops and the page holds the explanation: a modal nobody dismissed, a login wall,
     * a spinner that never resolved. `"always"` also captures a clean run, for comparing what two models
     * were LOOKING at rather than what they did. `"never"` for a long sweep where disk beats diagnosis.
     */
    capture?: "failure" | "always" | "never";
    /** the axes of the matrix */
    dimensions: D;
    /** the tasks each combination is run against */
    tasks: BenchTask[];
    /**
     * Turn one point of the matrix into concrete effects. Receives the whole combination, so an effect may
     * depend on several dimensions at once. Omit it for a sweep whose dimensions are only labels (e.g.
     * comparing tasks across models, where `model` is handled by the default mapping below).
     */
    apply?: (combo: Combo<D>) => CellEffects;
}

/**
 * Identity helper that pins the dimension types so `apply(combo)` and the report get literal types.
 * The `const` type parameter is what makes `["hex", "words"]` infer as that union rather than `string[]`.
 */
export function defineBench<const D extends Dimensions>(spec: BenchSpec<D>): BenchSpec<D> {
    return spec;
}
