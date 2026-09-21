// native-embed.spec.mjs — THE PHONE APP'S PAGE (src/chat/native-embed.tsx) with no app: the demo page in a phone-sized
// Chromium, this test playing the app. It sends what the app would (`__wmlReceive`) and reads what the page posts
// (`__nativeOut`, where `post` puts messages when there is no ReactNativeWebView). The app's own screens are Maestro's.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "dist-native");
const CHAT = "laptop:7b21d4e8", WATCHED = "lab-box:1d2e3f40";
let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "embed-demo.html")), "no dist-native/ (node scripts/build-web.mjs)");
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** The demo page at phone size, failing the test on a page error. */
async function open() {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${server.url}embed-demo.html`);
    await expect.poll(() => types(page)).toContain("ready");
    return { page, errors };
}
/** Everything the page has posted, parsed. */
const out = (page) => page.evaluate(() => (globalThis.__nativeOut ?? []).map((x) => JSON.parse(x)));
const types = async (page) => (await out(page)).map((m) => m.type);
const last = async (page, type) => (await out(page)).filter((m) => m.type === type).at(-1);
/** Send the page a message as the app does. */
const tell = (page, msg) => page.evaluate((m) => globalThis.__wmlReceive(JSON.stringify({ v: 1, ...m })), msg);

test("the page says who it is, the connection, and the index; it draws nothing until a session is opened @mobile", async () => {
    const { page, errors } = await open();
    expect((await last(page, "account")).account).toEqual({ label: "Demo phone", hubUrl: "demo", root: false });
    const index = await last(page, "index");
    expect(index.runtimes.map((r) => r.id).sort()).toEqual(["lab-box", "laptop", "old-mac"]);
    expect(index.sessions.length).toBeGreaterThan(3);
    await expect(page.locator(".chat-transcript")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

test("opening a session draws its calm transcript alone, and posts the chrome the app draws around it @mobile", async () => {
    const { page, errors } = await open();
    await tell(page, { type: "open", key: CHAT });
    await expect(page.locator(".chat-transcript")).toContainText("How much memory does the KV cache");
    // The app draws the header, the waiting bar and the composer: the page draws none of them, nor the lede's model pill.
    await expect(page.locator(".chat-head, .composer, .chat-waiting, .chat-lede .tp-pill")).toHaveCount(0);
    await expect.poll(async () => (await last(page, "session"))?.chrome?.key).toBe(CHAT);
    const c = (await last(page, "session")).chrome;
    expect(c).toMatchObject({ title: "KV cache size at 32k", model: "qwen3:32b", runtimeName: "Work laptop", canSend: true, canSwitchModel: true });
    // A runtime this device only watches: no sending, and the reason in the page's words.
    await tell(page, { type: "open", key: WATCHED });
    await expect.poll(async () => (await last(page, "session"))?.chrome?.key).toBe(WATCHED);
    expect((await last(page, "session")).chrome).toMatchObject({ canSend: false, readOnly: expect.stringContaining("may watch sessions on Lab box") });
    await tell(page, { type: "close" });
    await expect.poll(async () => (await last(page, "session"))?.chrome).toBeNull();
    expect(errors).toEqual([]);
    await page.close();
});

test("a send is answered with its outcome, so the app's drafts can keep a message that did not get through @mobile", async () => {
    const { page, errors } = await open();
    await tell(page, { type: "open", key: CHAT });
    await tell(page, { type: "send", id: "s1", key: CHAT, text: "and at 128k?" });
    await expect.poll(async () => (await out(page)).find((m) => m.type === "sent" && m.id === "s1")).toMatchObject({ ok: true });
    await expect(page.locator(".chat-transcript")).toContainText("You said: and at 128k?");
    await page.evaluate(() => { globalThis.__chatFake.handlers["session.send"] = () => ({ ok: false, error: { code: "unavailable", message: "network down" } }); });
    await tell(page, { type: "send", id: "s2", key: CHAT, text: "again" });
    await expect.poll(async () => (await out(page)).find((m) => m.type === "sent" && m.id === "s2")).toMatchObject({ ok: false, error: "network down" });
    // The store's notice goes to the app, which shows it; the page draws no notice of its own.
    await expect.poll(async () => (await last(page, "notice"))?.text).toContain("network down");
    await expect(page.locator(".chat-notice")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
});

test("the app's theme, a model list, a chat started from the app, and a malformed message ignored @mobile", async () => {
    const { page, errors } = await open();
    await tell(page, { type: "theme", theme: { scheme: "dark", fontScale: 1, insets: { top: 0, bottom: 0, left: 0, right: 0 }, reducedMotion: false } });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await tell(page, { type: "models", runtime: "laptop" });
    await expect.poll(async () => (await last(page, "models"))?.models?.map((m) => m.id)).toContain("qwen3:32b");
    await tell(page, { type: "start", id: "st1", runtime: "laptop", kind: "chat", text: "hello from the phone" });
    await expect.poll(async () => (await out(page)).find((m) => m.type === "sent" && m.id === "st1")).toMatchObject({ ok: true, session: expect.stringMatching(/^laptop:/) });
    const before = (await out(page)).length;
    await page.evaluate(() => { globalThis.__wmlReceive("{not json"); globalThis.__wmlReceive(JSON.stringify({ v: 1, type: "send", id: 5 })); });
    expect((await out(page)).length).toBe(before);
    expect(errors).toEqual([]);
    await page.close();
});
