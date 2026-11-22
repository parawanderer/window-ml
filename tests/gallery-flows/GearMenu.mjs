// GearMenu.mjs — the gallery flow behind GearMenu's `@gallery-flow` (src/chat/nav.tsx). The menu is closed until the
// gear is clicked, and a group's flyout opens on hover, so this opens the menu, hovers "Theme for this page", and checks
// what a person would: the flyout appears beside the menu with the row's top lined up, it holds the four theme choices
// with a glyph each, the row stays lit, Escape closes the flyout before the menu. It ends with the Theme flyout open.
// On a phone (a narrow viewport: --size 420x900) the same row slides over the menu instead. Run: node scripts/gallery.mjs shot GearMenu --variant 'theme flyout'

/** Open the gear menu, then the flyout of the row named `row` (by hovering it, as a person does). */
export async function openFlyout(page, tile, row) {
    // The menu rises ABOVE the gear: give the tile the room, or it draws over the card's heading.
    await tile.evaluate((el) => { el.style.paddingTop = "340px"; el.style.paddingBottom = "130px"; });
    await tile.locator(".chat-gear-btn").click();
    const menu = page.locator(".chat-gear-menu");
    await menu.waitFor({ timeout: 5_000 });
    const narrow = await page.evaluate(() => matchMedia("(max-width: 760px)").matches);
    if (narrow) return { menu, flyout: null, narrow, parent: menu.locator(".chat-menu-item", { hasText: row }) };
    const parent = menu.locator(".chat-menu-item", { hasText: row });
    await parent.hover();
    const flyout = page.locator(".chat-menu-flyout");
    await flyout.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(500);
    return { menu, flyout, parent, narrow };
}

/** Phone: the menu, then the group's page sliding over it; checks the back row, then goes back and in again. */
export async function slideOver(page, menu, parent, shot, label) {
    await page.waitForTimeout(400);
    await shot("menu");
    await parent.click();
    await page.waitForTimeout(600);
    const back = menu.locator(".chat-menu-back");
    if (!(await back.isVisible())) throw new Error("the back row is not there");
    if (!(await back.textContent()).includes(label)) throw new Error("the back row does not name the group");
    if (await menu.locator(":scope > .chat-menu-item:visible", { hasText: "Settings" }).count()) throw new Error("the menu's own rows still show");
    await shot("in");
    await back.click();
    await page.waitForTimeout(600);
    if (!(await menu.locator(":scope > .chat-menu-item", { hasText: "Settings" }).isVisible())) throw new Error("going back did not restore the menu");
    await parent.click();
    await page.waitForTimeout(600);
}

export default async ({ page, tile, shot }) => {
    const { menu, flyout, parent, narrow } = await openFlyout(page, tile, "Theme for this page");
    if (narrow) { await slideOver(page, menu, parent, shot, "Theme for this page"); return; }
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
