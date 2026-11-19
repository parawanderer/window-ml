// measure-ranged.mjs — what one ranged reader over the shelf holds, for docs/spec/FILE_ATTACHMENTS.md's lazy `/files/`
// (the amendment of 2026-11-17): N sessions at once, each with a large directory kept as IndexedDB Blobs, read LAZILY
// (512 KiB `Blob.slice` chunks posted to a worker that keeps a bounded cache) against EAGERLY (every file whole, as the
// ruled MEMFS mount does). An extension page stands in for the offscreen document, a dedicated worker for the Pyodide
// worker. Memory is the harness browser's process tree, sampled from outside. The channel to Python (route A's sliced
// wait) is not in this lab: its cost is notebooks/pyodide-mount/'s measurement.
//
// Run with `node scripts/test-slot.mjs run --kind batch -- node notebooks/session-store/measure-ranged.mjs [--quick]`.
// Writes data/ranged.json (data/ranged-gc.json with `--gc`). Nothing in src/ or tests/ changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchExtension } from "../../tests/e2e/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Other Playwright Chromium browsers on the machine (not this run's): recorded at the start and end, so the data says
 *  whether the machine was quiet. */
const otherBrowsers = (/** @type {string} */ mine) => execFileSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n").filter((l) => l.includes("ms-playwright/chromium") && !l.includes("--type=") && !(mine && l.includes(mine))).length;

const DATA = path.join(HERE, "data");
const QUICK = process.argv.includes("--quick");
/** `--gc`: only the lazy runs, in a browser started with `--expose-gc`, the page and each worker calling `gc()` as they
 *  go, so the peak is what the reader HOLDS and not garbage V8 had not yet collected. Writes data/ranged-gc.json. The
 *  plain lazy runs' peak grew with the bytes read (1.1 GiB over the baseline for one session reading 1.25 GiB through a
 *  16 MiB cache): each chunk is a fresh ArrayBuffer, and the dropped ones outlived the run. */
const GC = process.argv.includes("--gc");
const MiB = 1 << 20;
const SESSIONS = QUICK ? [1, 2] : [1, 4, 8];
/** Each session's directory: FILES files of FILE_MIB. */
const FILES = 2, FILE_MIB = QUICK ? 32 : 128;
const CHUNK = 512 * 1024;
const CACHE_CHUNKS = 32;   // 16 MiB per session
/** Runs per configuration, interleaved, so a reader can tell load noise from an effect. */
const REPS = QUICK ? 1 : 3;
/** A lazy run reads its directory this many times over, so it lasts seconds and the 100 ms sampler sees its steady
 *  state: read once, it finished in under 200 ms, faster than the sampler, which would understate its peak. */
const PASSES = 5;

function probeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-ss-ranged-"));
    for (const f of fs.readdirSync(path.join(HERE, "probe-ext"))) fs.copyFileSync(path.join(HERE, "probe-ext", f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "session-store ranged probe", version: "1.0", background: { service_worker: "sw.js" }, permissions: ["storage", "unlimitedStorage"] }));
    return dir;
}

/** RSS in MiB of the browser holding `mark` in its command line, and every process under it. */
function treeRssMiB(mark) {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 1 << 26 });
    const procs = out.split("\n").filter(Boolean).map((l) => { const [pid, ppid, rss, ...cmd] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, rss: +rss, cmd: cmd.join(" ") }; });
    const mine = new Set(procs.filter((p) => p.cmd.includes(mark) && !p.cmd.includes("--type=")).map((p) => p.pid));
    let grew = true;
    while (grew) { grew = false; for (const p of procs) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; } }
    return Math.round(procs.filter((p) => mine.has(p.pid)).reduce((a, p) => a + p.rss, 0) / 1024);
}

/** The macOS memory pressure level (1 normal, 2 warn, 4 critical) and the free-memory percentage the kernel reports.
 *  Under pressure Chrome purges and the OS compresses, so RSS reads LOW: a run not at level 1 throughout is void. */
