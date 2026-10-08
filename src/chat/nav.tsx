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
import { IconBrain, IconCompose, IconDock, IconFold, IconGear, IconMenu, IconSearch } from "../sidebar/icons";
import { MenuGroup, MenuItem } from "./menu";
import { benchOpen, groupAllTools, openBench, view } from "../sidebar/store";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { StartMenu, type StartKind } from "./new-session";
import { calm, logOpen, pane, setCalm, setGroupAll, setListOpen, setLogOpen, setPane, setStateOpen, stateOpen } from "./view-mode";
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
 */
export function GearMenu({ graphsRt, benchRt, logRt, stateRt, labelled }: {
    graphsRt?: RuntimeInfo; benchRt?: RuntimeInfo; logRt?: RuntimeInfo; stateRt?: RuntimeInfo; labelled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const pick = (run: () => void) => () => { setOpen(false); run(); };
    // The menu stays drawn for one beat after the click that closed it, so choosing something eases the sheet
    // away instead of deleting it between two frames.
    const { show, closing } = useDismiss(open);
    return (
        <div class="chat-gear" ref={wrap}>
            {show ? (
                <div class={`chat-menu chat-gear-menu${closing ? " leaving" : ""}`} role="menu" aria-label="Page menu">
                    {/* HOW MUCH OF THE MACHINERY YOU SEE WHILE READING — the two rows that answer that, under one
                        head. They were loose at the top level, where "Calm view" and a folding toggle read as two
                        unrelated switches rather than the coarse and fine of one choice. The group says which
                        view is on in its own row, so the mode is still legible without opening it. */}
                    <MenuGroup icon={<IconBrain />} label="Reading" detail={calm.value ? "Calm" : "Detailed"}>
                        {(sub) => <>
                            <MenuItem sub={{ i: 0, open: sub }} icon={null} label="Calm view" note="the conversation, with the machinery one hover away"
                                on={calm.value} onPick={pick(() => setCalm(!calm.value))} />
                            {/* SHOWN AND DISABLED outside calm, not hidden: "is this only available in calm view?"
                                is a question the menu should answer, and a row that vanishes answers it by making
                                you wonder whether you imagined it. `note` carries the reason, which is what that
                                slot is for. */}
                            <MenuItem sub={{ i: 1, open: sub }} icon={null} label="Group all tool calls"
                                note={calm.value ? "one row per run of work" : "only in Calm view — the detailed view is the one that shows every call"}
                                off={!calm.value} on={groupAllTools.value} onPick={pick(() => setGroupAll(!groupAllTools.value))} />
                        </>}
                    </MenuGroup>
                    {/* THE PANELS TOGETHER, under one row. These two are a different kind of thing from the rows
                        around them: not how the page reads or what it is set to, but an extra surface opened ONTO a
                        runtime — so each needs to say which device it would open on, and neither belongs beside
                        "Calm view". Grouped, the device is said once by the rows themselves and the menu's top level
                        stays four plain choices. Drawn with the same opening row as the theme choices, because a
                        second disclosure that animated differently is how a menu ends up with two of them. */}
                    {graphsRt || benchRt || logRt || stateRt ? (
                        <MenuGroup icon={<IconDock side="right" />} label="Panels">
                            {(sub) => <>
                                {graphsRt ? <MenuItem sub={{ i: 0, open: sub }} icon={null} label="Models and memory" detail={graphsRt.name} on={pane.value === "resource"} onPick={pick(() => setPane(pane.value === "resource" ? null : "resource"))} /> : null}
                                {benchRt ? <MenuItem sub={{ i: 1, open: sub }} icon={null} label="Python bench" detail={benchRt.name} on={benchOpen.value} onPick={pick(() => (benchOpen.value ? (benchOpen.value = false) : openBench()))} /> : null}
                                {/* Named for what it is rather than for the run it happens to be showing: it
                                    follows whatever session is open, so a title naming one would go stale the
                                    moment someone clicked another. */}
                                {logRt ? <MenuItem sub={{ i: 2, open: sub }} icon={null} label="Execution log" detail={logRt.name} on={logOpen.value} onPick={pick(() => setLogOpen(!logOpen.value))} /> : null}
                                {stateRt ? <MenuItem sub={{ i: 3, open: sub }} icon={null} label="Run state" detail={stateRt.name} on={stateOpen.value} onPick={pick(() => setStateOpen(!stateOpen.value))} /> : null}
                            </>}
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
