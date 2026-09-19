// THE CHAT PAGE AS AN EXTENSION TAB, over the REAL local runtime: `chat.html` talking to the background's session
// index through the `ml-sessions` port (docs/spec/CHAT_PAGE.md slice 3). The web spec beside this one drives the same
// app against a fake host; this one proves the wiring that only a real browser has — the port, the worker's index,
// and a command that reaches another tab's page.
import { test, expect } from "@playwright/test";
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

        // This browser can start both kinds, so `+` is a menu.
        await chat.locator(".chat-start .hbtn").click();
        await chat.locator(".menu-item", { hasText: "New chat" }).click();
        await chat.locator('[data-field="text"] textarea').fill("what is a service worker?");
        await chat.locator(".chat-new-foot .btn").click();

        // The page opens the session the worker answered with, and the answer arrives through the stream.
        await expect(chat).toHaveURL(/#s=local%3A/);
        await expect(chat.locator(".chat-main")).toContainText("a service worker is a background script");
        // No tab was opened for it: the chat page and the popup-less context are all there is.
        expect(ext.context.pages().filter((p) => p.url().startsWith("http")).length).toBe(0);
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
        await expect(chat.locator(".chat-pane .vram")).toBeVisible();
        await gear.click();
        await chat.getByRole("menuitemcheckbox", { name: /is running/ }).click();
        await expect(chat.locator(".chat-pane")).toHaveCount(0);

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
        await expect(chat.locator(".bench")).toBeVisible();
        await chat.locator('.bench [aria-label="Run"]').click();
        await expect(chat.locator(".bench-outbody")).toContainText("45", { timeout: 120_000 });
        expect(errors).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});
