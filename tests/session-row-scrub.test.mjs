// session-row-scrub.test.mjs — a session row leaves the worker with every registered value in its text as the marker
// (src/session/session-row-scrub.ts, docs/spec/SECRET_HANDLES.md "A session row leaves the worker scrubbed"): the pure
// scrub, the session server's exits, and the worker's, through the ports a chat page, the HUD and a hub client read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rowForEgress, ROW_IDENTIFIERS } from "../src/session/session-row-scrub.ts";
import { registrySubs } from "../src/secret-registry.ts";
import { SessionIndex } from "../src/session/session-index.ts";
import { SessionServer } from "../src/session/session-server.ts";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

const VALUE = "tok-9f8e7d6c5b4a3210";
const MARK = "[REDACTED:API_TOKEN]";
const SUBS = registrySubs([{ name: "API_TOKEN", value: VALUE }]);
const holds = (v, what) => JSON.stringify(v ?? null).includes(what);
const T = { timeout: 30000 };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A row with the value in every string a row can carry, a field no build has yet (`currentPage`) included. */
function fullRow() {
    return {
        id: { runtime: "local", hash: "abcd0001" }, kind: "agent", status: "done", model: "m",
        title: `deploy with ${VALUE}`, renamed: true, task: `use ${VALUE} to log in`, createdTs: 1, lastTs: 2, pendingApprovals: 0,
        page: { url: `https://site.example/?key=${VALUE}`, title: `Token ${VALUE}`, tabId: 7 },
        currentPage: { url: `https://other.example/#${VALUE}`, title: "Other" },
        saved: true, pinned: true,
        startedBy: { id: "dev1", kind: "device", name: `phone ${VALUE}` },
        lineage: { parent: { runtime: "local", hash: "abcd0000" }, seq: 3, request: "r1" },
        match: { snippet: `«${VALUE}»` },
    };
}

// --- the scrub itself: every string but the identifiers, by value, failing closed ---

test("every text in a row, a field added later included, has the value as its marker by name; the identifiers are as they were", () => {
    const row = fullRow();
    const out = rowForEgress(row, SUBS);
    assert.ok(!holds(out, VALUE));
    assert.equal(out.task, `use ${MARK} to log in`);
    assert.equal(out.title, `deploy with ${MARK}`);
    assert.equal(out.page.url, `https://site.example/?key=${MARK}`);
    assert.equal(out.page.title, `Token ${MARK}`);
    assert.equal(out.currentPage.url, `https://other.example/#${MARK}`, "a text field no build names yet is scrubbed by default");
    assert.equal(out.startedBy.name, `phone ${MARK}`);
    assert.equal(out.match.snippet, `«${MARK}»`);
    assert.deepEqual([out.id, out.kind, out.status, out.model, out.lineage, out.startedBy.id, out.startedBy.kind, out.page.tabId, out.pinned],
        [row.id, row.kind, row.status, row.model, row.lineage, "dev1", "device", 7, true]);
    assert.ok(holds(row, VALUE), "the index's own row is not changed");
});

test("the identifiers are exactly the routing fields: a new one is a decision, never a default", () => {
    assert.deepEqual([...ROW_IDENTIFIERS].sort(), ["id.hash", "id.runtime", "kind", "lineage.parent.hash", "lineage.parent.runtime", "lineage.request", "model", "startedBy.id", "startedBy.kind", "status"]);
});

test("fails closed: with substitutions it cannot trust, every text is withheld and a page with no URL left is dropped; identifiers stay", () => {
    const out = rowForEgress(fullRow(), null);
    assert.ok(!holds(out, VALUE));
    for (const k of ["title", "task", "page", "currentPage", "match"]) assert.equal(k in out, false, k);
    assert.equal("name" in out.startedBy, false);
    assert.deepEqual([out.id.hash, out.kind, out.status, out.model, out.startedBy.id], ["abcd0001", "agent", "done", "m", "dev1"]);
});

test("an empty registry sends the row as it is, the same object", () => {
    const row = fullRow();
    assert.equal(rowForEgress(row, []), row);
});

// --- the session server: every exit crosses `row` ---

