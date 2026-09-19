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
    assert.deepEqual(port.messages[0].runtime.capabilities, { chat: true, agent: true, tabs: true, highlight: true, screenshots: true, sideCalls: false, persistence: false, resourcePanel: true, pythonBench: false, localSettings: true, switchModel: true });
});

test("a live background run, driven from the chat page: steered while its gate is open, then approved through approval.answer", T, async () => {
    let bg, port, n = 0, secondCall = null;
    const cmd = (id, command) => port.send({ type: "cmd", id, command });
    bg = loadBackground({
        config,
        onFetch: (call) => {
            // The runtime asks the backend for its model list when a page connects (capabilities.attention): not a turn.
            if (!/chat\/completions/.test(call.url)) return jsonResponse({ data: [] });
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
        // Never OPEN a database the worker has not created: opening one at version 1 creates it EMPTY, the worker's
        // own open then runs no upgrade, and its object stores never exist. Tests passed only by winning that race.
        if (!(await idb.databases()).some((d) => d.name === "ml-saved-sessions")) { await new Promise((r) => setTimeout(r, 50)); continue; }
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

test("session.pin keeps an unsaved session, writes the pin, and a restarted worker lists it pinned", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    const bg = loadBackground({ config, indexedDB: idb });
    const page = openPage(bg);
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("eeee0001") }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("eeee0001", "agent-result", { answer: "done", steps: 1, status: "done" }) }, tab(7));
    await flush();
    assert.equal(page.rows().get("eeee0001").saved, false, "a page script's session, not kept");

    page.port.send({ type: "cmd", id: 1, command: { type: "session.pin", session: { runtime: "local", hash: "eeee0001" }, pinned: true } });
    await flush();
    assert.deepEqual(page.port.messages.find((m) => m.type === "result" && m.id === 1)?.result, { ok: true, data: {} });
    const row = page.rows().get("eeee0001");
    assert.equal(row.pinned, true);
    assert.equal(row.saved, true, "a pin on something that dies with the worker would keep nothing");

    // What a restart reads: the stored row carries the pin, and the events the session had before it was pinned.
    const stored = await storedRow(idb, "eeee0001");
    assert.equal(stored?.summary?.pinned, true);
    assert.ok(stored.count >= 2, "the ring reached the store with the pin");

    const next = loadBackground({ config, indexedDB: idb });
    const again = openPage(next);
    let restored;
    for (let i = 0; i < 30 && !restored; i++) { await flush(); restored = again.rows().get("eeee0001"); }
    assert.equal(restored?.pinned, true);
});

test("every command the contract defines reaches the handler through the port", T, async () => {
    // The port kept its own list of known commands, which went stale: slice 5's commands were built and tested in the
    // handler and answered `unsupported` from here, which is the only way the chat page reaches them.
    const { COMMAND_SCOPE } = await import("../src/session-host.ts");
    const bg = loadBackground({ config });
    const page = openPage(bg);
    const types = Object.keys(COMMAND_SCOPE);
    types.forEach((type, i) => page.port.send({ type: "cmd", id: 100 + i, command: { type } }));
    await flush(10);
    for (const [i, type] of types.entries()) {
        const reply = page.port.messages.find((m) => m.type === "result" && m.id === 100 + i);
        assert.ok(reply, `${type} was answered`);
        assert.notEqual(reply.result.error?.message, "this runtime does not know that command", type);
    }
});

test("a worker starting with sessions past their retention forgets them before listing, logs it, and keeps a pin", T, async () => {
    // `require`, not `import`: the harness hands the worker the CommonJS build's IDBKeyRange, and a key range from the
    // other build is refused by this database, which aborts the delete.
    const { IDBFactory } = require("fake-indexeddb");
    const { indexedDbBackend } = await import("../src/session-store.ts");
    const idb = new IDBFactory();
    const DAY = 24 * 60 * 60 * 1000;
    const be = indexedDbBackend(idb);
    const put = (hash, idleDays, over = {}) => {
        const lastTs = Date.now() - idleDays * DAY;
        const summary = { id: { runtime: "local", hash }, kind: "agent", status: "done", createdTs: lastTs, lastTs, pendingApprovals: 0, saved: true, ...over };
        return be.append({ hash, summary, lastTs, createdTs: lastTs, bytes: 10, count: 1 }, 0, [start(hash)]);
    };
    await put("0ld00001", 40);
    await put("0ld00002", 40, { pinned: true });
    await put("new00001", 3);

    const bg = loadBackground({ config: { ...config, sessionRetentionDays: 30 }, indexedDB: idb });
    const page = openPage(bg);
    for (let i = 0; i < 100 && !page.rows().has("new00001"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...page.rows().keys()].sort(), ["0ld00002", "new00001"], "never listed, not listed then removed");
    assert.equal(await storedRow(idb, "0ld00001", 3), null, "gone from the disk too");

    const { data } = await bg.send({ type: "DUMP_HOUSEKEEPING", payload: {} }, { url: "chrome-extension://test/sidebar/devtools.html" });
    const evicted = data.filter((e) => e.subsystem === "sessions" && e.kind === "evict");
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].key, "0ld00001");
    assert.equal(evicted[0].reason, "retention");
    assert.equal(evicted[0].detail.outcome, "deleted");
    assert.equal(evicted[0].detail.idleDays, 40);
});

