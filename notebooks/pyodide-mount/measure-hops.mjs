// measure-hops.mjs — the cost of each message hop of #1780 route A (python worker, offscreen document, service worker,
// wmlhost and back), timed in a real Chromium with the built extension, a throwaway profile and a real wmlhost.
//
// Run with `npm run build && node notebooks/pyodide-mount/measure-hops.mjs [--quick]`. Writes data/hops-*.json. Nothing in
// src/ or tests/ changes: the probes are a copy of dist/ plus hops-ext/ (a page and a worker), and the service worker's
// probe listener is `evaluate`d into it. The wmlhost is registered in the test profile ONLY (tests/e2e/native-host.mjs);
// never `wmlhost install`, never the person's own profile. Output goes to the files named above and to stdout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launchExtension } from "../../tests/e2e/harness.mjs";
import { wmlhostBinary, registerNativeHost, tempProfile, tempWorkspace, NATIVE_HOST_NAME } from "../../tests/e2e/native-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const DATA = path.join(HERE, "data");
const QUICK = process.argv.includes("--quick");
/** Repeats for a latency (the brief asks for at least 20). */
const REPS = QUICK ? 5 : 30;
const MB = 1 << 20;

/** @param {string} name @param {unknown} v Write one result file under data/. */
const save = (name, v) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, name), JSON.stringify(v, null, 2) + "\n"); };

/** Median, p90, max of numbers. @param {number[]} xs */
function stats(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1], min: s[0], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

/** The probe code that runs INSIDE the service worker: a native-messaging client and two onMessage listeners. */
function installSwProbe(/** @type {{ host: string }} */ { host }) {
    const g = /** @type {any} */ (globalThis);
    if (g.__hopsHost) return "already";
    const H = (g.__hopsHost = { port: null, seq: 0, pending: new Map(), done: new Map(), waiters: new Map(), closed: null });
    H.connect = () => {
        H.port = chrome.runtime.connectNative(host);
        H.closed = null;
        H.port.onMessage.addListener((m) => {
            if (m.event === "done") { const w = H.waiters.get(m.id); if (w) { H.waiters.delete(m.id); w(m); } else H.done.set(m.id, m); return; }
            const p = H.pending.get(m.seq);
            if (p) { H.pending.delete(m.seq); p(m); }
        });
        H.port.onDisconnect.addListener(() => { H.closed = chrome.runtime.lastError?.message || "closed"; for (const p of H.pending.values()) p({ error: { code: "Disconnected", message: H.closed } }); H.pending.clear(); });
    };
    H.raw = (call, args) => new Promise((res) => { const seq = ++H.seq; H.pending.set(seq, res); H.port.postMessage({ seq, call, args }); });
    H.call = async (call, args) => { const m = await H.raw(call, args); if (m.error) throw new Error(`${call}: ${JSON.stringify(m.error)}`); return m.value; };
    H.waitDone = (id) => new Promise((res) => { const d = H.done.get(id); if (d) { H.done.delete(id); res(d); } else H.waiters.set(id, res); });
    chrome.runtime.onMessage.addListener((msg, _s, send) => {
        if (msg?.type === "__hops_sw") { send({ ok: true, n: msg.payload ? msg.payload.length : 0, reply: msg.reply ? "A".repeat(msg.reply) : "" }); return false; }
        if (msg?.type === "__hops_host") {
            H.raw(msg.call, msg.args).then((m) => send(m), (e) => send({ error: { code: "Probe", message: String(e) } }));
            return true;
        }
        return false;
    });
    return "installed";
}

