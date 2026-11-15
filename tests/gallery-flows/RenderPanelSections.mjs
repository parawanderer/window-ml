// RenderPanelSections.mjs — the gallery flow behind RenderPanel's `@gallery-flow` (src/sidebar/transcript/render-panel.tsx).
// A result's sections (STDOUT, VALUE) in the calm chat: the same chevron the ml.sh footer draws, and a slide, not a snap,
// when one opens or closes. Sampled on every animation frame, because only a layout engine shows a snap.

export default async ({ page, tile, shot }) => {
    // These are the CALM chat's behaviours, and `gallery check` runs a flow in the dev view: switch the page to calm first.
    await page.evaluate(() => { const [path, q = ""] = location.hash.split("?"); const p = new URLSearchParams(q); p.set("view", "calm"); location.hash = `${path}?${p}`; });
    await page.waitForSelector(".gl-frame.calm");
    const sample = (act) => page.evaluate(([sel, act]) => new Promise((resolve) => {
        const el = document.querySelector(sel);
        const t0 = performance.now(), h = [];
        const chevron = () => getComputedStyle(el.querySelector("summary"), "::before").transform;
        const mask = getComputedStyle(el.querySelector("summary"), "::before").webkitMaskImage || getComputedStyle(el.querySelector("summary"), "::before").maskImage;
        el.querySelector("summary").click();
        const tick = () => { h.push(Math.round(el.getBoundingClientRect().height * 10) / 10); if (performance.now() - t0 < 420) requestAnimationFrame(tick); else resolve({ h, open: el.open, chevron: chevron(), mask }); };
        requestAnimationFrame(tick);
    }), [".gl-frame details.r-py-sec", act]);
    const fail = (m, r) => { throw new Error(`${m}: ${JSON.stringify(r.h)}`); };

    await shot("closed");
    const opening = await sample("open");
    if (!opening.open) fail("the section did not open", opening);
    if (!/mask|url/.test(String(opening.mask))) throw new Error(`no chevron mask on the summary: ${opening.mask}`);
    const total = opening.h[opening.h.length - 1] - opening.h[0];
    if (!(total > 20)) fail(`the section did not grow (${total}px)`, opening);
    for (let i = 1; i < opening.h.length; i++) {
        if (opening.h[i] < opening.h[i - 1] - 0.5) fail("the height went back while opening", opening);
        if (opening.h[i] - opening.h[i - 1] > total * 0.6) fail("the section SNAPPED open: one frame took most of the height", opening);
    }
    if (opening.chevron === "none") throw new Error("the chevron did not turn when the section opened");
    await shot("opened");

    const closing = await sample("close");
    if (closing.open) fail("the section did not close", closing);
    for (let i = 1; i < closing.h.length; i++) {
        if (closing.h[i] > closing.h[i - 1] + 0.5) fail("the height went up while closing", closing);
        if (closing.h[i - 1] - closing.h[i] > total * 0.6) fail("the section SNAPPED shut: one frame took most of the height", closing);
    }
    await shot("closed again");
};
