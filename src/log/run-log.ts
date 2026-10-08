// run-log.ts — WHAT THE MACHINERY DID while a run ran: the mechanics a transcript never shows.
//
// A run's steps say what the model asked for and what came back. They say nothing about the work underneath —
// that the tab was asleep and had to be reloaded, that a CDP attach was refused because the setting is off, that
// a tab came back under a new id. Those happen today and are invisible: a measured run spent 13m57s inside one
// `pageInfo` with nothing anywhere saying why. This is where that goes.
//
// IT IS NOT THE HOUSEKEEPING LOG (housekeeping.ts, docs/spec/HOUSEKEEPING_LOG.md), whose scope rule is "only
// decisions the system made ON ITS OWN" and explicitly excludes "anything a user or model action caused
// directly". A CDP attach is caused by a tool call, so it belongs here rather than stretching that scope — and
// keeping the two apart is the only thing stopping either from becoming a second, noisier debug stream.
//
// It REUSES that log's record shape (plus a `run`) and its sanitizer, so one renderer draws both, and the
// ring itself (storage-ring.ts), so there is one serialized write rather than two.
import { sanitizeReport, levelOf, LOG_LEVELS, type HousekeepingEvent, type HousekeepingReport, type LogLevel } from "./housekeeping";
import { HASH_RE } from "../contract/contract-run";
import { StorageRing, type SessionArea } from "./storage-ring";

/** One thing the machinery did on a run's behalf. A housekeeping event plus WHOSE run it was, since the whole
 *  point is reading one run's mechanics beside its steps. `subsystem` and `kind` are open by intent, exactly as
 *  they are there: a new mechanism adds its own rather than extending an enum every consumer generated from. */
export interface RunLogEvent extends HousekeepingEvent {
    /** The run's id, which is its session hash (`runId: runHash`, ml-agent-run.ts). */
    run: string;
}

// WHICH TAB A RECORD IS ABOUT GOES IN `detail.tab`, never the event's own `tab`: that field means the tab that
// REPORTED an event, which for a worker record is nobody, and the shared renderer prints it as part of "who said
// this". Here the tab is the subject — the one that was discarded, pinned, attached to — so it is detail.
//
// The subsystems and kinds in use today. Both are open by intent, so this is a map rather than a contract:
//   page  held (reason: navigating) · discarded · reloaded (reason: gone) · recovered · unreachable (reason: asleep|gone|silent)
//   cdp   attached (reason: already) · refused (reason: permission|busy) · detached
//   tab   pinned (reason: hosting) · released · replaced
//
// Levels: `warn` for a page discarded (and then reloaded); `error` for a page unreachable, a reload that failed
// (`gone`) and a CDP refusal, since the tool fails on each. Everything else is `info`, which goes unwritten.

/** What a reporter may say about a run. `t` and `origin` are the worker's to set, as in the housekeeping log. */
export type RunLogReport = HousekeepingReport & { run: string };

/** The one `chrome.storage.session` key the whole log lives under — every run's records in one ring, so a run
 *  that has ended is still readable and a run's key cannot be guessed at from outside. */
export const RUN_LOG_KEY = "ml_run_log";
/** Records kept across every run, oldest dropped. A few hundred bytes each, so ~400 KB of a 10 MB quota. */
export const RUN_LOG_CAP = 2000;
/** Records kept for ONE run, oldest of that run dropped first — so a run that watched a sleeping tab for four
 *  minutes cannot push every other run's mechanics out of the ring. */
export const PER_RUN_CAP = 200;

/**
 * A reported record made safe to store, or null when it is not one: the housekeeping log's own rules (lowercase
 * slug names, finite non-negative numbers, capped strings, flat `detail`) plus a `run` that is a session hash.
 *
 * Every emitter is inside the worker today, so this is about keeping the record well formed rather than about an
 * untrusted reporter — but a page knows mechanics the worker does not (an `exec` that fell back to CDP), so the
 * boundary is written before anything needs it.
 */
export function sanitizeRunReport(raw: unknown): RunLogReport | null {
    const clean = sanitizeReport(raw);
    if (!clean) return null;
    const run = (raw as { run?: unknown }).run;
    if (typeof run !== "string" || !HASH_RE.test(run)) return null;
    return { ...clean, run };
}

/** Trims a ring to `RUN_LOG_CAP` records and `PER_RUN_CAP` per run, dropping the oldest of each. */
export function trimRunRing(records: RunLogEvent[]): RunLogEvent[] {
    const counts = new Map<string, number>();
    for (const r of records) counts.set(r.run, (counts.get(r.run) || 0) + 1);
    const excess = new Map<string, number>();
    for (const [run, n] of counts) if (n > PER_RUN_CAP) excess.set(run, n - PER_RUN_CAP);
    const kept = excess.size
        ? records.filter((r) => {
            const left = excess.get(r.run) || 0;
            if (left <= 0) return true;
            excess.set(r.run, left - 1);
            return false;
        })
        : records;
    return kept.length > RUN_LOG_CAP ? kept.slice(kept.length - RUN_LOG_CAP) : kept;
}

/** One run's records, oldest first. The ring holds every run's, because the mechanics of a run that has already
 *  ended are exactly what someone comes looking for. */
