// live-hold.tsx — how long a tool call that was being written stays on screen once it has been written, in the calm chat.
//
// A call streams in as the model writes it (`LiveCall`), and the step it becomes replaces it the moment it is parsed. A fast
// model writes a script in a blink, and the block the reader had just started to read was gone before they could: it drew
// and collapsed in one beat. The calm view keeps the live block for `LIVE_MIN_MS` from when it was first shown. The step that
// replaces it waits for that, then takes over (the characters flying into place, code-morph.ts), and not before the live block
// has actually left the page: the flight starts from where the live block's characters were, which is only known as it
// goes. A call that took longer than that to write is not held at all. A new call starting to be written during the wait
// ends it at once: the next thing is already there to show. A step that has already finished is not held either.
//
// A held call whose step does not open (a call that needs no approval is a row, not a body) folds away rather than vanishing.

import { useEffect, useReducer, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { focusMode } from "../store";
import type { AgentStep, Session } from "../store";

/** How long, in ms, a live call stays on screen at least, counted from when it was first shown. */
export const LIVE_MIN_MS = 1200;
/** How long, in ms, a held call takes to fold away when no step opens in its place. */
export const LIVE_LEAVE_MS = 220;

// state: ui — the live blocks on screen now, when the first appeared, whether the held one is still drawn, and whether the
// step that replaces it opens (a gate: it shows the code, so the code flies there; otherwise the live block folds away)
const hold = { live: 0, first: 0, until: 0, frozen: false, opens: false };
// state: ui — bumped when a hold's wait is over or the frozen block has gone, so what waits on it draws again, in one pass
const tick = signal(0);

/** A live call has been drawn. Counts it, and starts the window with the first of them. */
export function liveMounted(now = Date.now()): void {
    if (hold.live === 0) {
        // A call that starts while the last one is still held ends that hold: the next thing to show is already here.
        if (now < hold.until) { hold.until = 0; hold.frozen = false; }
        hold.first = now;
        hold.opens = false;
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

/** Whether a held live block is still drawn: what a step waits on after the time is served, so it mounts after the block has left. */
export const liveFrozen = (): boolean => focusMode.value && hold.frozen;

/** A re-render after `ms`, through the shared tick so everything waiting on a hold draws in the same pass. */
function useWake(ms: number): void {
    useEffect(() => { if (ms <= 0) return; const t = setTimeout(() => { tick.value++; }, ms + 10); return () => clearTimeout(t); });
}

/**
 * The step that replaces a live call, held back until the call has had its time on screen AND its block has left the page.
 * A step that has already finished is drawn at once.
 */
export function HeldStep({ st, children }: { st: AgentStep; children: ComponentChildren }) {
    void tick.value;   // subscribed: drawn again when the wait is over or the held block has gone
    const owed = st.pending ? liveOwed() : 0;
    // A step waiting on the person opens to show the code, which the live block's characters fly to.
    if (st.pending && st.awaitingApproval) hold.opens = true;
    useWake(owed);
    return owed > 0 || (st.pending && liveFrozen()) ? null : <>{children}</>;
}

/**
 * The live stream, kept drawn as it last was for the time it is owed after the run's own state has dropped it (the step
 * that replaced it has landed). `ls` is null once the reducer has cleared it. When the time is served the block goes at once if a
 * step is opening to take its characters, and otherwise folds away over `LIVE_LEAVE_MS`.
 */
export function HeldLive({ ls: incoming, render }: { ls: Session["liveStream"] | undefined | null; render: (ls: NonNullable<Session["liveStream"]>) => ComponentChildren }) {
    void tick.value;
    // The next turn's stream arrives EMPTY (nothing written yet) and draws nothing: it does not displace a held block, which
    // goes when something has actually been written to replace it.
    const ls = incoming && (incoming.reasoning || incoming.content || incoming.calls?.length) ? incoming : null;
    const last = useRef<Session["liveStream"] | null>(null);
    // state: ui — when this block began to fold away, if it is; and whether it was ever HELD (a block that was not goes at once)
    const leaving = useRef(0);
    const held = useRef(false);
    const [, bump] = useReducer((n: number) => n + 1, 0);
    if (ls) { last.current = ls; leaving.current = 0; held.current = false; hold.frozen = false; }
    const owed = !ls && last.current ? liveOwed() : 0;
    let shown: Session["liveStream"] | null = ls ?? null;
    let folding = false;
    if (!ls && last.current) {
        if (owed > 0) { shown = last.current; hold.frozen = true; held.current = true; }
        else if (held.current && !hold.opens && focusMode.value && (leaving.current === 0 || Date.now() - leaving.current < LIVE_LEAVE_MS)) {
            // Served, and nothing opens to take over: fold away, with the step's row already appearing beside it.
            if (leaving.current === 0) leaving.current = Date.now();
            shown = last.current; folding = true; hold.frozen = false;
        } else { last.current = null; leaving.current = 0; hold.frozen = false; }
    }
    useWake(owed);
    useEffect(() => {
        if (!folding) return;
        const t = setTimeout(bump, LIVE_LEAVE_MS - (Date.now() - leaving.current) + 20);
        return () => clearTimeout(t);
    });
    // The block has gone this pass: whatever waited on it can draw now.
    const wasFrozen = useRef(false);
    useEffect(() => { if (wasFrozen.current && !hold.frozen) tick.value++; wasFrozen.current = hold.frozen; });
    return shown ? <div class={folding ? "live-hold live-leaving" : "live-hold"}>{render(shown)}</div> : null;
}
