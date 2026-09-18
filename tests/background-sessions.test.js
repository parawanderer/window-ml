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

test("an unknown command is answered unsupported", T, async () => {
    const bg = loadBackground({ config });
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "cmd", id: 2, command: { type: "nonsense" } });
    await flush();
    const [result] = port.messages.filter((m) => m.type === "result");
    assert.deepEqual([result.id, result.result.ok, result.result.error.code], [2, false, "unsupported"]);
    // `persistence: false` because this harness has no IndexedDB: the runtime reports what it can actually do rather
    // than what the code hopes for, which is the whole point of a client rendering by capability.
    // `resourcePanel`/`pythonBench` are not commands: they say this browser's box can be DRAWN and its sandbox
    // driven, which a client offers only where it also holds something to draw with (the chat page's `ChatExtras`).
    // `pythonBench: false` because this harness has no Pyodide bundle to find: it is measured, never assumed.
    assert.deepEqual(port.messages[0].runtime.capabilities, { chat: true, agent: true, tabs: true, highlight: true, screenshots: true, sideCalls: false, persistence: false, resourcePanel: true, pythonBench: false });
});

test("a live background run, driven from the chat page: steered while its gate is open, then approved through approval.answer", T, async () => {
    let bg, port, n = 0, secondCall = null;
    const cmd = (id, command) => port.send({ type: "cmd", id, command });
    bg = loadBackground({
        config,
        onFetch: (call) => {
            n++;
            if (n === 1) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: JSON.stringify({ selector: "#buy" }) } }] } }] });
            secondCall = call.body;
            return jsonResponse({ choices: [{ message: { content: "bought it" } }] });
        },
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                cmd(1, { type: "session.send", session: { runtime: "local", hash: "run00002" }, text: "use the blue button" });
                await flush();
                cmd(2, { type: "approval.answer", session: { runtime: "local", hash: "run00002" }, seq: msg.event.seq, decision: "approve" });
            }
            if (msg?.type === "RUN_TOOL_IN_PAGE" && !msg.payload?.renderOnly && !msg.payload?.precheck) return { result: "clicked" };
            return undefined;
        },
    });
    port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    port.send({ type: "events", sub: 1, hash: "run00002" });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "run00002", task: "buy it", systemPrompt: "S",
        tools: [{ name: "click", requiresApproval: true, description: "", parameters: { type: "object", properties: { selector: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, tab(7));
    await flush();
    assert.equal(res.data.summary, "bought it");
    const results = Object.fromEntries(port.messages.filter((m) => m.type === "result").map((m) => [m.id, m.result]));
    assert.deepEqual(results[1], { ok: true, data: { mode: "steer" } }, "a running loop takes the steer directly");
    assert.deepEqual(results[2], { ok: true, data: { resolved: true } });
    assert.ok(JSON.stringify(secondCall.messages).includes("use the blue button"), "the model saw the steer at the next step");
    const say = port.messages.find((m) => m.type === "stream" && m.message.event?.kind === "agent-say");
    assert.equal(say?.message.event.text, "use the blue button", "the steer shows in the transcript");
    const seen = port.messages.find((m) => m.type === "stream" && m.message.event?.kind === "agent-say-seen");
    assert.equal(seen?.message.event.sayId, say.message.event.sayId, "and is marked seen when drained");

    // Finished: a second answer finds the gate closed; delete forgets it, and the session is gone from the index.
    cmd(3, { type: "approval.answer", session: { runtime: "local", hash: "run00002" }, seq: 1, decision: "approve" });
    bg.localStore["ml_session_run00002"] = { messages: [] };
    cmd(4, { type: "session.delete", session: { runtime: "local", hash: "run00002" } });
    await flush();
    const later = Object.fromEntries(port.messages.filter((m) => m.type === "result").map((m) => [m.id, m.result]));
    assert.deepEqual(later[3], { ok: true, data: { resolved: false } });
    assert.deepEqual(later[4], { ok: true, data: {} });
    assert.equal("ml_session_run00002" in bg.localStore, false);
    assert.ok(port.messages.some((m) => m.type === "stream" && m.message.type === "gone"));
});

test("session.cancel on a background run blocked at its gate ends it cancelled", T, async () => {
    let bg, port;
    bg = loadBackground({
        config,
        onFetch: () => jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: "{}" } }] } }] }),
        onTabMessage: async (tabId, msg) => {
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) port.send({ type: "cmd", id: 1, command: { type: "session.cancel", session: { runtime: "local", hash: "run00003" } } });
            return undefined;
        },
    });
    port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "run00003", task: "x", systemPrompt: "S",
        tools: [{ name: "click", requiresApproval: true, description: "", parameters: { type: "object", properties: {} }, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, tab(7));
    await flush();
    assert.equal(res.data.cancelled, true);
    const [result] = port.messages.filter((m) => m.type === "result");
    assert.deepEqual(result.result, { ok: true, data: {} });
    const rows = port.messages.filter((m) => m.type === "index" && m.update.type === "upsert").map((m) => m.update.session.status);
    assert.equal(rows.at(-1), "cancelled");
});

