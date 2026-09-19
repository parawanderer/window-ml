// tab-picker.tsx — WHERE an agent run goes, picked the way you would find the tab yourself: "New tab" first, a rule, then
// the runtime's tabs in browser order, window by window, each group's members indented under the group, with the
// site's icon. It replaced a native <select> of truncated titles, which showed a long browser as one flat column of
// "Expose GPU and basic system info by dhiltgen · …" and nothing to tell two GitHub tabs apart.
//
// The order and grouping are `tabTree` (tab-tree.ts); this file draws them. A favicon is drawn only when the runtime
// sent it as a data URL (`faviconSrc`), otherwise the site's first letter stands in.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { IconCheck, IconPlus } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { faviconSrc, tabHost, tabMatches, tabTree, type TabGroupView, type TabTreeItem, type TabView } from "./tab-tree";

/** What is picked: a tab by id, or a new tab. */
export type TabChoice = number | "blank";

/** Past this many tabs the list gets a filter box: a long browser is found by typing, not by scrolling. */
const FILTER_AT = 8;

/** Chromium's group colours, as the page draws them (the browser's own palette, dimmed a little for the dark ground). */
const GROUP_COLOR: Record<string, string> = {
    grey: "#9aa0a6", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663", green: "#81c995",
    pink: "#ff8bcb", purple: "#c58af9", cyan: "#78d9ec", orange: "#fcad70",
};

/** A tab's icon: the runtime's favicon, or the site's first letter in a small square. */
function TabIcon({ tab }: { tab: TabView }) {
    const src = faviconSrc(tab);
    if (src) return <img class="tp-fav" src={src} alt="" width={16} height={16} />;
    const letter = (tabHost(tab.url).replace(/^[^a-z0-9]+/i, "")[0] ?? "?").toUpperCase();
    return <span class="tp-fav tp-letter" aria-hidden="true">{letter}</span>;
}

/**
 * The picker: a pill showing what is chosen, opening a list of "New tab" and every tab. `tabs` null means the list is
 * still on its way. Keyboard: arrows move, Enter picks, Escape closes; typing goes to the filter when there is one.
 */
