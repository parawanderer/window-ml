// The background's session index as the chat page reaches it: the `ml-sessions` port (extension pages only), what feeds
// the index (a background run's own events, a page's forwarded ones bound to its tab), and what a closed or reloaded
// tab does to the sessions it hosted. Against the built bundle, like background.test.js.
const { test } = require("node:test");
const assert = require("node:assert");
const { jsonResponse, loadBackground } = require("./helpers");

const PAGE = { url: "chrome-extension://test/chat.html" };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "" };
// The debug relays are fire-and-forget: they never call sendResponse, so their `bg.send` promise never settles. Never
// await one, and give every test a timeout so a mistake fails instead of hanging the runner.
const T = { timeout: 10000 };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const tab = (id, url = `https://site${id}.example/`) => ({ tab: { id, url, title: `Site ${id}` }, url });
const ev = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
const start = (hash) => ev(hash, "agent", { task: "look it up", model: "m", maxSteps: 5, config: null });

/** An extension page's connection, subscribed to the index. */
function openPage(bg) {
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    const rows = () => {
        const map = new Map();
        for (const m of port.messages) {
            if (m.type !== "index") continue;
            const u = m.update;
            if (u.type === "snapshot") { map.clear(); for (const s of u.sessions) map.set(s.id.hash, s); }
            else if (u.type === "upsert") map.set(u.session.id.hash, u.session);
            else if (u.type === "remove") map.delete(u.id.hash);
        }
        return map;
    };
    return { port, rows };
}

test("only an extension page may open the sessions port; a content script is refused and hears nothing", T, async () => {
    const bg = loadBackground({ config });
    const page = bg.connect("ml-sessions", { url: "https://evil.example/", tab: { id: 3 } });
    page.send({ type: "sessions" });
    assert.equal(page.wasDisconnected(), true);
    assert.deepEqual(page.messages, []);
    const noSender = bg.connect("ml-sessions");
    assert.equal(noSender.wasDisconnected(), true);

    const ok = bg.connect("ml-sessions", PAGE);
    assert.equal(ok.wasDisconnected(), false);
    const [hello] = ok.messages;
    assert.equal(hello.type, "runtime");
    assert.equal(hello.runtime.id, "local");
    assert.deepEqual(hello.runtime.grants.map((g) => g.scope), ["view", "drive", "approve", "screen"]);
});

test("a page's forwarded events land in the index under its own tab, and another tab cannot write into them", T, async () => {
    const bg = loadBackground({ config });
    const { port, rows } = openPage(bg);
    void bg.send({ type: "ML_SESSION_EVENT", event: start("aaaa0001") }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("cccc0003", "chat", { request: { model: "m", messages: [{ role: "user", content: "hi" }] }, config: {} }) }, tab(7));
    const row = rows().get("aaaa0001");
    assert.equal(row.status, "running");
    assert.deepEqual(row.page, { url: "https://site7.example/", title: "Site 7", tabId: 7 }, "the page is the browser's report of the tab, not the event's claim");
    assert.equal(rows().get("cccc0003").task, "hi", "the DevTools forward feeds the index too");

    port.send({ type: "events", sub: 1, hash: "aaaa0001" });
    void bg.send({ type: "ML_SESSION_EVENT", event: ev("aaaa0001", "agent-result", { summary: "forged", steps: 1, hitCap: false }) }, tab(8));
    void bg.send({ type: "ML_SESSION_EVENT", event: ev("aaaa0001", "agent-result", { summary: "real", steps: 1, hitCap: false }) }, tab(7));
    const results = port.messages.filter((m) => m.type === "stream" && m.message.type === "event" && m.message.event.kind === "agent-result");
    assert.deepEqual(results.map((m) => m.message.event.summary), ["real"]);
    assert.equal(rows().get("aaaa0001").status, "done");
    // An event with no tab behind it (not from a content script) is ignored.
    void bg.send({ type: "ML_SESSION_EVENT", event: start("dddd0004") }, { url: "https://x/" });
    assert.equal(rows().has("dddd0004"), false);
});

test("a background run's own events reach the index, and the page's copy of its start is not doubled", T, async () => {
    const bg = loadBackground({
        config,
        onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
    });
    const { port, rows } = openPage(bg);
    port.send({ type: "events", sub: 1, hash: "run00001" });
    // Off mode: the background fans the run's lifecycle itself; the page's bus (with listPageSessions) reports a start too.
    void bg.send({ type: "ML_SESSION_EVENT", event: start("run00001") }, tab(7));
    await bg.send({ type: "START_RUN", payload: {
        runId: "run00001", task: "look it up", systemPrompt: "sys", tools: [], model: "m", think: null,
        maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, tab(7));
    await flush();
    const kinds = port.messages.filter((m) => m.type === "stream" && m.message.type === "event").map((m) => m.message.event.kind);
    assert.equal(kinds.filter((k) => k === "agent").length, 1, "one start");
    assert.ok(kinds.includes("agent-step"));
    assert.equal(kinds.filter((k) => k === "agent-result").length, 1, "one result");
    assert.equal(rows().get("run00001").status, "done");
    // Now background-hosted: the tab's page closing does not interrupt it.
    bg.closeTab(7);
    assert.equal(rows().get("run00001").status, "done");
});

test("a closed tab or a new document interrupts the page-hosted runs it held", T, async () => {
    const bg = loadBackground({ config });
    const { rows } = openPage(bg);
    void bg.send({ type: "ML_SESSION_EVENT", event: start("aaaa0001") }, tab(7));
    void bg.send({ type: "ML_SESSION_EVENT", event: start("bbbb0002") }, tab(8));
    void bg.send({ type: "ML_DEBUG_RESET" }, tab(7));
    assert.equal(rows().get("aaaa0001").status, "interrupted");
    assert.equal(rows().get("bbbb0002").status, "running");
    bg.closeTab(8);
    assert.equal(rows().get("bbbb0002").status, "interrupted");
    assert.equal(rows().get("bbbb0002").page.tabId, undefined);
});

test("commands are answered, as unsupported until each one lands", T, async () => {
    const bg = loadBackground({ config });
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "cmd", id: 1, command: { type: "tabs.list", runtime: "local" } });
    port.send({ type: "cmd", id: 2, command: { type: "nonsense" } });
    await flush();
    // Replies come in completion order, not sending order.
    const results = port.messages.filter((m) => m.type === "result").sort((a, b) => a.id - b.id);
    assert.deepEqual(results.map((m) => [m.id, m.result.ok, m.result.error.code]), [[1, false, "unsupported"], [2, false, "unsupported"]]);
});
