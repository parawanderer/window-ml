// python-bench-stop.test.mjs — a bench Stop in the real core: the interrupt buffer ends a script, and a stop that did not land never reaches the next one.
//
// The real python-worker.ts under a fake `self` (name "readonly") and the real Pyodide in Node (`dist/pyodide/`,
// self-SKIPS without it), as python-worker-bridges.test.mjs runs it. The buffer is posted first, as the offscreen
// document posts it (offscreen.ts `ensureWorker`), and the stop is written from a SECOND THREAD, since a running script
// holds this one: that is where the offscreen document stands to the worker. Which run a stop may reach, and the kill
// when it is not answered, are the offscreen document's (python-bench-stop-offscreen.test.mjs). Its own file because
// `lockdown()` is once per realm.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const DIST = path.resolve(import.meta.dirname, "../dist");
const hasPyodide = fs.existsSync(path.join(DIST, "pyodide", "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let shim = null;
const posted = [];
let handler = null;
let nextId = 1;
const flag = new Int32Array(new SharedArrayBuffer(4));

before(async () => {
    if (!hasPyodide) return;
    // Pyodide in Node wants a filesystem path where the worker hands it a URL (python-worker-bridges.test.mjs).
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-stop-"));
    fs.mkdirSync(path.join(shim, "pyodide"));
    fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
        `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        postMessage: (m) => { posted.push(m); },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
    handler({ data: { interruptBuffer: flag } });
}, { timeout: 180000 });

after(() => { if (shim) fs.rmSync(shim, { recursive: true, force: true }); });

/** Post one bench script the way the offscreen document does and wait for the worker's answer to it. */
async function cell(code) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, persist: true } });
    for (let i = 0; i < 6000; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no answer for cell " + id);
}

/** Write a stop into the buffer from another thread after `ms`, as a Stop does while this thread runs Python. */
function stopAfter(ms) {
    const w = new Worker("const { workerData } = require('node:worker_threads'); const a = new Int32Array(workerData.sab); setTimeout(() => Atomics.store(a, 0, 2), workerData.ms);",
        { eval: true, workerData: { sab: flag.buffer, ms } });
    return () => w.terminate();
}

const text = (r) => `${r.error ?? ""}${r.stdout ?? ""}`;
const vars = (r) => (r.bench?.vars ?? []).map((v) => v.name);

// --- a stop ends the script, and the kept variables survive ---

test("a stop written while a Python loop runs ends it with KeyboardInterrupt, and the bench's variables are kept", { skip, timeout: 180000 }, async () => {
    assert.match(text(await cell("kept_before = 41\nprint('SET')")), /SET/, "positive control: the bench runs");
    const done = stopAfter(300);
    const t0 = Date.now();
    const r = await cell("while True:\n    pass");
    done();
    assert.match(text(r), /KeyboardInterrupt/, JSON.stringify(r).slice(0, 400));
    assert.ok(Date.now() - t0 < 10000, "the loop ended on the stop, not on anything slower");
    assert.ok(vars(r).includes("kept_before"), `the kept namespace is listed: ${vars(r)}`);
    assert.match(text(await cell("print(kept_before + 1)")), /42/, "and the next script reads it");
    assert.equal(Atomics.load(flag, 0), 0, "the buffer is clear once the run ends");
});

// --- clear before run: a stop that did not land does not interrupt the next script ---

test("a stop left pending between scripts does not interrupt the next one, which runs to its end", { skip, timeout: 180000 }, async () => {
    // Where a stop lands after the script's last bytecode (a C call that returned as the run ended): nothing read it.
    Atomics.store(flag, 0, 2);
    const r = await cell("total = sum(range(1000))\nprint('RAN-TO-END', total)");
    assert.match(text(r), /RAN-TO-END 499500/, JSON.stringify(r).slice(0, 400));
    assert.doesNotMatch(text(r), /KeyboardInterrupt/);
});

test("a stop written while a C call runs ends that script, never the next one", { skip, timeout: 180000 }, async () => {
    // `sum(range(…))` is one C call: the stop waits for it to return, and fires at the next bytecode, in this script.
    const done = stopAfter(100);
    const r = await cell("big = sum(range(60_000_000))\nprint('AFTER-C')");
    done();
    assert.doesNotMatch(text(r), /AFTER-C/, `positive control: the stop fired in this script: ${text(r).slice(0, 300)}`);
    assert.match(text(r), /KeyboardInterrupt/);
    const next = await cell("print('NEXT-RAN')");
    assert.match(text(next), /NEXT-RAN/, JSON.stringify(next).slice(0, 400));
    assert.doesNotMatch(text(next), /KeyboardInterrupt/);
});
