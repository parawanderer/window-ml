// route.ts — THE PAGE'S ADDRESSES: which view a URL names, and the URL for the view on screen, so a link can open the
// Devices tab or one session directly (`#/settings/devices`, `#/s/<runtime:hash>`). Pure, so the grammar is tested
// without a page.
//
// In the HASH, never the path: the extension's page is `chrome-extension://…/chat.html`, the phone app is served from
// its own bundle, and a static server has no fallback, so none of them can answer `/settings/devices`. A development
// server redirects such a path to its hash (tests/e2e/chat-shots.mjs). The old `#s=<key>` form still opens a session.

import type { SettingsTab } from "./settings-page";

/** The views a URL can name. */
export type MainRoute = "search" | "settings" | "attention";

/** What a URL names: a session, or a main view (and, for settings, which tab), or neither (the list). */
export interface Route {
    session?: string;
    main?: MainRoute;
    tab?: SettingsTab;
}

const TABS: readonly SettingsTab[] = ["page", "runtimes", "devices", "extension", "housekeeping"];

/** The route a hash names. Anything it does not know is the list, never an error: an old or mistyped link still opens the page. */
export function parseRoute(hash: string): Route {
    const legacy = /^#s=(.+)$/.exec(hash);
    if (legacy) return { session: decodeURIComponent(legacy[1]) };
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "s" && parts[1]) return { session: decodeURIComponent(parts.slice(1).join("/")) };
    if (parts[0] === "search" || parts[0] === "attention") return { main: parts[0] };
    if (parts[0] === "settings") {
        const tab = TABS.find((t) => t === parts[1]);
        return tab ? { main: "settings", tab } : { main: "settings" };
    }
    return {};
}

/** The hash for what is on screen. A main view wins over an open session, since it is drawn over it. */
export function formatRoute(r: Route): string {
    if (r.main === "settings") return r.tab ? `#/settings/${r.tab}` : "#/settings";
    if (r.main) return `#/${r.main}`;
    if (r.session) return `#/s/${encodeURIComponent(r.session)}`;
    return "";
}
