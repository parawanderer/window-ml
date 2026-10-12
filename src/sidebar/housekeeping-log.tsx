// housekeeping-log.tsx — the housekeeping log (docs/dev/housekeeping.md) as a panel section: what the system
// decided on its own, one line per event, in the same OUTPUT CELL a tool's stdout renders into. Reused rather
// than built as a list because a log IS output: the cell already gives it a timestamp gutter, find (Ctrl+F),
// a resize grip and tail-follow, and a second list component would have grown half of those, differently.
//
// Above the log, the Background work section: what each self-acting job (job-registry.ts) is doing NOW, which the
// log, a record of what happened, cannot say.
import { useEffect, useState } from "preact/hooks";
import { OutputCell, TimedOutput } from "./transcript/render-panel";
import { downloadBlob } from "./export/download";
import { formatBytes } from "../resource/resource-model";
import { fmtAge, fmtDelta, fmtDur } from "./timestamps";
import { Disclosure } from "./disclosure";
import { LOG_CAP, LOG_KEY, type HousekeepingEvent } from "../log/housekeeping";
import type { JobStatus } from "../job-registry";

/** A log rendered as text: the lines, the produced-at marks the timestamp gutter is drawn from, and — for a
 *  surface that wants it — which GROUP each line belongs to and how wide that column is. The last two are extra,
 *  not a change: a caller that ignores them gets exactly the log it got before. */
export interface LogText {
    text: string;
    marks: [number, number][];
    /** The subsystem each rendered line came from, one per line, in the same order. */
    groups: string[];
    /** How many characters the subsystem column was padded to, so a renderer can find it in the line. */
    headWidth: number;
}

/**
 * The events as log TEXT plus the produced-at marks `TimedOutput` draws its gutter from — oldest first, so the
 * cell's tail-follow keeps the newest in view. Subsystems in `hidden` are left out. Aligned for a human reader
 * (this never reaches a model). Anything not reported by the worker itself says who reported it, since a page
 * can write here and nothing it wrote should read as the worker's own account.
 *
 * `omit` drops `detail` keys from the LINE only — never from the records, which is what the download carries.
 * It exists because a key that is the same on every record in view is width spent saying nothing, and in a
 * narrow panel that width is what makes a one-record line wrap into two (the execution log's `tab`).
 */
export function housekeepingText(events: HousekeepingEvent[], hidden: ReadonlySet<string> = new Set(), omit: ReadonlySet<string> = new Set()): LogText {
    const shown = events.filter((e) => !hidden.has(e.subsystem));
    const width = Math.max(0, ...shown.map((e) => e.subsystem.length));
    const lines: string[] = [];
    const marks: [number, number][] = [];
    const groups: string[] = [];
    let offset = 0;
    for (const e of shown) {
        const parts = [e.subsystem.padEnd(width), e.reason ? `${e.kind} (${e.reason})` : e.kind];
        // Only the levels that are NOT routine say so, in capitals, ahead of what happened: an `info` tag on every
        // line would be width spent on the case nobody is scanning for.
        if (e.level === "warn" || e.level === "error") parts.splice(1, 0, e.level.toUpperCase());
        if (e.ms != null) parts.push(fmtDelta(e.ms));
        if (e.bytes != null) parts.push(formatBytes(e.bytes));
        if (e.key) parts.push(e.key);
        for (const [k, v] of Object.entries(e.detail || {})) if (!omit.has(k)) parts.push(`${k}=${v}`);
        if (e.origin !== "worker") parts.push(`[${e.origin}${e.tab != null ? ` tab ${e.tab}` : ""}]`);
        const line = parts.join("  ");
        marks.push([offset, e.t]);
        lines.push(line);
        groups.push(e.subsystem);
        offset += line.length + 1;
    }
    return { text: lines.join("\n"), marks, groups, headWidth: width };
}

/** Each subsystem with how many events it has, in order of first appearance — the filter chips' labels. */
export function subsystemCounts(events: HousekeepingEvent[]): [string, number][] {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.subsystem, (counts.get(e.subsystem) || 0) + 1);
    return [...counts];
}

/**
 * The HOUSEKEEPING LOG view (header ⋮ → Housekeeping log): evictions, sweeps, service-worker restarts, Python
 * cold starts and pre-warms. Read on mount — the first read goes through the worker (which flushes what it has
 * buffered), after that `storage.session` changes push the ring straight in. The output cell FILLS the view, so
 * the log gets the panel's height rather than a capped box in the middle of it.
 */
