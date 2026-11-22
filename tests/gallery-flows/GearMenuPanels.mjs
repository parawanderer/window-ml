// GearMenuPanels.mjs — the second GearMenu flow: the Panels flyout, with each panel's own icon. See GearMenu.mjs.
import { openFlyout, slideOver } from "./GearMenu.mjs";

export default async ({ page, tile, shot }) => {
    const { menu, flyout, narrow, parent } = await openFlyout(page, tile, "Panels");
    if (narrow) { await slideOver(page, menu, parent, shot, "Panels"); return; }
    const n = await flyout.locator(".chat-menu-ico svg").count();
    const heads = await flyout.locator(".chat-menu-section-head").allTextContents();
    if (heads.join() !== "mlbox,This browser") throw new Error(`the section headers are [${heads}]`);
    if (n !== 4) throw new Error(`the Panels flyout shows ${n} glyphs, not 4`);
};
