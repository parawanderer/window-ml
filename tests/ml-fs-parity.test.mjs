// ml-fs-parity.test.mjs — one corpus of read scripts run against Node's `fs/promises` on a temp directory and against `ml.fs` over the same files, compared member by member.
// Spec: docs/spec/FILE_ATTACHMENTS.md, "`ml.fs`: Node's `fs/promises`, with a session's files as its disk", "Parity with Node, tested side by side" and "Narrower than Node". Unit rows: ml-fs.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import nodeFsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fsOver } from "./ml-fs-harness.mjs";

const T = { timeout: 10000 };
const enc = new TextEncoder();
const ALL = Uint8Array.from({ length: 256 }, (_, i) => i);

/** The corpus: every file's handle, name and bytes. `agent/` is an empty folder beside `attached/`. */
const CORPUS = [
    { handle: "h1", name: "notes.txt", bytes: enc.encode("alpha\nbeta\r\ngamma\n") },
    { handle: "h2", name: "utf8.txt", bytes: enc.encode("héllo wörld ✓ 日本語 😀\n") },
    { handle: "h3", name: "bom.txt", bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode("bom text")]) },
    { handle: "h4", name: "bad.bin", bytes: Uint8Array.from([0x41, 0xc3, 0x28, 0xff, 0xfe, 0x42, 0xe2, 0x82]) },
    { handle: "h5", name: "all.bin", bytes: ALL },
    { handle: "h6", name: "empty.txt", bytes: new Uint8Array(0) },
    { handle: "h7", name: "lines.txt", bytes: enc.encode("a\nb\r\nc\n\nd") },
];

let tmp;
let mine;
before(async () => {
    tmp = await nodeFsp.mkdtemp(path.join(os.tmpdir(), "mlfs-"));
    await nodeFsp.mkdir(path.join(tmp, "agent"));
    for (const f of CORPUS) {
        await nodeFsp.mkdir(path.join(tmp, "attached", f.handle), { recursive: true });
        await nodeFsp.writeFile(path.join(tmp, "attached", f.handle, f.name), f.bytes);
    }
    mine = fsOver({ forms: [], sessions: { s1: CORPUS } }).fs;
});
after(async () => { if (tmp) await nodeFsp.rm(tmp, { recursive: true, force: true }); });

/** A path as each side spells it: Node's under the temp directory, ml.fs's under `/files`. */
const NODE_P = (rel) => (rel ? path.join(tmp, rel) : tmp);
const ML_P = (rel) => (rel ? `/files/${rel}` : "/files");

/** A value reduced to what is compared: bytes as arrays, Stats and Dirents as their shared fields, the temp prefix as `/files`. */
function norm(v) {
    if (typeof v === "string") return v.split(tmp).join("/files");
    if (v instanceof Uint8Array) return { bytes: Array.from(v) };
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object" && typeof v.isFile === "function" && typeof v.isDirectory === "function") {
        const o = { isFile: v.isFile(), isDirectory: v.isDirectory(), isSymbolicLink: v.isSymbolicLink() };
        if ("size" in v) { // a Stats: directory sizes differ by design
            if (v.isFile()) o.size = v.size;
            o.mtimeMs = typeof v.mtimeMs;
        } else { o.name = v.name; o.parentPath = norm(v.parentPath); }
        return o;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
    return v;
}

/** What a script came to: its normalised value, or its error as `{ code, syscall, path }`. */
async function outcome(script, fs, P) {
    try { return { ok: norm(await script(fs, P)) }; }
    catch (e) { return { err: { code: e.code, syscall: e.syscall, path: norm(e.path) } }; }
}

/** Run one script on both sides and assert the same outcome; returns it, so a row can also pin what it came to. `noPath` leaves an error's `path` out of the comparison. */
async function both(script, { noPath = false } = {}) {
    const n = await outcome(script, nodeFsp, NODE_P);
    const m = await outcome(script, mine, ML_P);
    if (noPath) { if (n.err) delete n.err.path; if (m.err) delete m.err.path; }
    assert.deepEqual(m, n, "ml.fs differs from Node");
    return n;
}

