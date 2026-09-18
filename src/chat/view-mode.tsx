// view-mode.ts — HOW MUCH OF THE MACHINERY THIS PAGE SHOWS, and whether the session list is open. Both are the
// device's preferences, not the runtime's: they say how someone wants to read, so they are stored per device
// (`ClientPlatform.prefs`) and never travel with a session.
//
// CALM is the page's default, and the reason this page exists. The DevTools panel is the developer's projection of a
// session — step numbers, model pills, raw argument trees, token counters — and rendering that at page scale gives a
// log viewer to read a conversation in. Calm hands the page over to the prose and puts the machinery one click away,
// which is what the shared `data-focus` attribute already does for the panel (src/sidebar/prefs.ts): calm SETS it,
// then chat.css does the part that only a whole page needs — a reading measure, a bubble for your own turn, and
// chrome that appears when the pointer asks for it.
//
// Nothing here removes anything. Every rule it turns on is a CSS hide over a document that still holds all of it, so
// search, copy, the exports and the toggle itself see one transcript — the standing rule that a run's raw,
// model-facing view may be quiet but never UNAVAILABLE (AGENTS.md §Showing a run).
import { signal } from "@preact/signals";
import { IconBrain, IconMenu } from "../sidebar/icons";
import type { PlatformPrefs } from "./platform";

/** Preference keys, under the platform's own namespace. */
export const CALM_KEY = "view.calm", LIST_KEY = "view.list", FOLDED_KEY = "view.folded";

/** Is the page in calm view? Read it in a render to re-render when it changes. */
export const calm = signal(true);

/** Is the session list pane open? Only a wide layout asks: a phone shows one pane at a time either way. */
export const listOpen = signal(true);

/** Runtimes whose group in the list is folded away. By id, so a runtime that goes offline and comes back stays as
 *  it was left, and one this device has never seen starts open. */
export const foldedRuntimes = signal<ReadonlySet<string>>(new Set());

let store: PlatformPrefs | null = null;

/** Mirror `calm` onto the document, where the shared views' own reading rules already live. */
function applyCalm(): void {
    try { document.documentElement.toggleAttribute("data-focus", calm.value); } catch { /* no DOM (a unit test) */ }
}

/** Seed both from this device's stored preferences, before the first render so the page never paints the other
 *  mode first, and keep writing them back. The entry calls it; a place with no stored answer gets the defaults. */
export function installViewPrefs(prefs: PlatformPrefs): void {
    store = prefs;
    // Assigned unconditionally, defaults included: installing IS the answer to "how does this device read", so a
    // stored value of the wrong shape (or none at all) means the default, never whatever was in the signal before.
    const c = prefs.get<boolean>(CALM_KEY);
    const l = prefs.get<boolean>(LIST_KEY);
    calm.value = typeof c === "boolean" ? c : true;
    listOpen.value = typeof l === "boolean" ? l : true;
    const f = prefs.get<string[]>(FOLDED_KEY);
    foldedRuntimes.value = new Set(Array.isArray(f) ? f.filter((x) => typeof x === "string") : []);
    applyCalm();
}

/** Switch views. */
export function setCalm(on: boolean): void {
    calm.value = on;
    applyCalm();
    store?.set(CALM_KEY, on);
}

/** Open or close the session list. */
export function setListOpen(on: boolean): void {
    listOpen.value = on;
    store?.set(LIST_KEY, on);
}

/** Fold a runtime's group away, or bring it back. */
export function toggleRuntime(id: string): void {
    const next = new Set(foldedRuntimes.value);
    if (!next.delete(id)) next.add(id);
    foldedRuntimes.value = next;
    store?.set(FOLDED_KEY, [...next]);
}

/** The page's own reading toggle, the twin of the DevTools panel's focus button (same glyph, because it is the
 *  same idea): calm is this surface's default, and the panel's is not. */
export function ViewToggle() {
    const on = calm.value;
    return (
        <button class={`tt hbtn chat-view-btn${on ? " on" : ""}`} aria-label="Calm view" aria-pressed={on} onClick={() => setCalm(!on)}>
            <IconBrain />
            <span class="tt-pop" role="tooltip">{on ? "Calm view on — show the step counters, model names, counters and controls" : "Calm view — the conversation, with the machinery one hover away"}</span>
        </button>
    );
}

/** Open or close the session list. Only on a wide layout: a phone shows one pane at a time, and there the list is
 *  a screen you go back to rather than a pane beside what you are reading. */
export function ListToggle({ narrow }: { narrow: boolean }) {
    if (narrow) return null;
    const open = listOpen.value;
    return (
        <button class="tt hbtn chat-list-btn" aria-label="Sessions" aria-expanded={open} onClick={() => setListOpen(!open)}>
            <IconMenu />
            <span class="tt-pop" role="tooltip">{open ? "Hide the session list" : "Show the session list"}</span>
        </button>
    );
}
