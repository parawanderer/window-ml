// live-hold.tsx — how long a tool call that was being written stays on screen once it has been written, in the calm chat, and
// how the calls of one turn hand over to their steps one at a time.
//
// A call streams in as the model writes it (`LiveCall`), and the step it becomes replaces it the moment it is parsed. A fast
// model writes a script in a blink, and the block the reader had just started to read was gone before they could: it drew
// and collapsed in one beat. The calm view keeps the live block for `LIVE_MIN_MS` from when it was first shown. The step that
// replaces it waits for that, then takes over (the characters flying into place, code-morph.ts), and not before ITS live cell
// has actually left the page: the flight starts from where the cell's characters were, which is only known as it goes. A call
// that took longer than that to write is not held at all. A new call starting to be written during the wait ends it at once.
//
// A turn that wrote several calls gets its steps one at a time (each waits on the one before). The cells whose steps have not
// landed yet STAY, where they were drawn, until their own step takes over: the second call does not vanish when the first is
// parsed and slide back in when its turn comes. A cell whose step is not opening for approval (a call that needs none is a row,
// not a body) folds away rather than vanishing.

import { useEffect, useLayoutEffect, useReducer, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { focusMode } from "../store";
import type { AgentStep, Session } from "../store";

/** How long, in ms, a live call stays on screen at least, counted from when it was first shown. */
export const LIVE_MIN_MS = 1200;
/** How long, in ms, a held call takes to fold away when no step opens in its place. */
export const LIVE_LEAVE_MS = 520;

/** How long, in ms, the next stream is held back after a call folds or a group forms, on top of the fold itself. */
export const FOLD_PAUSE_MS = 400;

// state: ui — until when the next model stream is kept off the page: set when something collapsed by itself
const calm = { until: 0 };

/** Something has just collapsed by itself (a call folded, a group formed) and takes `ms` to do it: the next stream waits for that and a beat more. */
export function noteFold(ms: number, now = Date.now()): void { calm.until = Math.max(calm.until, now + ms + FOLD_PAUSE_MS); }

/** Milliseconds the next stream is still to be kept off the page (0 outside the calm view). */
export function foldPauseOwed(now = Date.now()): number { return focusMode.value ? Math.max(0, calm.until - now) : 0; }

// state: ui — when the first live cell of this stretch appeared, until when it is owed, which cells (by call index) are drawn
// now, and which of their steps open for approval (the code then flies there; otherwise the cell folds away)
const hold = { first: 0, until: 0, cells: new Set<number>(), opens: new Set<number>() };
// state: ui — bumped when a hold's wait is over or a cell has gone, so what waits on it draws again, in one pass
const tick = signal(0);

/** A live cell (call `index`) has been drawn. Starts the window with the first of them. */
export function liveMounted(index = 0, now = Date.now()): void {
    if (hold.cells.size === 0) {
        // A call that starts while the last one is still held ends that hold: the next thing to show is already here.
        if (now < hold.until) hold.until = 0;
        hold.first = now;
        hold.opens.clear();
    }
    hold.cells.add(index);
    hold.until = hold.first + LIVE_MIN_MS;
}

/** A live cell has gone from the screen. */
export function liveUnmounted(index = 0): void { hold.cells.delete(index); }

/** Milliseconds a live call is still owed on screen, 0 when none is (or the view does not hold them). */
export function liveOwed(now = Date.now()): number {
    return focusMode.value ? Math.max(0, hold.until - now) : 0;
}

/** A re-render after `ms`, through the shared tick so everything waiting on a hold draws in the same pass. */
function useWake(ms: number): void {
    useEffect(() => { if (ms <= 0) return; const t = setTimeout(() => { tick.value++; }, ms + 10); return () => clearTimeout(t); });
}

/**
 * The step that replaces a live call (`slot` is its place among the turn's calls), held back until the call has had its time
 * on screen AND its cell has left the page. A step that has already finished is drawn at once.
 */
export function HeldStep({ st, slot, young, children }: { st: AgentStep; slot: number; /** it has only just started and has not said whether it will ask (step-settle.ts) */ young?: boolean; children: ComponentChildren }) {
    void tick.value;   // subscribed: drawn again when the wait is over or the held cell has gone
    const owed = st.pending ? liveOwed() : 0;
    // A step waiting on the person opens to show the code, which the live cell's characters fly to.
    if (st.pending && st.awaitingApproval) hold.opens.add(slot);
    useWake(owed);
    if (young && focusMode.value && hold.cells.has(slot)) return null;
    return owed > 0 || (st.pending && focusMode.value && hold.cells.has(slot)) ? null : <>{children}</>;
}

/**
 * The live stream, kept drawn as it last was for the time it is owed after the run's own state has dropped it (a step has
 * landed), and for as long as a call it wrote has no step. `ls` is null once the reducer has cleared it; `landed(step)` says
 * how many of that turn's calls have a step now (Infinity once nothing more will come of them). When the time is served the
 * cells that have a step go at once if their step opens to take their characters, and otherwise fold away over `LIVE_LEAVE_MS`.
 */
export function HeldLive({ ls: incoming, landed, render }: { ls: Session["liveStream"] | undefined | null; landed: (step: number) => number; render: (ls: NonNullable<Session["liveStream"]>, rest: boolean, leaving: ReadonlySet<number>) => ComponentChildren }) {
    void tick.value;
    // The next turn's stream arrives EMPTY (nothing written yet) and draws nothing: it does not displace a held block, which
    // goes when something has actually been written to replace it.
    const written = incoming && (incoming.reasoning || incoming.content || incoming.calls?.length) ? incoming : null;
    // A stream that STARTS right after something collapsed waits a beat: a fast model writes into the fold's last frames and everything moves at
    // once. What it says keeps arriving in the session meanwhile; a stream already on screen is never taken off it.
    const shownStep = useRef<number | null>(null);
    const pause = written && written.step !== shownStep.current ? foldPauseOwed() : 0;
    const ls = pause > 0 ? null : written;
    if (ls) shownStep.current = ls.step;
    useWake(pause);
    const last = useRef<Session["liveStream"] | null>(null);
    // state: ui — when each cell began to fold away (by call index), when the whole block did, and whether it was ever HELD
    // (a block that was not goes at once)
    const folding = useRef(new Map<number, number>());
    const leaving = useRef(0);
    const held = useRef(false);
    const [, bump] = useReducer((n: number) => n + 1, 0);
    if (ls) { last.current = ls; leaving.current = 0; held.current = false; folding.current.clear(); }
    let shown: Session["liveStream"] | null = ls ?? null;
    let whole = false;
    const fold = new Set<number>();
    let owed = 0;
    const now = Date.now();
    if (!ls && last.current) {
        const l = last.current;
        const calls = l.calls ?? [];
        const have = landed(l.step);
        owed = liveOwed(now);
        // What the turn says of itself (its thinking, its reply) is drawn by the turn that has landed; this holds only the calls.
        const bare = { ...l, reasoning: undefined, content: undefined };
        const rest = calls.filter((c) => c.index >= have);
        if (owed > 0) { shown = { ...bare, calls }; held.current = true; }
        else if (focusMode.value && rest.length > 0) {
            // The cells whose steps have landed go (folding, when they were held and their step does not open); the rest stay, and so
            // do all of them while the turn's thought has landed and no call has (the call's own step follows it).
            const out = calls.filter((c) => c.index < have && held.current && !hold.opens.has(c.index) && (folding.current.get(c.index) ?? now) + LIVE_LEAVE_MS > now);
            for (const c of out) { if (!folding.current.has(c.index)) folding.current.set(c.index, now); fold.add(c.index); }
            shown = { ...bare, calls: calls.filter((c) => c.index >= have || fold.has(c.index)) };
        } else if (held.current && hold.opens.size === 0 && focusMode.value && (leaving.current === 0 || now - leaving.current < LIVE_LEAVE_MS)) {
            // Served, and nothing opens to take over: fold away, with the step's row already appearing beside it.
            if (leaving.current === 0) leaving.current = now;
            shown = { ...bare, calls }; whole = true;
        } else { last.current = null; leaving.current = 0; folding.current.clear(); }
    }
    useWake(owed);
    useEffect(() => {
        const started = whole ? [leaving.current] : [...folding.current.values()].filter((t) => Date.now() - t < LIVE_LEAVE_MS);
        if (!started.length) return;
        const t = setTimeout(bump, LIVE_LEAVE_MS - (Date.now() - Math.min(...started)) + 20);
        return () => clearTimeout(t);
    });
    // A cell has gone this pass: whatever waited on it can draw now, before the next frame.
    const drawn = useRef(0);
    useLayoutEffect(() => { if (hold.cells.size < drawn.current) tick.value++; drawn.current = hold.cells.size; });
    return shown ? <div class={whole ? "live-hold live-leaving" : "live-hold"}>{render(shown, !ls, fold)}</div> : null;
}
