// ml-fs.test.mjs — `ml.fs`'s read members over every layer they cross (ml-fs-harness.mjs): Node's shapes and errors,
// the one root, the mask on text and bytes alike, what the worker forwards, the offscreen document's channels, and the
// isolated world's binding. Spec: docs/spec/FILE_ATTACHMENTS.md, "`ml.fs`: Node's `fs/promises`, with a session's files
// as its disk". Node parity, side by side with Node's own fs: ml-fs-parity.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fsOver } from "./ml-fs-harness.mjs";
import { ML_FS_READFILE_MAX, ML_FS_READ_MAX, resolveFsPath, Stats, Dirent } from "../src/ml/ml-fs.ts";
import { isoServer, ISO_REFUSED, ISO_FS_ASK_MAX, fsArgsOk } from "../src/sw/iso-channel.ts";
import { fsServer, FS_IDLE_MS, FS_CHANNELS_MAX } from "../src/session/fs-serve.ts";
import { fsCallFor, FS_CALL_FAILED } from "../src/sw/sw-fs-call.ts";
import { routeExec, execNames, surveyMayEnterPage, EXEC_REASONS } from "../src/sw/exec-routing.ts";
import { isolatedWrapper, isolatedMembers } from "../src/sw/sw-isolated-exec.ts";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";

const T = { timeout: 10000 };
const SECRET = "sk-live-0123456789abcdef";
const TEXT = "line one\nline two\r\nline three";

/** One session "s1" with a text file, a binary file and a file holding a secret; "s2" holds a file of its own. */
const files = (over = {}) => fsOver({
    forms: [{ find: SECRET }],
    sessions: {
        s1: [
            { handle: "h1", name: "notes.txt", bytes: TEXT },
            { handle: "h2", name: "blob.bin", bytes: Uint8Array.from([0, 1, 2, 0xfe, 0xff]) },
            { handle: "h3", name: "env.txt", bytes: `KEY=${SECRET}\n` },
        ],
        s2: [{ handle: "h9", name: "theirs.txt", bytes: "another session" }],
    },
    ...over,
});

/** The code, syscall and path of a rejection, for comparing errors as Node's are compared. */
const fails = async (p) => { try { await p; } catch (e) { return { code: e.code, syscall: e.syscall, path: e.path, message: e.message }; } assert.fail("did not reject"); };

// --- reading: Node's shapes ---

test("readFile with an encoding gives a string, without one a Uint8Array, in each supported encoding", T, async () => {
    const { fs } = files();
    assert.equal(await fs.readFile("/files/attached/h1/notes.txt", "utf8"), TEXT);
    assert.equal(await fs.readFile("/files/attached/h1/notes.txt", { encoding: "utf-8" }), TEXT);
    const b = await fs.readFile("/files/attached/h2/blob.bin");
    assert.ok(b instanceof Uint8Array);
    assert.deepEqual([...b], [0, 1, 2, 0xfe, 0xff]);
    assert.equal(await fs.readFile("/files/attached/h2/blob.bin", "hex"), "000102feff");
    assert.equal(await fs.readFile("/files/attached/h2/blob.bin", "base64"), Buffer.from([0, 1, 2, 0xfe, 0xff]).toString("base64"));
    assert.equal(await fs.readFile("/files/attached/h2/blob.bin", "latin1"), Buffer.from([0, 1, 2, 0xfe, 0xff]).toString("latin1"));
});

test("a UTF-8 read keeps a BOM and turns invalid bytes into U+FFFD, as Node's Buffer does", T, async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x41, 0xc3, 0x28]);
    const { fs } = fsOver({ sessions: { s1: [{ handle: "h1", name: "bom.txt", bytes }] } });
    assert.equal(await fs.readFile("/files/attached/h1/bom.txt", "utf8"), Buffer.from(bytes).toString("utf8"));
});

test("stat gives Node's fields the reader knows and leaves the rest absent, never zero", T, async () => {
    const { fs } = files();
    const s = await fs.stat("/files/attached/h1/notes.txt");
    assert.ok(s instanceof Stats);
    assert.equal(s.size, TEXT.length);
    assert.equal(s.isFile(), true);
    assert.equal(s.isDirectory(), false);
    assert.equal(s.isSymbolicLink(), false);
    assert.equal(s.mtimeMs, 5000);
    assert.equal(s.mtime.getTime(), 5000);
    for (const k of ["ino", "dev", "uid", "gid", "nlink", "blocks", "atimeMs", "mode"]) assert.equal(k in s, false, `${k} is absent`);
    const d = await fs.stat("/files/attached");
    assert.equal(d.isDirectory(), true);
    assert.deepEqual(await fs.lstat("/files/attached/h1/notes.txt"), s, "lstat answers as stat: no links exist");
});

