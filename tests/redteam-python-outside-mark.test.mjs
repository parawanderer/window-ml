// redteam-python-outside-mark.test.mjs — what a hostile page or a hostile cell must NOT get from the OUTSIDE MARK
// (src/python/py-mark.ts; src/offscreen.ts `outsideMarks`; docs/spec/PYTHON_DIALECT.md, "What an inside run may leave
// behind is data, never code"). Once a worker was posted a cell outside the read-only dialect, no later cell in it is
// tried inside: a lifted call runs Python callees ungated, so a plant an approved cell leaves in that interpreter would
// run in a cell nobody was asked about (tests/python-outside-plant.test.mjs measures the plant on the real core).
//
// Rows, by property: one outside cell closes every inside door in that worker, and no other principal's; the mark cannot
// be forged, cleared or reported by the worker's own word; an outside cell that failed still marks, and a killed worker
// is replaced rather than reused; a cell the GATE refused is not an outside cell, so it marks nothing; and one run's
// marked worker does not cost every later run its inside try through the service worker's probe cache.
//
// The document is imported for real under a mocked `chrome` and a fake `Worker`, as python-outside-mark.test.mjs does.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKED_AGAIN, MARKED_FIRST } from "../src/python/py-mark.ts";

mock.timers.enable({ apis: ["setTimeout"] });

const listeners = [];
const workers = [];
class FakeWorker {
    constructor() { this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: () => Promise.resolve(undefined),
    },
};
await import("../src/offscreen.ts");

