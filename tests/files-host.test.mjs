// files-host.test.mjs — which Python workers get `/files` (files-host.ts): none until the reader is set, then only a
// worker-hosted run's own, its session fixed to the run's; and what a worker may ask of the channel (files-wire.ts).

import { test } from "node:test";
import assert from "node:assert";
import { setFilesReader, attachFiles, filesMessage, detachFiles } from "../src/python/files-host.ts";
import { allocFilesShared, serveFiles } from "../src/python/files-wire.ts";

/** A worker that records what the offscreen document posts to it. */
const worker = () => ({ posted: [], postMessage(m) { this.posted.push(m); } });

/** A channel that records every member called on it. */
function recordingChannel() {
    const calls = [];
    const ch = new Proxy({}, {
        get: (_t, k) => (k === "then" ? undefined : k === "home" ? "/files/agent" : (...a) => { calls.push([k, ...a]); return Promise.resolve(k === "stat" ? { kind: "dir" } : undefined); }),
        has: () => true,
    });
    return { ch, calls };
}

// --- dormant until the reader is set: every worker gets nothing ---

test("with no reader set, no worker gets a channel, and no message is taken as a /files request", () => {
    setFilesReader(null);
    for (const principal of ["run:abc", "full", "own", "page:3", "library", "install:abc"]) {
        const w = worker();
        attachFiles(principal, w);
        assert.deepEqual(w.posted, [], principal);
        assert.equal(filesMessage(principal, { filesReq: { id: 1, op: "stat", args: ["agent"] } }), false, principal);
    }
});

// --- with a reader: only a run's own worker, its session the run's ---

test("only a worker-hosted run's worker gets a channel, with the run's session, never a page's, the bench's, library or an install's candidate", () => {
    const opened = [];
    setFilesReader(() => { const r = recordingChannel(); opened.push(r); return r.ch; });
    try {
        for (const principal of ["full", "own", "page:3", "library", "install:abc", "run:"]) {
            const w = worker();
            attachFiles(principal, w);
            assert.deepEqual(w.posted, [], principal);
        }
        assert.equal(opened.length, 0);
        const w = worker();
        attachFiles("run:abc123", w);
        assert.equal(opened.length, 1);
        assert.deepEqual(opened[0].calls, [["setSession", "abc123"]]);
        assert.equal(w.posted.length, 1);
        assert.ok(w.posted[0].filesShared.ctl instanceof SharedArrayBuffer && w.posted[0].filesShared.data instanceof SharedArrayBuffer);
        // Where the run writes is the reader's, posted as it gave it: the worker never derives it.
        assert.equal(w.posted[0].filesHome, "/files/agent");
        // The worker's end disposes the channel: every descriptor closes and every open txn aborts.
        detachFiles("run:abc123");
        assert.deepEqual(opened[0].calls.at(-1), ["dispose"]);
        assert.equal(filesMessage("run:abc123", { filesReq: { id: 1, op: "stat", args: ["agent"] } }), false);
    } finally { setFilesReader(null); }
});

// --- what a worker may ask: a listed op, never the offscreen document's own members ---

test("a worker's request names only a listed op: setSession, dispose and prototype names never reach the channel", async () => {
    const { ch, calls } = recordingChannel();
    const { handle } = serveFiles(allocFilesShared(), ch);
    let id = 0;
    for (const op of ["setSession", "dispose", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
        assert.equal(handle({ filesReq: { id: ++id, op, args: ["evil"] } }), true, op);
    }
    handle({ filesReq: { id: ++id, op: "stat", args: ["agent"] } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.map((c) => c[0]), ["stat"]);
});
