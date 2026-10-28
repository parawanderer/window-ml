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
import { DOCK_DEFAULT, readDock, type DockLayout } from "./dock-layout";
import { signal } from "@preact/signals";
import { IconBrain, IconMenu } from "../sidebar/icons";
import { focusMode, groupAllTools } from "../sidebar/store";
import type { PlatformPrefs } from "./platform";
import { CODE_DEFAULT, CODE_SIZES } from "../native/text-size";
import { placePins } from "./pin-order";
import { hasBaseline, markSeen, readStateFrom, type ReadState } from "./read-marks";

/** Preference keys, under the platform's own namespace. */
export const CALM_KEY = "view.calm", LIST_KEY = "view.list", FOLDED_KEY = "view.folded", PANE_KEY = "view.pane", PINNED_KEY = "view.pinned", READ_KEY = "view.read", PINNED_MODELS_KEY = "view.pinnedModels", CODE_KEY = "view.codeSize", GROUP_ALL_KEY = "view.groupAll", LOG_OPEN_KEY = "view.log", STATE_OPEN_KEY = "view.state", DOCK_KEY = "view.dock", PANEL_FS_KEY = "view.panelSize", DISMISSED_KEY = "view.dismissed", TAB_GROUPS_KEY = "view.tabGroups", THEME_KEY = "view.theme", TARGET_KEY = "view.target", KEYS_KEY = "view.keys";

/** Is the page in calm view? Read it in a render to re-render when it changes. */
export const calm = signal(true);

/** Is the session list pane open? Only a wide layout asks: a phone shows one pane at a time either way. */
export const listOpen = signal(true);

/** Fold EVERY run of tool calls into one row, not only a run of the same tool. On unless this device turned it off
 *  (`installViewPrefs` says why). Mirrored onto the shared signal the session views read. */
export function setGroupAll(on: boolean): void {
    groupAllTools.value = on;
    store?.set(GROUP_ALL_KEY, on);
}

/**
 * What the pane on the RIGHT is showing, if anything.
 *
 * One slot, named rather than a boolean, because it has more than one tenant coming: the resource panel is the
 * first, and the state inspector — the run's current context and pointer heap, beside the transcript rather than
 * instead of it — is the one the pane is really shaped for (docs/spec/CHAT_PAGE.md §The state inspector).
 */
export const pane = signal<"resource" | null>(null);

/**
 * Is the open run's EXECUTION LOG showing? What the machinery did underneath a run — the tab that was discarded
 * and reloaded, the CDP attach that was refused — which its steps cannot say (run-log.ts).
 *
 * Remembered per device, like the pane above: it is a choice about how this screen is laid out for working, not
 * something to re-make on every reload. It follows whichever session is open rather than being pinned to a run,
 * because the question it answers ("what happened under THIS") is always about what is being read.
 */
export const logOpen = signal<boolean>(false);

/** Is the open run's RUN STATE showing (the state inspector)? Remembered per device and following the open session,
 *  like the execution log beside it. */
export const stateOpen = signal<boolean>(false);

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
 * What this device has seen of each session (read-marks.ts): the baseline, taken the first time this device loaded
 * it, and the newest event of each session that has been on screen here. A session is unread when it moved after
 * both, and is not the one open. Stored (`view.read`), so it survives a reload and closing the app.
 *
 * THIS DEVICE'S, like the pins: the phone that was in a pocket has not seen what the laptop showed.
 */
export const readState = signal<ReadState>({ since: Date.now(), seen: {} });

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

export type { DockSide, DockPanelId, DockLayout } from "./dock-layout";
/** This device's dock layout (dock-layout.ts says what it holds and how it changes). */
export const dockLayout = signal<DockLayout>(DOCK_DEFAULT);

/** Change the dock layout, and keep it. */
export function setDockLayout(next: DockLayout): void {
    dockLayout.value = next;
    store?.set(DOCK_KEY, next);
}

let store: PlatformPrefs | null = null;

