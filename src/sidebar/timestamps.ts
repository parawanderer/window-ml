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

/** `14:03:07` — a wall-clock time, no date. */
export const hhmmss = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);
// Full precision for the hover — the gutter stays hh:mm:ss (narrow, scannable) but the underlying marks are
// epoch MILLISECONDS, so the tooltip can show the exact instant and a meaningful gap.
/** A clock label at the resolution the PIXEL affords. Milliseconds are shown only when a pixel is worth less
 *  than `MS_PRECISE` — otherwise the digits move faster than the pointer can mean anything by them, which is
 *  a precision the reader did not ask for and cannot use.
 *
 *  Note this is the resolution of the POINTER, not of the data: the resource chart samples on a poll (2s), so
 *  a crosshair between two samples is interpolated. Event times, which come from real timings rather than the
 *  sample grid, are exact and are shown to the millisecond in their own tooltip. */
export const MS_PRECISE = 40;   // ms per pixel below which the third decimal place is meaningful
/** A time at the precision the ZOOM justifies: seconds when a pixel is a second, milliseconds when the
 *  window is narrow enough for them to mean something. */
export const clockAt = (ts: number, msPerPx: number): string =>
    msPerPx > 0 && msPerPx < MS_PRECISE ? hhmmssms(ts) : hhmmss(ts);

/** `14:03:07.412` — for an event's own timings, which are exact (unlike the crosshair, which
 *  interpolates between samples). */
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

// A mark's LOCAL calendar day: the key groups, the label is what a reader sees. ISO so it can't be misread
// across locales (and sorts), unlike "3/9" vs "9/3".
const dayKey = (ts: number): string => new Date(ts).toDateString();
const p2 = (n: number): string => String(n).padStart(2, "0");
/** `2026-09-05` — the divider a run spanning midnight gets, so `00:00:01` under `23:59:58` cannot read
 *  as one second later. */
export const dayLabel = (ts: number): string => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

/** Line indices where the calendar DAY changes, → the new day's label. The gutter is time-only, so a run that
 *  crosses midnight would otherwise show `23:59:58` directly above `00:00:01` with nothing saying a day passed
 *  — the times are right and the reading is wrong. Never marks the FIRST day (there is nothing to separate). */
export function dayBreaks(text: string, marks: [number, number][] | undefined): Map<number, string> {
    const breaks = new Map<number, string>();
    const m = alignedMarks(marks, text);
    if (!m) return breaks;
    let off = 0, prev: string | null = null;
    text.split("\n").forEach((line, i) => {
        const ts = timeForOffset(m, off);
        off += line.length + 1;
        if (ts == null) return;                       // no mark covers it → we don't know its day, so say nothing
        const k = dayKey(ts);
        if (prev != null && k !== prev) breaks.set(i, dayLabel(ts));
        prev = k;
    });
    return breaks;
}

/** The output with a produced-at gutter, as PLAIN TEXT — for the exports, which have no way to make a column
 *  unselectable the way the sidebar does. Repeats are blanked, exactly like the gutter. Returns null when the
 *  marks don't describe this text, so a caller can fall back to the untimed output. */
export function timedText(text: string, marks: [number, number][] | undefined, now: number = Date.now()): string | null {
    const m = alignedMarks(marks, text);
    if (!m) return null;
    const short = elideHour(m, now);
    const width = short ? 5 : 8;
    const breaks = dayBreaks(text, m);
    let off = 0;
    const out: string[] = [];
    text.split("\n").forEach((line, i) => {
        const day = breaks.get(i);
        if (day) out.push(`${"─".repeat(width)}  ── ${day} ──`);
        const ts = timeForOffset(m, off);
        off += line.length + 1;
        // EVERY line carries its own stamp here, unlike the sidebar gutter, which blanks a repeat to keep a
        // burst reading as one moment. A text file has the opposite ergonomics: a blank means "look upwards",
        // and you cannot hover it — so each line is self-contained and greppable (`grep 23:59 run.md`). It is
        // not invented: lines sharing a mark genuinely arrived together. Only an offset NO mark covers stays
        // blank, because there the time really is unknown.
        const label = ts == null ? "" : (short ? hhmmss(ts).slice(3) : hhmmss(ts));
        // An empty content line gets no gutter — otherwise the trailing newline every log ends with becomes a
        // row of trailing spaces in the exported file.
        out.push(line === "" ? "" : `${label.padStart(width)}  ${line}`);
    });
    return out.join("\n");
}

/** A DURATION, in units a reader can hold in their head. One formatter, because the panel had two that
 *  disagreed: a span's tooltip stopped at seconds, so a five-minute run read as "312.4s" — technically the
 *  number but not the answer to "how long was that". Milliseconds matter under a second (a tool call can be
 *  4ms), tenths under a minute, and past that the seconds are noise beside the minutes. */
export function fmtDur(ms: number): string {
    const n = Math.max(0, ms);
    if (n < 1000) return `${Math.round(n)}ms`;
    if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
    const totalS = Math.round(n / 1000);
    const m = Math.floor(totalS / 60), sec = totalS % 60;
    if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`;
    const h = Math.floor(m / 60), min = m % 60;
    return min ? `${h}h ${min}m` : `${h}h`;
}

/** The same scale, as an AGE ("3m ago"). Sub-second is not a useful age — anything that recent is "now" to a
 *  reader — so it rounds up to seconds rather than reporting milliseconds. */
export function fmtAge(ms: number): string {
    return ms < 1000 ? "0s" : fmtDur(ms).replace(/\.\d+/, "");
}
