// tab-picker.tsx — WHERE an agent run goes, picked the way you would find the tab yourself: "New tab" first, a rule, then
// the runtime's tabs in browser order, window by window, each group's members indented under the group, with the
// site's icon. It replaced a native <select> of truncated titles, which showed a long browser as one flat column of
// "Expose GPU and basic system info by dhiltgen · …" and nothing to tell two GitHub tabs apart.
//
// The order and grouping are `tabTree` (tab-tree.ts); this file draws them. A favicon is drawn only when the runtime
// sent it as a data URL (`faviconSrc`), otherwise the site's first letter stands in.
import { IconCheck, IconPlus, IconWarn } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { cursorTipOn } from "../sidebar/ui-kit";
import { cutTip } from "./cut-tip";
import { useRef, useState } from "preact/hooks";
import { usePickerPop } from "./pop-picker";
import { groupFolds, setGroupFold } from "./view-mode";
import { faviconSrc, tabHost, tabMatches, tabTree, type TabGroupView, type TabTreeItem, type TabView } from "./tab-tree";

/** What is picked: a tab by id, or a new tab. */
export type TabChoice = number | "blank";

/** Chromium's group colours, as the page draws them (the browser's own palette, dimmed a little for the dark ground). */
const GROUP_COLOR: Record<string, string> = {
    grey: "#9aa0a6", blue: "#8ab4f8", red: "#f28b82", yellow: "#fdd663", green: "#81c995",
    pink: "#ff8bcb", purple: "#c58af9", cyan: "#78d9ec", orange: "#fcad70",
};

/** The list as drawn: window headings, loose tabs, and each group with its tabs gathered under it. */
type Segment =
    | { kind: "window"; windowId: number; count: number }
    | { kind: "tab"; tab: TabView }
    | { kind: "group"; group: TabGroupView; described: boolean; tabs: TabView[] };

/** Gather `tabTree`'s flat lines into segments: a group line and the member lines after it become one. */
function segments(items: readonly TabTreeItem[]): Segment[] {
    const out: Segment[] = [];
    for (const it of items) {
        if (it.kind === "window") out.push(it);
        else if (it.kind === "group") out.push({ kind: "group", group: it.group, described: it.described, tabs: [] });
        else if (it.indent && out.at(-1)?.kind === "group") (out.at(-1) as { tabs: TabView[] }).tabs.push(it.tab);
        else out.push({ kind: "tab", tab: it.tab });
    }
    return out;
}

