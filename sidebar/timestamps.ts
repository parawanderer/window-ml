// Per-line PRODUCED-AT timestamps for streamed tool output. Pure (no preact, no DOM) so both the sidebar's
// gutter (render-panel.tsx) and the static export (export.ts) read the SAME mapping — and so it can be
// unit-tested without mounting anything.
//
// The marks come from the EXECUTOR, never from the UI: `ctx.stream(text, ts?)` lets a tool stamp the instant
// its output actually happened (python stamps in the Pyodide worker; a future remote bash tool would stamp on
// its own server), and the loop's fan records `[offsetInTheAccumulatedText, epochMs]`. The UI only decides
// whether to SHOW them.
import { signal } from "@preact/signals";

/** Wall-clock for one streamed line, from the marks the EXECUTOR supplied. Pure so the mapping (a line takes
 *  the time of the last mark at or before its offset) is unit-testable without a DOM. Returns null when no mark
 *  covers the offset — we never invent a time. */
export function timeForOffset(marks: [number, number][] | undefined, offset: number): number | null {
    if (!marks || !marks.length) return null;
    let ts: number | null = null;
    for (const [at, t] of marks) { if (at <= offset) ts = t; else break; }
    return ts;
}

/** Guard against timing text the marks don't describe. The settled Out renders the SAME captured output the
 *  stream produced (both keep the head under one cap), so offsets carry over — but if a tool ever post-processes
 *  its output, a stale mark would time the wrong line. Cheap check: drop the marks unless they fit the text. */
export function alignedMarks(marks: [number, number][] | undefined, text?: string): [number, number][] | undefined {
    if (!marks?.length || typeof text !== "string") return undefined;
    return marks[marks.length - 1][0] <= text.length ? marks : undefined;
}

export const hhmmss = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);
// Full precision for the hover — the gutter stays hh:mm:ss (narrow, scannable) but the underlying marks are
// epoch MILLISECONDS, so the tooltip can show the exact instant and a meaningful gap.
export const hhmmssms = (ts: number): string => `${hhmmss(ts)}.${String(new Date(ts).getMilliseconds()).padStart(3, "0")}`;
// A timestamp's LOCAL hour bucket (date + hour), so "same hour" is exact across midnight and half-hour zones.
const hourKey = (ts: number): string => { const d = new Date(ts); return `${d.toDateString()} ${d.getHours()}`; };

/** Drop the HOUR from the gutter? Only when EVERY mark falls in the hour we're in right now — then "14:" is
 *  noise you can infer from context. A run that spans an hour boundary, or one you're reading back later,
 *  keeps the full clock so it can never be misread. The hover always carries the full time either way. */
export function elideHour(marks: [number, number][] | undefined, now: number = Date.now()): boolean {
    if (!marks?.length) return false;
    const k = hourKey(now);
    return marks.every(([, t]) => hourKey(t) === k);
}

/** Human gap between two marks: sub-second stays in ms (that's the resolution that matters for a fast loop). */
export const fmtDelta = (ms: number): string =>
    ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

// --- the hour roll-over ------------------------------------------------------------------------------------
// `elideHour` is answered at RENDER time, so on its own a cell that stops re-rendering keeps its mm:ss gutter
// into the next hour — a long agent session is exactly where that misleads. This is the "now" every gutter
// reads: a signal, so ONE timer re-renders all of them at the boundary instead of each cell owning an interval.
export const hourNow = signal(Date.now());
let hourTimer: ReturnType<typeof setTimeout> | null = null;

/** Arm the roll-over. Called while rendering any timestamped output; idempotent, and it re-arms only from the
 *  next render — so once nothing timestamped is on screen, no timer is left running. */
export function armHourTick(now: number = Date.now()): void {
    if (hourTimer != null) return;
    const next = new Date(now);
    next.setMinutes(60, 0, 0);                      // the top of the next hour, local
    const t = setTimeout(() => { hourTimer = null; hourNow.value = Date.now(); }, Math.max(1000, next.getTime() - now));
    // Node only: a pending hour-long timer would hold the test runner's event loop open (browsers have no unref).
    (t as unknown as { unref?: () => void }).unref?.();
    hourTimer = t;
}

/** Cancel a pending roll-over — for tests, and for a surface being torn down. */
export function stopHourTick(): void {
    if (hourTimer != null) { clearTimeout(hourTimer); hourTimer = null; }
}

/** The output with a produced-at gutter, as PLAIN TEXT — for the exports, which have no way to make a column
 *  unselectable the way the sidebar does. Repeats are blanked, exactly like the gutter. Returns null when the
 *  marks don't describe this text, so a caller can fall back to the untimed output. */
export function timedText(text: string, marks: [number, number][] | undefined, now: number = Date.now()): string | null {
    const m = alignedMarks(marks, text);
    if (!m) return null;
    const short = elideHour(m, now);
    const width = short ? 5 : 8;
    let off = 0, shown = "";
    return text.split("\n").map((line) => {
        const ts = timeForOffset(m, off);
        off += line.length + 1;
        let label = ts == null ? "" : (short ? hhmmss(ts).slice(3) : hhmmss(ts));
        if (label && label === shown) label = ""; else if (label) shown = label;
        return `${label.padStart(width)}  ${line}`;
    }).join("\n");
}
