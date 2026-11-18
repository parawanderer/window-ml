// redteam-python-kernel-death.test.mjs — the ADVERSARIAL half of ruling 26 (window-ml#1976, branch
// feat/py-fatal-listener at b9e0d06a): a Python cell must not be able to choose, fake or word the verdict that the
// kernel died, and a run's death must reach no other run's namespace. Two levels, because they answer different
// questions:
//
// - The real worker (tests/fixtures/kernel-death-redteam-driver.mjs, a child process, real Pyodide; self-SKIPS without
//   dist/pyodide) for whether the verdict is Pyodide's: a cell patches what the probe reads, installs `sys.settrace`,
//   and injects the verdict's own words; the real death (a wasm trap) must still be answered, with a cause the cell did
//   not write. The lane's own driver (tests/fixtures/kernel-death-driver.mjs) is the stack-overflow case; this one is a
//   different death, and the shape of the cause is the point.
// - The offscreen document (src/offscreen.ts under a fake `chrome` and Worker, no Pyodide) for the blast radius: a kill
//   for reason `kernel-death` touches the dying principal's runs and no other run's.
//
// The one row marked `todo` is a gap, not a fail: `kernelDied(cause)` interpolates the worker's error verbatim, and the
// answered-cell paths in python-worker.ts (`fatal = String(result.error)`) do not cut it to a line as `onUncaught` does,
// so a death whose error carries a traceback puts a multi-line, cell-source-bearing text in front of the model.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// --- the real worker in a child process ---

const ROOT = path.resolve(import.meta.dirname, "..");
const skip = fs.existsSync(path.join(ROOT, "dist", "pyodide", "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let measured = null;
function measure() {
    if (measured) return measured;
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "tests/fixtures/kernel-death-redteam-driver.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 170_000 });
    // Pyodide prints a fatal error's traceback to stdout too, so the line is found by its marker.
    const line = r.stdout.split("\n").find((l) => l.startsWith("KERNEL-DEATH-REDTEAM "));
    assert.ok(line, `the driver printed no result (exit ${r.status}): ${r.stderr.slice(-600)}`);
    measured = JSON.parse(line.slice("KERNEL-DEATH-REDTEAM ".length));
    return measured;
}
before(() => { if (!skip) measure(); }, { timeout: 180000 });

test("the verdict's own WORDS kill nothing: a rejection and a print carrying them leave the interpreter answering", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.deepEqual([m.control.ok, m.control.stdout], [true, "ALIVE\n"], "the control: the worker runs a cell");
    assert.deepEqual([m.afterVerdictText.ok, m.afterVerdictText.stdout], [true, "STILL\n"], `a rejection of "PythonError: already fatally failed" declared a death (${JSON.stringify(m.afterVerdictText)})`);
    assert.deepEqual([m.prints.ok, m.prints.stdout], [true, "already fatally failed\n"], "printing the words declared a death");
});

test("a cell's PATCH of the object the probe calls sticks and changes nothing: the real death is still its verdict", { skip, timeout: 180000 }, () => {
    const m = measure();
    // The control the row needs: the patch really was applied from Python, so the row is not vacuous.
    assert.match(m.reach.stdout, /\[\['module-runPython', True\], \['patched', True\]/, `the cell could not patch pyodide_js.runPython, so this row measures nothing (${m.reach.stdout})`);
    assert.deepEqual([m.trap.ok, m.trap.fatal], [false, true], `after the patch, a real wasm trap was not answered as the kernel's death (${JSON.stringify(m.trap)})`);
});

test("sys.settrace does not carry to the probe: a failing cell after it answers with its own error, not a death", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.equal(m.settrace.ok, false, "the control: the trace function fired in the cell that installed it");
    assert.match(String(m.settrace.error), /SPOOFED-BY-CELL/, "the control: the cell's own text is what the trace raised");
    assert.deepEqual([m.tracedAlive.ok, m.tracedAlive.stdout], [true, "STILL-ALIVE\n"], "the trace survived into a later cell");
    assert.deepEqual([m.tracedFail.ok, m.tracedFail.fatal], [false, undefined], `a cell that raised after installing the trace was answered as a kernel death (${JSON.stringify(m.tracedFail)})`);
    assert.match(String(m.tracedFail.error), /ValueError: an ordinary failure after the trace was set\n$/, "the answer is the cell's own error, and its last line is the cell's");
    assert.deepEqual([m.tracedLater.ok, m.tracedLater.stdout], [true, "LATER-AFTER-SPOOF\n"], "the spoof attempt left the interpreter dead");
});

test("the real death's cause is Pyodide's, one line and bounded, and every later cell gets it at once", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.equal(m.trap.fatal, true, JSON.stringify(m.trap));
    assert.match(m.trap.error, /function signature mismatch/, `the cause is not the trap's own error (${JSON.stringify(m.trap)})`);
    assert.equal(m.trap.errorLines, 1, `the cause carried ${m.trap.errorLines} lines`);
    assert.ok(m.trap.errorLen <= 300, `the cause is ${m.trap.errorLen} chars`);
    assert.deepEqual([m.trapLater.ok, m.trapLater.fatal], [false, true], JSON.stringify(m.trapLater));
    assert.ok(m.trapLaterMs < 1000, `answered in ${m.trapLaterMs} ms`);
});

// --- the offscreen document: a death reaches no other run ---

