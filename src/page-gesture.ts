// page-gesture.ts — whether the person just acted on the page itself: the gesture `ml.requestAccess` needs (Q11).
//
// docs/spec/SITE_ACCESS_SLICE3.md Q11. User activation spreads to ancestor frames, so a click on our own card's iframe
// would give the page an activation it could spend on a request. A gesture counts only when the browser says the page
// is active AND the content script saw a trusted pointerdown or keydown on the page's own document, outside the hosts
// the extension put there, in the last few seconds. The listeners are registered at document_start, before any page
// script, on the isolated world's `window`, which the page cannot reach. The shell marks its hosts here (`markOwnHost`):
// both content scripts share the isolated world, and its global is where the set lives.

/** How recent the trusted input must be. Chrome's transient activation lasts about as long. */
const GESTURE_MS = 5000;

const KEY = "__mlOwnHosts";   // a property of the isolated world's global, which no page script reaches

/** The extension's own hosts in this document, made on first use. */
function ownHosts(): WeakSet<EventTarget> {
    const g = globalThis as unknown as Record<string, WeakSet<EventTarget> | undefined>;
    return (g[KEY] ??= new WeakSet());   // state: plumbing
}

/**
 * Mark an element the extension put into the page, so input on it is not the page's gesture.
 * @param el the host
 */
export function markOwnHost(el: EventTarget): void { ownHosts().add(el); }

let lastInput = -Infinity;   // state: plumbing (the time of the last trusted input on the page's own document)

/** Start watching for the page's own trusted input. Called once, at document_start. */
export function watchGestures(): void {
    const note = (e: Event): void => {
        if (!e.isTrusted) return;
        const hosts = ownHosts();
        if (e.composedPath().some((n) => hosts.has(n))) return;
        lastInput = performance.now();
    };
    for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, note, { capture: true });
}

/**
 * Whether the person acted on the page itself just now (Q11): the browser's transient activation, and a trusted
 * input on the page's own document within `GESTURE_MS`.
 * @returns true for a gesture the page may spend
 */
export function hasPageGesture(): boolean {
    try {
        return (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation?.isActive === true
            && performance.now() - lastInput < GESTURE_MS;
    } catch { return false; }   // no way to tell is no gesture
}
