// CursorTipLayer.mjs — the gallery flow behind CursorTipLayer's `@gallery-flow` (src/sidebar/ui-kit.tsx). The layer
// draws nothing until the `cursorTip` signal is set (a hover over a `cursorTipOn` trigger does it), so this sets it
// through the module the gallery rendered it with, and checks that the text renders as inline markdown (code, emphasis)
// and that Escape takes it down. It ends with the tip up again, for the final shot.

/** Raise a tip inside the tile, with inline markdown in it: low in the tile, since the layer places a tip ABOVE the pointer. */
const raise = (page, tile) => tile.boundingBox().then((box) => page.evaluate(async ({ x, y }) => {
    const m = await globalThis.__gallery.module("CursorTipLayer");
    m.cursorTip.value = { x, y, text: "Reads `df['total']` from the **last** python_exec result." };
}, { x: box.x + 40, y: box.y + 150 }));

export default async ({ page, tile, shot }) => {
    await raise(page, tile);
    const tip = page.locator(".cursor-tip");
    await tip.waitFor({ timeout: 5_000 });
    await shot("raised");
    if (!(await tip.locator("code").count())) throw new Error("the backticks did not render as code");
    if (!(await tip.locator("strong, b").count())) throw new Error("the emphasis did not render");
    await page.keyboard.press("Escape");
    await tip.waitFor({ state: "detached", timeout: 5_000 });
    await raise(page, tile);
    await tip.waitFor({ timeout: 5_000 });
};
