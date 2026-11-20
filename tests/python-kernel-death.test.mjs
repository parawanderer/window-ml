// python-kernel-death.test.mjs — the kernel's death in the real worker (ruling 26): a cell that kills Pyodide is answered
// with the fatal error, and so is every later cell, at once; an ordinary unhandled rejection, after which the interpreter
// still answers, kills nothing. The worker runs in a child process (tests/fixtures/kernel-death-driver.mjs): the dead
// interpreter's leftover work outlives anything a test can contain. Real Chromium: tests/e2e/python-kernel-death.spec.mjs.
// Self-SKIPS without dist/pyodide.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const skip = fs.existsSync(path.join(ROOT, "dist", "pyodide", "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let measured = null, cause = null;
/** The driver's one JSON line for `scenario` (the default, or "cause"): each cell's answer, in order. */
function drive(scenario) {
    return new Promise((resolve) => execFile(process.execPath, ["--import", "tsx", path.join(ROOT, "tests/fixtures/kernel-death-driver.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 170_000, maxBuffer: 64 << 20, env: { ...process.env, KD_SCENARIO: scenario } }, (err, stdout, stderr) => {
        // Pyodide prints the fatal error's traceback to stdout too, so the driver's line is found by its marker.
        const line = String(stdout).split("\n").find((l) => l.startsWith("KERNEL-DEATH-DRIVER "));
        assert.ok(line, `the driver (${scenario}) printed no result (${err?.message ?? "exit 0"}): ${String(stderr).slice(-600)}`);
        resolve(JSON.parse(line.slice("KERNEL-DEATH-DRIVER ".length)));
    }));
}

// The child processes boot Pyodide for every row below, side by side, before them: no row carries a boot.
before(async () => { if (!skip) [measured, cause] = await Promise.all([drive("default"), drive("cause")]); }, { timeout: 180000 });
const measure = () => measured;

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

// --- whose text the cause is ---

test("the cause is what Pyodide's fatal-error handler caught, never a rejection or an answer the cell chose", { skip, timeout: 180000 }, () => {
    assert.equal(cause.control.ok, true, `the control: the full worker runs a cell (${JSON.stringify(cause.control)})`);
    assert.deepEqual([cause.killed.ok, cause.killed.fatal, cause.killed.error], [false, true, "THE-HANDLER-CAUGHT-THIS"], JSON.stringify(cause.killed));
    assert.deepEqual([cause.later.fatal, cause.later.error], [true, "THE-HANDLER-CAUGHT-THIS"], JSON.stringify(cause.later));
});
