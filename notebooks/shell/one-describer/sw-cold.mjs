// sw-cold.mjs — measures, in a real Chromium, a cold MV3 service-worker wake that compiles the describer wasm and makes its first call.
//
// Variants (a probe is PREPENDED to a copy of the built background.js):
//   control  the probe with no wasm (the extension's own startup)
//   a-z a-s  shape (a): describe.wasm shipped in the folder, compileStreaming(fetch(getURL)) started at the top of the script
//   b-z b-s  shape (b): the bytes are a base64 literal, new WebAssembly.Module/Instance run synchronously at the top
// Each variant runs in LAUNCHES fresh profiles; each launch does WAKES cold wakes (CDP ServiceWorker.stopAllWorkers, then a runtime message
// from an extension page). Programs alternate rmdir/gh per wake, and the starting program alternates per launch, so wake 0 is rmdir in one
// launch and gh in the other. Launch rounds are interleaved across variants (round 1 of every variant, then round 2) to spread drift.
//
// Not a test: run it through the queue as a batch job:
//   node scripts/test-slot.mjs run --kind batch -- node notebooks/shell/one-describer/sw-cold.mjs
// Smoke: node notebooks/shell/one-describer/sw-cold.mjs --variants control,b-z --wakes 3 --launches 1 --out <file>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DIR, TS, OUT, manifests, calls, WASM } from "./lib.mjs";

const { launchExtension } = await import(`${TS}/tests/e2e/harness.mjs`);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const VARIANTS = arg("variants", "control,a-z,a-s,b-z,b-s").split(",");
const WAKES = Number(arg("wakes", 35));
const LAUNCHES = Number(arg("launches", 2));
const OUTFILE = arg("out", path.join(OUT, "sw-cold.json"));
const WORK = arg("work", path.join(OUT, "sw-cold-work")); // the built extension and its variant copies (out/ is gitignored)
const BASE = path.join(WORK, "base");
const PROGRAMS = ["rmdir", "gh"];

/** the first described row of a program's fixture: the argv of the first call */
function firstCall(program) {
    const row = calls[program].calls.find((c) => c.described === true);
    return { program, argv: row.argv, version: calls[program].version };
}
const REQ = Object.fromEntries(PROGRAMS.map((p) => [p, { ...firstCall(p), manifest: manifests[p] }]));

/** the probe source for one variant */
function probeSource(variant, wasmB64) {
    const shape = variant === "control" ? "control" : variant[0];
    return `// sw-cold probe (${variant})
(() => {
const scriptStart = performance.now();
const T = { scriptStart, timeOrigin: performance.timeOrigin };
const REQS = JSON.parse(${JSON.stringify(JSON.stringify(REQ))});
let inst = null, ready = null;
T.parsed = performance.now();
const SHAPE = ${JSON.stringify(shape)};
if (SHAPE === "b") {
    try {
        const bin = atob(${JSON.stringify(wasmB64 ?? "")});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        T.decoded = performance.now();
        const mod = new WebAssembly.Module(bytes);
        T.compiled = performance.now();
        inst = new WebAssembly.Instance(mod, {});
        T.instantiated = performance.now();
    } catch (e) { T.syncError = { name: e && e.name, message: String(e && e.message) }; }
} else if (SHAPE === "a") {
    const url = chrome.runtime.getURL("describe.wasm");
    ready = (async () => {
        let mod;
        try { mod = await WebAssembly.compileStreaming(fetch(url)); T.path = "compileStreaming"; }
        catch (e) {
            T.streamingError = { name: e && e.name, message: String(e && e.message) };
            const buf = await (await fetch(url)).arrayBuffer();
            mod = await WebAssembly.compile(buf); T.path = "fetch+compile";
        }
        T.compiled = performance.now();
        inst = await WebAssembly.instantiate(mod, {});
        T.instantiated = performance.now();
        T.ready = T.instantiated;
    })();
    ready.catch((e) => { T.readyError = { name: e && e.name, message: String(e && e.message) }; });
}
function call(req) {
    const ex = inst.exports, enc = new TextEncoder(), dec = new TextDecoder();
    const b = enc.encode(JSON.stringify({ argv: req.argv, manifest: req.manifest, version: req.version, envSet: [], flavour: undefined }));
    const p = ex.alloc(b.length);
    new Uint8Array(ex.memory.buffer, p, b.length).set(b);
    const o = ex.describe(p, b.length);
    const len = new DataView(ex.memory.buffer).getUint32(o, true);
    const s = dec.decode(new Uint8Array(ex.memory.buffer, o + 4, len));
    ex.dealloc(p, b.length); ex.dealloc(o, 4 + len);
    return JSON.parse(s);
}
chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (!m || m.probe !== "describe") return;
    T.msgReceived = performance.now();
    (async () => {
        let described, error = null;
        try {
            if (ready) await ready;
            if (inst) described = call(REQS[m.program]).described;
        } catch (e) { error = { name: e && e.name, message: String(e && e.message) }; }
        T.described = performance.now();
        const mem = { performanceMemory: typeof performance.memory === "undefined" ? null : { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize }, wasmBytes: inst ? inst.exports.memory.buffer.byteLength : null };
        send({ T: { ...T }, described, error, mem, now: Date.now(), program: m.program });
    })();
    return true;
});
})();
`;
}

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** copy the base build once per variant, with the probe prepended */
function makeVariant(variant) {
    const dir = path.join(WORK, variant);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(BASE, dir, { recursive: true });
    const bg = path.join(dir, "background.js");
    const orig = fs.readFileSync(bg);
    let wasm = null;
    if (variant !== "control") wasm = fs.readFileSync(WASM(variant.split("-")[1]));
    if (variant[0] === "a") fs.copyFileSync(WASM(variant.split("-")[1]), path.join(dir, "describe.wasm"));
    const src = probeSource(variant, variant[0] === "b" ? wasm.toString("base64") : null);
    fs.writeFileSync(bg, Buffer.concat([Buffer.from(src), orig]));
    return { dir, backgroundBytes: fs.statSync(bg).size, backgroundGrowth: fs.statSync(bg).size - orig.length };
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const stat = (a) => (a.length ? { n: a.length, med: q(a, 0.5), p95: q(a, 0.95), max: Math.max(...a) } : null);

/** one heap reading of the worker target through its own DevTools websocket (the endpoint lists it at /json/list) */
async function heapUsage(endpoint, extId) {
    try {
        const list = await (await fetch(`${endpoint}/json/list`)).json();
        const t = list.find((x) => x.type === "service_worker" && x.url.includes(extId));
        if (!t) return { error: "no service_worker target in /json/list" };
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
        const r = await new Promise((res) => {
            const timer = setTimeout(() => res({ error: "timeout" }), 3000);
            ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); res(m.error ? { error: m.error.message } : m.result); } };
            ws.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
        });
        ws.close();
        return r;
    } catch (e) { return { error: String(e && e.message) }; }
}

