// THE CHAT PAGE AS A PLAIN WEB PAGE: dist-web/ served over http, in a browser with NO extension loaded, against the
// fake host's demo world (src/chat/demo-world.ts). Run at a phone's width and a desktop's, because the layout is the
// thing that differs and the transcript is the thing that must not (docs/spec/CHAT_PAGE.md §Testing both places).
//
// The page is driven through its own UI, and the fake host is read back through `window.__chatFake`: what command
// did the approve button send, and did the transcript change because the runtime said so.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const WAITING = "laptop:3f9a0c21", CHAT = "laptop:7b21d4e8", WATCHED = "lab-box:1d2e3f40", CAPPED = "laptop:c0ffee12";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** A fresh page at a viewport, failing the test on any page error. */
async function open(viewport, hash = "") {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url + hash);
    await page.locator(".chat").waitFor();
    return { page, errors };
}
const row = (page, key) => page.locator(`.chat-row[data-session="${key}"]`);
const commands = (page) => page.evaluate(() => globalThis.__chatFake.commands);

test("it runs with no extension: no chrome global, and the bundle loaded nothing that needs one", async () => {
    const { page, errors } = await open(DESKTOP);
    expect(await page.evaluate(() => typeof globalThis.chrome?.runtime)).toBe("undefined");
    await expect(row(page, WAITING)).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("phone: the list first, a session on its own, approve through the runtime, and back", async () => {
    const { page, errors } = await open(PHONE);
    // One pane: the list, grouped by runtime, with the open approval badged.
    await expect(page.locator(".chat-main")).toHaveCount(0);
    await expect(page.locator(".chat-rt", { hasText: "Lab box" }).locator(".chat-chip")).toHaveText("view only");
    await expect(row(page, WAITING).locator(".chat-appr-badge")).toHaveText("1 approval");

    await row(page, WAITING).click();
    await expect(page.locator(".chat-list")).toHaveCount(0);
    await expect(page).toHaveURL(/#s=laptop%3A3f9a0c21$/);
    const approve = page.locator(".astep-approve .appr-btn.yes");
    await expect(approve).toBeVisible();
    // Touch-sized, at a phone's width.
    const box = await approve.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(40);

    await approve.click();
    await expect.poll(() => commands(page)).toContainEqual({ type: "approval.answer", session: { runtime: "laptop", hash: "3f9a0c21" }, seq: 2, decision: "approve" });
    // The gate closes because the runtime sent the resolved step, not because the button assumed it would.
    await expect(page.locator(".astep-approve")).toHaveCount(0);
    await expect(page.locator(".chat-waiting")).toHaveCount(0);

    // The back button returns to the list, and the list has caught up with the index.
    await page.locator(".chat-head .nav").click();
    await expect(page.locator(".chat-main")).toHaveCount(0);
    await expect(row(page, WAITING).locator(".chat-appr-badge")).toHaveCount(0);
    // No horizontal scroll anywhere at this width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
});

test("phone: a runtime this device may only watch gets no composer, and says why", async () => {
    const { page } = await open(PHONE, `#s=${encodeURIComponent(WATCHED)}`);
    await expect(page.locator(".chat-readonly")).toContainText("watch sessions on Lab box");
    await expect(page.locator(".composer")).toHaveCount(0);
    await page.close();
});

test("desktop: both panes, a message becomes a turn from the runtime, and a refused command says so", async () => {
    const { page, errors } = await open(DESKTOP);
    await expect(page.locator(".chat-list")).toBeVisible();
    await expect(page.locator(".chat-pick")).toBeVisible();
    await row(page, CHAT).click();
    await expect(page.locator(".chat-list")).toBeVisible();
    await expect(row(page, CHAT)).toHaveClass(/active/);
    await expect(page.locator(".chat-transcript .katex").first()).toBeVisible();

    await page.locator(".composer .cinput").fill("and at 128k?");
    await page.locator(".composer .cinput").press("Enter");
    await expect(page.locator(".chat-transcript")).toContainText("You said: and at 128k?");

    // The runtime refuses: the page says why, in words, rather than doing nothing.
    await page.evaluate(() => { globalThis.__chatFake.handlers["session.send"] = () => ({ ok: false, error: { code: "forbidden", message: "that grant was revoked" } }); });
    await page.locator(".composer .cinput").fill("again");
    await page.locator(".composer .cinput").press("Enter");
    await expect(page.locator(".chat-notice.error")).toContainText("Not allowed from this device: that grant was revoked");
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a runtime that lost a session's history keeps what is shown and says so; a deleted one closes", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");
    await page.evaluate((k) => globalThis.__chatFake.restart(k, false), CHAT);
    await expect(page.locator(".chat-truncated")).toBeVisible();
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");

    await page.evaluate((k) => globalThis.__chatFake.deleteSession(k), CHAT);
    await expect(page.locator(".chat-pick")).toBeVisible();
    await expect(row(page, CHAT)).toHaveCount(0);
    await expect(page.locator(".chat-notice")).toContainText("deleted");
    await page.close();
});

test("calm view is what the page opens in, and the toggle hands the panel's detail back", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    await expect(page.locator(".chat")).toHaveClass(/calm/);
    // Calm rides the shared reading attribute, so the step counters the panel draws are quiet here…
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-focus"))).toBe(true);
    await expect(page.locator(".step-pill").first()).toBeHidden();
    // …but nothing has left the document: the toggle brings all of it back, and the approval never quiets.
    await expect(page.locator(".astep-approve")).toBeVisible();
    await page.locator(".chat-head .chat-view-btn").click();
    await expect(page.locator(".chat")).not.toHaveClass(/calm/);
    await expect(page.locator(".step-pill").first()).toBeVisible();
    // The choice is this device's, so it survives a reload.
    await page.reload();
    await expect(page.locator(".chat")).not.toHaveClass(/calm/);
    await page.close();
});

test("desktop: the session list hides and comes back, and is out of the tab order while hidden", async () => {
    const { page } = await open(DESKTOP, `#s=${encodeURIComponent(CHAT)}`);
    const list = page.locator(".chat-list");
    await expect(list).toBeVisible();
    await page.locator(".chat-list .head .chat-list-btn").click();
    await expect(list).toBeHidden();
    // The way back is in the header of what is now the only pane, not only where the list used to be.
    await page.locator(".chat-head .chat-list-btn").click();
    await expect(list).toBeVisible();
    await page.close();
});

test("a reload keeps the open session", async () => {
    const { page } = await open(PHONE);
    await row(page, CHAT).click();
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");
    await page.reload();
    await expect(page.locator(".chat-transcript")).toContainText("Quantising the cache");
    // Wide display math scrolls in its own box; the page itself never scrolls sideways at a phone's width.
    await expect(page.locator(".katex-display").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".katex-display").first().evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    await page.close();
});

test("phone: starting a chat from the list, and the form says what it cannot do", async () => {
    const { page, errors } = await open(PHONE);
    // `+` is one button per kind when more than one runtime kind can start something, so it opens a menu here.
    await page.locator(".chat-start .hbtn").click();
    await page.locator(".menu-item", { hasText: "New chat" }).click();

    // One runtime can hold a chat here — the lab box has `agent` and no `chat`, the old Mac is offline — so there is
    // nothing to choose between and the form does not ask.
    await expect(page.locator('[data-field="runtime"]')).toHaveCount(0);

    await page.locator('[data-field="text"] textarea').fill("what is a shared worker?");
    await page.locator(".chat-new-foot .btn").click();

    // The page opens the session the runtime answered with, and the transcript is the runtime's, not the form's.
    await expect(page).toHaveURL(/#s=laptop%3A/);
    await expect(page.locator(".chat-main")).toContainText("You said: what is a shared worker?");
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: an agent run picks a tab, or a new one, and is started on the runtime that has tabs", async () => {
    const { page, errors } = await open(DESKTOP);
    await page.locator(".chat-start .hbtn").click();
    await page.locator(".menu-item", { hasText: "New agent run" }).click();

    // The tab picker is filled from the runtime's own `tabs.list`, so the titles are the runtime's.
    await expect(page.locator('[data-field="tab"] option').first()).toHaveText("The front page");

    // Choosing a new tab swaps the picker for a URL, because a tab that does not exist has no title to choose.
    await page.locator('[data-field="where"] select').selectOption("blank");
    await expect(page.locator('[data-field="tab"]')).toHaveCount(0);
    await expect(page.locator('[data-field="page"] input')).toBeVisible();

    await page.locator('[data-field="text"] textarea').fill("summarise the front page");
    await page.locator(".chat-new-foot .btn").click();
    await expect(page).toHaveURL(/#s=laptop%3A/);
    await expect.poll(async () => (await commands(page)).at(-1)).toMatchObject({ type: "agent.start", task: "summarise the front page", target: { kind: "blank" } });
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a run whose page has gone offers a resume instead of a composer, and picks where", async () => {
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(CAPPED)}`);

    // The capped run has no open tab, so sending to it would end at a tab that is closed. The page offers the one
    // thing that would work instead, and not both.
    await expect(page.locator(".chat-resume")).toContainText("The page this run was on is gone");
    await expect(page.locator(".composer")).toHaveCount(0);

    await page.locator(".chat-resume").click();
    // The SAME where-picker a fresh run uses, and no message box: resuming takes no turn.
    await expect(page.locator('[data-field="tab"] option').first()).toHaveText("The front page");
    await expect(page.locator('[data-field="text"]')).toHaveCount(0);
    // What it will lose is said BEFORE it happens, not reported in the transcript after.
    await expect(page.locator('[data-field="lost"]')).toContainText("approval grants");

    await page.locator('[data-field="where"] select').selectOption("blank");
    await page.locator('[data-field="page"] input').fill("https://plots.example/");
    await page.locator(".chat-new-foot .btn").click();

    await expect.poll(async () => (await commands(page)).at(-1)).toMatchObject({
        type: "session.resume",
        session: { runtime: "laptop", hash: "c0ffee12" },
        target: { kind: "blank", url: "https://plots.example/" },
    });
    // The runtime answered, so the form closes and the transcript gains the seam — and the composer is back, because
    // the run has a page again.
    await expect(page.locator(".resume-divider")).toContainText("resumed on plots.example");
    await expect(page.locator(".chat-resume")).toHaveCount(0);
    await expect(page.locator(".composer")).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
});

test("desktop: a run whose tab is still open gets its composer, not a resume", async () => {
    // The distinction is the tab, not the status: two ways to continue one run is one too many.
    const { page, errors } = await open(DESKTOP, `#s=${encodeURIComponent(WAITING)}`);
    await expect(page.locator(".composer")).toBeVisible();
    await expect(page.locator(".chat-resume")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});
