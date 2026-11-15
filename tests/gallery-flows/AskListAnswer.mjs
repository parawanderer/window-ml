// AskListAnswer.mjs — the gallery flow behind AskList's `@gallery-flow` (src/sidebar/transcript/ask-card.tsx). A command's ask in
// the calm chat, answered: the card eases away from the height it had. Sampled on every animation frame, because the faults
// were frame-sized: a frame with no card at all, a card 40px shorter than the one it replaced (the exit copy dropped its note
// and buttons), and an exit that sat still and then collapsed in its last third (a `max-height` ceiling far above the card).

export default async ({ page, shot }) => {
    const fail = (m, r) => { throw new Error(`${m}: ${JSON.stringify(r)}`); };
    await page.evaluate(() => { const [path, q = ""] = location.hash.split("?"); const p = new URLSearchParams(q); p.set("view", "calm"); location.hash = `${path}?${p}`; });
    await page.waitForSelector(".gl-frame.calm");
    await page.waitForTimeout(300);
    await shot("waiting");
    const r = await page.evaluate(() => new Promise((resolve) => {
        const q = () => document.querySelector(".gl-frame .astep-approve.ask");
        const h0 = q().getBoundingClientRect().height;
        const t0 = performance.now(), hs = [];
        [...document.querySelectorAll(".gl-frame .astep-approve.ask button")].find((b) => /approve/i.test(b.textContent)).click();
        const tick = () => { const e = q(); hs.push(e ? Math.round(e.getBoundingClientRect().height) : 0); if (performance.now() - t0 < 560) requestAnimationFrame(tick); else resolve({ h0: Math.round(h0), hs }); };
        requestAnimationFrame(tick);
    }));
    const { h0, hs } = r;
    if (!(h0 > 100)) fail("the card was not drawn at a real height", r);
    if (Math.abs(hs[0] - h0) > 3) fail(`the exit began at ${hs[0]}px, not the card's ${h0}px (a frame with no card, or a shorter copy of it)`, r);
    for (let i = 1; i < hs.length; i++) {
        if (hs[i] > hs[i - 1] + 1) fail("the card grew while leaving", r);
        if (hs[i - 1] - hs[i] > h0 * 0.22) fail(`the card dropped ${hs[i - 1] - hs[i]}px of ${h0} in one frame: it snapped`, r);
    }
    const first = hs.findIndex((h) => h <= h0 * 0.9);
    const done = hs.findIndex((h) => h === 0);
    if (first < 0 || done < 0) fail("the card never left", r);
    // It moves from the start: a card still at 90% of its height a third of the way through has only the last of the beat to go in.
    if (first > done / 3) fail("the exit sat still, then collapsed", r);
    await shot("gone");
};
