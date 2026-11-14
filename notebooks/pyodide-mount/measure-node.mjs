// measure-node.mjs — #1780 route A, part 1: what a synchronous, Atomics.wait-backed host filesystem costs and does inside real Pyodide, in Node.
// Run: `node --import tsx notebooks/pyodide-mount/measure-node.mjs [item...] [--out data/node-*.json]` where item is one of
// stop, cost, walk, import, large, lockdown (default: all but large). Each item writes `data/node-<item>.json`. The worker half is
// node-worker.mjs (real Pyodide in a worker_threads Worker, a prototype FS type, the sliced wait); this file is the "host": it serves
// the worker's requests from the real disk with node:fs, can delay or never answer one, and sets the interrupt flag. The proxies
// (a Node worker for the browser's, node:fs for wmlhost, postMessage for three hops) are listed in each JSON's `caveats`.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const DATA = path.join(HERE, "data");
const SCRATCH = "/private/tmp/claude-501/-Users-sb-git-window-ml/a35fd507-c65b-41d2-a090-d4c205c60f1d/scratchpad";
const WORKSPACE = fs.realpathSync(ROOT);
const PYODIDE = fs.realpathSync(path.join(ROOT, "pyodide-core"));
const HDR = 64, DATA_BYTES = 16 * 1024 * 1024;
const RESP_ID = 0, RESP_STATUS = 1, RESP_LEN = 2;

/** @param {number[]} xs @returns {{n: number, median: number, p90: number, max: number, min: number, mean: number}} the spread of a sample, in its own unit */
export function spread(xs) {
    const s = [...xs].sort((a, b) => a - b), n = s.length;
    if (!n) return { n: 0 };
    const q = (p) => s[Math.min(n - 1, Math.floor(p * n))];
    return { n, min: s[0], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, p90: q(0.9), max: s[n - 1], mean: s.reduce((a, b) => a + b, 0) / n };
}
/** Round to 3 decimal places. @param {number} x @returns {number} */
const r3 = (x) => Math.round(x * 1000) / 1000;
/** @param {any} sp a spread @returns {any} the same with every number rounded to 3 places */
const rs = (sp) => Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, typeof v === "number" ? r3(v) : v]));
/** Wall-clock time in ms on the shared `performance.timeOrigin` scale, comparable across the worker and the host. */
const absNow = () => performance.timeOrigin + performance.now();

