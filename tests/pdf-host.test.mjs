// The offscreen document's side of the PDF worker (src/pdf/pdf-host.ts) over a fake Worker: requests run one at a time,
// a request past the wall-clock cap terminates the worker and is refused with a sentence, the next one starts fresh,
// and an idle worker is stopped.
import test from "node:test";
import assert from "node:assert/strict";
import { createPdfHost } from "../src/pdf/pdf-host.ts";

/** A fake Worker. `behave(req, reply)` decides what it does with a request: answer, or never. */
function fakeWorkers(behave) {
    const made = [];
    const spawn = () => {
        const w = { terminated: false, seen: [], onmessage: null, onerror: null,
            postMessage(req) { w.seen.push(req); behave(req, (result) => queueMicrotask(() => w.onmessage?.({ data: { id: req.id, result } })), w); },
            terminate() { w.terminated = true; } };
        made.push(w);
        return w;
    };
    return { spawn, made };
}
const read = () => ({ op: "read", bytes: new ArrayBuffer(8) });
const doc = { ok: true, doc: { pageCount: 1, pages: [] } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- one request at a time, one worker kept ---

test("a request is answered by the worker with its result", async () => {
    const { spawn, made } = fakeWorkers((_req, reply) => reply(doc));
    const host = createPdfHost({ spawn });
    assert.deepEqual(await host.call(read()), doc);
    assert.equal(made.length, 1);
    host.stop();
});

test("requests are serialised: the second is not posted until the first has answered", async () => {
    const pending = [];
    const { spawn, made } = fakeWorkers((_req, reply) => pending.push(reply));
    const host = createPdfHost({ spawn });
    const a = host.call(read()), b = host.call(read());
    await wait(10);
    assert.equal(made[0].seen.length, 1);
    pending[0](doc);
    await a;
    await wait(10);
    assert.equal(made[0].seen.length, 2);
    pending[1](doc);
    assert.deepEqual(await b, doc);
    assert.equal(made.length, 1, "the same worker served both");
    host.stop();
});

// --- the wall-clock cap ---

test("a request past the cap terminates the worker and is refused with a sentence", async () => {
    const { spawn, made } = fakeWorkers(() => { /* never answers */ });
    const host = createPdfHost({ spawn, timeoutMs: 50 });
    const r = await host.call(read());
    assert.equal(r.ok, false);
    assert.equal(r.code, "timeout");
    assert.match(r.refusal, /^Reading this PDF took longer than \d+ seconds?, so it was stopped\.$/);
    assert.equal(made[0].terminated, true);
    assert.equal(host.alive, false);
});

test("a request queued behind a killed one is not killed with it: it gets a fresh worker", async () => {
    let n = 0;
    const { spawn, made } = fakeWorkers((_req, reply) => { if (++n > 1) reply(doc); });
    const host = createPdfHost({ spawn, timeoutMs: 50 });
    const [first, second] = await Promise.all([host.call(read()), host.call(read())]);
    assert.equal(first.code, "timeout");
    assert.deepEqual(second, doc);
    assert.equal(made.length, 2);
    assert.equal(made[0].terminated, true);
    assert.equal(made[1].terminated, false);
    host.stop();
});

test("a late answer from a killed worker is not mistaken for the next request's", async () => {
    let first;
    const { spawn, made } = fakeWorkers((req, reply) => { if (!first) first = reply; else reply({ ok: true, doc: { pageCount: 2, pages: [] } }); });
    const host = createPdfHost({ spawn, timeoutMs: 40 });
    await host.call(read());
    first(doc);
    const r = await host.call(read());
    assert.equal(r.doc.pageCount, 2);
    assert.equal(made.length, 2);
    host.stop();
});

// --- a worker that dies, and one that idles ---

test("a worker error refuses the request in flight and the next call starts a new worker", async () => {
    let calls = 0;
    const { spawn, made } = fakeWorkers((_req, reply, w) => { if (++calls === 1) w.onerror({ message: "boom" }); else reply(doc); });
    const host = createPdfHost({ spawn });
    const r = await host.call(read());
    assert.equal(r.ok, false);
    assert.equal(r.refusal, "The PDF reader stopped unexpectedly.");
    assert.deepEqual(await host.call(read()), doc);
    assert.equal(made.length, 2);
    host.stop();
});

test("a worker that cannot be started refuses with a sentence", async () => {
    const host = createPdfHost({ spawn: () => { throw new Error("no such script"); } });
    const r = await host.call(read());
    assert.equal(r.ok, false);
    assert.equal(r.refusal, "The PDF reader could not be started.");
});

test("an idle worker is stopped after the idle time, and the next call starts another", async () => {
    const { spawn, made } = fakeWorkers((_req, reply) => reply(doc));
    const host = createPdfHost({ spawn, idleMs: 30 });
    await host.call(read());
    assert.equal(host.alive, true);
    await wait(80);
    assert.equal(host.alive, false);
    assert.equal(made[0].terminated, true);
    await host.call(read());
    assert.equal(made.length, 2);
    host.stop();
});