test("every event of a saved session reaches the store, not only the ones that changed its row", T, async () => {
    // Keyed on the index's `summary`, which is null when the row did not change, the write dropped most of a run: seven
    // events in, two stored. A restarted worker and `session.backfill` both read the store.
    const { IDBFactory } = require("fake-indexeddb");
    const idb = new IDBFactory();
    const bg = loadBackground({ config, indexedDB: idb });
    void bg.send({ type: "ML_KEEP_SESSION", hash: "cccc0001" }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("cccc0001") }, tab(7));
    for (let i = 1; i <= 6; i++) void bg.send({ type: "ML_DEBUG_EVENT", event: ev("cccc0001", "agent-step", { step: i, seq: i, tool: "exec", result: `r${i}` }) }, tab(7));
    let row = null;
    for (let i = 0; i < 100 && !(row?.count >= 7); i++) { await new Promise((r) => setTimeout(r, 20)); row = await storedRow(idb, "cccc0001", 1); }
    assert.equal(row?.count, 7);
});

test("a kept session's live events say where they sit, and session.backfill counts the same positions", T, async () => {
    // What lets a client that got a session from the hub's short ring page back to its start: `pos` on each live event
    // is the event's index in the stored history, which is what `session.backfill` pages through.
    const { IDBFactory } = require("fake-indexeddb");
    const bg = loadBackground({ config, indexedDB: new IDBFactory() });
    const { port } = openPage(bg);
    void bg.send({ type: "ML_KEEP_SESSION", hash: "dddd0001" }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("dddd0001") }, tab(7));
    await flush();
    port.send({ type: "events", sub: 1, hash: "dddd0001" });
    await flush();
    for (let i = 1; i <= 4; i++) void bg.send({ type: "ML_DEBUG_EVENT", event: ev("dddd0001", "agent-step", { step: i, seq: i, tool: "exec", result: `r${i}` }) }, tab(7));
    // An unkept session's events carry no position: nothing stored is there to page from.
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("eeee0001") }, tab(8));
    port.send({ type: "events", sub: 2, hash: "eeee0001" });
    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("eeee0001", "agent-step", { step: 1, seq: 1, tool: "exec", result: "x" }) }, tab(8));
    let live = [];
    for (let i = 0; i < 100 && live.length < 4; i++) {
        await flush();
        live = port.messages.filter((m) => m.type === "stream" && m.sub === 1 && m.message.type === "event" && m.message.event.kind === "agent-step").map((m) => m.message);
    }
    assert.deepEqual(live.map((m) => m.pos), [1, 2, 3, 4]);
    const other = port.messages.filter((m) => m.type === "stream" && m.sub === 2 && m.message.type === "event" && m.message.event.kind === "agent-step");
    assert.equal(other.length, 1);
    assert.equal(other[0].message.pos, undefined);

    port.send({ type: "cmd", id: 9, command: { type: "session.backfill", session: { runtime: "local", hash: "dddd0001" }, before: 3, limit: 2 } });
    let page = null;
    for (let i = 0; i < 100 && !page; i++) { await flush(); page = port.messages.find((m) => m.type === "result" && m.id === 9)?.result; }
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.data.from, 1);
    assert.deepEqual(page.data.events.map((e) => e.step), [1, 2], "positions 1 and 2 are the events live said were at 1 and 2");
});