function server() {
    const index = new SessionIndex({ runtime: "local" });
    const srv = new SessionServer(index, { runtime: () => ({ id: "local", name: "This browser", kind: "browser", online: true, capabilities: {} }), command: async () => ({ ok: false }), row: (r) => rowForEgress(r, SUBS) });
    const port = { messages: [], handlers: [], onDisconnect: { addListener() {} }, onMessage: { addListener(f) { port.handlers.push(f); } }, postMessage(m) { port.messages.push(m); } };
    srv.attach(port);
    for (const h of port.handlers) h({ type: "sessions" });
    const sunk = [];
    srv.watch({ index: (u) => sunk.push(u), stream: () => {} });
    return { index, srv, port, sunk };
}
const start = (hash, task) => ({ kind: "agent", id: hash, ts: 1, save: false, session: { hash, turn: 0 }, task, model: "m", maxSteps: 5, config: null });
const source = { tabId: 3, trusted: true, page: { url: `https://site.example/?key=${VALUE}`, title: "Site" } };

test("the server sends every row scrubbed: the ingest upsert to a page and a sink, a retitle, the snapshot, and its list", () => {
    const { srv, port, sunk } = server();
    srv.ingest(start("abcd0002", `use ${VALUE}`), source);
    srv.retitle("abcd0002", `about ${VALUE}`);
    const page = port.messages.filter((m) => m.type === "index");
    assert.ok(page.some((m) => m.update.type === "upsert"), "positive control: the page heard the row");
    assert.ok(sunk.some((u) => u.type === "upsert"), "positive control: the sink heard it");
    assert.ok(!holds(page, VALUE) && holds(page, MARK));
    assert.ok(!holds(sunk, VALUE) && holds(sunk, MARK), "the hub's sink gets what a page gets");
    assert.ok(!holds(srv.shownList(), VALUE) && holds(srv.shownList(), MARK), "the hub's list and the HUD's bring-here read the same rows");
    const later = { messages: [], handlers: [], onDisconnect: { addListener() {} }, onMessage: { addListener(f) { later.handlers.push(f); } }, postMessage(m) { later.messages.push(m); } };
    srv.attach(later);
    for (const h of later.handlers) h({ type: "sessions" });
    const snap = later.messages.find((m) => m.type === "index" && m.update.type === "snapshot");
    assert.equal(snap.update.sessions.length, 1);
    assert.ok(!holds(snap, VALUE), "the snapshot a page gets when it attaches");
    assert.ok(holds(srv.index.list(), VALUE), "the index keeps the row as it is, so a later registration scrubs it too");
});

test("reshow sends every row again through the scrub as it is now, to every page and sink", () => {
    let subs = [];
    const index = new SessionIndex({ runtime: "local" });
    const srv = new SessionServer(index, { runtime: () => ({ id: "local" }), command: async () => ({ ok: false }), row: (r) => rowForEgress(r, subs) });
    const sunk = [];
    srv.watch({ index: (u) => sunk.push(u), stream: () => {} });
    srv.ingest(start("abcd0003", `use ${VALUE}`), source);
    assert.ok(holds(sunk, VALUE), "positive control: before the value is registered the row carries it");
    subs = SUBS;
    sunk.length = 0;
    srv.reshow();
    assert.ok(sunk.length && !holds(sunk, VALUE) && holds(sunk, MARK));
});

// --- in the worker: the ports a chat page, the HUD and the commands answer through ---

const config = { chatUrl: "http://llm.test/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai" };
const REG = { ml_secret_registry: [{ name: "API_TOKEN", value: VALUE }] };
const EXT = { url: "chrome-extension://test/chat.html" };
const tab = (id, url) => ({ tab: { id, url, title: `Token ${VALUE}` }, url });

/** An extension page on the sessions port, subscribed to the index. */
function openPage(bg) {
    const port = bg.connect("ml-sessions", EXT);
    port.send({ type: "sessions" });
    let id = 0;
    const cmd = async (command) => {
        const my = ++id;
        port.send({ type: "cmd", id: my, command });
        for (let i = 0; i < 200; i++) { const r = port.messages.find((m) => m.type === "result" && m.id === my); if (r) return r.result; await tick(); }
        return null;
    };
    return { port, cmd };
}

