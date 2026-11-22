// nav.tsx — the page's NAVIGATION CHROME, Gemini's shape: a slim rail down the left edge when the session list is
// hidden (open the list, start something, search), and one gear at the bottom-left that opens a menu of everything
// that is not a session — how the page reads, this device's own views, and the settings.
//
// It replaced a band across the top and, after that, a `⋮` floating bottom-right: the page's tools now live in ONE
// place, the edge where navigation lives on every product that does this well, and the canvas is left to the words.
import { ThemeMenu } from "./theme-pick";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { RuntimeInfo, SessionKey } from "../session/session-host";
import { IconBench, IconBrain, IconCompose, IconDock, IconFold, IconGear, IconLog, IconMenu, IconRows, IconSearch, IconVram } from "../sidebar/icons";
import { MenuGroup, MenuItem, MenuSection, closeFlyout, flyoutIsOpen, sectionsByRuntime } from "./menu";
import { benchOpen, openBench, view } from "../sidebar/store";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { StartMenu, type StartKind } from "./new-session";
import { calm, logOpen, pane, setCalm, setListOpen, setLogOpen, setPane, setStateOpen, stateOpen } from "./view-mode";
import { useDismiss } from "../sidebar/use-dismiss";

/** What the MAIN pane shows instead of a session: the search page, this device's settings, or the attention list. Not
 *  stored as a preference: it lives in the URL (route.ts), so a reload keeps it and a fresh page does not. */
export const mainView = signal<"search" | "settings" | "attention" | null>(null);

/** Which device the search page is looking on, or null for every one of them.
 *
 *  Not in the URL, unlike `mainView`: the rest of that page's filter state is not either, and this is set when the
 *  page is OPENED rather than carried around. That is what makes the two ways in differ correctly — a runtime's own
 *  "Older sessions" arrives looking at that runtime, and the header's search button arrives looking everywhere
 *  instead of inheriting whichever row was clicked last. */
export const searchDevice = signal<string | null>(null);

/**
 * Open the search page (and close any session-level view that would sit on top of it).
 *
 * `runtime` preselects the device filter. Call it as `() => openSearch()` from an event handler, never by passing
 * the function itself: a handler would hand the MouseEvent over as the runtime, and the filter would quietly match
 * nothing.
 */
export function openSearch(runtime?: string): void {
    searchDevice.value = runtime ?? null;
    mainView.value = "search";
}

/**
 * Escape closes a sheet (the search page, Settings) from ANYWHERE on it, not only from a focused input: clicking a
 * date or the page's margin took focus away and left no key that closed it. `own` is an input that handles Escape
 * itself first (the search box clears what was typed), and a menu or dialog open over the sheet gets the key instead.
 */
export function useEscapeCloses(own?: { current: Element | null }): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented || (own && e.target === own.current)) return;
            // `:not(.leaving)` for the same reason the dock's guard has it: a menu animating away (use-dismiss.ts)
            // is still in the DOM and must not swallow the Escape meant for the sheet underneath it.
            if (document.querySelector(".chat-menu:not(.leaving), .chat-dialog")) return;
            mainView.value = null;
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);
}

/** The rail: what the list's header offers, stacked down the edge while the list itself is away. */
export function Rail({ store, onStart, gear }: { store: ChatStore; onStart: (kind: StartKind) => void; gear: ComponentChildren }) {
    return (
        <nav class="chat-rail" aria-label="Navigation">
            <button class="tt hbtn" aria-label="Show the session list" onClick={() => setListOpen(true)}>
                <IconMenu /><span class="tt-pop" role="tooltip">Show the session list</span>
            </button>
            <StartMenu store={store} onPick={onStart} icon={<IconCompose />} />
            <button class={`tt hbtn${mainView.value === "search" ? " on" : ""}`} aria-label="Search sessions" onClick={() => openSearch()}>
                <IconSearch /><span class="tt-pop" role="tooltip">Search sessions</span>
            </button>
            <span class="sp" />
            {gear}
        </nav>
    );
}

/**
 * The gear and its menu: everything on the page that is not a session.
 *
 * Each device view appears only where the runtime reports the capability AND this device can draw it (`ChatExtras`),
 * the same double question the rest of the page asks. `graphsRt` and `benchRt` are the runtimes those views would
 * describe, already asked both questions by the caller: the open session's where it offers the view, otherwise the
 * first that does. Settings is always offered, because the page's own display settings need no runtime.
 *
 * "Panels" and "Theme for this page" are groups: on a wide layout each opens a flyout beside the menu, on a phone it
 * slides over the menu (`MenuGroup`). Panels are listed under the name of the runtime each opens on.
 *
 * @group chat, menus
 * @gallery-flow theme flyout tests/gallery-flows/GearMenu.mjs {"labelled": true, "graphsRt": {"id": "mlbox", "name": "mlbox"}, "benchRt": {"id": "browser", "name": "This browser"}, "logRt": {"id": "browser", "name": "This browser"}, "stateRt": {"id": "browser", "name": "This browser"}}
 * @gallery-flow panels flyout tests/gallery-flows/GearMenuPanels.mjs {"labelled": true, "graphsRt": {"id": "mlbox", "name": "mlbox"}, "benchRt": {"id": "browser", "name": "This browser"}, "logRt": {"id": "browser", "name": "This browser"}, "stateRt": {"id": "browser", "name": "This browser"}}
 */
