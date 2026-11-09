// sandbox.mjs — asks whether an npm package's main entry bundles for the browser WITHOUT Node polyfills (esbuild,
// platform "browser", no plugins, no externals) and whether the bundle then evaluates inside a real Chromium Web Worker
// (no Node built-ins, no DOM), the stand-in for a sandboxed JS runtime in the extension. One JSON line per package.
//
//     node notebooks/js-packages/sandbox.mjs --top 100 [--out file.jsonl] [--jobs 6]
//     node notebooks/js-packages/sandbox.mjs names.json [--out file.jsonl]    # a JSON array of names, or of {rank, name}
//     … --shims                                  define `global` and `process.env.NODE_ENV`, nothing else
//
// Installs run with --ignore-scripts (untrusted code never executes in Node; it only runs inside the worker). Steps
// install + bundle run `--jobs` at a time and each package dir is deleted after its bundle step; evaluation runs one
// bundle at a time in a single headless browser. The cache dir is NPMPKG_CACHE, as in npm.py; the ranking is
// npm.py's `top_packages` (npm-high-impact). Run from the repo root.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import { spawn, spawnSync } from "node:child_process";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const CACHE = process.env.NPMPKG_CACHE || path.join(os.tmpdir(), "window-ml-npm-cache");
const EVAL_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 180_000;

const esbuild = await import(path.join(ROOT, "node_modules/esbuild/lib/main.js"));
const { chromium } = await import(path.join(ROOT, "node_modules/playwright/index.mjs"));

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));

// --- args ---

function parseArgs(argv) {
    const o = { jobs: 6, out: null, top: null, file: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--top") o.top = Number(argv[++i]);
        else if (a === "--jobs") o.jobs = Number(argv[++i]);
        else if (a === "--out") o.out = argv[++i];
        else if (a === "--shims") o.shims = true;
        else if (!a.startsWith("--")) o.file = a;
        else throw new Error(`unknown flag ${a}`);
    }
    if (!o.top && !o.file) throw new Error("usage: sandbox.mjs <names.json|--top N> [--out file.jsonl] [--jobs 6]");
    return o;
}

/** The ranked names: `--top N` asks npm.py's top_packages; a file is a JSON array of names or {rank, name}. */
function loadNames(o) {
    if (o.file) {
        const arr = JSON.parse(fs.readFileSync(o.file, "utf8"));
        return arr.map((x, i) => (typeof x === "string" ? { rank: i + 1, name: x } : { rank: x.rank ?? i + 1, name: x.name }));
    }
    const code = "import json,sys;from npm import top_packages;print(json.dumps(top_packages(int(sys.argv[1]))[1]))";
    const r = spawnSync("python3", ["-c", code, String(o.top)], { cwd: HERE, encoding: "utf8", env: { ...process.env, NPMPKG_CACHE: CACHE } });
    if (r.status !== 0) throw new Error("npm.py top_packages failed: " + r.stderr.slice(-500));
    return JSON.parse(r.stdout.trim().split("\n").pop());
}

// --- steps 1-2: install and bundle ---

function run(cmd, args, opts) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
        p.stdout.resume();
        const t = setTimeout(() => p.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
        p.on("close", (code, signal) => { clearTimeout(t); resolve({ code, signal, err }); });
        p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, err: String(e) }); });
    });
}

/** Count directories under node_modules that hold a package.json (scoped dirs descended). */
function countInstalled(nm) {
    let n = 0;
    const walk = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (!e.isDirectory() || e.name === ".bin") continue;
            const d = path.join(dir, e.name);
            if (fs.existsSync(path.join(d, "package.json"))) n++;
            if (e.name.startsWith("@") && !fs.existsSync(path.join(d, "package.json"))) walk(d, depth);
            else if (depth < 8) walk(path.join(d, "node_modules"), depth + 1);
        }
    };
    walk(nm, 0);
    return n;
}

/** Classify one esbuild error: a Node built-in that did not resolve, another unresolved import, a parse error. */
function classify(text) {
    const m = /Could not resolve "([^"]+)"/.exec(text);
    if (m) {
        const spec = m[1];
        const bare = spec.replace(/^node:/, "").split("/")[0];
        return { kind: spec.startsWith("node:") || BUILTINS.has(bare) ? "node-builtin" : "unresolved", text: spec };
    }
    if (/Expected|Unexpected|Syntax error|Invalid|Unterminated|Transforming|parse/i.test(text)) return { kind: "parse", text: text.slice(0, 300) };
    return { kind: "other", text: text.slice(0, 300) };
}

