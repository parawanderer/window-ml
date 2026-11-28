// redteam-files-mount.test.mjs — `/files` in a run's Python reaches nothing outside the mount, and no run's worker reaches
// another's mount (FILE_ATTACHMENTS.md, "Python's view: two mounts"; rulings 36/37, 86, 57): a path that climbs out never
// reaches the reader, Python cannot make a link out, a refused open leaves no phantom, and each run's worker gets its own
// channel with its own session. The mount is files-mount.ts in the real worker against the in-memory reader.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { PY_PACKAGE_LOADS } from "../src/python/python-env.ts";
import { allocFilesShared } from "../src/python/files-wire.ts";
import { setFilesReader, attachFiles, filesMessage, detachFiles } from "../src/python/files-host.ts";

const DIST = path.resolve(import.meta.dirname, "../dist");
const hasPyodide = fs.existsSync(path.join(DIST, "pyodide", "pyodide.mjs"));
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

before(async () => {
    if (skip) return;
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-rt-files-"));
    fs.mkdirSync(path.join(shim, "pyodide"));
    fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
        `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    server = new Worker(new URL("./fixtures/redteam-files-server.mjs", import.meta.url), { workerData: { session: "rt-1" } });
    server.unref();
    const ready = new Promise((r) => server.on("message", (m) => { if (m?.ready) r(); else if (m?.cid) { replies.get(m.cid)?.(m); replies.delete(m.cid); } }));
    const shared = allocFilesShared();
    server.postMessage({ shared });
    await ready;
    await ctl("seed", "rt-1", "attached/h1/notes.txt", "hello");
    await ctl("seed", "rt-1", "agent/mine.txt", "mine");
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        postMessage: (m, transfer) => { if (m?.filesReq || typeof m?.filesAbandon === "number") server.postMessage(m, transfer ?? []); else posted.push(m); },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
    handler({ data: { interruptBuffer: flag } });
    handler({ data: { filesShared: shared, filesHome: "/files/agent" } });
}, { timeout: 180000 });

after(() => {
    server?.terminate();
    if (shim) fs.rmSync(shim, { recursive: true, force: true });
});

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
const ok = async (code, run) => { const r = await cell(code, run); assert.equal(r.ok, true, `${r.error ?? ""}\n${r.stdout ?? ""}`); return String(r.stdout ?? "").trim(); };
/** Every path the reader was asked for, as the mount spelled it. */
const askedPaths = async () => (await ctl("log")).filter((e) => typeof e[1] === "string").map((e) => e[1]);

// --- a path that climbs out of /files never reaches the reader ---

test("RED TEAM (files mount): a path that climbs out of /files is refused, and the reader is never asked for it", T, async (t) => {
    if (skip) return t.skip(skip);
    await ctl("log");
    const before = (await ctl("log")).length;
    const r = await cell([
        "import os",
        "out = []",
        "for p in ['/files/../etc/passwd', '/files/../../etc/passwd', '/files/agent/../../attached/h1/notes.txt', '/files/agent/../../../']:",
        "    try:",
        "        open(p).read(); out.append('READ ' + p)",
        "    except OSError as e:",
        "        out.append('refused')",
        "print(','.join(out))",
    ].join("\n"));
    assert.equal(r.ok, true, String(r.error ?? ""));
    const log = (await ctl("log")).slice(before);
    for (const e of log) {
        if (typeof e[1] !== "string") continue;
        assert.ok(!e[1].includes(".."), `the reader was asked for a non-canonical path: ${JSON.stringify(e)}`);
        assert.ok(!/^\/|^etc\b/.test(e[1]), `the reader was asked for an absolute or outside path: ${JSON.stringify(e)}`);
    }
    // positive control: a canonical read of the same file through the mount does reach the reader and returns its bytes.
    assert.equal(await ok("print(open('/files/attached/h1/notes.txt').read(), end='')"), "hello");
});

test("RED TEAM (files mount): chdir out of /files reaches the sandbox root, never makes attached/ writable or the shelf", T, async (t) => {
    if (skip) return t.skip(skip);
    const r = await cell([
        "import os",
        "os.chdir('/files/../..')",
        "cwd = os.getcwd()",
        "try:",
        "    open('/files/attached/rt-escape.txt', 'w').write('x'); erofs = False",
        "except OSError:",
        "    erofs = True",
        "print(cwd, erofs, os.path.exists('/files/attached/rt-escape.txt'))",
    ].join("\n"));
    assert.equal(r.ok, true, String(r.error ?? ""));
    const [cwd, erofs, exists] = String(r.stdout).trim().split(" ");
    assert.notEqual(cwd, "/files", `chdir stayed in the mount: ${r.stdout}`);
    assert.equal(erofs, "True", `attached/ became writable after chdir: ${r.stdout}`);
    assert.equal(exists, "False", r.stdout);
    assert.deepEqual((await ctl("list", "rt-1")).filter((p) => p.includes("rt-escape")), [], "a write landed in the shelf");
});

// --- nothing Python makes can point out of the mount ---

test("RED TEAM (files mount): a symbolic link is refused, so no link can point out of /files", T, async (t) => {
    if (skip) return t.skip(skip);
    const r = await cell([
        "import os",
        "out = []",
        "for f in ('symlink', 'link'):",
        "    try:",
        "        getattr(os, f)('/etc/passwd', '/files/agent/link-' + f); out.append(f + ' made')",
        "    except (OSError, AttributeError) as e:",
        "        out.append(f + ' refused')",
        "import os.path",
        "print(','.join(out), os.path.lexists('/files/agent/link-symlink'))",
    ].join("\n"));
    assert.equal(r.ok, true, String(r.error ?? ""));
    assert.match(String(r.stdout), /symlink refused/, r.stdout);
    assert.doesNotMatch(String(r.stdout), /symlink made|link made/, r.stdout);
    assert.match(String(r.stdout), /False\s*$/, `a link exists in the mount: ${r.stdout}`);
});

// --- a refused open leaves no phantom ---

test("RED TEAM (files mount): a write refused outside agent/ leaves no file behind, in the mount or for the reader", T, async (t) => {
    if (skip) return t.skip(skip);
    await ctl("log");
    const r = await cell([
        "import os",
        "try:",
        "    open('/files/attached/rt-phantom.txt', 'w').write('x'); wrote = True",
        "except OSError as e:",
        "    wrote = False",
        "print(wrote, os.path.exists('/files/attached/rt-phantom.txt'), sorted(os.listdir('/files')), sorted(os.listdir('/files/attached')))",
    ].join("\n"));
    assert.equal(r.ok, true, String(r.error ?? ""));
    assert.match(String(r.stdout).trim(), /^False False \['agent', 'attached'\] \['h1'\]$/, r.stdout);
    // The reader is asked (its EROFS is the refusal); what must not follow is a commit, and nothing may land.
    const log = (await ctl("log")).map((e) => e[0]);
    assert.ok(!log.includes("commitTx") || log.lastIndexOf("commitTx") < log.lastIndexOf("openWrite"), `a refused open was committed: ${log.join(",")}`);
    assert.ok(!(await ctl("committed", "rt-1", "attached/rt-phantom.txt")), "the phantom was committed");
});

// --- two runs, two channels, two sessions ---

test("RED TEAM (files mount): each run's worker gets its own channel with its own session, and a request is served by that run's alone", () => {
    const seen = [];
    setFilesReader(() => {
        const calls = [];
        const ch = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : k === "home" ? "/files/agent" : (...a) => { calls.push([k, ...a]); return Promise.resolve({ kind: "dir" }); }), has: () => true });
        const rec = { calls, ch };
        seen.push(rec);
        return ch;
    });
    try {
        const a = { posted: [], postMessage(m) { this.posted.push(m); } };
        const b = { posted: [], postMessage(m) { this.posted.push(m); } };
        attachFiles("run:aaa", a);
        attachFiles("run:bbb", b);
        assert.equal(seen.length, 2, "the two runs did not each get a channel");
        assert.deepEqual(seen[0].calls, [["setSession", "aaa"]]);
        assert.deepEqual(seen[1].calls, [["setSession", "bbb"]]);
        assert.notEqual(a.posted[0].filesShared, b.posted[0].filesShared, "the two runs share one channel's memory");
        // A request under run b's principal is served by b's channel alone.
        assert.equal(filesMessage("run:bbb", { filesReq: { id: 1, op: "stat", args: ["agent"] } }), true);
        return new Promise((r) => setTimeout(r, 20)).then(() => {
            assert.deepEqual(seen[1].calls.map((c) => c[0]), ["setSession", "stat"]);
            assert.deepEqual(seen[0].calls.map((c) => c[0]), ["setSession"], "run a's channel served run b's request");
            detachFiles("run:aaa");
            detachFiles("run:bbb");
            assert.deepEqual(seen[0].calls.map((c) => c[0]), ["setSession", "dispose"]);
        });
    } finally { setFilesReader(null); }
});

// --- two files under one shown name: both listed, and a lookup by it asks the reader ------------------------

// FILE_ATTACHMENTS.md's name rule at the mount (#2166): two files whose stored names mask to ONE shown name are both
// listed under it, and a lookup by it asks the reader, which refuses it as ambiguous. The cache is what is at stake,
// and it fails in both directions: answer a stat from the mount's `kids` and it succeeds, saying one arbitrary file's
// size; drop the name from `kids` altogether and the LISTING dies, because getdents looks up every name it returns
// and the reader's EACCES fails the whole call. The control is a file whose shown name is unique, which stats fine.
test("RED TEAM (files mount): two files under one shown name are both listed, and a stat or open by that name is refused, not answered from the cache", T, async (t) => {
    if (skip) return t.skip(skip);
    const SHOWN = "[REDACTED:RT]";
    await ctl("seed", "rt-1", "agent/v1", "one");
    await ctl("seed", "rt-1", "agent/v2", "two");
    await ctl("seed", "rt-1", "agent/only-v1", "three");
    await ctl("forms", [{ find: "v1", put: SHOWN }, { find: "v2", put: SHOWN }]);
    const before = (await ctl("log")).length;
    try {
        const r = await cell([
            "import os",
            "out = []",
            "try:",
            "    out.append('ls=' + ','.join(sorted(os.listdir('/files/agent'))))",
            "except OSError as e:",
            "    out.append('lsERR ' + type(e).__name__)",
            "try:",
            "    os.stat('/files/agent/" + SHOWN + "'); out.append('stat ok')",
            "except OSError as e:",
            "    out.append('stat ' + type(e).__name__)",
            "try:",
            "    open('/files/agent/" + SHOWN + "'); out.append('open ok')",
            "except OSError as e:",
            "    out.append('open ' + type(e).__name__)",
            "out.append('unique=' + str(os.stat('/files/agent/only-" + SHOWN + "').st_size))",
            "print(';'.join(out))",
        ].join("\n"));
        assert.equal(r.ok, true, String(r.error ?? ""));
        const out = String(r.stdout).trim();
        // Positive control: the collision is two entries under the one shown name, and a unique shown name resolves.
        assert.match(out, new RegExp(`ls=.*${SHOWN.replace(/[[\]]/g, "\\$&")},${SHOWN.replace(/[[\]]/g, "\\$&")}`), out);
        assert.match(out, /unique=5/, out);
        // Neither stored name reaches the cell: the listing carries what the reader shows, not what it stores.
        assert.doesNotMatch(out, /v1|v2/, `a stored name reached the cell: ${out}`);
        // The lookups: refused as ambiguous, which the mount can only learn by asking the reader.
        assert.match(out, /stat PermissionError/, `the mount answered a stat for an ambiguous shown name from its cache: ${out}`);
        assert.match(out, /open PermissionError/, `the mount answered an open for an ambiguous shown name from its cache: ${out}`);
        const asked = (await ctl("log")).slice(before).filter((e) => typeof e[1] === "string").map((e) => e[1]);
        assert.ok(asked.includes("agent/" + SHOWN), `the reader was never asked for the ambiguous shown name: ${asked.join(", ")}`);
    } finally { await ctl("forms", []); }
});