test("readdir lists names, Dirents with withFileTypes, and every level with recursive", T, async () => {
    const { fs } = files();
    assert.deepEqual(await fs.readdir("/files"), ["agent", "attached"]);
    assert.deepEqual((await fs.readdir("/files/attached")).sort(), ["h1", "h2", "h3"]);
    const ents = await fs.readdir("/files/attached/h1", { withFileTypes: true });
    assert.equal(ents.length, 1);
    assert.ok(ents[0] instanceof Dirent);
    assert.deepEqual([ents[0].name, ents[0].parentPath, ents[0].isFile(), ents[0].isDirectory()], ["notes.txt", "/files/attached/h1", true, false]);
    assert.deepEqual((await fs.readdir("/files/attached", { recursive: true })).sort(), ["h1", "h1/notes.txt", "h2", "h2/blob.bin", "h3", "h3/env.txt"]);
    const deep = await fs.readdir("/files", { recursive: true, withFileTypes: true });
    assert.ok(deep.some((e) => e.name === "notes.txt" && e.parentPath === "/files/attached/h1"));
});

test("opendir pages the listing; a Dir iterates once and is closed after", T, async () => {
    const { fs } = files();
    const dir = await fs.opendir("/files/attached");
    const names = [];
    for await (const e of dir) names.push(e.name);
    assert.deepEqual(names.sort(), ["h1", "h2", "h3"]);
    assert.equal((await fails(dir.read())).code, "ERR_DIR_CLOSED");
});

test("access answers for a file that exists, EROFS for W_OK, EACCES for X_OK on a file, ENOENT for none", T, async () => {
    const { fs } = files();
    assert.equal(await fs.access("/files/attached/h1/notes.txt"), undefined);
    assert.equal(await fs.access("/files/attached/h1/notes.txt", fs.constants.R_OK), undefined);
    assert.equal((await fails(fs.access("/files/attached/h1/notes.txt", fs.constants.W_OK))).code, "EROFS");
    assert.equal((await fails(fs.access("/files/attached/h1/notes.txt", fs.constants.X_OK))).code, "EACCES");
    assert.deepEqual(await fails(fs.access("/files/nope")), { code: "ENOENT", syscall: "access", path: "/files/nope", message: "ENOENT: no such file or directory, access '/files/nope'" });
});

test("realpath answers the resolved path of a file that exists, and ENOENT for one that does not", T, async () => {
    const { fs } = files();
    assert.equal(await fs.realpath("attached/../attached/h1/notes.txt"), "/files/attached/h1/notes.txt");
    assert.equal(await fs.realpath("/"), "/files");
    assert.equal((await fails(fs.realpath("/files/gone"))).code, "ENOENT");
});

// --- handles ---

test("handle.read in each of Node's forms, with its own position, and bytesRead as Node's", T, async () => {
    const { fs } = files();
    const h = await fs.open("/files/attached/h1/notes.txt");
    const a = await h.read(new Uint8Array(4), 0, 4, null);
    assert.equal(Buffer.from(a.buffer).toString(), "line");
    const b = await h.read({ buffer: new Uint8Array(4) });
    assert.equal(Buffer.from(b.buffer).toString(), " one", "a null position reads on from the handle's own");
    const c = await h.read(new Uint8Array(8), { position: 0, length: 4 });
    assert.equal(Buffer.from(c.buffer.subarray(0, c.bytesRead)).toString(), "line", "a given position does not move the handle's");
    const d = await h.read({ buffer: new Uint8Array(3) });
    assert.equal(Buffer.from(d.buffer).toString(), "\nli");
    const end = await h.read(new Uint8Array(4), 0, 4, 10_000);
    assert.equal(end.bytesRead, 0, "past the end reads nothing");
    assert.equal((await h.read()).buffer.length, 16384, "with no buffer, Node's 16 KiB is allocated");
    assert.equal((await h.stat()).size, TEXT.length);
    await h.close();
    await h.close();
    assert.deepEqual(await fails(h.read(new Uint8Array(1))), { code: "EBADF", syscall: "read", path: undefined, message: "EBADF: bad file descriptor, read" });
});

