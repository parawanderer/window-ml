// CodeDiff.mjs — the gallery flow behind CodeDiff's `@gallery-flow` (src/sidebar/transcript/render-panel.tsx). It opens the
// maximised view in the shared modal, hovers the close button so its tip shows (it must draw ABOVE the modal), shoots,
// then switches the view inside the modal and checks the inline block followed.

export default async ({ page, tile, shot }) => {
    await page.evaluate(() => globalThis.__gallery.mountTipLayer());
    await page.setViewportSize({ width: 1000, height: 640 });
    await tile.locator(".r-diff-max").click();
    await page.locator(".r-max").waitFor({ timeout: 5_000 });
    await page.locator(".r-max-head button[aria-label=Close]").hover();
    await page.locator(".cursor-tip").waitFor({ timeout: 5_000 });
    await shot("maximised, close tip");
    if (process.env.CODEDIFF_SHOTS) await page.screenshot({ path: `${process.env.CODEDIFF_SHOTS}-maximised.png` });
    const tipAbove = await page.evaluate(() => {
        const tip = document.querySelector(".cursor-tip"), back = document.querySelector(".chat-dialog-back");
        return Number(getComputedStyle(tip).zIndex) > Number(getComputedStyle(back).zIndex);
    });
    if (!tipAbove) throw new Error("the tip is not above the modal");
    const top = await page.evaluate(() => document.querySelector(".r-max-head").getBoundingClientRect().top - document.querySelector(".chat-dialog").getBoundingClientRect().top);
    if (top > 20) throw new Error(`the title row sits ${top}px below the modal's top`);
    await page.locator(".r-max-head .r-diff-segbtn", { hasText: "code" }).click();
    if (await page.locator(".r-max-head .r-diff-segbtn.on").innerText() !== "code") throw new Error("the modal's switch did not change view");
    await shot("switched to code in the modal");
    if (process.env.CODEDIFF_SHOTS) await page.screenshot({ path: `${process.env.CODEDIFF_SHOTS}-switched.png` });
};
