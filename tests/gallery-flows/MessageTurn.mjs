// MessageTurn.mjs — the gallery flow behind MessageTurn's `@gallery-flow` (src/sidebar/transcript/reply.tsx). It guards
// the calm view's user stamp: at rest the time is drawn and the copy and edit buttons are not, and hovering the bubble
// brings the buttons in without moving the time. Run: node scripts/gallery.mjs flow MessageTurn --view calm

export default async ({ page, tile, shot }) => {
    const row = tile.locator(".msg.user .mrow");
    const stamp = row.locator(".time");
    const acts = row.locator(".umsg-acts");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    const op = (l) => l.evaluate((el) => Number(getComputedStyle(el).opacity));
    const restTime = await op(stamp), restActs = await op(acts);
    const before = await stamp.boundingBox();
    await shot("rest");
    await tile.locator(".msg.user .utext").hover();
    await page.waitForTimeout(400);
    const hoverActs = await op(acts);
    const after = await stamp.boundingBox();
    await shot("hover");
    if (!(restTime > 0.4)) throw new Error(`the time is hidden at rest (opacity ${restTime})`);
    if (restActs !== 0) throw new Error(`the buttons show at rest (opacity ${restActs})`);
    if (!(hoverActs > 0.4)) throw new Error(`the buttons stay hidden on hover (opacity ${hoverActs})`);
    if (Math.abs(before.x - after.x) > 0.5) throw new Error("the time moved when the buttons appeared");
};