/** The host: one worker, one channel, a request server with a policy. */
export class Lab {
    /** @param {{lockdown?: boolean, chunk?: number, sliceMs?: number, hide?: string[], dropStale?: boolean}} o */
    constructor(o = {}) {
        this.o = { lockdown: false, chunk: 4 * 1024 * 1024, sliceMs: 50, hide: [], dropStale: true, ...o };
        this.ctlSab = new SharedArrayBuffer(64);
        this.intrSab = new SharedArrayBuffer(8);
        this.dataSab = new SharedArrayBuffer(DATA_BYTES);
        this.ctl = new Int32Array(this.ctlSab); this.intr = new Int32Array(this.intrSab); this.data = new Uint8Array(this.dataSab);
        this.counts = {}; this.maxSeen = 0; this.cid = 0; this.pending = new Map();
        /** @type {(req: any) => ({mode: "normal"} | {mode: "never"} | {mode: "delay", ms: number})} */
        this.policy = () => ({ mode: "normal" });
        this.abandoned = []; this.onReq = null; this.log = [];
    }
    /** Start the worker and wait for Pyodide to boot. @returns {Promise<any>} the boot info */
    async start() {
        this.w = new Worker(path.join(HERE, "node-worker.mjs"), {
            execArgv: ["--import", "tsx"],
            workerData: { ctlSab: this.ctlSab, intrSab: this.intrSab, dataSab: this.dataSab, pyodideDir: PYODIDE, lockdown: this.o.lockdown, chunk: this.o.chunk, sliceMs: this.o.sliceMs, repoRoot: ROOT },
            resourceLimits: { maxOldGenerationSizeMb: 16384, stackSizeMb: 8 },
        });
        this.w.on("message", (m) => this.onMessage(m));
        this.w.on("error", (e) => { this.dead = e; for (const p of this.pending.values()) p.reject(e); });
        this.w.on("exit", (code) => { this.exited = code; const e = new Error("worker exited with code " + code + (this.dead ? ": " + this.dead.message : "")); for (const p of this.pending.values()) p.reject(e); });
        return this.call({ cmd: "boot" });
    }
    /** Send a command to the worker and wait for its `done`. @returns {Promise<any>} */
    call(m) { const cid = ++this.cid; return new Promise((resolve, reject) => { this.pending.set(cid, { resolve, reject }); this.w.postMessage({ ...m, cid }); }); }
    onMessage(m) {
        if (m.t === "done") { const p = this.pending.get(m.cid); this.pending.delete(m.cid); return m.error ? p.reject(new Error(m.error)) : p.resolve(m.value); }
        if (m.t === "abandon") { this.abandonedIds = (this.abandonedIds || new Set()).add(m.id); return; }
        if (m.t === "req") return this.serve(m);
        if (m.t === "log") { this.log.push(m.s); if (process.env.LAB_VERBOSE) console.error("[py]", m.s); }
    }
    /** Count, apply the policy, answer. */
    serve(req) {
        this.counts[req.op] = (this.counts[req.op] || 0) + 1;
        this.maxSeen = Math.max(this.maxSeen, req.id);
        this.onReq?.(req);
        const pol = this.policy(req);
        if (pol.mode === "never") { this.abandoned.push(req); return; }
        if (pol.mode === "delay") { setTimeout(() => this.answer(req), pol.ms); return; }
        this.answer(req);
    }
    /** Compute the reply for `req` from the real disk and publish it. @param {any} req */
    answer(req, { force = false } = {}) {
        if (!force && this.o.dropStale && req.id < this.maxSeen) { this.stale = (this.stale || 0) + 1; return; }
        let status = 0, len = 0;
        try { len = this.compute(req); } catch (e) { status = errno(e); }
        Atomics.store(this.ctl, RESP_STATUS, status); Atomics.store(this.ctl, RESP_LEN, len);
        Atomics.store(this.ctl, RESP_ID, req.id); Atomics.notify(this.ctl, RESP_ID);
    }
    /** Answer a request the policy swallowed earlier, as a late reply. @param {any} req */
    late(req, force = true) { this.answer(req, { force }); }
    /** @param {any} req @returns {number} the reply payload length, written into the data SAB */
    compute(req) {
        const d = this.data;
        const statOf = (p) => { const s = fs.lstatSync(p); return { mode: s.mode, size: s.size, mtimeMs: s.mtimeMs }; };
        const put = (obj) => { const b = Buffer.from(JSON.stringify(obj)); if (b.length > d.length) throw Object.assign(new Error("reply too large"), { code: "E2BIG" }); d.set(b, 0); return b.length; };
        switch (req.op) {
            case "ping": return 0;
            case "echo": return req.len;
            case "stat": return put(statOf(req.path));
            case "readdir": {
                const hide = this.o.hide;
                const names = fs.readdirSync(req.path).filter((n) => !hide.includes(n));
                const ents = [];
                for (const name of names) {
                    if (!req.withStat) { ents.push({ name }); continue; }
                    try { ents.push({ name, stat: statOf(req.path + "/" + name) }); } catch { ents.push({ name }); }
                }
                return put(ents);
            }
            case "read": {
                const fd = fs.openSync(req.path, "r");
                try {
                    const size = fs.fstatSync(fd).size;
                    const n = Math.max(0, Math.min(req.len, size - req.off, d.length - 16));
                    const got = n ? fs.readSync(fd, d, 16, n, req.off) : 0;
                    const dv = new DataView(this.dataSab, 0, 16); dv.setBigUint64(0, BigInt(size), true); dv.setBigUint64(8, BigInt(got), true);
                    return 16 + got;
                } finally { fs.closeSync(fd); }
            }
            case "put": {
                const tmp = req.path + ".wmlpart";
                if (req.off === 0) fs.writeFileSync(tmp, d.subarray(0, req.len)); else fs.appendFileSync(tmp, d.subarray(0, req.len));
                if (req.last) fs.renameSync(tmp, req.path);
                return 0;
            }
            case "readlink": return put(fs.readlinkSync(req.path));
            case "rename": fs.renameSync(req.from, req.to); return 0;
            case "mkdir": fs.mkdirSync(req.path); return 0;
            case "unlink": fs.unlinkSync(req.path); return 0;
            case "rmdir": fs.rmdirSync(req.path); return 0;
        }
        throw Object.assign(new Error("unknown op " + req.op), { code: "ENOSYS" });
    }
    /** Store 2 in the interrupt buffer (what Stop does). @param {boolean} notify also wake the waiter at once @returns {number} the wall time of the store, ms */
    stop(notify = false) {
        const t = absNow();
        Atomics.store(this.intr, 0, 2);
        if (notify) Atomics.notify(this.ctl, RESP_ID);
        return t;
    }
    /** Run a Python cell; `code` leaves its result in `_r` as a JSON string. @returns {Promise<any>} */
    run(code, reset = true) { return this.call({ cmd: "run", code, reset }); }
    /** Mount the host filesystem at `at` (a fresh mount is a fresh cell: no cached nodes). */
    mount(at, root = at) { return this.call({ cmd: "mount", at, root }); }
    cfg(c) { return this.call({ cmd: "cfg", cfg: c }); }
    resetCounts() { this.counts = {}; this.stale = 0; this.abandoned = []; }
    async close() { await this.w.terminate(); }
}
const ERRNO = { ENOENT: 44, EACCES: 2, EPERM: 63, EISDIR: 31, ENOTDIR: 54, EIO: 29, E2BIG: 1, ENOSYS: 52, EROFS: 69, ELOOP: 32, ENOTEMPTY: 55, EEXIST: 20, EINVAL: 28 };
/** @param {any} e a node:fs error @returns {number} Emscripten's errno for it */
function errno(e) { return ERRNO[e.code] ?? 29; }
/** Resolve after `ms` milliseconds. @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- item 1: Stop latency during a blocked op -------------------------------------------------------------------------

/**
 * Block Python in one op the host never answers, Stop at a random phase of the 50 ms slice, and time until `except KeyboardInterrupt` runs.
 * @param {Lab} lab @param {string} name the case @param {string} code Python that performs the op inside `try/except KeyboardInterrupt` and sets `_r`
 * @param {(req: any) => boolean} blockOn which request the host swallows @param {number} reps @param {boolean} notify the stopper also wakes the waiter
 * @param {string} mountAt where the host filesystem is mounted @param {string} [mountRoot] the host directory behind it
 */
