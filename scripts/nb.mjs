#!/usr/bin/env node
// nb.mjs — build the notebooks' environment and run a notebook headless, outputs written back (docs/dev/notebooks.md).
//
//   node scripts/nb.mjs setup                         the root .venv from notebooks/pyproject.toml + uv.lock
//   node scripts/nb.mjs run notebooks/bench/x.ipynb   execute in place; exit 1 if any cell raised
//   node scripts/nb.mjs make notebooks/bench/x.ipynb  run its generator (make-x.py) first, then run it
//
// Execute to a temp file and then replace, so the old outputs stay readable for the whole run; errors are allowed, so
// the traceback lands in the notebook where it shows which cell failed, and the exit status still says it failed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENV = path.join(ROOT, ".venv");
/** A cell may read a large database or run for minutes; nbconvert's default of 30 s is too short. */
const TIMEOUT_S = Number(process.env.NB_TIMEOUT || 1800);

/** Run a command in the repo root, inheriting the terminal; its exit status. */
function sh(cmd, args, env = {}) {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    return r.status ?? 1;
}

/** Whether an executed notebook holds an error output. */
export function hasError(nb) {
    return (nb.cells || []).some((c) => (c.outputs || []).some((o) => o.output_type === "error"));
}

function setup() {
    return sh("uv", ["sync", "--project", "notebooks"], { UV_PROJECT_ENVIRONMENT: VENV });
}

function run(nbPath) {
    const abs = path.resolve(nbPath);
    if (!existsSync(abs)) { console.error(`nb: no notebook at ${nbPath}`); return 2; }
    if (!existsSync(path.join(VENV, "bin", "jupyter"))) { console.error("nb: no environment yet; run `node scripts/nb.mjs setup`"); return 2; }
    const dir = path.dirname(abs), tmp = `.${path.basename(abs, ".ipynb")}.running.ipynb`;
    const status = sh(path.join(VENV, "bin", "jupyter"), ["nbconvert", "--execute", "--to", "notebook", "--allow-errors",
        `--ExecutePreprocessor.timeout=${TIMEOUT_S}`, "--ExecutePreprocessor.kernel_name=python3",
        "--output", tmp, "--output-dir", dir, abs]);
    if (status !== 0) return status;
    renameSync(path.join(dir, tmp), abs);
    if (hasError(JSON.parse(readFileSync(abs, "utf8")))) { console.error(`nb: ${nbPath} ran, and a cell raised (its traceback is in the notebook)`); return 1; }
    console.log(`nb: ${nbPath} ran clean`);
    return 0;
}

function make(nbPath) {
    const gen = path.join(path.dirname(nbPath), `make-${path.basename(nbPath, ".ipynb")}.py`);
    if (!existsSync(gen)) { console.error(`nb: no generator at ${gen}`); return 2; }
    const s = sh(path.join(VENV, "bin", "python"), [gen]);
    return s === 0 ? run(nbPath) : s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [cmd, arg] = process.argv.slice(2);
    const code = cmd === "setup" ? setup() : cmd === "run" && arg ? run(arg) : cmd === "make" && arg ? make(arg) : (console.error("usage: node scripts/nb.mjs setup | run <nb.ipynb> | make <nb.ipynb>"), 2);
    process.exit(code);
}
