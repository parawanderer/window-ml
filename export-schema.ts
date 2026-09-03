/**
 * @file The JSON export schema — the normative shape of a `.json` run export.
 *
 * This is a PUBLISHED contract, unlike the rest of the sidebar's types. It exists so a
 * program can consume an export without knowing anything about how we render markdown,
 * and consumers are expected to read (or copy) this file. Changing a field here is a
 * change to somebody else's parser: additive changes are free, anything else bumps
 * {@link EXPORT_SCHEMA_VERSION}.
 *
 * Lives at the root beside `contract.ts`, not under `sidebar/`: it is a contract, not a
 * detail of the debug UI, and it depends on nothing in there. The serializer that
 * produces it does (it reads the sidebar's `Session`), so that stays in `sidebar/`.
 *
 * Design notes live in `docs/spec/PROGRAMMATIC_EXPORT.md`. The short version:
 *  - It serializes the `Session` directly rather than walking it through a `Sink`. The
 *    sink vocabulary is presentational, so a sink-shaped JSON would encode our layout
 *    decisions — the exact coupling this format removes.
 *  - Nested and lossless. A flat step table is trivial to derive from this; the reverse
 *    is not.
 *  - Optional fields are OMITTED rather than null, so `"error" in step` is meaningful.
 *    The exception is {@link ExportOutcome}, whose flags are always present so consumers
 *    need no defaulting.
 *
 * WHAT THE VERSION PROMISE COVERS. This file's own field names and shapes, and the borrowed types that
 * are not marked unstable. Some fields reach types that live in `contract.ts` and are INTERNAL — most
 * visibly {@link ExportStep.renderIn}/{@link ExportStep.renderOut} and {@link ExportSession.config}.
 * Those carry `@unstable` at their declaration: a new render-descriptor variant or a new agent option can
 * appear in any release, and doing so is NOT a breaking change to this format. They are still fully
 * described in `docs/spec/export.schema.json` — you get real generated types for them — but the schema
 * marks them `x-unstable` and lets an unrecognised variant validate. Switch on what you know; tolerate
 * the rest.
 *
 * The generated JSON Schema at `docs/spec/export.schema.json` is this file, lifted, for consumers who are
 * not writing TypeScript. Regenerate it with `npm run gen-export-schema` (the build does it too).
 *
 * Types erased at build; import with `import type`.
 */

import type {
    RenderDescriptor, TokenUsage, SubcallUsage, ToolFeedback,
    PersistGrant, ReusedGrant, DebugAgentConfig, DebugSessionConfig,
} from "./contract";

/** Bumped only on a BREAKING change. Adding an optional field is not breaking. */
export const EXPORT_SCHEMA_VERSION = 1;

/** ISO 8601 with milliseconds, UTC — e.g. "2026-09-03T09:41:02.113Z". Chosen over epoch
 *  ms so an export is readable without tooling; the volatile-field list says which of
 *  these a differ should ignore. */
export type IsoTimestamp = string;

/** A run's terminal state, mirroring the sidebar's own. */
export type ExportStatus = "pending" | "ok" | "err";

/* ------------------------------- envelope ------------------------------- */

export interface ExportDocument {
    /** {@link EXPORT_SCHEMA_VERSION} at the time of writing. Check this before parsing. */
    schema: number;
    /** When the export was produced — not when the run happened. Volatile. */
    exportedAt: IsoTimestamp;
    generator: ExportGenerator;
    session: ExportSession;
}

export interface ExportGenerator {
    /** Always "window.ml". Present so an aggregator can tell exports apart by origin. */
    name: string;
    /** The extension version that wrote the file, from the manifest. Coarse — it moves on releases,
     *  not on commits. {@link ExportGenerator.build} is what identifies the actual code. */
    version?: string;
    /** Which BUILD produced this run. Absent when the exporter had no build stamp to hand. */
    build?: ExportBuild;
}

/**
 * The commit the extension was built from — the answer to "are these two exports even comparable?".
 *
 * A manifest version cannot answer that: two runs a week apart share it while the code moved underneath.
 * Anything comparing runs (a benchmark sweep, a regression differ) needs the commit, and needs to know
 * whether the tree was dirty, because a dirty build is not reproducible from any commit.
 *
 * Mirrors the extension's own `BUILD_INFO`, minus its `dirtyDiff` unless the exporter opts in — see
 * {@link ExportBuild.dirtyDiff}.
 */
