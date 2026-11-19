// files-mount-py.test.mjs — Python's `/files` in the real core: the mount (files-mount.ts) in the real worker
// (python-worker.ts, locked down as a run's worker is), its channel (files-wire.ts) served from a second thread over the
// in-memory reader. Every read is ranged, every write lands only on close, and nothing outside `agent/` is writable.

import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { PY_PACKAGE_LOADS } from "../src/python/python-env.ts";
import { allocFilesShared } from "../src/python/files-wire.ts";

const DIST = path.resolve(import.meta.dirname, "../dist");
const hasPyodide = fs.existsSync(path.join(DIST, "pyodide", "pyodide.mjs"));
// The boot's wheels beside the core are a precondition (python-bench-stop.test.mjs says why): skip, naming what is missing.
const missing = (() => {
    if (!hasPyodide) return ["dist/pyodide"];
    try {
        const pk = JSON.parse(fs.readFileSync(path.join(DIST, "pyodide", "pyodide-lock.json"), "utf8")).packages ?? {};
        return PY_PACKAGE_LOADS.map((n) => pk[n] ?? pk[Object.keys(pk).find((k) => k.toLowerCase() === n.toLowerCase()) ?? ""])
            .map((p, i) => (p?.file_name && fs.existsSync(path.join(DIST, "pyodide", p.file_name)) ? null : PY_PACKAGE_LOADS[i])).filter(Boolean);
    } catch { return ["pyodide-lock.json"]; }
})();
const skip = missing.length ? `run \`npm run build\` with the Pyodide core and wheels in place (missing: ${missing.join(", ")})` : false;
const T = { skip, timeout: 120000 };

const QUOTA = 4 * 1024 * 1024;
let shim = null, server = null, handler = null, nextId = 1, cid = 0;
const posted = [];
const flag = new Int32Array(new SharedArrayBuffer(4));
const replies = new Map();

/** Ask the server thread something (only while no cell is running: the main thread must be free to hear the answer). */
function ctl(op, ...args) {
    const id = ++cid;
    return new Promise((resolve, reject) => {
        replies.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.value)));
        server.postMessage({ ctl: { cid: id, op, args } });
    });
}
const text = (bytes) => (bytes ? Buffer.from(bytes).toString("utf8") : undefined);