export function HousekeepingView() {
    const [events, setEvents] = useState<HousekeepingEvent[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hidden, setHidden] = useState<Set<string>>(new Set());

    useEffect(() => {
        let live = true;
        chrome.runtime.sendMessage({ type: "DUMP_HOUSEKEEPING", payload: {} }, (r: { data?: HousekeepingEvent[]; error?: string } | undefined) => {
            if (!live) return;
            if (!r) setError(chrome.runtime.lastError?.message || "no answer from the service worker");
            else if (r.error) setError(r.error);
            else setEvents(r.data || []);
        });
        const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "session" && changes[LOG_KEY] && Array.isArray(changes[LOG_KEY].newValue)) setEvents(changes[LOG_KEY].newValue as HousekeepingEvent[]);
        };
        chrome.storage.onChanged.addListener(onChanged);
        return () => { live = false; chrome.storage.onChanged.removeListener(onChanged); };
    }, []);

    const all = events || [];
    const counts = subsystemCounts(all);
    const { text, marks } = housekeepingText(all, hidden);
    const cleared = all.length === 1 && all[0].subsystem === "log" && all[0].kind === "clear";
    const toggle = (s: string) => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; });
    // The worker owns the ring; the cleared ring (one `log/clear` marker) arrives through storage.onChanged.
    const clear = () => chrome.runtime.sendMessage({ type: "DUMP_HOUSEKEEPING", payload: { clear: true } }, () => { void chrome.runtime.lastError; });
    const download = () => downloadBlob(`ml-housekeeping-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        new Blob([JSON.stringify(all, null, 1)], { type: "application/json" }));

    return (
        <div class="hk-view">
            <div class="hk-bar">
                {counts.length > 1 ? (
                    <div class="rc-lane-filter">
                        {counts.map(([s, n]) => (
                            <button class={`rc-lane-chip${hidden.has(s) ? " off" : ""}`} key={s} aria-pressed={!hidden.has(s)}
                                aria-label={hidden.has(s) ? `Show ${s}` : `Hide ${s}`} onClick={() => toggle(s)}>{s} {n}</button>
                        ))}
                    </div>
                ) : null}
                <span class="hk-count">{error ? "unavailable" : events == null ? "loading…" : `${all.length} event${all.length === 1 ? "" : "s"}`}</span>
                <span class="sp" />
                <button class="raw-btn" onClick={download} disabled={!all.length}>download</button>
                <button class="raw-btn" onClick={clear} disabled={!all.length || cleared}>clear</button>
            </div>
            <div class="hint hk-about">
                What the extension decided on its own: cache evictions, service-worker restarts (inferred when the next
                one starts), Python cold starts and pre-warms. The last {LOG_CAP.toLocaleString()} events, cleared when
                the browser restarts. <code>[page]</code> lines were reported by a web page. Same data:{" "}
                <code>ml.__housekeeping()</code>.
            </div>
            <BackgroundWork events={all} />
            {error ? <div class="hint err">could not read the log: {error}</div>
                : events == null ? null
                    : !text ? <div class="hint">{all.length ? "Every subsystem is filtered out." : "Nothing recorded since the browser started."}</div>
                        : <OutputCell text fill><TimedOutput text={text} marks={marks} /></OutputCell>}
        </div>
    );
}

/** How often the section re-reads while it is open, so a countdown and a running pass stay current between records. */
const JOBS_POLL_MS = 5_000;

/** The header line of one job: its state in words, and what waits for it. */
export function jobStateText(j: JobStatus, now: number): string {
    const waiting = j.pending ? `${j.pending} ${j.pendingLabel || "waiting"}` : "";
    const due = j.nextDue != null ? (j.nextDue > now ? `next in ${fmtAge(j.nextDue - now)}` : "due now") : "";
    const head = j.state === "running" ? "running"
        : j.state === "interrupted" ? `interrupted${j.interruptedAt != null ? ` ${fmtAge(now - j.interruptedAt)} ago` : ""}, resumes on its own`
            : j.state === "failed" ? "last run failed"
                : j.state === "waiting" ? "waiting" : "idle";
    return [head, waiting, j.state !== "running" ? due : ""].filter(Boolean).join(" · ");
}

/** The last run in words: when, and what it did. */
export function lastRunText(j: JobStatus, now: number): string {
    const r = j.lastRun;
    if (!r) return "No run recorded since the browser started.";
    const what = [r.ok ? "finished" : `failed (${r.kind})`, `${fmtAge(now - r.t)} ago`];
    if (r.ms != null) what.push(`took ${fmtDur(r.ms)}`);
    if (r.bytes != null && r.ok) what.push(`freed ${formatBytes(r.bytes)}`);
    if (!r.ok && typeof r.detail?.error === "string") what.push(r.detail.error);
    return `Last run ${what.join(", ")}.`;
}

/**
 * THE BACKGROUND WORK SECTION: every declared job's state, pending work, last run and next start, each opening onto its
 * own housekeeping records. Read through DUMP_JOBS when the log changes and every few seconds while shown.
 * @gallery none needs the service worker's DUMP_JOBS answer; tests/background-work.test.mjs renders it with one
 */
export function BackgroundWork({ events }: { events: HousekeepingEvent[] }) {
    const [jobs, setJobs] = useState<JobStatus[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        let live = true;
        const read = () => chrome.runtime.sendMessage({ type: "DUMP_JOBS", payload: {} }, (r: { data?: JobStatus[]; error?: string } | undefined) => {
            if (!live) return;
            setNow(Date.now());
            if (!r) setError(chrome.runtime.lastError?.message || "no answer from the service worker");
            else if (r.error) setError(r.error);
            else { setError(null); setJobs(r.data || []); }
        });
        read();
        const t = setInterval(read, JOBS_POLL_MS);
        return () => { live = false; clearInterval(t); };
    }, [events]);

    if (error) return <div class="hint err">could not read background jobs: {error}</div>;
    if (!jobs?.length) return null;
    return (
        <section class="bgw" aria-label="Background work">
            <div class="bgw-title">Background work</div>
            {jobs.map((j) => {
                const mine = events.filter((e) => e.subsystem === j.subsystem && j.kinds.includes(e.kind));
                const { text, marks } = housekeepingText(mine);
                return (
                    <Disclosure key={j.id} label={<span>{j.title}</span>}
                        note={<span class={`bgw-state ${j.state}`}>{jobStateText(j, now)}</span>}>
                        <div class="bgw-body">
                            <div class="hint">Runs {j.trigger}. {lastRunText(j, now)}{j.error ? ` Its live status could not be read: ${j.error}` : ""}</div>
                            {text ? <OutputCell text><TimedOutput text={text} marks={marks} /></OutputCell> : null}
                        </div>
                    </Disclosure>
                );
            })}
        </section>
    );
}
