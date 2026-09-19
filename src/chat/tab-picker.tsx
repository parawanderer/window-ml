// tab-picker.tsx — WHERE an agent run goes, picked the way you would find the tab yourself: "New tab" first, a rule, then
// the runtime's tabs in browser order, window by window, each group's members indented under the group, with the
// site's icon. It replaced a native <select> of truncated titles, which showed a long browser as one flat column of
// "Expose GPU and basic system info by dhiltgen · …" and nothing to tell two GitHub tabs apart.
//
// The order and grouping are `tabTree` (tab-tree.ts); this file draws them. A favicon is drawn only when the runtime
// sent it as a data URL (`faviconSrc`), otherwise the site's first letter stands in.
import { IconCheck, IconPlus } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { cursorTipOn } from "../sidebar/ui-kit";
import { usePickerPop } from "./pop-picker";
import { faviconSrc, tabHost, tabMatches, tabTree, type TabGroupView, type TabTreeItem, type TabView } from "./tab-tree";

/** What is picked: a tab by id, or a new tab. */
export type TabChoice = number | "blank";

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
 * still on its way; `onOpen` asks for a fresh one each time it opens, since tabs open and close while the page sits.
 * `groupsHint` is said under the list when some group is only known to be together (no names or colours).
 * Keyboard: arrows move, Enter picks, Escape closes; typing goes to the filter.
 */
export function TabPicker({ tabs, groups, value, onChange, onOpen, groupsHint }: {
    tabs: readonly TabView[] | null;
    groups?: readonly TabGroupView[];
    value: TabChoice;
    onChange: (v: TabChoice) => void;
    onOpen?: () => void;
    groupsHint?: string;
}) {
    const chosen = value === "blank" ? null : tabs?.find((t) => t.tabId === value) ?? null;
    // A filtered list drops the group and window headings of what no longer shows, and keeps the rest in place.
    const treeFor = (q: string): TabTreeItem[] => tabTree((tabs ?? []).filter((t) => tabMatches(t, q)), groups);
    // What the arrows walk: "New tab", then each tab, in the order drawn.
    const p = usePickerPop<TabChoice>({
        picksFor: (q) => ["blank", ...treeFor(q).flatMap((i) => (i.kind === "tab" ? [i.tab.tabId] : []))],
        value, onPick: onChange, onOpen,
    });
    const items = treeFor(p.q.trim());
    const unnamed = items.some((i) => i.kind === "group" && !i.described);

    return (
        <>
            <button {...p.pillProps} class="tp-pill" aria-label={`Where it runs: ${chosen ? chosen.title || tabHost(chosen.url) : "a new tab"}`}>
                {tabs === null && value !== "blank" ? <span class="tp-pill-text dim">Loading tabs…</span>
                    : chosen ? <><TabIcon tab={chosen} /><span class="tp-pill-text">{truncate(chosen.title || tabHost(chosen.url), 48)}</span></>
                        : <><span class="tp-fav tp-new" aria-hidden="true"><IconPlus /></span><span class="tp-pill-text">New tab</span></>}
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Where it runs">
                    <input {...p.filterProps} placeholder="Filter tabs" aria-label="Filter tabs" />
                    <button type="button" role="option" aria-selected={value === "blank"} {...p.row("blank")}>
                        <span class="tp-fav tp-new" aria-hidden="true"><IconPlus /></span>
                        <span class="tp-title">New tab</span>
                        {value === "blank" ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                    </button>
                    <div class="tp-rule" role="separator" />
                    <div class="tp-list">
                        {tabs === null ? <div class="tp-note">Loading tabs…</div>
                            : !tabs.length ? <div class="tp-note">No open tabs this runtime can run on.</div>
                                : !items.length ? <div class="tp-note">No tab matches “{truncate(p.q.trim(), 30)}”.</div>
                                    : items.map((it) => it.kind === "window" ? (
                                        <div key={`w${it.windowId}`} class="tp-window">Window · {it.count} tab{it.count === 1 ? "" : "s"}</div>
                                    ) : it.kind === "group" && !it.described ? (
                                        // Only known to be together: the runtime has no grant to name groups.
                                        <div key={`g${it.group.id}`} class="tp-group-rule" role="separator" />
                                    ) : it.kind === "group" ? (
                                        <div key={`g${it.group.id}`} class="tp-group">
                                            <span class="tp-group-dot" style={{ background: GROUP_COLOR[it.group.color ?? ""] ?? "var(--fg-faint)" }} aria-hidden="true" />
                                            <span class="tp-group-title">{it.group.title || "Unnamed group"}</span>
                                            <span class="tp-group-n">{it.count}</span>
                                        </div>
                                    ) : (
                                        <button key={it.tab.tabId} type="button" role="option" aria-selected={value === it.tab.tabId}
                                            {...p.row(it.tab.tabId, it.indent ? " indent" : "")}>
                                            <TabIcon tab={it.tab} />
                                            <span class="tp-title">{it.tab.title || tabHost(it.tab.url)}</span>
                                            {/* The whole address follows the pointer: the host is what fits, and two tabs on one
                                                site differ only in the rest. A node, not a string, so the URL is text
                                                rather than markdown (an underscore in a path is not emphasis). */}
                                            <span class="tp-host" {...cursorTipOn(<span class="tp-url">{it.tab.url}</span>)}>{tabHost(it.tab.url)}</span>
                                            {it.tab.active ? <span class="tp-active" aria-label="showing in its window">●</span> : null}
                                            {value === it.tab.tabId ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                                        </button>
                                    ))}
                    </div>
                    {unnamed && groupsHint ? <div class="tp-foot">{groupsHint}</div> : null}
                </div>
            ) : null}
        </>
    );
}
