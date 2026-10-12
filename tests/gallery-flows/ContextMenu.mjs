// ContextMenu.mjs — the gallery flow behind ContextMenu's `@gallery-flow` (src/sidebar/ui-kit.tsx). The menu draws
// nothing until the `ctxMenu` signal is set (a right-click calls `openCtxMenu`), so this sets it through the module the
// gallery rendered it with, then checks what a person would: the items, a disabled one refusing, a click running its
// action and closing the menu. It ends with the menu open again, for the final shot. Run: node scripts/gallery.mjs shot ContextMenu

/** Open the menu inside the tile, with three items, one disabled; the actions record into `__ran`. */
const open = (page, tile) => tile.boundingBox().then((box) => page.evaluate(async ({ x, y }) => {
    const m = await globalThis.__gallery.module("ContextMenu");
    globalThis.__ran = [];
    m.ctxMenu.value = { x, y, items: [
        { label: "Copy document.querySelector(…)", run: () => globalThis.__ran.push("selector") },
        { label: "Copy pointer", run: () => globalThis.__ran.push("pointer") },
        { label: "Reveal in DevTools", run: () => globalThis.__ran.push("devtools"), disabled: true },
    ] };
}, { x: box.x + 24, y: box.y + 16 }));

export default async ({ page, tile, shot }) => {
    await open(page, tile);
    const menu = page.locator(".ctx-menu");
    await menu.waitFor({ timeout: 5_000 });
    await shot("open");
    const n = await menu.locator(".ctx-item").count();
    if (n !== 3) throw new Error(`the menu shows ${n} items, not 3`);
    if (!(await menu.locator(".ctx-item.off").isDisabled())) throw new Error("the disabled item is clickable");
    await menu.locator(".ctx-item", { hasText: "Copy pointer" }).click();
    await menu.waitFor({ state: "detached", timeout: 5_000 });
    const ran = await page.evaluate(() => globalThis.__ran);
    if (ran.join() !== "pointer") throw new Error(`the click ran [${ran}], not [pointer]`);
    await open(page, tile);
    await menu.waitFor({ timeout: 5_000 });
};
