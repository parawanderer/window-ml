// sidepanel.ts — the side panel of a hidden page: the card's app for one tab, outside that page's DOM.
//
// docs/spec/SITE_PRESENCE.md step 4. A page whose origin may not use window.ml gets nothing of ours in its DOM, so the
// card a run the person started there would show (its approvals, its transcript, the composer that starts it) lives in
// Chrome's side panel. The worker enables the panel per tab while the tab's document is hidden (sw-side-panel.ts) and
// names the tab in the panel's URL. This page plays the shell's part for the card: it feeds the app the tab's run events
// from the worker's port (the DevTools panel's feed, sw-debug.ts), and forwards the app's answers to the worker
// (app-host.ts). Nothing here reaches the page.

import { showLightbox, relayAppToWorker } from "./app-host";
import { cleanImages } from "../contract/contract-run";

const frame = document.getElementById("app") as HTMLIFrameElement;
const tabId = Number(new URLSearchParams(location.search).get("tabId"));

let ready = false;   // state: ui (the app has said it is listening)
const queue: unknown[] = [];   // state: ui (what came before the app was listening, in order)
/** Post one message to the app, or hold it until the app says it is listening. */
function toApp(m: unknown): void {
    if (ready) frame.contentWindow?.postMessage(m, "*");
    else queue.push(m);
}

/** What a gesture asked of the panel, one app message per key: open the composer, an element for it, show a run. */
function applyCue(cue: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(cue)) if (v !== undefined && v !== null) toApp({ [k]: v });
}

/** Connect to the tab's run feed; reconnect when the worker restarts, each replay being the truth. */
function connect(): void {
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: "ml-sidepanel" }); } catch { return; }   // the extension reloaded
    port.postMessage({ type: "ml-sidepanel-init", tabId });
    port.onMessage.addListener((msg: { __mlDebug?: unknown; reset?: boolean; replay?: unknown[]; cue?: Record<string, unknown> }) => {
        if (msg?.__mlDebug) toApp({ __mlDebug: msg.__mlDebug });
        else if (msg?.reset) { if (ready) frame.contentWindow?.postMessage({ __mlDebugReset: true }, "*"); else queue.length = 0; }
        // An empty replay after a worker restart is a lost buffer, not an empty history: keep what is shown.
        else if (Array.isArray(msg?.replay) && msg.replay.length) {
            if (ready) frame.contentWindow?.postMessage({ __mlDebugReset: true }, "*");
            for (const e of msg.replay) toApp({ __mlDebug: e });
        } else if (msg?.cue && typeof msg.cue === "object") applyCue(msg.cue);
    });
    port.onDisconnect.addListener(() => { if (chrome.runtime?.id) setTimeout(connect, 500); });
}
// A side panel the tab cannot be named for has nothing to show; one whose tab is named connects for it.
if (Number.isInteger(tabId)) connect();

window.addEventListener("message", (e: MessageEvent) => {
    const d: any = e.data;
    if (!d || e.source !== frame.contentWindow) return;
    if (d.__mlSidebarApp === "chartKeys" || d.__mlSidebarApp === "pointerIn") return;
    if (d.__mlSidebarApp === "ready") {
        ready = true;
        // The card's surface: the same app the page's corner card runs, its approvals and its composer.
        frame.contentWindow?.postMessage({ __mlSidebarSurface: "card" }, "*");
        for (const m of queue.splice(0)) frame.contentWindow?.postMessage(m, "*");
        return;
    }
    // The card's state: "hidden" is no run to show, which the empty note says; any other state shows the app.
    if (typeof d.__mlSidebarCard === "string") { document.body.toggleAttribute("data-empty", d.__mlSidebarCard === "hidden"); return; }
    if (typeof d.__mlLightbox === "string") { showLightbox(d.__mlLightbox); return; }
    // The composer's "start this task" for this tab. The worker builds the run, as from the page's card (sw-run-start.ts).
    if (d.__mlSidebarApp === "startRun" && typeof d.task === "string" && d.task.trim()) {
        const payload = {
            tabId,
            task: d.task,
            maxSteps: typeof d.maxSteps === "number" ? d.maxSteps : undefined,
            model: typeof d.model === "string" && d.model.trim() ? d.model.trim() : undefined,
            vision: d.vision === true ? true : undefined,
            stream: d.stream === true ? true : undefined,
            images: cleanImages(d.images),
            elementContext: (d.elementContext && typeof d.elementContext.selector === "string") ? d.elementContext : undefined,
            surface: "hud",
        };
        chrome.storage.sync.get({ agentHud: "progress", persistUiRuns: true }, (c: { agentHud?: string; persistUiRuns?: boolean }) => {
            void chrome.runtime.sendMessage({ type: "PANEL_START_RUN", payload: { ...payload, hud: c.agentHud || "progress" }, keep: c.persistUiRuns !== false })
                .then((r: { error?: string } | undefined) => { if (r?.error) console.warn("window.ml: the run did not start:", r.error); })
                .catch(() => { /* worker gone */ });
        });
        return;
    }
    relayAppToWorker(d, tabId, "hud", (m) => frame.contentWindow?.postMessage(m, "*"));
});

// A highlight drawn for a waiting approval lives on the page: clear it when the panel closes.
window.addEventListener("pagehide", () => {
    try { void chrome.runtime.sendMessage({ type: "ML_HL_REMOTE", tabId, ref: null }).catch(() => {}); } catch { /* context gone */ }
});
