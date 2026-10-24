// sw-badge.ts — the toolbar button's badge and tooltip: what is waiting for the person, per tab.
//
// docs/spec/SITE_ACCESS_SLICE3.md 1.2 and PR 3. Derived from the start asks (sw-start-approval.ts) every time one is
// raised or settled; it holds nothing of its own beyond which tabs it has drawn on. The access requests of PR 4 join the
// count when their store exists.

import { onStartsChanged, waitingStarts, type WaitingStart } from "./sw-start-approval";

/** The badge's colours: the panel's `--warn` amber, and its `--notice-fg` text on it. */
const BADGE_BG = "#eab308";
const BADGE_FG = "#1a1400";

/** The toolbar tooltip with nothing waiting. */
export const BADGE_IDLE_TITLE = "window.ml";

/**
 * What the toolbar button shows on one tab, from what is waiting there.
 * @param asks the start asks waiting on the tab
 * @returns the badge text ("" for none, "9+" past nine) and the tooltip
 */
export function badgeFor(asks: readonly WaitingStart[]): { text: string; title: string } {
    const n = asks.length;
    if (n === 0) return { text: "", title: BADGE_IDLE_TITLE };
    if (n === 1) return { text: "1", title: "window.ml: an agent start is waiting for you on this tab" };
    return { text: n > 9 ? "9+" : String(n), title: `window.ml: ${n} things are waiting for you` };
}

const drawn = new Set<number>();   // state: ui (the tabs whose badge this worker set, so a settled ask clears its own)

/** Draw one tab. A tab that closed in between rejects, which is fine: its badge went with it. */
async function draw(tabId: number, asks: readonly WaitingStart[]): Promise<void> {
    const { text, title } = badgeFor(asks);
    const action = globalThis.chrome?.action;
    if (!action) return;
    await Promise.all([
        action.setBadgeText({ tabId, text }),
        action.setTitle({ tabId, title }),
    ]).catch(() => { /* the tab is gone */ });
}

/** Recompute every tab's badge from the asks waiting now. */
export async function refreshBadges(): Promise<void> {
    const byTab = new Map<number, WaitingStart[]>();
    for (const a of waitingStarts()) byTab.set(a.tabId, [...(byTab.get(a.tabId) ?? []), a]);
    const stale = [...drawn].filter((t) => !byTab.has(t));
    for (const t of stale) drawn.delete(t);
    for (const t of byTab.keys()) drawn.add(t);
    await Promise.all([...stale.map((t) => draw(t, [])), ...[...byTab].map(([t, asks]) => draw(t, asks))]);
}

/**
 * Start the badge: its colours, every tab cleared (an ask a previous worker held died with it, so a count it drew would
 * be a lie), then kept in step with the asks.
 */
async function startBadge(): Promise<void> {
    const action = globalThis.chrome?.action;
    if (!action) return;
    onStartsChanged(() => { void refreshBadges(); });
    try {
        await action.setBadgeBackgroundColor({ color: BADGE_BG });
        await action.setBadgeTextColor?.({ color: BADGE_FG });
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs.filter((t) => t.id != null).map((t) => draw(t.id as number, [])));
    } catch { /* no tabs API in this context */ }
    await refreshBadges();
}

void startBadge();