async function stopCase(lab, name, code, blockOn, reps, notify, mountAt, mountRoot = mountAt) {
    const lat = [], detect = [], outcomes = {}, failures = [], intrAfter = {}; let nextOk = 0, finOk = 0;
    for (let i = 0; i < reps; i++) {
        Atomics.store(lab.intr, 0, 0);
        lab.policy = () => ({ mode: "normal" });
        await lab.mount(mountAt, mountRoot);   // a fresh mount: no cached nodes, so the first op goes over the channel
        lab.resetCounts();
        let blocked = null;
        const first = new Promise((res) => { lab.policy = (req) => (blockOn(req) ? (blocked ??= req, res(req), { mode: "never" }) : { mode: "normal" }); });
        const run = lab.run(code);
        await first;
        await sleep(5 + Math.random() * 60);   // a random phase against the worker's 50 ms slice
        const t = lab.stop(notify);
        const res = await Promise.race([run, sleep(10000).then(() => ({ hung: true }))]);
        if (res.hung) { failures.push({ rep: i, what: "cell never returned within 10 s of Stop" }); lab.policy = () => ({ mode: "normal" }); await lab.run("_r = '1'").catch(() => {}); break; }
        const v = res.value;
        const kind = res.error ? "error:" + res.error.split("\n").pop() : v?.outcome ?? "?";
        outcomes[kind] = (outcomes[kind] || 0) + 1;
        if (v?.fin != null) finOk++;
        if (v?.outcome === "KeyboardInterrupt") {
            lat.push(res.origin + v.t - res.clockOff - t);   // python clock -> worker clock -> wall
            if (res.detectedAt) detect.push(res.origin + res.detectedAt - t);
        }
        // The interrupt word after the handler ran: does CPython clear it itself? (0 = yes; 2 = our reset below is what clears it.)
        intrAfter[Atomics.load(lab.intr, 0)] = (intrAfter[Atomics.load(lab.intr, 0)] || 0) + 1;
        // the abandoned request's late reply, answered raw (no main-side stale guard), must not break the next cell
        Atomics.store(lab.intr, 0, 0);
        for (const r of lab.abandoned) lab.late(r, true);
        lab.policy = () => ({ mode: "normal" });
        // The next cell, every rep: the interpreter answers, and the mount (same mount, nodes cached from the interrupted cell) still lists and stats.
        const want = fs.readdirSync(mountAt).length;
        const after = await lab.run(`import json, os\n_r = json.dumps({"sum": 1 + 1, "n": len(os.listdir("${mountAt}")), "dir": os.path.isdir("${mountAt}")})`);
        if (after.error || after.value?.sum !== 2 || after.value?.n !== want || !after.value?.dir) failures.push({ rep: i, what: "next cell not normal", want, res: after });
        else nextOk++;
    }
    return { name, reps, notify, outcomes, interruptWordAfterHandler: intrAfter, nextCellNormal: nextOk, finallyOpsCompleted: finOk, stopToHandlerMs: rs(spread(lat)), stopToJsDetectMs: rs(spread(detect)), failures };
}

/** The cell every stop case runs: do `body` in a try, stamp the clock where KeyboardInterrupt (or anything else) lands. @param {string} body */
const stopCell = (body) => `import json, time
_fin = None
try:
${body.split("\n").map((l) => "    " + l).join("\n")}
    o = "completed"; t = 0
except KeyboardInterrupt:
    t = time.perf_counter() * 1000; o = "KeyboardInterrupt"
except BaseException as e:
    t = time.perf_counter() * 1000; o = type(e).__name__ + ": " + str(e)
_r = json.dumps({"outcome": o, "t": t, "fin": globals().get("_fin")})`;

/** Item 1: Stop latency, for each blocked operation, with the pure slice and with the stopper also notifying. @param {number} reps @param {{lockdown?: boolean}} o */
export async function itemStop(reps, o = {}) {
    const lab = new Lab(o);
    const boot = await lab.start();
    const big = path.join(SCRATCH, "stop-big.bin");
    fs.writeFileSync(big, Buffer.alloc(20 * 1024 * 1024, 7));
    const W = WORKSPACE, rows = [];
    const cases = [
        ["open().read(), blocked at the first lookup", stopCell(`open("${W}/package.json").read()`), () => true, W],
        ["open().read(), lookup answered, whole-file read blocked", stopCell(`open("${W}/package.json").read()`), (r) => r.op === "read", W],
        ["open().read() of 20 MB, blocked on the 3rd 4 MB chunk", stopCell(`open("${big}", "rb").read()`), (r) => r.op === "read" && r.off >= 8 * 1024 * 1024, path.dirname(big)],
        ["os.listdir, blocked at readdir", stopCell(`os.listdir("${W}")`.replace(/^/, "import os\n")), (r) => r.op === "readdir", W],
        ["open().read() in try/finally, blocked; the finally reads a second file (is the flag cleared once delivered?)", stopCell(`try:\n    open("${W}/package.json").read()\nfinally:\n    _fin = len(open("${W}/.nvmrc").read())`), (r) => r.path?.endsWith("package.json"), W],
        ["os.stat, blocked at the lookup", stopCell(`import os\nos.stat("${W}/package.json")`), (r) => r.op === "stat" && r.path.endsWith("package.json"), W],
    ];
    for (const notify of [false, true]) {
        for (const [name, code, blockOn, at] of cases) {
            rows.push(await stopCase(lab, name, code, blockOn, reps, notify, at));
            console.error(name, notify, JSON.stringify(rows.at(-1).stopToHandlerMs), JSON.stringify(rows.at(-1).outcomes));
        }
    }
    fs.rmSync(big, { force: true });
    await lab.close();
    return { boot, lockdown: !!o.lockdown, sliceMs: lab.o.sliceMs, rows };
}

// --- item 1b: a late reply to an abandoned id ------------------------------------------------------------------------

/**
 * Stop a cell blocked in a read of file A, then at once run a cell that reads file B while the host answers A's abandoned request late,
 * raw (no main-side stale guard), inside B's wait. B must come back with B's bytes. @param {number} reps @param {{lockdown?: boolean}} o
 */
