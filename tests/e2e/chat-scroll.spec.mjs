// THE CHAT PAGE'S LONG TRANSCRIPT: a reload draws the session once, settled at its end with nothing animating in, and
// scrolling up draws earlier items by itself while the text under the reader stays put. The web build against the fake
// host with `?long=<n>` (src/chat/long-session.ts); the cost of the same session is measured by chat-scroll-bench.mjs.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const PHONE = { width: 390, height: 844 }, DESKTOP = { width: 1280, height: 800 };
const WINDOW = 50;
// src/chat/long-session.ts `LONG`, spelled out: a spec does not import the page's TypeScript.
const LONG = { chat: "laptop:10a9c4a7", agent: "laptop:10a9a9e1" };

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** Open a long session. A recorder installed before the page runs notes every arrival animation and, at the first
 *  frame the transcript has content, where the scroll position was: the two things a reload must get right. */
async function openLong(viewport, key, n, { reduced = false } = {}) {
    const page = await browser.newPage({ viewport, reducedMotion: reduced ? "reduce" : "no-preference" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
        window.__arrivals = [];
        document.addEventListener("animationstart", (e) => { if (/turn-in|tool-in|streak|fold|collapse/.test(e.animationName)) window.__arrivals.push(e.animationName); }, true);
        window.__firstPaint = null;
        const tick = () => {
            const t = document.querySelector(".chat-transcript");
            if (t?.querySelector(".msg, .aturn")) { window.__firstPaint = { top: t.scrollTop, h: t.scrollHeight, view: t.clientHeight }; return; }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    await page.goto(`${server.url}?long=${n}#/s/${encodeURIComponent(key)}`);
    await page.locator(".chat-transcript .msg, .chat-transcript .aturn").first().waitFor();
    return { page, errors };
}

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    test(`${name}: reloading a long chat draws it once, already at its end, with nothing arriving`, async () => {
        const { page, errors } = await openLong(viewport, LONG.chat, 300);
        const first = await page.evaluate(() => window.__firstPaint);
        expect(first.top + first.view, "the first painted frame is already scrolled to the end").toBeGreaterThanOrEqual(first.h - 2);
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => window.__arrivals), "no turn animates in on a reload").toEqual([]);
        await expect(page.locator(".chat-transcript .aturn.fresh")).toHaveCount(0);
        expect(errors).toEqual([]);
        await page.close();
    });
}

test("a run whose last step landed moments ago is still history on a reload, and a live step still animates", async () => {
    const page = await browser.newPage({ viewport: DESKTOP });
    await page.addInitScript(() => {
        window.__arrivals = [];
        document.addEventListener("animationstart", (e) => { if (/turn-in|tool-in|streak/.test(e.animationName)) window.__arrivals.push(e.animationName); }, true);
    });
    await page.goto(`${server.url}?long=0`);
    await page.locator(".chat").waitFor();
    // 20 steps 100 ms apart, the last about half a second ago: inside the clock window of `justArrived`.
    const key = await page.evaluate(() => {
        const { longAgent } = globalThis.__longSession;
        const s = longAgent(20, Date.now(), 100);
        s.summary.id = { runtime: "laptop", hash: "feed5eed" };
        s.events = s.events.map((e) => ({ ...e, id: e.id.replace(/^[0-9a-f]+/, "feed5eed"), session: { ...e.session, hash: "feed5eed" } }));
        globalThis.__chatFake.addSession(s.summary, s.events);
        return "laptop:feed5eed";
    });
    await page.evaluate((k) => { location.hash = `#/s/${encodeURIComponent(k)}`; }, key);
    await page.locator(".chat-transcript .aturn").first().waitFor();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__arrivals), "history, however recent its stamp").toEqual([]);
    await expect(page.locator(".chat-transcript .astep.tool.fresh"), "a drawn tool call does not slide in").toHaveCount(0);
    // A step that arrives while the page is watching does animate.
    await page.evaluate((k) => globalThis.__chatFake.emit(k, {
        kind: "agent-step", id: "feed5eed-live", ts: Date.now(), save: true, session: { hash: "feed5eed", turn: 99 },
        step: 99, seq: 99, tool: "python_exec", arguments: {}, result: "ok", toolMs: 5, thought: "now",
    }), key);
    await expect.poll(() => page.evaluate(() => window.__arrivals.length)).toBeGreaterThan(0);
    await page.close();
});