test("session.model: a running loop's next step and a worker chat's next turn go to the model switched to", T, async () => {
    let bg, port, runCalls = [], chatCalls = [];
    const cmd = (id, command) => port.send({ type: "cmd", id, command });
    const result = async (id) => {
        for (let i = 0; i < 200; i++) { const r = port.messages.find((m) => m.type === "result" && m.id === id); if (r) return r.result; await flush(); }
        return null;
    };
    bg = loadBackground({
        config,
        onFetch: (call) => {
            // The model list (what `session.model` checks against) and anything else that is not a turn.
            if (!/chat\/completions/.test(call.url)) return jsonResponse({ data: [{ id: "default-model" }, { id: "m" }, { id: "m2" }] });
            if (call.body.tools) {
                runCalls.push(call.body.model);
                if (runCalls.length === 1) return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: JSON.stringify({ selector: "#buy" }) } }] } }] });
                return jsonResponse({ choices: [{ message: { content: "bought it" } }] });
            }
            chatCalls.push(call.body.model);
            return jsonResponse({ choices: [{ message: { content: `answer ${chatCalls.length}` } }] });
        },
        onTabMessage: async (tabId, msg) => {
            // At the gate, between the first model call and the second: switch, then approve.
            if (msg?.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                cmd(1, { type: "session.model", session: { runtime: "local", hash: "run00005" }, model: "m2" });
                await result(1);
                cmd(2, { type: "approval.answer", session: { runtime: "local", hash: "run00005" }, seq: msg.event.seq, decision: "approve" });
            }
            if (msg?.type === "RUN_TOOL_IN_PAGE" && !msg.payload?.renderOnly && !msg.payload?.precheck) return { result: "clicked" };
            return undefined;
        },
    });
    port = bg.connect("ml-sessions", PAGE);
    port.send({ type: "sessions" });
    const res = await bg.send({ type: "START_RUN", payload: {
        runId: "run00005", task: "buy it", systemPrompt: "S",
        tools: [{ name: "click", requiresApproval: true, description: "", parameters: { type: "object", properties: { selector: { type: "string" } } }, capabilities: [] }],
        model: "m", think: null, maxSteps: 5, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
    } }, tab(7));
    assert.equal(res.data.summary, "bought it");
    assert.deepEqual(await result(1), { ok: true, data: { model: "m2", applies: "next-step" } });
    assert.deepEqual(runCalls, ["m", "m2"], "the call under way kept its model; the next step used the new one");

    cmd(3, { type: "chat.start", runtime: "local", text: "hello", model: "m" });
    const started = await result(3);
    const hash = started.data.session.hash;
    for (let i = 0; i < 100 && chatCalls.length < 1; i++) await flush();
    cmd(4, { type: "session.model", session: { runtime: "local", hash }, model: "m2" });
    assert.deepEqual(await result(4), { ok: true, data: { model: "m2", applies: "next-turn" } });
    const row = [...port.messages].reverse().find((m) => m.type === "index" && m.update.type === "upsert" && m.update.session.id.hash === hash);
    assert.equal(row.update.session.model, "m2", "every client hears the row change before the next turn");
    for (let i = 0; i < 50; i++) await flush();
    cmd(5, { type: "session.send", session: { runtime: "local", hash }, text: "and now?" });
    assert.equal((await result(5)).ok, true);
    for (let i = 0; i < 100 && chatCalls.length < 2; i++) await flush();
    assert.deepEqual(chatCalls, ["m", "m2"]);

    cmd(6, { type: "session.model", session: { runtime: "local", hash }, model: "not-offered" });
    assert.equal((await result(6)).error.code, "invalid");
});