export function GearMenu({ graphsRt, benchRt, logRt, stateRt, labelled }: {
    graphsRt?: RuntimeInfo; benchRt?: RuntimeInfo; logRt?: RuntimeInfo; stateRt?: RuntimeInfo; labelled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        // A flyout is drawn outside `wrap` (it has to escape the list's clip), so a press in one is still a press in the menu.
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".chat-menu-flyout")) setOpen(false); };
        // Escape closes a flyout first and the menu on the second press.
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (flyoutIsOpen()) closeFlyout(); else setOpen(false); } };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); closeFlyout(); };
    }, [open]);
    const pick = (run: () => void) => () => { setOpen(false); run(); };
    // The menu stays drawn for one beat after the click that closed it, so choosing something eases the sheet
    // away instead of deleting it between two frames.
    const { show, closing } = useDismiss(open);
    return (
        <div class="chat-gear" ref={wrap}>
            {show ? (
                <div class={`chat-menu chat-gear-menu${closing ? " leaving" : ""}`} role="menu" aria-label="Page menu">
                    {/* CALM VIEW is the one reading choice that belongs at the top level: it is the coarse switch, and
                        its fine one ("Group all tool calls") lives in Settings → This page with the page's other
                        display preferences, where a switch that only applies inside calm view can say so. */}
                    <MenuItem icon={<IconBrain />} label="Calm view"
                        on={calm.value} onPick={pick(() => setCalm(!calm.value))} />
                    {/* THE PANELS TOGETHER, under one row. These two are a different kind of thing from the rows
                        around them: not how the page reads or what it is set to, but an extra surface opened ONTO a
                        runtime — so each needs to say which device it would open on, and neither belongs beside
                        "Calm view". Grouped, the device is said once, as each section's header, and the menu's top level
                        stays four plain choices. Drawn with the same opening row as the theme choices, because a
                        second disclosure that animated differently is how a menu ends up with two of them. */}
                    {graphsRt || benchRt || logRt || stateRt ? (
                        <MenuGroup icon={<IconDock side="right" />} label="Panels">
                            {(sub) => {
                                // One section per device, its name said once as the header: a panel is opened ONTO a
                                // runtime, and the same name on every row said it four times. The rows keep their
                                // device for a screen reader through their section's label.
                                const rows = [
                                    graphsRt && { rt: graphsRt, label: "Models and memory", icon: <IconVram />, on: pane.value === "resource", run: () => setPane(pane.value === "resource" ? null : "resource") },
                                    benchRt && { rt: benchRt, label: "Python bench", icon: <IconBench />, on: benchOpen.value, run: () => (benchOpen.value ? (benchOpen.value = false) : openBench()) },
                                    // Named for what it is rather than for the run it happens to be showing: it
                                    // follows whatever session is open, so a title naming one would go stale the
                                    // moment someone clicked another.
                                    logRt && { rt: logRt, label: "Execution log", icon: <IconLog />, on: logOpen.value, run: () => setLogOpen(!logOpen.value) },
                                    stateRt && { rt: stateRt, label: "Run state", icon: <IconRows />, on: stateOpen.value, run: () => setStateOpen(!stateOpen.value) },
                                ].filter((r): r is NonNullable<typeof r> => !!r);
                                let i = 0;
                                return sectionsByRuntime(rows).map((sec) => (
                                    <MenuSection key={sec.rt.id ?? sec.rt.name} name={sec.rt.name}>
                                        {sec.rows.map((r) => <MenuItem key={r.label} sub={{ i: i++, open: sub }} icon={r.icon} label={r.label} on={r.on} onPick={pick(r.run)} />)}
                                    </MenuSection>
                                ));
                            }}
                        </MenuGroup>
                    ) : null}
                    <ThemeMenu />
                    <MenuItem icon={<IconGear />} label="Settings" onPick={pick(() => { mainView.value = "settings"; })} />
                </div>
            ) : null}
            {/* Named where there is room for a word (the open list's foot), a glyph alone on the rail. */}
            <button class={`${labelled ? "chat-gear-wide" : "tt hbtn"} chat-gear-btn${open ? " on" : ""}`} aria-label="Page menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                <IconGear />{labelled ? <span>Views &amp; settings</span> : <span class="tt-pop" role="tooltip">Views &amp; settings</span>}
            </button>
        </div>
    );
}

/** Open a session: the one navigation the page has. */
export const openSession = (key: SessionKey) => { view.value = { name: "detail", hash: key }; };
