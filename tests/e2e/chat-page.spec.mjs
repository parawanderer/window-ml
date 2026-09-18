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