test("a handle reads at most one chunk per call, and refuses a range outside its buffer as Node's RangeError", T, async () => {
    const big = new Uint8Array(ML_FS_READ_MAX * 2 + 10).fill(7);
    const { fs } = fsOver({ sessions: { s1: [{ handle: "h1", name: "big.bin", bytes: big }] } });
    const h = await fs.open("/files/attached/h1/big.bin");
    const r = await h.read(new Uint8Array(big.length), 0, big.length, 0);
    assert.equal(r.bytesRead, ML_FS_READ_MAX);
    assert.equal((await fails(h.read(new Uint8Array(4), 2, 4, 0))).code, "ERR_OUT_OF_RANGE");
    assert.equal((await h.readFile()).length, big.length, "handle.readFile reads on, chunk by chunk, from its position");
    await h.close();
});

test("readLines yields every line ending as Node's readline does, and closes the handle at the end", T, async () => {
    const { fs } = fsOver({ sessions: { s1: [{ handle: "h1", name: "l.txt", bytes: "a\nb\r\nc\rd\n\ne" }, { handle: "h2", name: "t.txt", bytes: "x\n" }, { handle: "h3", name: "e.txt", bytes: "" }] } });
    const lines = async (p) => { const h = await fs.open(p); const out = []; for await (const l of h.readLines()) out.push(l); return { out, h }; };
    const { out, h } = await lines("/files/attached/h1/l.txt");
    assert.deepEqual(out, ["a", "b", "c", "d", "", "e"]);
    assert.equal((await fails(h.read(new Uint8Array(1)))).code, "EBADF", "the handle closed with the iteration");
    assert.deepEqual((await lines("/files/attached/h2/t.txt")).out, ["x"], "a final newline makes no empty line");
    assert.deepEqual((await lines("/files/attached/h3/e.txt")).out, []);
});

test("readLines across chunk boundaries splits a line and a CRLF exactly once", T, async () => {
    const line = "x".repeat(ML_FS_READ_MAX - 1);
    const { fs } = fsOver({ sessions: { s1: [{ handle: "h1", name: "l.txt", bytes: `${line}\r\nnext\n` }] } });
    const out = [];
    for await (const l of (await fs.open("/files/attached/h1/l.txt")).readLines()) out.push(l);
    assert.deepEqual(out.map((l) => l.length), [line.length, 4]);
});

test("a folder opens, as Node's does, and reading it is EISDIR", T, async () => {
    const { fs } = files();
    const h = await fs.open("/files/attached");
    assert.equal((await fails(h.read(new Uint8Array(1)))).code, "EISDIR");
    await h.close();
    assert.deepEqual(await fails(fs.readFile("/files/attached")), { code: "EISDIR", syscall: "read", path: "/files/attached", message: "EISDIR: illegal operation on a directory, read '/files/attached'" });
});

test("readFile refuses past ML_FS_READFILE_MAX with Node's code, naming the ranged way", T, async () => {
    const { fs } = fsOver({ sessions: { s1: [{ handle: "h1", name: "huge.bin", bytes: new Uint8Array(ML_FS_READFILE_MAX + 1) }] } });
    const e = await fails(fs.readFile("/files/attached/h1/huge.bin"));
    assert.equal(e.code, "ERR_FS_FILE_TOO_LARGE");
    assert.match(e.message, /ml\.fs\.open\(\) and handle\.read\(\)/);
    assert.match(e.message, /handle\.readLines\(\)/);
});

// --- paths: one root ---

test("/files/x, /x and a relative x name one file; `..` stops at the root", T, async () => {
    const { fs } = files();
    for (const p of ["/files/attached/h1/notes.txt", "/attached/h1/notes.txt", "attached/h1/notes.txt", "./attached/h1/notes.txt", "/files/../../files/attached/h1/notes.txt", "/files/attached/h2/../h1/notes.txt"])
        assert.equal(await fs.readFile(p, "utf8"), TEXT, p);
    assert.deepEqual(resolveFsPath("/files/../../etc/passwd"), { rel: "etc/passwd", dirOnly: false });
    assert.equal((await fails(fs.readFile("/files/../../etc/passwd"))).code, "ENOENT", "a host path names nothing here");
});

