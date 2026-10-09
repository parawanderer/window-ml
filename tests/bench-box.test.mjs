// The box's own record during a sweep (box-stream.mjs): the patched Ollama's event stream read as the worker reads it,
// derived as the resource panel derives it, every frame kept once in box.sqlite, polling when there is no stream, and
// what the page and memory.md make of it. Driven by a stream recorded on the real box.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { boxReducer, connectBoxStream, openBoxLog, logFrames, startBox } from "../tests/e2e/bench/box-stream.mjs";
import { memoryText, packSamples } from "../tests/e2e/bench/resource-poll.mjs";
import { staticPage } from "../tests/e2e/bench/serve.mjs";

let sqlite = true;
try { await import("node:sqlite"); } catch { sqlite = false; }
const needsSqlite = { skip: sqlite ? false : "this Node has no node:sqlite" };

const RECORDED = fs.readFileSync(new URL("./fixtures/hw/events-vectors-lifecycle-2026-09-17.ndjson", import.meta.url), "utf8");
const FRAMES = RECORDED.trim().split("\n").map((l) => JSON.parse(l));
const BACKEND = { chatUrl: "http://box:3000/api/chat/completions", key: "k" };

/** The recorded stream as a server would send it, in chunks that split lines (a slow link's reads). */
const streamResponse = (text) => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < text.length; i += 997) c.enqueue(new TextEncoder().encode(text.slice(i, i + 997))); c.close(); },
}), { headers: { "content-type": "application/x-ndjson" } });

// --- deriving what the box did ---

test("the recorded stream becomes the panel's readings and the box's events: both loads in their two halves, model names short", () => {
    const r = boxReducer();
    const T0 = 1_700_000_000_000;
    for (const f of FRAMES) r.push(f, T0 + f.t);
    const s = r.samples();
    // 43 readings; three carry no `/api/info` body and are drawn against the capacity the one before them had.
    assert.equal(s.length, 43);
    assert.ok(s.every((x) => x.capacity), "each against the capacity in force");
    const loads = r.events(T0 + 30_000).filter((e) => e.kind === "load");
    assert.deepEqual(loads.map((e) => [e.t - T0, e.until - T0]), [[3402, 4758], [20178, 26064]]);
    assert.equal(loads[0].model, "qwen3.5:0.8b");
    assert.ok(!loads.some((e) => e.model.includes("registry.ollama.ai")), "the stream's long names, normalised as /api/ps names them");
    assert.deepEqual(loads[0].phases.map((p) => [p.kind, p.until - T0]), [["weights", 4135], ["context", 4758]]);
    assert.ok(r.events(T0 + 30_000).every((e) => e.via === "server"));
});

// --- reading the stream ---

/** A server with the stream on OpenWebUI's passthrough, answering every connection with the recorded frames (as a
 *  reconnect is answered: the ring replays what the first connection already had). */
const streaming = (asked = []) => async (url) => {
    asked.push(url.replace("http://box:3000", ""));
    if (url === "http://box:3000/ollama/api/ps") return new Response(JSON.stringify({ models: [] }), { headers: { "content-type": "application/json" } });
    if (url.startsWith("http://box:3000/ollama/api/events?since=")) return streamResponse(RECORDED);
    return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
};

test("the client reads every frame through lines split across reads, anchors the server's clock on the hello, and reconnects", async () => {
    const got = [], asked = [];
    const c = connectBoxStream(BACKEND, { fetchImpl: streaming(asked), onFrame: (frame, meta) => { got.push({ frame, ...meta }); if (got.length === FRAMES.length * 2) c.stop(); } });
    await c.done;
    assert.equal(got.length, FRAMES.length * 2, "the stream ended once and was asked again");
    assert.deepEqual(got.slice(0, FRAMES.length).map((g) => g.frame.kind), FRAMES.map((f) => f.kind));
    assert.equal(got[5].box, "dd94d56bb74d", "the server's own id for the box");
    assert.equal(got[5].serverAt, Date.parse(FRAMES[0].serverTime) + FRAMES[5].t);
    assert.match(asked[1], /^\/ollama\/api\/events\?since=\d+$/);
});

