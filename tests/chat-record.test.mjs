// A chat that comes out of the archive can be resumed (src/session/chat-record.ts): its `ml_session_<hash>` record is
// written back from the history the archive holds, and a record that already exists is never overwritten.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { migrate, prepareSession, readArchived, wasmDb, writeSession } from "../src/archive/db.ts";
import { chatRecordKey, restoreChatRecord } from "../src/session/chat-record.ts";

const sqlite3 = await init();
const stored = (hash, text) => ({ hash, messages: [{ role: "user", content: text }, { role: "assistant", content: "hi" }], model: "m", extend: null, numCtx: null, numGpu: null, think: null, schema: null, toolIds: null, maxTokens: null, save: true });
const mapStore = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, structuredClone(v)); } }; };

/** A chat as the archive holds it today: the session's history is `{ kind: "chat", session }`, no ml_session_ column. */
async function archivedChat(hash) {
    const raw = new sqlite3.oo1.DB(":memory:");
    const db = wasmDb(raw);
    migrate(db);
    const summary = { id: { runtime: "local", hash }, kind: "chat", status: "done", createdTs: 1, lastTs: 2, pendingApprovals: 0, saved: true };
    writeSession(db, await prepareSession({ summary, events: [{ kind: "chat", id: hash, ts: 1, save: true }], history: { kind: "chat", session: stored(hash, "from the archive") }, bytes: 10 }), 3);
    return readArchived(db, hash);
}

// --- un-archiving a chat ---

test("UPGRADE: a chat archived before this existed is resumable once un-archived (GET_SESSION reads the key)", async () => {
    const back = await archivedChat("c0000001");
    const store = mapStore();
    assert.equal(await restoreChatRecord("c0000001", back.history, store), true);
    // what GET_SESSION and the worker's `load` read
    assert.deepEqual(store.m.get(chatRecordKey("c0000001")), stored("c0000001", "from the archive"));
});

test("an existing record is left alone: the live one is the newer", async () => {
    const back = await archivedChat("c0000002");
    const live = stored("c0000002", "newer, live");
    const store = mapStore({ ml_session_c0000002: live });
    assert.equal(await restoreChatRecord("c0000002", back.history, store), false);
    assert.deepEqual(store.m.get("ml_session_c0000002"), live);
});

test("a run's history, no history and a malformed chat history write nothing", async () => {
    const store = mapStore();
    assert.equal(await restoreChatRecord("a", { kind: "agent", messages: [] }, store), false);
    assert.equal(await restoreChatRecord("a", null, store), false);
    assert.equal(await restoreChatRecord("a", { kind: "chat", session: {} }, store), false);
    assert.equal(store.m.size, 0);
});

test("the record is written under the session's own hash, whatever the history says", async () => {
    const store = mapStore();
    await restoreChatRecord("real", { kind: "chat", session: stored("other", "x") }, store);
    assert.equal(store.m.get("ml_session_real").hash, "real");
});
