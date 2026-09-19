// tab-tree.ts — a runtime's open tabs as the browser shows them: window by window, in strip order, with each tab
// group's members together under their group. Pure, so the ordering is tested without a DOM.
//
// It reads fields a runtime MAY report (`index`, `groupId`, `favicon` on a tab; the groups themselves beside the list)
// and falls back to the order the list arrived in, with no groups, when it reports none. A tab strip is contiguous per
// group in every Chromium browser, so members are gathered by walking the strip, never by sorting on the group.

/** A tab as the picker draws it: the contract's `TabInfo`, plus what a runtime may add about where it sits. */
export interface TabView {
    tabId: number;
    url: string;
    title: string;
    active: boolean;
    windowId?: number;
    /** position in its window's tab strip */
    index?: number;
    /** the tab group it is in; absent or -1 when in none */
    groupId?: number;
    /** a small image, as a `data:image/…` URL the RUNTIME made. Anything else is never loaded (see `faviconSrc`). */
    favicon?: string;
}

/** A tab group, as a runtime may report it beside the tabs. */
export interface TabGroupView {
    id: number;
    title?: string;
    /** Chromium's group colour name: grey, blue, red, yellow, green, pink, purple, cyan, orange */
    color?: string;
    /** collapsed in the browser's tab strip */
    collapsed?: boolean;
}

/** One line of the picker's list. */
export type TabTreeItem =
    | { kind: "window"; windowId: number; count: number }
    /** `described`: the runtime reported this group (its colour, and its name if it has one). Undescribed, the page
     *  knows only that the tabs are together — a runtime without the optional `tabGroups` grant says no more. */
    | { kind: "group"; group: TabGroupView; count: number; described: boolean }
    | { kind: "tab"; tab: TabView; indent: boolean };

/**
 * The tabs in browser order, as lines: a window heading only when there is more than one window, a group heading
 * above each run of a group's members, and those members indented.
 *
 * Windows keep the order their first tab arrived in; within one, tabs follow `index` where reported, else arrival.
 * A group the runtime did not describe still gets its item (drawn as a plain rule), since its members are still together.
 */
export function tabTree(tabs: readonly TabView[], groups: readonly TabGroupView[] = []): TabTreeItem[] {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const windows = new Map<number, { tab: TabView; at: number }[]>();
    tabs.forEach((tab, at) => {
        const w = tab.windowId ?? -1;
        if (!windows.has(w)) windows.set(w, []);
        windows.get(w)!.push({ tab, at });
    });
    const out: TabTreeItem[] = [];
    const several = windows.size > 1;
    for (const [windowId, list] of windows) {
        list.sort((a, b) => (a.tab.index ?? a.at) - (b.tab.index ?? b.at) || a.at - b.at);
        if (several) out.push({ kind: "window", windowId, count: list.length });
        for (let i = 0; i < list.length; i++) {
            const g = inGroup(list[i].tab);
            if (g == null) { out.push({ kind: "tab", tab: list[i].tab, indent: false }); continue; }
            let end = i;
            while (end + 1 < list.length && inGroup(list[end + 1].tab) === g) end++;
            out.push({ kind: "group", group: byId.get(g) ?? { id: g }, count: end - i + 1, described: byId.has(g) });
            for (let j = i; j <= end; j++) out.push({ kind: "tab", tab: list[j].tab, indent: true });
            i = end;
        }
    }
    return out;
}

/** The tab's group, or null when it is in none (Chromium reports -1 for that). */
function inGroup(t: TabView): number | null {
    return t.groupId != null && t.groupId >= 0 ? t.groupId : null;
}

/**
 * The favicon to draw, or null for the letter fallback. ONLY an image the runtime already turned into a data URL:
 * loading a tab's own favicon URL would fetch from that site, which from a phone looking at a desktop's tabs tells
 * every one of those sites (and anyone watching the phone's traffic) what the desktop has open.
 */
export function faviconSrc(t: TabView): string | null {
    return t.favicon && /^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|webp|jpeg|svg\+xml);/i.test(t.favicon) ? t.favicon : null;
}

/** The host a tab is on, for its second line and its letter icon. */
export function tabHost(url: string): string {
    try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

/** Does a tab match what was typed into the filter? Title or host, case-insensitive. */
export function tabMatches(t: TabView, q: string): boolean {
    if (!q) return true;
    const s = q.toLowerCase();
    return t.title.toLowerCase().includes(s) || tabHost(t.url).toLowerCase().includes(s);
}
