// clock.ts — the sweep page's one clock: every elapsed time on the page reads it, so two copies of one running run's
// badge (the Running card, the Answers header, the Runs table) always say the same thing.

import { signal } from "@preact/signals";

/**
 * Now, by the wall, moved once a second while the sweep runs. A SIGNAL rather than a re-render of the whole page from
 * the top: a component with hooks and unchanged props is skipped when its parent re-renders (the signals integration
 * bails it out), so a clock carried by re-rendering froze the Answers card's badge while the others kept counting.
 * Reading `now.value` subscribes whoever reads it, wherever it sits.
 */
export const now = signal(Date.now());   // state: ui

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the clock (a running sweep) or stop it (a finished one, whose times no longer move). */
export function runClock(on: boolean): void {
    if (on && !timer) timer = setInterval(() => { now.value = Date.now(); }, 1000);
    if (!on && timer) { clearInterval(timer); timer = null; }
    now.value = Date.now();
}