export function TabPicker({ tabs, groups, value, onChange }: {
    tabs: readonly TabView[] | null;
    groups?: readonly TabGroupView[];
    value: TabChoice;
    onChange: (v: TabChoice) => void;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const [hot, setHot] = useState(0);
    const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
    const btn = useRef<HTMLButtonElement>(null);
    const pop = useRef<HTMLDivElement>(null);
    const filter = useRef<HTMLInputElement>(null);

    const chosen = value === "blank" ? null : tabs?.find((t) => t.tabId === value) ?? null;
    const shown = (tabs ?? []).filter((t) => tabMatches(t, q.trim()));
    // A filtered list drops the group and window headings of what no longer shows, and keeps the rest in place.
    const items: TabTreeItem[] = tabTree(shown, groups);
    // What the arrows walk: "New tab", then each tab, in the order drawn.
    const picks: TabChoice[] = ["blank", ...items.flatMap((i) => (i.kind === "tab" ? [i.tab.tabId] : []))];

    const place = () => {
        const r = btn.current?.getBoundingClientRect();
        if (!r) return;
        const width = Math.min(460, Math.max(r.width, 320), window.innerWidth - 16);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        // Below when there is room, otherwise above: the start box sits a little above the middle of the page.
        const below = window.innerHeight - r.bottom;
        setAt(below > 320 || below > r.top ? { left, top: r.bottom + 6, width } : { left, bottom: window.innerHeight - r.top + 6, width });
    };
    const openIt = () => { place(); setQ(""); setHot(Math.max(0, picks.indexOf(value))); setOpen(true); };
    const pick = (v: TabChoice) => { setOpen(false); onChange(v); btn.current?.focus(); };

    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false); };
        const close = () => setOpen(false);
        document.addEventListener("pointerdown", onDown);
        window.addEventListener("resize", close);
        return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("resize", close); };
    }, [open]);
    useEffect(() => { if (open) (filter.current ?? pop.current)?.focus(); }, [open]);
    useEffect(() => { setHot(0); }, [q]);
    // Keep the highlighted row in view as the arrows move it.
    useLayoutEffect(() => { pop.current?.querySelector(".tp-row.hot")?.scrollIntoView?.({ block: "nearest" }); }, [hot, open]);

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(picks.length - 1, h + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(0, h - 1)); }
        else if (e.key === "Enter") { e.preventDefault(); if (picks[hot] != null) pick(picks[hot]); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
    };
    const rowClass = (v: TabChoice, extra = "") => `tp-row${extra}${picks[hot] === v ? " hot" : ""}${value === v ? " on" : ""}`;

    return (
        <>
            <button ref={btn} type="button" class="tp-pill" aria-haspopup="listbox" aria-expanded={open}
                aria-label={`Where it runs: ${chosen ? chosen.title || tabHost(chosen.url) : "a new tab"}`}
                onClick={() => (open ? setOpen(false) : openIt())}
                onKeyDown={(e: KeyboardEvent) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openIt(); } }}>
                {tabs === null && value !== "blank" ? <span class="tp-pill-text dim">Loading tabs…</span>
                    : chosen ? <><TabIcon tab={chosen} /><span class="tp-pill-text">{truncate(chosen.title || tabHost(chosen.url), 48)}</span></>
                        : <><span class="tp-fav tp-new" aria-hidden="true"><IconPlus /></span><span class="tp-pill-text">New tab</span></>}
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {open && at ? (
                <div ref={pop} class="chat-menu tp-pop" role="listbox" aria-label="Where it runs" tabIndex={-1} onKeyDown={onKey}
                    style={{ left: `${at.left}px`, width: `${at.width}px`, ...(at.top != null ? { top: `${at.top}px` } : { bottom: `${at.bottom}px` }) }}>
                    {(tabs?.length ?? 0) > FILTER_AT ? (
                        <input ref={filter} class="tp-filter" type="search" placeholder="Filter tabs" aria-label="Filter tabs"
                            value={q} onInput={(e: any) => setQ(e.target.value)} />
                    ) : null}
                    <button type="button" role="option" aria-selected={value === "blank"} class={rowClass("blank")}
                        onMouseEnter={() => setHot(0)} onClick={() => pick("blank")}>
                        <span class="tp-fav tp-new" aria-hidden="true"><IconPlus /></span>
                        <span class="tp-title">New tab</span>
                        {value === "blank" ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                    </button>
                    <div class="tp-rule" role="separator" />
                    <div class="tp-list">
                        {tabs === null ? <div class="tp-note">Loading tabs…</div>
                            : !tabs.length ? <div class="tp-note">No open tabs this runtime can run on.</div>
                                : !items.length ? <div class="tp-note">No tab matches “{truncate(q.trim(), 30)}”.</div>
                                    : items.map((it) => it.kind === "window" ? (
                                        <div key={`w${it.windowId}`} class="tp-window">Window · {it.count} tab{it.count === 1 ? "" : "s"}</div>
                                    ) : it.kind === "group" ? (
                                        <div key={`g${it.group.id}`} class="tp-group">
                                            <span class="tp-group-dot" style={{ background: GROUP_COLOR[it.group.color ?? ""] ?? "var(--fg-faint)" }} aria-hidden="true" />
                                            <span class="tp-group-title">{it.group.title || "Unnamed group"}</span>
                                            <span class="tp-group-n">{it.count}</span>
                                        </div>
                                    ) : (
                                        <button key={it.tab.tabId} type="button" role="option" aria-selected={value === it.tab.tabId}
                                            class={rowClass(it.tab.tabId, it.indent ? " indent" : "")}
                                            onMouseEnter={() => setHot(picks.indexOf(it.tab.tabId))} onClick={() => pick(it.tab.tabId)}>
                                            <TabIcon tab={it.tab} />
                                            <span class="tp-title">{it.tab.title || tabHost(it.tab.url)}</span>
                                            <span class="tp-host">{tabHost(it.tab.url)}</span>
                                            {it.tab.active ? <span class="tp-active" aria-label="showing in its window">●</span> : null}
                                            {value === it.tab.tabId ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                                        </button>
                                    ))}
                    </div>
                </div>
            ) : null}
        </>
    );
}
