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
import { sanitizeCellFacts, type CellFacts } from "../agent/cell-facts";

/** One thing the machinery did on a run's behalf. A housekeeping event plus WHOSE run it was, since the whole
 *  point is reading one run's mechanics beside its steps. `subsystem` and `kind` are open by intent, exactly as
 *  they are there: a new mechanism adds its own rather than extending an enum every consumer generated from. */
export interface RunLogEvent extends Omit<HousekeepingEvent, "detail"> {
    /** The run's id, which is its session hash (`runId: runHash`, ml-agent-run.ts). */
    run: string;
    /** Anything else: flat, as in the housekeeping log, except on `cell`/`facts` ({@link CellFactsDetail}). */
    detail?: RunLogDetail;
}

/** The ONE nested `detail`: subsystem `cell`, kind `facts` (docs/spec/CELL_FACTS.md, Half 1). `seq` is the step it
 *  describes; `cell` is what {@link sanitizeCellFacts} returned. Validated by enumeration, never passed through. */
export interface CellFactsDetail {
    seq: number;
    cell: CellFacts;
}

/** A record's `detail`: flat for every kind but `cell`/`facts`. */
export type RunLogDetail = Record<string, string | number | boolean> | CellFactsDetail;

/** True for the one record whose `detail` is nested: subsystem `cell`, kind `facts`. */
export const isCellFactsRecord = (e: { subsystem: string; kind: string }): boolean => e.subsystem === "cell" && e.kind === "facts";

/** A record's `detail` when it is the flat kind, else undefined: what every reader that prints `k=v` or reads one
 *  key (`tab`) uses, so the nested `cell` is handled in one place. */
export function flatDetail(e: { detail?: RunLogDetail }): Record<string, string | number | boolean> | undefined {
    const d = e.detail;
    if (!d || !Object.values(d).every((v) => typeof v !== "object")) return undefined;
    return d as Record<string, string | number | boolean>;
}

// WHICH TAB A RECORD IS ABOUT GOES IN `detail.tab`, never the event's own `tab`: that field means the tab that
// REPORTED an event, which for a worker record is nobody, and the shared renderer prints it as part of "who said
// this". Here the tab is the subject — the one that was discarded, pinned, attached to — so it is detail.
//
// The subsystems and kinds in use today. Both are open by intent, so this is a map rather than a contract:
//   page  held (reason: navigating) · discarded · reloaded (reason: gone) · recovered · unreachable (reason: asleep|gone|crashed|busy|silent|unadopted) · no-commit (reason: navigate)
//         answer-capped (reason: rows|columns|cell|cell-type|text|image|result): a page's answer cut to pageRead's caps
//   cdp   attached (reason: already) · refused (reason: permission|busy) · detached
//   tab   pinned (reason: hosting) · released · replaced
//   cell  facts: one per exec/python_exec cell, detail `{ seq, cell }` (nested; docs/spec/CELL_FACTS.md); never model-facing
//
// Levels: `warn` for a page discarded (and then reloaded); `error` for a page unreachable, a reload that failed
// (`gone`) and a CDP refusal, since the tool fails on each. Everything else is `info`, which goes unwritten.

/** What a reporter may say about a run. `t` and `origin` are the worker's to set, as in the housekeeping log. */
export type RunLogReport = Omit<HousekeepingReport, "detail"> & { run: string; detail?: RunLogDetail };

