// sw-invocation.ts — how the person opens the HUD on this install, read live from chrome.commands.

import type { InvocationInfo } from "../contract";

/**
 * How to open the HUD on THIS install (GET_INVOCATION, and `agent_api_docs` in the worker). The shortcut is
 * user-rebindable at chrome://extensions/shortcuts, so this reports what chrome.commands says is bound RIGHT NOW (and
 * whether that still matches the manifest) rather than letting anything hardcode "Alt+Space": a stale answer sends
 * the user to a key that does nothing. Non-secret: it's the user's own UI affordance, so no sender gating.
 * @returns the live binding, the manifest default, and whether a right-click entry exists
 */
export async function invocationInfo(): Promise<InvocationInfo> {
    const manifest = chrome.runtime.getManifest?.() || {} as chrome.runtime.Manifest;
    const suggested = manifest.commands?.["open-composer"]?.suggested_key;
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent || "");
    const defaultShortcut = (typeof suggested === "string" ? suggested
        : (isMac ? suggested?.mac : suggested?.default) || suggested?.default) || "";
    // contextMenus is a permission-gated API, so the manifest declaring it is a truthful proxy
    // for "the right-click entry exists" — this line turns itself on when that feature lands.
    const contextMenu = (manifest.permissions || []).includes("contextMenus");
    try {
        const cmds: chrome.commands.Command[] = await Promise.resolve(chrome.commands?.getAll?.() ?? []);
        const shortcut = cmds.find(c => c.name === "open-composer")?.shortcut || "";
        return { shortcut, defaultShortcut, isDefault: !!shortcut && shortcut === defaultShortcut, contextMenu };
    } catch {
        return { shortcut: "", defaultShortcut, isDefault: false, contextMenu };
    }
}
