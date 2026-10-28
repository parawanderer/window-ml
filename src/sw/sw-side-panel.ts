// sw-side-panel.ts — Chrome's side panel as a hidden page's surface: enabled per tab while its top document is hidden,
// the panels open now, what a gesture asked of one, and the cut that keeps a run's UI out of a hidden page.
//
// docs/spec/SITE_PRESENCE.md step 4 (2). A hidden page gets nothing of ours in its DOM, so the card and the composer a
// run shows there live in the side panel (sidepanel.html, the same app under an extension page). The panel is enabled
// for a tab while the tab's top document is hidden and disabled while it is visible, so the BROWSER holds the decision a
// start gesture needs: `sidePanel.open` must run before the gesture handler's first await, and it rejects "No active
// side panel" on a tab whose panel is disabled (measured, Chromium 151). Nothing here reads what a page posted.

import { presence } from "./sw-presence";

/** The port a side panel connects on, beside the DevTools panel's `ml-devtools` (sw-debug.ts serves both feeds). */
export const SIDE_PANEL_PORT = "ml-sidepanel";

/** The panel's page, named per tab so the page knows which tab it shows. */
export function panelPath(tabId: number): string {
    return `sidepanel.html?tabId=${tabId}`;
}

/** Per tab, whether its top document is hidden: the read under way or done, so a send waits for one in flight. Rebuilt
 *  from the open tabs when the worker starts, and on every top-frame navigation commit. */
const hiddenTabs = new Map<number, Promise<boolean>>();   // state: cache
/** The same, settled: what a synchronous reader (the badge) can use. */
const hiddenNow = new Map<number, boolean>();   // state: cache
/** The side panels connected now, by the tab each shows. */
const panelPorts = new Map<number, Set<chrome.runtime.Port>>();   // state: plumbing
/** What a gesture asked a panel to do that had not connected yet (open the composer, show a run), by tab. */
const cues = new Map<number, Record<string, unknown>[]>();   // state: ui
const CUES_MAX = 8;   // state: fixed

const listeners: (() => void)[] = [];   // state: plumbing

/** Hear every change to what waits on a closed panel (the badge redraws on it). */
export function onPanelsChanged(f: () => void): void {
    listeners.push(f);
}
function changed(): void {
    for (const f of listeners) { try { f(); } catch { /* one listener's failure is not the rest's */ } }
}

/** Write the browser's per-tab options: the panel for a hidden document, none for a visible one. */
function writeOptions(tabId: number, hidden: boolean): void {
    const sp = globalThis.chrome?.sidePanel;
    if (!sp?.setOptions) return;
    void sp.setOptions(hidden ? { tabId, path: panelPath(tabId), enabled: true } : { tabId, enabled: false }).catch(() => { /* the tab is gone */ });
}

/**
 * Read a tab's top document anew and write its panel options. A failed read counts as hidden, the side that puts
 * nothing in the page.
 * @param tabId the tab
 * @param url the document's URL, as the browser reported it
 * @returns whether the document is hidden
 */
export function notePage(tabId: number, url: string | undefined): Promise<boolean> {
    const read = presence(url).then((p) => p !== "full", () => true);
    hiddenTabs.set(tabId, read);
    void read.then((hidden) => {
        if (hiddenTabs.get(tabId) !== read) return;   // a later navigation read it again
        hiddenNow.set(tabId, hidden);
        writeOptions(tabId, hidden);
        changed();
    });
    return read;
}

/**
 * Whether a tab's top document is hidden, from the last read, or a read of the tab now when there is none.
 * @param tabId the tab
 * @returns true when hidden, or when the tab cannot be read
 */
export function tabHidden(tabId: number): Promise<boolean> {
    const known = hiddenTabs.get(tabId);
    if (known) return known;
    const read = Promise.resolve(globalThis.chrome?.tabs?.get?.(tabId)).then((t) => t?.url, () => undefined);
    return read.then((url) => hiddenTabs.get(tabId) ?? notePage(tabId, url));
}

/** The settled answer for a tab, for a synchronous reader; undefined while none has settled. */
export function tabHiddenNow(tabId: number): boolean | undefined {
    return hiddenNow.get(tabId);
}

/** Read every open tab again: when the worker starts, and after the site lists change. */
export async function syncAllPanels(): Promise<void> {
    const tabs = await Promise.resolve(globalThis.chrome?.tabs?.query?.({})).catch(() => undefined) ?? [];
    await Promise.all(tabs.map((t) => t.id == null ? undefined : notePage(t.id, t.url)));
}

/** Forget a closed tab. */
export function forgetTab(tabId: number): void {
    hiddenTabs.delete(tabId);
    hiddenNow.delete(tabId);
    if (cues.delete(tabId)) changed();
}