/** What a worker-side emitter may say: {@link RunLogReport} without the `run`, which the log is given beside it. */
export type RunLogBody = Omit<RunLogReport, "run">;

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
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    // The ONE nested detail, validated by enumeration (CELL_FACTS.md): exactly `seq` and `cell`, `cell` rebuilt by
    // sanitizeCellFacts. Anything else DROPS THE RECORD, so a reader never meets a shape it does not know.
    if (r.subsystem === "cell" && r.kind === "facts") {
        const d = r.detail as Record<string, unknown> | null | undefined;
        if (!d || typeof d !== "object" || Array.isArray(d)) return null;
        const keys = Object.keys(d);
        if (keys.length !== 2 || !keys.includes("seq") || !keys.includes("cell")) return null;
        if (typeof d.seq !== "number" || !Number.isInteger(d.seq) || d.seq < 0) return null;
        const cell = sanitizeCellFacts(d.cell);
        if (!cell) return null;
        const head = sanitizeReport({ ...r, detail: undefined });
        const run = r.run;
        if (!head || typeof run !== "string" || !HASH_RE.test(run)) return null;
        return { ...head, run, detail: { seq: d.seq, cell } };
    }
    const clean = sanitizeReport(raw);
    if (!clean) return null;
    const run = r.run;
    if (typeof run !== "string" || !HASH_RE.test(run)) return null;
    return { ...clean, run };
}

/** A run's cell facts records kept, apart from its mechanics (`PER_RUN_CAP`): one record per cell, so a long run's cells
 *  would otherwise push out the page, CDP and tab records that say what happened under it, and the reverse. */
export const PER_RUN_CELL_CAP = 200;
/** Cell facts records kept across every run, apart from `RUN_LOG_CAP`, so one run's cells never evict another run's
 *  mechanics. Fewer than the mechanics' cap because a record may be up to ~4 KB (CELL_CHARS_MAX): at most ~4 MB of the
 *  10 MB `storage.session` quota, beside the mechanics' ~400 KB. */
export const CELL_LOG_CAP = 1000;

/** Drops the oldest records of one class until each run has at most `perRun` and the ring at most `total` of it. */
function trimClass(records: RunLogEvent[], ofClass: (r: RunLogEvent) => boolean, perRun: number, total: number): RunLogEvent[] {
    const counts = new Map<string, number>();
    let all = 0;
    for (const r of records) if (ofClass(r)) { counts.set(r.run, (counts.get(r.run) || 0) + 1); all++; }
    const excess = new Map<string, number>();
    for (const [run, n] of counts) if (n > perRun) { excess.set(run, n - perRun); all -= n - perRun; }
    let over = Math.max(0, all - total);
    if (!excess.size && !over) return records;
    return records.filter((r) => {
        if (!ofClass(r)) return true;
        const left = excess.get(r.run) || 0;
        if (left > 0) { excess.set(r.run, left - 1); return false; }
        if (over > 0) { over--; return false; }
        return true;
    });
}

/** Trims a ring to `RUN_LOG_CAP` mechanics records and `PER_RUN_CAP` per run, and apart from those to `CELL_LOG_CAP` cell
 *  facts records and `PER_RUN_CELL_CAP` per run, dropping the oldest of each: neither class evicts the other. */
export function trimRunRing(records: RunLogEvent[]): RunLogEvent[] {
    const cells = trimClass(records, isCellFactsRecord, PER_RUN_CELL_CAP, CELL_LOG_CAP);
    return trimClass(cells, (r) => !isCellFactsRecord(r), PER_RUN_CAP, RUN_LOG_CAP);
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
export function filterRunLog<T extends { level?: LogLevel; subsystem: string; kind: string; reason?: string; key?: string; detail?: RunLogDetail }>(records: readonly T[], f: RunLogFilter): T[] {
    const least = LOG_LEVELS.indexOf(f.minLevel ?? "info");
    const needle = (f.text ?? "").trim().toLowerCase();
    return records.filter((r) => {
        if (LOG_LEVELS.indexOf(levelOf(r)) < least) return false;
        if (!needle) return true;
        const hay = [levelOf(r), r.subsystem, r.kind, r.reason ?? "", r.key ?? "",
            ...Object.entries(r.detail ?? {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)].join(" ").toLowerCase();
        return hay.includes(needle);
    });
}

/** How many records sit at each level or above, for the menu's level choices: `[info, warn, error]` order. */
export function levelCounts(records: readonly { level?: LogLevel }[]): Record<LogLevel, number> {
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
    record(run: string, report: RunLogBody): void {
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
