// The sweep's memory: the harness reading the box as the resource panel does (resource-poll.mjs: `/api/ps` and
// `/api/info` through the panel's own parsers), the samples packed for the page, memory.md, and the timeline drawing
// the panel's memory chart above its lanes only when there are readings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { BOXES } from "./fixtures/boxes.mjs";
import { readSample, packSamples, startResourcePoll, memoryText } from "../tests/e2e/bench/resource-poll.mjs";
import { staticPage } from "../tests/e2e/bench/serve.mjs";

const S = BOXES.cuda, GiB = 1024 ** 3;
const idle = (i) => S.devices[i].total_memory - S.idleHeld;
const BACKEND = { chatUrl: "http://box:3000/api/chat/completions", key: "k" };
/** A box with `model` (of `size`) resident on card 0, or nothing. */
const bodies = (model, size) => ({
    ps: { models: model ? [{ model, name: model, size, size_vram: size, context_length: 32768, expires_at: "2026-10-09T11:00:00Z", gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: size }] }] : [] },
    info: { compute: { system_compute: { cpu_cores: 32, total_memory: S.hostTotal, free_memory: 60 * GiB, free_swap: 0 },
        supported_gpus: S.devices.map((d, i) => ({ ...d, free_memory: idle(i) - (i === 0 && model ? size : 0) })) } },
});
/** A server that answers on OpenWebUI's `/ollama` passthrough only, recording what it was asked. */
const server = (b, asked = []) => async (url, init) => {
    asked.push([url, init?.headers?.authorization]);
    if (!url.startsWith("http://box:3000/ollama/")) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => (url.endsWith("/api/ps") ? b.ps : b.info) };
};

// --- reading the box ---

test("a reading is the panel's sample: the resident model's bytes on its card, and the box's capacity", async () => {
    const asked = [];
    const s = await readSample(BACKEND, { fetchImpl: server(bodies("gemma4:31b", 18 * GiB), asked), now: () => 1000 });
    assert.equal(s.t, 1000);
    assert.deepEqual(s.models.map((m) => [m.model, m.vramBytes, m.perDevice]), [["gemma4:31b", 18 * GiB, { 0: 18 * GiB }]]);
    assert.equal(s.capacity.devices.length, 2);
    assert.equal(s.capacity.devices[0].freeBytes, idle(0) - 18 * GiB);
    // The worker's base order, with the key: the origin itself was tried for /api/info and refused; ps went to the base that answered.
    assert.deepEqual(asked.map(([u]) => u.replace("http://box:3000", "")), ["/ollama/api/info", "/ollama/api/ps"]);
    assert.ok(asked.every(([, auth]) => auth === "Bearer k"));
});

test("a box with no /api/info gives no reading (unknown, never zero), and the poll stops asking after a few tries", async () => {
    const stock = async (url) => ({ ok: !url.endsWith("/api/info"), json: async () => (url.endsWith("/api/ps") ? { models: [] } : "<html>") });
    assert.equal(await readSample(BACKEND, { fetchImpl: stock }), null);
    let calls = 0;
    const poll = startResourcePoll(BACKEND, { everyMs: 1, maxMisses: 3, fetchImpl: async (...a) => { calls++; return stock(...a); } });
    await new Promise((r) => setTimeout(r, 60));
    const after = calls;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, after, "stopped by itself");
    assert.equal(poll.samples(), null);
    poll.stop();
});

test("packed samples keep each capacity once, and the poll hands back what it read, in order", async () => {
    let n = 0;
    const seq = [bodies(null), bodies(null), bodies("gemma4:31b", 18 * GiB), bodies("gemma4:31b", 18 * GiB)];
    const poll = startResourcePoll(BACKEND, { everyMs: 1, fetchImpl: (url, init) => server(seq[Math.min(n, seq.length - 1)])(url, init).finally(() => { if (url.endsWith("/api/ps")) n++; }) });
    while (n < 4) await new Promise((r) => setTimeout(r, 5));
    poll.stop();
    const p = poll.samples();
    assert.ok(p.samples.length >= 4);
    assert.equal(p.capacities.length, 2, "an idle box and a loaded one");
    assert.deepEqual(p.samples.slice(0, 4).map((s) => s.c), [0, 0, 1, 1]);
    assert.ok(p.samples.every((s, i) => !i || s.t >= p.samples[i - 1].t));
    assert.equal(packSamples([]), null);
});

// --- memory.md ---

test("memory.md: each pool's peak and mean, each model's stretch in memory; and what no readings means", async () => {
    const reads = [];
    for (const [t, b] of [[0, bodies(null)], [2000, bodies("gemma4:31b", 18 * GiB)], [4000, bodies(null)]]) reads.push(await readSample(BACKEND, { fetchImpl: server(b), now: () => Date.UTC(2026, 9, 9, 10, 0, 0) + t }));
    const md = memoryText(packSamples(reads));
    assert.match(md, /3 readings, every 2 s, 10:00:00 to 10:00:04/);
    assert.match(md, /\| CUDA0 \| 95\.0 GiB \| 18\.5 GiB \| 10:00:02 \| 6\.5 GiB \|/);
    assert.match(md, /\| gemma4:31b \| 10:00:02 \| 10:00:02 \| 18\.0 GiB \|/);
    assert.match(memoryText(null), /No readings: the backend serves no `\/api\/info`/);
});

// --- the page ---

test("the timeline draws the panel's memory chart above its lanes when there are readings, and only then", async (t) => {
    const reads = [];
    for (let k = 0; k < 6; k++) reads.push(await readSample(BACKEND, { fetchImpl: server(bodies(k > 1 ? "gemma4:31b" : null, 18 * GiB)), now: () => 10_000 + k * 2000 }));
    const runs = [{ combo: { model: "gemma4:31b" }, taskId: "t", repeat: 0, state: "done", who: "g", ok: true }];
    const timeline = { now: 22_000, runs: [{ index: 0, events: [{ kind: "run", t: 14_000, until: 20_000, label: "run", model: "gemma4:31b" }] }] };
    const base = { name: "x", dims: ["model"], runs, rows: [], jobs: 1, started: 10_000, finished: 22_000, timeline };
    // Each window is closed at the end: the chart ticks its axis on an interval, which would keep the runner alive.
    const opened = [];
    const dom = async (state) => { const w = new JSDOM(await staticPage(state), { runScripts: "dangerously", pretendToBeVisual: true }).window; opened.push(w); return w.document; };
    t.after(() => opened.forEach((w) => w.close()));
    const withMem = await dom({ ...base, resources: packSamples(reads) });
    const card = [...withMem.querySelectorAll(".card")].find((c) => c.querySelector(".tl"));
    assert.ok(card.querySelector(".tlchart .rc"), "the panel's chart");
    assert.ok(card.querySelector(".tlchart .tl .rc-ev-run"), "the run's lane, under it");
    assert.equal(card.querySelector(".wml-lane-axis"), null, "the chart's axis, not a second one");
    const without = await dom(base);
    assert.equal(without.querySelector(".rc"), null);
    assert.ok(without.querySelector(".tl .wml-lane-axis"), "its own axis without a chart");
});