before(async () => {
    if (skip) return;
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-files-"));
    fs.mkdirSync(path.join(shim, "pyodide"));
    fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
        `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    server = new Worker(new URL("./fixtures/files-server-thread.mjs", import.meta.url), { workerData: { quotaBytes: QUOTA, session: "s1" } });
    server.unref();
    const ready = new Promise((r) => server.on("message", (m) => { if (m?.ready) r(); else if (m?.cid) { replies.get(m.cid)?.(m); replies.delete(m.cid); } }));
    const shared = allocFilesShared();
    server.postMessage({ shared });
    await ready;
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        // The worker's `post`: a `/files` request goes straight to the server thread, synchronously, as the offscreen
        // document's `onmessage` would take it; the main thread then blocks in the mount's wait.
        postMessage: (m, transfer) => {
            if (m?.filesReq || typeof m?.filesAbandon === "number") server.postMessage(m, transfer ?? []);
            else posted.push(m);
        },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
    handler({ data: { interruptBuffer: flag } });
    handler({ data: { filesShared: shared } });
}, { timeout: 180000 });

after(() => {
    server?.terminate();
    if (shim) fs.rmSync(shim, { recursive: true, force: true });
});

/** Run one cell the way a worker-hosted run's outside cell is posted, and wait for its answer. */
async function cell(code) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null } });
    for (let i = 0; i < 12000; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no answer for cell " + id);
}
/** A cell that must succeed; its printed output. */
async function ok(code) {
    const r = await cell(code);
    assert.equal(r.ok, true, `${r.error ?? ""}\n${r.stdout ?? ""}`);
    return String(r.stdout ?? "").trim();
}

// --- the layout: what /files holds and where a write may go ---

test("the root lists attached/ and agent/ only, and an attached file reads back whole", T, async () => {
    await ctl("seed", "s1", "attached/h1/notes.txt", "hello from the person\n");
    assert.equal(await ok("import os\nprint(sorted(os.listdir('/files')))"), "['agent', 'attached']");
    assert.equal(await ok("print(open('/files/attached/h1/notes.txt').read(), end='')"), "hello from the person");
});

test("nothing outside agent/ is writable: the root, attached/ and agent itself answer EROFS", T, async () => {
    const out = await ok([
        "import errno, os",
        "def code(f):",
        "    try: f(); return 'ok'",
        "    except OSError as e: return errno.errorcode.get(e.errno, e.errno)",
        "print(code(lambda: open('/files/new.txt', 'w')))",
        "print(code(lambda: open('/files/attached/h1/notes.txt', 'w')))",
        "print(code(lambda: open('/files/attached/h1/notes.txt', 'a')))",
        "print(code(lambda: os.mkdir('/files/x')))",
        "print(code(lambda: os.rename('/files/attached/h1/notes.txt', '/files/agent/notes.txt')))",
        "print(code(lambda: os.unlink('/files/attached/h1/notes.txt')))",
        "print(code(lambda: os.symlink('/files/attached/h1/notes.txt', '/files/agent/link')))",
    ].join("\n"));
    assert.deepEqual(out.split("\n"), ["EROFS", "EROFS", "EROFS", "EROFS", "EROFS", "EROFS", "EPERM"]);
    assert.equal(text(await ctl("committed", "s1", "attached/h1/notes.txt")), "hello from the person\n");
});

test("a hidden file is listed by name, and reading it is refused", T, async () => {
    await ctl("seed", "s1", "attached/h1/.env", "API_KEY=sk-not-for-you\n");
    await ctl("hide", "s1", "attached/h1/.env");
    const out = await ok([
        "import os",
        "print('.env' in os.listdir('/files/attached/h1'))",
        "try: open('/files/attached/h1/.env').read(); print('read')",
        "except PermissionError: print('refused')",
    ].join("\n"));
    assert.deepEqual(out.split("\n"), ["True", "refused"]);
});

// --- reads are ranged: a seek reads its chunk, never the file ---

test("a seek into a large file reads only the chunks its buffer spans", T, async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await ctl("seed", "s1", "attached/h2/big.bin", new Uint8Array(big));
    const before = await ctl("reads");
    const out = await ok("f = open('/files/attached/h2/big.bin', 'rb')\nf.seek(2_500_000)\nprint(list(f.read(4)))\nf.close()");
    assert.deepEqual(JSON.parse(out), [...big.subarray(2_500_000, 2_500_004)]);
    // Python 3.14 buffers 128 KiB a read (io.DEFAULT_BUFFER_SIZE), so a read 2.5 MB in spans chunk 4 into chunk 5 and
    // fetches those two, and nothing of the other five.
    const calls = (await ctl("readCalls")).slice(before);
    assert.deepEqual(calls.map(([, at]) => at / (512 * 1024)), [4, 5], JSON.stringify(calls));
});

test("a whole read of a large file is one request per chunk, through the cache's fixed slots", T, async () => {
    const before = await ctl("reads");
    const out = await ok("import hashlib\nprint(len(open('/files/attached/h2/big.bin', 'rb').read()))");
    assert.equal(out, String(3 * 1024 * 1024 + 7));
    assert.equal((await ctl("reads")) - before, 7, "3 MiB + 7 bytes is seven 512 KiB chunks");
});

// --- writes land on close (ruling 75), and only under agent/ ---

test("a file written in agent/ lands when it is closed, not before", T, async () => {
    const out = await ok([
        "f = open('/files/agent/out.txt', 'w')",
        "f.write('first line\\n'); f.flush()",
        "try: open('/files/agent/out.txt').read(); print('seen before close')",
        "except FileNotFoundError: print('not yet')",
        "f.close()",
        "print(open('/files/agent/out.txt').read(), end='')",
    ].join("\n"));
    assert.deepEqual(out.split("\n"), ["not yet", "first line"]);
    assert.equal(text(await ctl("committed", "s1", "agent/out.txt")), "first line\n");
});

test("a failed cell keeps the files it already closed", T, async () => {
    const r = await cell("open('/files/agent/kept.txt', 'w').write('kept')\nraise RuntimeError('the cell fails after the close')");
    assert.equal(r.ok, false);
    assert.equal(text(await ctl("committed", "s1", "agent/kept.txt")), "kept");
});

test("append, overwrite in place and truncate all go to the same file", T, async () => {
    const out = await ok([
        "p = '/files/agent/edit.txt'",
        "open(p, 'w').write('0123456789')",
        "with open(p, 'a') as f: f.write('ab')",
        "with open(p, 'r+') as f: f.seek(2); f.write('XY')",
        "with open(p, 'r+') as f: f.truncate(9)",
        "print(open(p).read())",
    ].join("\n"));
    assert.equal(out, "01XY45678");
    assert.equal(text(await ctl("committed", "s1", "agent/edit.txt")), "01XY45678");
});

test("a zip written in agent/ (headers patched after the data) reads back", T, async () => {
    const out = await ok([
        "import zipfile",
        "with zipfile.ZipFile('/files/agent/a.zip', 'w', zipfile.ZIP_DEFLATED) as z:",
        "    z.writestr('a.txt', 'alpha' * 1000)",
        "    z.writestr('b.txt', 'beta')",
        "with zipfile.ZipFile('/files/agent/a.zip') as z: print(z.read('b.txt').decode(), len(z.read('a.txt')), z.testzip())",
    ].join("\n"));
    assert.equal(out, "beta 5000 None");
});

test("directories, renames and deletes in agent/", T, async () => {
    const out = await ok([
        "import os",
        "os.makedirs('/files/agent/d/e')",
        "open('/files/agent/d/e/x.txt', 'w').write('x')",
        "os.rename('/files/agent/d/e/x.txt', '/files/agent/d/y.txt')",
        "print(sorted(os.listdir('/files/agent/d')))",
        "os.unlink('/files/agent/d/y.txt'); os.rmdir('/files/agent/d/e'); os.rmdir('/files/agent/d')",
        "print(os.path.exists('/files/agent/d'))",
    ].join("\n"));
    assert.deepEqual(out.split("\n"), ["['e', 'y.txt']", "False"]);
    assert.equal(await ctl("committed", "s1", "agent/d/y.txt"), undefined);
});

test("pandas writes a CSV to agent/ and reads it back", T, async () => {
    const out = await ok([
        "import pandas as pd",
        "pd.DataFrame({'a': [1, 2], 'b': ['x', 'y']}).to_csv('/files/agent/t.csv', index=False)",
        "print(pd.read_csv('/files/agent/t.csv').to_dict('list'))",
    ].join("\n"));
    assert.equal(out, "{'a': [1, 2], 'b': ['x', 'y']}");
});

// --- the quota, and what a new cell sees ---

test("a write past the session's quota fails ENOSPC and lands nothing", T, async () => {
    const out = await ok([
        "import errno",
        "try:",
        "    with open('/files/agent/huge.bin', 'wb') as f: f.write(b'\\0' * (5 * 1024 * 1024))",
        "    print('written')",
        "except OSError as e: print(errno.errorcode.get(e.errno))",
    ].join("\n"));
    assert.equal(out, "ENOSPC");
    assert.equal(await ctl("committed", "s1", "agent/huge.bin"), undefined);
});

test("a file another front end adds between cells is seen by the next cell", T, async () => {
    assert.equal(await ok("import os\nprint('later.txt' in os.listdir('/files/agent'))"), "False");
    await ctl("seed", "s1", "agent/later.txt", "from ml.fs");
    assert.equal(await ok("print(open('/files/agent/later.txt').read())"), "from ml.fs");
});

// --- a Stop ends a blocked read ---

/**
 * The stop's writer, on its own thread (the main thread is blocked in the mount's wait and cannot run a timer): it
 * writes the stop `afterMs` after it starts and, if the flag is still set `failAfterMs` later, kills the PROCESS, since a
 * stop that never lands leaves the main thread waiting forever (python-bench-stop.test.mjs, the same backstop).
 */
const STOP_SRC = `
    const { workerData } = require('node:worker_threads');
    const a = new Int32Array(workerData.sab);
    const t0 = Date.now();
    while (Date.now() - t0 < workerData.afterMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    Atomics.store(a, 0, 2);
    const t1 = Date.now();
    while (Atomics.load(a, 0) === 2) {
        if (Date.now() - t1 > workerData.failAfterMs) { console.error('files-mount-py: the stop never ended the blocked read'); process.kill(process.pid, 'SIGKILL'); }
        Atomics.wait(a, 0, 2, 5);
    }
`;

test("a Stop during a read the reader has not answered ends the cell", T, async () => {
    // Held for 4 s: the stop lands at 1.5 s, and the read's late answer, at 4 s, must reach nothing.
    await ctl("holdReads", 4000);
    Atomics.store(flag, 0, 0);
    // Started before the cell, as the bench's writer is: the cell then blocks in the mount's wait, the read held.
    const writer = new Worker(STOP_SRC, { eval: true, execArgv: [], workerData: { sab: flag.buffer, afterMs: 1500, failAfterMs: 15000 } });
    const r = await cell("open('/files/attached/h2/big.bin', 'rb').read(10)");
    await writer.terminate();
    assert.equal(r.ok, false);
    assert.match(String(r.error ?? ""), /KeyboardInterrupt|interrupt/i);
    // The worker is usable again, and the abandoned read's late answer reached nothing.
    assert.equal(await ok("print(open('/files/attached/h1/notes.txt').read(), end='')"), "hello from the person");
});