export async function itemLate(reps, o = {}) {
    const lab = new Lab({ ...o, dropStale: false });
    await lab.start();
    const dir = path.join(SCRATCH, "late"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + "/a.txt", "A".repeat(3000)); fs.writeFileSync(dir + "/b.txt", "B".repeat(3000));
    let ok = 0; const bad = [];
    for (let i = 0; i < reps; i++) {
        Atomics.store(lab.intr, 0, 0); await lab.mount(dir); lab.resetCounts(); lab.policy = () => ({ mode: "normal" });
        let blocked; const first = new Promise((res) => { lab.policy = (req) => (req.path?.endsWith("a.txt") ? (res(), { mode: "never" }) : { mode: "normal" }); });
        const runA = lab.run(stopCell(`open("${dir}/a.txt").read()`));
        await first; await sleep(3 + Math.random() * 30);
        lab.stop(true);
        const a = await runA;
        const abandoned = lab.abandoned.slice();
        Atomics.store(lab.intr, 0, 0);
        // B's stat is delayed 40 ms; A's late reply lands inside that wait, then B's real reply follows.
        lab.policy = (req) => (req.path?.endsWith("b.txt") ? { mode: "delay", ms: 40 } : { mode: "normal" });
        const runB = lab.run(`import json\n_r = json.dumps({"b": open("${dir}/b.txt").read()[:5], "n": len(open("${dir}/b.txt").read())})`);
        await sleep(15);
        for (const r of abandoned) lab.late(r, true);   // the late reply, written raw into the data SAB and the reply word
        const b = await Promise.race([runB, sleep(8000).then(() => ({ hung: true }))]);
        if (b.hung) { bad.push({ rep: i, what: "B hung" }); break; }
        if (b.error || b.value?.b !== "BBBBB" || b.value?.n !== 3000 || a.value?.outcome !== "KeyboardInterrupt") bad.push({ rep: i, a: a.value, b });
        else ok++;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    await lab.close();
    return { reps, ok, bad };
}

// --- item 2: the cost of one round trip -------------------------------------------------------------------------------

/** Python source: time `n` calls of `body` (a statement block using `i`), per-call ms into `_t`. @param {string} body @param {number} n */
const timed = (name, setup, body, n) => `
${setup}
_ts = []
for i in range(${n}):
    _a = time.perf_counter()
${body.split("\n").map((l) => "    " + l).join("\n")}
    _ts.append((time.perf_counter() - _a) * 1000)
_all["${name}"] = _ts
`;

/** Item 2: per-op cost on the mount against MEMFS, and the raw SAB round trip. @param {number} n ops per case @param {{lockdown?: boolean}} o */
export async function itemCost(n, o = {}) {
    const lab = new Lab(o);
    const boot = await lab.start();
    const W = WORKSPACE;
    const scratch = path.join(SCRATCH, "cost"); fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(scratch + "/small.txt", "x".repeat(4096));
    fs.mkdirSync(scratch + "/d", { recursive: true });
    for (let i = 0; i < 40; i++) fs.writeFileSync(`${scratch}/d/f${i}`, "y");
    // Raw: no Python, no FS: a request posted, the reply word waited on in slices, in the worker.
    const ping = await lab.call({ cmd: "ping", n: 20 }); // warm
    const rawPing = (await lab.call({ cmd: "ping", n: Math.max(n, 2000) }));
    await lab.cfg({ listingCache: false });
    await lab.mount(scratch);
    // MEMFS twins
    const code = `import os, time, json
os.makedirs("/tmp/m/d", exist_ok=True)
open("/tmp/m/small.txt", "w").write("x" * 4096)
for _i in range(40): open(f"/tmp/m/d/f{_i}", "w").write("y")
_all = {}
${timed("stat existing, mount (getattr)", "", `os.stat("${scratch}/small.txt")`, n)}
${timed("stat existing, MEMFS", "", `os.stat("/tmp/m/small.txt")`, n)}
${timed("stat missing, mount (lookup miss)", "", `try:\n    os.stat("${scratch}/nope")\nexcept FileNotFoundError:\n    pass`, n)}
${timed("stat missing, MEMFS", "", `try:\n    os.stat("/tmp/m/nope")\nexcept FileNotFoundError:\n    pass`, n)}
${timed("open+read+close 4 KB text, mount", "", `with open("${scratch}/small.txt") as f: f.read()`, n)}
${timed("open+read+close 4 KB text, MEMFS", "", `with open("/tmp/m/small.txt") as f: f.read()`, n)}
${timed("listdir 40 entries, mount", "", `os.listdir("${scratch}/d")`, n)}
${timed("listdir 40 entries, MEMFS", "", `os.listdir("/tmp/m/d")`, n)}
${timed("scandir 40 entries + is_dir, mount, no listing cache", "", `[e.is_dir() for e in os.scandir("${scratch}/d")]`, Math.min(n, 100))}
${timed("scandir 40 entries + is_dir, MEMFS", "", `[e.is_dir() for e in os.scandir("/tmp/m/d")]`, n)}
_r = json.dumps(_all)
`;
    const counts = {};
    const res = await lab.run(code);
    if (res.error) throw new Error("cost cell: " + res.error);
    // Requests per op come from separate single-op runs (the cell above mixes them).
    const perOp = {};
    const probe = async (label, body) => { await lab.mount(scratch); const r = await lab.run(`import os\n${body}\n_r='1'`); perOp[label] = r.sent; };
    await probe("stat existing", `os.stat("${scratch}/small.txt")\nos.stat("${scratch}/small.txt")`);
    await probe("stat missing x2", `for _ in range(2):\n    try: os.stat("${scratch}/nope")\n    except FileNotFoundError: pass`);
    await probe("open+read+close x2", `for _ in range(2):\n    open("${scratch}/small.txt").read()`);
    await probe("listdir x2 (40 entries)", `os.listdir("${scratch}/d")\nos.listdir("${scratch}/d")`);
    // write path: open for write, write 4 KB, close: pushes
    const wt = (await lab.run(`import os, time, json
_ts = []
for _i in range(${Math.min(n, 100)}):
    _a = time.perf_counter()
    with open("${scratch}/w.txt", "w") as f: f.write("z" * 4096)
    _ts.append((time.perf_counter() - _a) * 1000)
_r = json.dumps(_ts)`, true));
    const wrote = fs.readFileSync(scratch + "/w.txt", "utf8").length;
    // The same stat/read cost with a rtt of the host forced to 1 ms and 5 ms (the product's chain is longer than one postMessage).
    const delayed = {};
    for (const ms of [1, 5]) {
        lab.policy = () => ({ mode: "delay", ms });
        await lab.mount(scratch);
        const r = await lab.run(`import os, time, json\n_ts=[]\nfor _i in range(30):\n    _a=time.perf_counter(); os.stat("${scratch}/small.txt"); _ts.append((time.perf_counter()-_a)*1000)\n_r=json.dumps(_ts)`);
        delayed[ms + " ms host delay, stat"] = rs(spread(r.value));
    }
    lab.policy = () => ({ mode: "normal" });
    fs.rmSync(scratch, { recursive: true, force: true });
    await lab.close();
    const out = {};
    for (const [k, v] of Object.entries(res.value)) out[k] = rs(spread(v));
    return { boot, lockdown: !!o.lockdown, n, rawSabRoundTripMs: rs(spread(rawPing)), perOpMs: out, writeClose4KB: { ms: rs(spread(wt.value)), landedBytes: wrote }, perOpRequests: perOp, withHostDelay: delayed };
}

// --- item 3: os.walk over the real workspace ---------------------------------------------------------------------------

/** Count what a walk of `dir` should see (files, dirs, symlinks listed once, symlinked directories not descended), on the host. @param {string} dir @param {string[]} hide */
function hostCount(dir, hide) {
    let files = 0, dirs = 0;
    const rec = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (hide.includes(e.name)) continue;
            if (e.isDirectory()) { dirs++; rec(d + "/" + e.name); } else files++;
        }
    };
    rec(dir);
    return { files, dirs };
}
/**
 * Item 3: `os.walk` of the worktree on the mount, with and without the per-directory listing cache (`readdir` returning each entry's stat),
 * with and without node_modules and .git hidden by the host; the first walk and a second walk in the same cell. @param {number} reps
 */
