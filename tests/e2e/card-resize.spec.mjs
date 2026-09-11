// card-resize.spec.mjs — the corner card's WIDTH handle, against real layout.
//
// The card already had a height handle on whichever HORIZONTAL edge is free. Width is the same affordance on
// the other axis, and it needs a real browser for the same reason: which edge is free depends on the corner
// the card is anchored to, and the anchored edge staying put is a fact about computed geometry, not about
// state. jsdom reports every element as zero-sized, so none of it is observable there.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** Drive a background-hosted run so the corner card mounts, and hand back its wrap's geometry reader. */
async function cardOnScreen(page, fake) {
    fake.setScript([{ content: "done." }]);
    await page.evaluate(() => { window.__run = window.ml.agent("say something"); });
    await page.waitForFunction(() => !!document.getElementById("ml-sb-card")?.shadowRoot, null, { timeout: 20000 });
    // The card starts as an orb; the width handle exists ONLY in the fully expanded state, which is the one
    // state whose width is a reading measure worth choosing. So wait for that rather than measuring a circle.
    await page.waitForFunction(() => {
        const w = document.getElementById("ml-sb-card")?.shadowRoot?.getElementById("ml-sb-card-wrap");
        return w?.dataset.state === "expanded";
    }, null, { timeout: 20000 });
    const once = () => page.evaluate(() => {
        const w = document.getElementById("ml-sb-card").shadowRoot.getElementById("ml-sb-card-wrap");
        const r = w.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), corner: w.dataset.corner };
    });
    // SETTLED, not instantaneous. The card's width is a CSS transition (0.4s), so a rect read the moment a
    // state lands is a frame partway through the animation — which is how a 140px drag first measured as a
    // 46px growth. Two matching reads is the cheap way to say "it has stopped moving".
    return async () => {
        let prev = await once();
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(80);
            const now = await once();
            if (now.width === prev.width && now.right === prev.right) return now;
            prev = now;
        }
        return prev;
    };
}

/** Grab the width handle and drag it by `dx` page pixels. */
async function dragWidth(page, dx) {
    const box = await page.evaluate(() => {
        const h = document.getElementById("ml-sb-card").shadowRoot.getElementById("ml-sb-card-resize-x");
        const r = h.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + dx, box.y, { steps: 8 });
    await page.mouse.up();
}

test("corner card: dragging the free vertical edge resizes the width, and the anchored edge stays put", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "off",   // off → the run is background-hosted and the HUD is the corner card
        });
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const read = await cardOnScreen(page, fake);

        const before = await read();
        expect(before.corner).toMatch(/right$/);          // the default corner
        // Anchored right → the handle is on the LEFT, and dragging it left makes the card WIDER.
        await dragWidth(page, -120);
        const after = await read();
        expect(after.width).toBeGreaterThan(before.width + 60);
        // The anchored edge is the point of the exercise: a card that grew by moving its right edge would
        // walk off the corner it is pinned to.
        expect(Math.abs(after.right - before.right)).toBeLessThanOrEqual(2);

        // …and back the other way.
        await dragWidth(page, 90);
        const narrower = await read();
        expect(narrower.width).toBeLessThan(after.width - 40);
        expect(Math.abs(narrower.right - before.right)).toBeLessThanOrEqual(2);
    } finally {
        await ext.close(); await site.stop(); await fake.stop();
    }
});

test("corner card: the width handle exists ONLY on the expanded card", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
        });
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await cardOnScreen(page, fake);
        const visible = () => page.evaluate(() => {
            const sr = document.getElementById("ml-sb-card").shadowRoot;
            const el = sr.getElementById("ml-sb-card-resize-x");
            return { state: sr.getElementById("ml-sb-card-wrap").dataset.state, shown: el.getBoundingClientRect().width > 0 };
        });
        expect(await visible()).toEqual({ state: "expanded", shown: true });

        // Collapse to the orb. The drag does nothing there — the orb is a circle sized by what it contains —
        // so the handle must not be grabbable either: an affordance that does nothing is worse than none.
        await page.evaluate(() => {
            const sr = document.getElementById("ml-sb-card").shadowRoot;
            sr.getElementById("ml-sb-card-wrap").dataset.state = "orb";
        });
        expect((await visible()).shown).toBe(false);

        // The HEIGHT handle has the same rule and had the same gap: `cardH` reads the dragged height only for
        // the expanded card, so outside it the top edge was grabbable and inert.
        const heightShown = () => page.evaluate(() => {
            const sr = document.getElementById("ml-sb-card").shadowRoot;
            return sr.getElementById("ml-sb-card-resize").getBoundingClientRect().height > 0;
        });
        expect(await heightShown()).toBe(false);
        await page.evaluate(() => {
            document.getElementById("ml-sb-card").shadowRoot.getElementById("ml-sb-card-wrap").dataset.state = "expanded";
        });
        expect(await heightShown()).toBe(true);
    } finally {
        await ext.close(); await site.stop(); await fake.stop();
    }
});

