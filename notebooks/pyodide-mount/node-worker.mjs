// node-worker.mjs — the worker half of measure-node.mjs: real Pyodide with a prototype host-backed filesystem whose every op blocks on a sliced Atomics.wait.
// Runs inside a node:worker_threads Worker. The main thread (measure-node.mjs) serves the requests this worker posts and writes the
// replies into a SharedArrayBuffer. Mirrors route A of docs/spec/FILE_ATTACHMENTS.md ("The channel"): the worker posts a request, then
// waits on the reply word in slices of SLICE_MS, checking the interrupt buffer (the one `py.setInterruptBuffer` holds) between slices.
// Lab code: nothing here is imported by the product.

import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";

const { ctlSab, intrSab, dataSab, pyodideDir, lockdown, chunk, sliceMs, hdr } = workerData;
const ctl = new Int32Array(ctlSab);
const intr = new Int32Array(intrSab);
const data = new Uint8Array(dataSab);
/** Index of the reply id, status (0 ok, else an errno), and reply length in `ctl`. */
const RESP_ID = 0, RESP_STATUS = 1, RESP_LEN = 2;
const EINTR = 27;   // Emscripten's errno numbers: EINTR 27, EFBIG 22, ENOENT 44, EIO 29, EROFS 69
const td = new TextDecoder();

// Captured before any lockdown strip: the channel's raw objects live in closures from here on.
const post = parentPort.postMessage.bind(parentPort);
const wait = Atomics.wait, load = Atomics.load, now = () => performance.now();

/** Per-run counters and knobs the orchestrator sets with `{cmd: "cfg"}`. */
const cfg = { dirCache: false, readOnly: false, listingCache: true, maxFetch: Infinity, lastIntrAt: 0, sliceMs, lateAbandon: 0 };
let seq = 0;
/** Wall time of the last abandoned wait's detection, ms since the worker's timeOrigin (read back by the orchestrator). */
let detectedAt = 0;
let FS = null, ErrnoError = null;
/** Round trips this worker made, by op (the main thread counts too; the two must agree). */
const sent = {};

/**
 * Post one request and block until its reply, in slices.
 * @param {string} op the operation name
 * @param {object} args its arguments (structured-cloned to the main thread)
 * @returns {{status: number, len: number}} the reply header; the payload is in `data[0..len)`
 */
function request(op, args = {}) {
    const id = ++seq;
    sent[op] = (sent[op] || 0) + 1;
    let seen = load(ctl, RESP_ID);
    post({ t: "req", id, op, ...args });
    for (;;) {
        const cur = load(ctl, RESP_ID);
        if (cur === id) return { status: load(ctl, RESP_STATUS), len: load(ctl, RESP_LEN) };
        if (load(intr, 0) === 2) {
            detectedAt = now();
            post({ t: "abandon", id });
            throw new ErrnoError(EINTR);
        }
        if (cur !== seen) seen = cur;   // a stale reply for an abandoned id: ignored, keep waiting
        wait(ctl, RESP_ID, seen, cfg.sliceMs);
    }
}
/** @returns {any} the reply payload parsed as JSON */
function json(len) { return JSON.parse(td.decode(data.subarray(0, len))); }

/** Throw the errno a reply carries. */
function check(r) { if (r.status) throw new ErrnoError(r.status); }

/**
 * Build the host-backed filesystem type on `FS` (Emscripten's). Files are fetched whole on open and pushed whole on close; the
 * listing (names and stats) is cached per mount when `cfg.listingCache`. A fresh mount is a fresh cell.
 * @param {any} FSx Emscripten's FS
 * @returns {any} the filesystem type for `FS.mount`
 */
