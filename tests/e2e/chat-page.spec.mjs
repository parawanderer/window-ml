// THE CHAT PAGE AS AN EXTENSION TAB, over the REAL local runtime: `chat.html` talking to the background's session
// index through the `ml-sessions` port (docs/spec/CHAT_PAGE.md slice 3). The web spec beside this one drives the same
// app against a fake host; this one proves the wiring that only a real browser has — the port, the worker's index,
// and a command that reaches another tab's page.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** The chat page, open in its own tab, with page errors failing the test. */
async function openChatPage(ext) {
    const page = await ext.context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
    await page.locator(".chat").waitFor();
    return { page, errors };
}

test("a page's own chat appears in the extension's chat page, and can be answered from it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "the first answer" }, { content: "the second answer" }]);

        const { page: chat, errors } = await openChatPage(ext);
        // This browser is a runtime like any other, named and reported by the worker rather than assumed by the page.
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();

        // A chat started on an ordinary page, the way a person would from the console.
        const site1 = await ext.context.newPage();
        await site1.goto(site.url + "/");
        await waitForMl(site1);
        const hash = await site1.evaluate(async () => {
            const c = window.ml.createChat({});
            await c.chat("what is a service worker?");
            return c.hash;
        });

        const row = chat.locator(`.chat-row[data-session="local:${hash}"]`);
        await expect(row).toBeVisible();
        await row.click();
        await expect(chat.locator(".chat-main")).toContainText("the first answer");

        // Answering from the chat page: the command crosses the worker to the page that holds the session, and the
        // transcript changes because the runtime reported the turn, not because the composer assumed it.
        await chat.locator(".composer .cinput").fill("and a shared worker?");
        await chat.locator(".composer .cinput").press("Enter");
        await expect(chat.locator(".chat-main")).toContainText("the second answer");
        await expect.poll(() => fake.calls().length).toBe(2);
        expect(fake.calls()[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("the popup opens the chat page, and opening it again focuses the one that is already there", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: "http://127.0.0.1:1/", apiKey: "", apiFormat: "openai", model: "m" });
        const url = `chrome-extension://${ext.extensionId}/chat.html`;
        const popup = await ext.context.newPage();
        await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`);

        await popup.locator("#openChat").click();
        await expect.poll(() => ext.context.pages().filter((p) => p.url() === url).length).toBe(1);

        // A second click focuses the open one: two chat pages would each hold their own port and scroll position.
        // The popup closes itself on success, so the wait is on the context rather than on that page.
        const popup2 = await ext.context.newPage();
        await popup2.goto(`chrome-extension://${ext.extensionId}/popup.html`);
        await popup2.locator("#openChat").click();
        await expect.poll(() => ext.context.pages().filter((p) => p.url().endsWith("popup.html")).length).toBe(0);
        expect(ext.context.pages().filter((p) => p.url() === url).length).toBe(1);
    } finally { await ext.context.close(); }
});