/** The tabs the arrows can reach: every tab not inside a folded group. */
function visibleTabs(items: readonly TabTreeItem[], folded: (g: TabGroupView) => boolean): number[] {
    return segments(items).flatMap((s) => s.kind === "tab" ? [s.tab.tabId] : s.kind === "group" ? (s.described && folded(s.group) ? [] : s.tabs.map((t) => t.tabId)) : []);
}

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
export function TabPicker({ tabs, groups, value, onChange, onOpen, groupsHint, groupsGrant, runtime, withheld = 0, sitesGrant, loading }: {
    tabs: readonly TabView[] | null;
    groups?: readonly TabGroupView[];
    value: TabChoice;
    onChange: (v: TabChoice) => void;
    onOpen?: () => void;
    groupsHint?: string;
    /** asks for group names and colours; offered as a button in the foot where this device can (see ChatExtras) */
    groupsGrant?: (() => Promise<boolean>) | null;
    /** whose tabs these are: a folded group is remembered per runtime */
    runtime?: string;
    /** open tabs the runtime could not list because its site access is limited (`tabs.list`'s `withheld`) */
    withheld?: number;
    /** asks for access to every site, where this device can (the fix for `withheld`) */
    sitesGrant?: (() => Promise<boolean>) | null;
    /** the FIRST list is still on its way, and this runtime has tabs to list: draw the placeholder rather than a
     *  choice. The caller decides, because only it knows whether a null list means "not yet" or "never" — a runtime
     *  with no tabs never gets one, and would shimmer for ever. */
    loading?: boolean;
}) {
    const [asking, setAsking] = useState<"" | "groups" | "sites">("");
    // A group starts folded as the browser's strip has it, then as it was last left here; typing opens every group,
    // since a match hidden inside a fold is a match not found.
    const foldKey = (g: TabGroupView) => `${runtime ?? ""}:${g.id}`;
    const foldedFor = (g: TabGroupView, q: string) => !q && (groupFolds.value[foldKey(g)] ?? !!g.collapsed);
    const chosen = value === "blank" ? null : tabs?.find((t) => t.tabId === value) ?? null;
    // A filtered list drops the group and window headings of what no longer shows, and keeps the rest in place.
    const treeFor = (q: string): TabTreeItem[] => tabTree((tabs ?? []).filter((t) => tabMatches(t, q)), groups);
    // What the arrows walk: "New tab", then each tab, in the order drawn.
    const p = usePickerPop<TabChoice>({
        picksFor: (q) => ["blank", ...visibleTabs(treeFor(q), (g) => foldedFor(g, q))],
        value, onPick: onChange, onOpen,
    });
    const items = treeFor(p.q.trim());
    function tabRow(t: TabView, indent: boolean) {
        return (
            <button key={t.tabId} type="button" role="option" aria-selected={value === t.tabId} {...p.row(t.tabId, indent ? " indent" : "")}>
                <TabIcon tab={t} />
                {/* On the span rather than the row: the host beside it has an instant tip of its own, and a
                    delayed one on the whole row would replace that under a resting pointer. */}
                <span class="tp-title" {...cutTip(t.title || tabHost(t.url))}>{t.title || tabHost(t.url)}</span>
                {/* The whole address follows the pointer: the host is what fits, and two tabs on one site differ only
                    in the rest. A node, not a string, so the URL is text rather than markdown. */}
                <span class="tp-host" {...cursorTipOn(<span class="tp-url">{t.url}</span>)}>{tabHost(t.url)}</span>
                {t.active ? <span class="tp-active" aria-label="showing in its window">●</span> : null}
                {value === t.tabId ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
            </button>
        );
    }
    // The first list has not landed yet. Not conditioned on what is CHOSEN: nothing has been chosen yet, and the pill
    // used to spend the wait reading "New tab" — a definite answer that then silently became a different tab as the
    // list landed. A placeholder says the true thing, which is that the question cannot be answered yet.
    const waiting = !!loading;
    // Whether a placeholder was ever drawn: only then does the real pill fade in, the way the model pill does.
    const waited = useRef(false);
    if (waiting) waited.current = true;

    const isFolded = (g: TabGroupView) => foldedFor(g, p.q.trim());
    const fold = (g: TabGroupView) => setGroupFold(foldKey(g), !isFolded(g));
    const unnamed = items.some((i) => i.kind === "group" && !i.described);

    return (
        <>
            {/* WAITING FOR THE FIRST LIST: the model pill's shimmering placeholder, not the word "Loading" inside a
                pill that can be pressed. The two pills sit beside each other and were filling in differently — one
                shimmered, one read as a chosen value that happened to say "Loading tabs…" — and a pill you can open
                onto an empty list is worse than one that plainly is not ready yet. A REFRESH keeps the list it has
                (`load(false)` never sets null), so this is the first load only, and the real pill fades in after it. */}
            {waiting ? <span class="tp-pill tp-pill-tab tp-pill-wait" role="status" aria-label="Loading tabs" /> : (
            <button {...p.pillProps} {...(chosen ? cutTip(chosen.title || tabHost(chosen.url)) : {})} class={`tp-pill tp-pill-tab${waited.current ? " tp-pill-in" : ""}`} aria-label={`Where it runs: ${chosen ? chosen.title || tabHost(chosen.url) : value === "blank" ? "a new tab" : "a tab that has closed"}`}>
                {value !== "blank" && !chosen ? <span class="tp-pill-text tp-gone">That tab closed · pick another</span>
                    : chosen ? <><TabIcon tab={chosen} /><span class="tp-pill-text">{chosen.title || tabHost(chosen.url)}</span></>
                        : <><span class="tp-fav tp-new" aria-hidden="true"><IconPlus /></span><span class="tp-pill-text">New tab</span></>}
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            )}
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Where it runs">
                    <input {...p.filterProps} placeholder="Filter tabs" aria-label="Filter tabs" />
                    <button type="button" role="option" aria-selected={value === "blank"} {...p.row("blank")}>
                        <span class="tp-fav tp-new" aria-hidden="true"><IconPlus /></span>
                        <span class="tp-title">New tab</span>
                        {value === "blank" ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                    </button>
                    <div class="tp-rule" role="separator" />
                    {withheld > 0 && !p.q.trim() ? (
                        // Said, not silently dropped: a tab that is open but missing reads as a bug in the list.
                        <div class="tp-warn" role="note">
                            <span class="tp-warn-icon" aria-hidden="true"><IconWarn /></span>
                            <span class="tp-warn-text">
                                {withheld} open tab{withheld === 1 ? " is" : "s are"} not listed: the extension may only read the sites you allowed it.{" "}
                                {sitesGrant ? (
                                    <button type="button" class="chat-link" disabled={asking === "sites"} onClick={() => {
                                        // Called synchronously in the click: a browser shows a permission prompt only inside one.
                                        setAsking("sites");
                                        void sitesGrant().then((ok) => { setAsking(""); if (ok) onOpen?.(); });
                                    }}>{asking === "sites" ? "Asking…" : "Allow all sites"}</button>
                                ) : <>Allowed in that browser's extension settings (site access).</>}
                            </span>
                        </div>
                    ) : null}
                    <div class="tp-list">
                        {tabs === null ? <div class="tp-note">Loading tabs…</div>
                            : !tabs.length ? <div class="tp-note">No open tabs this runtime can run on.</div>
                                : !items.length ? <div class="tp-note">No tab matches “{truncate(p.q.trim(), 30)}”.</div>
                                    : segments(items).map((seg) => seg.kind === "window" ? (
                                        <div key={`w${seg.windowId}`} class="tp-window">Window · {seg.count} tab{seg.count === 1 ? "" : "s"}</div>
                                    ) : seg.kind === "tab" ? tabRow(seg.tab, false) : (
                                        // A group: its heading and its tabs in one box, so the arm in the group's colour
                                        // runs from the heading's dot down beside the tabs and stops at the last one.
                                        <div key={`g${seg.group.id}`} class={`tp-grp${seg.described ? "" : " plain"}${isFolded(seg.group) ? " folded" : ""}`}
                                            style={{ "--gc": seg.described ? GROUP_COLOR[seg.group.color ?? ""] ?? "var(--fg-faint)" : "var(--border)" }}>
                                            {seg.described ? (
                                                <button type="button" class="tp-group" aria-expanded={!isFolded(seg.group)}
                                                    aria-label={`${seg.group.title || "Unnamed group"}, ${seg.tabs.length} tab${seg.tabs.length === 1 ? "" : "s"}`}
                                                    onClick={() => fold(seg.group)}>
                                                    <span class="tp-group-dot" aria-hidden="true" />
                                                    <span class="tp-group-title" {...cutTip(seg.group.title || "Unnamed group")}>{seg.group.title || "Unnamed group"}</span>
                                                    <span class="tp-group-n">{seg.tabs.length}</span>
                                                    <svg class="tp-group-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                                                </button>
                                            ) : (
                                                // Only known to be together: the runtime has no grant to name groups.
                                                <div class="tp-group-rule" role="separator" />
                                            )}
                                            {/* Always drawn, so folding can animate: the rows collapse to nothing, and a folded
                                                group's tabs are inert (no pointer, no Tab key) as well as skipped by the arrows. */}
                                            <div class="tp-grp-body" {...(isFolded(seg.group) ? { inert: true, "aria-hidden": true } : {})}>
                                                <div class="tp-grp-rows">{seg.tabs.map((t) => tabRow(t, true))}</div>
                                            </div>
                                        </div>
                                    ))}
                    </div>
                    {unnamed && groupsGrant ? (
                        <div class="tp-foot">
                            Groups show without their names and colours.{" "}
                            <button type="button" class="chat-link" disabled={asking === "groups"} onClick={() => {
                                // Called synchronously in the click: a browser shows a permission prompt only inside one.
                                setAsking("groups");
                                void groupsGrant().then((ok) => { setAsking(""); if (ok) onOpen?.(); });
                            }}>{asking === "groups" ? "Asking…" : "Show them"}</button>
                        </div>
                    ) : unnamed && groupsHint ? <div class="tp-foot">{groupsHint}</div> : null}
                </div>
            ) : null}
        </>
    );
}
