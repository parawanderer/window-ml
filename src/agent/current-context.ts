// current-context.ts — what `ml.current` hands a read-only `exec`: the run's own messages, what is known about each,
// and its execution log, as ONE snapshot of plain data (docs/spec/CURRENT_CONTEXT.md).
//
// Pure, and in three parts that never meet at runtime. The agent loop RECORDS what only the moment of appending a
// message knows (when, which step, which tool, typed where, how big by the engine's own count), because nothing can
// reconstruct it afterwards. This module ASSEMBLES a snapshot from those records on request. The dialect READS it.
// Nothing here holds state or touches a page, so the worker and the page share it and it is tested directly.

import type { NeutralMessage } from "../contract/contract-chat";
import type { PromptSurface } from "../contract/contract-run";
import type { LogLevel } from "../log/housekeeping";
import type { RunLogEvent } from "../log/run-log";
import { toolToken } from "../util";

/** What the loop records about a message at the moment it appends it. Every field is null when not known, which
 *  is the case for history a session carried in from an earlier turn: the turn that appended it is gone. */
export interface RecordedMeta {
    ts: number | null;
    step: number | null;
    seq: number | null;
    tool: string | null;
    surface: PromptSurface | null;
    /** The engine's own count for THIS message, or null when it gave none that measures it. */
    counted: number | null;
    /** The tool output in this message was cut BEFORE the model saw it. */
    truncated: boolean;
}

/** Nothing known: a message no turn of this loop appended. */
export const UNRECORDED: RecordedMeta = { ts: null, step: null, seq: null, tool: null, surface: null, counted: null, truncated: false };

/** Record the messages appended since `from`. One call per push: the loop measures `messages.length` either side,
 *  so a host's push helper that appends two messages (a tool result and its images) records both. */
export function recordAppended(recorded: (RecordedMeta | undefined)[], from: number, to: number, fact: Partial<RecordedMeta>): void {
    for (let i = from; i < to; i++) recorded[i] = { ...UNRECORDED, ...fact };
}

/** Characters per token for an estimate. No tokenizer is involved: good for comparing messages, rough for budgets. */
export const CHARS_PER_TOKEN = 4;

/** What is KNOWN about one message: `ml.current.meta[i]` describes `ml.current.messages[i]`. Flat on purpose, so a
 *  copy the script owns is writable all the way down (the dialect's ownership is one level deep). */
export interface MessageMeta {
    /** Stable handle, minted like a `@tool:` id (payload plus check character) but from its own namespace, so the two
     *  can never collide. The same message has the same id in every snapshot of the session. */
    id: string;
    /** Epoch ms it was appended; null for history carried in from an earlier turn. */
    ts: number | null;
    /** How long ago that was, at the snapshot's instant. */
    ageMs: number | null;
    /** The gap since the PREVIOUS message: a long one is someone going away between turns. Null when either is unknown. */
    gapMs: number | null;
    /** Where a user message was typed. Null for every other role, and for history. */
    surface: PromptSurface | null;
    /** The size of this message as the ENGINE counted it: what compacting it would reclaim. Text only; see `images`.
     *  Present only when there is a count (a reply the model produced); otherwise `estimatedTokens` is, never both,
     *  so a message's size is `m.tokens ?? m.estimatedTokens`. Two names because a bare `tokens` was read as exact
     *  when it was an estimate (a real model summed them and called the total exact, 2026-10-08). */
    tokens?: number;
    /** The size of this message ESTIMATED from its characters ({@link CHARS_PER_TOKEN}), when the engine gave no count:
     *  every system, user and tool message. A total that includes one is an estimate. */
    estimatedTokens?: number;
    /** Images the message carries, which neither size includes: an image's cost depends on the model, and
     *  estimating its data URL by characters would be wrong by orders of magnitude. */
    images: number;
    /** The step that produced it, and the call within the run, so it joins up with the transcript and `@tool:` ids. */
    step: number | null;
    seq: number | null;
    /** The tool a tool-result message came from. */
    tool: string | null;
    /** The tool output was cut BEFORE the model saw it, so an ellipsis in it is not data. */
    truncated: boolean;
}

/** Which run this is. */
export interface CurrentRun {
    /** The run's session hash: the same in every turn of the conversation. */
    id: string;
    model: string | null;
    /** Model calls so far in THIS TURN, counting the one that is reading it: 1 on a turn's first call. It restarts when a
     *  new message starts a turn, so it is not a session-wide count (a real model read 2, then 1 after the next message,
     *  and took the watch it was reading for a stale snapshot). */
    step: number;
    /** THIS TURN's step budget. */
    maxSteps: number;
    /** When THIS TURN started, epoch ms. A message whose `meta[i].ts` is earlier (or null, carried in) is from an
     *  earlier turn: this is where the boundary between turns is visible from inside one read. */
    startedTs: number;
}

