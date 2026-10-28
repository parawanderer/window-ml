// read-marks.ts — which sessions have NEWS this device has not seen, so the list can mark them and the mark survives
// a reload and closing the app.
//
// A session is UNREAD when its newest event is later than both this device's BASELINE and the newest event of it that
// was on screen here, and it is not the session open now. The baseline is the moment this device first loaded its
// marks: a session that last moved before then is never unread, which is what stops the first open of the page from
// marking every session there is (and teaches nobody to ignore the mark). What happens afterwards is news: a session
// that moves while you are in another one, one a run finished in while the app was closed, one started on another
// device. Opening a session (its newest event on screen) marks it seen up to that event, so a run that is resumed
// and moves again is unread again. A bad ending is news like any other: the capped, failed or cancelled run you have
// not looked at is unread, and once looked at it is not.
//
// Per device, like a pin: what this screen has shown you. Pure and import-free, because the phone's list (mobile/)
// shares it through Metro, which watches src/chat.

/** A session's status, as the index reports it (session-host.ts `SessionStatus`). */
export type ReadStatus = "running" | "waiting" | "done" | "error" | "cancelled" | "capped" | "interrupted";

/** The statuses that ended, and not the way they were asked to: their words stay in the list after they are read. */
export const UNTIL_READ: ReadonlySet<ReadStatus> = new Set<ReadStatus>(["capped", "error", "cancelled", "interrupted"]);

/** Per session key, the `lastTs` its newest event had when it was on screen here. */
export type ReadMarks = Readonly<Record<string, number>>;

/** What this device has seen: the baseline (`since`, a local clock stamp in ms) and the marks (`seen`, runtime clock). */
export type ReadState = Readonly<{ since: number; seen: ReadMarks }>;

/** How many marks a device keeps: the newest, by what was seen. A runtime's index is bounded far below this. */
export const READ_MARKS_MAX = 500;

/**
 * Whether session `key` has news this device has not seen: it is not the one open, it is not running, it moved after the baseline
 * (`localTs` is its `lastTs` on THIS device's clock, which is what the baseline is on), and its newest event
 * (`lastTs`, the runtime's clock, which is what the marks are on) is later than the one seen.
 */
export function isUnread(state: ReadState, key: string, status: ReadStatus, lastTs: number, localTs: number, open: boolean): boolean {
    // A RUNNING session is never unread: its dot already says it is working, and a title that went bold on every step
    // while you are elsewhere would be the mark that is always there. When it ends, or stops to wait on you, its newer
    // `lastTs` against the mark makes it unread then.
    if (open || status === "running" || localTs <= state.since) return false;
    const at = state.seen[key];
    return !(typeof at === "number" && at >= lastTs);
}

/**
 * The state with `key` seen up to `lastTs`, or the same object when that changes nothing (so a caller can skip the
 * write). Never moves a mark BACK: a row reported late with an older stamp does not unread what was read.
 */
export function markSeen(state: ReadState, key: string, lastTs: number): ReadState {
    const marks = state.seen;
    if (!Number.isFinite(lastTs) || (marks[key] ?? -Infinity) >= lastTs) return state;
    const next: Record<string, number> = { ...marks, [key]: lastTs };
    const keys = Object.keys(next);
    if (keys.length <= READ_MARKS_MAX) return { since: state.since, seen: next };
    // Over the cap: keep the newest by what was seen. The dropped ones are the oldest endings, which were read anyway.
    keys.sort((a, b) => next[b] - next[a]);
    return { since: state.since, seen: Object.fromEntries(keys.slice(0, READ_MARKS_MAX).map((k) => [k, next[k]])) };
}

/** Whether `raw` (as stored) already carries a baseline; when it does not, the loader writes the one `readStateFrom` made. */
export function hasBaseline(raw: unknown): boolean {
    return !!raw && typeof raw === "object" && !Array.isArray(raw) && Number.isFinite((raw as { since?: unknown }).since);
}

/**
 * Stored state as read back from storage, never trusted. Without a baseline (nothing stored, junk, or the flat
 * key → stamp map the first version of this wrote) the baseline is `now` and the old marks, if any, are kept: nothing
 * becomes unread by an upgrade, and a bad ending already read stays read.
 */
export function readStateFrom(raw: unknown, now: number): ReadState {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { since: now, seen: {} };
    const o = raw as Record<string, unknown>;
    if (hasBaseline(raw)) return { since: o.since as number, seen: readMarksFrom(o.seen) };
    return { since: now, seen: readMarksFrom(raw) };
}

/** Stored marks as read back from storage: anything that is not a key → finite number is dropped, never trusted. */
export function readMarksFrom(raw: unknown): ReadMarks {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
}

/** How long a stored mark may lag the screen: a streaming session moves its mark on every event, storage is told at most this often. */
export const MARK_WRITE_MS = 2000;

/**
 * A writer for a value that changes in bursts: `put` writes at once when nothing was written in the last `ms`, and
 * otherwise keeps only the newest value and writes it when the window ends. `flush` writes what is pending now (on
 * leaving a session, hiding the page, a status change), so the last value is never lost. The in-memory copy is the
 * caller's; only the storage write is throttled. `now` and the timer are parameters so a test can drive them.
 */
export function throttledWriter<T>(write: (v: T) => void, ms: number = MARK_WRITE_MS, now: () => number = Date.now,
    timer: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void } = { set: (f, d) => { const h = setTimeout(f, d) as unknown as { unref?: () => void }; h.unref?.(); return h; }, clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }): { put: (v: T) => void; flush: () => void } {
    let last = -Infinity, pending: { v: T } | null = null, handle: unknown = null;
    const out = () => { if (handle !== null) { timer.clear(handle); handle = null; } if (!pending) return; const { v } = pending; pending = null; last = now(); write(v); };
    return {
        put(v) {
            pending = { v };
            if (now() - last >= ms) out();
            else if (handle === null) handle = timer.set(out, Math.max(0, ms - (now() - last)));
        },
        flush: out,
    };
}
