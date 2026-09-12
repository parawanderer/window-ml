// The per-load records kept for tuning the server's VRAM predictor (src/load-records.ts): fed frames in arrival
// order, one record per load once the reading that shows where it settled has arrived.
import { test } from "node:test";
import assert from "node:assert";
import { LoadRecorder, addRecords } from "../src/load-records.ts";

const GB = 1e9;
const info = (used, procs) => ({ compute: { system_compute: { total_memory: 8e9 },
    supported_gpus: [{ gpu_id: "0", runner: "CUDA", total_memory: 100 * GB, free_memory: 100 * GB - used,
        processes_scope: "pid_namespace", processes: procs }] } });
const runner = (bytes, loading = true) => [{ pid: 7, used_memory: bytes, name: "llama-server", runner: { model: "m:7b", ...(loading ? { loading: true } : {}) } }];
const EST = { predicted: 9 * GB, predicted_for_load: 10 * GB, source: "calibration", breakdown: { weights: 6 * GB, kv_cache: 3 * GB, compute: 0 } };

function run(rec) {
    const out = [];
    const push = (frame, at) => out.push(...rec.push(frame, at));
    push({ kind: "sample", t: 0, info: info(1 * GB, []) }, 0);
    push({ kind: "estimate", t: 0, model: "registry.ollama.ai/library/m:7b", estimate: EST }, 100);
    push({ kind: "load.start", t: 0, model: "registry.ollama.ai/library/m:7b" }, 200);
    push({ kind: "sample", t: 0, info: info(4 * GB, runner(3 * GB)) }, 450);
    push({ kind: "sample", t: 0, info: info(12 * GB, runner(11 * GB)) }, 700);
    push({ kind: "load.complete", t: 0, model: "registry.ollama.ai/library/m:7b", size_vram: 9.5 * GB, memory: { weights: 6 * GB, kv_cache: 3.5 * GB } }, 800);
    const before = out.length;
    push({ kind: "sample", t: 0, info: info(10.8 * GB, runner(9.8 * GB, false)) }, 950);
    return { out, before };
}

test("LoadRecorder: a load is recorded once where it SETTLED is known, with its prediction verbatim", () => {
    const { out, before } = run(new LoadRecorder());
    assert.equal(before, 0, "nothing on the complete edge itself: the settling reading comes after it");
    assert.equal(out.length, 1);
    const r = out[0];
    assert.equal(r.model, "m:7b", "one spelling of the model, the one /api/ps and the runner use");
    assert.deepEqual([r.start, r.end], [200, 800]);
    assert.deepEqual(r.estimate, EST, "the server's own words, not our reading of them");
    assert.deepEqual(r.complete, { size_vram: 9.5 * GB, memory: { weights: 6 * GB, kv_cache: 3.5 * GB } });
    assert.equal(r.trace.basis, "runner");
    assert.deepEqual(r.trace.peak, { t: 500, bytes: 11 * GB }, "the overshoot, relative to the load's start");
    assert.deepEqual(r.trace.final, { t: 750, bytes: 9.8 * GB });
    assert.deepEqual(r.trace.points, [[250, 3 * GB], [500, 11 * GB], [750, 9.8 * GB]]);
});

test("LoadRecorder: a failed attempt is counted, and the LAST estimate is the one kept", () => {
    const rec = new LoadRecorder();
    const m = "registry.ollama.ai/library/m:7b";
    rec.push({ kind: "sample", t: 0, info: info(1 * GB, []) }, 0);
    rec.push({ kind: "estimate", model: m, estimate: { predicted: 50 * GB } }, 10);
    rec.push({ kind: "load.start", model: m }, 20);
    rec.push({ kind: "load.failed", model: m, reason: "evicted a model; retrying" }, 30);
    rec.push({ kind: "load.start", model: m }, 50);
    // The retry's estimate lands AFTER its start (the probe answers once the attempt is under way), so the
    // one held at the start is the stale one.
    rec.push({ kind: "estimate", model: m, estimate: EST }, 55);
    rec.push({ kind: "load.complete", model: m, size_vram: 9 * GB }, 60);
    const [r] = rec.push({ kind: "sample", t: 0, info: info(10 * GB, runner(9 * GB, false)) }, 70);
    assert.equal(r.failedAttempts, 1);
    assert.deepEqual(r.estimate, EST);
    assert.equal(r.start, 50, "the attempt that succeeded");
});

test("addRecords: a reconnect's replay of a load already recorded is recognised, and the cap holds", () => {
    const { out } = run(new LoadRecorder());
    const once = addRecords([], out);
    assert.equal(addRecords(once, [{ ...out[0], end: out[0].end + 1200 }]).length, 1, "the same load, re-anchored by a new hello");
    assert.equal(addRecords(once, [{ ...out[0], end: out[0].end + 60_000 }]).length, 2, "a later load of the same model is its own record");
    assert.equal(addRecords(once, Array.from({ length: 5 }, (_, i) => ({ ...out[0], end: i * 10_000 + 99_000 })), 3).length, 3);
});
