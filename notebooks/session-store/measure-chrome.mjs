// measure-chrome.mjs — the two figures docs/spec/SESSION_HISTORY_STORE.md left unknown, measured in the e2e harness's
// Chromium with a probe extension (probe-ext/), never the person's profile: how much an MV3 service worker can hold
// before it dies, and what quota an extension gets with and without `unlimitedStorage`. Also, because they decide the
// same batch sizes: the largest single IndexedDB put, and the runtime message limit.
//
// Run with `node scripts/test-slot.mjs run --kind batch -- node notebooks/session-store/measure-chrome.mjs [--quick]`.
// Writes data/*.json. Each allocation run stops at CAP_GIB (a shared machine), so "no death below the cap" is a
// lower bound, said as such in the data. Nothing in src/ or tests/ changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { launchExtension } from "../../tests/e2e/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Other Playwright Chromium browsers on the machine (not this run's): recorded at the start and end, so the data says
 *  whether the machine was quiet. */
const otherBrowsers = (/** @type {string} */ mine) => execFileSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n").filter((l) => l.includes("ms-playwright/chromium") && !l.includes("--type=") && !(mine && l.includes(mine))).length;

const DATA = path.join(HERE, "data");
const QUICK = process.argv.includes("--quick");
const MiB = 1 << 20;
/** Where an allocation run stops if the worker has not died: the machine is shared. */
const CAP_GIB = QUICK ? 1 : 6;
const STEP_MIB = 64;

/** @param {string} name @param {unknown} v */
const save = (name, v) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, name), JSON.stringify(v, null, 2) + "\n"); };

/** A copy of probe-ext/ with a manifest, with or without `unlimitedStorage`. */
function probeDir(/** @type {boolean} */ unlimited) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wml-ss-probe-${unlimited ? "u" : "n"}-`));
    for (const f of fs.readdirSync(path.join(HERE, "probe-ext"))) fs.copyFileSync(path.join(HERE, "probe-ext", f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
        manifest_version: 3, name: "session-store probe", version: "1.0",
        background: { service_worker: "sw.js" },
        permissions: ["storage", ...(unlimited ? ["unlimitedStorage"] : [])],
    }));
    return dir;
}

/** Launch the probe; `sw` is its worker, `page` an extension page. */
async function launch(/** @type {boolean} */ unlimited) {
    const dist = probeDir(unlimited);
    const ext = await launchExtension({ dist });
    // The browser launched with THIS probe copy: its command line names the directory.
    const line = execFileSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").find((l) => l.includes(`--load-extension=${dist}`) && !l.includes("--type="));
    PROFILE_MARK = line?.match(/--user-data-dir=(\S+)/)?.[1] ?? "\0";
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/page.html`);
    const version = ext.context.browser()?.version() ?? await page.evaluate(() => navigator.userAgent);
    return { ...ext, page, version, dist };
}

/** The worker currently registered, waking it if it was stopped or died. A death in the worker takes the extension
 *  process with it, and the probe page lives in that process too, so the page is replaced first when it crashed. */
async function liveWorker(ext) {
    const alive = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.extensionId));
    if (alive.length) return alive[alive.length - 1];
    const ok = await Promise.race([ext.page.evaluate(() => 1).catch(() => 0), new Promise((r) => setTimeout(() => r(0), 3000))]);
    if (!ok) {
        await ext.page.close().catch(() => {});
        ext.page = await ext.context.newPage();
        await ext.page.goto(`chrome-extension://${ext.extensionId}/page.html`);
    }
    const again = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.extensionId));
    if (again.length) return again[again.length - 1];
    const next = ext.context.waitForEvent("serviceworker", { timeout: 20000 });
    await ext.page.evaluate(() => chrome.runtime.sendMessage({ probe: "echo-length", body: "" }).catch(() => null));
    return next;
}

const machine = { platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, load: os.loadavg() };

/** The harness's browser (the process holding this run's temporary profile) and every process under it: other sessions
 *  may run their own Chromium at the same time. */
