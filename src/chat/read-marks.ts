// read-marks.ts — which finished-badly sessions you have already SEEN, so their list dot can go once you have.
//
// A capped or failed run's dot says "something here went wrong that you have not looked at". Once you have looked, it
// says nothing new, and a list where every old failure keeps its dot forever teaches the eye to skip the dots. So the
// dot of such a session is drawn until you have seen its newest event, and not after: the mark records the session's
// `lastTs` as it was when you saw it, so a run that is resumed and goes wrong AGAIN has a newer `lastTs` and its dot
// comes back. A run still working or waiting on you keeps its dot whatever you have seen: that is not news, it is work.
//
// Per device, like a pin: what this screen has shown you. Pure and import-free, because the phone's list (mobile/)
// shares it through Metro, which watches src/chat.

/** A session's status, as the index reports it (session-host.ts `SessionStatus`). */
export type ReadStatus = "running" | "waiting" | "done" | "error" | "cancelled" | "capped" | "interrupted";

/** The statuses whose dot is news until it has been seen: the run ended, and not the way it was asked to. */
export const UNTIL_READ: ReadonlySet<ReadStatus> = new Set<ReadStatus>(["capped", "error", "cancelled", "interrupted"]);

/** What this device has seen: per session key, the `lastTs` its newest event had when it was on screen. */
export type ReadMarks = Readonly<Record<string, number>>;

/** How many marks a device keeps: the newest, by what was seen. A runtime's index is bounded far below this. */
export const READ_MARKS_MAX = 500;

/** Whether this session's ending has been seen here: its status is one that waits to be read, and its newest event is. */
export function seenEnding(status: ReadStatus, lastTs: number, marks: ReadMarks, key: string): boolean {
    if (!UNTIL_READ.has(status)) return false;
    const at = marks[key];
    return typeof at === "number" && at >= lastTs;
}

/**
 * The marks with `key` seen up to `lastTs`, or the same object when that changes nothing (so a caller can skip the
 * write). Never moves a mark BACK: a row reported late with an older stamp does not unread what was read.
 */
export function markSeen(marks: ReadMarks, key: string, lastTs: number): ReadMarks {
    if (!Number.isFinite(lastTs) || (marks[key] ?? -Infinity) >= lastTs) return marks;
    const next: Record<string, number> = { ...marks, [key]: lastTs };
    const keys = Object.keys(next);
    if (keys.length <= READ_MARKS_MAX) return next;
    // Over the cap: keep the newest by what was seen. The dropped ones are the oldest endings, which were read anyway.
    keys.sort((a, b) => next[b] - next[a]);
    return Object.fromEntries(keys.slice(0, READ_MARKS_MAX).map((k) => [k, next[k]]));
}

/** Stored marks as read back from storage: anything that is not a key → finite number is dropped, never trusted. */
export function readMarksFrom(raw: unknown): ReadMarks {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
}