function pressure() {
    const [level, freePct] = execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "kern.memorystatus_level"], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
    return { level, freePct };
}

/** Run `fn` while sampling the tree's RSS and the memory pressure every 100 ms; returns its result with the peak, the
 *  baseline, the worst pressure level seen and the lowest free-memory percentage. */
async function sampled(mark, fn) {
    const base = treeRssMiB(mark);
    const p0 = pressure();
    let peak = base, maxLevel = p0.level, minFree = p0.freePct;
    const t = setInterval(() => { try { peak = Math.max(peak, treeRssMiB(mark)); const p = pressure(); maxLevel = Math.max(maxLevel, p.level); minFree = Math.min(minFree, p.freePct); } catch { /* one sample failed */ } }, 100);
    const t0 = Date.now();
    try {
        const r = await fn();
        const p1 = pressure();
        return { ...r, rssBaseMiB: base, rssPeakMiB: Math.max(peak, treeRssMiB(mark)), ms: Date.now() - t0,
            pressureStart: p0, pressureEnd: p1, maxPressureLevel: Math.max(maxLevel, p1.level), minFreePct: Math.min(minFree, p1.freePct),
            valid: Math.max(maxLevel, p1.level) === 1 };
    } finally { clearInterval(t); }
}

const otherAtStart = otherBrowsers("");
/** The test-slot queue when this run started (other jobs running or queued), so the data says how loaded the machine was. */
const queueAtStart = (() => { try { const out = execFileSync("node", [path.join(HERE, "..", "..", "scripts", "test-slot.mjs"), "status"], { encoding: "utf8" }); let n = 0, on = false; for (const l of out.split("\n")) { if (/^(running|queued):/.test(l)) on = true; else if (/^finished:/.test(l)) on = false; else if (on && /^  \d/.test(l) && !l.includes("measure-ranged")) n++; } return n; } catch { return null; } })();
const dist = probeDir();
// One profile for every launch, so the shelf written once is read by each fresh browser; the extension's id follows
// its directory, so the same `dist` keeps the same origin and the same IndexedDB.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wml-ss-ranged-profile-"));
const mark = `--load-extension=${dist}`;
let browser = "unknown";

/** A fresh browser on the shared profile, with the probe page and its toolkit loaded. Each configuration gets its own,
 *  so its baseline is not what an earlier configuration left behind (a first version of this lab ran every
 *  configuration in one browser, and the baseline climbed from 1.0 to 3.0 GiB across them). */
