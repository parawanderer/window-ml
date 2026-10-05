// just-arrived.ts — telling something that happened IN FRONT OF THE READER from history being drawn for the
// first time.
//
// The reading view animates a transcript's own motion: a turn arriving drifts up into place, a run of the same
// tool collapses into one row rather than cutting to it. Both read as the log moving, which is what they are —
// and both are WRONG for a transcript somebody just opened, where the same code runs over fifty items at once
// and produces a page of movement about things the reader never saw happen.
//
// The two cases are indistinguishable from inside a component: it mounts either way. What tells them apart is the
// CLOCK, and only the clock — a step that landed while you were watching is stamped a moment ago, and one from a
// run that ended yesterday is not.
//
// NOT "is the run still live", which was the obvious second test and is wrong in the case that matters most: a
// run's LAST streak folds precisely BECAUSE the run ended, so at that moment it is not live and the one fold the
// reader is most certainly watching would have been the one that snapped.
//
// A REMOTE RUNTIME'S CLOCK is what `live` was really guarding against — a stamp from a machine running an hour
// fast is not "a moment ago", it is the future — so the window is bounded at BOTH ends instead. Skew in either
// direction falls outside it and is treated as history, which is the safe way to be wrong: one animation too few,
// never a page of them at once.
//
// Read ONCE, at mount, into state: it is a fact about how the thing came to be on screen, and re-reading it on
// a later render would make it decay in the middle of its own animation.

/** How recently something must have landed to count as having arrived in view. Generous on purpose: the cost of
 *  being wrong is one animation too many or too few, and a conservative window would skip the real case on a slow
 *  machine, where the drift matters most. */
export const JUST_ARRIVED_MS = 4000;

/**
 * Did this land while the reader was watching?
 *
 * @param ts when it happened, as the runtime stamped it (absent, 0, or outside the window → history: a page
 *           opened later must not animate, so anything uncertain is read as old)
 * @param now injectable so this is testable without waiting on a clock
 */
export const justArrived = (ts: number | undefined | null, now = Date.now()): boolean => {
    if (ts == null || ts <= 0) return false;
    const age = now - ts;
    return age >= 0 && age < JUST_ARRIVED_MS;
};