const send = (msg) => new Promise((resolve) => {
    for (const fn of listeners) { if (fn(msg, { id: "test" }, resolve) === true) return; }
    resolve(undefined);
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/**
 * One PY_RUN; its answer, resolved by the worker it reached with `reply` — or, when the document answered it itself (a
 * marked inside try), by the document, with no worker posted. `reply: null` leaves the cell running.
 * @returns {{ w: FakeWorker | undefined, answer: Promise<any> }} the worker posted, and the answer
 */
async function cell({ principal, code = "x = 1", inside = false, libraries, reply = {} }) {
    const before = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", principal, code, image: null, hardened: true, tables: null, ...(inside ? { inside: true } : {}), ...(libraries ? { libraries } : {}) });
    await settle();
    const w = workers.find((x) => x.posts.length > (before.get(x) ?? 0));
    if (w && reply !== null) w.reply({ id: w.posts.at(-1).id, ok: true, stdout: "", ...reply });
    return { w, answer };
}

// --- one outside cell closes every inside door in that worker, and no other principal's ---

test("RED TEAM: one outside cell closes every inside door in its worker: the plain try, the try carrying libraries, and the readiness probe", async () => {
    const out = await cell({ principal: "run:door1", code: "import os" });
    assert.ok(out.w, "the outside cell was posted");
    await out.answer;
    const posted = out.w.posts.length;
    // Every shape an inside try can take from the service worker: the cell, the same cell with the dialect's tier 3
    // libraries riding it, and the `pass` probe that asks whether the sandbox can judge membership at all.
    for (const [shape, code, libraries] of [["plain", "x = 1", undefined], ["with libraries", "x = 1", [{ name: "np" }]], ["the probe", "pass", undefined]]) {
        const inside = await cell({ principal: "run:door1", code, inside: true, libraries });
        assert.equal(inside.w, undefined, `the ${shape} inside try was posted to the marked worker`);
        const r = await inside.answer;
        assert.deepEqual([r.ok, r.marked], [false, true], `${shape}: ${JSON.stringify(r)}`);
        assert.equal(typeof r.notInDialect, "string", `${shape}: the refusal is not the mark's`);
    }
    assert.equal(out.w.posts.length, posted, "the marked worker was posted an inside try");
});

test("RED TEAM: a page's outside cell marks the page's worker alone, reports no mark for a run, and shuts that page's inside door", async () => {
    const page = await cell({ principal: "page:77", code: "import os" });
    assert.ok(page.w);
    const pageAnswer = await page.answer;
    assert.equal(pageAnswer.markSet, undefined, "a page's cell answered with a run log's mark record");
    // A run's inside try is a different worker: unmarked, and made.
    const run = await cell({ principal: "run:iso2", inside: true });
    assert.ok(run.w, "a run's inside try was refused because a PAGE's worker was marked");
    assert.equal((await run.answer).notInDialect, undefined);
    // The page's own worker is marked as any worker is: the page gets no inside door either.
    const pageInside = await cell({ principal: "page:77", inside: true });
    assert.equal(pageInside.w, undefined);
    assert.equal((await pageInside.answer).marked, true);
});

// --- the mark is the document's word: the worker can neither set, clear nor report it ---

test("RED TEAM: a worker cannot forge the mark into existence, and a forged answer reports nothing", async () => {
    const first = await cell({ principal: "run:forge3", inside: true, reply: { marked: true, markSet: true } });
    assert.ok(first.w, "an unmarked worker's inside try is posted");
    const r = await first.answer;
    assert.deepEqual([r.marked, r.markSet], [undefined, undefined], "the worker's own words reached the service worker");
    const next = await cell({ principal: "run:forge3", inside: true });
    assert.ok(next.w, "a forged `marked` made the document skip a real inside try");
});

test("RED TEAM: an outside cell that FAILED still marks, and a reply saying it did not set the mark is ignored", async () => {
    const failed = await cell({ principal: "run:fail4", code: "raise SystemExit", reply: { ok: false, error: "boom", marked: false, markSet: false } });
    const r = await failed.answer;
    assert.equal(r.marked, undefined, "the worker's `marked: false` came through");
    assert.equal(r.markSet, true, "the document did not report the mark its own post set");
    const inside = await cell({ principal: "run:fail4", inside: true });
    assert.equal(inside.w, undefined, "a failed outside cell left the inside door open");
    assert.equal((await inside.answer).notInDialect, MARKED_FIRST);
});

// --- a refused cell sets none; a killed worker is replaced, never reused marked ---

test("RED TEAM: a cell the GATE refused is not an outside cell: it marks nothing, so the next inside try is still made there", async () => {
    const refused = await cell({ principal: "run:gate5", inside: true, code: "import os", reply: { ok: false, notInDialect: "not in dialect: import 'os' (line 1)" } });
    const r = await refused.answer;
    assert.deepEqual([r.notInDialect, r.marked], ["not in dialect: import 'os' (line 1)", undefined], "the gate's refusal was rewritten as the mark's");
    const again = await cell({ principal: "run:gate5", inside: true, code: "x = 1" });
    assert.equal(again.w, refused.w, "a gate refusal marked the worker: the next inside try was refused or sent to a new worker");
    assert.equal((await again.answer).notInDialect, undefined);
});

test("RED TEAM: an outside cell that never starts is killed, and the run's next inside try goes to a NEW worker, never the marked one", async () => {
    const stuck = await cell({ principal: "run:tmo6", code: "import os", reply: null });
    assert.ok(stuck.w, "the outside cell was posted");
    // Past the start bound the document kills the worker: the 120 s it waits for a cold start (PY_START_TIMEOUT_MS).
    mock.timers.tick(120_000);
    await settle();
    const dead = await stuck.answer;
    assert.deepEqual([dead.ok, /did not start/.test(String(dead.error))], [false, true], "the stuck outside cell was not killed");
    assert.equal(stuck.w.terminated, true, "the marked worker was not terminated");
    const again = await cell({ principal: "run:tmo6", inside: true });
    assert.ok(again.w, "the run's inside try reached no worker");
    assert.notEqual(again.w, stuck.w, "the inside try went to the marked worker again");
    assert.equal((await again.answer).notInDialect, undefined);
});

// --- one marked run must not deny every later run the inside path ---

test("RED TEAM: a marked probe answer is not cached as the sandbox's verdict", () => {
    // The probe (`pythonDialectReady`) is asked once per service-worker life and its answer cached for every run. A
    // marked worker's refusal is THAT RUN's worker's, not the sandbox's: cached, every later run would ask without a try,
    // so one page's approved outside cell could cost every run the dialect's unasked path. The cache write is in the
    // service worker, out of this harness's reach (`runPython` is a static import); the field it keys on is asserted above
    // (the refusal carries `marked: true`) and the rule here.
    const src = readFileSync(new URL("../src/sw/worker-tools.ts", import.meta.url), "utf8");
    const start = src.indexOf("export function pythonDialectReady(");
    assert.ok(start > 0, "pythonDialectReady is not in worker-tools.ts: this row measures nothing");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /inside:\s*true/, "the probe is not an inside try, so the mark's refusal cannot reach it");
    assert.match(body, /marked[\s\S]{0,400}?pyDialectReady\s*=\s*null/, "a marked refusal is returned as the sandbox's verdict: one run's outside cell would make every later run ask");
});