test("session storage stats answer an extension page and refuse a page", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    const idb = new IDBFactory();
    const bg = loadBackground({ config, indexedDB: idb });
    void bg.send({ type: "ML_KEEP_SESSION", hash: "ffff0001" }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("ffff0001") }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("ffff0001", "agent-step", { step: 1, seq: 1, tool: "exec", result: "r".repeat(300) }) }, tab(7));
    for (let i = 0; i < 100 && !((await storedRow(idb, "ffff0001", 1))?.count >= 2); i++) await new Promise((r) => setTimeout(r, 20));

    const refused = await bg.send({ type: "SESSION_STORAGE_STATS" }, tab(7));
    assert.match(refused.error, /Refused/);
    const reply = await bg.send({ type: "SESSION_STORAGE_STATS" }, { url: "chrome-extension://test/chat.html" });
    const { data } = reply;
    assert.equal(data.sessions, 1);
    assert.equal(data.events, 2);
    assert.ok(data.toolOutput >= 300);
    assert.equal(data.top[0].hash, "ffff0001");
});

test("the store budget: 0 caps nothing, and a lowered budget applies at once", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    const { indexedDbBackend } = await import("../src/session-store.ts");
    const idb = new IDBFactory();
    const be = indexedDbBackend(idb);
    const MB = 1024 * 1024;
    // Two sessions of 200 MB each by the store's own accounting: over the default 256, under nothing.
    for (const [hash, age] of [["big00001", 2], ["big00002", 1]]) {
        const lastTs = Date.now() - age * 60_000;
        const summary = { id: { runtime: "local", hash }, kind: "agent", status: "done", createdTs: lastTs, lastTs, pendingApprovals: 0, saved: true };
        await be.append({ hash, summary, lastTs, createdTs: lastTs, bytes: 200 * MB, count: 1 }, 0, [start(hash)]);
    }
    const bg = loadBackground({ config: { ...config, sessionStoreBudgetMB: 0 }, indexedDB: idb });
    const page = openPage(bg);
    for (let i = 0; i < 100 && page.rows().size < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(page.rows().size, 2, "0 is no cap: 400 MB kept");

    // Lowered to 256 while watching: the older one goes now, not on some later write.
    bg.setSync({ sessionStoreBudgetMB: 256 });
    for (let i = 0; i < 100 && page.rows().has("big00001"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...page.rows().keys()], ["big00002"]);
    const { data } = await bg.send({ type: "DUMP_HOUSEKEEPING", payload: {} }, { url: "chrome-extension://test/sidebar/devtools.html" });
    assert.deepEqual(data.filter((e) => e.subsystem === "sessions").map((e) => [e.key, e.reason]), [["big00001", "budget"]]);
});

test("the runtime titles a session it keeps, once, never one it does not, and a rename sticks until cleared", T, async () => {
    const titleCalls = [];
    const bg = loadBackground({
        config: { ...config, utilityModel: "tiny", autoTitles: true },
        onFetch: (call) => {
            const sys = call.body?.messages?.[0]?.content ?? "";
            if (/titles for a request/.test(sys)) { titleCalls.push(call.body.messages[1].content); return jsonResponse({ choices: [{ message: { content: `"Lamp hunt ${titleCalls.length}."` } }] }); }
            return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
    });
    const page = openPage(bg);
    await flush();
    void bg.send({ type: "ML_KEEP_SESSION", hash: "abcd0001" }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0001") }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0002") }, tab(8));   // a page script's: not kept
    for (let i = 0; i < 100 && !page.rows().get("abcd0001")?.title; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(page.rows().get("abcd0001").title, "Lamp hunt 1");
    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("abcd0001", "agent-step", { step: 1, seq: 1, tool: "exec", result: "r" }) }, tab(7));
    await flush();
    assert.equal(titleCalls.length, 1, "once, not per event, and never for the session nobody kept");
    assert.match(titleCalls[0], /look it up/);

    const rename = (id, title) => { page.port.send({ type: "cmd", id, command: { type: "session.rename", session: { runtime: "local", hash: "abcd0001" }, title } }); };
    rename(1, "My lamp");
    await flush();
    assert.equal(page.rows().get("abcd0001").title, "My lamp");
    assert.equal(page.rows().get("abcd0001").renamed, true);

    rename(2, "");
    for (let i = 0; i < 100 && page.rows().get("abcd0001")?.title !== "Lamp hunt 2"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(page.rows().get("abcd0001").title, "Lamp hunt 2", "cleared: generated again");
    assert.equal(page.rows().get("abcd0001").renamed, undefined);
});

