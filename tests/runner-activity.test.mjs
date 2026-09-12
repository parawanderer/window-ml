// `activity` on `/api/ps` — what the runner is DOING, and how full its KV cache is.
//
// Driven off the REAL capture (tests/e2e/fixtures/runner-activity.json, recorded on mlbox from the
// `ollama-slop:activity3` build) rather than shapes written here, for the reason a hand-written fixture keeps
// proving: it agrees with itself. Two of the four cases below are ones nobody would have invented — an idle
// runner still reporting occupancy, and a generation with no prefill sample in it at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activityFrom, kvOccupancy, fmtOccupancy } from "../src/resource-model.ts";
import { loadedFrom } from "../src/resource-events.ts";

const CAP = JSON.parse(readFileSync(fileURLToPath(new URL("./e2e/fixtures/runner-activity.json", import.meta.url)), "utf8"));
const at = (t) => CAP.ps_samples.find((s) => s.t >= t);

test("the capture is what it claims to be", () => {
    // A fixture test that never checks the fixture is how a recording quietly becomes a stale copy.
    assert.equal(CAP.box, "mlbox");
    assert.equal(CAP.num_ctx, 8192);
    assert.ok(CAP.ps_samples.length > 100, "polled fast enough to contain a phase arc");
    const phases = new Set(CAP.ps_samples.map((s) => s.activity?.phase));
    assert.deepEqual([...phases].sort(), ["decode", "idle", "prefill"], "all three phases were captured");
});

test("phase and the in-flight counts, straight off the recording", () => {
    // PREFILL, mid-way: the engine reads the prompt in batch-sized steps, so `done` trails `prompt_tokens`.
    const pre = activityFrom(at(6.30).activity);
    assert.equal(pre.phase, "prefill");
    assert.equal(pre.promptTokens, 2048);
    assert.equal(pre.promptTokensDone, 1024, "prefill PROGRESS, not the total");
    assert.ok(pre.promptTokensDone < pre.promptTokens, "a prefill in progress has read less than it holds");

    // DECODE: `prompt_tokens` climbs with `decoded`, which is what makes it occupancy rather than prompt size.
    const dec = activityFrom(at(6.52).activity);
    assert.equal(dec.phase, "decode");
    assert.equal(dec.decoded, 36);
    assert.equal(dec.promptTokens, 4134);
    assert.equal(dec.promptTokensDone, 4098, "the prompt is fully read; only generation is moving");
    const later = activityFrom(at(6.60).activity);
    assert.equal(later.promptTokens - dec.promptTokens, later.decoded - dec.decoded,
        "n_past advances one for one with generation — it is tokens RESIDENT, not tokens of prompt");
});

test("an idle runner keeps its occupancy and drops the in-flight counts", () => {
    // The shape nobody would have written: the task is over, `done`/`cached`/`decoded` are gone, and
    // `prompt_tokens` still stands at 4177 — because those tokens really are still in the cache. Occupancy
    // survives the task; the work does not. Reading the survivor as work in progress is the mistake here.
    const idle = activityFrom(at(6.70).activity);
    assert.equal(idle.phase, "idle");
    assert.equal(idle.promptTokens, 4177);
    assert.equal(idle.promptTokensDone, undefined);
    assert.equal(idle.decoded, undefined);
    assert.equal(idle.promptTokensCached, undefined);
    // And it is a real reading, so it answers the question the field exists for.
    assert.equal(kvOccupancy({ activity: idle, contextLength: 8192 }).toFixed(3), (4177 / 8192).toFixed(3));
});

test("a prompt served from the cache explains a prefill too short to draw", () => {
    // Second run of the SAME prompt: 4097 of 4098 tokens came from the prefix cache, leaving one to compute.
    // There is no `prefill` sample anywhere in this stretch — not a sampling miss, the phase did not last
    // long enough to exist — and this field is the whole explanation for a timing that otherwise reads broken.
    const hit = activityFrom(at(8.74).activity);
    assert.equal(hit.phase, "decode");
    assert.equal(hit.promptTokensCached, 4097);
    assert.equal(hit.promptTokensDone, 1, "one token actually computed");

    const inWindow = CAP.ps_samples.filter((s) => s.t >= 8.654 && s.t <= 8.90);
    assert.ok(inWindow.length > 2, "the window really was sampled");
    assert.equal(inWindow.filter((s) => s.activity?.phase === "prefill").length, 0,
        "a cache hit can leave NO prefill to draw, and that is a legitimate outcome");
});

