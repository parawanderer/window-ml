// SessionHoverCard.mjs — the gallery flow behind SessionHoverCard's `@gallery-flow` (src/chat/session-summary.tsx). The card
// draws nothing until the pointer rests on the title: this opens it and checks it holds the title and the short form's
// lines (state, model, last activity, open asks) and nothing from the long form.

export default async ({ page, tile, shot }) => {
    const fail = (m) => { throw new Error(m); };
    await page.mouse.move(0, 0);
    await shot("rest");
    await tile.locator(".hc").hover({ position: { x: 12, y: 4 } });
    await page.waitForTimeout(700);
    const card = page.locator(".hc-card");
    if (!(await card.count())) fail("the card did not open after the pointer rested");
    const fields = await card.locator(".sum-line").evaluateAll((els) => els.map((e) => e.getAttribute("data-field")));
    if (fields.join() !== "state,asks,last,model") fail(`the short form drew ${fields.join()}`);
    if (!(await card.locator(".sum-hc-title").innerText()).includes("Plot the fare prices")) fail("the card has no title");
    await shot("card");
};