test("the box log keeps each frame once: a reconnect's replay and a second sweep on the same box add nothing", needsSqlite, async () => {
    const db = await openBoxLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-box-")), "box.sqlite"));
    const serverT0 = Date.parse(FRAMES[0].serverTime);
    const rows = (localT0) => FRAMES.map((frame) => ({ frame: { ...frame, backfilled: localT0 ? 1 : null }, at: localT0 + frame.t, serverAt: serverT0 + frame.t, box: "dd94d56bb74d" }));
    assert.equal(logFrames(db, rows(1000)), FRAMES.length);
    assert.equal(logFrames(db, rows(5000)), 0, "the same frames, delivered again on another connection");
    const kinds = db.prepare("SELECT kind, COUNT(*) AS n FROM frames GROUP BY kind ORDER BY kind").all().map((r) => [r.kind, r.n]);
    assert.ok(kinds.some(([k, n]) => k === "load.complete" && n === 2));
    assert.deepEqual(JSON.parse(db.prepare("SELECT frame FROM frames WHERE kind = 'hello'").get().frame).box, "dd94d56bb74d", "stored verbatim");
});

test("a server with no event stream is polled instead", async () => {
    const GiB = 1024 ** 3;
    const info = { compute: { system_compute: { cpu_cores: 8, total_memory: 64 * GiB, free_memory: 32 * GiB, free_swap: 0 }, supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 24 * GiB, free_memory: 20 * GiB, compute: "8.6", driver: "13" }] } };
    const stock = async (url) => {
        if (url.endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }), { headers: { "content-type": "application/json" } });
        if (url.endsWith("/api/info")) return new Response(JSON.stringify(info), { headers: { "content-type": "application/json" } });
        return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    const box = startBox(BACKEND, { fetchImpl: stock });
    for (let i = 0; i < 100 && box.mode !== "poll"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(box.mode, "poll");
    for (let i = 0; i < 100 && !box.resources(); i++) await new Promise((r) => setTimeout(r, 20));
    box.stop();
    assert.ok(box.resources().samples.length >= 1);
    assert.equal(box.resources().events, undefined, "no stream, so no box events");
});

// --- what the page and memory.md show ---

test("memory.md lists what the box reported; the timeline draws it as its own row above the runs", async (t) => {
    const r = boxReducer();
    const T0 = 1_700_000_000_000;
    for (const f of FRAMES) r.push(f, T0 + f.t);
    const packed = { ...packSamples(r.samples()), events: r.events(T0 + 30_000) };
    const md = memoryText(packed);
    assert.match(md, /## What the box reported/);
    assert.match(md, /\| load \| qwen3\.5:0\.8b \| 1\.4 s \| .*weights 0\.7 s, context 0\.6 s \|/);
    const runs = [{ combo: { model: "qwen3.5:0.8b" }, taskId: "t", repeat: 0, state: "done", who: "q", ok: true }];
    const timeline = { now: T0 + 30_000, runs: [{ index: 0, events: [{ kind: "run", t: T0 + 4000, until: T0 + 5000, label: "run", model: "qwen3.5:0.8b" }] }] };
    const w = new JSDOM(await staticPage({ name: "x", dims: ["model"], runs, rows: [], jobs: 1, started: T0, finished: T0 + 30_000, timeline, resources: packed }), { runScripts: "dangerously", pretendToBeVisual: true }).window;
    t.after(() => w.close());   // the chart ticks on an interval
    const tl = w.document.querySelector(".tlchart .tl");
    assert.equal(tl.querySelector(".who").textContent, "the box");
    assert.equal(tl.querySelectorAll(".wml-lane")[0].querySelectorAll(".rc-ev-load").length, 2);
});