test("models.list answers what the whitelist allows, with kinds and the default marked", T, async () => {
    const bg = loadBackground({
        config: { ...config, chatUrl: "http://host/api/chat/completions", model: "qwen3:14b", modelFilter: "^qwen" },
        onFetch: (call) => {
            if (call.url === "http://host/api/models") return jsonResponse({ data: [{ id: "qwen3:14b", owned_by: "ollama" }, { id: "gpt-4o", owned_by: "openai" }, { id: "qwen2.5vl:7b", owned_by: "ollama" }] });
            if (call.url.endsWith("/api/show")) return jsonResponse({ capabilities: call.body?.model === "qwen2.5vl:7b" ? ["completion", "vision"] : ["completion", "tools"] });
            return jsonResponse({});
        },
    });
    const page = openPage(bg);
    page.port.send({ type: "cmd", id: 1, command: { type: "models.list", runtime: "local" } });
    let reply;
    for (let i = 0; i < 100 && !reply; i++) { await new Promise((r) => setTimeout(r, 10)); reply = page.port.messages.find((m) => m.type === "result" && m.id === 1); }
    assert.deepEqual(reply.result, { ok: true, data: { models: [
        { id: "qwen3:14b", kinds: ["completion", "tools"], default: true, where: "local" },
        { id: "qwen2.5vl:7b", kinds: ["completion", "vision"], where: "local" },
    ], filtered: { hidden: 1 } } }, "the cloud model the whitelist excludes never reaches the contract either; that a filter hid one does");
    assert.ok(!JSON.stringify(reply).includes("^qwen"), "the filter itself is never sent");
});

test("tabs.list says how many tabs site access withheld, and only while it is limited", T, async () => {
    // As the browser reports them: tabs on sites the extension may not read arrive with no url and no title.
    const openTabs = [
        { id: 1, windowId: 1, index: 0, active: true, url: "https://allowed.example/", title: "Allowed" },
        { id: 2, windowId: 1, index: 1, active: false },
        { id: 3, windowId: 1, index: 2, active: false },
    ];
    const ask = async (bg) => {
        const page = openPage(bg);
        page.port.send({ type: "cmd", id: 1, command: { type: "tabs.list", runtime: "local" } });
        let reply;
        for (let i = 0; i < 100 && !reply; i++) { await new Promise((r) => setTimeout(r, 10)); reply = page.port.messages.find((m) => m.type === "result" && m.id === 1); }
        return reply.result;
    };
    const limited = await ask(loadBackground({ config, openTabs, allSites: false }));
    assert.equal(limited.ok, true);
    assert.deepEqual(limited.data.tabs.map((t) => t.tabId), [1]);
    assert.equal(limited.data.withheld, 2, "the two tabs it could not read are counted, not silently dropped");
    // With every site allowed, a tab still without an address is a browser page: left out on purpose, not counted.
    const full = await ask(loadBackground({ config, openTabs, allSites: true }));
    assert.equal(full.data.withheld, undefined);
});

test("the storage history is recorded at startup, answered over the contract, and refused to a page", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    const idb = new IDBFactory();
    const bg = loadBackground({ config, indexedDB: idb });
    void bg.send({ type: "ML_KEEP_SESSION", hash: "5709a001" }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("5709a001") }, tab(7));
    void bg.send({ type: "ML_DEBUG_EVENT", event: ev("5709a001", "agent-step", { step: 1, seq: 1, tool: "exec", result: "r".repeat(500) }) }, tab(7));
    for (let i = 0; i < 100 && !((await storedRow(idb, "5709a001", 1))?.count >= 2); i++) await new Promise((r) => setTimeout(r, 20));

    // A second worker over the same disk records its first snapshot as it starts.
    const next = loadBackground({ config, indexedDB: idb });
    for (let i = 0; i < 100 && !next.localStore.ml_storage_history; i++) await new Promise((r) => setTimeout(r, 20));
    const [first] = next.localStore.ml_storage_history;
    assert.equal(first.sessions, 1);
    assert.equal(first.byTool.exec, 500);
    assert.equal(JSON.stringify(first).includes("5709a001"), false, "the history names no session");

    const page = openPage(next);
    page.port.send({ type: "cmd", id: 1, command: { type: "storage.stats", runtime: "local" } });
    let reply;
    for (let i = 0; i < 100 && !reply; i++) { await new Promise((r) => setTimeout(r, 10)); reply = page.port.messages.find((m) => m.type === "result" && m.id === 1); }
    assert.equal(reply.result.ok, true);
    assert.equal(reply.result.data.history.length, 1);
    assert.equal(reply.result.data.largest[0].hash, "5709a001");

    assert.match((await next.send({ type: "STORAGE_HISTORY" }, tab(7))).error, /Refused/);
});

