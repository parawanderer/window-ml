// The services seam (services.ts) as the EXTENSION'S frames implement it: the in-page sidebar, the DevTools panel
// and the Commander HUD card, which all run `sidebar-app` in an extension iframe. These are the same calls the
// shared components used to make inline: the background over `chrome.runtime`, and the frame's parent (the
// content-script shell, or panel.ts) over `postMessage`. The parent can prove a message came from this extension
// iframe, which is what makes an approval posted this way unforgeable by the page.
import { hintSession } from "../contract-run";
import { config } from "./store";
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
    // Without a utility model, `extend: "utility"` falls back to the (expensive) main model, and someone who has not
    // set one has not asked for glosses.
    sideCalls: () => !!config.value.utilityModel.trim(),
    bench: true,
    // The shell forwards it to the background as SET_APPROVAL, having checked it came from this iframe.
    answerApproval: (hash, seq, decision, persist) => toParent({ __mlSidebarApp: "approval", hash, seq, decision, persist }),
    // A post to the page, which answers nothing: what goes wrong from there shows in the run itself.
    sendToSession: async (hash, text, images) => { toParent({ __mlSidebarApp: "sessionSend", hash, text, images }); return { ok: true }; },
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
    // The panel holds a run's whole log in the worker's ring already: there is no earlier page to ask for.
    loadEarlier: null,
    // Every extension frame is extension-origin, so it opens the same value store the service worker writes, and decodes
    // the bytes with the parsers the preview came from. Reads only: the budget never applies.
    storedTable: typeof indexedDB === "undefined" ? null : async (key, opts) => {
        const [{ ValueStore }, { storedColumns }] = await Promise.all([import("../value-store"), import("../table-data")]);
        const { row, blob } = await new ValueStore({ budgetBytes: () => Number.POSITIVE_INFINITY }).get(key);
        return storedColumns(await blob.arrayBuffer(), row.format, opts.columns, { delimiter: opts.delimiter, headerless: opts.headerless });
    },
};