export interface ExportBuild {
    /** Full commit SHA the extension was built from. */
    commit?: string;
    shortCommit?: string;
    /** The working tree had uncommitted changes at build time, so `commit` does NOT fully describe what
     *  ran. A sweep should treat runs from a dirty build as provisional. */
    dirty?: boolean;
    /** Paths that were modified, when dirty. Names only — cheap, and usually enough to know what moved. */
    dirtyFiles?: string[];
    /**
     * The full uncommitted diff, when the exporter asked for it. OPT-IN, and off by default for two
     * reasons: it is frequently larger than the run it describes, and it puts unpublished source into a
     * file that gets shared. Turn it on where the export is a local artifact and reproducing the exact
     * build matters — a benchmark cell, a bug report you are keeping.
     */
    dirtyDiff?: string;
    /** Committer date of {@link ExportBuild.commit}, ISO 8601. */
    commitDate?: string;
    repoUrl?: string;
    commitUrl?: string;
    /** When the bundle was built. Volatile: rebuilding the same commit changes it. */
    buildTime?: string;
}

/* ------------------------------- session ------------------------------- */

export interface ExportSession {
    /** The session hash the sidebar shows. Stable within a session, random across them,
     *  so a differ comparing two runs of the same task should ignore it. */
    hash: string;
    /** An agent run (a task and its steps) or a chat session (turns). */
    kind: "agent" | "chat";
    /** The AI-summarised title. Absent when it was never generated. */
    title?: string;
    createdAt: IsoTimestamp;
    lastAt: IsoTimestamp;
    /** The model pinned for the session, when there is one. A per-turn/per-step
     *  `model` is the one that actually answered, which can differ (utility profile,
     *  server-side resolution). */
    model?: string;
    /** The options the session was created with, verbatim: `createChat`'s for a chat,
     *  `ml.agent`'s for a run. */
    config?: DebugSessionConfig | DebugAgentConfig;
    /** The initial task. Agent runs only. */
    task?: string;
    /** The page the run STARTED on. Agent runs only, and absent on a run exported from a build that
     *  predates the field. Close to a primary key when comparing runs — the same task against a
     *  different page is a different experiment — and previously recoverable only by regexing the URL
     *  back out of `config.system`, which is prose and only present when `env` was on. A run that
     *  navigates ends somewhere else; this is where it began. */
    page?: ExportPage;
    /** Images attached to the initial task, as data URLs. Agent runs only. */
    taskImages?: string[];
    outcome: ExportOutcome;
    totals: ExportTotals;
    /** The conversation in order: the user's messages and the model's answers. For a
     *  chat these are its turns; for an agent run, its `say`s and answers interleaved
     *  with the steps by {@link ExportMessage.atStep}. */
    messages: ExportMessage[];
    /** The agent loop's steps, ordered by {@link ExportStep.seq}. Agent runs only. */
    steps?: ExportStep[];
}

export interface ExportPage {
    url?: string;
    /** Origin of {@link ExportPage.url}, split out so grouping by site needs no URL parsing. */
    origin?: string;
    title?: string;
}

/* ------------------------------- derived ------------------------------- */

/**
 * Run-level flags, gathered rather than scattered as optional booleans.
 *
 * DERIVED, and deliberately so: several consumers want these and would otherwise each
 * reconstruct them from different fields and disagree. Every input remains present
 * elsewhere in the document, so a consumer that distrusts our arithmetic can redo it.
 */
export interface ExportOutcome {
    status: ExportStatus;
    /** The loop stopped because it reached `maxSteps`, not because it finished. */
    hitCap: boolean;
    /** Aborted via the HUD or an AbortSignal. The transcript is partial but real. */
    cancelled: boolean;
    /** Resurrected from storage after the service worker was evicted mid-run. */
    resumed: boolean;
    /** A FATAL error (the model call failed, or the loop threw). Distinct from a tool
     *  returning an error string, which is a normal step result. Null when none. */
    error: string | null;
    /** Distinct `step` values, NOT `steps.length` — one loop turn emits several steps
     *  (a thought plus one per tool call) sharing a `step`. */
    turnsRun?: number;
    maxSteps?: number;
}

