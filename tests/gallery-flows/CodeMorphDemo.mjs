// The packed script, then the click, a frame while the characters fly, and the settled block.
export default async ({ page, tile, shot }) => {
    await shot("packed");
    await tile.locator(".code-morph-run").click();
    await page.waitForTimeout(110);
    if (!(await tile.locator(".code-morph > span").count())) throw new Error("no flying characters: the morph drew nothing");
    await shot("flying");
    await page.waitForTimeout(500);
    await shot("settled");
};