/** The names a readdir gave, sorted: Node's order is the OS's. */
const sorted = (xs) => [...xs].sort((a, b) => (typeof a === "string" ? a : a.name).localeCompare(typeof b === "string" ? b : b.name) || 0);
const byParent = (xs) => [...xs].sort((a, b) => `${a.parentPath}/${a.name}`.localeCompare(`${b.parentPath}/${b.name}`));

// --- readFile: bytes, each encoding, each kind of content ---

const ENCODINGS = [undefined, "utf8", "utf-8", "latin1", "base64", "hex", { encoding: "utf8" }, { encoding: "hex" }, { encoding: "latin1" }];
const FILES = ["h1/notes.txt", "h2/utf8.txt", "h3/bom.txt", "h4/bad.bin", "h5/all.bin", "h6/empty.txt"];
for (const f of FILES) {
    test(`readFile ${f} reads the same in every encoding`, T, async () => {
        for (const e of ENCODINGS) {
            const r = await both((fs, P) => fs.readFile(P(`attached/${f}`), e));
            assert.ok("ok" in r, `${JSON.stringify(e)} read`);
        }
    });
}

test("readFile without an encoding is bytes on both sides", T, async () => {
    const r = await both((fs, P) => fs.readFile(P("attached/h5/all.bin")));
    assert.deepEqual(r.ok.bytes, Array.from(ALL));
});

test("readFile keeps the BOM and turns invalid UTF-8 into U+FFFD, as Node does", T, async () => {
    const bom = await both((fs, P) => fs.readFile(P("attached/h3/bom.txt"), "utf8"));
    assert.equal(bom.ok, "﻿bom text");
    const bad = await both((fs, P) => fs.readFile(P("attached/h4/bad.bin"), "utf8"));
    assert.ok(bad.ok.includes("�"));
});

// --- readdir ---

for (const dir of ["attached", "attached/h1", "agent", ""]) {
    test(`readdir ${JSON.stringify(dir)}: names, withFileTypes, recursive, both`, T, async () => {
        const plain = await both(async (fs, P) => sorted(await fs.readdir(P(dir))));
        const rec = await both(async (fs, P) => sorted(await fs.readdir(P(dir), { recursive: true })));
        const types = await both(async (fs, P) => sorted(await fs.readdir(P(dir), { withFileTypes: true })));
        const recTypes = await both(async (fs, P) => byParent(await fs.readdir(P(dir), { withFileTypes: true, recursive: true })));
        if (dir === "attached") {
            assert.equal(plain.ok.length, CORPUS.length);
            assert.ok(rec.ok.includes("h1/notes.txt"));
            assert.equal(recTypes.ok.length, CORPUS.length * 2);
        }
        assert.ok(types.ok && recTypes.ok);
    });
}

test("readdir: the encoding option 'utf8' and a trailing slash read as without", T, async () => {
    await both(async (fs, P) => sorted(await fs.readdir(P("attached"), "utf8")));
    await both(async (fs, P) => sorted(await fs.readdir(P("attached") + "/", { withFileTypes: true })));
});

// --- stat, lstat, access ---

test("stat and lstat of a file and a directory share size (files), kind flags and a numeric mtimeMs", T, async () => {
    for (const rel of ["attached/h1/notes.txt", "attached/h6/empty.txt", "attached/h5/all.bin", "attached", "attached/h1", "agent"]) {
        for (const call of ["stat", "lstat"]) {
            const r = await both((fs, P) => fs[call](P(rel)));
            assert.equal(r.ok.mtimeMs, "number");
        }
    }
    const f = await both((fs, P) => fs.stat(P("attached/h5/all.bin")));
    assert.deepEqual(f.ok, { isFile: true, isDirectory: false, isSymbolicLink: false, size: 256, mtimeMs: "number" });
});

test("ml.fs's Stats leaves the fields it cannot know ABSENT, where Node has them", T, async () => {
    const absent = ["ino", "dev", "uid", "gid", "nlink", "blocks", "atimeMs"];
    const ns = await nodeFsp.stat(NODE_P("attached/h1/notes.txt"));
    for (const k of absent) assert.ok(k in ns, `Node has ${k}`);
    for (const rel of ["attached/h1/notes.txt", "attached"]) {
        const s = await mine.stat(ML_P(rel));
        for (const k of absent) assert.ok(!(k in s), `ml.fs has no ${k}`);
        assert.equal(typeof s.mtimeMs, "number");
    }
});

