// prompt-pin.spec.mjs — the panel's PROMPT PIN and the fold of a LONG prompt, in the overlay sidebar (the same app the
// DevTools panel hosts). One two-turn session, run once: the first prompt is sixty lines long and its turn is long
// enough that the transcript window (transcript-window.tsx) no longer draws it by the time the second turn has ended.
// The pin has to name the message ABOVE where you are reading, including one the window holds back, and a click on it
// has to land on that message. The long prompt has to start folded, scroll inside its box when opened, keep its
// collapse button in reach, and come back to its first line, in view, when closed. prompt-pin.tsx and user-text.tsx
// say why each of those.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

test.describe.configure({ mode: "default" });

const FIRST = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the first prompt: count the rows`).join("\n");
const SECOND = "Now say which row was the last one.";
const TURN1 = 100, TURN2 = 30;

let fake, site, ext, page, frame;
test.beforeAll(async () => {
    test.setTimeout(240_000);
    fake = await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    ext = await launchExtension();
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
    page = await ext.context.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(site.url + "/");
    await waitForMl(page);
    const turn = (n, answer) => [...Array.from({ length: n }, () => ({ tool: "findByText", args: { text: "step" } })), { content: answer }];
    fake.setScript([...turn(TURN1, "Turn one is done."), ...turn(TURN2, "Turn two is done.")]);
    await page.evaluate(([a, b]) => {
        const agent = window.ml.createAgent({ maxSteps: 300 });
        void agent.run(a).then(() => agent.run(b));
    }, [FIRST, SECOND]);
    await expect.poll(() => fake.calls().length, { timeout: 180_000, message: "both turns used their whole script" }).toBe(TURN1 + TURN2 + 2);
    frame = await openRunInSidebar(page, { task: "line 1 of the first prompt" });
    await expect(frame.locator(".msg.user[data-prompt]").last()).toContainText(SECOND);
    await expect(frame.locator(".pending-note")).toHaveCount(0);
});
test.afterAll(async () => { await ext?.close(); fake?.stop?.(); site?.stop?.(); });

/** Scroll the panel's transcript so `y` px of it are above the top edge (or to the end, for `Infinity`). */
const scrollTo = (y) => frame.evaluate((top) => {
    const v = document.querySelector(".view");
    v.scrollTop = top === null ? v.scrollHeight : top;
    v.dispatchEvent(new Event("scroll"));
}, Number.isFinite(y) ? y : null);
/** Where a drawn message's box is, against the scroller's: `above`, `in` view, or `below`; null when not drawn. */
const placeOf = (key) => frame.evaluate((k) => {
    const v = document.querySelector(".view").getBoundingClientRect();
    const el = document.querySelector(`[data-prompt="${k}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.bottom <= v.top ? "above" : r.top >= v.bottom ? "below" : "in";
}, key);

// --- the pin names the message above where you are reading ---

test("at the end of the second turn, the pin names the second prompt, and the first is not drawn at all", async () => {
    await scrollTo(Infinity);
    const pin = frame.locator(".prompt-pin");
    await expect(pin).toBeVisible();
    await expect(pin).toContainText(SECOND);
    expect(await placeOf("task"), "the window holds the first prompt back").toBe(null);
});

test("scrolled up into the first turn, the pin names the first prompt, which is still not drawn", async () => {
    // Just above the second prompt: the first turn's last steps fill the view.
    const top = await frame.evaluate(() => {
        const v = document.querySelector(".view"), el = document.querySelectorAll(".msg.user[data-prompt]");
        const second = [...el].at(-1);
        return v.scrollTop + second.getBoundingClientRect().top - v.getBoundingClientRect().top - v.clientHeight - 40;
    });
    await scrollTo(top);
    await expect(frame.locator(".prompt-pin")).toContainText("line 1 of the first prompt");
    expect(await placeOf("s0") ?? await placeOf("task"), "the second prompt is below the view").not.toBe("in");
});

test("a click on the pin lands on the first prompt, draws it, marks it, and the pin goes", async () => {
    await frame.locator(".prompt-pin").click();
    await expect.poll(() => placeOf("task"), { timeout: 10_000, message: "the first prompt is drawn and in view" }).toBe("in");
    await expect(frame.locator('[data-prompt="task"]')).toHaveClass(/astep-pulse/);
    await expect(frame.locator(".prompt-pin")).toHaveCount(0);
});