/**
 * Send a message to a tab's page-side UI (the shell: the card, the overlay, the composer), unless the tab's top document
 * is hidden, where it goes nowhere: the panel has the run through its port. In order, per tab.
 * @param tabId the tab
 * @param message the message
 * @param options which frame or document
 */
export function toPageUi(tabId: number, message: Record<string, unknown>, options?: chrome.tabs.MessageSendOptions): void {
    const send = (): void => { void chrome.tabs.sendMessage(tabId, message, options ?? {}).catch(() => { /* the tab is gone, or no shell */ }); };
    // A browser with no side panel has nowhere else to show a run: the page's own surfaces stay as they were.
    if (!globalThis.chrome?.sidePanel) { send(); return; }
    void tabHidden(tabId).then((hidden) => {
        if (!hidden) send();
    });
}

/** Whether a side panel shows this tab now. */
export function panelOpen(tabId: number): boolean {
    return (panelPorts.get(tabId)?.size ?? 0) > 0;
}

/**
 * Hand a panel what a gesture asked of it: at once when it is open, else when it connects.
 * @param tabId the panel's tab
 * @param cue what to tell its app (`__mlSidebarComposer`, `__mlComposerElement`, `__mlAddToCurrentRun`, `__mlShowRun`)
 */
export function cuePanel(tabId: number, cue: Record<string, unknown>): void {
    const ports = panelPorts.get(tabId);
    if (ports?.size) { for (const p of ports) { try { p.postMessage({ cue }); } catch { /* closing */ } } return; }
    const list = cues.get(tabId) ?? [];
    list.push(cue);
    if (list.length > CUES_MAX) list.splice(0, list.length - CUES_MAX);
    cues.set(tabId, list);
    changed();
}

/** The tabs whose closed panel has something a gesture asked of it, waiting for it to open. */
export function tabsWithCues(): number[] {
    return [...cues.keys()].filter((t) => !panelOpen(t));
}

/**
 * Open a tab's panel from a gesture. MUST be called in the gesture's handler before its first await: the browser
 * refuses `open` after one.
 * @param tabId the tab
 * @returns true when the panel opened (the tab's document is hidden), false when the tab has no panel (it is visible)
 */
export function openPanelNow(tabId: number): Promise<boolean> {
    try {
        const sp = globalThis.chrome?.sidePanel;
        if (!sp?.open) return Promise.resolve(false);
        return sp.open({ tabId }).then(() => true, () => false);
    } catch { return Promise.resolve(false); }
}

/**
 * A start gesture that landed in the worker (Alt+Space, the context menu): the panel on a hidden page, the page's own
 * surface on a visible one. Call it synchronously from the gesture's handler.
 * @param tabId the tab the gesture was on
 * @param cue what the panel is to do once open
 * @param inPage what to do on a visible page instead
 */
export function startGesture(tabId: number, cue: () => Promise<Record<string, unknown>>, inPage: () => void): void {
    const opened = openPanelNow(tabId);
    void opened.then(async (ok) => {
        if (ok) { cuePanel(tabId, await cue()); return; }
        // The browser says visible. Read it again before anything goes into the page: a navigation may have raced the
        // options. Hidden after all: nothing in the page, and the cue waits for the panel, which the badge points to.
        if (await notePage(tabId, await Promise.resolve(chrome.tabs.get(tabId)).then((t) => t?.url, () => undefined))) {
            cuePanel(tabId, await cue());
            return;
        }
        inPage();
    });
}

/**
 * Serve one side-panel port: registered against the tab it names, given what waited for it. Only an extension page may
 * hold one: the run's events go down it.
 * @param port the port
 */
export function servePanelPort(port: chrome.runtime.Port): void {
    if (port.name !== SIDE_PANEL_PORT) return;
    const own = typeof port.sender?.url === "string" && port.sender.url.startsWith(chrome.runtime.getURL(""));
    if (!own || port.sender?.tab) { try { port.disconnect(); } catch { /* gone */ } return; }
    let tabId: number | null = null;
    port.onMessage.addListener((msg: { type?: string; tabId?: unknown }) => {
        if (msg?.type !== "ml-sidepanel-init" || typeof msg.tabId !== "number" || tabId != null) return;
        const tid = msg.tabId;
        tabId = tid;
        const set = panelPorts.get(tid) ?? new Set();
        set.add(port);
        panelPorts.set(tid, set);
        for (const cue of cues.get(tid) ?? []) { try { port.postMessage({ cue }); } catch { /* closing */ } }
        cues.delete(tid);
        changed();
    });
    port.onDisconnect.addListener(() => {
        if (tabId == null) return;
        const set = panelPorts.get(tabId);
        if (set) { set.delete(port); if (!set.size) panelPorts.delete(tabId); }
        changed();
    });
}

/** TEST-ONLY: drop everything this module holds. */
export function resetSidePanelForTest(): void {
    hiddenTabs.clear(); hiddenNow.clear(); panelPorts.clear(); cues.clear();
}