test("corner card: the width SURVIVES a reload, and double-click restores the default", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
        });
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        let read = await cardOnScreen(page, fake);
        const dflt = (await read()).width;
        await dragWidth(page, -140);
        const chosen = (await read()).width;
        expect(chosen).toBeGreaterThan(dflt + 60);

        // Unlike the HEIGHT — which is content-driven, so a drag is a momentary hold the next step supersedes
        // — a width is a preference: nothing about the content argues with it, so it is persisted.
        await page.reload();
        await waitForMl(page);
        read = await cardOnScreen(page, fake);
        expect(Math.abs((await read()).width - chosen)).toBeLessThanOrEqual(4);

        // Double-click is the way back, matching the height handle's own reset.
        const h = await page.evaluate(() => {
            const el = document.getElementById("ml-sb-card").shadowRoot.getElementById("ml-sb-card-resize-x");
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        await page.mouse.dblclick(h.x, h.y);
        await expect.poll(async () => (await read()).width, { timeout: 5000 }).toBe(dflt);
    } finally {
        await ext.close(); await site.stop(); await fake.stop();
    }
});

// A DRAG MUST TRACK THE HAND; a programmatic move must animate. The card carries a 0.4s width/height spring
// so a state change reads as something happening, and the drag handlers already added `.no-anim` to suppress
// it — except the rule never won: `#wrap.no-anim` and `#wrap[data-state="expanded"]` are both specificity
// (1,1,0), a TIE resolved by source order, and the state rule is declared later. So every drag was fought by
// a 0.4s ease and felt like dragging through treacle, while the class sat there looking correct.
//
// Only a real browser can answer this: it is a COMPUTED transition on the shell's own wrap (a content-script
// shadow host, not the iframe app), and jsdom neither computes the cascade this way nor runs the drag.
test("corner card: dragging is instant, and a programmatic resize still animates", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
        });
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const read = await cardOnScreen(page, fake);
        await read();

        const durations = () => page.evaluate(() => {
            const w = document.getElementById("ml-sb-card").shadowRoot.getElementById("ml-sb-card-wrap");
            const cs = getComputedStyle(w);
            // The longest transition-duration that is actually in effect. `transition: none` collapses the
            // whole list, so this reads 0 exactly when nothing will animate.
            const secs = cs.transitionDuration.split(",").map((s) => parseFloat(s) || 0);
            return { max: Math.max(0, ...secs), anim: w.classList.contains("no-anim") };
        });

        // At rest, the spring is armed — that is what makes a state change legible.
        const atRest = await durations();
        expect(atRest.max, "the card animates when it is not being dragged").toBeGreaterThan(0.1);
        expect(atRest.anim).toBe(false);

        // MID-DRAG: hold the button down and read the computed style with the pointer still down.
        const h = await page.evaluate(() => {
            const el = document.getElementById("ml-sb-card").shadowRoot.getElementById("ml-sb-card-resize-x");
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        await page.mouse.move(h.x, h.y);
        await page.mouse.down();
        await page.mouse.move(h.x - 60, h.y, { steps: 4 });
        const mid = await durations();
        expect(mid.anim, "the drag flags itself").toBe(true);
        expect(mid.max, "…and NOTHING animates while the pointer is down").toBe(0);
        await page.mouse.up();

        // …and the spring comes straight back, so the reset below is animated.
        await page.waitForTimeout(120);
        expect((await durations()).max, "the spring returns on release").toBeGreaterThan(0.1);
    } finally {
        await ext.context.close();
        await site.stop();
        await fake.stop();
    }
});
