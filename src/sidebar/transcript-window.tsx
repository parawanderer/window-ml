// transcript-window.tsx — HOW MUCH OF A TRANSCRIPT IS IN THE DOM AT ONCE. A long session is drawn from its END: the
// newest `WINDOW` items, with a button above them that draws more. Everything older is still HELD (the store has it);
// it is simply not rendered until something asks for it.
//
// Measured on the chat page before this existed: a 1000-turn chat drew 34,008 nodes, 1.9 MB of HTML and 385,000 px of
// scroll height. Linear in turns, and an agent step with a screenshot or a table costs several times a chat turn. A
// phone pays that in memory and in every layout; a laptop has the headroom to not notice until it does.
//
// A REFERENCE INTO THE PAST is why this is not just a slice. A citation, a pointer chip or a lane bar names a step by
// `seq`, and the step it names may be outside the window or not even loaded. `reveal` is the one way in: it grows the
// window, pages the store if it must, and says so when the step is gone for good — so a reference never silently does
// nothing, which is what the eight-frame retry it replaces did.

import { services } from "./services";
import { rev } from "./store";

/** How many items a transcript draws before you ask for more, and how many each "earlier" adds. */
export const WINDOW = 50;

/**
 * How many trailing items each session draws, by session key. Absent means `WINDOW`.
 *
 * A plain Map, not a signal, and growing it bumps `rev` like everything else the transcript draws from. A component
 * that READS a signal is converted by @preact/signals into one that re-renders from that signal, and it then stops
 * re-rendering from its parent's `rev` cascade — which is how a first version of this stopped live turns from ever
 * appearing while the assertions about window size all passed.
 */
const shown = new Map<string, number>();

/** How many of a session's items are drawn right now. */
export const shownFor = (key: string): number => shown.get(key) ?? WINDOW;

/** Draw `by` more of this session's earlier items. */
export function growWindow(key: string, by = WINDOW): void {
    shown.set(key, shownFor(key) + by);
    rev.value++;
}

/** Back to the newest `WINDOW` items: a session closed and opened again starts where the reader would expect. */
export function resetWindow(key: string): void {
    if (!shown.has(key)) return;
    shown.delete(key);
    rev.value++;
}

/** What each session is holding back as it last drew, so `reveal` knows whether growing the window can still help. */
const held = new Map<string, number>();

/** How many of this session's items are held back right now, as it last drew. */
export const hiddenFor = (key: string): number => held.get(key) ?? 0;

/** The items a transcript draws, and how many it is holding back. */
export function tail<T>(items: T[], key: string): { drawn: T[]; hidden: number } {
    const n = shownFor(key);
    const hidden = Math.max(0, items.length - n);
    held.set(key, hidden);
    return { drawn: hidden ? items.slice(items.length - n) : items, hidden };
}

/** The scrollable ancestor of an element: what a transcript is drawn inside, whichever surface it is. */
function scrollerOf(el: Element | null): Element | null {
    for (let p = el?.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
}

/**
 * Keep the reading position while items are added ABOVE what is on screen. Returns the function to call once they are
 * drawn. WebKit has no scroll anchoring, so a phone would otherwise jump to a different part of the conversation every
 * time it drew more of it.
 */
export function holdPosition(el: Element | null): () => void {
    const scroller = scrollerOf(el);
    const before = scroller?.scrollHeight ?? 0;
    const at = scroller?.scrollTop ?? 0;
    return () => {
        if (!scroller) return;
        scroller.scrollTop = at + (scroller.scrollHeight - before);
    };
}

/** What `reveal` did, for the caller to say where the click was. */
export type Revealed = "shown" | "loading" | "gone";

/**
 * Make the thing `find` looks for drawable, then hand it back. In order: it is already in the DOM; it is held but
 * outside the window (grow, wait a frame, look again); it is older than what is loaded (ask the host for the page
 * before, then look again, until the host says there is no more). `gone` means every one of those was tried.
 */
export async function reveal(key: string, find: () => Element | null): Promise<Revealed> {
    const frame = (): Promise<void> => new Promise((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
    if (find()) return "shown";
    // Grow a window at a time rather than opening the whole session: a reference near the end of a long run should
    // cost what it needs and no more.
    for (let grows = 0; hiddenFor(key) > 0 && grows < 200; grows++) {
        growWindow(key);
        await frame();
        if (find()) return "shown";
    }
    const earlier = services().loadEarlier;
    if (!earlier) return "gone";
    // Page back until it turns up or the session's history runs out. Each page re-renders the transcript, and the
    // window is open, so a found step is drawn by the time the next frame lands.
    for (let pages = 0; pages < 100; pages++) {
        const r = await earlier(key);
        // The page lands ABOVE everything drawn, so the window has to take it in for the step to exist at all.
        for (let grows = 0; hiddenFor(key) > 0 && grows < 200; grows++) {
            growWindow(key);
            await frame();
            if (find()) return "shown";
        }
        await frame();
        if (find()) return "shown";
        if (!r.more) return "gone";
    }
    return "gone";
}

/** The control above a windowed transcript: how much is not drawn, and the way to draw more of it. */
export function EarlierInThread({ sessionKey, hidden }: { sessionKey: string; hidden: number }) {
    if (hidden <= 0) return null;
    const more = Math.min(hidden, WINDOW);
    const show = (e: Event): void => {
        const restore = holdPosition((e.currentTarget as Element).parentElement);
        growWindow(sessionKey, WINDOW);
        // After the added items are drawn, put the reader back where they were reading.
        setTimeout(restore, 0);
    };
    return (
        <div class="chat-window-edge">
            <button class="chat-earlier-retry" onClick={show}>Show {more} earlier</button>
            <span class="chat-window-rest">{hidden} earlier in this session</span>
        </div>
    );
}