function makeHostFS(FSx) {
    const MEMFS = FSx.filesystems.MEMFS;
    const H = {
        mount(m) { return H.node(null, "/", 0o40755, ""); },
        node(parent, name, mode, hostPath) {
            const n = FSx.createNode(parent, name, mode, 0);
            n.node_ops = H.node_ops; n.stream_ops = H.stream_ops;
            n.hostPath = hostPath; n.contents = null; n.usedBytes = 0; n.dirty = false; n.attr = null;
            n.cache = new Map();   // stat by child name, primed by readdir
            return n;
        },
        node_ops: {
            getattr(n) {
                let a = n.attr;
                if (!a || !cfg.listingCache) {
                    const r = request("stat", { path: n.hostPath }); check(r); a = json(r.len);
                    n.attr = a;
                }
                const sz = n.contents ? n.usedBytes : a.size;
                return { dev: 1, ino: n.id, mode: a.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size: sz, atime: new Date(a.mtimeMs), mtime: new Date(a.mtimeMs), ctime: new Date(a.mtimeMs), blksize: 4096, blocks: Math.ceil(sz / 4096) };
            },
            setattr(n, attr) {
                if (attr.size !== undefined && n.contents) { MEMFS.node_ops.setattr(n, { size: attr.size }); n.dirty = true; }
            },
            lookup(parent, name) {
                const hp = parent.hostPath + "/" + name;
                let a = cfg.listingCache ? parent.cache.get(name) : null;
                if (!a) { const r = request("stat", { path: hp }); if (r.status) throw new ErrnoError(44); a = json(r.len); }
                const n = H.node(parent, name, a.mode, hp); n.attr = a; return n;
            },
            readdir(n) {
                if (cfg.dirCache && n.names) return n.names.slice();
                const r = request("readdir", { path: n.hostPath, withStat: cfg.listingCache }); check(r);
                const ents = json(r.len);
                const out = [".", ".."];
                for (const e of ents) { out.push(e.name); if (e.stat) n.cache.set(e.name, e.stat); }
                if (cfg.dirCache) n.names = out;
                return out.slice();
            },
            mknod(parent, name, mode) {
                if (cfg.readOnly) throw new ErrnoError(69);
                const hp = parent.hostPath + "/" + name;
                if (FSx.isDir(mode)) { check(request("mkdir", { path: hp })); const d = H.node(parent, name, mode, hp); d.attr = { mode, size: 4096, mtimeMs: Date.now() }; return d; }
                const n = H.node(parent, name, mode, hp); n.contents = new Uint8Array(0); n.dirty = true; n.attr = { mode, size: 0, mtimeMs: Date.now() };
                return n;
            },
            unlink(parent, name) { if (cfg.readOnly) throw new ErrnoError(69); check(request("unlink", { path: parent.hostPath + "/" + name })); },
            rmdir(parent, name) { if (cfg.readOnly) throw new ErrnoError(69); check(request("rmdir", { path: parent.hostPath + "/" + name })); },
            rename(old, newDir, newName) {
                if (cfg.readOnly) throw new ErrnoError(69);
                const np = newDir.hostPath + "/" + newName;
                check(request("rename", { from: old.hostPath, to: np }));
                old.hostPath = np;
                if (old.cacheDirty !== false) old.attr = old.attr;
            },
            symlink() { throw new ErrnoError(63); },
            readlink(n) { const r = request("readlink", { path: n.hostPath }); check(r); return json(r.len); },
            mkdir(parent, name, mode) {
                if (cfg.readOnly) throw new ErrnoError(69);   // EROFS
                const hp = parent.hostPath + "/" + name; check(request("mkdir", { path: hp }));
                const n = H.node(parent, name, 0o40000 | mode, hp); n.attr = { mode: 0o40000 | mode, size: 4096, mtimeMs: Date.now() }; return n;
            },
        },
        stream_ops: {
            open(stream) {
                const n = stream.node;
                if (!FSx.isFile(n.mode)) return;
                if (n.contents === null) {
                    if ((stream.flags & 0o1000) /* O_TRUNC */) { n.contents = new Uint8Array(0); n.usedBytes = 0; n.dirty = true; return; }
                    const first = request("read", { path: n.hostPath, off: 0, len: chunk }); check(first);
                    const total = json8(first.len);
                    if (total.size > cfg.maxFetch) throw new ErrnoError(22);   // EFBIG
                    const buf = new Uint8Array(total.size);
                    buf.set(data.subarray(16, 16 + total.n), 0);
                    let got = total.n;
                    while (got < total.size) {
                        const r = request("read", { path: n.hostPath, off: got, len: chunk }); check(r);
                        const t = json8(r.len);
                        buf.set(data.subarray(16, 16 + t.n), got); got += t.n;
                        if (t.n === 0) break;
                    }
                    n.contents = buf; n.usedBytes = total.size;
                }
            },
            close(stream) {
                const n = stream.node;
                if (n.dirty && FSx.isFile(n.mode)) {
                    const total = n.usedBytes;
                    let off = 0;
                    do {
                        const k = Math.min(chunk, total - off);
                        data.set(n.contents.subarray(off, off + k), 0);
                        check(request("put", { path: n.hostPath, off, len: k, last: off + k >= total }));
                        off += k;
                    } while (off < total);
                    n.dirty = false;
                }
                n.contents = null; n.usedBytes = 0;   // a re-open fetches afresh
            },
            read: MEMFS.stream_ops.read,
            write(stream, buffer, offset, length, position, canOwn) { stream.node.dirty = true; return MEMFS.stream_ops.write(stream, buffer, offset, length, position, canOwn); },
            llseek: MEMFS.stream_ops.llseek,
        },
    };
    return H;
}
/** Read the 16-byte binary header of a `read` reply: `{size, n}` (file size, bytes in this chunk). */
function json8(len) { const dv = new DataView(dataSab, 0, 16); return { size: Number(dv.getBigUint64(0, true)), n: Number(dv.getBigUint64(8, true)) }; }

