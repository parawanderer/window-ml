// FILES.LIST AND FILES-CHANGED, the worker's half (SESSION_CONTRACT.md, "Commands" and "Session events"): the command
// handler's checks, the worker's rebuild of the offscreen answer, the `files-changed` hint from the session server, its
// hub frame, and the upgrade: an old client that never heard of `files-changed`.
import test from "node:test";
import assert from "node:assert/strict";
import { SessionIndex } from "../src/session/session-index.ts";
import { SessionServer } from "../src/session/session-server.ts";
import { createCommandHandler } from "../src/session/session-commands.ts";
import { listSessionFiles } from "../src/sw/sw-files-list.ts";
import { decodeStreamFrame, encodeStreamFrame } from "../src/hub/runtime/session-relay.ts";
import { SessionFeed } from "../src/chat/session-feed.ts";
import { SessionFeed as OldSessionFeed } from "./fixtures/old-clients/session-feed-bc82ea11.mjs";
import { SESSION_CONTRACT_VERSION } from "../src/session/session-host.ts";

const T = { timeout: 5000 };
const HASH = "c0de0001";
const SESSION = { runtime: "local", hash: HASH };
const startEvent = (hash = HASH, extra = {}) => ({ kind: "agent", id: hash, ts: 1, save: false, session: { hash, turn: 0 }, task: "t", model: "m", maxSteps: 3, config: null, ...extra });
const PAGE = { entries: [{ name: "attached", kind: "dir", size: 0, mtimeMs: 1, hidden: false, readonly: true }], count: { attached: 1 } };

/** A handler over an index holding one session, with `listFiles` recording its calls. */
function handler(listFiles) {
    const index = new SessionIndex({ runtime: "local", spawn: "w1" });
    index.ingest(startEvent(), { tabId: 1, trusted: true });
    const calls = [];
    const run = createCommandHandler({ runtime: "local", index, ...(listFiles ? { listFiles: async (...a) => { calls.push(a); return listFiles(...a); } } : {}) });
    return { run, calls };
}

// --- files.list: the command handler ---

test("files.list answers the page the reader gave, for the session the command names, to this browser and a hub device alike", T, async () => {
    const { run, calls } = handler(async () => ({ ok: PAGE }));
    assert.deepEqual(await run({ type: "files.list", session: SESSION, path: "" }), { ok: true, data: PAGE });
    assert.deepEqual(await run({ type: "files.list", session: SESSION, path: "attached", cursor: "c:2:x", limit: 10 }, { via: "hub", scopes: ["view"] }), { ok: true, data: PAGE });
    assert.deepEqual(calls, [[HASH, "", {}], [HASH, "attached", { cursor: "c:2:x", limit: 10 }]]);
});

test("files.list refuses before asking the reader: no session, another runtime's, unknown, a mount other than files, a bad path, cursor or limit", T, async () => {
    const { run, calls } = handler(async () => ({ ok: PAGE }));
    const code = async (c) => (await run({ type: "files.list", ...c })).error?.code;
    assert.equal(await code({ path: "" }), "invalid");
    assert.equal(await code({ session: { runtime: "other", hash: HASH }, path: "" }), "not-found");
    assert.equal(await code({ session: { runtime: "local", hash: "deadbeef" }, path: "" }), "not-found");
    assert.equal(await code({ session: SESSION, path: "", mount: "history" }), "unsupported");
    assert.equal(await code({ session: SESSION, path: "", mount: "" }), "unsupported");
    for (const path of [undefined, null, 5, ["attached"]]) assert.equal(await code({ session: SESSION, path }), "invalid");
    for (const cursor of [5, null, {}]) assert.equal(await code({ session: SESSION, path: "", cursor }), "invalid");
    for (const limit of [0, 501, 1.5, "5", null]) assert.equal(await code({ session: SESSION, path: "", limit }), "invalid");
    assert.equal(calls.length, 0);
    assert.equal((await run({ type: "files.list", session: SESSION, path: "", mount: "files" })).ok, true);
});