test("another session's file is ENOENT with the message a missing file gets: the error never says why", T, async () => {
    const { fs } = files();
    const theirs = await fails(fs.readFile("/files/attached/h9/theirs.txt"));
    const none = await fails(fs.readFile("/files/attached/h8/theirs.txt"));
    assert.equal(theirs.code, "ENOENT");
    assert.equal(theirs.message.replace("h9", "h8"), none.message);
});

test("a trailing slash on a file is ENOTDIR; a path through a file is ENOTDIR; readdir of a file is ENOTDIR", T, async () => {
    const { fs } = files();
    assert.equal((await fails(fs.stat("/files/attached/h1/notes.txt/"))).code, "ENOTDIR");
    assert.equal((await fails(fs.readdir("/files/attached/h1/notes.txt"))).syscall, "scandir");
    assert.equal((await fails(fs.readdir("/files/attached/h1/notes.txt"))).code, "ENOTDIR");
});

test("a path that is not a string, or holds a NUL, is refused as Node refuses it", T, async () => {
    const { fs } = files();
    assert.equal((await fails(Promise.resolve().then(() => fs.readFile(42)))).code, "ERR_INVALID_ARG_TYPE");
    assert.equal((await fails(Promise.resolve().then(() => fs.stat("a\0b")))).code, "ERR_INVALID_ARG_VALUE");
    assert.equal(await fs.readFile(new TextEncoder().encode("/files/attached/h1/notes.txt"), "utf8"), TEXT, "a Uint8Array path, as Node's Buffer");
});

// --- the mask: one rule for text and bytes ---

test("a secret reads as `*` in a text read and a byte read alike, and a text read's length equals stat's size", T, async () => {
    const { fs } = files();
    const p = "/files/attached/h3/env.txt";
    const text = await fs.readFile(p, "utf8");
    assert.equal(text, `KEY=${"*".repeat(SECRET.length)}\n`);
    assert.equal(text.length, (await fs.stat(p)).size, "the mask keeps the length, so the text read's does too");
    const bytes = await fs.readFile(p);
    assert.equal(Buffer.from(bytes).toString(), text);
    assert.ok(!text.includes(SECRET) && !Buffer.from(bytes).includes(SECRET));
    const lines = [];
    for await (const l of (await fs.open(p)).readLines()) lines.push(l);
    assert.deepEqual(lines, [`KEY=${"*".repeat(SECRET.length)}`]);
    const h = await fs.open(p);
    const part = await h.read(new Uint8Array(6), 0, 6, 6);
    assert.equal(Buffer.from(part.buffer).toString(), "******", "a range inside the value is masked too");
});

// --- what is narrower than Node ---

test("every *Sync member, every callback form and each listed member refuses at the call with ERR_ML_FS_UNSUPPORTED", () => {
    const { fs } = files();
    for (const name of ["readFileSync", "existsSync", "statSync", "writeFileSync"]) assert.throws(() => fs[name]("/files"), { code: "ERR_ML_FS_UNSUPPORTED", message: /await ml\.fs\./ }, name);
    assert.throws(() => fs.readFile("/files/attached/h1/notes.txt", () => {}), { code: "ERR_ML_FS_UNSUPPORTED", message: /promise form/ });
    assert.throws(() => fs.stat("/files", "x", () => {}), { code: "ERR_ML_FS_UNSUPPORTED" });
    for (const name of ["createWriteStream", "watch", "watchFile", "unwatchFile", "chmod", "chown", "lchown", "utimes", "lutimes", "fchmod", "symlink", "link", "readlink", "mkdtemp", "statfs"])
        assert.throws(() => fs[name]("/files"), { code: "ERR_ML_FS_UNSUPPORTED" }, name);
});

test("an encoding outside the list is refused by name, with the list", T, async () => {
    const { fs } = files();
    const e = await fails(fs.readFile("/files/attached/h1/notes.txt", "ucs2"));
    assert.equal(e.code, "ERR_ML_FS_UNSUPPORTED");
    assert.match(e.message, /supported: utf8, utf-8, latin1, base64, hex/);
});

