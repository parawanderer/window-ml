// StepStreak.mjs — the gallery flow behind StepStreak's `@gallery-flow` (src/sidebar/transcript/step-streak.tsx). Opening a
// folded group makes its summary (the tool names and the failure count) slide out to the left and fade; folding it brings
// the summary back. The count and the duration must not move while that happens, which only a layout engine can show.

export default async ({ tile, page, shot }) => {
    // The slide is the reading view's alone (the panel's row is untouched), so the flow puts the page in it however it was
    // reached: `check` renders every example in the default view.
    await page.evaluate(() => { if (!location.hash.includes("view=calm")) location.hash += (location.hash.includes("?") ? "&" : "?") + "view=calm"; });
    await page.locator(".gl-frame.calm .astreak-head").first().waitFor({ timeout: 5_000 });
    const head = tile.locator(".astreak-head");
    await head.waitFor({ timeout: 5_000 });
    const read = () => tile.evaluate((root) => {
        const q = (sel) => root.querySelector(sel);
        const o = (el) => Number(getComputedStyle(el).opacity);
        const x = (el) => el.getBoundingClientRect().left;
        return { names: o(q(".astreak-tools")), bad: o(q(".astreak-bad")), vis: getComputedStyle(q(".astreak-tools")).visibility,
            nLeft: x(q(".astreak-calls")), msLeft: x(q(".astreak-ms")), expanded: q(".astreak").classList.contains("expanded") };
    });
    // Caught on a frame rather than at a fixed delay: a loaded machine starts the transition late, and what matters is
    // to get the mid-motion frame for the screenshot. It is best effort: a page `check` renders in the background may have its frames
    // throttled past the whole fade, and the end states below are what the flow asserts.
    const midFade = () => page.waitForFunction(() => {
        const o = Number(getComputedStyle(document.querySelector(".astreak-tools")).opacity);
        return o > 0.05 && o < 0.95;
    }, null, { polling: "raf", timeout: 2_000 }).catch(() => {});
    const folded = await read();
    if (folded.names !== 1 || folded.bad !== 1 || folded.expanded) throw new Error(`folded group must show its summary: ${JSON.stringify(folded)}`);
    await shot("folded");

    await head.click();
    await midFade();
    await shot("opening-mid");
    await page.waitForTimeout(400);
    const open = await read();
    if (open.names !== 0 || open.bad !== 0 || open.vis !== "hidden") throw new Error(`open group must hide its summary: ${JSON.stringify(open)}`);
    if (Math.abs(open.nLeft - folded.nLeft) > 0.5 || Math.abs(open.msLeft - folded.msLeft) > 0.5) throw new Error(`count or duration moved: ${JSON.stringify({ folded, open })}`);
    await shot("open");

    await head.click();
    await midFade();
    await shot("folding-mid");
    await page.waitForTimeout(400);
    const again = await read();
    if (again.names !== 1 || again.bad !== 1) throw new Error(`folded again must show the summary: ${JSON.stringify(again)}`);
    await shot("folded-again");
};
