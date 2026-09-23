// WHAT BELONGS TO THE DEVICE, not the runtime: the chat core's `ClientPlatform` (docs/spec/CHAT_PAGE.md). The contract
// leaves these out because they are the same whichever runtime a session is on: where preferences are stored, how an
// image is shown full size, how a file is handed over. Each place the core runs supplies one: the web adapter here,
// the extension adapter with the extension page (slice 3), and `nativePlatform` (native-embed.tsx) in the phone app,
// where each of these crosses the bridge to the shell (docs/spec/NATIVE_SHELL.md).
import { signal } from "@preact/signals";
import type { PairingApi } from "../pairing/api";

/** Device-local storage for display preferences. Synchronous reads, so a first render can use them. */
export interface PlatformPrefs {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
}

/** The device services the chat core uses. */
export interface ClientPlatform {
    /** `web`: a plain page (development and testing). `extension`, `native`: the other adapters, when they exist. */
    readonly kind: "web" | "extension" | "native";
    prefs: PlatformPrefs;
    /** show an image full size */
    openImage(src: string): void;
    /** hand a file to the person: a download on the web, the share sheet on a phone */
    saveFile(name: string, data: Blob): void;
    copyText(text: string): Promise<boolean>;
    /** joining a hub account and pairing devices, where this device can: the Devices tab in Settings shows only then */
    pairing?: PairingApi;
}

/** The image the web adapter's lightbox is showing, if any; the chat app renders it. */
export const lightboxSrc = signal<string | null>(null);

const PREFIX = "wml-chat:";

/** The web adapter: localStorage, an in-page lightbox, an anchor download, the async clipboard. Every storage call is
 *  guarded, because a private window or blocked site data throws on access and the page must still work. */
export const webPlatform: ClientPlatform = {
    kind: "web",
    prefs: {
        get<T>(key: string): T | undefined {
            try {
                const raw = localStorage.getItem(PREFIX + key);
                return raw == null ? undefined : (JSON.parse(raw) as T);
            } catch { return undefined; }
        },
        set(key, value) {
            try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage unavailable: the pref lasts this page */ }
        },
    },
    openImage: (src) => {
        // Only images this page can show without navigating anywhere: the views pass data and blob URLs.
        if (/^(data:image\/|blob:)/.test(src)) lightboxSrc.value = src;
    },
    saveFile: (name, data) => {
        const url = URL.createObjectURL(data);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
    copyText: async (text) => {
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    },
};