/** One execution-log record as the model reads it. `ts` is the log's `t`, renamed so a time is spelled one way across
 *  `ml.current`. Only the fields a model can act on: never `key`, which the housekeeping log withholds from a page
 *  that did not report the event, nor `tab`/`origin`, which say who REPORTED it. */
export interface CurrentLogRecord {
    ts: number;
    /** `info` for the routine, `warn` for something that went wrong and was worked around, `error` for what was not. */
    level: LogLevel;
    subsystem: string;
    kind: string;
    reason: string | null;
    detail: Record<string, unknown> | null;
}

/** The records, and the same log as greppable lines on `.text`, for `ml.pipe`. One member, two views. */
export type CurrentLog = CurrentLogRecord[] & { text: string };

/** Everything `ml.current` is, at one instant: the moment the exec reading it runs. So it holds the assistant message
 *  that made that call, and not the call's result, and every later read has more messages than this one.
 *
 *  Read it in a read-only `exec`, where it is read in place. In an approved `exec` of a run the extension's UI started,
 *  `ml.current` is a deep-frozen copy, and the exec runs in an isolated world: it shares the page's DOM but not the
 *  page's own globals, and of `ml` it has only `current` and `dereference`. Where no isolated world is available
 *  (Debugger-based actions turned off and user scripts not allowed), such an exec is refused: read `ml.current` in a
 *  read-only exec, and act on the page in the next. */
export interface CurrentSnapshot {
    run: CurrentRun;
    /** The NeutralMessage[] the next model call gets, verbatim: the system prompt first, then every user and assistant
     *  message, tool call and tool result. A COPY, so nothing a script does reaches the loop's. */
    messages: NeutralMessage[];
    /** Parallel to `messages`: same length, same order. */
    meta: MessageMeta[];
    log: CurrentLog;
    /** What the PERSON pointed the model at. Present only where the host adds it (a worker-hosted run). */
    debug?: { userWatches: UserWatch[] };
    /** The environment the run acts in, read now: what you would otherwise learn by trying and reading the refusal.
     *  Present only where the host adds it (a worker-hosted run). */
    env?: CurrentEnv;
}

/** Where an approved `exec` runs: in the page's own world (its scripts share your globals), in an isolated world of its
 *  own (the page's DOM, not its globals; of `ml` only `current` and `dereference`), or not at all. */
export type ExecWhere = "page" | "isolated" | "refused";

/** The environment a run acts in, computed by the same rules the extension applies, at the moment it is read. */
export interface CurrentEnv {
    /** The page the run's tab holds now. `approved`: whether the person allowed this site to use window.ml (site
     *  access, in Settings). Not `ml.config().pageApprovalAllowed`, which is whether the page may answer approval
     *  prompts itself. */
    page: { url: string; approved: boolean };
    /** What the browser offers for running a script in a world of its own: user scripts (the person allowed them for the
     *  extension) and Debugger-based actions (on in Settings, with the debugger permission). Neither means an exec that
     *  needs isolation is refused. */
    isolation: { userScripts: boolean; cdp: boolean };
    /** Where an approved `exec` (one that is not read-only, e.g. it clicks) would run now. It goes by what the script
     *  READS, not by whether it changes the page: one that clicks AND reads `ml.current` is `readsCurrent`.
     *  `readsNeither` reads neither `ml.current` nor a pointer. A read-only survey is none of these: it is read in
     *  place, without the page's world. */
    exec: { readsNeither: ExecWhere; readsCurrent: ExecWhere; readsPointer: ExecWhere };
    /** Whether a read-only `exec` (a survey that changes nothing) runs without asking the person. */
    readonlyAutoApprove: boolean;
}

/** One watch the person shared with the model from the Run state panel ("look at this"): the expression they wrote, and
 *  what it gives over THIS snapshot, re-evaluated for every read (so it is always now; there is no "when pinned"). A JSONPath gives the list of what it matched. `error` instead of `value` when it
 *  failed or its value was too large to hand over. */
export interface UserWatch {
    expression: string;
    /** What the person wrote about WHY they shared it ("is this growing?"), when they wrote anything. Their words, and
     *  often their question: answer it, not just the value (a real model read "is it climbing?" and reported the number). */
    note?: string;
    value?: unknown;
    error?: string;
}

/** A message's stable id. `toolToken` gives the avalanche and the check character; the `:msg` namespace keeps it
 *  from ever equalling a `@tool:` id minted for the same run. */
export const messageId = (runHash: string, index: number): string => toolToken(`${runHash}:msg`, index);

/** Characters of text a message puts in the context: its content and its tool calls as they are sent. */
function textChars(m: NeutralMessage): number {
    let n = typeof m.content === "string" ? m.content.length : 0;
    if (m.tool_calls?.length) n += JSON.stringify(m.tool_calls).length;
    return n;
}