function myProcesses() {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 1 << 26 });
    const procs = out.split("\n").filter(Boolean).map((l) => { const [pid, ppid, rss, ...cmd] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, rss: +rss, cmd: cmd.join(" ") }; });
    const roots = procs.filter((p) => p.cmd.includes("--user-data-dir=") && p.cmd.includes("playwright_chromiumdev_profile") && !p.cmd.includes("--type="));
    const mine = new Set(roots.filter((r) => r.cmd.includes(PROFILE_MARK)).map((r) => r.pid));
    let grew = true;
    while (grew) { grew = false; for (const p of procs) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; } }
    return procs.filter((p) => mine.has(p.pid));
}
const chromiumRssMiB = () => Math.round(myProcesses().reduce((a, p) => a + p.rss, 0) / 1024);
/** The largest resident size, in MiB, of THIS run's `--extension-process` (where the probe's service worker runs):
 *  sampled from outside, so a held allocation is checked to be real memory. Another session's Chromium never counts. */
const extensionRssMiB = () => Math.round(Math.max(0, ...myProcesses().filter((p) => p.cmd.includes("--extension-process")).map((p) => p.rss)) / 1024);
/** Set at launch: the temporary profile directory's name, which only this run's browser carries. */
let PROFILE_MARK = "\0";

// --- 1. what a service worker holds before it dies -------------------------------------------------------------------

/**
 * Allocate in STEP_MIB steps inside the worker, writing the running total to chrome.storage.session after each step
 * (which lives in the browser process, so it survives the worker), until the worker dies or CAP_GIB is reached.
 * `kind`: "string" holds one-byte strings (the JS heap, where a session's events and history live today);
 * "arraybuffer" holds touched ArrayBuffers (outside the JS heap, where a backup's bytes live).
 */
async function allocate(ext, /** @type {"objects"|"string"|"arraybuffer"} */ kind) {
    const sw = await liveWorker(ext);
    const heap = await sw.evaluate(() => {
        const m = /** @type {any} */ (performance).memory;
        return m ? { jsHeapSizeLimit: m.jsHeapSizeLimit, totalJSHeapSize: m.totalJSHeapSize, usedJSHeapSize: m.usedJSHeapSize } : null;
    });
    await sw.evaluate(() => chrome.storage.session.clear());
    let closed = null;
    sw.once("close", () => { closed = Date.now(); });
    const t0 = Date.now();
    let peakRssMiB = extensionRssMiB(), peakAllMiB = chromiumRssMiB();
    const baseAllMiB = peakAllMiB;
    const sampler = setInterval(() => { try { peakRssMiB = Math.max(peakRssMiB, extensionRssMiB()); peakAllMiB = Math.max(peakAllMiB, chromiumRssMiB()); } catch { /* ps failed once */ } }, 250);
    const outcome = await sw.evaluate(async ({ kind, step, capMiB }) => {
        const g = /** @type {any} */ (globalThis);
        g.__hold = [];
        // Every held byte is FLAT and RANDOM: `"x".repeat(n)` is a rope that holds almost nothing, and a page of one
        // repeated byte costs almost nothing under the macOS memory compressor (the first run of this script measured
        // both, not the heap). Strings take random bytes mapped to 0x20-0x7e, which `TextDecoder("ascii")` returns as
        // one flat one-byte string.
        const MiB = 1024 * 1024;
        const fill = (/** @type {Uint8Array} */ u, /** @type {boolean} */ printable) => {
            for (let i = 0; i < u.length; i += 65536) crypto.getRandomValues(u.subarray(i, i + 65536));
            if (printable) for (let i = 0; i < u.length; i++) u[i] = 0x20 + (u[i] % 95);
        };
        const ascii = new TextDecoder("ascii");
        let mib = 0;
        try {
            while (mib + step <= capMiB) {
                if (kind === "objects") {
                    // Plain JS objects, which live in V8's own heap, as parsed events and history messages do. One step
                    // is a million small objects with a fresh double each; its size is V8's, read from RSS, not assumed.
                    const a = new Array(1_000_000);
                    for (let i = 0; i < a.length; i++) a[i] = { i, x: Math.random(), k: "m" };
                    g.__hold.push(a);
                    mib += step;
                    await chrome.storage.session.set({ mib });
                    continue;
                }
                const u = new Uint8Array(step * MiB);
                fill(u, kind === "string");
                if (kind === "string") { const str = ascii.decode(u); if (str.length !== u.length) throw new Error("decode changed the length"); g.__hold.push(str); }
                else g.__hold.push(u.buffer);
                mib += step;
                await chrome.storage.session.set({ mib });
            }
            // Still held? Every step's length, and one byte read from each, at the cap.
            let heldBytes = 0, sample = 0;
            for (const x of g.__hold) { if (kind === "objects") { heldBytes += x.length; sample += x[x.length >> 1].i; continue; } heldBytes += kind === "string" ? x.length : x.byteLength; sample += kind === "string" ? x.charCodeAt(x.length >> 1) : new Uint8Array(x)[x.byteLength >> 1]; }
            return { ended: "cap", mib, heldBytes, sampleSum: sample };
        } catch (e) {
            return { ended: "threw", mib, error: `${e?.name}: ${String(e?.message).slice(0, 200)}` };
        } finally { g.__hold = null; }
    }, { kind, step: STEP_MIB, capMiB: CAP_GIB * 1024 }).catch((e) => ({ ended: "rejected", error: String(e?.message || e).split("\n")[0].slice(0, 200) }));
    clearInterval(sampler);
    await new Promise((r) => setTimeout(r, 500));
    const after = await liveWorker(ext);
    const { mib: lastWritten } = await after.evaluate(() => chrome.storage.session.get("mib")).catch(() => ({ mib: null }));
    // A REJECTION is the evaluate promise failing; a DEATH is the worker going away. Only the second is a death.
    if (outcome.ended === "rejected" && closed !== null) outcome.ended = "died";
    return { kind, stepMiB: STEP_MIB, capMiB: CAP_GIB * 1024, heapBefore: heap, ...outcome, lastStepWrittenMiB: lastWritten ?? 0, workerClosed: closed !== null, peakExtensionRssMiB: peakRssMiB, chromiumRssBeforeMiB: baseAllMiB, peakChromiumRssMiB: peakAllMiB, ms: Date.now() - t0 };
}