test("files.list: the reader's refusal is the command's, a throw is unavailable, and a runtime without a reader is unsupported", T, async () => {
    assert.deepEqual((await handler(async () => ({ fail: "not-found", message: "no such directory" })).run({ type: "files.list", session: SESSION, path: "x" })).error, { code: "not-found", message: "no such directory" });
    assert.deepEqual((await handler(async () => ({ fail: "invalid", message: "not a directory" })).run({ type: "files.list", session: SESSION, path: "x" })).error, { code: "invalid", message: "not a directory" });
    assert.equal((await handler(async () => { throw new Error("offscreen gone at https://llm.internal.example"); }).run({ type: "files.list", session: SESSION, path: "" })).error.code, "unavailable");
    const r = await handler(async () => { throw new Error("offscreen gone at https://llm.internal.example"); }).run({ type: "files.list", session: SESSION, path: "" });
    assert.doesNotMatch(r.error.message, /llm\.internal/);
    assert.equal((await handler(null).run({ type: "files.list", session: SESSION, path: "" })).error.code, "unsupported");
});

// --- files.list: what the worker passes on from the offscreen document ---

test("listSessionFiles rebuilds the page: only the listed fields go on, realName and anything else dropped", T, async () => {
    const sent = [];
    const r = await listSessionFiles(HASH, "attached/h1", { limit: 5 }, { send: async (m) => { sent.push(m); return { ok: {
        entries: [{ name: "a***.txt", kind: "file", size: 3, mtimeMs: 9, hidden: true, readonly: true, realName: "a-secret.txt", key: "k1", birthtimeMs: 1 }],
        next: "c:1:a", count: { attached: 2, agent: 1, extra: 5 }, extra: "x" } }; } });
    assert.deepEqual(sent, [{ type: "FILES_LIST", session: HASH, path: "attached/h1", limit: 5 }]);
    assert.deepEqual(r, { ok: { entries: [{ name: "a***.txt", kind: "file", size: 3, mtimeMs: 9, hidden: true, readonly: true }], next: "c:1:a", count: { attached: 2, agent: 1 } } });
});

test("listSessionFiles passes a refusal on and throws on any answer not of the server's shape", T, async () => {
    const via = (answer) => listSessionFiles(HASH, "", {}, { send: async () => answer });
    assert.deepEqual(await via({ fail: "invalid", message: "not a directory" }), { fail: "invalid", message: "not a directory" });
    for (const bad of [undefined, null, {}, { ok: { entries: "x" } }, { ok: { entries: [{ name: 5 }] } }, { ok: { entries: [], next: 5 } },
        { ok: { entries: [], count: { attached: "2" } } }, { fail: "failed", message: "x" }, { fail: "invalid" }]) {
        await assert.rejects(via(bad), undefined, JSON.stringify(bad));
    }
});

// --- files-changed: a live hint from the session server, never an event ---

/** A server holding one session, a connected page subscribed to it, and a hub sink. */
function served() {
    const server = new SessionServer(new SessionIndex({ runtime: "local", spawn: "w1" }), { runtime: () => ({ id: "local" }), command: async () => ({ ok: true, data: {} }) });
    server.ingest(startEvent(), { tabId: 1, trusted: true });
    const posted = [];
    let listen;
    server.attach({ postMessage: (m) => posted.push(m), onMessage: { addListener: (fn) => { listen = fn; } }, onDisconnect: { addListener: () => {} }, disconnect: () => {} });
    listen({ type: "events", sub: 1, hash: HASH });
    const sunk = [];
    server.watch({ index: () => {}, stream: (hash, m) => sunk.push([hash, m]) });
    return { server, posted, sunk, hints: () => posted.filter((m) => m.type === "stream" && m.message.type === "files-changed").map((m) => m.message) };
}

test("filesChanged reaches the subscribed page and the hub sink once, with dirs, and is never kept in the index", T, async () => {
    const { server, sunk, hints } = served();
    server.filesChanged(HASH, ["agent", "agent"]);
    assert.deepEqual(hints(), [{ type: "files-changed", session: SESSION, dirs: ["agent"] }]);
    assert.deepEqual(sunk.filter(([, m]) => m.type === "files-changed"), [[HASH, { type: "files-changed", session: SESSION, dirs: ["agent"] }]]);
    assert.ok(!server.index.backfill(HASH).some((m) => m.type === "files-changed" || m.event?.kind === "files-changed"));
});

test("filesChanged with no dirs, or past 16, names none; a session the index does not hold hears nothing", T, async () => {
    const { server, hints } = served();
    server.filesChanged(HASH);
    server.filesChanged(HASH, Array.from({ length: 17 }, (_, i) => `agent/d${i}`));
    server.filesChanged("deadbeef", ["agent"]);
    assert.deepEqual(hints(), [{ type: "files-changed", session: SESSION }, { type: "files-changed", session: SESSION }]);
});

