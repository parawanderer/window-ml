// sw-badge.ts — the toolbar button's badge and tooltip: what is waiting for the person, per tab.
//
// docs/spec/SITE_ACCESS_SLICE3.md 1.2. Derived from the start asks (sw-start-approval.ts) and the sites asking for access
// (sw-access-requests.ts) every time either changes; it holds nothing of its own beyond which tabs it has drawn on. A
// request is from any site, so it counts on every tab: it is drawn as the button's default, and a tab with a start ask
// waiting draws the sum over it.

import { onStartsChanged, waitingStarts, type WaitingStart } from "./sw-start-approval";
import { onRequestsChanged, waitingRequests } from "./sw-access-requests";
import type { AccessRequest } from "../site-requests";

/** The badge's colours: the panel's `--warn` amber, and its `--notice-fg` text on it. */
const BADGE_BG = "#eab308";
const BADGE_FG = "#1a1400";

/** The toolbar tooltip with nothing waiting. */
export const BADGE_IDLE_TITLE = "window.ml";

/**
 * What the toolbar button shows on one tab, from what is waiting there.
 * @param asks the start asks waiting on the tab
 * @param requests the sites asking for access (from any tab)
 * @returns the badge text ("" for none, "9+" past nine) and the tooltip
 */
export function badgeFor(asks: readonly WaitingStart[], requests: readonly Pick<AccessRequest, "origin">[] = []): { text: string; title: string } {
    const n = asks.length + requests.length;
    const text = n === 0 ? "" : n > 9 ? "9+" : String(n);
    if (n === 0) return { text, title: BADGE_IDLE_TITLE };
    if (!requests.length && n === 1) return { text, title: "window.ml: an agent start is waiting for you on this tab" };
    if (!asks.length && n === 1) return { text, title: `window.ml: ${new URL(requests[0].origin).host} is asking for access` };
    if (!asks.length) return { text, title: `window.ml: ${n} sites are asking for access` };
    return { text, title: `window.ml: ${n} things are waiting for you` };
}

const drawn = new Set<number>();   // state: ui (the tabs whose badge this worker set, so a settled ask clears its own)

/**
 * Draw one tab, or with no tab the default every tab without its own shows. A tab with nothing of its own is reset to
 * the default (`null`), so the requests drawn there show. A tab that closed in between rejects, which is fine: its
 * badge went with it.
 */
async function draw(tabId: number | undefined, asks: readonly WaitingStart[], requests: readonly AccessRequest[]): Promise<void> {
    const action = globalThis.chrome?.action;
    if (!action) return;
    const { text, title } = badgeFor(asks, requests);
    const own = tabId != null && !asks.length;
    await Promise.all([
        action.setBadgeText({ ...(tabId != null ? { tabId } : {}), text: own ? null as unknown as string : text }),
        action.setTitle({ ...(tabId != null ? { tabId } : {}), title: own ? null as unknown as string : title }),
    ]).catch(() => { /* the tab is gone */ });
}

/** Recompute the default and every tab's badge from what is waiting now. */
export async function refreshBadges(): Promise<void> {
    const requests = await waitingRequests().catch(() => [] as AccessRequest[]);
    const byTab = new Map<number, WaitingStart[]>();
    for (const a of waitingStarts()) byTab.set(a.tabId, [...(byTab.get(a.tabId) ?? []), a]);
    const stale = [...drawn].filter((t) => !byTab.has(t));
    for (const t of stale) drawn.delete(t);
    for (const t of byTab.keys()) drawn.add(t);
    await Promise.all([draw(undefined, [], requests), ...stale.map((t) => draw(t, [], requests)), ...[...byTab].map(([t, asks]) => draw(t, asks, requests))]);
}

/**
 * Start the badge: its colours, every tab cleared (an ask a previous worker held died with it, so a count it drew would
 * be a lie), then kept in step with the asks.
 */
async function startBadge(): Promise<void> {
    const action = globalThis.chrome?.action;
    if (!action) return;
    onStartsChanged(() => { void refreshBadges(); });
    onRequestsChanged(() => { void refreshBadges(); });
    try {
        await action.setBadgeBackgroundColor({ color: BADGE_BG });
        await action.setBadgeTextColor?.({ color: BADGE_FG });
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs.filter((t) => t.id != null).map((t) => draw(t.id as number, [], [])));
    } catch { /* no tabs API in this context */ }
    await refreshBadges();
}

void startBadge();