/** Run inside the service worker: time `n` hello round trips, then the held-output reads. */
async function swHostRun(/** @type {{ files: Record<string,string>, root: string, helloReps: number, plan: Record<string, number> }} */ { files, root, helloReps, plan }) {
    const H = /** @type {any} */ (globalThis).__hopsHost;
    const out = { hello: null, configured: null, helloInfo: null, spawn: {}, reads: {}, ptrs: {} };
    const t = async (fn) => { const t0 = performance.now(); const v = await fn(); return [performance.now() - t0, v]; };
    if (!H.port || H.closed) H.connect();
    const helloMs = [];
    for (let i = 0; i < helloReps + 3; i++) { const [ms, v] = await t(() => H.call("hello")); if (i >= 3) helloMs.push(ms); out.helloInfo = v; }
    out.hello = helloMs;
    out.helloBatch = [];
    for (let b = 0; b < 21; b++) { const t0 = performance.now(); for (let i = 0; i < 20; i++) await H.call("hello"); if (b > 0) out.helloBatch.push((performance.now() - t0) / 20); }
    // outputCap raised so a 100 MB file is held whole; the sandbox stays on when the host has one.
    out.configured = await H.call("configure", { roots: [root], sandbox: true, outputCap: 1 << 30, timeoutMs: 300000 });
    for (const [name, file] of Object.entries(files)) {
        const [ms1, facts] = await t(() => H.call("spawn", { argv: ["/bin/cat", file], cwd: root }));
        const [ms2] = await t(() => H.call("start", { id: facts.id }));
        const done = await H.waitDone(facts.id);
        out.spawn[name] = { spawnMs: ms1, startAnswerMs: ms2, wallMs: done.durationMs, code: done.code, stdout: done.stdout, error: done.error ?? null, sandboxed: facts.sandboxed };
        out.ptrs[name] = done.stdout.ptr;
    }
    const CH = 524288;
    /** Read a whole held output sequentially (depth 1) or with `depth` reads in flight. */
    const readAll = async (ptr, depth) => {
        const t0 = performance.now();
        const chunkMs = [];
        const first = await H.call("read", { ptr, offset: 0, length: CH });
        const size = first.size;
        let got = first.length;
        const offs = []; for (let o = first.length; o < size; o += CH) offs.push(o);
        let i = 0;
        const lane = async () => { while (i < offs.length) { const o = offs[i++]; const c0 = performance.now(); const r = await H.call("read", { ptr, offset: o, length: CH }); chunkMs.push(performance.now() - c0); got += r.length; } };
        await Promise.all(Array.from({ length: depth }, lane));
        return { ms: performance.now() - t0, bytes: got, size, chunkMs };
    };
    for (const [name, reps] of Object.entries(plan)) {
        const ptr = out.ptrs[name];
        out.reads[name] = { seq: [], pipe4: [], chunkMs: [] };
        for (let r = 0; r < reps; r++) {
            const a = await readAll(ptr, 1); out.reads[name].seq.push({ ms: a.ms, bytes: a.bytes }); out.reads[name].chunkMs.push(...a.chunkMs);
            if (r < Math.min(reps, 5)) { const b = await readAll(ptr, 4); out.reads[name].pipe4.push({ ms: b.ms, bytes: b.bytes }); }
        }
    }
    return out;
}