test("every write member, a write flag, and a readFile with a write flag reject EROFS until the write side lands", T, async () => {
    const { fs, sent } = files();
    const before = sent.length;
    for (const [name, syscall] of [["writeFile", "open"], ["appendFile", "open"], ["mkdir", "mkdir"], ["rmdir", "rmdir"], ["rm", "rm"], ["unlink", "unlink"], ["rename", "rename"], ["copyFile", "copyfile"], ["cp", "cp"], ["truncate", "open"]]) {
        const e = await fails(fs[name]("/files/agent/x", "data"));
        assert.deepEqual([e.code, e.syscall], ["EROFS", syscall], name);
    }
    for (const flag of ["w", "a", "r+", "wx", "w+", "a+", "ax", 1]) assert.equal((await fails(fs.open("/files/agent/x", flag))).code, "EROFS", String(flag));
    assert.equal((await fails(fs.readFile("/files/attached/h1/notes.txt", { flag: "w" }))).code, "EROFS");
    assert.equal(sent.length, before, "none of them reached the reader");
    const h = await fs.open("/files/attached/h1/notes.txt");
    assert.equal((await fails(h.write(new Uint8Array(1)))).code, "EBADF", "a read handle does not write, as Node's");
});

test("ml.fs.promises is ml.fs, and ml.fs cannot be changed by the script", () => {
    const { fs } = files();
    assert.equal(fs.promises, fs);
    assert.equal(Reflect.set(fs, "readFile", () => "x"), false);
    assert.equal(Reflect.deleteProperty(fs, "stat"), false);
    assert.equal(Reflect.defineProperty(fs, "x", { value: 1 }), false);
    assert.equal(typeof fs.readFile, "function");
});

// --- the worker forwards read ops alone ---

test("a script that calls the channel itself reaches the read ops alone: a write op or a bad shape is never forwarded", T, async () => {
    const { ask, sent } = files();
    const before = sent.length;
    for (const req of [
        { op: "fs", call: "openWrite", args: ["agent/x", "w", 1] },
        { op: "fs", call: "begin", args: [] },
        { op: "fs", call: "setSession", args: ["s2"] },
        { op: "fs", call: "dispose", args: [] },
        { op: "fs", call: "__proto__", args: [] },
        { op: "fs", call: "read", args: [3, 0, ML_FS_READ_MAX + 1] },
        { op: "fs", call: "read", args: [3, -1, 4] },
        { op: "fs", call: "stat", args: [{ toString: () => "x" }] },
        { op: "fs", call: "stat", args: ["a", "b"] },
        { op: "fs", call: "opendir", args: ["", { limit: 5, session: "s2" }] },
        { op: "fs", call: "stat", args: "attached" },
    ]) await assert.rejects(ask(req), { message: ISO_REFUSED.malformed }, JSON.stringify(req));
    assert.equal(sent.length, before);
    // The raw ops still read only this session's files, canonical paths only.
    assert.equal((await fails(ask({ op: "fs", call: "stat", args: ["attached/h9/theirs.txt"] }))).code, "ENOENT");
    assert.equal((await fails(ask({ op: "fs", call: "stat", args: ["../s2"] }))).code, "ENOENT");
});

test("the arguments each read op takes, enumerated", () => {
    const ok = [["stat", ["x"]], ["open", [""]], ["opendir", ["", { limit: 1 }]], ["opendir", ["a", { limit: 1, cursor: "c" }]], ["read", [0, 0, 1]], ["read", [1, 2, ML_FS_READ_MAX]], ["fstat", [0]], ["close", [9]]];
    const bad = [["stat", []], ["stat", [1]], ["open", ["a", "w"]], ["opendir", [""]], ["opendir", ["", null]], ["opendir", ["", { limit: -1 }]], ["opendir", ["", { limit: 1, cursor: 2 }]], ["read", [0, 0]], ["read", [0.5, 0, 1]], ["read", [0, 0, ML_FS_READ_MAX + 1]], ["fstat", ["0"]], ["close", []]];
    for (const [op, a] of ok) assert.equal(fsArgsOk(op, a), true, `${op} ${JSON.stringify(a)}`);
    for (const [op, a] of bad) assert.equal(fsArgsOk(op, a), false, `${op} ${JSON.stringify(a)}`);
});