test("access with F_OK and R_OK resolves on both, for a file and a directory", T, async () => {
    for (const rel of ["attached/h1/notes.txt", "attached"]) {
        for (const mode of [undefined, nodeFs.constants.F_OK, nodeFs.constants.R_OK]) {
            const r = await both((fs, P) => fs.access(P(rel), mode));
            assert.equal(r.ok, undefined);
        }
    }
});

// --- open and the handle ---

test("open('r') plus handle.read in the three forms, position null advancing and an explicit position not moving the handle", T, async () => {
    const r = await both(async (fs, P) => {
        const h = await fs.open(P("attached/h5/all.bin"), "r");
        const out = {};
        const a = Buffer.alloc(4);
        out.positional = await h.read(a, 0, 4, null);               // (buffer, offset, length, position)
        out.second = await h.read(Buffer.alloc(3), 0, 3, null);      // null advances: bytes 4..6
        out.explicit = await h.read(Buffer.alloc(2), 0, 2, 100);     // explicit: does not move the handle
        out.afterExplicit = await h.read(Buffer.alloc(2), 0, 2, null); // still 7..8
        out.opts = await h.read(Buffer.alloc(5), { offset: 1, length: 3, position: null }); // (buffer, options)
        out.objForm = await h.read({ buffer: Buffer.alloc(4), offset: 0, length: 2, position: 250 }); // (options)
        out.noOffset = await h.read(Buffer.alloc(2));                // (buffer) alone
        await h.close();
        return out;
    });
    assert.deepEqual(r.ok.positional.bytesRead, 4);
    assert.deepEqual(r.ok.explicit.buffer.bytes.slice(0, 2), [100, 101]);
    assert.deepEqual(r.ok.afterExplicit.buffer.bytes, [7, 8]);
});

test("handle.read reports bytesRead 0 at EOF and a short read at the tail, on a null and an explicit position", T, async () => {
    const r = await both(async (fs, P) => {
        const h = await fs.open(P("attached/h1/notes.txt"));
        const size = (await h.stat()).size;
        const out = {};
        out.tail = await h.read(Buffer.alloc(64), 0, 64, size - 3);
        out.eof = await h.read(Buffer.alloc(8), 0, 8, size);
        out.past = await h.read(Buffer.alloc(8), 0, 8, size + 100);
        out.whole = await h.read(Buffer.alloc(64), 0, 64, null);
        out.nullEof = await h.read(Buffer.alloc(8), 0, 8, null);
        out.zeroLen = await h.read(Buffer.alloc(8), 0, 0, null);
        await h.close();
        return out;
    });
    assert.equal(r.ok.eof.bytesRead, 0);
    assert.equal(r.ok.nullEof.bytesRead, 0);
});

test("handle.stat().size and handle.readFile from mid-position", T, async () => {
    const r = await both(async (fs, P) => {
        const h = await fs.open(P("attached/h1/notes.txt"));
        const out = { size: (await h.stat()).size, isFile: (await h.stat()).isFile() };
        await h.read(Buffer.alloc(6), 0, 6, null);
        out.rest = await h.readFile("utf8");
        out.restAgain = await h.readFile();
        await h.close();
        return out;
    });
    assert.equal(r.ok.rest, "beta\r\ngamma\n");
    assert.deepEqual(r.ok.restAgain.bytes, []);
});

test("handle.readLines over a file with \\n, \\r\\n and no final newline", T, async () => {
    const r = await both(async (fs, P) => {
        const h = await fs.open(P("attached/h7/lines.txt"));
        const out = [];
        for await (const l of h.readLines()) out.push(l);
        return out;
    });
    assert.deepEqual(r.ok, ["a", "b", "c", "", "d"]);
    const r2 = await both(async (fs, P) => {
        const h = await fs.open(P("attached/h1/notes.txt"));
        const out = [];
        for await (const l of h.readLines()) out.push(l);
        return out;
    });
    assert.deepEqual(r2.ok, ["alpha", "beta", "gamma"]);
});

