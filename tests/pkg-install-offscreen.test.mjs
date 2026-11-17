// pkg-install-offscreen.test.mjs — who may drive an install's candidate in the offscreen document: PY_INSTALL_TEST and PY_INSTALL_STOP. Run: node --import tsx --test tests/pkg-install-offscreen.test.mjs

// src/offscreen.ts imported for real under a mocked `chrome` and a fake `Worker` (the scaffolding of
// python-bench-stop-offscreen.test.mjs). Design: docs/plan/repl/PACKAGES_INSTALL.md, item 10, shape (v).
import { test } from "node:test";
import assert from "node:assert/strict";

// --- a fake chrome and Worker around the real offscreen document ---

const listeners = [];
const sentToWorker = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
const workers = [];   // every Worker the document spawned, in order
class FakeWorker {
    constructor(url, opts) { this.url = url; this.name = opts?.name; this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    /** Play the worker's reply to the document. */
    reply(data) { this.onmessage({ data }); }
    /** The interrupt flag the document posted to this worker: the SharedArrayBuffer the document writes 2 into. */
    get flag() { return this.posts.find((p) => p.interruptBuffer)?.interruptBuffer; }
}
globalThis.Worker = FakeWorker;
// The idle reap arms a clock of minutes on every idle worker; a live timer would hold this process open.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); return t; };
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sentToWorker.push(m); return Promise.resolve(undefined); },
    },
};
await import("../src/offscreen.ts");

const SW = { id: "test" };   // the service worker's sender: our id, no tab
/** Deliver a runtime message to the document's listeners; resolves with its answer, or undefined when none came. */
const send = (msg, sender = SW) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => setTimeout(r, 0));

const TAB = { id: "test", tab: { id: 4 }, url: "https://evil.example/" };   // a content script: our id, but a tab
const OTHER = { id: "other-extension" };   // another extension: no tab, a foreign id
/** `send`, but a handler that took the message and never answers (the unguarded path) ends as "hung" rather than hanging the run. */
const sendOrHang = (msg, sender) => Promise.race([send(msg, sender), new Promise((r) => setTimeout(() => r("hung"), 300))]);
const TEST_MSG = { type: "PY_INSTALL_TEST", run: "r1", wheels: [], modules: ["x"] };

// --- who may drive an install's candidate (PACKAGES_INSTALL.md item 10, shape v) ---

for (const [name, sender] of [["a tab's sender", TAB], ["another extension", OTHER]]) {
    test(`PY_INSTALL_TEST from ${name} gets no answer and spawns no Worker`, async () => {
        const before = workers.length;
        assert.equal(await sendOrHang(TEST_MSG, sender), undefined);
        await tick();
        assert.equal(workers.length, before, "no candidate was started");
    });
    test(`PY_INSTALL_STOP from ${name} gets no answer`, async () => {
        assert.equal(await sendOrHang({ type: "PY_INSTALL_STOP", run: "r1" }, sender), undefined);
    });
}

test("positive control: the service worker's sender stops (nothing running) and starts a candidate", async () => {
    assert.deepEqual(await send({ type: "PY_INSTALL_STOP", run: "r1" }, SW), { ok: true, stopped: false });
    const before = workers.length;
    send(TEST_MSG, SW);   // not awaited: the fake worker never answers
    await tick();
    assert.ok(workers.length > before, "a Worker was spawned for the candidate");
    assert.ok(workers.at(-1).posts.length > 0, "and was handed work");
});