/** Summed counters. Derived for the same reason as {@link ExportOutcome}. */
export interface ExportTotals {
    /** Step records, i.e. `steps.length`. See {@link ExportOutcome.turnsRun} for the
     *  number the loop's cap is measured against. */
    steps: number;
    /** Prompt tokens across the run's own model calls. Excludes delegated sub-calls. */
    tokensIn: number;
    tokensOut: number;
    /** Tokens spent by DELEGATED sub-calls (`look`, `locate`, verify) — billed to the
     *  run but not part of the driver's own context. */
    subcallTokens: number;
    /**
     * ELAPSED wall-clock, first event to last — not time spent working. A multi-turn session includes
     * whatever the human spent between turns, so a chat left open for an hour reports an hour. Dividing
     * tokens by this gives throughput of the session, not of the model. Volatile.
     */
    wallMs: number;
    /** Per-model breakdown, so a sweep can attribute cost when a run used several
     *  (a driver plus a utility reader, say). */
    byModel: ExportModelUsage[];
}

export interface ExportModelUsage {
    model: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
}

/* ------------------------------- messages ------------------------------- */

/**
 * One conversational message. A chat turn carries both halves (`user` then `assistant`)
 * as two entries so the array reads uniformly for both session kinds.
 */
export interface ExportMessage {
    role: "user" | "assistant";
    text: string;
    at: IsoTimestamp;
    /** The cumulative step count when this arrived, so a consumer can interleave
     *  messages with {@link ExportSession.steps} in the order they happened. Agent
     *  runs only. */
    atStep?: number;
    /** Attached images, as data URLs. */
    images?: string[];
    /** Assistant only: the model that actually produced this, after server-side
     *  resolution. May differ from {@link ExportSession.model}. */
    model?: string;
    /** Assistant only: which profile resolved the model — marks a utility-model reply
     *  apart from the default one. */
    extend?: string;
    /** Assistant only: separate thinking text, when the model emitted any. */
    reasoning?: string;
    /** Assistant only, chat sessions: provenance the server attached (RAG/tool sources). */
    sources?: unknown[];
    /** Assistant only: token counts for this turn, when the server reported them. */
    usage?: TokenUsage;
    /** Present when this message failed. */
    error?: string;
    status?: ExportStatus;
}

/* ------------------------------- steps ------------------------------- */

/**
 * One agent step: either a thought, or a tool call with its arguments and result.
 *
 * Transient view state is NOT exported — `pending`, `awaitingApproval`, `liveStream`,
 * `ended`/`endedStep` describe a live UI, not the run. A pending step never appears in
 * an export; only its completed form does.
 */
export interface ExportStep {
    /** The loop turn this belongs to. Several steps share one. */
    step: number;
    /** Index within the current turn of a multi-turn session (`run()` then `continue()`),
     *  where `step` keeps counting across turns. */
    localStep?: number;
    /**
     * Groups the records a single model turn emitted: a thought and the tool call it
     * decided on share one `seq`. It is therefore NOT unique — 9 records over 5 turns
     * carry 5 distinct values — so it identifies a turn's event group, not a record.
     *
     * ORDER: the `steps` array is already in the order things happened. Sort by `seq`
     * only with a stable sort, or ties reorder; array order is authoritative.
     */
    seq: number;
    /** When the step completed. Volatile. */
    at?: IsoTimestamp;
    /** How long the tool took, from `toolMs`. Frequently ABSENT — the loop records it
     *  per tool call, and a thought-only record has none. Volatile. */
    durationMs?: number;
    /** The model's narration for this step, when it produced any. */
    thought?: string;
    /** Separate reasoning/thinking text, distinct from `thought`. */
    reasoning?: string;

    /** The tool called. Absent on a thought-only step. */
    tool?: string;
    /** The arguments the model emitted, verbatim — not normalised, not re-ordered. */
    arguments?: Record<string, unknown>;
    /** Schema complaints about those arguments (required/type/enum/unknown-prop),
     *  as the sidebar's red strip shows them. Absent when the args were clean. */
    argIssues?: string[];

    /**
     * The fuller captured output — what the UI shows, which can exceed what the model
     * received (see {@link ExportStep.modelResult}).
     */
    result?: string;
    /**
     * What the model ACTUALLY received, when it differs from {@link ExportStep.result}
     * — the result is clipped to a context budget while the UI keeps more. Omitted when
     * the two are identical.
     *
     * Required by the project's raw-view rule: an export must always carry the
     * model-facing text, never only the prettier one.
     */
    modelResult?: string;
    /** Output the tool streamed as it worked, when it streamed. */
    streamOutput?: string;
    /** `[offsetInStreamOutput, epochMs]` per line, stamped by whatever produced the
     *  output. Lets a consumer reconstruct per-line timing. Volatile. */
    streamMarks?: [number, number][];
    /** The `@tool:<id>` token minted for this output, when one was, so a citation in an
     *  answer can be resolved back to the step that produced it. Volatile. */
    token?: string;