const listeners = [];
const sentToWorker = [];
const workers = [];
class FakeWorker {
    constructor(url, opts) { this.url = url; this.name = opts?.name; this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
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

const send = (msg, sender = { id: "test" }) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastPost = (w) => w.posts.at(-1);
/** Start a PY_RUN and answer it from the fake worker; `reply` is what the worker says back. */
async function runCell(msg, reply) {
    const before = workers.length;
    const posted = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: true, tables: null, ...msg });
    await tick();
    const w = workers.find((x) => x.posts.length > (posted.get(x) ?? 0));
    const post = lastPost(w);
    assert.ok(post && typeof post.id === "number", "the cell reached a worker");
    w.reply({ id: post.id, ok: true, stdout: "", ...reply });
    return { answer: await answer, w, post, spawned: workers.length - before };
}
const bench = (names) => ({ bench: { id: "run-x", vars: names.map((name) => ({ name, type: "int" })) } });
// The shape the offscreen document's own fixture (tests/python-lease-offscreen.test.mjs, TRAP_TRACEBACK) gives a fatal
// Pyodide answer: a Python traceback, whose middle line is the CELL's source line.
const TRAP_TRACEBACK = "PythonError: Traceback (most recent call last):\n  File \"<exec>\", line 1, in <module>\n    import PIL._imagingtk\nRuntimeError: function signature mismatch";

test("RED TEAM: a run's kernel death resets that run only; another run's cell keeps its worker and gets no line", async () => {
    const a1 = await runCell({ principal: "run:kd-a", wire: { client: "rt-a1", run: "kd-a" } }, bench(["x"]));
    const b1 = await runCell({ principal: "run:kd-b", wire: { client: "rt-b1", run: "kd-b" } }, bench(["y"]));
    const died = await runCell({ principal: "run:kd-a", wire: { client: "rt-a2", run: "kd-a" } }, { ok: false, stdout: "", error: "Maximum call stack size exceeded", fatal: true });
    assert.match(String(died.answer.error), /^The Python interpreter crashed \(Maximum call stack size exceeded\)/, JSON.stringify(died.answer));
    assert.ok(died.w.terminated, "the dead worker was not ended");
    const b2 = await runCell({ principal: "run:kd-b", wire: { client: "rt-b2", run: "kd-b" } }, bench(["y"]));
    assert.equal(b2.w, b1.w, "the other run's cell was moved to another worker");
    assert.equal(b2.spawned, 0, "the other run's worker was replaced");
    assert.ok(!("nsReset" in b2.answer), `another run's cell was told its namespace went (${JSON.stringify(b2.answer)})`);
    assert.equal(b2.answer.ok, true, "the control: that cell ran");
    const a2 = await runCell({ principal: "run:kd-a", wire: { client: "rt-a3", run: "kd-a" } }, bench(["x"]));
    assert.equal(a2.spawned, 1, "the dying run did not start a fresh worker");
    assert.match(String(a2.answer.stdout), /^namespace reset at .*: the interpreter crashed$/, `the dying run's next cell was not told (${JSON.stringify(a2.answer)})`);
    assert.equal(a1.w, died.w, "the control: the run's cells shared one worker");
});

test("RED TEAM: a death on the shared full-mode worker is the whole principal's, and no other principal's", async () => {
    const f1 = await runCell({ hardened: false, principal: "full", wire: { client: "rt-f1", run: "kd-f1" } }, bench(["x"]));
    const f2 = await runCell({ hardened: false, principal: "full", wire: { client: "rt-f2", run: "kd-f2" } }, bench(["y"]));
    assert.equal(f1.w, f2.w, "the control: full-mode runs share one worker");
    const own = await runCell({ principal: "run:kd-c", wire: { client: "rt-c1", run: "kd-c" } }, bench(["z"]));
    await runCell({ hardened: false, principal: "full", wire: { client: "rt-f3", run: "kd-f1" } }, { ok: false, stdout: "", error: "Maximum call stack size exceeded", fatal: true });
    // Both full-mode runs lost the one dict: each is told on its next cell.
    for (const run of ["kd-f1", "kd-f2"]) {
        const next = await runCell({ hardened: false, principal: "full", wire: { client: `rt-f4-${run}`, run } }, bench(["x"]));
        assert.match(String(next.answer.stdout), /^namespace reset at .*: the interpreter crashed$/, `${run} was not told its namespace went (${JSON.stringify(next.answer)})`);
    }
    const control = await runCell({ principal: "run:kd-c", wire: { client: "rt-c2", run: "kd-c" } }, bench(["z"]));
    assert.equal(control.w, own.w, "another principal's worker was replaced by a death on the full one");
    assert.ok(!("nsReset" in control.answer), "another principal's cell was told its namespace went");
});

test("RED TEAM: the model-facing cause is one line, whatever the worker's error text was", { todo: "kernelDied interpolates the worker's error verbatim, and python-worker.ts's answered-cell paths do not cut it to a line as onUncaught does" }, async () => {
    const died = await runCell({ principal: "run:kd-shape", wire: { client: "rt-s1", run: "kd-shape" } }, { ok: false, stdout: "", error: TRAP_TRACEBACK, fatal: true });
    const cause = String(died.answer.error);
    assert.equal(cause.split("\n").length, 1, `the model is told ${cause.split("\n").length} lines, the cell's source among them: ${JSON.stringify(cause.slice(0, 240))}`);
    assert.ok(!cause.includes("import PIL._imagingtk"), "the cell's own line rides in the answer");
});
