// UsageChartView.mjs — the gallery flow behind UsageChartView's `@gallery-flow` (src/chat/session-resources.tsx). The readout
// draws nothing until the plot is pointed at: this hovers it and checks the cursor tip (read from its signal: the gallery mounts no tip layer) lists the call's prompt, completion and
// total, and that the rule is up. Then it drags across the first burst of the multi-day session, checks the chip that offers to leave the
// selection appears, and clicks it away.

export default async ({ page, tile, shot }) => {
    const fail = (m) => { throw new Error(m); };
    await page.mouse.move(0, 0);
    await shot("rest");
    const plot = tile.locator(".sum-plot");
    await plot.scrollIntoViewIfNeeded();   // the tile can sit below the fold of a page that lists several variants
    const box = await plot.boundingBox();
    if (!box) fail("no plot box");
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(200);
    // The gallery page mounts no cursor-tip layer, so the tip is read from the signal the readout sets (the module is the
    // one the rendered chart uses) and the shot shows the rule.
    const text = await page.evaluate(async () => {
        const m = await globalThis.__gallery.module("CursorTipLayer");
        const seen = new Set();
        const words = [];
        const walk = (n) => {
            if (n == null || typeof n === "boolean") return;
            if (typeof n !== "object") { words.push(String(n)); return; }
            if (seen.has(n)) return;
            seen.add(n);
            if (Array.isArray(n)) { n.forEach(walk); return; }
            walk(n.props?.children);
        };
        walk(m.cursorTip.value?.node);
        return words.join(" ");
    });
    if (!text) fail("no tip after pointing at the plot");
    for (const w of ["Prompt", "Completion", "Total"]) if (!text.includes(w)) fail(`the tip lacks ${w}: ${text}`);
    if (!(await tile.locator(".rc-cross").count())) fail("no cursor rule");
    await shot("readout");
    // A selection: drag across the first burst; the chip appears, the plot now holds fewer marks, and the chip clears it.
    const all = await tile.locator(".sum-chart circle").count();
    await page.mouse.move(box.x + 2, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    if (!(await tile.locator(".vram-zoom").count())) fail("no chip after a drag-select");
    const some = await tile.locator(".sum-chart circle").count();
    if (!(some > 0 && some < all)) fail(`the selection drew ${some} of ${all} marks`);
    await shot("selected");
    await tile.locator(".vram-zoom").click();
    await page.waitForTimeout(200);
    if ((await tile.locator(".sum-chart circle").count()) !== all) fail("clearing the selection did not bring every mark back");
};
