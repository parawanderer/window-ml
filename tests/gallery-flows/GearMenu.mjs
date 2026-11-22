// GearMenu.mjs — the gallery flow behind GearMenu's `@gallery-flow` (src/chat/nav.tsx). The menu is closed until the
// gear is clicked, and a group's flyout opens on hover, so this opens the menu, hovers "Theme for this page", and checks
// what a person would: the flyout appears beside the menu with the row's top lined up, it holds the four theme choices
// with a glyph each, the row stays lit, Escape closes the flyout before the menu. It ends with the Theme flyout open.
// Wide layouts only: on a phone the same row expands in place (shoot it with --width phone). Run: node scripts/gallery.mjs shot GearMenu --variant 'theme flyout'

/** Open the gear menu, then the flyout of the row named `row` (by hovering it, as a person does). */
export async function openFlyout(page, tile, row) {
    // The menu rises ABOVE the gear: give the tile the room, or it draws over the card's heading.
    await tile.evaluate((el) => { el.style.paddingTop = "340px"; });
    await tile.locator(".chat-gear-btn").click();
    const menu = page.locator(".chat-gear-menu");
    await menu.waitFor({ timeout: 5_000 });
    const narrow = await page.evaluate(() => matchMedia("(max-width: 760px)").matches);
    if (narrow) return { menu, flyout: null, narrow };
    const parent = menu.locator(".chat-menu-item", { hasText: row });
    await parent.hover();
    const flyout = page.locator(".chat-menu-flyout");
    await flyout.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(500);
    return { menu, flyout, parent, narrow };
}

export default async ({ page, tile, shot }) => {
    const { menu, flyout, parent, narrow } = await openFlyout(page, tile, "Theme for this page");
    if (narrow) { await menu.locator(".chat-menu-item", { hasText: "Theme for this page" }).click(); await page.waitForTimeout(600); return; }
    const labels = await flyout.locator(".chat-menu-label").allTextContents();
    if (!/System/.test(labels.join()) || !/Dark/.test(labels.join())) throw new Error(`the flyout holds [${labels}]`);
    if ((await flyout.locator(".chat-menu-ico svg").count()) !== labels.length) throw new Error("a theme choice has no glyph");
    const [fb, pb] = await Promise.all([flyout.locator("button").first().boundingBox(), parent.boundingBox()]);
    if (Math.abs(fb.y - pb.y) > 3) throw new Error(`the first choice is ${fb.y - pb.y}px off the row`);
    if (!(await parent.evaluate((el) => el.classList.contains("fly-open")))) throw new Error("the parent row is not lit");
    await shot("flyout");
    await page.keyboard.press("Escape");
    await flyout.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    if (!(await menu.isVisible())) throw new Error("the first Escape closed the menu too");
    // The pointer is still on the row, which would not enter it again: leave, then come back.
    await page.mouse.move(0, 0);
    await parent.hover();
    await flyout.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(500);
};
