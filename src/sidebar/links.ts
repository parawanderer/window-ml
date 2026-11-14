// links.ts — `[label](window-ml:<address>)` in the model's prose: which panel view an address names, the tip that
// says so, and the one click handler that opens it through `services().openAddress` (docs/spec/LINKS.md).
//
// A link opens a view; it never acts. The grammar here is the DevTools Settings panel's part of the chat page's
// addresses, parsed by its parser (`parseRoute`, src/chat/route.ts): `settings/extension/<panelTab>[/<section>]`,
// `settings/extension/backup` and `setting/<key>`, so a link and a hash cannot disagree about what an address means.

import { PANEL_LAYOUT, SETTING_PLACES, type MlConfig, type PanelTab } from "../contract/contract-config";
import { formatRoute, parseRoute } from "../chat/route";
import { services } from "./services";

/** A view of the DevTools Settings panel a link can open: a tab, a section open on it, or one setting's row. */
export interface PanelRoute {
    tab: PanelTab;
    section?: string;
    /** the config key whose row is scrolled to and marked */
    setting?: keyof MlConfig;
    /** an element id to scroll to (the Backup block) */
    target?: string;
}

/** Settings → Storage → Backup and restore: what the `settings/extension/backup` alias opens. Mirrors
 *  `BACKUP_TAB`/`BACKUP_BLOCK_ID` in settings.tsx, which this file does not import so a renderer stays light;
 *  tests/setting-places.test.js holds the copy to the panel it draws. */
const BACKUP: PanelRoute = { tab: "appearance", section: "storage", target: "set-backup" };

/**
 * The panel view an address names, or null for anything this grammar does not know. Null is final for a link: the
 * model naming a place that is not there renders as its label. `parseRoute` falls back to a wider view for what it
 * does not know (an old URL still opens the page); a link does not, so an address is accepted only when it is
 * exactly the one its route formats back to: no query, fragment, unknown part or extra part.
 * @param address what follows `window-ml:`
 */
export function parseAddress(address: string): PanelRoute | null {
    if (!/^[A-Za-z0-9_/-]+$/.test(address)) return null;
    const hash = `#/${address}`;
    const r = parseRoute(hash);
    if (formatRoute(r) !== hash) return null;
    if (r.setting) return { ...SETTING_PLACES[r.setting as keyof MlConfig]!, setting: r.setting as keyof MlConfig };
    if (r.anchor === "backup") return { ...BACKUP };
    if (!r.panelTab) return null;
    return r.section ? { tab: r.panelTab, section: r.section } : { tab: r.panelTab };
}

/**
 * The chat page's hash for a panel view, the way back from {@link parseAddress}: where the extension's chat page,
 * which reads its own hash, sends a link it opens (docs/spec/LINKS.md, "What a click does").
 * @param r the resolved view
 */
export function addressHash(r: PanelRoute): string {
    if (r.setting) return formatRoute({ setting: r.setting });
    if (r.target === BACKUP.target) return formatRoute({ main: "settings", tab: "extension", anchor: "backup" });
    return formatRoute({ main: "settings", tab: "extension", panelTab: r.tab, section: r.section });
}

/**
 * What a link's tip says: where it goes, from the resolved address and never from the label, since link text and
 * destination are the two things Markdown lets disagree.
 * @param r the resolved view
 */
export function addressTip(r: PanelRoute): string {
    const tab = PANEL_LAYOUT[r.tab];
    const path = ["Settings", tab.label];
    if (r.target === BACKUP.target) path.push("Storage", "Backup and restore");
    else if (r.section) path.push(tab.sections[r.section] ?? r.section);
    return `Opens ${path.join(" → ")}${r.setting ? `, at ${r.setting}` : ""}`;
}

/**
 * How to draw a `window-ml:` link on this surface: its route and tip, or null to draw the label alone. Null where
 * the address does not parse or this surface cannot open a panel view (`openAddress` absent).
 * @param address what follows `window-ml:`
 */
export function resolveLink(address: string): { route: PanelRoute; tip: string } | null {
    if (!services().openAddress) return null;
    const route = parseAddress(address);
    return route ? { route, tip: addressTip(route) } : null;
}

/** The `markdown()` option that draws a `window-ml:` link as a button: its tip, or null to leave the label. */
export const linkTipFor = (address: string): string | null => resolveLink(address)?.tip ?? null;

/**
 * Open what a `.md-addr` button names, for a click anywhere in a view drawn from `markdown()`'s HTML. The address
 * is parsed again at click time, from the button's own attribute: nothing the HTML carries is trusted as a route.
 * @param e the click
 * @returns whether the click was a link's
 */
export function onAddressClick(e: Event): boolean {
    const btn = (e.target as Element | null)?.closest?.("button.md-addr");
    const address = btn?.getAttribute("data-addr");
    if (!address) return false;
    const r = resolveLink(address);
    if (r) services().openAddress?.(r.route);
    e.preventDefault();
    return true;
}
