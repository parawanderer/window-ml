// ps-read.test.mjs — reading what is RESIDENT (`/api/ps`) in src/sidebar/resource-feed.ts: `readPs` reads whatever
// panel is or is not open, `pollPs` keeps the sidebar's guards, and `loadedAt` moves only on a reading that arrived.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const feed = await import("../src/sidebar/resource/resource-feed.ts");
const store = await import("../src/sidebar/store.ts");
const panel = await import("../src/sidebar/resource/panel-state.ts");

/** A worker that answers OLLAMA_PS with `reply`, counting what it was asked. */
let sent = [];
const worker = (reply) => {
    sent = [];
    globalThis.chrome = { runtime: { lastError: undefined, sendMessage: (msg, cb) => { sent.push(msg.type); cb?.(reply); } } };
};
beforeEach(() => { feed.loadedAt.value = null; store.loadedModels.value = null; store.psError.value = null; store.sidebarOpen.value = false; panel.streamLive.value = false; });

// --- reading the resident set, and when that reading counts as news ---

test("readPs reads with no sidebar slid open, where pollPs keeps the sidebar's own guards", () => {
    worker({ data: [{ model: "qwen3:32b", vramBytes: 1, sizeBytes: 1 }] });
    feed.pollPs();
    assert.deepEqual(sent, [], "the sidebar's poll waits for its shell to be open");
    feed.readPs();
    assert.deepEqual(sent, ["OLLAMA_PS"], "the chat page's read does not");
    assert.deepEqual(store.loadedModels.value.map((m) => m.model), ["qwen3:32b"]);
    assert.equal(typeof feed.loadedAt.value, "number", "and the reading is stamped");
});

test("a failed read leaves the stamp alone, so it reads as old news rather than as nothing loaded", () => {
    worker({ data: [] });
    feed.readPs();
    const at = feed.loadedAt.value;
    worker({ error: "connection refused" });
    feed.readPs();
    assert.equal(store.psError.value, "connection refused");
    assert.equal(feed.loadedAt.value, at, "no new stamp for a reading that did not arrive");
});

test("while the event stream carries the readings, readPs does not add a second set", () => {
    worker({ data: [] });
    panel.streamLive.value = true;
    feed.readPs();
    assert.deepEqual(sent, []);
});