    /** How a privileged call was approved: auto-approved by the read-only interpreter or
     *  sandbox, consented by origin, approved by the user, denied, and so on. Absent
     *  when the tool needed no approval. */
    approval?: string;
    /** Grants this step created / reused, for privileged fetches. */
    grants?: PersistGrant[];
    reused?: ReusedGrant[];

    /** A COUNT of matched DOM elements. Never the nodes: they cannot cross the bus. */
    elements?: number;
    /** Visualisation of the CALL, as the sidebar rendered it. Data, never code. */
    renderIn?: RenderDescriptor;
    /** Visualisation of the RESULT. */
    renderOut?: RenderDescriptor;
    /** What was fed back into the model's context off the back of this step (a crop
     *  after a `locate`, say), and why. */
    feedback?: ToolFeedback;

    /**
     * Token counts for the model call that produced this step. In practice this sits on
     * the THOUGHT record of a turn, not on the tool call it led to — the tokens were
     * spent deciding, and the tool call is the consequence. Do not expect it per tool.
     *
     * `session.totals.tokensIn` sums these, so it counts the re-sent conversation once
     * per turn. That is what a run COST; it is not the count of distinct tokens.
     */
    usage?: TokenUsage;
    /** Tokens spent by delegated sub-calls made DURING this step. */
    subUsage?: SubcallUsage;
}

/* ------------------------------- diffing ------------------------------- */

/**
 * Field paths whose values change between two runs of the same task without the run
 * behaving differently. A consumer comparing exports should strip these first, or it
 * will diff wall-clock noise instead of behaviour.
 *
 * Published as data so a differ does not have to hardcode our field names.
 *
 * NOT SUFFICIENT ON ITS OWN — see {@link VOLATILE_PATTERNS}, which covers the same volatile values
 * where they appear inside free text, and which no amount of field removal can reach.
 */
export const VOLATILE_FIELDS: readonly string[] = [
    "exportedAt",
    "generator.build.buildTime",
    "session.hash",
    "session.createdAt",
    "session.lastAt",
    "session.totals.wallMs",
    "session.messages[].at",
    // A message carries the same TokenUsage a step does, and a CHAT export is all messages and no
    // steps — so omitting these left that whole session kind with nothing stripped but the envelope.
    "session.messages[].usage.genMs",
    "session.messages[].usage.evalMs",
    "session.messages[].usage.loadMs",
    "session.steps[].at",
    "session.steps[].durationMs",
    "session.steps[].streamMarks",
    "session.steps[].token",
    "session.steps[].usage.genMs",
    "session.steps[].usage.evalMs",
    "session.steps[].usage.loadMs",
];

/**
 * Volatile values that appear INSIDE text, which stripping fields cannot remove.
 *
 * A tool-output pointer is the case that forces this. `steps[].token` is correctly listed as volatile
 * above, but that same id is deliberately surfaced to the model as text: as an `@tool:a39f599` citation
 * in an answer, as the `ref` argument of a `dereference` call, and in the token line appended to a tool
 * result. Delete the field and every one of those copies remains, so a differ that follows
 * {@link VOLATILE_FIELDS} faithfully still diffs pure noise — and worse, it diffs noise that LOOKS like
 * behaviour, since the surrounding sentence is identical and only the id moved.
 *
 * Apply these to every string value that survives field-stripping, then compare.
 *
 * Use {@link canonicalizeText}, which also handles the session hash.
 */
export const VOLATILE_PATTERNS: readonly { pattern: RegExp; replace: string }[] = [
    /** A minted tool-output pointer: 7 hex characters (6 of payload plus a check character). The
     *  `@tool:` prefix is what makes this safe to apply blindly — the hex alone would not be. */
    { pattern: /@tool:[0-9a-f]{7}\b/g, replace: "@tool:<id>" },
];

/**
 * The session hash is volatile in text too, but deliberately NOT in {@link VOLATILE_PATTERNS}: it is
 * eight bare hex characters, and a pattern that loose would also strike a colour, a short commit or any
 * hex the page happened to contain — masking real differences while claiming to remove noise. It does
 * not need a pattern, because its value is known: take `session.hash` and replace that literal string.
 */
export function canonicalizeText(text: string, sessionHash?: string): string {
    let out = VOLATILE_PATTERNS.reduce((t, { pattern, replace }) => t.replace(pattern, replace), text);
    if (sessionHash) out = out.split(sessionHash).join("<hash>");
    return out;
}
