// CodeMorphDemo.mjs — the flow behind CodeMorphDemo's `@gallery-flow` (src/sidebar/transcript/code-morph-demo.tsx). The calm
// chat's reformat of a streamed script and the approval card beside it, sampled every animation frame, because only a layout
// engine shows the glitches this guards against: a block that vanishes and returns, a height that steps or doubles back,
// a layer that outlives its beat, a second open animation after the first, a card that does not leave.

export default async ({ page, tile, shot }) => {
    const run = tile.locator(".code-morph-run");
    await shot("packed");

    // Sample the code block's height and the layer's life on every frame from the click until well after the beat.
    const trace = await page.evaluate(() => new Promise((resolve) => {
        const root = document.querySelector(".gl-frame, body");
        const cs = getComputedStyle(root.querySelector(".chat.calm") ?? root);
        const flowMs = parseFloat(cs.getPropertyValue("--calm-reflow-ms")), exitMs = parseFloat(cs.getPropertyValue("--calm-flow-ms"));
        const t0 = performance.now(), frames = [];
        const heightOf = () => root.querySelector("pre.code")?.getBoundingClientRect().height ?? null;
        const card = () => root.querySelector(".astep-approve.ask");
        document.querySelector(".code-morph-run").click();
        const tick = () => {
            const t = performance.now() - t0;
            frames.push({ t, h: heightOf(), layer: !!root.querySelector(".code-morph"), card: card() ? +getComputedStyle(card()).opacity : null, hidden: root.querySelector("pre.code > code") ? getComputedStyle(root.querySelector("pre.code > code")).visibility : null });
            if (t < flowMs + 400) requestAnimationFrame(tick); else resolve({ flowMs, exitMs, frames });
        };
        requestAnimationFrame(tick);
    }));
    const { flowMs, exitMs, frames } = trace;
    const fail = (m) => { throw new Error(`${m}\n${frames.map((f) => `${Math.round(f.t)}ms h=${f.h && Math.round(f.h)} layer=${f.layer} card=${f.card} code=${f.hidden}`).join("\n")}`); };
    if (!(flowMs > 0)) fail("no --calm-reflow-ms on the calm chat");

    // The block never disappears, and its height only ever grows, in steps that are a share of the whole: no jump, no doubling back.
    const hs = frames.map((f) => f.h);
    if (hs.some((h) => h == null || h <= 0)) fail("the code block vanished for a frame");
    const total = hs[hs.length - 1] - hs[0];
    if (!(total > 40)) fail(`the block did not grow (${total}px)`);
    for (let i = 1; i < hs.length; i++) {
        if (hs[i] < hs[i - 1] - 0.5) fail(`the height went back at frame ${i}: ${hs[i - 1]} → ${hs[i]}`);
        if (hs[i] - hs[i - 1] > total * 0.4) fail(`the height jumped ${Math.round(hs[i] - hs[i - 1])}px of ${Math.round(total)} in one frame at ${i}`);
    }
    // The flying layer exists for the beat and is gone after it; the real text is hidden only while it is there.
    const layered = frames.filter((f) => f.layer);
    if (!layered.length) fail("no flying characters");
    if (layered[layered.length - 1].t > flowMs + 160) fail("the layer outlived its beat");
    if (frames.filter((f) => !f.layer && f.t > flowMs + 160).some((f) => f.hidden === "hidden")) fail("the code text stayed hidden after the layer left");
    // The card fades in over the same beat: never fully there in the first frames, fully there when the beat is over.
    const cards = frames.filter((f) => f.card != null);
    if (!cards.length || cards[0].card > 0.5) fail(`the card did not fade in (first opacity ${cards[0]?.card})`);
    if (frames.filter((f) => f.t > flowMs + 120).some((f) => f.card !== 1)) fail("the card was not fully shown when the beat was over");
    for (let i = 1; i < cards.length; i++) if (cards[i].card < cards[i - 1].card - 0.01) fail("the card's opacity went back while fading in");

    // The settled block is where a plain render of the same code puts it: the flying characters land on the real text.
    const landed = await tile.locator("pre.code").first().evaluate((pre) => pre.getBoundingClientRect().height);
    if (Math.abs(landed - hs[hs.length - 1]) > 1) fail("the block's height moved after the beat");
    await shot("settled");

    // Answering sends the card away over the same beat, and it is gone from the page.
    await tile.locator(".code-morph-approve").click();
    await page.waitForTimeout(exitMs / 2);
    const mid = await tile.locator(".astep-approve").first().evaluate((e) => +getComputedStyle(e).opacity);
    if (!(mid > 0 && mid < 1)) fail(`the card was not mid-fade half way through its exit (${mid})`);
    await page.waitForTimeout(exitMs + 150);
    if (await tile.locator(".astep-approve").count()) fail("the card was still on the page after its exit");
    await shot("answered");

    // Under reduced motion nothing flies: the block simply appears.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await tile.locator(".code-morph-run").click();      // Again → packed
    await tile.locator(".code-morph-run").click();      // Run
    await page.waitForTimeout(40);
    if (await tile.locator(".code-morph").count()) fail("characters flew under reduced motion");
    await page.emulateMedia({ reducedMotion: "no-preference" });
};
