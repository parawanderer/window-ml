// chat-prompt-fold.spec.mjs — a LONG prompt on the chat page, at a phone's width: folded at first, a scroll box of
// bounded height when opened (so the button that closes it is under it, not screens further down), and back on its
// first line when closed. The same component as the panel's (`UserText`, user-text.tsx); the panel's half, with the
// prompt pin, is tests/e2e/prompt-pin.spec.mjs. The web build against the fake host.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const PHONE = { width: 390, height: 844 };
const KEY = "laptop:5709bbbb";
const TASK = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of a pasted log`).join("\n");

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

// --- a long prompt on a phone ---

test("on a phone: folded, opened into a bounded scroll box with its button in view, and closed back onto its first line", async () => {
    const page = await browser.newPage({ viewport: PHONE });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.locator(".chat").waitFor();
    await page.evaluate(([k, task]) => {
        const [runtime, hash] = k.split(":"), now = Date.now();
        globalThis.__chatFake.addSession(
            { id: { runtime, hash }, kind: "agent", status: "done", pendingApprovals: 0, saved: true, createdTs: now, lastTs: now, title: "A pasted log", model: "qwen3:32b" },
            [{ id: hash, ts: now, save: true, session: { hash, turn: 0 }, kind: "agent", task, model: "qwen3:32b", maxSteps: 12 }]);
        location.hash = `#s=${encodeURIComponent(k)}`;
    }, [KEY, TASK]);
    const text = page.locator(".msg.user .utext").first();
    await expect(text).toHaveClass(/folded/);
    await page.locator(".msg.user .utext-more").first().click();
    await expect(text).toHaveClass(/opened/);
    const box = await text.evaluate((el) => ({ h: el.clientHeight, full: el.scrollHeight, vh: window.innerHeight }));
    expect(box.full, "the whole log is there, inside the box").toBeGreaterThan(box.h);
    expect(box.h, "the box is bounded by the screen, not the log").toBeLessThanOrEqual(Math.ceil(box.vh * 0.6) + 1);
    await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector(".chat-transcript").getBoundingClientRect();
        const b = document.querySelector(".msg.user .utext-more").getBoundingClientRect();
        return b.top >= v.top && b.bottom <= v.bottom;
    }), { message: "the button that closes it is on screen" }).toBe(true);
    await text.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(text).toContainText("line 80 of a pasted log");
    await page.locator(".msg.user .utext-more").first().click();
    await expect(text).toHaveClass(/folded/);
    expect(await text.evaluate((el) => el.scrollTop), "folded onto its first lines, not its middle").toBe(0);
    expect(errors).toEqual([]);
    await page.close();
});