export async function itemWalk(reps, o = {}) {
    const W = WORKSPACE, rows = [];
    for (const hide of [[], ["node_modules", ".git"]]) {
        const truth = hostCount(W, hide);
        for (const [listingCache, dirCache] of [[false, false], [true, false], [true, true]]) {
            const lab = new Lab({ ...o, hide });
            await lab.start();
            await lab.cfg({ listingCache, dirCache });
            const first = [], second = [], reqs1 = [], reqs2 = [], by1 = [], by2 = [];
            let nf = 0, nd = 0, err = null;
            for (let i = 0; i < reps; i++) {
                await lab.mount(W); lab.resetCounts();
                const r = await lab.run(`import os, time, json
def walk():
    nf = nd = 0
    for r, ds, fs_ in os.walk("${W}"):
        nd += len(ds); nf += len(fs_)
    return nf, nd
a = time.perf_counter(); n1 = walk(); t1 = (time.perf_counter() - a) * 1000
_r = json.dumps({"t1": t1, "n1": n1})`);
                if (r.error) { err = r.error; break; }
                const c1 = { ...lab.counts }; lab.resetCounts();
                const r2 = await lab.run(`a = time.perf_counter(); n2 = walk(); t2 = (time.perf_counter() - a) * 1000
_r = json.dumps({"t2": t2, "n2": n2})`);
                if (r2.error) { err = r2.error; break; }
                const c2 = { ...lab.counts };
                first.push(r.value.t1); second.push(r2.value.t2); nf = r.value.n1[0]; nd = r.value.n1[1];
                reqs1.push(Object.values(c1).reduce((a, b) => a + b, 0)); reqs2.push(Object.values(c2).reduce((a, b) => a + b, 0)); by1.push(c1); by2.push(c2);
            }
            await lab.close();
            const entries = nf + nd;
            rows.push({ hidden: hide.join(",") || "(nothing)", listingCache, dirCache, hostTruth: truth, pythonSaw: { files: nf, dirs: nd }, reps: first.length, error: err,
                firstWalkMs: rs(spread(first)), secondWalkSameCellMs: rs(spread(second)),
                firstWalkRequests: rs(spread(reqs1)), firstWalkRequestsByOp: by1[0], secondWalkRequests: rs(spread(reqs2)), secondWalkRequestsByOp: by2[0],
                usPerEntryFirstWalk: entries ? r3(spread(first).median * 1000 / entries) : null });
            console.error("walk", rows.at(-1).hidden, listingCache, dirCache, rows.at(-1).firstWalkMs.median, "ms", entries, "entries");
        }
    }
    // The same walk against MEMFS, for the floor: copy the tree without node_modules/.git into MEMFS? Too large; walk the Pyodide's own /lib instead.
    return { workspace: W, rows };
}

// --- item 4: import over the mount -------------------------------------------------------------------------------------

/** Write a synthetic pure-Python package of 50 modules under `dir`. @param {string} dir @returns {string} the package name */
function makeSynth(dir) {
    const pk = path.join(dir, "synthpkg"); fs.rmSync(pk, { recursive: true, force: true }); fs.mkdirSync(pk, { recursive: true });
    let init = "";
    for (let i = 0; i < 50; i++) {
        const m = "m" + String(i).padStart(2, "0");
        const body = Array.from({ length: 12 }, (_, k) => `def f${k}(x, y=${k}):\n    """doc ${m}.f${k}"""\n    return (x * ${k + 1} + y) % 97\n`).join("\n");
        fs.writeFileSync(`${pk}/${m}.py`, `# ${m}\nimport os\nfrom dataclasses import dataclass\n\n@dataclass\nclass C${i}:\n    a: int = ${i}\n    b: str = "${m}"\n\n${body}`);
        init += `from . import ${m}\n`;
    }
    fs.writeFileSync(`${pk}/__init__.py`, init);
    return "synthpkg";
}
/** Count the files under a dir. @param {string} d @returns {number} */
const countFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? countFiles(d + "/" + e.name) : 1), 0);

