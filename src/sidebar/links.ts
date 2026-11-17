// links.ts — `[label](window-ml:<address>)` in the model's prose: which panel view an address names, the tip that
// says so, and the one click handler that opens it through `services().openAddress` (docs/spec/LINKS.md).
//
// A link opens a view; it never acts. The grammar (`settings/extension/<panelTab>[/<section>]`,
// `settings/extension/backup`, `setting/<key>`) is link-address.ts, which the worker shares.

import { PANEL_LAYOUT } from "../contract/contract-config";
import { services } from "./services";
import { BACKUP, formatAddress, parseAddress, type PanelRoute } from "../link-address";

/**
 * The chat page's hash for a panel view, the way back from {@link parseAddress}: where the extension's chat page,
 * which reads its own hash, sends a link it opens (docs/spec/LINKS.md, "What a click does").
 * @param r the resolved view
 */
export function addressHash(r: PanelRoute): string {
    return `#/${formatAddress(r)}`;
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
