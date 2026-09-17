import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// THE SESSION INDEX, FED BY REAL PAGES: a page's own `ml.chat` reaches the background's cross-tab index (what the chat
// page's local host reads) through the content-script shell, which only a real browser runs. The unit tests cover the
// index and the port; this covers the shell's forwarding in each mode, including that off mode stays silent (and
// its corner card stays unmounted) unless `listPageSessions` is on.

/** Open an extension page subscribed to the `ml-sessions` index; returns a reader of its current rows, and installs
 *  `globalThis.__cmd(command)` there, which resolves with the command's result. */
async function indexReader(ext) {
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await page.evaluate(() => {
        const rows = new Map();
        globalThis.__rows = rows;
        const port = chrome.runtime.connect({ name: "ml-sessions" });
        const waiting = new Map();
        let nextId = 1;
        globalThis.__cmd = (command) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); port.postMessage({ type: "cmd", id, command }); });
        port.onMessage.addListener((m) => {
            if (m.type === "result") { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
            if (m.type !== "index") return;
            const u = m.update;
            if (u.type === "snapshot") { rows.clear(); for (const s of u.sessions) rows.set(s.id.hash, s); }
            else if (u.type === "upsert") rows.set(u.session.id.hash, u.session);
            else if (u.type === "remove") rows.delete(u.id.hash);
        });
        port.postMessage({ type: "sessions" });
    });
    const rows = () => page.evaluate(() => [...globalThis.__rows.values()].map((s) => ({ hash: s.id.hash, kind: s.kind, status: s.status, task: s.task, url: s.page?.url })));
    rows.cmd = (command) => page.evaluate((c) => globalThis.__cmd(c), command);
    return rows;
}
const strip = (list) => list.map(({ hash, ...rest }) => rest);

test("overlay mode: a page's own chat is listed, with the tab's URL", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "hello back" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.chat("hello from the overlay page"));
        await expect.poll(async () => strip(await rows())).toEqual([{ kind: "chat", status: "done", task: "hello from the overlay page", url: site.url + "/" }]);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("off mode: a page's own sessions are not listed until listPageSessions is on, and the corner card never mounts for them", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "a" }, { content: "b" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.chat("not reported"));
        // Nothing arrives: give a forward that should not happen the time a real one takes, then look.
        await page.waitForTimeout(500);
        expect(await rows()).toEqual([]);

        // The site is on the page-approval list, so its agent runs page-hosted: reported only by the page's own bus.
        await configureExtension(ext.sw, { listPageSessions: true, pageApprovalDomains: [new URL(site.url).hostname] });
        await page.reload();
        await waitForMl(page);
        // An agent, not a chat: the card mounts on agent events, so this is what would put it on screen for a run the
        // background does not host.
        const res = await page.evaluate(() => window.ml.agent("reported now", { maxSteps: 2 }));
        expect(res.summary).toBe("b");
        await expect.poll(async () => strip(await rows())).toEqual([{ kind: "agent", status: "done", task: "reported now", url: site.url + "/" }]);
        await expect(page.locator("#ml-sb-card")).toHaveCount(0);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("commands through the page: a message continues a page's chat and says it started a turn; after a reload the page no longer has it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "first" }, { content: "second" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.createChat().chat("start"));
        await expect.poll(async () => (await rows()).map((r) => r.status)).toEqual(["done"]);
        const [{ hash }] = await rows();
        const session = { runtime: "local", hash };

        expect(await rows.cmd({ type: "session.send", session, text: "and then?" })).toEqual({ ok: true, data: { mode: "turn" } });
        await expect.poll(() => fake.calls().length).toBe(2);
        expect(JSON.stringify(fake.calls()[1].messages)).toContain("and then?");

        // A plain chat that was not saved does not survive a reload: the page says it does not have it.
        await page.reload();
        await waitForMl(page);
        const gone = await rows.cmd({ type: "session.send", session, text: "still there?" });
        expect(gone.ok).toBe(false);
        expect(gone.error.code).toBe("not-found");
        expect(await rows.cmd({ type: "session.continue", session })).toMatchObject({ ok: false, error: { code: "conflict" } });
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("page.highlight draws on the session's tab even with the debug panel off", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", listPageSessions: true });
        fake.setScript([{ content: "ok" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.chat("hi"));
        await expect.poll(async () => (await rows()).length).toBe(1);
        const [{ hash }] = await rows();
        expect(await rows.cmd({ type: "page.highlight", session: { runtime: "local", hash }, ref: { selector: "body" } })).toEqual({ ok: true, data: {} });
        await expect(page.locator("#ml-sb-root-hl")).toHaveCount(1);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});
