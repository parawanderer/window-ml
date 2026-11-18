// pkg-install-fatal-worker.test.mjs — what a package that kills Pyodide at import leaves of the worker, in the real worker.
// Measured: the cell NEVER ANSWERS. The fatal RangeError (a call chain too deep for the compiler) escapes as an unhandled
// rejection, which a browser Worker does not report as `onerror`, so the offscreen document hears nothing; an install's
// candidate is ended by its deadline (offscreen.ts installTest, rows in tests/pkg-install-offscreen.test.mjs), a run's
// own cell by its timeout. The answer the offscreen rows and python-lease-offscreen's kernel-death todo rows expect,
// the fatal error AS the cell's answer, is the todo row here. The worker runs in a child process
// (tests/fixtures/fatal-worker-driver.mjs): the dead interpreter's leftover work outlives anything a test can contain.
// Self-SKIPS without dist/pyodide.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const skip = fs.existsSync(path.join(ROOT, "dist", "pyodide", "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let measured = null;
/** The driver's one JSON line: the control cell, the killing import's answer, and where the fatal error went. */
function measure() {
    if (measured) return measured;
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "tests/fixtures/fatal-worker-driver.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 170_000 });
    // Pyodide prints the fatal error's traceback to stdout too, so the driver's line is found by its marker.
    const line = r.stdout.split("\n").find((l) => l.startsWith("FATAL-WORKER-DRIVER "));
    assert.ok(line, `the driver printed no result (exit ${r.status}): ${r.stderr.slice(-600)}`);
    measured = JSON.parse(line.slice("FATAL-WORKER-DRIVER ".length));
    return measured;
}

// --- a package that kills the interpreter at import ---

test("an import that kills Pyodide never answers: the fatal error escapes as an unhandled rejection", { skip, timeout: 180000 }, () => {
    const m = measure();
    assert.equal(m.control.ok, true, `the control: the worker runs a cell (${JSON.stringify(m.control)})`);
    assert.equal(m.killed, "no answer", `the cell answered: ${JSON.stringify(m.killed).slice(0, 300)}`);
    assert.ok(m.rejections.some((e) => /Maximum call stack size exceeded/.test(e)), `the fatal error went to an unhandled rejection: ${JSON.stringify(m)}`);
});

test("an import that kills Pyodide answers with the fatal error", { skip, timeout: 180000, todo: "Pyodide loses a fatal error raised in a cell; the worker should answer it (async/kernel-death)" }, () => {
    const m = measure();
    assert.notEqual(m.killed, "no answer");
    assert.equal(m.killed.ok, false);
    assert.match(String(m.killed.error), /Maximum call stack size exceeded|fatal/i);
});
