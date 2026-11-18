// python-kernel-death.test.mjs — the kernel's death in the real worker (ruling 26): a cell that kills Pyodide is answered
// with the fatal error, and so is every later cell, at once; an ordinary unhandled rejection, after which the interpreter
// still answers, kills nothing. The worker runs in a child process (tests/fixtures/kernel-death-driver.mjs): the dead
// interpreter's leftover work outlives anything a test can contain. Real Chromium: tests/e2e/python-kernel-death.spec.mjs.
// Self-SKIPS without dist/pyodide.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const skip = fs.existsSync(path.join(ROOT, "dist", "pyodide", "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let measured = null;
/** The driver's one JSON line: each cell's answer, in order. */
function measure() {
    if (measured) return measured;
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "tests/fixtures/kernel-death-driver.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 170_000 });
    // Pyodide prints the fatal error's traceback to stdout too, so the driver's line is found by its marker.
    const line = r.stdout.split("\n").find((l) => l.startsWith("KERNEL-DEATH-DRIVER "));
    assert.ok(line, `the driver printed no result (exit ${r.status}): ${r.stderr.slice(-600)}`);
    measured = JSON.parse(line.slice("KERNEL-DEATH-DRIVER ".length));
    return measured;
}

// The one child process boots Pyodide for every row below: measured once, before them, so no row carries the boot.
before(() => { if (!skip) measure(); }, { timeout: 180000 });

// --- what kills the kernel, and what does not ---

test("an ordinary unhandled rejection, between cells or during one, kills nothing: the interpreter still answers", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.equal(m.control.ok, true, `the control: the worker runs a cell (${JSON.stringify(m.control)})`);
    assert.equal(m.listeners.unhandledrejection, true, "the control: the worker listens for unhandled rejections");
    assert.deepEqual(m.afterOrdinary, { ok: true, error: "", stdout: "STILL\n" }, "the cell after a rejection between cells runs");
    assert.deepEqual(m.during, { ok: true, error: "", stdout: "DURING\n" }, "the cell a rejection landed in finishes");
});

test("a cell that kills Pyodide is answered with the fatal error as the kernel's death", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.notEqual(m.killed, "no answer", "the cell answered");
    assert.equal(m.killed.fatal, true, JSON.stringify(m.killed));
    assert.match(m.killed.error, /Maximum call stack size exceeded/);
});

test("every cell after the kernel's death is answered with it at once, never queued behind the dead cell", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.notEqual(m.later, "no answer", "the later cell answered");
    assert.deepEqual([m.later.ok, m.later.fatal], [false, true], JSON.stringify(m.later));
    assert.ok(m.laterMs < 1000, `answered in ${m.laterMs} ms`);
});