/** The log as lines: ISO time, level, subsystem, kind, reason, then the detail as JSON. Single spaces and no padding, since
 *  a model reads it (AGENTS.md); the order is fixed so `grep` patterns written against it keep working. */
export function logText(records: readonly CurrentLogRecord[]): string {
    return records.map((r) => [
        new Date(r.ts).toISOString().replace(/\.\d{3}Z$/, "Z"), r.level, r.subsystem, r.kind,
        ...(r.reason ? [r.reason] : []), ...(r.detail ? [JSON.stringify(r.detail)] : []),
    ].join(" ")).join("\n");
}

/** Execution-log records as the model reads them in `ml.current.log`, oldest first: never `key`, `tab` or `origin`. Also
 *  what the state inspector shows for `run.log`, so the panel draws the model's view, not a fuller one. */
export function currentLogRecords(log: readonly RunLogEvent[]): CurrentLogRecord[] {
    return log.map((e): CurrentLogRecord => ({
        ts: e.t, level: e.level ?? "info", subsystem: e.subsystem, kind: e.kind, reason: e.reason ?? null,
        detail: e.detail && typeof e.detail === "object" ? structuredClone(e.detail) as Record<string, unknown> : null,
    })).sort((a, b) => a.ts - b.ts);
}

/** Assemble a snapshot. `recorded` may be shorter than `messages` (a host appended outside the loop's pushes), and
 *  each missing entry reads as {@link UNRECORDED}: absent, never invented. */
export function snapshotCurrent(src: {
    run: CurrentRun;
    messages: readonly NeutralMessage[];
    recorded: readonly (RecordedMeta | undefined)[];
    log?: readonly RunLogEvent[];
    now: number;
}): CurrentSnapshot {
    const messages = structuredClone(src.messages) as NeutralMessage[];
    const meta = messages.map((m, i): MessageMeta => {
        const r = src.recorded[i] ?? UNRECORDED;
        const prev = i > 0 ? (src.recorded[i - 1] ?? UNRECORDED).ts : null;
        const counted = r.counted != null && r.counted > 0 ? r.counted : null;
        return {
            id: messageId(src.run.id, i),
            ts: r.ts,
            ageMs: r.ts == null ? null : Math.max(0, src.now - r.ts),
            gapMs: r.ts == null || prev == null ? null : Math.max(0, r.ts - prev),
            surface: m.role === "user" ? r.surface : null,
            ...(counted != null ? { tokens: counted } : { estimatedTokens: Math.ceil(textChars(m) / CHARS_PER_TOKEN) }),
            images: m.images?.length ?? 0,
            step: r.step,
            seq: r.seq,
            tool: r.tool,
            truncated: r.truncated,
        };
    });
    const records = currentLogRecords(src.log ?? []);
    const log = Object.assign(records, { text: logText(records) });
    return { run: { ...src.run }, messages, meta, log };
}

/** The most of `ml.current` an approved `exec` is SENT, as JSON characters. An approved exec runs in a world of its own
 *  (docs/spec/SITE_ACCESS.md, part 4), so the snapshot crosses to the tab with the call; a read-only survey reads it
 *  in place in the worker, with nothing sent, which is where an over-cap context is read instead. */
export const EXEC_CURRENT_CHARS = 500_000;

/** `ml.current` as it crosses to an approved exec: plain JSON. The log's `text` travels beside the records, since a
 *  JSON array keeps no property but its items; {@link currentFromExec} puts it back. */
export interface ExecCurrent {
    current: Omit<CurrentSnapshot, "log"> & { log: CurrentLogRecord[] };
    logText: string;
}

/**
 * What an approved exec is sent for `ml.current` (the site-access work binds it, frozen, in the exec's own world).
 * @param snap the run's snapshot, as the worker made it (shared watches included)
 * @param enabled the run's `selfIntrospection`; off, there is no `ml.current` at all
 * @returns undefined when there is none to send; `error`, the sentence the script is given, when it is over
 *   {@link EXEC_CURRENT_CHARS}; otherwise the value
 */
export function currentForExec(snap: CurrentSnapshot | undefined, enabled: boolean): { value: ExecCurrent } | { error: string } | undefined {
    if (!enabled || !snap) return undefined;
    const value: ExecCurrent = JSON.parse(JSON.stringify({ current: { ...snap, log: [...snap.log] }, logText: snap.log.text }));
    const chars = JSON.stringify(value).length;
    if (chars > EXEC_CURRENT_CHARS)
        return { error: `ml.current is ${chars} characters here, over the ${EXEC_CURRENT_CHARS} an approved exec is sent. Read it in a read-only exec (one that does not touch the page), where it is read in place.` };
    return { value };
}

/**
 * The snapshot back from what {@link currentForExec} sent: `log.text` restored, everything else as it came.
 * @param x what arrived with the call
 */
export function currentFromExec(x: ExecCurrent): CurrentSnapshot {
    return { ...x.current, log: Object.assign([...x.current.log], { text: x.logText }) };
}