/**
 * Item 4: cold `import` of a pure-Python tree, mounted and in MEMFS. Synthetic (50 modules, one `@dataclass` each) and a real one (pip's
 * vendored `rich`, copied out of Homebrew's site-packages). Each repeat starts from a fresh mount (no cached nodes) and purged sys.modules.
 * @param {number} reps @param {{lockdown?: boolean}} o
 */
export async function itemImport(reps, o = {}) {
    const base = path.join(SCRATCH, "import"); fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(base, { recursive: true });
    makeSynth(base);
    const pipSrc = "/opt/homebrew/lib/python3.14/site-packages/pip";
    const realOk = fs.existsSync(pipSrc);
    if (realOk) fs.cpSync(pipSrc, base + "/realsite/pip", { recursive: true, dereference: true, filter: (f) => !f.includes("__pycache__") });
    const cases = [["synthetic 50 modules", base, "synthpkg", countFiles(base + "/synthpkg")]];
    if (realOk) cases.push(["real: pip's vendored rich (pure Python), import pip._vendor.rich.table", base + "/realsite", "pip._vendor.rich.table", countFiles(base + "/realsite")]);
    const lab = new Lab(o);
    const boot = await lab.start();
    // copy twin into MEMFS: write each file into /tmp/twin<k>
    const out = [];
    for (const [name, dir, mod, nfiles] of cases) {
        const mem = "/tmp/twin_" + path.basename(dir);
        // Load the tree into MEMFS in one cell from base64 (the mount itself is not used, so MEMFS timing stays MEMFS).
        const files = []; const walkf = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "__pycache__") continue; if (e.isDirectory()) walkf(d + "/" + e.name, rel + e.name + "/"); else files.push([rel + e.name, fs.readFileSync(d + "/" + e.name).toString("base64")]); } };
        walkf(dir, "");
        await lab.run(`import os, base64, json
_files = json.loads(${JSON.stringify(JSON.stringify(files))})
for _p, _b in _files:
    _full = "${mem}/" + _p
    os.makedirs(os.path.dirname(_full), exist_ok=True)
    open(_full, "wb").write(base64.b64decode(_b))
_r = "1"`);
        const imp = (root, extra) => `import sys, time, json, importlib
${extra}
for _m in [m for m in sys.modules if m.split(".")[0] in ("synthpkg", "pip")]: del sys.modules[_m]
sys.path_importer_cache.clear(); importlib.invalidate_caches()
sys.path.insert(0, "${root}")
_n0 = len(sys.modules)
_a = time.perf_counter()
importlib.import_module("${mod}")
_t = (time.perf_counter() - _a) * 1000
sys.path.remove("${root}")
_r = json.dumps({"ms": _t, "modules": len(sys.modules) - _n0})`;
        const variants = [
            ["MEMFS, first import (the .pyc is written)", mem, null, "sys.dont_write_bytecode = False"],
            ["MEMFS, later import reads the .pyc", mem, null, "sys.dont_write_bytecode = False", true],
            ["mount read-only (no .pyc possible)", dir, { readOnly: true }, "sys.dont_write_bytecode = False"],
            ["mount, dont_write_bytecode", dir, { readOnly: false }, "sys.dont_write_bytecode = True"],
            ["mount read-write, first import writes .pyc", dir, { readOnly: false }, "sys.dont_write_bytecode = False"],
            ["mount read-write, second process reads .pyc", dir, { readOnly: false, keepPyc: true }, "sys.dont_write_bytecode = False"],
        ];
        for (const [vname, root, mcfg, extra, keepMem] of variants) {
            const ts = [], mods = [], reqs = [], by = [];
            let err = null;
            for (let i = 0; i < reps; i++) {
                if (mcfg) { await lab.cfg({ readOnly: mcfg.readOnly, listingCache: true }); await lab.mount(dir === root ? root : root); }
                else if (!keepMem) { await lab.run(`import shutil, os\nfor _d, _ds, _fs in os.walk("${root}"):\n    if "__pycache__" in _ds: shutil.rmtree(_d + "/__pycache__"); _ds.remove("__pycache__")\n_r="1"`); }
                if (mcfg && !mcfg.keepPyc) for (const d of walkDirs(dir)) fs.rmSync(d + "/__pycache__", { recursive: true, force: true });
                lab.resetCounts();
                const r = await lab.run(imp(root, extra));
                if (r.error) { err = r.error; break; }
                if (mcfg?.keepPyc && i === 0) {   // the pycs were not there for rep 0: that rep is the writing one; later reps read them
                    for (const x of []) { x; }
                }
                ts.push(r.value.ms); mods.push(r.value.modules); const c = { ...lab.counts }; by.push(c); reqs.push(Object.values(c).reduce((a, b) => a + b, 0));
            }
            if (mcfg?.keepPyc || keepMem) { ts.shift(); reqs.shift(); by.shift(); }   // drop the pyc-writing first rep
            out.push({ case: name, files: nfiles, variant: vname, reps: ts.length, error: err, importMs: rs(spread(ts)), modulesImported: mods[0], channelRequests: rs(spread(reqs)), requestsByOp: by[0] });
            console.error("import", name, vname, JSON.stringify(out.at(-1).importMs), reqs[0], err ?? "");
        }
    }
    await lab.close();
    fs.rmSync(base, { recursive: true, force: true });
    return { boot, realPackageAvailable: realOk, rows: out };
}
/** @param {string} d every directory under `d`, `d` included @returns {string[]} */
function walkDirs(d) { const out = [d]; for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) out.push(...walkDirs(d + "/" + e.name)); return out; }

// --- item 5: a large file opened whole ---------------------------------------------------------------------------------

