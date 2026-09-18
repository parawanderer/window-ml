// chart-interaction.ts — what the pointer and the keyboard are currently on in the resource chart, and what the
// chart publishes as it renders.
//
// This is SHARED STATE, and it is a module because of who reads it rather than for tidiness. The chart, the event
// lane, every track's band tip and the pool tips all place a tooltip from the same cursor and all decide what is
// lit from the same hover — and they live in different files. Holding this in the chart meant the lane could not
// leave it, and holding the pool half in vram.tsx meant the two files imported each other.
//
// Two shapes on purpose. Signals for what a POINTER does, because a render must react to it. A plain `live`
// holder for what the chart publishes as it draws, because that is written DURING render, where a signal either
// warns or re-enters.

import { signal } from "@preact/signals";
import type { Band } from "../resource-bands";
import type { ResourceSample } from "../resource-model";

/** The pool (card or host) currently hovered in the chart, and which models sit on it. The model rows below
 *  ARE the legend, so rows not on that pool grey out — reusing what is already on screen instead of injecting
 *  a row that shifts the layout under the cursor. */
// WHICH pool is hovered, not what it held when you got there — the pool is identified by the LINE, while the
// figures come from the DATAPOINT the pointer is on (see PoolTip). Keeping the reading out of this signal is
// what lets the tip follow the cursor along a line and report a different instant at each x.
export const poolHover = signal<{ id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] } | null>(null);
