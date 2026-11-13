// route.ts — THE PAGE'S ADDRESSES: which view a URL names, and the URL for the view on screen, so a link can open the
// Devices tab or one session directly (`#/settings/devices`, `#/s/<runtime:hash>`). Pure, so the grammar is tested
// without a page.
//
// In the HASH, never the path: the extension's page is `chrome-extension://…/chat.html`, the phone app is served from
// its own bundle, and a static server has no fallback, so none of them can answer `/settings/devices`. A development
// server redirects such a path to its hash (tests/e2e/chat-shots.mjs). The old `#s=<key>` form still opens a session.
//
// The same grammar, minus the `#/`, is a `window-ml:` link's address (docs/spec/LINKS.md, "Addresses"), so a hash and a
// link cannot disagree about what an address means.

import type { SettingsAnchor, SettingsTab } from "./settings-page";
import { DEFAULT_CONFIG } from "../contract/contract-config";
import { PANEL_SECTIONS, PANEL_TABS, type PanelTab } from "../sidebar/settings/settings-sections";

/** The views a URL can name. */
export type MainRoute = "search" | "settings" | "attention";

/** What a URL names: a session, or a main view (and, for settings, which tab and block), or one setting's row, or
 *  neither (the list). */
export interface Route {
    session?: string;
    main?: MainRoute;
    tab?: SettingsTab;
    anchor?: SettingsAnchor;
    /** Under the Extension tab: a tab of the extension's settings view (`settings/extension/advanced`). */
    panelTab?: PanelTab;
    /** Under a panel tab: one of its sections (`settings/extension/advanced/shell`). */
    section?: string;
    /** One setting's row, by its config key (`setting/autoApproveReadonly`). */
    setting?: string;
}

const TABS: readonly SettingsTab[] = ["page", "runtimes", "devices", "extension", "housekeeping"];

/** The anchors each tab knows; one a tab does not list is dropped. */
const ANCHORS: Partial<Record<SettingsTab, readonly SettingsAnchor[]>> = { extension: ["backup"] };

/** A config key an address may name. Every `DEFAULT_CONFIG` key for now; the setting-place table narrows it to the
 *  keys with a row (LINKS.md). */
const isSettingKey = (k: string): boolean => Object.hasOwn(DEFAULT_CONFIG, k);

/** The route a hash names. Anything it does not know is the list, never an error: an old or mistyped link still opens the page. */
export function parseRoute(hash: string): Route {
    const legacy = /^#s=(.+)$/.exec(hash);
    if (legacy) return { session: decodeURIComponent(legacy[1]) };
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "s" && parts[1]) return { session: decodeURIComponent(parts.slice(1).join("/")) };
    if (parts[0] === "search" || parts[0] === "attention") return { main: parts[0] };
    if (parts[0] === "settings") {
        const tab = TABS.find((t) => t === parts[1]);
        if (!tab) return { main: "settings" };
        const anchor = ANCHORS[tab]?.find((a) => a === parts[2]);
        if (anchor) return { main: "settings", tab, anchor };
        const panelTab = tab === "extension" ? PANEL_TABS.find((t) => t === parts[2]) : undefined;
        if (!panelTab) return { main: "settings", tab };
        const section = PANEL_SECTIONS[panelTab].find((x) => x === parts[3]);
        return section ? { main: "settings", tab, panelTab, section } : { main: "settings", tab, panelTab };
    }
    if (parts[0] === "setting" && parts[1] && isSettingKey(parts[1])) return { setting: parts[1] };
    return {};
}

/** The hash for what is on screen. A main view wins over an open session, since it is drawn over it. */
export function formatRoute(r: Route): string {
    if (r.main === "settings") {
        if (!r.tab) return "#/settings";
        if (r.anchor && ANCHORS[r.tab]?.includes(r.anchor)) return `#/settings/${r.tab}/${r.anchor}`;
        if (r.tab !== "extension" || !r.panelTab || !PANEL_TABS.includes(r.panelTab)) return `#/settings/${r.tab}`;
        return r.section && PANEL_SECTIONS[r.panelTab].includes(r.section)
            ? `#/settings/${r.tab}/${r.panelTab}/${r.section}` : `#/settings/${r.tab}/${r.panelTab}`;
    }
    if (r.main) return `#/${r.main}`;
    if (r.setting && isSettingKey(r.setting)) return `#/setting/${r.setting}`;
    if (r.session) return `#/s/${encodeURIComponent(r.session)}`;
    return "";
}