/** wait until the browser lists no service-worker target for the extension (Playwright's own serviceWorkers() list goes stale, so it is not used) */
async function waitGone(ext) {
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
        const list = await (await fetch(`${ext.cdpEndpoint}/json/list`)).json();
        if (!list.some((x) => x.type === "service_worker" && x.url.includes(ext.extensionId))) { await new Promise((r) => setTimeout(r, 300)); return Date.now() - t0; }
        await new Promise((r) => setTimeout(r, 50));
    }
    return -1;
}

async function runLaunch(variant, launch, info, meta) {
    const records = [];
    const ext = await launchExtension({ dist: info.dir, sidePanel: true });
    const browserVersion = ext.context.browser()?.version?.() ?? (await (await fetch(`${ext.cdpEndpoint}/json/version`)).json()).Browser;
    meta.chrome = browserVersion;
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    const cdp = await ext.context.newCDPSession(page);
    let status = "";
    cdp.on("ServiceWorker.workerVersionUpdated", (e) => { const v = e.versions.at(-1); if (v) status = `${v.runningStatus}/${v.status}`; });
    await cdp.send("ServiceWorker.enable");
    // the install-time start must finish first: a stop that lands inside it just restarts the worker
    for (let i = 0; i < 200 && status !== "running/activated"; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1000));
    let prevOrigin = null;
    for (let w = -1; w < WAKES; w++) {
        const program = PROGRAMS[(Math.max(w, 0) + launch) % 2];
        // wake -1 is the worker the browser started at install, NOT stopped: its compile is the first in the profile, before any cache
        const rec = { variant, launch, wake: w, initial: w < 0, program, loadavg1: os.loadavg()[0] };
        try {
            if (w >= 0) { await cdp.send("ServiceWorker.stopAllWorkers"); rec.goneMs = await waitGone(ext); }
            const r = await page.evaluate(async (program) => {
                const t0 = Date.now(), p0 = performance.now();
                const ans = await chrome.runtime.sendMessage({ probe: "describe", program });
                return { ans, t0, roundTrip: performance.now() - p0, t1: Date.now() };
            }, program);
            if (!r.ans) throw new Error("no answer from the probe");
            const T = r.ans.T;
            rec.T = T; rec.describedField = r.ans.described; rec.error = r.ans.error; rec.roundTrip = r.roundTrip;
            rec.pageT0 = r.t0; rec.swNow = r.ans.now;
            rec.startLagMs = T.timeOrigin - r.t0; // worker time origin minus the page's send time: how long after the send the worker began
            rec.cold = !rec.initial && (prevOrigin === null || T.timeOrigin !== prevOrigin);
            prevOrigin = T.timeOrigin;
            rec.mem = r.ans.mem;
            rec.heap = await heapUsage(ext.cdpEndpoint, ext.extensionId); // after the answer, so it cannot touch the timings
            const key = variant[0] === "b" ? "instantiated" : variant[0] === "a" ? "ready" : null;
            rec.i = key && T[key] != null ? T[key] - T.scriptStart : null;
            rec.ii = T.described - T.scriptStart;
            rec.iii = r.roundTrip;
        } catch (e) { rec.error = rec.error ?? { name: e.name, message: String(e.message) }; rec.fatal = true; }
        records.push(rec);
    }
    await ext.close();
    return records;
}

