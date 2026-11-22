// GearMenuPanels.mjs — the second GearMenu flow: the Panels flyout, with each panel's own icon. See GearMenu.mjs.
import { openFlyout } from "./GearMenu.mjs";

export default async ({ page, tile }) => {
    const { menu, flyout, narrow } = await openFlyout(page, tile, "Panels");
    if (narrow) { await menu.locator(".chat-menu-item", { hasText: "Panels" }).click(); await page.waitForTimeout(600); return; }
    const n = await flyout.locator(".chat-menu-ico svg").count();
    if (n !== 4) throw new Error(`the Panels flyout shows ${n} glyphs, not 4`);
};
