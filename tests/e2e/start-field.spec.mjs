// start-field.spec.mjs — the dot field behind the start page (start-field.ts), in a real Chromium against the web
// build: what a press stirs and what it leaves alone, that a drag selects nothing, that the field survives the list
// sliding over it, that a phone never gets it, and every reason it stands still. How it LOOKS is a screenshot
// (`node tests/e2e/chat-shots.mjs`); the water's physics is tests/start-field.test.mjs.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const WIDE = { width: 1300, height: 820 };

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** A new page on the start page (or on `ready`), its field mounted; `init` runs before the page's own scripts. */
async function startPage({ viewport = WIDE, init, initArg, reducedMotion, ready = ".chat-start-page" } = {}) {
    const page = await browser.newPage({ viewport, ...(reducedMotion ? { reducedMotion } : {}) });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (init) await page.addInitScript(init, initArg);
    await page.goto(server.url);
    await page.locator(ready).first().waitFor();
    return { page, errors, field: page.locator(".chat-start-field") };
}
const stirring = (page) => page.evaluate(() => document.documentElement.classList.contains("start-field-stirring"));

// --- what a press stirs ---

test("the field covers the window behind everything, takes no pointer events, and is hidden from assistive tech", async () => {
    const { page, errors, field } = await startPage();
    await expect(field).toHaveCount(1);
    expect(await field.boundingBox()).toEqual({ x: 0, y: 0, ...WIDE });
    await expect(field).toHaveAttribute("aria-hidden", "true");
    expect(await field.evaluate((c) => getComputedStyle(c).pointerEvents)).toBe("none");
    await expect(field).not.toHaveAttribute("data-still");
    expect(errors).toEqual([]);
    await page.close();
});

test("hovering stirs nothing; a held press on open ground stirs until released, and a drag selects no text", async () => {
    const { page, errors } = await startPage();
    for (let i = 0; i < 10; i++) await page.mouse.move(400 + i * 30, 700);
    expect(await stirring(page), "a hover is not a press").toBe(false);
    // Across the hint line under the box: text a plain drag would select.
    const hint = await page.locator(".chat-start-hint").boundingBox();
    await page.mouse.move(hint.x - 120, hint.y + hint.height / 2);
    await page.mouse.down();
    expect(await stirring(page)).toBe(true);
    for (let i = 0; i <= 20; i++) await page.mouse.move(hint.x - 120 + i * 30, hint.y + hint.height / 2);
    await page.mouse.up();
    expect(await stirring(page), "released").toBe(false);
    expect(await page.evaluate(() => getSelection().toString())).toBe("");
    expect(errors).toEqual([]);
    await page.close();
});

test("a press on the box focuses it and stirs nothing; nor does a press on one of its pills", async () => {
    const { page } = await startPage();
    const box = page.locator(".chat-start-box textarea");
    await page.mouse.move(...await box.boundingBox().then((b) => [b.x + 40, b.y + 8]));
    await page.mouse.down();
    expect(await stirring(page)).toBe(false);
    await page.mouse.up();
    await expect(box).toBeFocused();
    const pill = await page.locator(".chat-start-row .tp-pill").first().boundingBox();
    await page.mouse.move(pill.x + 8, pill.y + pill.height / 2);
    await page.mouse.down();
    expect(await stirring(page)).toBe(false);
    await page.mouse.up();
    await page.close();
});

// --- the list over it ---

test("closing the list slides it off the field: the canvas keeps its size and is never rebuilt", async () => {
    const { page, field } = await startPage();
    const before = await field.boundingBox();
    const id = await field.evaluate((c) => (c.dataset.probe = String(Math.random())));
    await page.locator(".chat-list-btn").first().click();
    await expect(page.locator(".chat")).toHaveClass(/list-hidden/);
    expect(await field.boundingBox()).toEqual(before);
    await expect(field).toHaveAttribute("data-probe", id);
    await page.close();
});

// --- it stops when the page is left ---

/** Counts every WebGL draw on the page, from before its scripts run: whether the field is still drawing. */
const countDraws = () => {
    globalThis.__draws = 0;
    const draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (...a) { globalThis.__draws++; return draw.apply(this, a); };
};
const draws = (page) => page.evaluate(() => globalThis.__draws);