test("the archive's folder state rides the runtime's description: read at startup, sent again when it changes, gone when the archive is switched off", T, async () => {
    const { IDBFactory } = require("fake-indexeddb");
    let folder = { state: "needs-grant", pending: 2, lastSync: null };
    const bg = loadBackground({
        config: { ...config, sessionArchive: true }, indexedDB: new IDBFactory(),
        onArchiveOp: (msg) => (msg.op === "folder" || msg.op === "sync" ? { ok: true, result: folder } : { ok: true, result: null }),
    });
    const port = bg.connect("ml-sessions", PAGE);
    const archive = () => port.messages.filter((m) => m.type === "runtime").at(-1)?.runtime.capabilities.archive;
    for (let i = 0; i < 100 && archive()?.folder !== "needs-grant"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(archive(), { folder: "needs-grant", pending: 2 }, "a lapsed grant, read at startup");

    // Re-granted in Settings: the resync's report reaches every page without it asking.
    folder = { state: "connected", pending: 0, lastSync: 1234 };
    await bg.send({ type: "ARCHIVE_FOLDER", payload: { action: "sync" } }, { url: "chrome-extension://test/settings.html" });
    assert.deepEqual(archive(), { folder: "connected", lastSync: 1234 });

    bg.setSync({ sessionArchive: false });
    for (let i = 0; i < 100 && archive(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(archive(), undefined);
});

test("capabilities.attention: what needs a hand on this runtime, as codes, sent again when a fix clears one", T, async () => {
    let answering = true;
    const bg = loadBackground({
        config: { ...config, utilityModel: "" },
        onFetch: () => (answering ? jsonResponse({ data: [{ id: "default-model" }] }) : Promise.reject(new TypeError("Failed to fetch"))),
    });
    const port = bg.connect("ml-sessions", PAGE);
    const attention = () => port.messages.filter((m) => m.type === "runtime").at(-1)?.runtime.capabilities.attention;
    const until = async (want) => { for (let i = 0; i < 100 && JSON.stringify(attention()) !== JSON.stringify(want); i++) await new Promise((r) => setTimeout(r, 20)); assert.deepEqual(attention(), want); };
    // With the archive off (the default) retention deletes for good, a suggestion; the harness has no Python wheels.
    const also = ["archive-off", "python-packages-missing"];
    await until(["tab-groups", "no-utility-model", ...also]);

    bg.setSync({ utilityModel: "tiny" });
    await until(["tab-groups", ...also]);
    bg.grantPermission("tabGroups");
    await until(also);
    // Turning the archive on clears the suggestion that it is off.
    bg.setSync({ sessionArchive: true });
    await until(["python-packages-missing"]);

    // The server went away and the URL was changed: asked again at once, not at the next page.
    answering = false;
    bg.setSync({ chatUrl: "http://elsewhere/api/chat/completions" });
    await until(["backend-unreachable", "python-packages-missing"]);
    bg.setSync({ model: "" });
    await until(["no-model", "backend-unreachable", "python-packages-missing"]);
});

test("HUB_RUNTIME: refused to a web page, and an unpaired browser says so to its own pages", T, async () => {
    const bg = loadBackground({ config });
    const refused = await bg.send({ type: "HUB_RUNTIME", payload: {} }, tab(3));
    assert.match(refused.error, /extension pages/);
    const { data } = await bg.send({ type: "HUB_RUNTIME", payload: {} }, PAGE);
    assert.deepEqual(data, { state: "unpaired" });
    assert.deepEqual((await bg.send({ type: "HUB_RUNTIME", payload: { action: "devices" } }, PAGE)).data, [], "no allowlist while unpaired");
    assert.equal((await bg.send({ type: "HUB_RUNTIME", payload: { action: "revoke", principal: "ab".repeat(32) } }, PAGE)).data, "unpaired");
});