test("closing a handle twice resolves both times; reading a closed handle is EBADF", T, async () => {
    const r = await both(async (fs, P) => {
        const h = await fs.open(P("attached/h1/notes.txt"));
        const out = {};
        out.first = await h.close();
        out.second = await h.close();
        try { await h.read(Buffer.alloc(2), 0, 2, null); } catch (e) { out.read = { code: e.code, syscall: e.syscall }; }
        try { await h.stat(); } catch (e) { out.stat = { code: e.code, syscall: e.syscall }; }
        return out;
    });
    assert.equal(r.ok.read.code, "EBADF");
});

// --- path cases ---

test("path cases: `..` inside the tree, `./`, doubled slashes, a trailing slash on a dir", T, async () => {
    const a = await both((fs, P) => fs.readFile(P("attached/h2/../h1/notes.txt"), "utf8"));
    assert.equal(a.ok, "alpha\nbeta\r\ngamma\n");
    await both((fs, P) => fs.readFile(P("attached/./h1/./notes.txt"), "utf8"));
    await both((fs, P) => fs.readFile(P("attached//h1//notes.txt"), "utf8"));
    await both(async (fs, P) => sorted(await fs.readdir(P("attached/") + "/")));
    await both((fs, P) => fs.stat(P("attached/h1") + "/"));
    await both((fs, P) => fs.stat(P("attached/h1") + "/."));
    const d = await both((fs, P) => fs.stat(P("attached/h1/../h2")));
    assert.equal(d.ok.isDirectory, true);
});

test("a trailing slash on a file is ENOTDIR for stat, lstat, access, open and readFile", T, async () => {
    for (const call of ["stat", "lstat", "access", "open", "readFile"]) {
        const r = await both((fs, P) => fs[call](P("attached/h1/notes.txt") + "/"));
        assert.equal(r.err.code, "ENOTDIR", call);
    }
});

// --- errors: the same code and syscall ---

test("ENOENT: readFile, stat, lstat, readdir, open, access of a missing path", T, async () => {
    for (const call of ["readFile", "stat", "lstat", "readdir", "open", "access"]) {
        for (const rel of ["attached/h1/missing.txt", "attached/nope", "nope", "attached/nope/deeper/x"]) {
            const r = await both((fs, P) => fs[call](P(rel)));
            assert.equal(r.err.code, "ENOENT", `${call} ${rel}`);
        }
    }
});

test("ENOTDIR: readdir of a file, stat and readFile and readdir through a file", T, async () => {
    const r = await both((fs, P) => fs.readdir(P("attached/h1/notes.txt")));
    assert.equal(r.err.code, "ENOTDIR");
    for (const call of ["stat", "lstat", "readFile", "readdir", "open", "access"]) {
        const x = await both((fs, P) => fs[call](P("attached/h1/notes.txt/x")));
        assert.equal(x.err.code, "ENOTDIR", call);
    }
    await both((fs, P) => fs.readdir(P("attached/h1/notes.txt"), { recursive: true }));
    await both((fs, P) => fs.readdir(P("attached/h1/notes.txt"), { withFileTypes: true }));
});

test("EISDIR: readFile of a directory; open a directory, then handle.read", T, async () => {
    for (const rel of ["attached", "attached/h1", "agent"]) {
        const r = await both((fs, P) => fs.readFile(P(rel)), { noPath: true });
        assert.equal(r.err.code, "EISDIR", rel);
        assert.equal(r.err.syscall, "read", rel);
        await both((fs, P) => fs.readFile(P(rel), "utf8"), { noPath: true });
    }
    const h = await both(async (fs, P) => {
        const handle = await fs.open(P("attached/h1"), "r");
        try { await handle.read(Buffer.alloc(8), 0, 8, null); } catch (e) { return { code: e.code, syscall: e.syscall }; } finally { await handle.close(); }
        return "read succeeded";
    });
    assert.deepEqual(h.ok, { code: "EISDIR", syscall: "read" });
    await both(async (fs, P) => {
        const handle = await fs.open(P("attached"), "r");
        try { await handle.readFile(); } catch (e) { return { code: e.code, syscall: e.syscall }; } finally { await handle.close(); }
        return "read succeeded";
    });
});