test("ml.fs has its own request count, and an exec that did not name ml.fs has no ml.fs on the channel", T, async () => {
    const calls = [];
    const serve = isoServer("s1", [], { deref: () => undefined, holders: async () => null, columns: async () => ({}), fs: async (op, a) => { calls.push(op); return { ok: null }; } });
    for (let i = 0; i < ISO_FS_ASK_MAX; i++) await serve({ op: "fs", call: "fstat", args: [0] });
    assert.deepEqual(await serve({ op: "fs", call: "fstat", args: [0] }), { error: ISO_REFUSED.fsBudget });
    assert.equal(calls.length, ISO_FS_ASK_MAX);
    assert.deepEqual(await serve({ op: "pipe", i: 0, stages: [] }), { error: ISO_REFUSED.unnamed }, "the pointer reads' count is untouched");
    const none = isoServer("s1", [], { deref: () => undefined, holders: async () => null, columns: async () => ({}) });
    assert.deepEqual(await none({ op: "fs", call: "stat", args: [""] }), { error: ISO_REFUSED.noFs });
});

// --- the relay and the offscreen document's channels ---

test("the relay names the run's session and carries back a code alone, never the offscreen document's text", T, async () => {
    const sent = [];
    const leak = `could not read ${SECRET} at https://llm.internal.example/v1`;
    const r = fsCallFor("run-7", { send: async (m) => { sent.push(m); return m.type === "FS_CALL" ? { code: "ENOENT", error: leak } : undefined; } });
    assert.deepEqual(await r.fs("stat", ["x"]), { error: FS_CALL_FAILED, code: "ENOENT" });
    assert.equal(sent[0].session, "run-7");
    const thrown = fsCallFor("run-7", { send: async () => { throw new Error(leak); } });
    assert.deepEqual(await thrown.fs("stat", ["x"]), { error: FS_CALL_FAILED, code: "EIO" });
    const odd = fsCallFor("run-7", { send: async () => ({ code: `E ${leak}` }) });
    assert.deepEqual(await odd.fs("stat", ["x"]), { error: FS_CALL_FAILED, code: "EIO" }, "a code that is not an errno name is EIO");
    r.end();
    assert.deepEqual(sent.at(-1), { type: "FS_END", key: sent[0].key });
    const unused = [];
    fsCallFor("run-7", { send: async (m) => { unused.push(m); } }).end();
    assert.equal(unused.length, 0, "an exec that never read sends no end");
});

test("an exec's channel keeps its session, closes its descriptors at the end, and only read ops are served", T, async () => {
    const opened = [];
    const fake = () => { const ch = { session: null, disposed: false, setSession(s) { ch.session = s; }, dispose() { ch.disposed = true; }, stat: async (p) => ({ p, s: ch.session }), openWrite: async () => assert.fail("never called") }; opened.push(ch); return ch; };
    const server = fsServer(fake);
    assert.deepEqual(await server.call("k1", "s1", "stat", ["a"]), { ok: { p: "a", s: "s1" } });
    assert.deepEqual(await server.call("k1", "s2", "stat", ["a"]), { code: "EBADF" }, "a key keeps the session it was opened with");
    assert.deepEqual(await server.call("k1", "s1", "openWrite", ["a", "w", 1]), { code: "EINVAL" });
    assert.deepEqual(await server.call("k1", "s1", "setSession", ["s2"]), { code: "EINVAL" });
    for (const [k, s] of [["", "s1"], ["k", ""], [1, "s1"], ["k", null]]) assert.deepEqual(await server.call(k, s, "stat", ["a"]), { code: "EINVAL" });
    assert.equal(opened.length, 1);
    server.end("k1");
    assert.equal(opened[0].disposed, true);
    assert.equal(server.size(), 0);
});

test("a channel idle past FS_IDLE_MS closes, and past FS_CHANNELS_MAX the least recently used closes", T, async () => {
    let t = 0;
    const opened = [];
    const fake = () => { const ch = { disposed: false, setSession() {}, dispose() { ch.disposed = true; }, stat: async () => ({}) }; opened.push(ch); return ch; };
    const server = fsServer(fake, () => t);
    await server.call("old", "s1", "stat", [""]);
    t += FS_IDLE_MS + 1;
    await server.call("new", "s1", "stat", [""]);
    assert.equal(opened[0].disposed, true);
    for (let i = 0; i < FS_CHANNELS_MAX; i++) await server.call(`k${i}`, "s1", "stat", [""]);
    assert.equal(server.size(), FS_CHANNELS_MAX);
    assert.equal(opened[1].disposed, true, "the least recently used went first");
});