let py = null, harness = null, bridges = null, wrapUserCode = null, injectInputs = null, hfs = null;
/** Python-clock to worker-clock offset (ms): perf_counter()*1000 - performance.now(). */
let clockOff = 0;

/**
 * Boot Pyodide, install the host filesystem type, optionally lock the realm down the way python-worker.ts does for READONLY.
 */
async function boot() {
    const { loadPyodide } = await import(path.join(pyodideDir, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: pyodideDir + "/", packageBaseUrl: pyodideDir + "/" });
    py.setInterruptBuffer(intr);
    py.setStdout({ batched: (s) => post({ t: "log", s }) }); py.setStderr({ batched: (s) => post({ t: "log", s: "ERR " + s }) });
    FS = py.FS; ErrnoError = FS.ErrnoError;
    hfs = makeHostFS(FS);
    // Clock calibration before the strip: Python's perf_counter against this realm's performance.now.
    globalThis.__now = () => performance.now();
    py.runPython("import js, time\n_cal=[]\nfor _ in range(50):\n    a=js.__now(); b=time.perf_counter()*1000; c=js.__now(); _cal.append(b-(a+c)/2)\n_cal.sort()");
    clockOff = py.runPython("_cal[len(_cal)//2]");
    let lock = null;
    if (lockdown) {
        const L = await import(path.resolve(workerData.repoRoot, "src/python/lockdown.ts"));
        lock = await L.lockdownReadonly(py, globalThis);
        harness = lock.harness; bridges = lock.bridges;
    }
    return { clockOff, lockdown: !!lockdown, pyVersion: py.version };
}

/** Mount the host filesystem at `at`, which is the real absolute path (parents created in MEMFS). Returns the stripped-down root. */
function mount(at, hostRoot = at) {
    try { FS.unmount(at); } catch { /* not mounted */ }
    FS.mkdirTree(at);
    FS.mount({ mount: (m) => hfs.node(null, "/", 0o40755, hostRoot) }, {}, at);
}

/** Run one cell of Python source and return its JSON-able result (a JSON string the cell leaves in `_r`). */
async function runCell(code) {
    py.globals.set("_r", undefined);
    try { py.runPython(code); } catch (e) { return { error: String(e.message ?? e).split("\n").slice(-4).join("\n"), value: null }; }
    const r = py.globals.get("_r");
    return { error: null, value: r === undefined ? null : JSON.parse(r) };
}

const ready = boot();
parentPort.on("message", async (m) => {
    if (m.cmd === "cfg") { Object.assign(cfg, m.cfg); return post({ t: "done", cid: m.cid, value: cfg }); }
    try {
        const info = await ready;
        if (m.cmd === "boot") return post({ t: "done", cid: m.cid, value: info });
        if (m.cmd === "mount") { mount(m.at, m.root); return post({ t: "done", cid: m.cid, value: true }); }
        if (m.cmd === "unmount") { try { FS.unmount(m.at); } catch (e) { /* */ } return post({ t: "done", cid: m.cid, value: true }); }
        if (m.cmd === "ping") {   // the raw SAB round trip, no Python and no FS
            const ts = [];
            for (let i = 0; i < m.n; i++) { const a = now(); request("ping"); ts.push(now() - a); }
            return post({ t: "done", cid: m.cid, value: ts });
        }
        if (m.cmd === "echo") {   // a raw round trip carrying `len` bytes back, to separate bandwidth from latency
            const ts = [];
            for (let i = 0; i < m.n; i++) { const a = now(); request("echo", { len: m.len }); ts.push(now() - a); }
            return post({ t: "done", cid: m.cid, value: ts });
        }
        if (m.cmd === "sent") { const s = { ...sent }; if (m.reset) for (const k of Object.keys(sent)) delete sent[k]; return post({ t: "done", cid: m.cid, value: s }); }
        if (m.cmd === "run") {
            if (m.reset) { for (const k of Object.keys(sent)) delete sent[k]; }
            const t0 = now();
            const r = await runCell(m.code);
            return post({ t: "done", cid: m.cid, value: { ...r, wallMs: now() - t0, detectedAt, clockOff, sent: { ...sent }, origin: performance.timeOrigin } });
        }
        if (m.cmd === "bridges") { bridges?.(m.on); return post({ t: "done", cid: m.cid, value: true }); }
    } catch (e) { post({ t: "done", cid: m.cid, error: String(e?.stack ?? e) }); }
});