/** Copy dist/ and add the probe page and worker, so the unchanged build can be loaded with two extra extension files. */
function probeDist() {
    const dest = path.join(os.tmpdir(), `wml-hops-dist-${process.pid}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "dist"), dest, { recursive: true });
    for (const f of fs.readdirSync(path.join(HERE, "hops-ext"))) fs.copyFileSync(path.join(HERE, "hops-ext", f), path.join(dest, f));
    return dest;
}

const bin = wmlhostBinary();
if (!bin) { console.error("no wmlhost binary (build one in a window-ml-host checkout, or set E2E_WMLHOST)"); process.exit(2); }
const machine = { cpu: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"]).toString().trim(), node: process.version, os: `${os.type()} ${os.release()}`, wmlhost: bin, quick: QUICK };
const failures = [];
/** Run one section, recording a failure with its error text instead of stopping. */
async function section(/** @type {string} */ name, /** @type {() => Promise<any>} */ fn) {
    try { const r = await fn(); console.log(`ok   ${name}`); return r; }
    catch (e) { const msg = String(e?.stack || e); failures.push({ section: name, error: msg.slice(0, 1500) }); console.log(`FAIL ${name}: ${String(e?.message || e).slice(0, 300)}`); return null; }
}

const profile = tempProfile();
const ws = tempWorkspace();
const dist = probeDist();
const sizes = { f1: 1 * MB, f16: 16 * MB, f100: 100 * MB };
for (const [k, n] of Object.entries(sizes)) fs.writeFileSync(path.join(ws, `${k}.bin`), randomBytes(n));
const ext = await launchExtension({ userDataDir: profile, dist });
let exitCode = 0;
try {
    registerNativeHost(profile, ext.extensionId, bin);
    machine.chromium = ext.context.browser()?.version?.() ?? null;
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/hops-page.html`);
    const sw = ext.context.serviceWorkers().at(-1);
    console.log("service worker probe:", await sw.evaluate(installSwProbe, { host: NATIVE_HOST_NAME }));
    machine.sabAvailable = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated);
    const size = [["1KB", 1024], ["64KB", 64 << 10], ["1MB", MB], ["8MB", 8 * MB]];

    // 1. python worker <-> extension page (stands in for the offscreen document).
    const h1 = await section("hop1 worker<->page postMessage", async () => {
        const rows = [];
        for (const kind of ["str", "ab"]) for (const [label, bytes] of size) {
            const r = await page.evaluate(([k, b, n]) => window.__h.workerRtt(k, b, n), [kind, bytes, bytes >= 8 * MB ? Math.max(20, REPS - 10) : REPS]);
            rows.push({ kind, label, ...r });
        }
        return rows;
    });
    const sb = await section("small round trips, batched", async () => ({
        worker: await page.evaluate(([n, b]) => window.__h.smallBatch("worker", n, b), [20, QUICK ? 5 : 25]),
        sw: await page.evaluate(([n, b]) => window.__h.smallBatch("sw", n, b), [20, QUICK ? 5 : 25]),
    }));
    if (sb) save("hops-small-batched.json", { machine, note: "mean per round trip of 20 back-to-back round trips (one sample alone is quantised to 0.1 ms)", ...sb });
    if (h1) save("hops-worker-page.json", { machine, note: "round trip page->worker->page of the same payload both ways; extension page, not the offscreen document", rows: h1 });
    const hw = await section("hop1 SAB wake", () => page.evaluate(([b, n]) => window.__h.wake(b, n), [QUICK ? 5 : 30, 200]));
    if (hw) save("hops-wake.json", { machine, ...hw });

    // 2. page <-> service worker.
    const h2 = await section("hop2 page<->service worker sendMessage", async () => {
        const rows = [];
        for (const dir of ["small", "up", "down"]) for (const [label, bytes] of dir === "small" ? [["tiny", 0]] : size) {
            const r = await page.evaluate(([d, b, n]) => window.__h.swRtt(d, b, n), [dir, bytes, bytes >= 8 * MB ? Math.max(20, REPS - 10) : REPS]);
            rows.push({ label, ...r });
        }
        return rows;
    });
    if (h2) save("hops-page-sw.json", { machine, note: "chrome.runtime.sendMessage to a probe listener evaluated into the service worker; up = payload in request, down = payload in reply; base64 characters", rows: h2 });

    // 3. service worker <-> wmlhost.
    const files = Object.fromEntries(Object.keys(sizes).map((k) => [k, path.join(ws, `${k}.bin`)]));
    const h3 = await section("hop3 service worker<->wmlhost", () => sw.evaluate(swHostRun, { files, root: ws, helloReps: REPS, plan: { f1: REPS, f16: QUICK ? 2 : 8, f100: QUICK ? 1 : 4 } }));
    let ptrs = null;
    if (h3) {
        ptrs = h3.ptrs;
        save("hops-sw-host.json", { machine, helloInfo: h3.helloInfo, configured: h3.configured, hello: { ...stats(h3.hello), samples: h3.hello }, helloBatched: { n: 20, ...stats(h3.helloBatch), samples: h3.helloBatch },
            spawn: h3.spawn,
            reads: Object.fromEntries(Object.entries(h3.reads).map(([k, v]) => [k, {
                fileBytes: sizes[k], chunk: 524288,
                seqMBps: stats(v.seq.map((x) => (x.bytes / MB) / (x.ms / 1000))), seqMs: stats(v.seq.map((x) => x.ms)),
                pipe4MBps: v.pipe4.length ? stats(v.pipe4.map((x) => (x.bytes / MB) / (x.ms / 1000))) : null,
                perChunkMs: stats(v.chunkMs), bytesOk: v.seq.every((x) => x.bytes === sizes[k]),
            }])) });
    }

    // 4. the whole chain: the worker blocks on a SAB while the page relays through the service worker to the host.
    const ch = await section("chain worker->page->sw->host and back", async () => {
        const hello = await page.evaluate((n) => window.__h.chainHello(n), REPS);
        const helloBatched = await page.evaluate(([n, b]) => window.__h.chainHelloBatch(n, b), [20, QUICK ? 5 : 25]);
        const files = {};
        if (ptrs) for (const [k, reps] of [["f1", REPS], ["f16", QUICK ? 2 : 6], ["f100", QUICK ? 1 : 3]]) {
            const runs = [];
            for (let r = 0; r < reps; r++) runs.push(await page.evaluate(([p, c]) => window.__h.chainFile(p, c), [ptrs[k], 524288]));
            files[k] = { fileBytes: sizes[k], ms: stats(runs.map((x) => x.ms)), MBps: stats(runs.map((x) => (x.bytes / MB) / (x.ms / 1000))), bytesOk: runs.every((x) => x.bytes === sizes[k]),
                perChunkRpcMs: stats(runs.flatMap((x) => x.chunkMs.map((c) => c.rpc))), perChunkDecodeMs: stats(runs.flatMap((x) => x.chunkMs.map((c) => c.decode))) };
        }
        return { hello, helloBatched, files };
    });
    if (ch) save("hops-chain.json", { machine, note: "worker posts a request and blocks on Atomics.wait in 50 ms slices; page relays with sendMessage; service worker relays to wmlhost; reply is written into the SAB as JSON; files are read in 512 KiB chunks one at a time, base64 decoded in the worker", ...ch });
} finally {
    save("hops-failures.json", { machine, failures });
    await ext.close();
    for (const d of [profile, ws, dist]) fs.rmSync(d, { recursive: true, force: true });
}
if (failures.length) { console.log(JSON.stringify(failures, null, 1)); exitCode = 1; }
process.exit(exitCode);