for (const [where, hash] of [["a session", "#/s/laptop%3A3f9a0c21"], ["Settings", "#/settings"]]) {
    test(`opening ${where} takes the field away and stops its drawing; the start page again draws it again`, async () => {
        const { page, errors, field } = await startPage({ init: countDraws });
        await expect.poll(() => draws(page), { message: "it draws while the start page is up" }).toBeGreaterThan(5);
        await page.evaluate((h) => { location.hash = h; }, hash);
        await expect(field).toHaveCount(0);
        const after = await draws(page);
        await page.waitForTimeout(500);
        expect(await draws(page), "no frame is drawn once it is gone").toBe(after);
        // A press there stirs nothing: its listeners went with it.
        await page.mouse.move(700, 700);
        await page.mouse.down();
        expect(await stirring(page)).toBe(false);
        await page.mouse.up();
        await page.evaluate(() => { location.hash = "#/"; });
        await expect(field).toHaveCount(1);
        await expect.poll(() => draws(page), { message: "back on the start page, it draws again" }).toBeGreaterThan(after + 5);
        expect(errors).toEqual([]);
        await page.close();
    });
}

// --- where it never runs ---

test("a phone's start page has no field at all @mobile", async () => {
    // A phone opens on the list; the compose button is the way to the start page.
    const { page } = await startPage({ viewport: { width: 390, height: 844 }, ready: ".chat-start.hbtn" });
    await page.locator(".chat-start.hbtn").first().click();
    await expect(page.locator(".chat-start-box")).toBeVisible();
    await expect(page.locator(".chat-start-field")).toHaveCount(0);
    await page.close();
});

// --- why it stands still ---

test("reduced motion: one still frame, and a press stirs nothing", async () => {
    const { page, field } = await startPage({ reducedMotion: "reduce" });
    await expect(field).toHaveAttribute("data-still", "motion");
    await page.mouse.move(300, 700);
    await page.mouse.down();
    expect(await stirring(page)).toBe(false);
    await page.mouse.up();
    await page.close();
});

test("a low battery that is not charging stills it, and plugging in starts it again", async () => {
    const { page, field } = await startPage({ init: () => {
        const on = {};
        const battery = { charging: false, level: 0.12, addEventListener: (t, f) => (on[t] ??= []).push(f), removeEventListener() {} };
        globalThis.__plugIn = () => { battery.charging = true; for (const f of on.chargingchange ?? []) f(); };
        navigator.getBattery = () => Promise.resolve(battery);
    } });
    await expect(field).toHaveAttribute("data-still", "battery");
    await page.evaluate(() => globalThis.__plugIn());
    await expect(field).not.toHaveAttribute("data-still");
    await page.close();
});

test("a battery that is low but charging, or high and unplugged, never stills it", async () => {
    for (const reading of [{ charging: true, level: 0.05 }, { charging: false, level: 0.8 }]) {
        const { page, field } = await startPage({ initArg: reading, init: (r) => {
            navigator.getBattery = () => Promise.resolve({ ...r, addEventListener() {}, removeEventListener() {} });
        } });
        // The reading is answered by the next frame; give it a few.
        await page.waitForTimeout(300);
        await expect(field, JSON.stringify(reading)).not.toHaveAttribute("data-still");
        await page.close();
    }
});

test("its own switch stills it and lets it go", async () => {
    const { page, field } = await startPage();
    await page.evaluate(() => { globalThis.__startField.still = true; });
    await expect(field).toHaveAttribute("data-still", "forced");
    await page.evaluate(() => { globalThis.__startField.still = false; });
    await expect(field).not.toHaveAttribute("data-still");
    await page.close();
});

test("with no WebGL the start page is the page it always was, with no error", async () => {
    const plain = await chromium.launch({ channel: "chromium", args: ["--disable-webgl", "--disable-3d-apis"] });
    const page = await plain.newPage({ viewport: WIDE });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.locator(".chat-start-box textarea").fill("still works");
    await expect(page.locator(".chat-start-box textarea")).toHaveValue("still works");
    expect(errors).toEqual([]);
    await plain.close();
});
