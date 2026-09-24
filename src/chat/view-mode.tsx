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
import { focusMode } from "../sidebar/store";
import type { PlatformPrefs } from "./platform";

/** Preference keys, under the platform's own namespace. */
export const CALM_KEY = "view.calm", LIST_KEY = "view.list", FOLDED_KEY = "view.folded", PANE_KEY = "view.pane", PINNED_KEY = "view.pinned", PINNED_MODELS_KEY = "view.pinnedModels", CODE_KEY = "view.codeSize", DOCK_KEY = "view.dock", PANEL_FS_KEY = "view.panelSize", DISMISSED_KEY = "view.dismissed", TAB_GROUPS_KEY = "view.tabGroups", THEME_KEY = "view.theme";

/** Is the page in calm view? Read it in a render to re-render when it changes. */
export const calm = signal(true);

/** Is the session list pane open? Only a wide layout asks: a phone shows one pane at a time either way. */
export const listOpen = signal(true);

/**
 * What the pane on the RIGHT is showing, if anything.
 *
 * One slot, named rather than a boolean, because it has more than one tenant coming: the resource panel is the
 * first, and the state inspector — the run's current context and pointer heap, beside the transcript rather than
 * instead of it — is the one the pane is really shaped for (docs/spec/CHAT_PAGE.md §The state inspector).
 */
export const pane = signal<"resource" | null>(null);

/** Runtimes whose group in the list is folded away. By id, so a runtime that goes offline and comes back stays as
 *  it was left, and one this device has never seen starts open. */
export const foldedRuntimes = signal<ReadonlySet<string>>(new Set());

/**
 * Sessions pinned to the top of the list, by session key (`runtime:hash`).
 *
 * THIS DEVICE'S, like the rest of this file: a pin says which conversations someone keeps coming back to on this
 * screen, and the phone is allowed a different answer. What a pin cannot do from here is stop the runtime forgetting
 * the session — its index keeps a bounded number and drops the oldest finished ones — so a pinned key whose session
 * is gone simply draws nothing, and stays stored in case the session comes back (an offline runtime reconnecting).
 */
export const pinned = signal<ReadonlySet<string>>(new Set());

/**
 * Models kept at the top of every model list, by id.
 *
 * THIS DEVICE'S, like the session pins above, and for the same reason: which models someone reaches for is a fact
 * about how they work on this screen, not about the runtime — the box offering forty of them has no opinion, and the
 * phone is allowed a different shortlist from the laptop. Several, not one favourite, because the question is
 * usually "which three do I actually use" rather than "which one".
 *
 * A pinned id that no runtime offers draws nothing and stays stored: the model may be on a box that is offline, or
 * unloaded, and forgetting the pin because the list is momentarily short would lose it for good.
 */
export const pinnedModels = signal<ReadonlySet<string>>(new Set());

/**
 * The size code is set at on this page, in px: transcript code blocks, the Python bench's editor and what it prints.
 *
 * A setting rather than a constant because it is the one size here that people disagree about. The page reads prose
 * at 15px, and code inherited that — a monospace face nearly the size of the prose stops reading as an inset, and the
 * bench, built for the DevTools panel's 12px, came out a size and a half too big. The default is the panel's code
 * size, near enough; someone reading at arm's length can raise it without the prose moving.
 */
export const CODE_SIZES = [{ px: 11, label: "Small" }, { px: 12.5, label: "Default" }, { px: 14, label: "Large" }, { px: 15.5, label: "Larger" }] as const;
/** The default code size, in px. */
export const CODE_DEFAULT = 12.5;
/** The code size this device reads at, in px. */
export const codeSize = signal<number>(CODE_DEFAULT);

/**
 * The base size of the DOCKED PANELS (the resource panel, the bench's chrome, their tab bars), in px.
 *
 * Those panels were built for the DevTools panel's 12px base and size everything off `--fs`; docked in this page they
 * inherited its 15px reading size and came out a quarter too big — a chart's labels, legends and rows crowding a
 * region you want to be a strip. The default is the DevTools panel's own size, so a panel reads the same in both
 * places; the page's reading size is the largest choice, for someone who wants them to match the prose.
 */
