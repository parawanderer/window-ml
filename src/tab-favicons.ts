// tab-favicons.ts — the tab picker's site icons, as `data:image/…` URLs the runtime fetched itself. A client (a phone
// looking at a desktop's tabs over a hub) must never load a site's own icon URL: that request would tell each site,
// and the phone's network, what the desktop has open. The runtime fetches from the browser that already has the tab
// open, once per site, and hands the bytes over.
//
// Pure over `fetch`, so the rules are tested without a browser: http(s) icons only, images only, small ones only,
// one fetch per icon URL for the worker's life, and a time budget so one slow site cannot hold the tab list.

/** The largest icon passed on. A 32px PNG is a few hundred bytes; anything near this is not a tab icon. */
export const FAVICON_MAX_BYTES = 16 * 1024;
/** How many icon URLs are remembered, whatever they answered. */
const CACHE_MAX = 500;

/** Base64 of bytes, in chunks. */
function base64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** Icons by the URL the tab reports, fetched once. */
export class FaviconCache {
    private readonly got = new Map<string, Promise<string | null>>();

    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    /** The icon for a tab's `favIconUrl`, as a data URL, or null. Never throws. */
    icon(favIconUrl: string | undefined): Promise<string | null> {
        if (!favIconUrl) return Promise.resolve(null);
        // A data URL the browser already holds is passed on as it is, if it is an image and small.
        if (favIconUrl.startsWith("data:")) {
            return Promise.resolve(/^data:image\/[a-z0-9.+-]+[;,]/i.test(favIconUrl) && favIconUrl.length <= FAVICON_MAX_BYTES * 1.4 ? favIconUrl : null);
        }
        if (!/^https?:\/\//i.test(favIconUrl)) return Promise.resolve(null);
        let p = this.got.get(favIconUrl);
        if (!p) {
            if (this.got.size >= CACHE_MAX) this.got.delete(this.got.keys().next().value as string);
            p = this.load(favIconUrl);
            this.got.set(favIconUrl, p);
        }
        return p;
    }

    private async load(url: string): Promise<string | null> {
        try {
            // No cookies: an icon is public, and a credentialed request would be one more thing to reason about.
            const res = await this.fetchImpl(url, { credentials: "omit" });
            if (!res.ok) return null;
            const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            if (!type.startsWith("image/")) return null;
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (!bytes.length || bytes.length > FAVICON_MAX_BYTES) return null;
            return `data:${type};base64,${base64(bytes)}`;
        } catch { return null; }
    }

    /**
     * Icons for many tabs, each within `budgetMs`: what has not arrived by then is left out of this answer and
     * arrives in the next one, since the fetch keeps going and is cached.
     */
    async many(urls: (string | undefined)[], budgetMs = 1500): Promise<(string | null)[]> {
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), budgetMs));
        return Promise.all(urls.map((u) => Promise.race([this.icon(u), timeout])));
    }
}

/**
 * Tabs in the order the browser's strip shows them: the focused window first, then the others in the order they were
 * met; each window's tabs by their index.
 */
export function stripOrder<T extends { windowId?: number; index?: number }>(tabs: readonly T[], focusedWindowId?: number): T[] {
    const windows: number[] = [];
    for (const t of tabs) if (t.windowId != null && !windows.includes(t.windowId)) windows.push(t.windowId);
    const rank = (w?: number) => (w == null ? Number.MAX_SAFE_INTEGER : w === focusedWindowId ? -1 : windows.indexOf(w));
    return [...tabs].sort((a, b) => rank(a.windowId) - rank(b.windowId) || (a.index ?? 0) - (b.index ?? 0));
}
