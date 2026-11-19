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

test("text deeper than the scrub looks is withheld, never sent as it is; a deep subtree with no text is kept", () => {
    const row = { ...fullRow(), later: { a: { b: { c: { d: { note: `key ${VALUE}` } } } } }, counts: { a: { b: { c: { d: { n: 3 } } } } } };
    const out = rowForEgress(row, SUBS);
    assert.ok(holds(row, VALUE), "positive control: the value is in the row");
    assert.ok(!holds(out, VALUE), JSON.stringify(out.later));
    assert.equal(out.counts.a.b.c.d.n, 3);
});

test("a registered value used as a KEY is scrubbed like text: collisions numbered, __proto__ kept a key, a deep one withheld, and none with no substitutions", () => {
    const row = { ...fullRow(), usage: { [VALUE]: 1, [`x ${VALUE}`]: 2, [MARK]: 3, plain: 4 } };
    const out = rowForEgress(row, SUBS);
    assert.ok(!holds(out, VALUE), JSON.stringify(out.usage));
    // The key the scrub left alone keeps its name; the later one that scrubs to it is numbered.
    assert.deepEqual(out.usage, { [`${MARK} (2)`]: 1, [`x ${MARK}`]: 2, [MARK]: 3, plain: 4 });
    const proto = rowForEgress(JSON.parse(`{"id":{"runtime":"local","hash":"h"},"__proto__":{"${VALUE}":1}}`), SUBS);
    assert.equal(Object.getPrototypeOf(proto), Object.prototype);
    assert.ok(Object.hasOwn(proto, "__proto__") && !holds(proto, VALUE), JSON.stringify(proto));
    const deep = rowForEgress({ ...fullRow(), later: { a: { b: { c: { d: { [VALUE]: 1 } } } } } }, SUBS);
    assert.ok(!holds(deep, VALUE) && !("later" in deep), JSON.stringify(deep.later));
    // With no substitutions to trust, a key with a schema's shape is kept, any other entry withheld.
    const shut = rowForEgress(row, null);
    assert.ok(!holds(shut, VALUE));
    assert.deepEqual(shut.usage, { plain: 4 });
    assert.deepEqual(shut.id, row.id);
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

test("in the worker: side.call purpose title answers a session's stored title with the marker", T, async () => {
    const bg = loadBackground({ config: { ...config, utilityModel: "tiny" }, local: REG });
    for (let i = 0; i < 20; i++) await tick();
    const page = openPage(bg);
    void bg.send({ type: "ML_DEBUG_EVENT", event: start("abcd0013", "look it up") }, tab(7, "https://site.example/"));
    for (let i = 0; i < 20; i++) await tick();
    const session = { runtime: "local", hash: "abcd0013" };
    await page.cmd({ type: "session.rename", session, title: `Use ${VALUE}` });
    for (let i = 0; i < 20; i++) await tick();
    const r = await page.cmd({ type: "side.call", runtime: "local", purpose: "title", session, messages: [{ role: "user", content: "name this" }], maxTokens: 16 });
    assert.equal(r?.ok && r.data?.content, `Use ${MARK}`, JSON.stringify(r));
});

// --- every command whose answer carries a session's text to a hub or a phone, and what guards it ---
// sessions.list, sessions.search: CommandDeps.shownRow (the list and search row above).
// side.call purpose title, and SESSION_TITLE (extension pages): shownTitle, through forRowText (the side.call row above; e3's rows).
// storage.stats: storageReport's `largest` titles through forRowText (e3's row in tests/redteam-session-row-egress.test.mjs).
// side.call purpose summary/explain: the utility model's reply to messages the asker sent, no row text (#2007 scrubs what it is sent).
// session.rename: answers the title the asking device sent, its own words; the row it changes leaves through broadcastIndex.
// session.backfill, session.resume: events, not the row; a stored turn's text is ruling 39's turn scrub (SECRET_HANDLES.md, known limits).
// runtime.info, models.list, device.*: the runtime's own description, model names and device records, no session text.
// tabs.list: tabs, not sessions: outside this rule (a tab's title and URL are what the person's browser shows).
// chat.start, agent.start, session.send, .cancel, .continue, .delete, .pin, .model, .unarchive, approval.answer,
// page.highlight, tab.focus, file.put, file.have: ids, booleans and status only.
// tab.screenshot: an image of the tab.

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