export const PANEL_SIZES = [{ px: 11, label: "Small" }, { px: 12, label: "Default" }, { px: 13.5, label: "Large" }, { px: 15, label: "Page size" }] as const;
/** The default docked-panel size, in px: the DevTools panel's base. */
export const PANEL_FS_DEFAULT = 12;
/** The docked panels' base size on this device, in px. */
export const panelSize = signal<number>(PANEL_FS_DEFAULT);

/** An edge of the reading column a panel can be docked to. */
export type DockSide = "top" | "right" | "bottom" | "left";
/** The panels the page can dock: the box's resource panel and the Python bench. */
export type DockPanelId = "resource" | "bench";
/** Where each panel is docked, how big each edge's region is, and which tab each edge is showing. */
export interface DockLayout {
    side: Record<DockPanelId, DockSide>;
    /** px: a height for top and bottom, a width for left and right */
    size: Record<DockSide, number>;
    active: Partial<Record<DockSide, DockPanelId>>;
}
/** The graphs across the top, because a timeline is wide and short; the bench underneath, where a drawer is. */
export const DOCK_DEFAULT: DockLayout = {
    side: { resource: "top", bench: "bottom" },
    size: { top: 300, bottom: 320, left: 380, right: 420 },
    active: {},
};
const SIDES: readonly DockSide[] = ["top", "right", "bottom", "left"];
/** This device's dock layout. */
export const dockLayout = signal<DockLayout>(DOCK_DEFAULT);

/** Read a stored layout, keeping only what is well formed: a stored value from an older build is a hint, not a
 *  contract, and one bad field must not cost the rest. */
function readDock(v: unknown): DockLayout {
    const o = (v && typeof v === "object" ? v : {}) as Partial<DockLayout>;
    const side = { ...DOCK_DEFAULT.side }, size = { ...DOCK_DEFAULT.size }, active: DockLayout["active"] = {};
    for (const id of Object.keys(side) as DockPanelId[]) if (SIDES.includes(o.side?.[id] as DockSide)) side[id] = o.side![id];
    for (const sd of SIDES) {
        const n = o.size?.[sd];
        if (typeof n === "number" && Number.isFinite(n) && n >= 64) size[sd] = n;
        const a = o.active?.[sd];
        if (a === "resource" || a === "bench") active[sd] = a;
    }
    return { side, size, active };
}

/** Change the dock layout, and keep it. */
export function setDockLayout(next: DockLayout): void {
    dockLayout.value = next;
    store?.set(DOCK_KEY, next);
}

let store: PlatformPrefs | null = null;

/** Mirror `calm` onto the document, where the shared views' own reading rules already live. */
function applyCalm(): void {
    try { document.documentElement.toggleAttribute("data-focus", calm.value); } catch { /* no DOM (a unit test) */ }
    // The shared views ask the STORE, not the document, whether they are being read quietly — a component cannot
    // re-render from an attribute. The panel's own focus toggle already sets this signal and derives the attribute
    // from it; calm is the same idea under another name, so it sets both and the two surfaces answer alike.
    focusMode.value = calm.value;
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
    const pn = prefs.get<string>(PANE_KEY);
    pane.value = pn === "resource" ? pn : null;
    const f = prefs.get<string[]>(FOLDED_KEY);
    foldedRuntimes.value = new Set(Array.isArray(f) ? f.filter((x) => typeof x === "string") : []);
    const p = prefs.get<string[]>(PINNED_KEY);
    pinned.value = new Set(Array.isArray(p) ? p.filter((x) => typeof x === "string") : []);
    const pm = prefs.get<string[]>(PINNED_MODELS_KEY);
    pinnedModels.value = new Set(Array.isArray(pm) ? pm.filter((x) => typeof x === "string") : []);
    dockLayout.value = readDock(prefs.get<DockLayout>(DOCK_KEY));
    const ps = prefs.get<number>(PANEL_FS_KEY);
    panelSize.value = PANEL_SIZES.some((x) => x.px === ps) ? ps! : PANEL_FS_DEFAULT;
    const cs = prefs.get<number>(CODE_KEY);
    codeSize.value = CODE_SIZES.some((x) => x.px === cs) ? cs! : CODE_DEFAULT;
    const th = prefs.get<string>(THEME_KEY);
    pageThemeMode.value = (PAGE_THEMES as readonly string[]).includes(th ?? "") ? th as PageThemeMode : "extension";
    const tg = prefs.get<Record<string, boolean>>(TAB_GROUPS_KEY);
    groupFolds.value = tg && typeof tg === "object" && !Array.isArray(tg)
        ? Object.fromEntries(Object.entries(tg).filter(([, v]) => typeof v === "boolean")) : {};
    const d = prefs.get<string[]>(DISMISSED_KEY);
    dismissed.value = new Set(Array.isArray(d) ? d.filter((x) => typeof x === "string") : []);
    applyCalm();
}