test("absent is not idle, and an unknown phase is not a fourth state", () => {
    // The server omits the whole object when it could not ask the runner — still loading, a backend with no
    // /slots, a failed poll, every build before this one. Collapsing that into `idle` would draw a full cache
    // as an empty one on every unpatched server, which is the same trap `memory` and `gpus` set.
    assert.equal(activityFrom(undefined), null);
    assert.equal(activityFrom(null), null);
    assert.equal(activityFrom({}), null, "no phase, no reading");
    assert.equal(activityFrom({ phase: "warming" }), null, "an unrecognised phase invents no rendering");
    assert.equal(activityFrom("idle"), null);
    // A LOADING row in the capture carries no activity at all, which is exactly that case.
    const loading = CAP.frames.map((w) => w.frame).find((f) => f.ps?.models?.some((m) => m.state === "loading"));
    assert.ok(loading, "the capture contains a loading row");
    assert.equal(activityFrom(loading.ps.models[0].activity), null);
});

test("kvOccupancy refuses rather than reporting an empty cache", () => {
    const a = { phase: "idle", slots: 1, slotsBusy: 0, promptTokens: 4096 };
    assert.equal(kvOccupancy({ activity: a, contextLength: 8192 }), 0.5);
    // Either half missing is UNKNOWN, never 0: an empty bar is a claim about memory nobody measured.
    assert.equal(kvOccupancy({ activity: undefined, contextLength: 8192 }), null);
    assert.equal(kvOccupancy({ activity: a, contextLength: null }), null);
    assert.equal(kvOccupancy({ activity: a, contextLength: 0 }), null);
    assert.equal(kvOccupancy({ activity: { phase: "idle", slots: 1, slotsBusy: 0 }, contextLength: 8192 }), null);
    // A genuinely empty cache IS zero, and that is a different answer from null.
    assert.equal(kvOccupancy({ activity: { ...a, promptTokens: 0 }, contextLength: 8192 }), 0);
    // Clamped: n_past can momentarily exceed the window the row reports, and a bar past its own ceiling
    // reads as a rendering fault rather than as a reading.
    assert.equal(kvOccupancy({ activity: { ...a, promptTokens: 9000 }, contextLength: 8192 }), 1);
});

test("loadedFrom carries activity through, and absence stays absent", () => {
    // The same parser serves the polled route and the stream's embedded body, so the field has to survive
    // that boundary or the two transports disagree about what a model IS.
    const row = { name: "m", model: "m", size: 1, size_vram: 1, context_length: 8192,
        activity: { phase: "decode", slots: 1, slots_busy: 1, prompt_tokens: 10, decoded: 3 } };
    assert.deepEqual(loadedFrom([row])[0].activity, row.activity, "raw, parsed once downstream");
    assert.ok(!("activity" in loadedFrom([{ name: "m", model: "m" }])[0]),
        "no key at all when the server said nothing — absence is the server's own signal");
});

test("loadedFrom carries which BUILD a model is, and a loading row's empty details stay absent", async () => {
    // A real /api/ps body off the box: two resident models, each with its `details`.
    const { readFileSync } = await import("node:fs");
    const { ps } = JSON.parse(readFileSync(new URL("./fixtures/hw/runner-pids-context-band-2026-09-11.json", import.meta.url), "utf8"));
    const by = Object.fromEntries(loadedFrom(ps.models).map((m) => [m.model, m]));
    assert.deepEqual([by["granite4.1:3b"].quant, by["granite4.1:3b"].paramSize, by["granite4.1:3b"].family], ["Q4_K_M", "3.4B", "granite"]);
    assert.equal(by["qwen3.5:0.8b"].quant, "Q8_0");
    // A `loading` row reports every detail as "" — not reported, never a model with no quantization.
    const loading = loadedFrom([{ name: "m", model: "m", state: "loading", size: 0, size_vram: 0,
        details: { parent_model: "", format: "", family: "", families: null, parameter_size: "", quantization_level: "" } }])[0];
    assert.ok(!("quant" in loading) && !("paramSize" in loading) && !("family" in loading));
});

test("fmtOccupancy: nearly-empty and nearly-full never round to the answer's opposite", () => {
    // The failure this exists for: 30 tokens of a 262,144 window rounds to "0%", which beside a reserved
    // 40 GiB says the cache is EMPTY — the exact claim the reader is about to act on, and false.
    assert.equal(fmtOccupancy(30 / 262144), "<1%");
    assert.equal(fmtOccupancy(0), "0%", "an empty cache IS empty — the one case the round number is right about");
    assert.equal(fmtOccupancy(1), "100%");
    assert.equal(fmtOccupancy(0.999), ">99%", "and a nearly-full cache must not read as full");
    assert.equal(fmtOccupancy(4177 / 8192), "51%");
});
