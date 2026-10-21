// reveal.ts — the pace at which a live call's text is TYPED OUT: text that arrives in bursts (a worker flush every
// ~90 ms, a hub's relay) is shown at an even speed instead of in clumps. Pure, so the rules are tested apart from the
// component (`useReveal`, live-call.tsx). It only ever shows text that has ARRIVED: the reveal trails the stream by
// about one gap between arrivals, and anything that would make it trail further shows the text at once.

/** The bounds the reveal keeps to. */
export const REVEAL = {
    /** the gap between arrivals is clamped to this range before the pace is set from it, ms */
    minGapMs: 60, maxGapMs: 400,
    /** a backlog this many characters long is shown at once (a resumed stream, a reopened panel, a hub's catch-up) */
    jumpChars: 4000,
    /** a render that costs more than this is not animated at all, ms (a cell of about 40k characters, measured) */
    maxCostMs: 30,
    /** the share of the main thread the reveal may spend rendering */
    budgetShare: 0.25,
    /** the fastest a reveal ticks: one frame, ms */
    frameMs: 16,
};

const clampGap = (ms: number): number => Math.min(REVEAL.maxGapMs, Math.max(REVEAL.minGapMs, ms));

/** The gap between arrivals, smoothed: the pace is set to drain each burst over about one gap. */
export function nextGap(gap: number, observedMs: number): number {
    return gap * 0.7 + clampGap(observedMs) * 0.3;
}

/** The pace, in characters per ms, that shows `backlog` characters over one expected gap between arrivals. Set when
 *  text arrives and held until the next arrival, so the speed is even between bursts rather than easing out. */
export function revealRate(backlog: number, gapMs: number): number {
    return Math.max(0, backlog) / clampGap(gapMs);
}

/** How many characters are shown after `dt` ms at `rate`: at least one more per tick, never past `target`. */
export function advance(shown: number, target: number, rate: number, dt: number): number {
    return Math.min(target, shown + Math.max(1, Math.round(rate * dt)));
}

/** How long to wait before the next tick, given what the last render cost: every frame while it is cheap, and less
 *  often as the cell grows, so highlighting a long cell never takes more than `budgetShare` of the main thread. */
export function tickDelay(costMs: number): number {
    return Math.max(REVEAL.frameMs, costMs / REVEAL.budgetShare);
}

/** Whether newly arrived text is shown AT ONCE instead of typed out: motion is reduced, what is shown is no longer its
 *  start (the text was replaced), the backlog is too long to type out within one gap, or a render costs too much. */
export function revealJumps(o: { shownText: string; text: string; costMs: number; reduced: boolean }): boolean {
    return o.reduced
        || !o.text.startsWith(o.shownText)
        || o.text.length - o.shownText.length > REVEAL.jumpChars
        || o.costMs > REVEAL.maxCostMs;
}