/** This page's theme: the extension's setting (the default), the system's, or one of its own. */
export const PAGE_THEMES = ["extension", "system", "light", "dark"] as const;
/** One of `PAGE_THEMES`: how this page picks light or dark. */
export type PageThemeMode = typeof PAGE_THEMES[number];
/** This page's theme choice, per device. The entry applies it (`pageTheme` in sidebar/prefs.ts). */
export const pageThemeMode = signal<PageThemeMode>("extension");

/** Choose this page's theme. */
export function setPageThemeMode(m: PageThemeMode): void {
    pageThemeMode.value = m;
    store?.set(THEME_KEY, m);
}

/**
 * Tab groups folded or opened in the tab picker, as `runtime:groupId` → folded. Only what someone CHANGED is here;
 * a group with no entry starts as the browser's strip has it. A group's id lasts until the browser restarts, so an
 * old entry is simply never matched again; the map is capped so those do not pile up.
 */
export const groupFolds = signal<Record<string, boolean>>({});

/** Remember a tab group folded or opened in the picker. */
export function setGroupFold(key: string, folded: boolean): void {
    const next = { ...groupFolds.value };
    delete next[key];
    next[key] = folded;
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete next[k];
    groupFolds.value = next;
    store?.set(TAB_GROUPS_KEY, next);
}

/** Suggestions put away on this device, as `runtime:code` (attention.ts). Only a suggestion can be; a problem stays. */
export const dismissed = signal<Set<string>>(new Set());

/** Put a suggestion away on this device. */
export function dismiss(key: string): void {
    if (dismissed.value.has(key)) return;
    const next = new Set(dismissed.value);
    next.add(key);
    dismissed.value = next;
    store?.set(DISMISSED_KEY, [...next]);
}

/** Set the docked panels' base size (one of `PANEL_SIZES`). */
export function setPanelSize(px: number): void {
    panelSize.value = px;
    store?.set(PANEL_FS_KEY, px);
}

/** Set the page's code size (one of `CODE_SIZES`). */
export function setCodeSize(px: number): void {
    codeSize.value = px;
    store?.set(CODE_KEY, px);
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

/** Show something in the right-hand pane, or close it. */
export function setPane(p: "resource" | null): void {
    pane.value = p;
    store?.set(PANE_KEY, p);
}

/** Fold a runtime's group away, or bring it back. */
export function toggleRuntime(id: string): void {
    const next = new Set(foldedRuntimes.value);
    if (!next.delete(id)) next.add(id);
    foldedRuntimes.value = next;
    store?.set(FOLDED_KEY, [...next]);
}

/** Pin a session to the top of the list, or unpin it. */
export function togglePin(key: string): void {
    const next = new Set(pinned.value);
    if (!next.delete(key)) next.add(key);
    pinned.value = next;
    store?.set(PINNED_KEY, [...next]);
}

/** Keep a model at the top of the lists on this device, or stop. */
export function togglePinnedModel(id: string): void {
    const next = new Set(pinnedModels.value);
    if (!next.delete(id)) next.add(id);
    pinnedModels.value = next;
    store?.set(PINNED_MODELS_KEY, [...next]);
}

/** Pin a session on this device (a no-op when it already is). */
export function addPin(key: string): void {
    if (pinned.value.has(key)) return;
    const next = new Set(pinned.value);
    next.add(key);
    pinned.value = next;
    store?.set(PINNED_KEY, [...next]);
}

/** Forget a pin whose session was deleted HERE: the person asked for it gone, so nothing should hold its key. */
export function dropPin(key: string): void {
    if (!pinned.value.has(key)) return;
    const next = new Set(pinned.value);
    next.delete(key);
    pinned.value = next;
    store?.set(PINNED_KEY, [...next]);
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
