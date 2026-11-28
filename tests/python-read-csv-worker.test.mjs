// python-read-csv-worker.test.mjs — `pd.read_csv` inside the read-only dialect in the REAL worker (python-worker.ts,
// locked down as a run's worker is) over the real `/files` mount, served from a second thread as files-mount-py.test.mjs
// serves it. What only the worker shows: the FIRST cell a worker runs can be an inside one, before any prelude has
// installed the loader redirect, so the setup must register the `pd.read_csv` a cell reaches; a hidden file under
// /files is listed by the mount but refused at open, so an inside read raises the full path's PermissionError; and the
// frame stays the run's, owned, for its later inside cells. The path and keyword rules are python-read-csv-inside's.

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
    // As files-host posts it: the channel's memory and where the run writes, the reader's `home` (ruling 86).
    handler({ data: { filesShared: shared, filesHome: "/files/agent" } });
}, { timeout: 180000 });

after(() => {
    server?.terminate();
    if (shim) fs.rmSync(shim, { recursive: true, force: true });
});

/** Run one cell the way a worker-hosted run's outside cell is posted (`run` keeps its namespace), and wait for its answer. */
async function cell(code, run, inside = false) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, ...(run ? { run } : {}), ...(inside ? { inside: true, libraries: [] } : {}) } });
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


const CSV = "region,amount\nnorth,1.5\nsouth,2.5\neast,4\n";

/** An inside cell's answer: what the model reads, and whether it asked. */
async function inside(code, run = "rc1") {
    const r = await cell(code, run, true);
    return { ok: r.ok, asked: r.notInDialect ?? null, stdout: String(r.stdout ?? "").trim(), error: r.error ?? null };
}

// --- the first cell of a worker, inside: the loader redirect is already the registered identity ---

test("the worker's very first cell, inside, reads an attached CSV with no card", T, async () => {
    await ctl("seed", "s1", "attached/h1/sales.csv", CSV);
    const r = await inside(`import pandas as pd\nsales = pd.read_csv("/files/attached/h1/sales.csv")\nprint(len(sales), float(sales["amount"].sum()))`);
    assert.deepStrictEqual([r.asked, r.ok, r.stdout], [null, true, "3 8.0"], JSON.stringify(r));
});

test("a later inside cell of the run edits the frame it read, unasked: the data is in a variable, owned", T, async () => {
    const r = await inside(`sales["double"] = sales["amount"] * 2\nprint(float(sales["double"].sum()))`);
    assert.deepStrictEqual([r.asked, r.ok, r.stdout], [null, true, "16.0"], JSON.stringify(r));
});

test("a relative path reads from the run's home, /files/agent, up into attached", T, async () => {
    const r = await inside(`import pandas as pd\nprint(len(pd.read_csv("../attached/h1/sales.csv")))`);
    assert.deepStrictEqual([r.asked, r.ok, r.stdout], [null, true, "3"], JSON.stringify(r));
});

// --- a hidden file: listed by the mount, refused at open, so the read raises as a full run's does ---

test("a hidden file under /files raises PermissionError inside, as on the full path, and asks nothing", T, async () => {
    await ctl("seed", "s1", "attached/h1/secret.csv", CSV);
    await ctl("hide", "s1", "attached/h1/secret.csv");
    const r = await inside(`import pandas as pd\npd.read_csv("/files/attached/h1/secret.csv")`);
    assert.equal(r.asked, null, JSON.stringify(r));
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /PermissionError/);
    const full = await cell(`import pandas as pd\npd.read_csv("/files/attached/h1/secret.csv")`, "rc1");
    assert.match(full.error ?? "", /PermissionError/);
});

test("ADVERSARIAL: a path outside /files asks in the worker too, and so does a URL", T, async () => {
    for (const src of ["/home/pyodide/x.csv", "/lib/python314.zip", "http://127.0.0.1/sales.csv", "file:///files/attached/h1/sales.csv"]) {
        const r = await inside(`import pandas as pd\npd.read_csv(${JSON.stringify(src)})`);
        assert.ok(r.asked, `${src}: ${JSON.stringify(r)}`);
    }
});