// --- 2. the largest single IndexedDB put ------------------------------------------------------------------------------

async function idbPuts(ext) {
    const sizes = QUICK ? [32, 130] : [32, 64, 120, 127, 130, 256, 512];
    const out = [];
    for (const mib of sizes) {
        for (const kind of ["string", "object-of-strings"]) {
            const sw = await liveWorker(ext);
            let closed = false;
            sw.once("close", () => { closed = true; });
            const r = await sw.evaluate(async ({ mib, kind }) => {
                const open = () => new Promise((res, rej) => { const q = indexedDB.open("probe", 1); q.onupgradeneeded = () => q.result.createObjectStore("v"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
                const db = /** @type {IDBDatabase} */ (await open());
                const n = mib * 1024 * 1024;
                // One string, as a row's history would serialize; or an object of 1 MiB strings, as a history array is.
                const value = kind === "string" ? "x".repeat(n) : { messages: Array.from({ length: mib }, (_, i) => ({ role: "tool", content: String.fromCharCode(97 + (i % 26)).repeat(1024 * 1024) })) };
                const t0 = performance.now();
                try {
                    await new Promise((res, rej) => { const tx = db.transaction("v", "readwrite"); tx.objectStore("v").put(value, "k"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
                    const putMs = performance.now() - t0;
                    const back = await new Promise((res, rej) => { const q = db.transaction("v").objectStore("v").get("k"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
                    const len = typeof back === "string" ? back.length : back.messages.reduce((a, m) => a + m.content.length, 0);
                    await new Promise((res) => { const tx = db.transaction("v", "readwrite"); tx.objectStore("v").clear(); tx.oncomplete = res; });
                    db.close();
                    return { ok: true, putMs: Math.round(putMs), readBackOk: len === n };
                } catch (e) { db.close(); return { ok: false, error: `${e?.name}: ${String(e?.message).slice(0, 200)}` }; }
            }, { mib, kind }).catch((e) => ({ ok: false, rejected: true, error: String(e?.message || e).split("\n")[0].slice(0, 200) }));
            // `rejected`: the evaluate failed (a RangeError building the value counts); `died`: the worker went away.
            out.push({ mib, kind, ...r, died: closed, workerClosed: closed });
        }
    }
    return out;
}

// --- 3. the runtime message limit -------------------------------------------------------------------------------------

async function messages(ext) {
    const sizes = QUICK ? [1, 65] : [1, 32, 63, 64, 65, 128];
    const out = [];
    for (const mib of sizes) {
        for (const via of ["sendMessage", "port"]) {
            await liveWorker(ext);
            const r = await ext.page.evaluate(async ({ mib, via }) => {
                const body = "x".repeat(mib * 1024 * 1024 - 64);
                const t0 = performance.now();
                try {
                    const reply = via === "sendMessage"
                        ? await chrome.runtime.sendMessage({ probe: "echo-length", body })
                        : await new Promise((res, rej) => {
                            const p = chrome.runtime.connect();
                            const timer = setTimeout(() => rej(new Error("no reply in 20 s")), 20000);
                            p.onMessage.addListener((m) => { clearTimeout(timer); p.disconnect(); res(m); });
                            p.onDisconnect.addListener(() => { clearTimeout(timer); rej(new Error(`disconnected: ${chrome.runtime.lastError?.message ?? "no lastError"}`)); });
                            p.postMessage({ body });
                        });
                    return { ok: reply?.length === body.length, ms: Math.round(performance.now() - t0) };
                } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
            }, { mib, via });
            out.push({ mib, via, ...r });
        }
    }
    return out;
}

// --- 4. quota, with and without unlimitedStorage ----------------------------------------------------------------------

async function quota(ext) {
    const sw = await liveWorker(ext);
    const inWorker = await sw.evaluate(async () => { const e = await navigator.storage.estimate(); return { quota: e.quota, usage: e.usage, persisted: await navigator.storage.persisted?.() }; });
    const inPage = await ext.page.evaluate(async () => { const e = await navigator.storage.estimate(); return { quota: e.quota, usage: e.usage }; });
    return { inWorker, inPage };
}

function diskBytes() {
    const s = fs.statfsSync(os.tmpdir());
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
}

const result = { machine, quick: QUICK, at: new Date().toISOString(), otherBrowsersAtStart: otherBrowsers("") };
for (const unlimited of [false, true]) {
    const ext = await launch(unlimited);
    result.browser ??= ext.version;
    const tag = unlimited ? "unlimited" : "default";
    console.log(`[${tag}] ${ext.version}`);
    result[`quota-${tag}`] = { ...(await quota(ext)), disk: diskBytes() };
    // `performance.memory` in an extension PAGE, for comparison: the worker has none (measured: absent).
    result.pageMemory ??= await ext.page.evaluate(() => { const m = /** @type {any} */ (performance).memory; return m ? { jsHeapSizeLimit: m.jsHeapSizeLimit } : null; });
    console.log(`[${tag}] quota`, JSON.stringify(result[`quota-${tag}`]));
    if (unlimited) {
        result.messages = await messages(ext);
        console.log("messages", JSON.stringify(result.messages));
        result.idb = await idbPuts(ext);
        console.log("idb", JSON.stringify(result.idb));
        result.heap = [];
        for (const kind of ["string", "arraybuffer", "objects"]) {
            const r = await allocate(ext, kind);
            result.heap.push(r);
            console.log("heap", JSON.stringify(r));
        }
    }
    await ext.close();
    fs.rmSync(ext.dist, { recursive: true, force: true });
}
result.machine.loadAfter = os.loadavg();
result.otherBrowsersAtEnd = otherBrowsers("");
save(QUICK ? "chrome-quick.json" : "chrome.json", result);
console.log("wrote", QUICK ? "data/chrome-quick.json" : "data/chrome.json");