// --- one home for a session's history (slice 5) ---

/** Read a saved session's row straight out of the fake IndexedDB, once the store's debounced write has landed. */
async function storedRow(idb, hash, tries = 30) {
    for (let i = 0; i < tries; i++) {
        const row = await new Promise((resolve, reject) => {
            const open = idb.open("ml-saved-sessions", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains("sessions")) { db.close(); resolve(null); return; }
                const req = db.transaction("sessions", "readonly").objectStore("sessions").get(hash);
                req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
                req.onerror = () => { db.close(); reject(req.error); };
            };
        });
        if (row) return row;
        await new Promise((r) => setTimeout(r, 50));
    }
    return null;
}

test("a page's { save: true } chat is written ONCE, to both the record resumeChat reads and the session's history", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    const bg = loadBackground({ config, indexedDB: idb });
    const page = openPage(bg);
    const session = { hash: "dddd0001", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], model: "m", save: true };

    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("dddd0001", "chat", { request: { model: "m", messages: session.messages }, config: {} }) }, tab(7));
    await flush();
    const saved = await bg.send({ type: "SAVE_SESSION", payload: { hash: "dddd0001", session } });
    await flush();

    // The page's own contract, unchanged.
    assert.deepEqual(saved, { data: true });
    assert.deepEqual(bg.localStore.ml_session_dddd0001, session);

    // A chat that persists itself is a session to KEEP, so the history has a row to live on.
    assert.equal(page.rows().get("dddd0001").saved, true);
    const row = await storedRow(idb, "dddd0001");
    assert.equal(row?.history?.kind, "chat");
    assert.deepEqual(row.history.session.messages, session.messages);
});

test("a run's history is kept for a session the store holds, and dropped for one it does not", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    const bg = loadBackground({ config, indexedDB: idb, onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }] }) });
    const port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    const run = (runId) => bg.send({ type: "START_RUN", payload: {
        runId, task: "look it up", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 5,
        autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, tab(7));

    // Kept: this browser's own UI reported the session so the worker keeps it past its life.
    void bg.send({ type: "ML_KEEP_SESSION", hash: "run00010" }, tab(7));
    await run("run00010");
    await flush();
    const row = await storedRow(idb, "run00010");
    assert.equal(row?.history?.kind, "agent");
    assert.ok(row.history.messages.length > 0, "what the model would be continued from");
    // The payload is what makes it continuable rather than merely readable: the system prompt, the tool
    // descriptors and the rebuild config, none of which can be reconstructed from the transcript.
    assert.equal(row.history.payload.task, "look it up");
    assert.equal(row.history.payload.systemPrompt, "S");
    assert.equal(row.history.payload.runId, "run00010");

    // Not kept: a one-off run stays one-off. Whether a run persists is `ephemeral`/`persistUiRuns`, and writing a
    // history must never be a second way to answer that.
    await run("run00011");
    await flush();
    assert.equal(await storedRow(idb, "run00011", 3), null);
});