test("a standalone tool call slides in, and a pair that becomes a group says so on the head", async () => {
    const page = await browser.newPage({ viewport: DESKTOP });
    await page.addInitScript(() => {
        window.__arrivals = [];
        document.addEventListener("animationstart", (e) => { if (/tool-in|streak/.test(e.animationName)) window.__arrivals.push(e.animationName); }, true);
    });
    await page.goto(`${server.url}?long=0`);
    await page.locator(".chat").waitFor();
    const key = await page.evaluate(() => {
        const { longAgent } = globalThis.__longSession;
        const s = longAgent(0, Date.now(), 100);
        s.summary.id = { runtime: "laptop", hash: "a11e5001" };
        s.events = s.events.map((e) => ({ ...e, id: e.id.replace(/^[0-9a-f]+/, "a11e5001"), session: { ...e.session, hash: "a11e5001" } }));
        globalThis.__chatFake.addSession(s.summary, s.events);
        return "laptop:a11e5001";
    });
    await page.evaluate((k) => { location.hash = `#/s/${encodeURIComponent(k)}`; }, key);
    await page.locator(".chat-transcript").waitFor();
    // One call on its own: the row slides in (and the turn may drift with it).
    await page.evaluate((k) => globalThis.__chatFake.emit(k, {
        kind: "agent-step", id: "solo-tool", ts: Date.now(), save: true, session: { hash: "a11e5001", turn: 1 },
        step: 1, seq: 1, tool: "exec", arguments: {}, result: "ok", toolMs: 5,
    }), key);
    await expect(page.locator(".astep.tool.fresh").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__arrivals.some((n) => n === "chat-tool-in"))).toBe(true);
    // A second call of a different tool is one more row, not yet a group under the ordinary rule; under "group
    // all" (the chat page's default) two calls are a group and the head is what says so.
    await page.evaluate((k) => globalThis.__chatFake.emit(k, {
        kind: "agent-step", id: "pair-tool", ts: Date.now(), save: true, session: { hash: "a11e5001", turn: 2 },
        step: 2, seq: 2, tool: "look", arguments: {}, result: "ok", toolMs: 5,
    }), key);
    await expect(page.locator(".astreak").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__arrivals.some((n) => n === "chat-streak-form" || n === "chat-streak-wash"))).toBe(true);
    await page.close();
});

test("prefers-reduced-motion: a live step appears without the arrival animation", async () => {
    const { page } = await openLong(DESKTOP, LONG.agent, 20, { reduced: true });
    await page.evaluate((k) => globalThis.__chatFake.emit(k, {
        kind: "agent-step", id: "x-live", ts: Date.now(), save: true, session: { hash: "10a9a9e1", turn: 99 },
        step: 999, seq: 999, tool: "python_exec", arguments: {}, result: "ok", toolMs: 5, thought: "now",
    }), LONG.agent);
    await expect(page.locator(".aturn", { hasText: "now" })).toBeVisible();
    expect(await page.evaluate(() => window.__arrivals)).toEqual([]);
    await page.close();
});

for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    test(`${name}: scrolling to the top draws earlier turns by itself and the text under the reader does not move`, async () => {
        const { page, errors } = await openLong(viewport, LONG.chat, 300);
        const turns = () => page.locator(".chat-transcript .msg.user").count();
        expect(await turns()).toBe(WINDOW);
        await expect(page.locator(".chat-window-edge .chat-earlier-retry"), "no button where IntersectionObserver exists").toHaveCount(0);
        await expect(page.locator(".chat-window-rest")).toHaveText(`${300 - WINDOW} earlier in this session`);
        // Go to the top and read where the first drawn turn sits, synchronously, before the observer has answered.
        const before = await page.evaluate(() => {
            const t = document.querySelector(".chat-transcript");
            // A reader's own gesture, which is what stops the page following the newest turn (a bare scrollTop does not).
            t.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
            t.scrollTop = 0;
            const a = t.querySelector(".msg.user");
            return { text: a.textContent, off: a.getBoundingClientRect().top - t.getBoundingClientRect().top };
        });
        await expect.poll(turns).toBeGreaterThan(WINDOW);
        const after = await page.evaluate((text) => {
            const t = document.querySelector(".chat-transcript");
            const a = [...t.querySelectorAll(".msg.user")].find((m) => m.textContent === text);
            return { off: a.getBoundingClientRect().top - t.getBoundingClientRect().top, top: t.scrollTop };
        }, before.text);
        expect(after.top, "the reader was moved off the top, not left at it").toBeGreaterThan(0);
        expect(Math.abs(after.off - before.off), "the same text is under the reader").toBeLessThanOrEqual(2);
        // And it keeps going to the very start, then says nothing is left.
        for (let i = 0; i < 20 && await page.locator(".chat-window-edge").count(); i++) {
            await page.evaluate(() => { document.querySelector(".chat-transcript").scrollTop = 0; });
            await page.waitForTimeout(150);
        }
        await expect(page.locator(".chat-window-edge")).toHaveCount(0);
        expect(await turns()).toBe(300);
        expect(errors).toEqual([]);
        await page.close();
    });
}
