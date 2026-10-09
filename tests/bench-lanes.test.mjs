// A sweep in per-model lanes (tests/e2e/bench/lanes.mjs): which lanes run side by side, which wait for room on the box,
// and how the box's `/api/fits` answer is read. The cells are timers and the box is a function, so every case is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLanes, fitsGate } from "../tests/e2e/bench/lanes.mjs";

/** Cells as `model` strings; `fn` records what ran at once, each cell taking `ms`. */
function harness(models, { ms = 20 } = {}) {
    const live = new Set(), together = [], order = [];
    let peak = 0;
    const fn = async (model, i) => {
        live.add(`${model}#${i}`);
        together.push([...live].map((k) => k.split("#")[0]).sort().join("+"));
        peak = Math.max(peak, live.size);
        order.push(i);
        await new Promise((r) => setTimeout(r, ms));
        live.delete(`${model}#${i}`);
        return i;
    };
    return { cells: models, fn, together, order, peak: () => peak };
}
const opts = (h, gate, extra = {}) => ({ modelOf: (m) => m, gate, fn: h.fn, retryMs: 5, ...extra });

// --- which lanes run at once ---

test("models that fit run side by side, each model's own cells one after another", async () => {
    const h = harness(["a", "a", "b", "b", "c"]);
    const out = await runLanes(h.cells, opts(h, async () => ({ go: true, local: true, resident: true, why: "fits" })));
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
    assert.equal(h.peak(), 3, "a, b and c at once");
    assert.ok(h.together.every((t) => !/a\+a|b\+b/.test(t)), "never two cells of one model at once");
});

test("a model that would displace another waits until the box is free, then runs as one job would", async () => {
    // A box with room for ONE of the two: whichever is loaded fits, the other would displace it.
    const h = harness(["a", "a", "b"]);
    let box = null;
    const gate = async (m) => (box === null || box === m ? { go: true, local: true, resident: box === m, why: "fits" } : { go: false, local: true, why: `would displace ${box}` });
    const logs = [];
    await runLanes(h.cells, { ...opts(h, gate), settle: async (m) => { box = m; }, log: (l) => logs.push(l) });
    assert.equal(h.peak(), 1, "b never ran beside a");
    assert.deepEqual([...h.order].sort(), [0, 1, 2]);
    assert.ok(logs.some((l) => /lane b: waits \(would displace a\)/.test(l)));
});

test("a lane waiting for room does not hold up a lane that fits", async () => {
    const h = harness(["a", "a", "a", "b", "c"], { ms: 30 });
    const gate = async (m) => (m === "b" ? { go: false, local: true, why: "too big" } : { go: true, local: true, resident: true, why: "fits" });
    await runLanes(h.cells, opts(h, gate));
    assert.ok(h.together.some((t) => t === "a+c"), "c ran beside a while b waited");
    assert.ok(h.together.includes("b"), "and b ran once it had the box to itself");
});

test("when the box cannot say, local models take turns; a cloud model runs beside them", async () => {
    const h = harness(["a", "b", "cloud", "cloud"]);
    const gate = async (m) => (m === "cloud" ? { go: true, local: false, why: "cloud" } : { go: null, local: true, why: "no /api/fits" });
    await runLanes(h.cells, opts(h, gate));
    assert.ok(h.together.every((t) => !/a\+b|a.*b/.test(t)), "a and b never together");
    assert.ok(h.together.some((t) => t.includes("cloud") && (t.includes("a") || t.includes("b"))), "the cloud model alongside a local one");
});

test("--jobs caps how many lanes run at once", async () => {
    const h = harness(["a", "b", "c", "d"]);
    await runLanes(h.cells, opts(h, async () => ({ go: true, local: false, why: "cloud" }), { maxLanes: 2 }));
    assert.equal(h.peak(), 2);
});

test("a model that was not loaded is settled before the next lane asks, so two lanes are never both told it fits", async () => {
    const h = harness(["a", "b"]);
    const loaded = new Set(), asked = [];
    const gate = async (m) => { asked.push([m, [...loaded].sort().join(",")]); return { go: true, local: true, resident: loaded.has(m), why: "fits" }; };
    await runLanes(h.cells, opts(h, gate, { settle: async (m) => { loaded.add(m); } }));
    assert.deepEqual(asked.map(([m, l]) => (m === "b" ? l : null)).filter((x) => x != null), ["a"], "b asked after a was loaded");
});

// --- reading the box's answer ---

/** A fetch answering `/ollama/api/fits` with `byModel[model]` as `[status, body]`. */
const fakeFetch = (byModel) => async (url) => {
    const u = new URL(url);
    if (!u.pathname.startsWith("/ollama/api/fits")) return { ok: false, status: 404, json: async () => { throw new Error("HTML"); } };
    const [status, body] = byModel[u.searchParams.get("model")] ?? [404, { detail: "model not found" }];
    return { ok: status === 200, status, json: async () => body };
};
const backend = { chatUrl: "https://owui.test/api/chat/completions", key: "k" };

test("fitsGate: fits, already loaded, would displace, and a cloud model the server does not list as Ollama's", async () => {
    const gate = fitsGate(backend, new Map([["sonnet", { local: false }], ["gemma4:31b", { local: true }]]), fakeFetch({
        "gemma4:31b": [200, { fits: true, resident: true, displaces: [], gpu_ids: ["0"] }],
        "gemma4:26b": [200, { fits: true, resident: false, displaces: [], gpu_ids: ["1"] }],
        "qwen3.8:big": [200, { fits: false, displaces: ["gemma4:31b", "gemma4:26b"] }],
    }));
    assert.deepEqual(await gate("gemma4:31b"), { go: true, local: true, resident: true, why: "already loaded" });
    assert.deepEqual(await gate("gemma4:26b"), { go: true, local: true, resident: false, why: "fits on GPU 1" });
    assert.deepEqual(await gate("qwen3.8:big"), { go: false, local: true, resident: false, why: "would displace gemma4:31b, gemma4:26b" });
    assert.equal((await gate("sonnet")).local, false);
    assert.equal((await gate("sonnet")).go, true);
    // Not Ollama's (404 from it) and not listed as local: not on the box.
    assert.deepEqual(await gate("openrouter/kimi"), { go: true, local: false, why: "not an Ollama model" });
});

test("fitsGate: a server with no /api/fits cannot say (go null); an Ollama model it 404s stays local", async () => {
    const none = fitsGate(backend, new Map(), async () => ({ ok: false, status: 404, json: async () => { throw new Error("SPA HTML"); } }));
    assert.deepEqual(await none("gemma4:31b"), { go: null, local: true, why: "the box cannot say whether it fits (no /api/fits)" });
    const listed = fitsGate(backend, new Map([["gemma4:31b", { local: true }]]), fakeFetch({}));
    assert.equal((await listed("gemma4:31b")).go, null, "listed as Ollama's, so a 404 is not read as 'not on the box'");
});