/**
 * Item 5: open a sparse file of each size on the mount (the open fetches it whole into the worker), then read it from Python three ways:
 * `f.read()` into one bytes, `f.read(1 MiB)` in a loop (nothing retained), and `f.seek(n-1); f.read(1)`. Also the fetch's cost by chunk size
 * on 100 MB, and a size cap's refusal (`EFBIG`). @param {number[]} sizesMB @param {number} reps100 repeats for the 100 MB fetch @param {{lockdown?: boolean}} o
 */
export async function itemLarge(sizesMB, reps100, o = {}) {
    const dir = path.join(SCRATCH, "large"); fs.mkdirSync(dir, { recursive: true });
    const rows = [], sweep = [];
    const MB = 1024 * 1024;
    const freeGB = () => { try { const v = execSync("vm_stat").toString(); const ps = +/page size of (\d+)/.exec(v)[1]; const g = (k) => +new RegExp(k + ":\\s+(\\d+)").exec(v)[1]; return r3((g("Pages free") + g("Pages inactive") + g("Pages purgeable")) * ps / 2 ** 30); } catch { return null; } };
    // chunk-size sweep on 100 MB
    const f100 = path.join(dir, "f100.bin"); fs.closeSync(fs.openSync(f100, "w")); fs.truncateSync(f100, 100 * MB);
    for (const chunk of [64 * 1024, 1 * MB, 4 * MB, 16 * MB - 16]) {
        const lab = new Lab({ ...o, chunk }); await lab.start(); await lab.mount(dir);
        lab.resetCounts();
        const r = await lab.run(`import time, json
_ts = []
for _i in range(${reps100}):
    _a = time.perf_counter(); f = open("${f100}", "rb", buffering=0); _ts.append((time.perf_counter() - _a) * 1000); f.close()
_r = json.dumps(_ts)`);
        sweep.push({ chunkBytes: chunk, reps: r.value?.length, error: r.error, fetch100MBms: r.value ? rs(spread(r.value)) : null, requestsPerOpen: lab.counts.read && r.value ? lab.counts.read / r.value.length : null, MBperS_median: r.value ? r3(100 / (spread(r.value).median / 1000)) : null });
        console.error("chunk", chunk, JSON.stringify(sweep.at(-1).fetch100MBms), sweep.at(-1).error ?? "");
        await lab.close();
    }
    fs.rmSync(f100, { force: true });
    for (const mb of sizesMB) {
        const p = path.join(dir, `f${mb}.bin`); fs.closeSync(fs.openSync(p, "w")); fs.truncateSync(p, mb * MB);
        const reps = mb <= 100 ? 5 : mb <= 1024 ? 3 : 1;
        for (let rep = 0; rep < reps; rep++) {
            const lab = new Lab({ ...o }); await lab.start(); await lab.mount(dir); lab.resetCounts();
            const row = { sizeMB: mb, rep, freeGBBefore: freeGB() };
            const step = async (name, code) => { const a = performance.now(); try { const r = await lab.run(code); row[name] = { hostMs: r4(performance.now() - a), error: r.error, value: r.value }; } catch (e) { row[name] = { error: "WORKER: " + String(e.message).slice(0, 300) }; return false; } return true; };
            const open = `import time, json\nf = open("${p}", "rb", buffering=0)\n_r = json.dumps({})`;
            let ok = await step("open_fetch", open);
            if (ok && !row.open_fetch.error) {
                ok = await step("read_all", `import time, json\n_a = time.perf_counter()\ntry:\n    b = f.read()\n    _o = {"len": len(b)}\n    del b\nexcept BaseException as e:\n    _o = {"exc": type(e).__name__, "msg": str(e)[:200]}\n_o["ms"] = (time.perf_counter() - _a) * 1000\n_r = json.dumps(_o)`);
                if (ok) ok = await step("read_1MiB_loop", `import time, json\nf.seek(0)\n_a = time.perf_counter(); _n = 0\ntry:\n    while True:\n        c = f.read(1 << 20)\n        if not c: break\n        _n += len(c)\n    _o = {"len": _n}\nexcept BaseException as e:\n    _o = {"exc": type(e).__name__, "msg": str(e)[:200]}\n_o["ms"] = (time.perf_counter() - _a) * 1000\n_r = json.dumps(_o)`);
                if (ok) ok = await step("close", `import json\nf.close()\n_r = json.dumps({})`);
            }
            row.requests = { ...lab.counts };
            rows.push(row);
            console.error("large", mb, rep, JSON.stringify({ f: row.open_fetch?.hostMs, e: row.open_fetch?.error, ra: row.read_all?.value ?? row.read_all?.error }));
            await lab.close();
            if (row.open_fetch?.error || row.open_fetch?.hostMs === undefined) break;
        }
        // the cap: a file over `maxFetch` fails the open with EFBIG
        fs.rmSync(p, { force: true });
        if (mb <= 100) {
            const pp = path.join(dir, "cap.bin"); fs.closeSync(fs.openSync(pp, "w")); fs.truncateSync(pp, mb * MB);
            const lab = new Lab({ ...o }); await lab.start(); await lab.mount(dir); await lab.cfg({ maxFetch: 10 * MB });
            const r = await lab.run(`import json\ntry:\n    open("${pp}", "rb")\n    _o = "opened"\nexcept BaseException as e:\n    _o = type(e).__name__ + ": " + str(e)\n_r = json.dumps(_o)`);
            rows.push({ cap: `maxFetch 10 MB on a ${mb} MB file`, result: r.value, error: r.error, requests: { ...lab.counts } });
            await lab.close(); fs.rmSync(pp, { force: true });
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { chunkSweep: sweep, rows };
}
const r4 = (x) => Math.round(x * 100) / 100;

// --- item 6: the lockdown ------------------------------------------------------------------------------------------------

/** What a cell can reach of the channel's raw objects from Python, with the bridge refused (a normal readonly cell) and lifted (a cell approved for the browser's JavaScript). */
export async function itemReach() {
    const lab = new Lab({ lockdown: true });
    const boot = await lab.start();
    await lab.mount(WORKSPACE);
    const probe = `import json, sys
_o = {}
def _try(name, f):
    try:
        v = f()
        _o[name] = v if isinstance(v, (str, int, float, bool, list, dict, type(None))) else repr(v)[:200]
    except BaseException as e:
        _o[name] = "RAISED " + type(e).__name__ + ": " + str(e).splitlines()[0][:160] if str(e) else "RAISED " + type(e).__name__
def _js():
    import js
    return [k for k in ("postMessage", "parentPort", "process", "require", "chrome", "fetch", "Atomics", "SharedArrayBuffer", "FS", "Module", "__now", "navigator") if hasattr(js, k)]
_try("import js: globals present", _js)
def _js2():
    import js
    return js.Atomics.wait is not None and "can build a NEW SharedArrayBuffer: " + str(js.SharedArrayBuffer.new(8).byteLength)
_try("js.Atomics / new SharedArrayBuffer", _js2)
def _js3():
    import js
    return sorted(k for k in js.Object.getOwnPropertyNames(js.globalThis) if k[0].islower() or k.startswith("__"))[:80]
_try("js.globalThis lowercase and __ names", _js3)
def _js4():
    import js
    return str(js.Atomics.load(js.Int32Array.new(js.SharedArrayBuffer.new(8)), 0))
_try("Atomics on a fresh SAB", _js4)
def _pj():
    import pyodide_js
    return sorted(k for k in dir(pyodide_js) if not k.startswith("__"))[:40]
_try("import pyodide_js: names", _pj)
def _pj2():
    import pyodide_js
    return repr(pyodide_js._module)[:120]
_try("pyodide_js._module", _pj2)
def _pj3():
    import pyodide_js
    return repr(pyodide_js.FS)[:120]
_try("pyodide_js.FS", _pj3)
def _ffi():
    import pyodide.ffi as f
    return sorted(k for k in dir(f) if not k.startswith("_"))[:30]
_try("pyodide.ffi names", _ffi)
def _core():
    import _pyodide_core as c
    return sorted(k for k in dir(c) if not k.startswith("_"))[:30]
_try("import _pyodide_core", _core)
def _gc():
    import gc
    return sorted({type(o).__name__ for o in gc.get_objects() if "Js" in type(o).__name__})[:20]
_try("gc.get_objects: Js* types", _gc)
def _mods():
    return sorted(m for m in sys.modules if "js" in m.lower() or "pyodide" in m.lower() or "ffi" in m.lower())[:30]
_try("sys.modules with js/pyodide/ffi", _mods)
def _os():
    import os
    return [os.path.exists("/proc"), sorted(os.listdir("/proc"))[:8]]
_try("os /proc", _os)
_r = json.dumps(_o)`;
    const out = {};
    for (const on of [false, true]) {
        await lab.call({ cmd: "bridges", on });
        const r = await lab.run(probe);
        out[on ? "bridge lifted" : "bridge refused (the readonly default)"] = r.error ? { cellError: r.error } : r.value;
        await lab.call({ cmd: "bridges", on: false });
    }
    await lab.close();
    return { boot, probes: out };
}

// --- driver ------------------------------------------------------------------------------------------------------------

/** @returns {object} the machine this ran on */
function machine() {
    const sh = (c) => { try { return execSync(c).toString().trim(); } catch { return null; } };
    return { cpu: sh("sysctl -n machdep.cpu.brand_string"), cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, os: sh("uname -sr"), pyodide: "pyodide-core 314.0.3 (Python 3.14.0, restricted-mode fork build)", date: new Date().toISOString() };
}
const CAVEATS = [
    "The worker is a node:worker_threads Worker and the host a Node main thread: the channel is one postMessage hop plus a SharedArrayBuffer, not worker -> offscreen -> service worker -> wmlhost. Every figure is the sandbox side's floor; the product adds its hops.",
    "The host answers from the real disk with node:fs in-process, synchronously inside one event-loop turn. wmlhost's native-messaging, JSON and base64 costs are not here.",
    "Large files are sparse: the host reads zeros from holes without touching a disk, so the fetch figures are memory-copy speed, not I/O speed.",
    "Cells run through py.runPython (not the product's wrapUserCode harness, which needs numpy/pandas): the cell gate's begin/revoke window is not opened around them.",
    "The stop latency is stamped Python-side with time.perf_counter() (== performance.now() here, offset calibrated at boot) and host-side with Date-aligned performance.timeOrigin + now.",
];

/** CLI entry. */
async function main() {
    const args = process.argv.slice(2);
    const want = args.length ? args : ["stop", "cost", "walk", "import", "lockdown"];
    fs.mkdirSync(DATA, { recursive: true });
    const write = (name, obj) => { fs.writeFileSync(path.join(DATA, `node-${name}.json`), JSON.stringify({ machine: machine(), caveats: CAVEATS, ...obj }, null, 2) + "\n"); console.error("wrote", `data/node-${name}.json`); };
    for (const item of want) {
        if (item === "stop") write("stop", { item: "1: Stop latency during a blocked operation", stop: await itemStop(25), late: await itemLate(25) });
        else if (item === "cost") write("cost", { item: "2: one round trip", cost: await itemCost(500) });
        else if (item === "walk") write("walk", { item: "3: os.walk over the real workspace", walk: await itemWalk(20) });
        else if (item === "import") write("import", { item: "4: import over the mount", import: await itemImport(20) });
        else if (item === "large") write("large", { item: "5: a large file opened whole", large: await itemLarge([100, 512, 1024, 1536, 2047, 2048, 3072, 4096], 20) });
        else if (item === "lockdown") write("lockdown", { item: "6: under lockdownReadonly", stop: await itemStop(25, { lockdown: true }), late: await itemLate(25, { lockdown: true }), cost: await itemCost(500, { lockdown: true }), reach: await itemReach() });
        else console.error("unknown item", item);
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
