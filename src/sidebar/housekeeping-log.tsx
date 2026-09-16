// housekeeping-log.tsx — the housekeeping log (docs/dev/housekeeping.md) as a panel section: what the system
// decided on its own, one line per event, in the same OUTPUT CELL a tool's stdout renders into. Reused rather
// than built as a list because a log IS output: the cell already gives it a timestamp gutter, find (Ctrl+F),
// a resize grip and tail-follow, and a second list component would have grown half of those, differently.
import { useEffect, useState } from "preact/hooks";
import { OutputCell, TimedOutput } from "./render-panel";
import { downloadBlob } from "./download";
import { formatBytes } from "../resource-model";
import { fmtDelta } from "./timestamps";
import { LOG_CAP, LOG_KEY, type HousekeepingEvent } from "../housekeeping";

/**
 * The events as log TEXT plus the produced-at marks `TimedOutput` draws its gutter from — oldest first, so the
 * cell's tail-follow keeps the newest in view. Subsystems in `hidden` are left out. Aligned for a human reader
 * (this never reaches a model). Anything not reported by the worker itself says who reported it, since a page
 * can write here and nothing it wrote should read as the worker's own account.
 */
export function housekeepingText(events: HousekeepingEvent[], hidden: ReadonlySet<string> = new Set()): { text: string; marks: [number, number][] } {
    const shown = events.filter((e) => !hidden.has(e.subsystem));
    const width = Math.max(0, ...shown.map((e) => e.subsystem.length));
    const lines: string[] = [];
    const marks: [number, number][] = [];
    let offset = 0;
    for (const e of shown) {
        const parts = [e.subsystem.padEnd(width), e.reason ? `${e.kind} (${e.reason})` : e.kind];
        if (e.ms != null) parts.push(fmtDelta(e.ms));
        if (e.bytes != null) parts.push(formatBytes(e.bytes));
        if (e.key) parts.push(e.key);
        for (const [k, v] of Object.entries(e.detail || {})) parts.push(`${k}=${v}`);
        if (e.origin !== "worker") parts.push(`[${e.origin}${e.tab != null ? ` tab ${e.tab}` : ""}]`);
        const line = parts.join("  ");
        marks.push([offset, e.t]);
        lines.push(line);
        offset += line.length + 1;
    }
    return { text: lines.join("\n"), marks };
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
            {error ? <div class="hint err">could not read the log: {error}</div>
                : events == null ? null
                    : !text ? <div class="hint">{all.length ? "Every subsystem is filtered out." : "Nothing recorded since the browser started."}</div>
                        : <OutputCell text fill><TimedOutput text={text} marks={marks} /></OutputCell>}
        </div>
    );
}
