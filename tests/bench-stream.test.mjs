// A held bench run's screen on the bench page: the held run's frame server (bench/stream.mjs), which captures only while
// someone watches, the page's server passing it through (serve.mjs `/held`, `/held/<pid>/stream`), and the page's reader
// of the frames (page/frames.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveScreen, frameBytes } from "../tests/e2e/bench/stream.mjs";
import { readScreenFrames } from "../tests/e2e/bench/page/frames.ts";

// hold.mjs reads its list's path once, on import: a test's own, never the real one.
process.env.BENCH_HELD_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "held-")), "held.json");
const { startDashboard } = await import("../tests/e2e/bench/serve.mjs");

const ROOT = path.resolve(import.meta.dirname, "..");
const jpeg = (n) => Buffer.from(`frame-${n}`);
const until = async (ok, ms = 3000) => { for (const end = Date.now() + ms; !ok();) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };

/** A capture that records when it runs, and sends a frame when told to. */
function fakeCapture() {
    const c = { starts: 0, stops: 0, running: false, push: null };
    c.start = async (onFrame) => {
        c.starts++; c.running = true; c.push = onFrame;
        return async () => { c.stops++; c.running = false; c.push = null; };
    };
    return c;
}

/** Read frames from a URL until `n` arrived, then stop reading. Resolves the frames as text. */
async function take(url, n) {
    const ctl = new AbortController();
    const res = await fetch(url, { signal: ctl.signal });
    const got = [];
    await readScreenFrames(res.body, (f) => { got.push(Buffer.from(f).toString()); if (got.length === n) ctl.abort(); }).catch(() => {});
    return got;
}

// --- the held run's frame server ---

test("a held run captures its screen only while someone watches: the first viewer starts it, the last one leaving stops it", async (t) => {
    const cap = fakeCapture();
    const screen = await serveScreen(cap.start);
    t.after(() => screen.close());
    assert.equal(cap.starts, 0, "nobody watching: no capture");
    const url = `http://127.0.0.1:${screen.port}/stream`;
    const first = take(url, 2);
    await until(() => cap.running);
    cap.push(jpeg(1)); cap.push(jpeg(2));
    assert.deepEqual(await first, ["frame-1", "frame-2"]);
    await until(() => !cap.running);
    assert.deepEqual([cap.starts, cap.stops], [1, 1]);
    // A page that is not changing sends no frames, so a new viewer is given the last one at once.
    assert.deepEqual(await take(url, 1), ["frame-2"]);
});

test("a viewer arriving as the last one leaves keeps the capture running", async (t) => {
    const cap = fakeCapture();
    const screen = await serveScreen(cap.start);
    t.after(() => screen.close());
    const url = `http://127.0.0.1:${screen.port}/stream`;
    const a = new AbortController();
    await fetch(url, { signal: a.signal });
    await until(() => cap.running);
    a.abort();
    const second = take(url, 1);
    await until(() => screen.viewers() === 1 && cap.running);
    cap.push(jpeg(3));
    assert.deepEqual(await second, ["frame-3"]);
});

test("closing the held run ends every viewer's stream, which is how the page learns it ended", async () => {
    const cap = fakeCapture();
    const screen = await serveScreen(cap.start);
    const res = await fetch(`http://127.0.0.1:${screen.port}/stream`);
    await until(() => cap.running);
    cap.push(jpeg(1));
    const got = [];
    const done = readScreenFrames(res.body, (f) => got.push(Buffer.from(f).toString()));
    await until(() => got.length === 1);
    await screen.close();
    await done;   // settles: the stream ended
    assert.equal(cap.running, false);
});

// --- the page's reader ---

test("the page reads frames however the bytes are split, one byte at a time included", async () => {
    const bytes = Buffer.concat([frameBytes(jpeg(1)), frameBytes(Buffer.alloc(0)), frameBytes(Buffer.from("x".repeat(9000)))]);
    for (const step of [1, 3, 4, 5, 4096, bytes.length]) {
        const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += step) c.enqueue(new Uint8Array(bytes.subarray(i, i + step))); c.close(); } });
        const got = [];
        await readScreenFrames(body, (f) => got.push(f.length));
        assert.deepEqual(got, [7, 0, 9000], `in chunks of ${step}`);
    }
});

// --- the page's server ---

test("the page's server lists this sweep's held runs and passes each one's screen through; another sweep's are not its", async (t) => {
    // Anywhere: a held run's `dir` is relative to the repository, and one outside it resolves back the same way.
    const sweep = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-sweep-")));
    t.after(() => fs.rmSync(sweep, { recursive: true, force: true }));
    const cap = fakeCapture();
    const screen = await serveScreen(cap.start);
    t.after(() => screen.close());
    const rel = (p) => path.relative(ROOT, p);
    fs.writeFileSync(process.env.BENCH_HELD_FILE, JSON.stringify([
        { pid: process.pid, cell: "m · t · r0", sweep: "s", dir: rel(path.join(sweep, "t/m/r0")), expiresAt: "2026-10-10T10:00:00.000Z", stream: screen.port },
        { pid: process.ppid, cell: "elsewhere", sweep: "other", dir: "tests/e2e/artifacts/bench/other/t/m/r0", expiresAt: "2026-10-10T10:00:00.000Z", stream: 1 },
    ]));
    const dash = await startDashboard({ artifactRoot: sweep, port: 0 });
    t.after(() => dash.stop());
    const list = await (await fetch(`${dash.url}/held`)).json();
    assert.deepEqual(list, [{ pid: process.pid, cell: "m · t · r0", dir: "t/m/r0", expiresAt: "2026-10-10T10:00:00.000Z", stream: true }]);
    const frames = take(`${dash.url}/held/${process.pid}/stream`, 1);
    await until(() => cap.running);
    cap.push(jpeg(9));
    assert.deepEqual(await frames, ["frame-9"]);
    await until(() => !cap.running);   // the page's tile closed: the held run stops capturing
    assert.equal((await fetch(`${dash.url}/held/${process.ppid}/stream`)).status, 404, "another sweep's run is not served here");
});
