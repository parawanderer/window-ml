// app-host.ts — what every extension page hosting the sidebar app for one tab shares: the relay to the worker and the image viewer.

import { approvalPayload } from "../approval-key";
import { cleanImages } from "../contract/contract-run";

// The app posts __mlLightbox on an image click; the overlay's shell shows it full-window.
// The panel is its own page, so it needs its own viewer — with Escape + backdrop close,
// and it grabs focus so Escape lands HERE even though the click came from the app iframe
// (keyboard events don't cross the iframe boundary).
let lightboxKey: ((e: KeyboardEvent) => void) | null = null;   // state: ui

/** Close the image viewer, if one is open. */
function hideLightbox(): void {
    document.getElementById("ml-lightbox")?.remove();
    if (lightboxKey) { window.removeEventListener("keydown", lightboxKey); lightboxKey = null; }
}

/**
 * Show an image full-window over an extension page that hosts the app (the image viewer, or lightbox): closed by a
 * click or Escape.
 * @param src the image
 */
export function showLightbox(src: string): void {
    hideLightbox();
    const box = document.createElement("div");
    box.id = "ml-lightbox";
    box.tabIndex = -1;
    box.addEventListener("click", hideLightbox);              // click anywhere (incl. the image) closes
    const img = document.createElement("img");
    img.src = src;
    box.append(img);
    document.body.append(box);
    box.focus();                                              // pull focus out of the iframe → Escape reaches us
    lightboxKey = e => { if (e.key === "Escape") hideLightbox(); };
    window.addEventListener("keydown", lightboxKey);
}

/**
 * Forward what the app asks of the worker for one tab: an approval, a start decision, a highlight, a message, a cancel
 * or a Continue. Shared by every extension page that hosts the app for a tab (the DevTools panel, the side panel); the
 * caller has already checked the message came from its own app frame.
 * @param d the app's message
 * @param tabId the tab the host shows
 * @param surface the surface name a follow-up is sent from
 * @param toApp posts a message back to the app
 * @returns whether the message was one of these
 */
export function relayAppToWorker(d: any, tabId: number, surface: string, toApp: (m: unknown) => void): boolean {
    // Design A reverse channel: the app's approve/deny for a background-hosted run's gate. Forward it to
    // the background as SET_APPROVAL. Unforgeable by the inspected page — this fires ONLY for a message
    // from the real panel-app iframe (the e.source check above), and a web page can't postMessage into an
    // extension page. The host (an extension page) can chrome.runtime.sendMessage directly; the
    // page has no such path (it's not an extension context, and SET_APPROVAL isn't a content-relayed type).
    if (d.__mlSidebarApp === "approval" && typeof d.hash === "string" && typeof d.seq === "number") {
        void chrome.runtime.sendMessage({ type: "SET_APPROVAL", payload: approvalPayload(d) }).catch(() => {});
        return true;
    }
    // A start card's answer, from the real panel-app iframe (the e.source check above): forwarded as SET_START_APPROVAL.
    if (d.__mlSidebarApp === "startDecision" && typeof d.requestId === "string" && (d.decision === "allow" || d.decision === "always" || d.decision === "deny")) {
        // An ask the worker no longer holds (it restarted, the ask timed out) is shown expired, not left waiting.
        const id = d.requestId as string;
        void chrome.runtime.sendMessage({ type: "SET_START_APPROVAL", payload: { requestId: id, decision: d.decision } })
            .then((r: { data?: boolean } | undefined) => { if (r?.data !== true) toApp({ __mlStartExpired: id }); },
                () => toApp({ __mlStartExpired: id }));
        return true;
    }
    // Hover-highlight reverse channel: the app asks to outline a page element/point on hover. The panel
    // can't touch the inspected page, so relay to the background → that tab's content-script shell, which
    // draws the box. Origin-checked above (e.source === frame.contentWindow); a web page can't
    // postMessage into a DevTools page regardless.
    if ("__mlHighlight" in d) { void chrome.runtime.sendMessage({ type: "ML_HL_REMOTE", tabId, ref: d.__mlHighlight }).catch(() => {}); return true; }
    // Session composer reverse channel: the panel can't touch the inspected page, so relay to the
    // background → that tab's shell → the page's handle registry (same route as hover-highlight).
    if (d.__mlSidebarApp === "sessionSend" && typeof d.hash === "string" && typeof d.text === "string" && (d.text.trim() || cleanImages(d.images))) {
        void chrome.runtime.sendMessage({ type: "ML_SESSION_REMOTE", tabId, action: "send", hash: d.hash, text: d.text, images: cleanImages(d.images), surface }).catch(() => {});
        return true;
    }
    if (d.__mlSidebarApp === "sessionCancel" && typeof d.hash === "string") {
        // A background-hosted agent run is owned by the SERVICE WORKER, so cancel it DIRECTLY — do NOT detour
        // through the inspected page. The page round-trip (below) needs a live content script on the tab, which
        // an "on-click" site-access page (github) lacks after a reload, or a CSP-blocked page never has — so Stop
        // was inert there and the run couldn't be killed (reported bug). CANCEL_RUN aborts the run's own
        // controller; cancelling a run is harmless (the security note in background.ts), and it's a no-op if the
        // hash isn't a live run. The round-trip still covers a page-hosted chat/handle session + the page-side
        // "cancelled" UI cleanup when the content script IS present.
        void chrome.runtime.sendMessage({ type: "CANCEL_RUN", payload: { runId: d.hash } }).catch(() => {});
        void chrome.runtime.sendMessage({ type: "ML_SESSION_REMOTE", tabId, action: "cancel", hash: d.hash }).catch(() => {});
        return true;
    }
    if (d.__mlSidebarApp === "continueRun" && typeof d.hash === "string") {
        void chrome.runtime.sendMessage({ type: "ML_SESSION_REMOTE", tabId, action: "continue", hash: d.hash, maxSteps: d.maxSteps }).catch(() => {});
        return true;
    }
    return false;
}
