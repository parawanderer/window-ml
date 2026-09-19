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
import type { RuntimeInfo } from "../session-host";
import { IconBench, IconBrain, IconCompose, IconGear, IconMenu, IconSearch, IconVram } from "../sidebar/icons";
import { MenuItem } from "./menu";
import { benchOpen, openBench } from "../sidebar/store";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { StartMenu, type StartKind } from "./new-session";
import { calm, pane, setCalm, setListOpen, setPane } from "./view-mode";

/** What the MAIN pane shows instead of a session: the search page, this device's settings, or the attention list. Not
 *  stored as a preference: it lives in the URL (route.ts), so a reload keeps it and a fresh page does not. */
export const mainView = signal<"search" | "settings" | "attention" | null>(null);

/** Open the search page (and close any session-level view that would sit on top of it). */
export function openSearch(): void { mainView.value = "search"; }

/**
 * Escape closes a sheet (the search page, Settings) from ANYWHERE on it, not only from a focused input: clicking a
 * date or the page's margin took focus away and left no key that closed it. `own` is an input that handles Escape
 * itself first (the search box clears what was typed), and a menu or dialog open over the sheet gets the key instead.
 */
export function useEscapeCloses(own?: { current: Element | null }): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented || (own && e.target === own.current)) return;
            if (document.querySelector(".chat-menu, .chat-dialog")) return;
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
            <button class={`tt hbtn${mainView.value === "search" ? " on" : ""}`} aria-label="Search sessions" onClick={openSearch}>
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
export function GearMenu({ graphsRt, benchRt, labelled }: {
    graphsRt?: RuntimeInfo; benchRt?: RuntimeInfo; labelled?: boolean;
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
    return (
        <div class="chat-gear" ref={wrap}>
            {open ? (
                <div class="chat-menu chat-gear-menu" role="menu" aria-label="Page menu">
                    <MenuItem icon={<IconBrain />} label="Calm view" on={calm.value} onPick={pick(() => setCalm(!calm.value))} />
                    {graphsRt ? <MenuItem icon={<IconVram />} label={`What ${graphsRt.name} is running`} on={pane.value === "resource"} onPick={pick(() => setPane(pane.value === "resource" ? null : "resource"))} /> : null}
                    {benchRt ? <MenuItem icon={<IconBench />} label="Python bench" on={benchOpen.value} onPick={pick(() => (benchOpen.value ? (benchOpen.value = false) : openBench()))} /> : null}
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