test("EISDIR from readFile of a directory carries the path, as Node's does", T, async () => {
    await both((fs, P) => fs.readFile(P("attached/h1")));
});

// --- narrower by design ---

/** Assert a call throws ERR_ML_FS_UNSUPPORTED synchronously, at the call: before any promise exists. */
function refusedAtTheCall(call, what) {
    let p;
    assert.throws(() => { p = call(); }, { code: "ERR_ML_FS_UNSUPPORTED" }, `${what} throws at the call`);
    assert.equal(p, undefined, `${what} returned nothing`);
}

test("Sync members and existsSync throw ERR_ML_FS_UNSUPPORTED at the call; Node answers them", T, async () => {
    const f = NODE_P("attached/h1/notes.txt");
    // Node: readFileSync returns a Buffer, existsSync a boolean, statSync a Stats.
    assert.equal(nodeFs.readFileSync(f, "utf8"), "alpha\nbeta\r\ngamma\n");
    assert.equal(nodeFs.existsSync(f), true);
    assert.equal(nodeFs.statSync(f).size, 18);
    for (const name of ["readFileSync", "existsSync", "statSync", "readdirSync", "openSync", "accessSync"])
        refusedAtTheCall(() => mine[name](ML_P("attached/h1/notes.txt")), name);
});

test("the callback form fs.readFile(p, cb) throws ERR_ML_FS_UNSUPPORTED at the call; Node's callback fs calls back", T, async () => {
    // Node: node:fs's readFile(p, cb) calls cb(null, data); fs/promises has no callback form.
    const data = await new Promise((res, rej) => nodeFs.readFile(NODE_P("attached/h1/notes.txt"), "utf8", (e, d) => (e ? rej(e) : res(d))));
    assert.equal(data, "alpha\nbeta\r\ngamma\n");
    let called = false;
    for (const name of ["readFile", "stat", "readdir", "access", "open"])
        refusedAtTheCall(() => mine[name](ML_P("attached/h1/notes.txt"), () => { called = true; }), `${name} with a callback`);
    assert.equal(called, false);
});

test("members ml.fs does not have throw ERR_ML_FS_UNSUPPORTED at the call", T, async () => {
    // Node: createWriteStream opens a write stream; watch an FSWatcher; chmod/symlink act; readlink reads a link;
    // mkdtemp makes a directory; statfs reports the volume. Run the harmless ones on the temp directory.
    const w = nodeFs.createWriteStream(NODE_P("agent/out.txt"));
    await new Promise((res) => w.end("x", res));
    const watcher = nodeFs.watch(NODE_P("agent")); watcher.close();
    await nodeFsp.chmod(NODE_P("agent/out.txt"), 0o600);
    await nodeFsp.symlink(NODE_P("agent/out.txt"), NODE_P("agent/link"));
    assert.equal(await nodeFsp.readlink(NODE_P("agent/link")), NODE_P("agent/out.txt"));
    const made = await nodeFsp.mkdtemp(NODE_P("agent/t-"));
    assert.ok(made.startsWith(NODE_P("agent/t-")));
    assert.equal(typeof (await nodeFsp.statfs(tmp)).bsize, "number");
    await nodeFsp.rm(NODE_P("agent/out.txt")); await nodeFsp.rm(NODE_P("agent/link")); await nodeFsp.rm(made, { recursive: true });

    const f = ML_P("attached/h1/notes.txt");
    refusedAtTheCall(() => mine.createWriteStream(ML_P("agent/out.txt")), "createWriteStream");
    refusedAtTheCall(() => mine.watch(ML_P("agent")), "watch");
    refusedAtTheCall(() => mine.chmod(f, 0o600), "chmod");
    refusedAtTheCall(() => mine.symlink(f, ML_P("agent/link")), "symlink");
    refusedAtTheCall(() => mine.readlink(f), "readlink");
    refusedAtTheCall(() => mine.mkdtemp(ML_P("agent/t-")), "mkdtemp");
    refusedAtTheCall(() => mine.statfs(ML_P("")), "statfs");
});

// --- createReadStream: the async-iterable part of Node's ReadStream ---

