// link-address.ts — what a `window-ml:` address names: the DevTools Settings panel's part of the chat page's
// addresses (docs/spec/LINKS.md), parsed by its parser (`parseRoute`, src/chat/route.ts), and formatted back.
//
// Pure, so the worker parses with it too: a surface that cannot open the panel (the HUD card) asks the worker to open
// the chat page at an address, and the worker accepts exactly the addresses a link resolves, never a URL.

import { parseRoute, formatRoute } from "./chat/route";
import { type PanelTab, type MlConfig, SETTING_PLACES } from "./contract";

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
export const BACKUP: PanelRoute = { tab: "appearance", section: "storage", target: "set-backup" };

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
 * The address of a panel view: the inverse of `parseAddress`, so `formatAddress(parseAddress(a)!) === a` for every
 * address that parses. How a surface that cannot open the panel names the view to open elsewhere.
 * @param r the resolved view
 */
export function formatAddress(r: PanelRoute): string {
    if (r.setting) return `setting/${r.setting}`;
    if (r.target === BACKUP.target) return "settings/extension/backup";
    return r.section ? `settings/extension/${r.tab}/${r.section}` : `settings/extension/${r.tab}`;
}
