// The services seam (services.ts) as the EXTENSION'S frames implement it: the in-page sidebar, the DevTools panel
// and the Commander HUD card, which all run `sidebar-app` in an extension iframe. These are the same calls the
// shared components used to make inline: the background over `chrome.runtime`, and the frame's parent (the
// content-script shell, or panel.ts) over `postMessage`. The parent can prove a message came from this extension
// iframe, which is what makes an approval posted this way unforgeable by the page.
import { hintSession } from "../contract";
import { bareHash, type SidebarServices, type SideCallRequest, type SideCallResult } from "./services";

const toParent = (msg: unknown): void => window.parent.postMessage(msg, "*");

/** A utility-model call through the background's `FETCH_LLM`, tagged as a side task about the session. */
function sideCall(req: SideCallRequest): Promise<SideCallResult> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(
                { type: "FETCH_LLM", payload: {
                    messages: req.messages, extend: "utility", maxTokens: req.maxTokens, think: false,
                    ...(req.schema ? { schema: req.schema } : {}),
                    hint: { session: hintSession(bareHash(req.session)) },
                } },
                (resp: { data?: unknown; error?: string; usage?: { requestId?: string } } | undefined) => {
                    if (chrome.runtime.lastError || !resp || resp.error) {
                        resolve({ ok: false, error: resp?.error || chrome.runtime.lastError?.message || "no response" });
                        return;
                    }
                    resolve({ ok: true, content: String(resp.data ?? ""), requestId: resp.usage?.requestId });
                },
            );
        } catch (e) {
            resolve({ ok: false, error: String((e as Error)?.message || e) });
        }
    });
}

/** The extension frames' services. Installed by `app.tsx` before it renders. */
export const extensionServices: SidebarServices = {
    sideCall,
    // The shell forwards it to the background as SET_APPROVAL, having checked it came from this iframe.
    answerApproval: (hash, seq, decision, persist) => toParent({ __mlSidebarApp: "approval", hash, seq, decision, persist }),
    sendToSession: (hash, text, images) => toParent({ __mlSidebarApp: "sessionSend", hash, text, images }),
    cancelSession: (hash) => toParent({ __mlSidebarApp: "sessionCancel", hash }),
    continueSession: (hash) => toParent({ __mlSidebarApp: "continueRun", hash }),
    highlight: (ref) => toParent({ __mlHighlight: ref }),
    openLightbox: (src) => toParent({ __mlLightbox: src }),
    hostAccess: {
        has: async (pattern) => {
            if (typeof chrome === "undefined" || !chrome.permissions?.contains) return true;   // nothing to ask: say granted, so no note shows
            try { return await chrome.permissions.contains({ origins: [pattern] }); } catch { return true; }
        },
        request: async (pattern) => {
            if (typeof chrome === "undefined" || !chrome.permissions?.request) return;
            try { await chrome.permissions.request({ origins: [pattern] }); } catch { /* dismissed, or an older Chrome: the fetch returns the actionable error */ }
        },
    },
    sheetTitle: (id) => new Promise((resolve) => {
        try { chrome.runtime.sendMessage({ type: "FETCH_SHEET_TITLE", payload: { id } }, (resp: { data?: string } | undefined) => resolve(resp?.data || null)); }
        catch { resolve(null); }
    }),
    savePref: (key, value) => { try { chrome.storage.local.set({ [key]: value }); } catch { /* no chrome in a bare render */ } },
};