test("starting a chat from the page: the worker hosts it, with no tab behind it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "a service worker is a background script" }]);
        const { page: chat, errors } = await openChatPage(ext);

        // With nothing open the page is the start box; this browser can start both kinds, so Chat is one click.
        await chat.getByRole("radio", { name: "Chat" }).click();
        await chat.locator(".chat-start-box textarea").fill("what is a service worker?");
        await chat.locator(".chat-start-box textarea").press("Enter");

        // The page opens the session the worker answered with, and the answer arrives through the stream.
        await expect(chat).toHaveURL(/#s=local%3A/);
        await expect(chat.locator(".chat-main")).toContainText("a service worker is a background script");
        // No tab was opened for it: the chat page and the popup-less context are all there is.
        expect(ext.context.pages().filter((p) => p.url().startsWith("http")).length).toBe(0);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

/** A two-card box for the fake backend to report, so the resource panel has something to draw. */
const GiB = 1024 ** 3;
const card = (id, free) => ({ gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2", total_memory: 101972967424, physical_memory: 102641958912, free_memory: free });
const BOX = { compute: { system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12.3 * GiB }, supported_gpus: [card(0, 90 * GiB), card(1, 94 * GiB)] } };

test("panels dock to an edge, share one as tabs, resize from their edge, and zoom until Escape", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setCapacity(BOX);
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        const { page: chat, errors } = await openChatPage(ext);
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();
        const gear = chat.locator(".chat-gear-btn");
        await gear.click();
        await chat.getByRole("menuitemcheckbox", { name: /is running/ }).click();
        await gear.click();
        await chat.getByRole("menuitemcheckbox", { name: "Python bench" }).click();
        const top = chat.locator(".chat-dock.chat-dock-top"), bottom = chat.locator(".chat-dock.chat-dock-bottom");
        await expect(top.getByRole("tab", { name: "Resources" })).toBeVisible();
        // Docked panels read at the DevTools panel's base size, not the page's 15px reading size.
        const panelFs = () => top.locator(".vram").evaluate((el) => getComputedStyle(el).getPropertyValue("--fs").trim());
        expect(await panelFs()).toBe("12px");
        await expect(bottom.getByRole("tab", { name: "Python bench" })).toBeVisible();

        // The docked panels live in the reading column, so the rail keeps its whole height: its gear is never under
        // (or over) a bottom panel, which is what happened while the bench was a full-width row.
        await chat.getByRole("button", { name: "Sessions" }).first().click();
        await expect(chat.locator(".chat-rail")).toBeVisible();
        await expect.poll(async () => (await bottom.boundingBox()).x).toBeGreaterThanOrEqual((await chat.locator(".chat-rail").boundingBox()).width - 1);
        const gearBox = await chat.locator(".chat-rail .chat-gear-btn").boundingBox();
        expect(gearBox.x + gearBox.width).toBeLessThanOrEqual((await bottom.boundingBox()).x + 1);
        await chat.locator(".chat-rail").getByRole("button", { name: "Show the session list" }).click();

        // Moving the bench to the top makes the two tabs of one region, the moved one showing.
        await bottom.getByRole("button", { name: "Python bench options" }).click();
        await chat.getByRole("menuitemradio", { name: "Dock to the top" }).click();
        await expect(bottom).toHaveCount(0);
        await expect(top.getByRole("tab")).toHaveCount(2);
        await expect(top.getByRole("tab", { name: "Python bench" })).toHaveAttribute("aria-selected", "true");
        await expect(top.locator(".bench")).toBeVisible();
        await expect(top.locator(".vram")).toBeHidden();
        await top.getByRole("tab", { name: "Resources" }).click();
        await expect(top.locator(".vram")).toBeVisible();
        // A tab closes from its own ✕, which arrives with the pointer.
        const x = top.getByRole("button", { name: "Close Python bench" });
        await chat.mouse.move(0, 0);
        await expect(x).toHaveCSS("opacity", "0");
        await top.getByRole("tab", { name: "Python bench" }).hover();
        await expect(x).toHaveCSS("opacity", "1");
        await x.click();
        await expect(top.getByRole("tab")).toHaveCount(1);
        await expect(chat.locator(".bench")).toHaveCount(0);

        // The region resizes from its inner edge, and keeps the size across a reload.
        const h0 = (await top.boundingBox()).height;
        const edge = await top.locator(".dock-edge").boundingBox();
        await chat.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
        await chat.mouse.down();
        await chat.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 + 80, { steps: 4 });
        await chat.mouse.up();
        const h1 = (await top.boundingBox()).height;
        expect(Math.round(h1 - h0)).toBe(80);
        // …down to a strip: the tab bar and a sliver, much smaller than the resource panel's own floor elsewhere.
        const e2 = await top.locator(".dock-edge").boundingBox();
        await chat.mouse.move(e2.x + e2.width / 2, e2.y + e2.height / 2);
        await chat.mouse.down();
        await chat.mouse.move(e2.x + e2.width / 2, 0, { steps: 4 });
        await chat.mouse.up();
        expect(Math.round((await top.boundingBox()).height)).toBe(64);
        // In a dock the graphs give way to the region: a plot keeps no 72px height and no 44px floor there, as it
        // does in the DevTools panel. (Checked on the rule, since a chart needs a box report the fake does not reach.)
        const plotRule = await top.locator(".dock-pane").first().evaluate((pane) => {
            const p = document.createElement("div"); p.className = "rc-plot"; pane.appendChild(p);
            const cs = getComputedStyle(p); const r = { h: cs.height, min: cs.minHeight }; p.remove(); return r;
        });
        expect(plotRule.min).toBe("14px");
        expect(plotRule.h).not.toBe("72px");
        await chat.mouse.move(e2.x + e2.width / 2, 64 - 1);
        await chat.mouse.down();
        await chat.mouse.move(e2.x + e2.width / 2, 64 - 1 + (h1 - 64), { steps: 4 });
        await chat.mouse.up();
        expect(Math.round((await top.boundingBox()).height)).toBe(Math.round(h1));
        await chat.reload();
        await expect(chat.locator(".chat-dock.chat-dock-top .vram")).toBeVisible();
        expect(Math.round((await chat.locator(".chat-dock.chat-dock-top").boundingBox()).height)).toBe(Math.round(h1));

        // Maximize covers the column; Escape comes back.
        await chat.getByRole("button", { name: "Resources options" }).click();
        await chat.getByRole("menuitem", { name: "Maximize" }).click();
        await expect(chat.locator(".chat-dock.max")).toBeVisible();
        // Off the chart first: over it, the panel's own Escape takes the chart's tooltip down before anything else.
        await chat.mouse.move(2, 2);
        await chat.keyboard.press("Escape");
        await expect(chat.locator(".chat-dock.max")).toHaveCount(0);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the box's panel and the Python bench are on this page, because THIS browser is the runtime", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        const { page: chat, errors } = await openChatPage(ext);
        await expect(chat.locator(".chat-rt", { hasText: "This browser" })).toBeVisible();

        // Offered because the RUNTIME reports it can be drawn and this DEVICE holds something to draw it with.
        // Neither question is "is this local", and a phone reaching the same runtime would answer the second one no.
        // The page's tools live in the gear's menu at the bottom-left, with the settings beside them.
        const gear = chat.locator(".chat-gear-btn");
        await gear.click();
        const box = chat.getByRole("menuitemcheckbox", { name: /is running/ });
        await expect(box).toBeVisible();
        await box.click();
        // Docked across the top by default, with its header row in the dock's tab bar rather than under it.
        await expect(chat.locator(".chat-dock.chat-dock-top .vram")).toBeVisible();
        await expect(chat.locator(".chat-dock.chat-dock-top .dock-bar .vram-head")).toBeVisible();
        await gear.click();
        await chat.getByRole("menuitemcheckbox", { name: /is running/ }).click();
        await expect(chat.locator(".chat-dock")).toHaveCount(0);

        // Settings are this browser's own, offered because the runtime reports `localSettings` and this page can
        // draw them: the same settings view the DevTools panel has, in the main pane.
        await gear.click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await expect(chat.locator(".chat-settings")).toBeVisible();
        await chat.getByRole("button", { name: "Close settings" }).click();
        await expect(chat.locator(".chat-settings")).toHaveCount(0);
        // A sheet like the search page: Escape takes you back from anywhere on it.
        await gear.click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await expect(chat.locator(".chat-settings h1")).toHaveText("Settings");
        await chat.locator(".chat-settings h1").click();
        await chat.keyboard.press("Escape");
        await expect(chat.locator(".chat-settings")).toHaveCount(0);

        // The bench is not a picture of one: it runs, through this browser's own offscreen sandbox, from a page
        // that is not the panel. A drawer that opened and could not run would be worse than no drawer.
        await gear.click();
        await chat.getByRole("menuitemcheckbox", { name: "Python bench" }).click();
        await expect(chat.locator(".chat-dock.chat-dock-bottom .bench")).toBeVisible();
        // One bar: the bench's own controls are in the dock's tab bar.
        await expect(chat.locator(".chat-dock.chat-dock-bottom .dock-bar .bench-play")).toBeVisible();
        await chat.locator('.dock-bar [aria-label="Run"]').click();
        await expect(chat.locator(".bench-outbody")).toContainText("45", { timeout: 120_000 });
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the start page holds through a worker restart, and its tab list is fresh and has the sites' icons", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    // Pages with an icon: a tab's icon is what the runtime fetches and hands the picker as a data URL.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const srv = createServer((q, r) => {
        if (q.url === "/fav.png") { r.writeHead(200, { "content-type": "image/png" }); r.end(png); return; }
        r.writeHead(200, { "content-type": "text/html" }); r.end(`<title>Page ${q.url}</title><link rel="icon" href="/fav.png"><p>hi`);
    });
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const site = { url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((res) => srv.close(res)) };
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        const first = await ext.context.newPage();
        await first.goto(site.url + "/");
        const { page: chat, errors } = await openChatPage(ext);
        const box = chat.locator(".chat-start-box textarea");
        await box.fill("half a thought");

        // The browser stops an idle worker about every 30 seconds and the page reconnects. The form, and what was
        // typed, stay on screen throughout: it used to be traded for an empty page and drawn again.
        await chat.evaluate(() => {
            window.__gone = 0;
            new MutationObserver(() => { if (!document.querySelector(".chat-start-box")) window.__gone++; }).observe(document.body, { subtree: true, childList: true });
        });
        const cdp = await ext.context.newCDPSession(chat);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        await expect.poll(() => chat.evaluate(() => document.querySelector(".chat-start-wait") == null), { timeout: 10_000 }).toBe(true);
        await chat.waitForTimeout(500);
        expect(await chat.evaluate(() => window.__gone)).toBe(0);
        await expect(box).toHaveValue("half a thought");

        // A tab opened after the page is in the list the next time it opens, with the icon the runtime fetched.
        const later = await ext.context.newPage();
        await later.goto(site.url + "/?later");
        await chat.bringToFront();
        await chat.getByRole("button", { name: /^Where it runs/ }).click();
        const list = chat.getByRole("listbox", { name: "Where it runs" });
        await expect(list.locator(".tp-row", { hasText: "127.0.0.1" })).toHaveCount(2);
        await expect(list.getByRole("searchbox", { name: "Filter tabs" })).toBeVisible();
        await chat.keyboard.press("Escape");
        await chat.getByRole("button", { name: /^Where it runs/ }).click();
        await expect.poll(() => list.locator("img.tp-fav").count(), { timeout: 10_000 }).toBeGreaterThan(0);
        await chat.keyboard.press("Escape");

        // Settings has the housekeeping log, the one the DevTools panel shows.
        await chat.locator(".chat-gear-btn").click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await chat.getByRole("tab", { name: "Housekeeping" }).click();
        await expect(chat.locator(".chat-set-hk .hk-view")).toBeVisible();
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("a worker restart does not redraw Settings: Runtimes keeps its scroll and never says offline", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        const { page: chat, errors } = await openChatPage(ext);
        await chat.setViewportSize({ width: 1200, height: 520 });
        await chat.locator(".chat-gear-btn").first().click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await chat.getByRole("tab", { name: "Runtimes" }).click();
        await expect(chat.locator("section[aria-label=Storage]")).toBeVisible();
        const scroller = chat.locator(".chat-settings .chat-sheet-scroll");
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        const at = await scroller.evaluate((el) => el.scrollTop);
        expect(at).toBeGreaterThan(0);
        await chat.evaluate(() => {
            window.__saidOffline = false;
            new MutationObserver(() => { if (/Offline/.test(document.querySelector(".rt-sheet")?.textContent ?? "")) window.__saidOffline = true; })
                .observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        const cdp = await ext.context.newCDPSession(chat);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        // Back well inside the grace; the page reconnected without showing anything.
        await chat.waitForTimeout(1500);
        expect(await chat.evaluate(() => window.__saidOffline)).toBe(false);
        expect(await scroller.evaluate((el) => el.scrollTop)).toBe(at);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the page follows the extension's Theme from the start, and offers to keep following it or choose its own", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { theme: "dark" });
        const { page: chat, errors } = await openChatPage(ext);
        await chat.emulateMedia({ colorScheme: "light" });
        const theme = () => chat.evaluate(() => document.documentElement.getAttribute("data-theme"));
        // Without opening Settings: the extension's config is loaded at the page's start (it used to wait for Settings).
        await expect.poll(theme).toBe("dark");
        await chat.locator(".chat-gear-btn").first().click();
        await chat.getByRole("menuitem", { name: /Theme for this page/ }).click();
        const menu = chat.getByRole("menu", { name: "Page menu" });
        await expect(menu.getByRole("menuitemradio")).toHaveText(["Like the extension (Dark)", "System", "Light", "Dark"]);
        await menu.getByRole("menuitemradio", { name: "Light" }).click();
        expect(await theme()).toBe("light");
        // Its own choice holds when the extension's changes; following the extension tracks it.
        await configureExtension(ext.sw, { theme: "dark" });
        expect(await theme()).toBe("light");
        await menu.getByRole("menuitemradio", { name: /Like the extension/ }).click();
        expect(await theme()).toBe("dark");
        await ext.sw.evaluate(() => chrome.storage.sync.set({ theme: "light" }));
        await expect.poll(theme).toBe("light");
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); }
});

test("the attention list proposes the archive: Keep them turns it on from the click, then offers a folder", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { sessionArchive: false });
        const { page: chat, errors } = await openChatPage(ext);
        // Suggestions only: there may be no count, but the list is there to open.
        await chat.locator(".chat-list-foot .chat-att-btn").click();
        const sheet = chat.getByRole("main", { name: "Needs attention" });
        const off = sheet.locator(".chat-att-item", { hasText: "Old sessions are deleted, not kept" });
        await expect(off).toBeVisible();
        await off.getByRole("button", { name: "Keep them" }).click();
        // The setting is written, the worker follows it, and the runtime's codes move on to the next step.
        await expect.poll(() => ext.sw.evaluate(() => chrome.storage.sync.get("sessionArchive").then((c) => c.sessionArchive))).toBe(true);
        await expect(off).toHaveCount(0);
        const folder = sheet.locator(".chat-att-item", { hasText: "Keep a copy of the archive on disk" });
        await expect(folder).toBeVisible();
        await expect(folder.getByRole("button", { name: "Pick a folder" })).toBeVisible();

        // In Settings the folder sits under the switch it depends on, and only while that is on.
        await chat.locator(".chat-gear-btn").first().click();
        await chat.getByRole("menuitem", { name: "Settings" }).click();
        await chat.getByRole("tab", { name: "Extension" }).click();
        await chat.getByRole("tab", { name: "Appearance" }).click();
        const group = chat.getByRole("group", { name: "Archive folder" });
        await expect(group).toBeVisible();
        await chat.getByRole("checkbox", { name: "Archive sessions instead of deleting them" }).uncheck();
        await expect(group).toHaveCount(0);
        await expect(chat.getByText("(above)")).toHaveCount(0);
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); }
});