async function installAndBundle(item) {
    const row = { rank: item.rank, name: item.name, version: null, install_s: null, n_installed: null, stage: "install",
        bundle_errors: [], bundle_bytes: null, eval_error: null, eval_ms: null };
    const dir = fs.mkdtempSync(path.join(CACHE, "sandbox-"));
    let code = null;
    try {
        fs.writeFileSync(path.join(dir, "package.json"), '{"name":"probe","version":"0.0.0","private":true}');
        const t0 = Date.now();
        const r = await run("npm", ["install", `${item.name}@latest`, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev",
            "--no-package-lock", "--prefix", dir], { cwd: dir });
        row.install_s = +((Date.now() - t0) / 1000).toFixed(2);
        if (r.signal) { row.bundle_errors = [{ kind: "timeout", text: `npm install killed (${r.signal}) after ${INSTALL_TIMEOUT_MS / 1000} s` }]; return { row }; }
        if (r.code !== 0) { row.bundle_errors = [{ kind: "install", text: r.err.slice(-300) }]; return { row }; }
        const nm = path.join(dir, "node_modules");
        row.n_installed = countInstalled(nm);
        try { row.version = JSON.parse(fs.readFileSync(path.join(nm, item.name, "package.json"), "utf8")).version; } catch {}
        row.stage = "bundle";
        fs.writeFileSync(path.join(dir, "entry.mjs"),
            `import * as m from ${JSON.stringify(item.name)}; globalThis.__probe = Object.keys(m).length;\n`);
        try {
            const res = await esbuild.build({ entryPoints: [path.join(dir, "entry.mjs")], bundle: true, platform: "browser",
                format: "esm", write: false, logLevel: "silent", absWorkingDir: dir, conditions: ["browser", "worker", "import", "default"],
                ...(opts.shims ? { define: SHIMS } : {}) });
            code = res.outputFiles[0].text;
            row.bundle_bytes = Buffer.byteLength(code);
        } catch (e) {
            const errs = e.errors?.length ? e.errors.map((x) => x.text) : [String(e.message || e)];
            row.bundle_errors = errs.slice(0, 50).map(classify);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return { row, code };
}

// --- step 3: evaluate in a Worker ---

/** Run one bundle in a module Worker made from a Blob URL; resolves {ok, keys|error, ms}. */
async function evalInWorker(page, code) {
    return page.evaluate(({ code, timeout }) => new Promise((resolve) => {
        const src = code + "\n;postMessage({ok:true, keys: globalThis.__probe})";
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        const t0 = performance.now();
        let w;
        const done = (r) => { clearTimeout(timer); try { w.terminate(); } catch {} URL.revokeObjectURL(url); resolve({ ...r, ms: Math.round(performance.now() - t0) }); };
        const timer = setTimeout(() => done({ ok: false, error: "timeout" }), timeout);
        try { w = new Worker(url, { type: "module" }); } catch (e) { return done({ ok: false, error: String(e) }); }
        w.onmessage = (ev) => done(ev.data);
        w.onerror = (ev) => { ev.preventDefault?.(); done({ ok: false, error: ev.message || "worker error (no message)" }); };
        w.onmessageerror = () => done({ ok: false, error: "messageerror" });
    }), { code, timeout: EVAL_TIMEOUT_MS });
}

// --- main ---

// `--shims`: the two names a runtime can define for nothing, without polyfilling any Node module: `global` (an alias
// of globalThis) and `process.env.NODE_ENV` (the build-time constant bundlers set). Everything else stays absent.
const SHIMS = { global: "globalThis", "process.env.NODE_ENV": '"production"' };
const opts = parseArgs(process.argv.slice(2));
fs.mkdirSync(CACHE, { recursive: true });
const names = loadNames(opts);
const out = opts.out ? fs.createWriteStream(opts.out) : null;
const emit = (row) => { const line = JSON.stringify(row); console.log(line); out?.write(line + "\n"); };

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
// A module Worker cannot start from a blob: URL made on about:blank (opaque origin, "blob:null/…": the load fails with
// no message), so the page is a routed, empty document on a fake https origin. Nothing is fetched from it.
await page.route("https://probe.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
await page.goto("https://probe.invalid/");

// Stage 1: a pool of `jobs` install+bundle workers feeding a queue the single evaluator drains in order.
const ready = [];
let waiter = null;
let finished = 0;
let next = 0;
const push = (r) => { ready.push(r); waiter?.(); };
const timing = { install_bundle_s: 0, eval_s: 0 };
const T0 = Date.now();
const worker = async () => {
    while (next < names.length) {
        const item = names[next++];
        let r;
        try { r = await installAndBundle(item); }
        catch (e) { r = { row: { rank: item.rank, name: item.name, stage: "install", bundle_errors: [{ kind: "install", text: String(e).slice(0, 300) }] } }; }
        push(r);
    }
};
const pool = Promise.all(Array.from({ length: Math.max(1, opts.jobs) }, worker));

const results = [];
while (finished < names.length) {
    if (!ready.length) { await new Promise((res) => { waiter = res; }); waiter = null; continue; }
    const { row, code } = ready.shift();
    finished++;
    if (code != null) {
        const t = Date.now();
        const ev = await evalInWorker(page, code);
        timing.eval_s += (Date.now() - t) / 1000;
        row.eval_ms = ev.ms;
        if (ev.ok) row.stage = "ok"; else { row.stage = "eval"; row.eval_error = String(ev.error).slice(0, 300); }
    }
    results.push(row);
    emit(row);
}
await pool;
await browser.close();
out?.end();
timing.total_s = +((Date.now() - T0) / 1000).toFixed(1);
console.error(JSON.stringify({ summary: { n: results.length, total_s: timing.total_s, eval_s: +timing.eval_s.toFixed(1),
    install_s_sum: +results.reduce((a, r) => a + (r.install_s || 0), 0).toFixed(1), jobs: opts.jobs } }));