/** Every chunk a ReadStream yields, iterated: Node's from `node:fs`, ml.fs's from itself. Bytes become arrays. */
const chunks = (opts) => async (fs, P) => {
    const out = [];
    const s = (fs === nodeFsp ? nodeFs : fs).createReadStream(P("attached/h2/utf8.txt"), opts);
    for await (const c of s) out.push(typeof c === "string" ? c : [...c]);
    return { out, bytesRead: s.bytesRead };
};

test("createReadStream yields the chunks Node's yields: whole, a start/end range, a small highWaterMark, decoded", T, async () => {
    for (const opts of [undefined, { start: 3, end: 9 }, { highWaterMark: 4 }, { start: 2, highWaterMark: 5 }, { encoding: "utf8", highWaterMark: 3 }, "hex", { start: 0, end: 0 }])
        await both(chunks(opts));
});

test("createReadStream of a missing file fails its iteration with ENOENT, as Node's does", T, async () => {
    await both(async (fs, P) => { for await (const _ of (fs === nodeFsp ? nodeFs : fs).createReadStream(P("attached/h1/gone.txt"))) { /* none */ } });
});

test("a ReadStream's EventEmitter and pipe members throw ERR_ML_FS_UNSUPPORTED; Node's work", T, async () => {
    // Node: a ReadStream is an EventEmitter and pipes.
    const n = nodeFs.createReadStream(NODE_P("attached/h1/notes.txt"));
    await new Promise((res) => { n.on("data", () => {}); n.on("end", res); });
    const s = mine.createReadStream(ML_P("attached/h1/notes.txt"));
    for (const k of ["on", "once", "pipe", "addListener", "read", "setEncoding"]) refusedAtTheCall(() => s[k]("data", () => {}), `stream.${k}`);
});

test("the encoding 'ucs2' rejects with ERR_ML_FS_UNSUPPORTED; Node decodes it", T, async () => {
    // Node: Buffer decodes UTF-16LE.
    assert.equal(typeof (await nodeFsp.readFile(NODE_P("attached/h2/utf8.txt"), "ucs2")), "string");
    for (const e of ["ucs2", "utf16le", { encoding: "ucs2" }, "ascii"]) {
        await assert.rejects(mine.readFile(ML_P("attached/h2/utf8.txt"), e), { code: "ERR_ML_FS_UNSUPPORTED" }, JSON.stringify(e));
    }
});

test("writes are EROFS on ml.fs: writeFile, mkdir, unlink, rename, open 'w', access W_OK; Node succeeds", T, async () => {
    // Node: each of these works on the temp directory's agent/ folder.
    await nodeFsp.writeFile(NODE_P("agent/w.txt"), "x");
    await nodeFsp.mkdir(NODE_P("agent/sub"));
    await nodeFsp.rename(NODE_P("agent/w.txt"), NODE_P("agent/w2.txt"));
    await (await nodeFsp.open(NODE_P("agent/w2.txt"), "w")).close();
    await nodeFsp.access(NODE_P("agent/w2.txt"), nodeFs.constants.W_OK);
    await nodeFsp.unlink(NODE_P("agent/w2.txt"));
    await nodeFsp.rmdir(NODE_P("agent/sub"));

    const f = ML_P("attached/h1/notes.txt"), a = ML_P("agent/w.txt");
    const rows = [
        ["writeFile", () => mine.writeFile(a, "x"), "open"],
        ["appendFile", () => mine.appendFile(a, "x"), "open"],
        ["mkdir", () => mine.mkdir(ML_P("agent/sub")), "mkdir"],
        ["unlink", () => mine.unlink(f), "unlink"],
        ["rename", () => mine.rename(f, a), "rename"],
        ["open w", () => mine.open(a, "w"), "open"],
        ["open a", () => mine.open(a, "a"), "open"],
        ["open r+", () => mine.open(f, "r+"), "open"],
        ["access W_OK", () => mine.access(f, nodeFs.constants.W_OK), "access"],
        ["access R_OK|W_OK", () => mine.access(f, nodeFs.constants.R_OK | nodeFs.constants.W_OK), "access"],
    ];
    for (const [name, call, syscall] of rows) {
        await assert.rejects(call(), (e) => e.code === "EROFS" && e.syscall === syscall, name);
    }
});
