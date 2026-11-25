// FILES MOUNT, REAL READER: Python's `/files` mount over the product's own stack: the real RangedReader and the real
// store of run-made files (agent-files.ts, on fake-indexeddb), served by tests/fixtures/files-server-real.mjs. The
// mount's behaviour in detail is files-mount-py.test.mjs, over the in-memory fake. These rows hold that a file a cell
// writes and closes is a stored Blob, that it reads back, and that the quota and a discard behave the same end to end.
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
    server = new Worker(new URL("./fixtures/files-server-real.mjs", import.meta.url), { workerData: { quotaBytes: QUOTA, session: "s1" } });
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
    // As files-host posts it: the channel's memory and where the run writes, the reader's `home` (ruling 86).
    handler({ data: { filesShared: shared, filesHome: "/files/agent" } });
}, { timeout: 180000 });

after(() => {
    server?.terminate();
    if (shim) fs.rmSync(shim, { recursive: true, force: true });
});

/** Run one cell the way a worker-hosted run's outside cell is posted (`run` keeps its namespace), and wait for its answer. */
async function cell(code, run) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, ...(run ? { run } : {}) } });
    for (let i = 0; i < 12000; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no answer for cell " + id);
}
/** A cell that must succeed; its printed output. */
async function ok(code, run) {
    const r = await cell(code, run);
    assert.equal(r.ok, true, `${r.error ?? ""}\n${r.stdout ?? ""}`);
    return String(r.stdout ?? "").trim();
}

// --- a closed file is stored, and reads back ---

test("real reader: a file written and closed in agent/ is stored and reads back in the next cell", T, async () => {
    const out = await ok([
        "f = open('/files/agent/out.txt', 'w')",
        "f.write('first line\\n')",
        "try: open('/files/agent/out.txt').read(); print('seen before close')",
        "except FileNotFoundError: print('not yet')",
        "f.close()",
    ].join("\n"));
    assert.equal(out, "not yet");
    assert.equal(text(await ctl("committed", "s1", "agent/out.txt")), "first line\n");
    assert.equal(await ok("print(open('/files/agent/out.txt').read(), end='')"), "first line");
});

test("real reader: append, overwrite in place, truncate, folders and a rename all land in the store", T, async () => {
    const out = await ok([
        "import os",
        "os.makedirs('/files/agent/d/e')",
        "p = '/files/agent/d/e/edit.txt'",
        "open(p, 'w').write('0123456789')",
        "with open(p, 'a') as f: f.write('ab')",
        "with open(p, 'r+') as f: f.seek(2); f.write('XY')",
        "with open(p, 'r+') as f: f.truncate(9)",
        "os.rename(p, '/files/agent/d/moved.txt')",
        "print(sorted(os.listdir('/files/agent/d')), open('/files/agent/d/moved.txt').read())",
    ].join("\n"));
    assert.equal(out, "['e', 'moved.txt'] 01XY45678");
    assert.equal(text(await ctl("committed", "s1", "agent/d/moved.txt")), "01XY45678");
    assert.equal(await ctl("committed", "s1", "agent/d/e/edit.txt"), undefined);
});

test("real reader: a zip (headers patched after the data) and a pandas CSV round-trip through the store", T, async () => {
    const out = await ok([
        "import zipfile, pandas as pd",
        "with zipfile.ZipFile('/files/agent/a.zip', 'w', zipfile.ZIP_DEFLATED) as z:",
        "    z.writestr('a.txt', 'alpha' * 1000)",
        "with zipfile.ZipFile('/files/agent/a.zip') as z: print(len(z.read('a.txt')), z.testzip())",
        "pd.DataFrame({'a': [1, 2]}).to_csv('/files/agent/t.csv', index=False)",
        "print(pd.read_csv('/files/agent/t.csv').to_dict('list'))",
    ].join("\n"));
    assert.deepEqual(out.split("\n"), ["5000 None", "{'a': [1, 2]}"]);
});

test("real reader: a file another front end committed between cells is seen by the next cell", T, async () => {
    await ctl("seed", "s1", "agent/later.txt", "from ml.fs");
    assert.equal(await ok("print(open('/files/agent/later.txt').read())"), "from ml.fs");
});

// --- the quota ---

test("real reader: a write past the session's quota fails ENOSPC, lands nothing, and says what to do", T, async () => {
    const before = await ctl("usage", "s1");
    const out = await ok([
        "import errno",
        "try:",
        "    with open('/files/agent/huge.bin', 'wb') as f: f.write(b'\\0' * (5 * 1024 * 1024))",
        "    print('written')",
        "except OSError as e: print(errno.errorcode.get(e.errno))",
    ].join("\n"));
    assert.equal(out, "ENOSPC");
    assert.equal(await ctl("committed", "s1", "agent/huge.bin"), undefined);
    assert.equal(await ctl("usage", "s1"), before);
});

// --- a file open when the channel ends is discarded and noted (last: it ends the channel) ---

test("real reader: a file still open when the channel ends is discarded, never half-stored, and noted once", T, async () => {
    // A run's cells share a namespace, so the file object outlives the cell and stays open: a stateless cell's would be
    // collected at its end, which closes, and so commits, it.
    await ok("keep = open('/files/agent/open.txt', 'w')\nkeep.write('pending')", "run-keep");
    await ctl("dispose");
    assert.equal(await ctl("committed", "s1", "agent/open.txt"), undefined);
    const lost = await ctl("lost");
    assert.deepEqual(lost.map((l) => [l.session, l.path, l.reason]), [["s1", "agent/open.txt", "channel-ended"]]);
});
