// current-context.ts — what `ml.current` hands a read-only `exec`: the run's own messages, what is known about each,
// and its execution log, as ONE snapshot of plain data (docs/spec/CURRENT_CONTEXT.md).
//
// Pure, and in three parts that never meet at runtime. The agent loop RECORDS what only the moment of appending a
// message knows (when, which step, which tool, typed where, how big by the engine's own count), because nothing can
// reconstruct it afterwards. This module ASSEMBLES a snapshot from those records on request. The dialect READS it.
// Nothing here holds state or touches a page, so the worker and the page share it and it is tested directly.

import type { NeutralMessage } from "./contract/contract-chat";
import type { PromptSurface } from "./contract/contract-run";
import type { RunLogEvent } from "./run-log";
import { toolToken } from "./util";

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

/** How a message's size was arrived at. `counted`: the engine reported it. `estimated`: characters over
 *  {@link CHARS_PER_TOKEN}, which is all there is for every user, system and tool message. A bare number would be
 *  read as counted, and usually is not (the same reason `RunStats.genBasis` exists). */
export type TokensBasis = "counted" | "estimated";

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
    /** The size of this message: what compacting it would reclaim. Text only; see `images`. */
    tokens: number;
    tokensBasis: TokensBasis;
    /** Images the message carries, which `tokens` does NOT include: an image's cost depends on the model, and
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
    /** The run's session hash. */
    id: string;
    model: string | null;
    step: number;
    maxSteps: number;
    startedTs: number;
}

/** One execution-log record as the model reads it. `ts` is the log's `t`, renamed so a time is spelled one way across
 *  `ml.current`. Only the fields a model can act on: never `key`, which the housekeeping log withholds from a page
 *  that did not report the event, nor `tab`/`origin`, which say who REPORTED it. */
export interface CurrentLogRecord {
    ts: number;
    subsystem: string;
    kind: string;
    reason: string | null;
    detail: Record<string, unknown> | null;
}

/** The records, and the same log as greppable lines on `.text`, for `ml.pipe`. One member, two views. */
export type CurrentLog = CurrentLogRecord[] & { text: string };

/** Everything `ml.current` is, at one instant. */
export interface CurrentSnapshot {
    run: CurrentRun;
    /** The NeutralMessage[] the next model call gets, verbatim: a COPY, so nothing a script does reaches the loop's. */
    messages: NeutralMessage[];
    /** Parallel to `messages`: same length, same order. */
    meta: MessageMeta[];
    log: CurrentLog;
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

/** The log as lines: ISO time, subsystem, kind, reason, then the detail as JSON. Single spaces and no padding, since
 *  a model reads it (AGENTS.md); the order is fixed so `grep` patterns written against it keep working. */
export function logText(records: readonly CurrentLogRecord[]): string {
    return records.map((r) => [
        new Date(r.ts).toISOString().replace(/\.\d{3}Z$/, "Z"), r.subsystem, r.kind,
        ...(r.reason ? [r.reason] : []), ...(r.detail ? [JSON.stringify(r.detail)] : []),
    ].join(" ")).join("\n");
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
            tokens: counted ?? Math.ceil(textChars(m) / CHARS_PER_TOKEN),
            tokensBasis: counted != null ? "counted" : "estimated",
            images: m.images?.length ?? 0,
            step: r.step,
            seq: r.seq,
            tool: r.tool,
            truncated: r.truncated,
        };
    });
    const records = (src.log ?? []).map((e): CurrentLogRecord => ({
        ts: e.t, subsystem: e.subsystem, kind: e.kind, reason: e.reason ?? null,
        detail: e.detail && typeof e.detail === "object" ? structuredClone(e.detail) as Record<string, unknown> : null,
    })).sort((a, b) => a.ts - b.ts);
    const log = Object.assign(records, { text: logText(records) });
    return { run: { ...src.run }, messages, meta, log };
}
