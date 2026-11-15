// JsonTreeStrings.mjs — the gallery flow behind JsonNode's `@gallery-flow` (src/sidebar/transcript/json-tree.tsx). A string in
// the tree: a long one cut with "show all", and one with escapes read in a hover card that waits for the pointer to rest,
// stays open while the pointer is in it (so it can be scrolled), lights the string, stays on screen and closes after the pointer
// leaves. A real layout is what shows a card cut off by the window or a highlight that never draws.

export default async ({ page, tile, shot }) => {
    const fail = (m) => { throw new Error(m); };
    // These are the CALM chat's behaviours, and `gallery check` runs a flow in the dev view: switch the page to calm first.
    await page.evaluate(() => { const [path, q = ""] = location.hash.split("?"); const p = new URLSearchParams(q); p.set("view", "calm"); location.hash = `${path}?${p}`; });
    await page.waitForSelector(".gl-frame.calm");
    const row = (key) => tile.locator(".jt-row", { has: page.locator(`.jt-key-text:text-is('"${key}"')`) });
    // The calm view's frame once squeezed the component into the chat page's 320px list column: the component's host must
    // be as wide as its frame.
    const widths = await page.evaluate(() => [document.querySelector(".gl-frame").getBoundingClientRect().width, document.querySelector(".gl-host").getBoundingClientRect().width]);
    if (Math.abs(widths[0] - widths[1]) > 1) fail(`the component is ${widths[1]}px in a ${widths[0]}px frame`);
    await shot("cut");

    // A long string: cut, then all of it, then cut again.
    const longVal = row("long").locator(".jt-val");
    if (!(await longVal.textContent()).includes("…")) fail("the long string was not cut");
    await row("long").locator("button.jt-more").click();
    if ((await longVal.textContent()).length < 600) fail("show all did not draw the whole string");
    await shot("expanded");
    await row("long").locator("button.jt-more").click();
    if (!(await longVal.textContent()).includes("…")) fail("show less did not cut it again");

    // A cut string has no escapes, and its card still reads all of it: the part the row cut is what the card is for.
    await longVal.hover();
    await page.waitForTimeout(700);
    const longCard = page.locator(".hc-card");
    if (!(await longCard.count())) fail("a cut string opened no card");
    if ((await longCard.innerText()).length < 600) fail("the cut string's card did not hold all of it");
    await page.mouse.move(2, 2, { steps: 4 });
    await page.waitForTimeout(600);

    // A string with escapes: nothing at once, the card after the pointer rests, the string lit.
    const multi = row("multi").locator(".jt-val");
    await multi.hover();
    await page.waitForTimeout(120);
    if (await page.locator(".hc-card").count()) fail("the card opened before the pointer had rested");
    await page.waitForTimeout(500);
    const card = page.locator(".hc-card");
    if (!(await card.count())) fail("the card did not open after the pointer rested");
    const text = await card.innerText();
    if (!text.includes("line one\nline two\n") && !text.includes("line one\nline two")) fail(`the card did not show the newlines as lines: ${JSON.stringify(text)}`);
    if (text.includes("\\n")) fail("the card still shows the \\n escape");
    const bg = await multi.evaluate((e) => getComputedStyle(e).backgroundColor);
    if (/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) fail(`the string was not lit while its card is open (${bg})`);
    await shot("card");

    // Into the card: it stays, and a long text scrolls inside it, inside the window.
    await row("script").locator(".jt-val").hover();
    await page.waitForTimeout(700);
    const big = page.locator(".hc-card");
    const box = await big.boundingBox();
    const vp = page.viewportSize();
    if (box.x < 0 || box.y < 0 || box.x + box.width > vp.width || box.y + box.height > vp.height) fail(`the card left the window: ${JSON.stringify(box)} in ${JSON.stringify(vp)}`);
    if (box.height > 245) fail(`the card is taller than its cap (${box.height}px)`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(450);                              // longer than the close delay: it must still be there
    if (!(await big.count())) fail("the card closed while the pointer was inside it");
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(100);
    if (!((await big.evaluate((e) => e.scrollTop)) > 0)) fail("the long text did not scroll inside the card");
    await shot("scrolled");

    // Away: it closes after a moment, not instantly.
    await page.mouse.move(2, 2, { steps: 4 });
    await page.waitForTimeout(80);
    if (!(await page.locator(".hc-card").count())) fail("the card closed the instant the pointer left");
    await page.waitForTimeout(600);
    if (await page.locator(".hc-card").count()) fail("the card stayed after the pointer left");
    await shot("closed");
};
