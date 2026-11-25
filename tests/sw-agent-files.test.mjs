// sw-agent-files.test.mjs — the service worker's side of a session's run-made files (src/sw/sw-agent-files.ts):
// `forgetAgentFiles`, which deletes them with their session, and `session.files`, the state inspector's view of them.
// On fake-indexeddb as the worker's `indexedDB`, written through the same database name the offscreen document uses.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
globalThis.indexedDB = new IDBFactory();
const { AgentFiles } = await import("../src/session/agent-files.ts");
const { forgetAgentFiles } = await import("../src/sw/sw-agent-files.ts");
const { readState } = await import("../src/state-registry.ts");

// The offscreen document's handle: its own instance, the same database.
const writer = new AgentFiles();
const T = { timeout: 10000 };

// --- deleted with the session, and only that session ---

test("forgetAgentFiles deletes the session's files and discard notes, and leaves another session's", T, async () => {
    await writer.commit("gone", [{ op: "mkdir", path: "d" }, { op: "put", path: "d/a.txt", data: new Blob(["a"]) }]);
    await writer.noteLost({ session: "gone", path: "agent/b.txt", at: 1, reason: "channel-ended" });
    await writer.commit("kept", [{ op: "put", path: "k.txt", data: new Blob(["k"]) }]);
    await forgetAgentFiles("gone");
    assert.deepEqual(await writer.all("gone"), []);
    assert.deepEqual(await writer.lost("gone"), []);
    assert.deepEqual((await writer.all("kept")).map((n) => n.path), ["k.txt"]);
    // A session with nothing stored is a no-op, not an error.
    await forgetAgentFiles("never-had-any");
});

// --- the state inspector ---

test("session.files lists the session's files and discards for a person, and nothing for a session with none", T, async () => {
    await writer.commit("seen", [{ op: "put", path: "w.npy", data: new Blob(["0123"]) }]);
    await writer.noteLost({ session: "seen", path: "agent/x.bin", at: 7, reason: "channel-ended" });
    const entry = (await readState({ runId: "seen" }, "human", "worker")).find((e) => e.id === "session.files");
    assert.deepEqual(entry?.value, { files: [{ path: "agent/w.npy", kind: "file", size: 4 }], lost: [{ path: "agent/x.bin", at: 7 }] });
    const none = (await readState({ runId: "empty" }, "human", "worker")).find((e) => e.id === "session.files");
    assert.equal(none?.value, undefined);
    // Declared for a person only: the model reads its files through /files itself.
    assert.equal((await readState({ runId: "seen" }, "model", "worker")).some((e) => e.id === "session.files"), false);
});
