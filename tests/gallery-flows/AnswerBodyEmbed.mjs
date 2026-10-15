// AnswerBodyEmbed.mjs — the gallery flow behind AnswerBody's embed `@gallery-flow` (src/sidebar/transcript/answer-render.tsx).
// An embedded block's fold only exists in the reading (calm) view, so the flow switches to it first. It checks the
// embed's own controls (copy, tree/text, quoted keys), folds it by its rail, and that the folded row's label and rail
// answer the pointer, then opens it again. It ends folded, with the label hovered, for the final shot.

export default async ({ page, tile, shot }) => {
    await page.getByRole("button", { name: "calm", exact: true }).click();
    const embed = tile.locator(".tok-block").first();
    await embed.waitFor({ timeout: 5_000 });
    if (!(await embed.locator('button[aria-label="copy the value"]').count())) throw new Error("the embed has no copy button");
    const toggle = embed.locator("button.code-tool", { hasText: "tree" });
    await toggle.click();
    const keys = await embed.locator(".jt-key").allTextContents();
    if (!keys.length || keys.some((k) => !k.startsWith('"'))) throw new Error(`tree keys are not all quoted: ${JSON.stringify(keys)}`);
    await shot("tree");
    await embed.locator("button.code-tool", { hasText: "text" }).click();

    await embed.locator(".fold-rail").first().click({ force: true });
    const folded = tile.locator(".tok-folded");
    await folded.waitFor({ timeout: 5_000 });
    const name = folded.locator(".tok-fold-name");
    await page.waitForTimeout(400);   // past the slide-in
    const colour = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
    const before = await colour(name);
    await name.hover();
    await page.waitForTimeout(100);
    if ((await colour(name)) === before) throw new Error("the folded label did not change colour under the pointer");
    const railColour = (loc) => loc.evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
    const rail = folded.locator(".fold-rail");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const railBefore = await railColour(rail);
    await rail.hover({ force: true });
    await page.waitForTimeout(250);
    if ((await railColour(rail)) === railBefore) throw new Error("the folded rail did not change colour under the pointer");

    await folded.click();
    await tile.locator(".tok-body").first().waitFor({ timeout: 5_000 });
    await embed.locator(".fold-rail").first().click({ force: true });
    await folded.waitFor({ timeout: 5_000 });
    await name.hover();
    await page.waitForTimeout(400);
};