test("with a prompt on screen, there is no pin", async () => {
    await scrollTo(0);
    await expect.poll(() => placeOf("task")).toBe("in");
    await expect(frame.locator(".prompt-pin")).toHaveCount(0);
});

// --- a long prompt is folded, scrolls when opened, and folds back in view ---

test("the sixty-line prompt starts folded, with a fade and the button to open it", async () => {
    const text = frame.locator('[data-prompt="task"] .utext');
    await expect(text).toHaveClass(/folded/);
    const { shown, full } = await text.evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
    expect(shown, "it shows a few lines of sixty").toBeLessThan(full / 3);
    await expect(frame.locator('[data-prompt="task"] .utext-more')).toHaveAttribute("aria-expanded", "false");
});

test("opened, it scrolls inside a bounded box and the collapse button is on screen without scrolling the panel", async () => {
    await frame.locator('[data-prompt="task"] .utext-more').click();
    const text = frame.locator('[data-prompt="task"] .utext');
    await expect(text).toHaveClass(/opened/);
    const box = await text.evaluate((el) => ({ h: el.clientHeight, full: el.scrollHeight, vh: window.innerHeight }));
    expect(box.full, "the whole text is there").toBeGreaterThan(box.h);
    expect(box.h, "the box is bounded by the view, not the text").toBeLessThanOrEqual(Math.ceil(box.vh * 0.6) + 1);
    await expect.poll(() => frame.evaluate(() => {
        const v = document.querySelector(".view").getBoundingClientRect();
        const b = document.querySelector('[data-prompt="task"] .utext-more').getBoundingClientRect();
        return b.top >= v.top && b.bottom <= v.bottom;
    }), { message: "the collapse button is in view" }).toBe(true);
    // Read to the end of it, inside its own box: the last line is reachable.
    await text.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(text).toContainText("line 60 of the first prompt");
});

test("closed again from its end, with its top scrolled away, it folds back onto its first line, in view", async () => {
    // The panel scrolled down until the collapse button is near its top: the message's own top is above the view.
    await frame.evaluate(() => {
        const v = document.querySelector(".view"), b = document.querySelector('[data-prompt="task"] .utext-more');
        v.scrollTop += b.getBoundingClientRect().top - v.getBoundingClientRect().top - 60;
    });
    expect(await frame.evaluate(() => document.querySelector('[data-prompt="task"]').getBoundingClientRect().top - document.querySelector(".view").getBoundingClientRect().top),
        "the message's top has scrolled out").toBeLessThan(0);
    await frame.locator('[data-prompt="task"] .utext-more').click();
    const text = frame.locator('[data-prompt="task"] .utext');
    await expect(text).toHaveClass(/folded/);
    expect(await text.evaluate((el) => el.scrollTop), "the fold shows the first lines, not the middle").toBe(0);
    // Bringing it back into view happens a frame after the click: let that frame pass, so it is what is measured
    // here and not something that moves the next test's scroll.
    await frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect.poll(() => frame.evaluate(() => document.querySelector('[data-prompt="task"]').getBoundingClientRect().top - document.querySelector(".view").getBoundingClientRect().top),
        { message: "the whole message is back in view, its header included" }).toBeGreaterThanOrEqual(-1);
});

test("the pin's whole bar is one control with a name, and a long prompt is clipped in it", async () => {
    // A quarter of the way down the steps, which is inside the first turn whatever the transcript's height.
    await frame.evaluate(() => { const st = document.querySelectorAll(".astep"); st[Math.floor(st.length / 4)].scrollIntoView({ block: "start" }); });
    const pin = frame.locator(".prompt-pin");
    await expect(pin).toContainText("line 1 of the first prompt");
    await expect(pin).toHaveAttribute("aria-label", /^Go back to the message: line 1 of the first prompt/);
    const lines = await pin.locator(".prompt-pin-text").evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines, "two lines of sixty").toBeLessThanOrEqual(2);
});