// ---- main ----
const startLoad = os.loadavg();
fs.mkdirSync(WORK, { recursive: true });
fs.rmSync(BASE, { recursive: true, force: true });
console.log("building the extension into", BASE);
execFileSync("node", ["build.mjs", "--outdir", BASE], { cwd: TS, stdio: ["ignore", "ignore", "inherit"] });

const infos = Object.fromEntries(VARIANTS.map((v) => [v, makeVariant(v)]));
const meta = {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, cpus: os.cpus().length, loadavgStart: startLoad,
    wasm: { z: { bytes: fs.statSync(WASM("z")).size, sha256: sha(WASM("z")) }, s: { bytes: fs.statSync(WASM("s")).size, sha256: sha(WASM("s")) } },
    variants: Object.fromEntries(VARIANTS.map((v) => [v, { backgroundBytes: infos[v].backgroundBytes, backgroundGrowth: infos[v].backgroundGrowth }])),
    requests: Object.fromEntries(PROGRAMS.map((p) => [p, { argv: REQ[p].argv, version: REQ[p].version }])),
    wakesPerLaunch: WAKES, launches: LAUNCHES, startedAt: new Date().toISOString(),
};
const records = [];
for (let launch = 0; launch < LAUNCHES; launch++) {
    for (const v of VARIANTS) {
        console.log(`launch ${launch} variant ${v} ...`);
        try { records.push(...(await runLaunch(v, launch, infos[v], meta))); }
        catch (e) { console.log("  launch failed:", e.message); records.push({ variant: v, launch, wake: -2, fatal: true, error: { name: e.name, message: e.message } }); }
    }
}
meta.loadavgEnd = os.loadavg();
meta.finishedAt = new Date().toISOString();
for (const r of records) r.chrome = meta.chrome, r.platform = meta.platform, r.loadavgStart = meta.loadavgStart, r.loadavgEnd = meta.loadavgEnd;
fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
fs.writeFileSync(OUTFILE, JSON.stringify({ meta, records }, null, 1));
console.log("wrote", OUTFILE);

// ---- summary ----
const f = (x) => (x == null ? "    -" : x.toFixed(1).padStart(7));
const row = (name, s) => `${name.padEnd(24)}${String(s?.n ?? 0).padStart(4)} ${f(s?.med)} ${f(s?.p95)} ${f(s?.max)}`;
const ok = records.filter((r) => !r.fatal && r.T);
const failed = records.filter((r) => r.fatal || r.error);
console.log(`\nrecords ${records.length}, ok ${ok.length}, with an error or fatal: ${failed.length}, non-initial wakes that did not cold-start: ${ok.filter((r) => !r.initial && !r.cold).length}`);
const ctrl = { 0: {}, rest: {}, init: {} };
for (const v of VARIANTS) {
    for (const [label, sel] of [["wakes>0", (r) => r.wake > 0], ["wake 0", (r) => r.wake === 0], ["initial (install-time start, not stopped)", (r) => r.initial]]) {
        const rs = ok.filter((r) => r.variant === v && sel(r));
        // the initial record's message is sent ~1 s after the install-time start, so only (i) means anything there
        const S = { i: stat(rs.map((r) => r.i).filter((x) => x != null)), ii: label[0] === "i" ? null : stat(rs.map((r) => r.ii)), iii: label[0] === "i" ? null : stat(rs.map((r) => r.iii)) };
        const key = label === "wake 0" ? 0 : label === "wakes>0" ? "rest" : "init";
        if (v === "control") ctrl[key] = S;
        console.log(`\n${v} / ${label}   (ms)             n     med     p95     max`);
        console.log(row("(i) init-scriptStart", S.i));
        console.log(row("(ii) described-scriptStart", S.ii));
        console.log(row("(iii) page round trip", S.iii));
        if (v !== "control" && ctrl[key].ii) {
            console.log(row("(ii) minus control med", S.ii && { n: S.ii.n, med: S.ii.med - ctrl[key].ii.med, p95: S.ii.p95 - ctrl[key].ii.p95, max: S.ii.max - ctrl[key].ii.max }));
            console.log(row("(iii) minus control med", S.iii && { n: S.iii.n, med: S.iii.med - ctrl[key].iii.med, p95: S.iii.p95 - ctrl[key].iii.p95, max: S.iii.max - ctrl[key].iii.max }));
        }
    }
    const rs = ok.filter((r) => r.variant === v);
    for (const p of PROGRAMS) {
        const s = stat(rs.filter((r) => r.wake > 0 && r.program === p).map((r) => r.ii));
        console.log(row(`  (ii) wakes>0 ${p}`, s));
    }
    const heaps = rs.map((r) => r.heap?.usedSize).filter((x) => x != null);
    console.log(row("  heap usedSize (bytes/1e3)", stat(heaps.map((x) => x / 1e3))));
    const errs = [...new Set(rs.map((r) => JSON.stringify(r.T.syncError ?? r.T.readyError ?? null)))];
    console.log("  syncError/readyError:", errs.join(" | "), " path:", [...new Set(rs.map((r) => r.T.path))].join(","));
}
