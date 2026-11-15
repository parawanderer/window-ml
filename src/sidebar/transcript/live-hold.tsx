// live-hold.tsx — how long a tool call that was being written stays on screen once it has been written, in the calm chat.
//
// A call streams in as the model writes it (`LiveCall`), and the step it becomes replaces it the moment it is parsed. A fast
// model writes a script in a blink, and the block the reader had just started to read was gone before they could: it drew
// and collapsed in one beat. The calm view keeps the live block for `LIVE_MIN_MS` from when it was first shown, and the step
// that replaces it waits for that, then takes over (the characters flying into place, code-morph.ts). A call that took longer
// than that to write is not held at all. A new call starting to be written during the wait ends it: the next thing is already
// there to show. A step that has already finished (a quick call whose result is in) is not held either.

import { useEffect, useReducer, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { focusMode } from "../store";
import type { AgentStep, Session } from "../store";

/** How long, in ms, a live call stays on screen at least, counted from when it was first shown. */
export const LIVE_MIN_MS = 1200;

// state: ui — the live blocks on screen now and when the first appeared; the step waits until `until`
const hold = { live: 0, first: 0, until: 0 };

/** A live call has been drawn. Counts it, and starts the window with the first of them. */
export function liveMounted(now = Date.now()): void {
    if (hold.live === 0) {
        // A call that starts while the last one is still held ends that hold: the next thing to show is already here.
        if (now < hold.until) hold.until = 0;
        hold.first = now;
    }
    hold.live++;
    hold.until = hold.first + LIVE_MIN_MS;
}

/** A live call has gone from the screen. */
export function liveUnmounted(): void { hold.live = Math.max(0, hold.live - 1); }

/** Milliseconds a live call is still owed on screen, 0 when none is (or the view does not hold them). */
export function liveOwed(now = Date.now()): number {
    return focusMode.value ? Math.max(0, hold.until - now) : 0;
}

/** A re-render when `ms` have passed. */
function useRerenderAfter(ms: number): void {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => { if (ms <= 0) return; const t = setTimeout(bump, ms + 10); return () => clearTimeout(t); });   // re-armed by every render: a late timer must not leave the step unmounted
}

/**
 * The step that replaces a live call, held back until the call has had its time on screen. `step` is drawn the render after
 * the wait; a step that has already finished is drawn at once.
 */
export function HeldStep({ st, children }: { st: AgentStep; children: ComponentChildren }) {
    const owed = st.pending ? liveOwed() : 0;
    useRerenderAfter(owed);
    return owed > 0 ? null : <>{children}</>;
}

/**
 * The live stream, kept drawn as it last was for the time it is owed after the run's own state has dropped it (the step
 * that replaced it has landed). `ls` is null once the reducer has cleared it.
 */
export function HeldLive({ ls, render }: { ls: Session["liveStream"] | undefined | null; render: (ls: NonNullable<Session["liveStream"]>) => ComponentChildren }) {
    const last = useRef<Session["liveStream"] | null>(null);
    if (ls) last.current = ls;
    const owed = !ls && last.current ? liveOwed() : 0;
    if (!ls && owed <= 0) last.current = null;
    useRerenderAfter(owed);
    const shown = ls ?? (owed > 0 ? last.current : null);
    return shown ? <>{render(shown)}</> : null;
}
