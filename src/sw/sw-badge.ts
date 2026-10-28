// sw-badge.ts — the toolbar button's badge and tooltip: what is waiting for the person, per tab.
//
// docs/spec/SITE_ACCESS_SLICE3.md 1.2. Derived from the start asks (sw-start-approval.ts) and the sites asking for access
// (sw-access-requests.ts) every time either changes; it holds nothing of its own beyond which tabs it has drawn on. A
// request is from any site, so it counts on every tab: it is drawn as the button's default, and a tab with a start ask
// waiting draws the sum over it. A hidden page's side panel (sw-side-panel.ts, SITE_PRESENCE.md step 4) adds what waits
// on it while it is closed: a gate of a run on that tab, or what a start gesture asked of it. The popup's "Open panel"
// rows list the same tabs (`panelWaits`).

import { onStartsChanged, waitingStarts, type WaitingStart } from "./sw-start-approval";
import { onRequestsChanged, waitingRequests } from "./sw-access-requests";
import type { AccessRequest } from "../site-requests";
import { onApprovalsChanged, pendingApprovals } from "./sw-consent";
import { runInboxes, tabPageUrl } from "./sw-runs";
import { onPanelsChanged, panelOpen, tabHiddenNow, tabsWithCues } from "./sw-side-panel";

/** The badge's colours: the panel's `--warn` amber, and its `--notice-fg` text on it. */
const BADGE_BG = "#eab308";
const BADGE_FG = "#1a1400";

/** The toolbar tooltip with nothing waiting. */
export const BADGE_IDLE_TITLE = "window.ml";

/**
 * What the toolbar button shows on one tab, from what is waiting there.
 * @param asks the start asks waiting on the tab
 * @param requests the sites asking for access (from any tab)
 * @param inPanel what waits on this tab's closed side panel (its run's gates, a start gesture's ask)
 * @returns the badge text ("" for none, "9+" past nine) and the tooltip
 */
export function badgeFor(asks: readonly WaitingStart[], requests: readonly Pick<AccessRequest, "origin">[] = [], inPanel = 0): { text: string; title: string } {
    const n = asks.length + requests.length + inPanel;
    const text = n === 0 ? "" : n > 9 ? "9+" : String(n);
    if (n === 0) return { text, title: BADGE_IDLE_TITLE };
    if (n === inPanel) return { text, title: "window.ml: something is waiting for you in the side panel on this tab" };
    if (!requests.length && n === 1) return { text, title: "window.ml: an agent start is waiting for you on this tab" };
    if (!asks.length && !inPanel && n === 1) return { text, title: `window.ml: ${new URL(requests[0].origin).host} is asking for access` };
    if (!asks.length && !inPanel) return { text, title: `window.ml: ${n} sites are asking for access` };
    return { text, title: `window.ml: ${n} things are waiting for you` };
}

const drawn = new Set<number>();   // state: ui (the tabs this worker drew a badge of their own on, redrawn on every change)

/**
 * Draw one tab, or with no tab the default every tab without its own shows. Always explicit text: Chrome does not take
 * `null` back to the default for a title, so a tab once drawn keeps its own badge, drawn from what waits now. A tab that
 * closed in between rejects, which is fine: its badge went with it.
 */
async function draw(tabId: number | undefined, asks: readonly WaitingStart[], requests: readonly AccessRequest[], inPanel = 0): Promise<void> {
    const action = globalThis.chrome?.action;
    if (!action) return;
    const { text, title } = badgeFor(asks, requests, inPanel);
    const at = tabId != null ? { tabId } : {};
    await Promise.all([action.setBadgeText({ ...at, text }), action.setTitle({ ...at, title })]).catch(() => { /* the tab is gone */ });
}

/** Recompute the default and every drawn tab's badge from what is waiting now. */
export async function refreshBadges(): Promise<void> {
    const requests = await waitingRequests().catch(() => [] as AccessRequest[]);
    const byTab = new Map<number, WaitingStart[]>();
    for (const a of waitingStarts()) byTab.set(a.tabId, [...(byTab.get(a.tabId) ?? []), a]);
    const panels = closedPanelWaits();
    for (const t of [...byTab.keys(), ...panels.keys()]) drawn.add(t);
    await Promise.all([draw(undefined, [], requests), ...[...drawn].map((t) => draw(t, byTab.get(t) ?? [], requests, panels.get(t) ?? 0))]);
}

/**
 * What waits on each hidden tab whose side panel is closed: the gates of its runs, and one for a start gesture's ask.
 * @returns the count per tab, only tabs with something waiting
 */
function closedPanelWaits(): Map<number, number> {
    const n = new Map<number, number>();
    for (const { descriptor } of pendingApprovals.values()) {
        const tabId = runInboxes.get(descriptor.runId)?.tabId;
        if (tabId == null || tabHiddenNow(tabId) !== true || panelOpen(tabId)) continue;
        n.set(tabId, (n.get(tabId) ?? 0) + 1);
    }
    for (const t of tabsWithCues()) n.set(t, (n.get(t) ?? 0) + 1);
    return n;
}

/**
 * The popup's "Open panel" rows: each tab with something waiting on its closed side panel, named by the origin the
 * browser reports for it (never a title the page set).
 * @returns the tabs, each with its origin and how much waits
 */
export async function panelWaits(): Promise<{ tabId: number; origin: string; waiting: number }[]> {
    const out: { tabId: number; origin: string; waiting: number }[] = [];
    for (const [tabId, waiting] of closedPanelWaits()) {
        const url = tabPageUrl.get(tabId) ?? await Promise.resolve(chrome.tabs.get(tabId)).then((t) => t?.url, () => undefined);
        let origin = "";
        try { origin = url ? new URL(url).origin : ""; } catch { /* not a URL */ }
        if (origin) out.push({ tabId, origin, waiting });
    }
    return out;
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
    onApprovalsChanged(() => { void refreshBadges(); });
    onPanelsChanged(() => { void refreshBadges(); });
    chrome.tabs?.onRemoved?.addListener((tabId) => { drawn.delete(tabId); });
    try {
        await action.setBadgeBackgroundColor({ color: BADGE_BG });
        await action.setBadgeTextColor?.({ color: BADGE_FG });
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) if (t.id != null) drawn.add(t.id);
    } catch { /* no tabs API in this context */ }
    await refreshBadges();
}

void startBadge();