/** Mirror `calm` onto the document, where the shared views' own reading rules already live. */
function applyCalm(): void {
    try {
        document.documentElement.toggleAttribute("data-focus", calm.value);
        // `data-calm` SAYS WHICH PRODUCT THIS IS, where `data-focus` only says "quieten the chrome". The panel's
        // focus mode sets the second and not the first, so a developer who turned the noise down there keeps the
        // approval gate they were working with instead of being handed the reading view's card.
        document.documentElement.toggleAttribute("data-calm", calm.value);
    } catch { /* no DOM (a unit test) */ }
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
    // ON unless this device said otherwise. Calm view's whole claim is that you read the conversation and reach
    // for the machinery, and the conservative fold rule leaves a reading view full of rows nobody asked to see;
    // someone who wants every call has the detailed view, which is what it is for. A device that turned it OFF
    // keeps that — only the absence of an answer is what changed meaning.
    const ga = prefs.get<boolean>(GROUP_ALL_KEY);
    groupAllTools.value = ga !== false;
    logOpen.value = prefs.get<boolean>(LOG_OPEN_KEY) === true;
    stateOpen.value = prefs.get<boolean>(STATE_OPEN_KEY) === true;
    const pn = prefs.get<string>(PANE_KEY);
    pane.value = pn === "resource" ? pn : null;
    const f = prefs.get<string[]>(FOLDED_KEY);
    foldedRuntimes.value = new Set(Array.isArray(f) ? f.filter((x) => typeof x === "string") : []);
    const p = prefs.get<string[]>(PINNED_KEY);
    pinned.value = new Set(Array.isArray(p) ? p.filter((x) => typeof x === "string") : []);
    const rawRead = prefs.get<unknown>(READ_KEY);
    readState.value = readStateFrom(rawRead, Date.now());
    // The baseline is taken ONCE: stored now, so the next load (and a stored mark from before it existed) finds it.
    if (!hasBaseline(rawRead)) prefs.set(READ_KEY, readState.value);
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
    lastTargets.value = targetsFrom(prefs.get<unknown>(TARGET_KEY));
    keyUse.value = keyUseFrom(prefs.get<unknown>(KEYS_KEY));
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

/** Where a run was last sent on a runtime, as picked in the start page's "Where it runs": an open tab, by its id and
 *  the address it showed then, or a new tab. */
export type RememberedTarget = { tabId: number; url: string } | { blank: true };

/** The last target PICKED on each runtime (by runtime id), so a reloaded start page offers it again while that tab is
 *  still open. Only a pick someone made is kept: the start page's own first guess (the tab in front) never is. */
export const lastTargets = signal<Record<string, RememberedTarget>>({});

/** Remember the target just picked on `runtime`. */
export function rememberTarget(runtime: string, t: RememberedTarget): void {
    lastTargets.value = { ...lastTargets.value, [runtime]: t };
    store?.set(TARGET_KEY, lastTargets.value);
}

/** The stored map, keeping only entries of a shape this code wrote. */
export function targetsFrom(v: unknown): Record<string, RememberedTarget> {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, RememberedTarget> = {};
    for (const [rt, t] of Object.entries(v as Record<string, unknown>)) {
        const o = t as { tabId?: unknown; url?: unknown; blank?: unknown } | null;
        if (o && o.blank === true) out[rt] = { blank: true };
        else if (o && typeof o.tabId === "number" && typeof o.url === "string") out[rt] = { tabId: o.tabId, url: o.url };
    }
    return out;
}

/** How often this device has used the composer's keys: Enter to send, and Shift+Enter for a new line. */
export interface KeyUse { sends: number; newlines: number }

/** This device's key use so far, counted until it {@link knowsKeys}; then the "Enter to send" hint is not drawn. */
export const keyUse = signal<KeyUse>({ sends: 0, newlines: 0 });

/** Sends by Enter, with at least one Shift+Enter, that say someone has the keys; or sends alone, for someone who
 *  never writes a second line and so never needs the other half. */
export const KEYS_SENDS = 3, KEYS_SENDS_ALONE = 10;

/** Has this device shown it knows how the box sends? Then the hint saying so has done its job. */
export const knowsKeys = (u: KeyUse): boolean => (u.sends >= KEYS_SENDS && u.newlines >= 1) || u.sends >= KEYS_SENDS_ALONE;

/** Count one use of a key the hint describes. Counting stops once the hint is retired. */
export function noteKeyUse(key: "send" | "newline"): void {
    const u = keyUse.value;
    if (knowsKeys(u)) return;
    keyUse.value = key === "send" ? { ...u, sends: u.sends + 1 } : { ...u, newlines: u.newlines + 1 };
    store?.set(KEYS_KEY, keyUse.value);
}

/** The stored count, zero for anything else. */
function keyUseFrom(v: unknown): KeyUse {
    const o = v as Partial<KeyUse> | null;
    const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
    return { sends: n(o?.sends), newlines: n(o?.newlines) };
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

/** Open or close the open run's execution log. */
export function setLogOpen(on: boolean): void {
    logOpen.value = on;
    store?.set(LOG_OPEN_KEY, on);
}

/** Open or close the open run's state. */
export function setStateOpen(on: boolean): void {
    stateOpen.value = on;
    store?.set(STATE_OPEN_KEY, on);
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

/** Put the pins the Pinned section shows in this order, on this device (`placePins`). */
export function orderPins(keys: readonly string[]): void {
    const out = placePins(pinned.value, keys);
    pinned.value = new Set(out);
    store?.set(PINNED_KEY, out);
}

/** Record that this device has shown session `key` up to its event at `lastTs`; a no-op (and no write) if it had. */
export function markRead(key: string, lastTs: number): void {
    const next = markSeen(readState.value, key, lastTs);
    if (next === readState.value) return;
    readState.value = next;
    store?.set(READ_KEY, next);
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