test("a person's turn that attached a file sends one files-changed naming the root and attached/; a turn without one sends none", T, async () => {
    const { server, hints } = served();
    server.ingest({ kind: "agent-say", id: HASH, ts: 2, save: false, session: { hash: HASH, turn: 1 }, text: "hi" }, { tabId: 1, trusted: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(hints(), []);
    server.ingest({ kind: "agent-say", id: HASH, ts: 3, save: false, session: { hash: HASH, turn: 2 }, text: "see", display: { typed: "see", context: [{ kind: "file", file: { name: "a.txt" } }, { kind: "file", file: { name: "b.txt" } }] } }, { tabId: 1, trusted: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(hints(), [{ type: "files-changed", session: SESSION, dirs: ["", "attached"] }]);
});

test("a run whose FIRST turn attaches a file sends one files-changed, to a page subscribed before it started and to the hub sink", T, async () => {
    const server = new SessionServer(new SessionIndex({ runtime: "local", spawn: "w1" }), { runtime: () => ({ id: "local" }), command: async () => ({ ok: true, data: {} }) });
    const posted = [];
    let listen;
    server.attach({ postMessage: (m) => posted.push(m), onMessage: { addListener: (fn) => { listen = fn; } }, onDisconnect: { addListener: () => {} }, disconnect: () => {} });
    listen({ type: "events", sub: 1, hash: HASH });
    const sunk = [];
    server.watch({ index: () => {}, stream: (hash, m) => sunk.push([hash, m]) });
    server.ingest(startEvent(HASH, { display: { typed: "t", context: [{ kind: "file", file: { name: "a.txt" } }] } }), { tabId: 1, trusted: true });
    await new Promise((r) => setTimeout(r, 0));
    const hint = { type: "files-changed", session: SESSION, dirs: ["", "attached"] };
    assert.deepEqual(posted.filter((m) => m.type === "stream" && m.message.type === "files-changed").map((m) => m.message), [hint]);
    assert.deepEqual(sunk.filter(([, m]) => m.type === "files-changed"), [[HASH, hint]]);
});

// --- files-changed over a hub: the sealed frame ---

test("a files-changed frame decodes with its dirs; more than 16, or a dir that is not a string, is not one", T, () => {
    const round = (m) => decodeStreamFrame(encodeStreamFrame(m));
    assert.deepEqual(round({ type: "files-changed", session: SESSION, dirs: ["", "attached"] }), { type: "files-changed", session: SESSION, dirs: ["", "attached"] });
    assert.deepEqual(round({ type: "files-changed", session: SESSION }), { type: "files-changed", session: SESSION });
    assert.equal(round({ type: "files-changed", session: SESSION, dirs: Array.from({ length: 17 }, () => "a") }), null);
    assert.equal(round({ type: "files-changed", session: SESSION, dirs: [5] }), null);
    assert.equal(round({ type: "files-changed", session: SESSION, dirs: "agent" }), null);
    assert.equal(round({ type: "files-changed" }), null);
});

test("a decoded files-changed carries nothing but type, session and dirs, whatever the frame held", T, () => {
    const frame = new TextEncoder().encode(JSON.stringify({ type: "files-changed", session: SESSION, dirs: ["agent"], names: ["secret.txt"], count: 3 }));
    assert.deepEqual(Object.keys(decodeStreamFrame(frame)).sort(), ["dirs", "session", "type"]);
});

// --- the upgrade: an old client receives files-changed ---

test("UPGRADE: an old client (SessionFeed at bc82ea11) drops files-changed and applies the events around it exactly as without it", T, () => {
    const ev = (cursor) => ({ type: "event", v: SESSION_CONTRACT_VERSION, session: SESSION, epoch: "w1.0", cursor, event: startEvent() });
    const hint = { type: "files-changed", session: SESSION, dirs: ["agent"] };
    const run = (Feed, msgs) => { const f = new Feed(SESSION); return msgs.map((m) => f.handle(m)); };
    const withHint = run(OldSessionFeed, [ev(1), hint, ev(2)]);
    assert.equal(withHint[1].type, "drop");
    assert.deepEqual([withHint[0], withHint[2]], run(OldSessionFeed, [ev(1), ev(2)]));
    // The shipped feed knows the hint, and the events around it are applied the same.
    const now = run(SessionFeed, [ev(1), hint, ev(2)]);
    assert.notEqual(now[1].type, "drop");
    assert.deepEqual([now[0], now[2]], run(SessionFeed, [ev(1), ev(2)]));
});