export function eventsForRun(records: readonly RunLogEvent[], run: string): RunLogEvent[] {
    return records.filter((r) => r.run === run);
}

/** Each run with how many records it has, newest run first — what a panel offers when the open session is not
 *  the run someone is asking about. */
export function runsInLog(records: readonly RunLogEvent[]): { run: string; count: number; last: number }[] {
    const by = new Map<string, { run: string; count: number; last: number }>();
    for (const r of records) {
        const got = by.get(r.run);
        if (got) { got.count++; got.last = Math.max(got.last, r.t); }
        else by.set(r.run, { run: r.run, count: 1, last: r.t });
    }
    return [...by.values()].sort((a, b) => b.last - a.last);
}

/** What the panel narrows the log to: a least level, and text that must appear somewhere in the record. */
export interface RunLogFilter {
    minLevel?: LogLevel;
    text?: string;
}

/**
 * The records a filter keeps, in order. The text is matched case-insensitively against every field a line prints
 * (level, subsystem, kind, reason, key, and each detail as `k=v`), so a search for `tab=12` or `python_exec` finds
 * what the reader sees, not only what one field holds.
 */
export function filterRunLog<T extends HousekeepingEvent>(records: readonly T[], f: RunLogFilter): T[] {
    const least = LOG_LEVELS.indexOf(f.minLevel ?? "info");
    const needle = (f.text ?? "").trim().toLowerCase();
    return records.filter((r) => {
        if (LOG_LEVELS.indexOf(levelOf(r)) < least) return false;
        if (!needle) return true;
        const hay = [levelOf(r), r.subsystem, r.kind, r.reason ?? "", r.key ?? "",
            ...Object.entries(r.detail ?? {}).map(([k, v]) => `${k}=${v}`)].join(" ").toLowerCase();
        return hay.includes(needle);
    });
}

/** How many records sit at each level or above, for the menu's level choices: `[info, warn, error]` order. */
export function levelCounts(records: readonly HousekeepingEvent[]): Record<LogLevel, number> {
    const out: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const r of records) for (const l of LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(levelOf(r)) + 1)) out[l]++;
    return out;
}

/**
 * The version of the EXPORT DOCUMENT below, not of the records. Additive changes are free — a new `subsystem`,
 * a new `kind`, a new `detail` key — because both are open by intent and a consumer that fails on one would
 * break the day any new mechanism reports. It moves only when a field that was there changes meaning or goes.
 */
export const RUN_LOG_SCHEMA_VERSION = 1;

/**
 * One run's mechanics as a FILE, which is what the panel's download writes. A bare array was the obvious thing
 * and is the wrong one: it carries no version, nothing saying which run it is of, and nothing saying when it was
 * taken — all three of which a file read six months later needs and a panel does not.
 *
 * Normative shape, published as `docs/spec/run-log.schema.json` (generated from here; see scripts/gen-export-schema.mjs).
 */
export interface RunLogDocument {
    schemaVersion: number;
    /** When this was exported, ISO 8601. */
    exportedAt: string;
    /** The run it is of — absent when the whole ring was exported rather than one run's records. */
    run?: string;
    records: RunLogEvent[];
}

/** The records as the published document. Pure, so the shape is tested without a panel around it. */
export function runLogDocument(records: readonly RunLogEvent[], run?: string | null, now: number = Date.now()): RunLogDocument {
    return {
        schemaVersion: RUN_LOG_SCHEMA_VERSION,
        exportedAt: new Date(now).toISOString(),
        ...(run ? { run } : {}),
        records: [...records],
    };
}

/** The service worker's execution log: one ring over every run's mechanics, written in batches. */
export class RunLog extends StorageRing<RunLogEvent> {
    constructor(area: SessionArea, now: () => number = Date.now) {
        super(area, RUN_LOG_KEY, trimRunRing, now);
    }

    /** Records something the machinery did on this run's behalf. Silently drops a malformed record: a log line
     *  is never worth failing the run that was being logged. */
    record(run: string, report: HousekeepingReport): void {
        const clean = sanitizeRunReport({ ...report, run });
        if (clean) this.push({ ...clean, t: this.now(), origin: "worker" });
    }

    /** One run's records, oldest first. */
    async forRun(run: string): Promise<RunLogEvent[]> {
        return eventsForRun(await this.all(), run);
    }

    /** Forgets one run's records, or every run's. Unlike the housekeeping log this leaves no marker: a run's log
     *  is read beside that run, and a cleared one reads as "nothing happened underneath", which is the truth
     *  about the machinery from here on. */
    async clear(run?: string): Promise<void> {
        const kept = run ? (await this.all()).filter((r) => r.run !== run) : [];
        await this.replace(kept);
    }
}

/** WHAT THE EXECUTION LOG PANEL IS, in one sentence, for the tooltip on its tab. It was a paragraph sitting on
 *  top of the records until the panel gave its width back to them. Here rather than in the view beside it,
 *  because the page that draws the tab may not import a module that touches `chrome` — and the only reason that
 *  did not already break the web build is that esbuild happened to shake the rest of the view out. */
export const RUN_LOG_ABOUT = "What the machinery did under this run, which its steps cannot say: a tab the browser discarded and we reloaded, a debugger attach that was refused. Kept until the browser restarts.";