test("an error from the reader reaches the offscreen answer as its code alone", T, async () => {
    const server = fsServer(() => ({ setSession() {}, dispose() {}, stat: async () => { throw { code: "ENOENT", syscall: "stat", path: "x", message: `no x, key ${SECRET}` }; }, open: async () => { throw new Error(SECRET); } }));
    assert.deepEqual(await server.call("k", "s1", "stat", ["x"]), { code: "ENOENT" });
    assert.deepEqual(await server.call("k", "s1", "open", ["x"]), { code: "EIO" });
});

test("an exec's end closes the descriptors it opened in the offscreen document", T, async () => {
    const { fs, end, server } = files();
    await fs.open("/files/attached/h1/notes.txt");
    assert.equal(server.size(), 1);
    end();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(server.size(), 0);
});

// --- who may call it ---

test("a script naming ml.fs is read lexically, and runs only in an isolated world, never the page's", () => {
    assert.equal(execNames("return await ml.fs.readFile('/files/x', 'utf8')").fs, true);
    assert.equal(execNames("return ml\n  . fs.promises").fs, true);
    assert.equal(execNames("const fs = 1; return ml.fsx ?? fs").fs, false);
    assert.ok(EXEC_REASONS.includes("fs"));
    const js = "return (await ml.fs.readdir('/files')).length";
    assert.deepEqual(routeExec(js, true, { userScripts: true, cdp: true }), { where: "isolated", how: "userScripts", reason: "fs" });
    assert.deepEqual(routeExec(js, true, { userScripts: false, cdp: true }), { where: "isolated", how: "cdp", reason: "fs" });
    const none = routeExec(js, true, { userScripts: false, cdp: false });
    assert.equal(none.where, "refused");
    assert.match(none.result, /ml\.fs, which only an isolated world is given/);
    assert.equal(routeExec(js, true, { userScripts: true, cdp: true }, { world: "page" }).where, "refused");
    assert.match(routeExec(js, true, { userScripts: true, cdp: true }, { world: "page" }).result, /reads the session's files through ml\.fs/);
    assert.equal(routeExec(js, false, { userScripts: true, cdp: true }).reason, "unapproved-page");
    assert.equal(surveyMayEnterPage(js), false, "a survey naming ml.fs never goes to the page's interpreter");
});

test("the read-only dialect has no ml.fs, even when one is handed to it: no read member is free before the hide rule", T, async () => {
    // The dialect's facade copies functions only (policy.ts mlFacade), so an object member never reaches a survey. In the
    // worker's realm the missing member is NeedsPage, and the page leg is closed to a script whose route reason is "fs"
    // (surveyMayEnterPage, below), so it asks the person: the end-to-end row is isolated-exec.test.mjs, "an exec naming
    // ml.fs asks the person".
    const { fs } = files();
    assert.equal((await evalReadonly("typeof ml.fs", null, { getModel: async () => "m", fs })).value, "undefined");
    await assert.rejects(evalReadonly("ml.fs.readFile('/files/attached/h1/notes.txt', 'utf8')", null, { getModel: async () => "m", fs }), (e) => !(e instanceof NotInDialect || e instanceof Denied) && /undefined/.test(e.message));
});

// --- the isolated world's binding ---

/** Run the wrapper in a fresh context, with the channel answered by `fsOver`'s server. */
async function inWorld(js, b, ask) {
    const ctx = vm.createContext({ __ask: ask, console, TextDecoder, TextEncoder, atob, btoa, Uint8Array, Promise, Error, Date, Symbol, Object, JSON });
    return vm.runInContext(isolatedWrapper(js, b, "N1", "", ask ? "__ask" : ""), ctx);
}

test("an isolated exec that names ml.fs reads the session's files through the call's channel; one that does not has none", T, async () => {
    const { serve } = files();
    const ask = (req) => serve(req);
    const r = await inWorld("await ml.fs.readFile('/files/attached/h3/env.txt', 'utf8')", { reads: [], fs: true }, ask);
    assert.equal(r.v, `KEY=${"*".repeat(SECRET.length)}\n`);
    const missing = await inWorld("await ml.fs.stat('/files/nope')", { reads: [], fs: true }, ask);
    assert.match(missing.threw, /ENOENT: no such file or directory, stat '\/files\/nope'/);
    const unbound = await inWorld("ml.fs.readFile('/files/x')", { reads: [] }, ask);
    assert.match(unbound.threw, /ml\.fs is not available in this exec/);
    assert.deepEqual(isolatedMembers({ reads: [] }).includes("fs"), false);
    assert.deepEqual(isolatedMembers({ reads: [], fs: true }).includes("fs"), true);
});
