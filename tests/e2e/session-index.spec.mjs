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
    rows.page = page;
    return rows;
}
const strip = (list) => list.map(({ hash, ...rest }) => rest);
/** Whether the row for `task` says it is saved. Read separately, so the shared reader keeps the shape the other
 *  tests compare whole. */
const savedOf = (page, task) => page.evaluate((t) => [...globalThis.__rows.values()].find((s) => s.task === t)?.saved ?? null, task);

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

test("chat.start: a chat with no tab behind it runs in the worker, and answers a second message", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "the first answer" }, { content: "the second answer" }]);
        const rows = await indexReader(ext);

        const started = await rows.cmd({ type: "chat.start", runtime: "local", text: "what is a service worker?" });
        expect(started.ok, JSON.stringify(started)).toBe(true);
        const hash = started.data.session.hash;

        // It is a session of this browser like any other, and it belongs to no tab: nothing was open for it.
        await expect.poll(async () => strip(await rows())).toEqual([
            { kind: "chat", status: "done", task: "what is a service worker?", url: undefined },
        ]);

        const sent = await rows.cmd({ type: "session.send", session: { runtime: "local", hash }, text: "and a shared worker?" });
        expect(sent).toEqual({ ok: true, data: { mode: "turn" } });
        await expect.poll(() => fake.calls().length).toBe(2);
        // The second turn carries the first one's answer, so the worker is holding the conversation, not just relaying.
        const second = fake.calls()[1];
        expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(second.messages[1].content).toBe("the first answer");
    } finally { await ext.context.close(); await fake.stop(); }
});

test("agent.start: a run on a chosen tab, and one on a blank tab the browser opens", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
            agentStartPage: site.url + "/",
        });
        fake.setScript([{ content: "the first run is done" }, { content: "the second run is done" }]);
        const rows = await indexReader(ext);

        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const tabs = await rows.cmd({ type: "tabs.list", runtime: "local" });
        const tabId = tabs.data.tabs.find((t) => t.url.startsWith(site.url)).tabId;

        // On a tab that is already open: the run belongs to that page.
        const onTab = await rows.cmd({ type: "agent.start", runtime: "local", task: "read the page", target: { kind: "tab", tabId } });
        expect(onTab.ok, JSON.stringify(onTab)).toBe(true);
        await expect.poll(async () => (await rows()).find((r) => r.hash === onTab.data.session.hash)?.kind).toBe("agent");

        // On a blank tab: the browser opens one at the configured start page and the run begins there.
        const before = ext.context.pages().length;
        const onBlank = await rows.cmd({ type: "agent.start", runtime: "local", task: "look around", target: { kind: "blank" } });
        expect(onBlank.ok, JSON.stringify(onBlank)).toBe(true);
        expect(onBlank.data.session.hash).not.toBe(onTab.data.session.hash);
        expect(ext.context.pages().length).toBe(before + 1);
        await expect.poll(async () => (await rows()).find((r) => r.hash === onBlank.data.session.hash)?.kind).toBe("agent");

        // The browser's own pages cannot host a run, and the extension says so rather than starting one there.
        const refused = await rows.cmd({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: 0 } });
        expect(refused.ok).toBe(false);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("a start page that cannot be reached fails fast, says so, and leaves no tab behind", async () => {
    // A blank run opens a page nobody typed (the published one, or whatever the setting names), so its failure has
    // to name its own cause. `executeScript` throws the same way for "never loaded" and "not allowed here", and the
    // wait used to report the second for both: fifteen seconds of nothing, then a permissions answer to a network
    // problem, with a browser-error tab left open at an address the person never chose.
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
            agentStartPage: "https://127.0.0.1:9/nothing-here.html",   // discard port: nothing answers
        });
        const rows = await indexReader(ext);
        const before = ext.context.pages().length;

        const t0 = Date.now();
        const r = await rows.cmd({ type: "agent.start", runtime: "local", task: "look around", target: { kind: "blank" } });
        const took = Date.now() - t0;

        expect(r.ok).toBe(false);
        expect(r.error.message).toMatch(/could not be reached/);
        expect(r.error.message, "the browser's own reason is the actionable half").toMatch(/net::/);
        expect(r.error.message, "a load failure is not a permissions problem").not.toMatch(/site access/);
        // Fast, because a load that failed is never going to succeed: the 15s budget is for a slow page, not a dead one.
        expect(took, `took ${took}ms`).toBeLessThan(10_000);
        // And nothing is left open at an address nobody typed.
        expect(ext.context.pages().length).toBe(before);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("a run the browser's own UI starts is kept; one started from code is not", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", persistUiRuns: true });
        fake.setScript([{ content: "done from the HUD" }, { content: "done from the console" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);

        // What the SHELL posts into the page for a UI-started run, `keep` being the setting it read. Driving the HUD
        // composer itself would add the composer's own plumbing to a test about what happens after it: the shell's
        // one line (`keep: persistUiRuns`) is the only step below this that a person's click adds.
        await page.evaluate(() => window.postMessage({ __mlStartAgent: { task: "read the page", keep: true, maxSteps: 1 } }, "*"));
        await expect.poll(() => savedOf(rows.page, "read the page")).toBe(true);

        // A console call is not the UI: it lasts as long as the page unless it asks to be saved.
        await page.evaluate(() => window.ml.agent("count the links", { maxSteps: 1 }));
        await expect.poll(() => savedOf(rows.page, "count the links")).toBe(false);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});