test("in the worker: the chat page's index, a sessions.list page and a search hold the marker where the task and page held the value", T, async () => {
    const bg = loadBackground({ config, local: REG });
    for (let i = 0; i < 20; i++) await tick();
    const page = openPage(bg);
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0010", `log in with ${VALUE}`) }, tab(7, `https://site.example/?key=${VALUE}`));
    for (let i = 0; i < 20; i++) await tick();
    const index = page.port.messages.filter((m) => m.type === "index");
    assert.ok(holds(index, "abcd0010"), "positive control: the row reached the page");
    assert.ok(!holds(index, VALUE) && holds(index, `log in with ${MARK}`));
    const listed = await page.cmd({ type: "sessions.list", runtime: "local" });
    assert.ok(holds(listed, "abcd0010") && !holds(listed, VALUE));
    const found = await page.cmd({ type: "sessions.search", runtime: "local", query: VALUE });
    assert.ok(!holds(found, "abcd0010"), "a query holding the value finds nothing in what the row shows, and confirms no guess");
    const byMark = await page.cmd({ type: "sessions.search", runtime: "local", query: "log in" });
    assert.ok(holds(byMark, "abcd0010") && !holds(byMark, VALUE), "a search's snippet is scrubbed too");
});

test("in the worker: a value registered after a row was sent is replaced where the page holds it", T, async () => {
    const bg = loadBackground({ config });
    for (let i = 0; i < 20; i++) await tick();
    const page = openPage(bg);
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0011", `log in with ${VALUE}`) }, tab(7, "https://site.example/"));
    for (let i = 0; i < 20; i++) await tick();
    assert.ok(holds(page.port.messages, VALUE), "positive control: not registered yet, so the row carries it");
    const before = page.port.messages.length;
    bg.setLocal(REG);
    for (let i = 0; i < 20; i++) await tick();
    const after = page.port.messages.slice(before).filter((m) => m.type === "index" && m.update.type === "upsert" && m.update.session.id.hash === "abcd0011");
    assert.ok(after.length, "the row is sent again");
    assert.equal(after.at(-1).update.session.task, `log in with ${MARK}`);
});

test("in the worker: the HUD's bring-here list names a session with the marker", T, async () => {
    const bg = loadBackground({ config, local: REG, openTabs: [{ id: 7, windowId: 1, active: true, url: "https://site.example/", title: "Site" }] });
    for (let i = 0; i < 20; i++) await tick();
    bg.context.__mlKeepSessionForTest("abcd0012");
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0012", `log in with ${VALUE}`) }, tab(9, `https://site.example/?key=${VALUE}`));
    void bg.send({ type: "ML_DEBUG_EVENT", event: { kind: "agent-result", id: "abcd0012", ts: 3, save: false, session: { hash: "abcd0012", turn: 0 }, result: "done" } }, tab(9, `https://site.example/?key=${VALUE}`));
    for (let i = 0; i < 20; i++) await tick();
    const r = await bg.send({ type: "LIST_BRINGABLE" }, { url: "chrome-extension://test/hud.html", tab: { id: 7, url: "https://site.example/" }, frameId: 1 });
    const mine = (r?.data ?? []).filter((s) => s.hash === "abcd0012");
    assert.equal(mine.length, 1, "positive control: the session is offered");
    assert.ok(!holds(mine, VALUE) && holds(mine, MARK));
});

test("upgrade: a row an older build stored with the value in its task and page is listed by a restarted worker with the marker", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const idb = new IDBFactory();
    // FIXTURE: the row as the code before this change wrote it, built and stored the way it did (no scrub at the exit).
    const first = loadBackground({ config, indexedDB: idb });
    first.context.__mlKeepSessionForTest("abcd0013");
    void first.send({ type: "ML_DEBUG_EVENT", event: start("abcd0013", `log in with ${VALUE}`) }, tab(9, `https://site.example/?key=${VALUE}`));
    for (let i = 0; i < 60; i++) await tick();
    const bg = loadBackground({ config, indexedDB: idb, local: REG });
    let rows = [];
    for (let i = 0; i < 200 && !rows.some((s) => s.id.hash === "abcd0013"); i++) {
        await tick();
        if (i % 20 === 19) {
            const page = openPage(bg);
            for (let j = 0; j < 20; j++) await tick();
            rows = page.port.messages.filter((m) => m.type === "index" && m.update.type === "snapshot").flatMap((m) => m.update.sessions);
        }
    }
    const row = rows.find((s) => s.id.hash === "abcd0013");
    assert.ok(row, "positive control: the stored row came back");
    assert.ok(!holds(row, VALUE), "the person sees no value on any device's list");
    assert.equal(row.task, `log in with ${MARK}`);
    assert.equal(row.page.url, `https://site.example/?key=${MARK}`);
});