async function fresh() {
    const ext = await launchExtension({ dist, userDataDir: profile, args: GC ? ["--js-flags=--expose-gc"] : [] });
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/page.html`);
    browser = ext.context.browser()?.version() ?? browser;
    // The page's toolkit: an IndexedDB of Blobs, a writer of random files, the lazy and eager readers.
    await page.evaluate(() => {
        const g = /** @type {any} */ (globalThis);
        const open = () => new Promise((res, rej) => { const q = indexedDB.open("shelf", 1); q.onupgradeneeded = () => q.result.createObjectStore("files"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        const tx = (db, mode, fn) => new Promise((res, rej) => { const t = db.transaction("files", mode); const r = fn(t.objectStore("files")); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); });
        g.shelf = {
            async put(key, mib) {
                // Written in 8 MiB parts of random bytes, so the stored Blob is incompressible and is never one buffer here.
                const parts = [];
                for (let i = 0; i < mib; i += 8) { const u = new Uint8Array(8 * 1024 * 1024); for (let o = 0; o < u.length; o += 65536) crypto.getRandomValues(u.subarray(o, o + 65536)); parts.push(new Blob([u])); }
                const db = await open(); await tx(db, "readwrite", (s) => s.put(new Blob(parts), key)); db.close();
            },
            async get(key) { const db = await open(); const q = await new Promise((res, rej) => { const r = db.transaction("files").objectStore("files").get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); db.close(); return q; },
            async clear() { const db = await open(); await tx(db, "readwrite", (s) => s.clear()); db.close(); },
        };
        g.newReader = async (cacheChunks) => {
            const w = new Worker("reader-worker.js");
            let id = 0; const waiting = new Map();
            w.onmessage = (e) => { const f = waiting.get(e.data.id ?? "ctl"); if (f) { waiting.delete(e.data.id ?? "ctl"); f(e.data); } };
            const call = (m, transfer = []) => new Promise((res) => { const k = m.op === "chunk" ? (m.id = ++id) : "ctl"; waiting.set(k, res); w.postMessage(m, transfer); });
            await call({ op: "config", cacheChunks });
            return { w, call };
        };
        // LAZY: one session reads every file through, chunk by chunk, each chunk posted (transferred) to its worker.
        g.readLazy = async (keys, chunk, reader) => {
            const lat = [];
            let bytes = 0;
            for (const key of keys) {
                const blob = await g.shelf.get(key);
                for (let at = 0; at < blob.size; at += chunk) {
                    const t0 = performance.now();
                    const buf = await blob.slice(at, Math.min(blob.size, at + chunk)).arrayBuffer();
                    lat.push(performance.now() - t0);
                    bytes += buf.byteLength;
                    await reader.call({ op: "chunk", buf }, [buf]);
                }
                if (typeof g.gc === "function") g.gc();
            }
            return { bytes, lat };
        };
    });


    await new Promise((r) => setTimeout(r, 3000));   // settle before the baseline
    return { ext, page };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(0.9 * s.length))] : null; };

const result = { quick: QUICK, at: new Date().toISOString(), machine: { cpus: os.cpus()[0]?.model, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1), load: os.loadavg() },
    files: FILES, fileMiB: FILE_MIB, chunkBytes: CHUNK, cacheChunks: CACHE_CHUNKS, freshBrowserPerRun: true, runs: [] };

const maxN = Math.max(...SESSIONS);
console.log(`writing ${maxN} sessions x ${FILES} x ${FILE_MIB} MiB`);
{
    const { ext, page } = await fresh();
    for (let s = 0; s < maxN; s++) for (let f = 0; f < FILES; f++) await page.evaluate(({ key, mib }) => globalThis.shelf.put(key, mib), { key: `s${s}/f${f}`, mib: FILE_MIB });
    await ext.close();
}

const keysOf = (s) => Array.from({ length: FILES }, (_, f) => `s${s}/f${f}`);
const extra = (r) => ({ pressureStart: r.pressureStart, pressureEnd: r.pressureEnd, maxPressureLevel: r.maxPressureLevel, minFreePct: r.minFreePct, valid: r.valid });
for (let rep = 0; rep < REPS; rep++) for (const n of SESSIONS) {
    {   // LAZY, n sessions at once, each its own worker.
        const { ext, page } = await fresh();
        const lazy = await sampled(mark, () => page.evaluate(async ({ n, keys, chunk, cache, passes }) => {
            const g = /** @type {any} */ (globalThis);
            const readers = await Promise.all(Array.from({ length: n }, () => g.newReader(cache)));
            const out = await Promise.all(readers.map(async (r, s) => { const acc = { bytes: 0, lat: [] }; for (let i = 0; i < passes; i++) { const o = await g.readLazy(keys[s], chunk, r); acc.bytes += o.bytes; acc.lat.push(...o.lat); } return acc; }));
            readers.forEach((r) => r.w.terminate());
            return { bytes: out.reduce((a, o) => a + o.bytes, 0), lat: out.flatMap((o) => o.lat) };
        }, { n, keys: Array.from({ length: n }, (_, s) => keysOf(s)), chunk: CHUNK, cache: CACHE_CHUNKS, passes: PASSES }));
        result.runs.push({ mode: "lazy", sessions: n, dirMiBPerSession: FILES * FILE_MIB, readMiB: Math.round(lazy.bytes / MiB), chunkMsMedian: +median(lazy.lat).toFixed(3), chunkMsP90: +p90(lazy.lat).toFixed(3),
            mbPerS: +((lazy.bytes / 1e6) / (lazy.ms / 1000)).toFixed(0), rssBaseMiB: lazy.rssBaseMiB, rssPeakMiB: lazy.rssPeakMiB, ms: lazy.ms, rep, ...extra(lazy) });
        console.log(JSON.stringify(result.runs.at(-1)));
        await ext.close();
    }
    if (!GC) {   // EAGER, n sessions at once: every file whole, held, as the ruled MEMFS mount holds the directory.
        const { ext, page } = await fresh();
        const eager = await sampled(mark, () => page.evaluate(async ({ keys }) => {
            const g = /** @type {any} */ (globalThis);
            g.__eager = [];
            for (const k of keys.flat()) { const b = await g.shelf.get(k); const buf = await b.arrayBuffer(); new Uint8Array(buf).reduce((a, x, i) => (i % 4096 ? a : a + x), 0); g.__eager.push(buf); }
            const bytes = g.__eager.reduce((a, b) => a + b.byteLength, 0);
            await new Promise((r) => setTimeout(r, 1500));   // held while sampled
            g.__eager = null;
            return { bytes };
        }, { keys: Array.from({ length: n }, (_, s) => keysOf(s)) }));
        result.runs.push({ mode: "eager", sessions: n, dirMiBPerSession: FILES * FILE_MIB, readMiB: Math.round(eager.bytes / MiB), rssBaseMiB: eager.rssBaseMiB, rssPeakMiB: eager.rssPeakMiB, ms: eager.ms, rep, ...extra(eager) });
        console.log(JSON.stringify(result.runs.at(-1)));
        await ext.close();
    }
}

const { ext, page } = await fresh();
result.browser = browser;
// SMALL FILES: 200 files of 4 KiB, each read whole once: lazily one slice each, against eagerly loaded then read.
await page.evaluate(async () => {
    const g = /** @type {any} */ (globalThis);
    const db = await new Promise((res, rej) => { const q = indexedDB.open("shelf", 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res) => { const t = db.transaction("files", "readwrite"); for (let i = 0; i < 200; i++) { const u = new Uint8Array(4096); crypto.getRandomValues(u); t.objectStore("files").put(new Blob([u]), `small/${i}`); } t.oncomplete = res; });
    db.close();
});
result.small = await page.evaluate(async () => {
    const g = /** @type {any} */ (globalThis);
    const t0 = performance.now();
    const blobs = []; for (let i = 0; i < 200; i++) blobs.push(await g.shelf.get(`small/${i}`));
    const tGet = performance.now();
    for (const b of blobs) await b.slice(0, b.size).arrayBuffer();
    const tLazy = performance.now();
    const held = []; for (const b of blobs) held.push(await b.arrayBuffer());
    const tEagerLoad = performance.now();
    let x = 0; for (const h of held) x += new Uint8Array(h)[0];
    const tEagerRead = performance.now();
    return { files: 200, fileBytes: 4096, getAllMs: +(tGet - t0).toFixed(2), lazyReadAllMs: +(tLazy - tGet).toFixed(2), eagerLoadMs: +(tEagerLoad - tLazy).toFixed(2), eagerReadMs: +(tEagerRead - tEagerLoad).toFixed(3), x };
});
console.log("small", JSON.stringify(result.small));

await page.evaluate(() => globalThis.shelf.clear());
await ext.close();
fs.rmSync(dist, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
result.machine.loadAfter = os.loadavg();
result.otherBrowsersAtStart = otherAtStart;
result.otherTestSlotJobsAtStart = queueAtStart;
result.reps = REPS;
result.lazyPasses = PASSES;
result.timingsUnderLoad = (queueAtStart ?? 0) > 0;
result.otherBrowsersAtEnd = otherBrowsers("");
fs.mkdirSync(DATA, { recursive: true });
const outName = `ranged${GC ? "-gc" : ""}${QUICK ? "-quick" : ""}.json`;
result.gc = GC;
fs.writeFileSync(path.join(DATA, outName), JSON.stringify(result, null, 2) + "\n");
console.log("wrote", `data/${outName}`);
