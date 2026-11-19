// files-channel-fake.test.mjs — the in-memory `/files` channel double behaves as the reader's contract says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakeFiles } from "./fixtures/files-channel-fake.mjs";

const S = "sess1";
const dec = new TextDecoder();
const enc = new TextEncoder();

/** A fake with one channel already on session S. */
function setup(opts) {
    const fake = makeFakeFiles(opts);
    const ch = fake.channel();
    ch.setSession(S);
    return { fake, ch };
}
const code = (c) => (e) => e && e.code === c;
async function readAll(ch, fd, size) {
    const dest = new Uint8Array(size + 4);
    const n = await ch.read(fd, 0, size + 4, dest);
    return dec.decode(dest.subarray(0, n));
}
/** Write `text` to `path` in a fresh txn and commit it. */
async function put(ch, path, text) {
    const t = await ch.begin();
    const { wfd } = await ch.openWrite(path, "w", t);
    await ch.write(wfd, 0, enc.encode(text));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
}

// --- rule 1: the store and canonical paths ---

test("root, attached and agent always exist as dirs", async () => {
    const { ch } = setup();
    for (const p of ["", "attached", "agent"]) assert.equal((await ch.stat(p)).kind, "dir");
    const page = await ch.opendir("", { limit: 10 });
    assert.deepEqual(page.entries.map((e) => e.name), ["agent", "attached"]);
});

test("non-canonical paths reject ENOENT", async () => {
    const { ch } = setup();
    for (const p of ["/agent", "agent/", "agent//a", "agent/./a", "agent/../a", "./agent", "a//b"]) {
        await assert.rejects(ch.stat(p), code("ENOENT"), p);
    }
});

// --- rule 2: the session ---

test("every call rejects EBADF while the session is null", async () => {
    const fake = makeFakeFiles();
    const ch = fake.channel();
    await assert.rejects(ch.stat(""), code("EBADF"));
    await assert.rejects(ch.begin(), code("EBADF"));
    await assert.rejects(ch.open("agent/m1/x"), code("EBADF"));
});

test("a descriptor or txn used under another session rejects EBADF", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "attached/h/a.txt", "hi");
    const { fd } = await ch.open("attached/h/a.txt");
    const t = await ch.begin();
    ch.setSession("other");
    await assert.rejects(ch.read(fd, 0, 2, new Uint8Array(2)), code("EBADF"));
    await assert.rejects(ch.commitTx(t), code("EBADF"));
    await assert.rejects(ch.stat("", { txn: t }), code("EBADF"));
    ch.setSession(S);
    assert.equal(await ch.read(fd, 0, 2, new Uint8Array(2)), 2);
});

test("a call is judged against the session at the moment it is called", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/a", "x");
    const p = ch.stat("agent/m1/a");
    ch.setSession(null);
    assert.equal((await p).kind, "file");
});

// --- rule 3: errors ---

test("errors are plain FsError objects with the right codes", async () => {
    const { fake, ch } = setup({ hidden: ["agent/m1/h"] });
    fake.seed(S, "agent/m1/f", "x");
    fake.seed(S, "agent/m1/h", "x");
    fake.seed(S, "agent/m1/d/n", "x");
    const t = await ch.begin();
    const e = await ch.stat("agent/m1/missing").catch((x) => x);
    assert.equal(Object.getPrototypeOf(e), Object.prototype);
    assert.deepEqual(Object.keys(e).sort(), ["code", "message", "path", "syscall"]);
    await assert.rejects(ch.opendir("agent/m1/f", { limit: 1 }), code("ENOTDIR"));
    await assert.rejects(ch.mkdir("agent/m1/f/z", t), code("ENOTDIR"));
    await assert.rejects(ch.open("agent/m1/d"), code("EISDIR"));
    await assert.rejects(ch.openWrite("agent/m1/d", "w", t), code("EISDIR"));
    await assert.rejects(ch.read(999, 0, 1, new Uint8Array(1)), code("EBADF"));
    await assert.rejects(ch.commitTx(999), code("EBADF"));
    await assert.rejects(ch.open("agent/m1/h"), (x) => x.code === "EACCES" && /hidden/.test(x.message));
    await assert.rejects(ch.openWrite("agent/m1/f", "x", t), code("EEXIST"));
    await assert.rejects(ch.mkdir("agent/m1/d", t), code("EEXIST"));
    await assert.rejects(ch.rmdir("agent/m1/d", t), code("ENOTEMPTY"));
    await assert.rejects(ch.mkdir("agent/m1/q/r", t), code("ENOENT"));
    await assert.rejects(ch.read(999, -1, 1, new Uint8Array(1)), code("EBADF"));
});

test("EROFS for every write at the root or into attached/", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "attached/h/a.txt", "x");
    fake.seed(S, "agent/m1/f", "x");
    const t = await ch.begin();
    await assert.rejects(ch.openWrite("attached/h/a.txt", "w", t), code("EROFS"));
    await assert.rejects(ch.openWrite("top.txt", "w", t), code("EROFS"));
    await assert.rejects(ch.openWrite("", "w", t), code("EROFS"));
    await assert.rejects(ch.mkdir("attached/new", t), code("EROFS"));
    await assert.rejects(ch.mkdir("attached", t), code("EROFS"));
    await assert.rejects(ch.mkdir("top", t), code("EROFS"));
    await assert.rejects(ch.unlink("attached/h/a.txt", t), code("EROFS"));
    await assert.rejects(ch.unlink("", t), code("EROFS"));
    await assert.rejects(ch.rmdir("", t), code("EROFS"));
    await assert.rejects(ch.rmdir("attached/h", t), code("EROFS"));
    await assert.rejects(ch.rename("agent/m1/f", "attached/f", t), code("EROFS"));
    await assert.rejects(ch.rename("attached/h/a.txt", "agent/m1/f2", t), code("EROFS"));
    await assert.rejects(ch.rename("", "agent/m1/x", t), code("EROFS"));
    await assert.rejects(ch.rename("agent/m1/f", "", t), code("EROFS"));
});

// --- ruling 81: a run writes only in its own folder ---

test("home is /files/agent/<folder> after setSession, undefined before", async () => {
    const fake = makeFakeFiles();
    const ch = fake.channel();
    assert.equal(ch.home, undefined);
    ch.setSession(S);
    assert.equal(ch.home, "/files/agent/m1");
    const named = makeFakeFiles({ folderOf: (s) => "f-" + s }).channel();
    named.setSession("zz");
    assert.equal(named.home, "/files/agent/f-zz");
    assert.throws(() => { "use strict"; named.home = "x"; }, TypeError);
});

test("the own folder exists empty before any write and does not count toward the quota", async () => {
    const { ch } = setup({ quotaBytes: 0 });
    const st = await ch.stat("agent/m1");
    assert.equal(st.kind, "dir");
    assert.deepEqual((await ch.opendir("agent", { limit: 10 })).entries.map((e) => e.name), ["m1"]);
    assert.deepEqual((await ch.opendir("agent/m1", { limit: 10 })).entries, []);
});

test("mkdir of the own folder is EEXIST; rmdir, unlink, rename and openWrite of it are EACCES", async () => {
    const { ch } = setup();
    const t = await ch.begin();
    await assert.rejects(ch.mkdir("agent/m1", t), code("EEXIST"));
    await assert.rejects(ch.rmdir("agent/m1", t), code("EACCES"));
    await assert.rejects(ch.unlink("agent/m1", t), code("EACCES"));
    await assert.rejects(ch.openWrite("agent/m1", "w", t), code("EACCES"));
    await assert.rejects(ch.rename("agent/m1", "agent/m1/x", t), code("EACCES"));
});

test("agent itself and a new name directly in agent/ are EACCES", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "x");
    const t = await ch.begin();
    await assert.rejects(ch.rmdir("agent", t), code("EACCES"));
    await assert.rejects(ch.unlink("agent", t), code("EACCES"));
    await assert.rejects(ch.mkdir("agent", t), code("EACCES"));
    await assert.rejects(ch.mkdir("agent/new", t), code("EACCES"));
    await assert.rejects(ch.openWrite("agent/new", "w", t), code("EACCES"));
    await assert.rejects(ch.openWrite("agent/new/f", "w", t), code("EACCES"));
    await assert.rejects(ch.rename("agent/m1/f", "agent/new", t), code("EACCES"));
    await assert.rejects(ch.rename("agent", "agent/m1/z", t), code("EACCES"));
});

test("another model's folder answers ENOENT to every access, reads included", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m2/secret.txt", "s");
    fake.seed(S, "agent/m1/mine", "x");
    const t = await ch.begin();
    const rejectsENOENT = (p, label) => assert.rejects(p, code("ENOENT"), label);
    for (const p of ["agent/m2", "agent/m2/secret.txt", "agent/m2/nope"]) {
        await rejectsENOENT(ch.stat(p), "stat " + p);
        await rejectsENOENT(ch.stat(p, { txn: t }), "stat txn " + p);
        await rejectsENOENT(ch.opendir(p, { limit: 5 }), "opendir " + p);
        await rejectsENOENT(ch.open(p), "open " + p);
        await rejectsENOENT(ch.openWrite(p, "w", t), "openWrite " + p);
        await rejectsENOENT(ch.openWrite(p, "x", t), "openWrite x " + p);
        await rejectsENOENT(ch.unlink(p, t), "unlink " + p);
        await rejectsENOENT(ch.rmdir(p, t), "rmdir " + p);
        await rejectsENOENT(ch.mkdir(p, t), "mkdir " + p);
        await rejectsENOENT(ch.rename(p, "agent/m1/x", t), "rename from " + p);
        await rejectsENOENT(ch.rename("agent/m1/mine", p, t), "rename to " + p);
    }
    assert.equal(dec.decode(fake.committed(S, "agent/m2/secret.txt")), "s");
});

test("a stat of another model's folder looks exactly like a stat of a missing path", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m2/secret.txt", "s");
    for (const [other, missing] of [["agent/m2", "agent/m3"], ["agent/m2/secret.txt", "agent/m3/secret.txt"]]) {
        const a = await ch.stat(other).catch((e) => e);
        const b = await ch.stat(missing).catch((e) => e);
        const strip = (e, p) => ({ ...e, path: undefined, message: e.message.replace(p, "<p>") });
        assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
        assert.deepEqual(strip(a, other), strip(b, missing));
        assert.equal(a.code, "ENOENT");
        assert.equal(a.syscall, "stat");
    }
    const open = await ch.open("agent/m2/secret.txt").catch((e) => e);
    const gone = await ch.open("agent/m3/secret.txt").catch((e) => e);
    assert.deepEqual([open.code, open.syscall, open.message.replace("m2", "m3")], [gone.code, gone.syscall, gone.message]);
});

test("opendir(agent) lists only the own folder, in a txn view too", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m2/secret.txt", "s");
    fake.seed(S, "agent/m3/x", "x");
    assert.deepEqual((await ch.opendir("agent", { limit: 10 })).entries.map((e) => e.name), ["m1"]);
    const t = await ch.begin();
    assert.deepEqual((await ch.opendir("agent", { limit: 10, txn: t })).entries.map((e) => e.name), ["m1"]);
});

test("rename judges the source first, then the destination", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "attached/h/a", "a");
    fake.seed(S, "agent/m2/s", "s");
    fake.seed(S, "agent/m1/f", "f");
    const t = await ch.begin();
    // source: attached EROFS beats a bad destination; another folder ENOENT; elsewhere EACCES
    await assert.rejects(ch.rename("attached/h/a", "agent/m2/x", t), code("EROFS"));
    await assert.rejects(ch.rename("agent/m2/s", "attached/x", t), code("ENOENT"));
    await assert.rejects(ch.rename("agent/m2/s", "agent/new", t), code("ENOENT"));
    await assert.rejects(ch.rename("agent", "attached/x", t), code("EACCES"));
    await assert.rejects(ch.rename("agent/new", "agent/m2/x", t), code("EACCES"));
    // destination: root and agent/ direct EACCES-or-EROFS per rule, attached EROFS, another folder ENOENT
    await assert.rejects(ch.rename("agent/m1/f", "", t), code("EROFS"));
    await assert.rejects(ch.rename("agent/m1/f", "agent/new", t), code("EACCES"));
    await assert.rejects(ch.rename("agent/m1/f", "agent", t), code("EACCES"));
    await assert.rejects(ch.rename("agent/m1/f", "attached/f", t), code("EROFS"));
    await assert.rejects(ch.rename("agent/m1/f", "agent/m2/f", t), code("ENOENT"));
    await ch.rename("agent/m1/f", "agent/m1/g", t);
});

test("a non-default folderOf gives two sessions two folders, each blind to the other", async () => {
    const fake = makeFakeFiles({ folderOf: (s) => "f-" + s });
    const a = fake.channel();
    const b = fake.channel();
    a.setSession("A");
    b.setSession("B");
    assert.equal(a.home, "/files/agent/f-A");
    assert.equal(b.home, "/files/agent/f-B");
    await put(a, "agent/f-A/n", "hi");
    assert.equal(dec.decode(fake.committed("A", "agent/f-A/n")), "hi");
    await assert.rejects(a.stat("agent/f-B"), code("ENOENT"));
    await assert.rejects(b.stat("agent/f-A"), code("ENOENT"));
    await assert.rejects(a.stat("agent/m1"), code("ENOENT"));
    assert.deepEqual((await a.opendir("agent", { limit: 9 })).entries.map((e) => e.name), ["f-A"]);
    assert.deepEqual((await b.opendir("agent", { limit: 9 })).entries.map((e) => e.name), ["f-B"]);
    const t = await b.begin();
    // stores are per session: B's store has no f-A folder, so a write there is just outside B's own folder
    await assert.rejects(b.openWrite("agent/f-A/n", "w", t), code("EACCES"));
    await assert.rejects(b.openWrite("agent/m1/n", "w", t), code("EACCES"));
});

test("EINVAL for a length over FILES_CHUNK and for a negative position", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "abc");
    const { fd } = await ch.open("agent/m1/f");
    const big = new Uint8Array(512 * 1024 + 1);
    await assert.rejects(ch.read(fd, 0, big.length, big), code("EINVAL"));
    await assert.rejects(ch.read(fd, -1, 1, new Uint8Array(1)), code("EINVAL"));
    assert.equal(await ch.read(fd, 0, 512 * 1024, new Uint8Array(512 * 1024)), 3);
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/g", "w", t);
    await assert.rejects(ch.write(wfd, 0, big), code("EINVAL"));
    await assert.rejects(ch.write(wfd, -1, new Uint8Array(1)), code("EINVAL"));
});

// --- rule 4: reads, pinned versions, txn views, hidden ---

test("read copies into dest, 0 at and after the end", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "hello");
    const { fd, size, version } = await ch.open("agent/m1/f");
    assert.equal(size, 5);
    assert.equal(typeof version, "string");
    const dest = new Uint8Array(10);
    assert.equal(await ch.read(fd, 1, 3, dest), 3);
    assert.equal(dec.decode(dest.subarray(0, 3)), "ell");
    assert.equal(await ch.read(fd, 5, 3, dest), 0);
    assert.equal(await ch.read(fd, 50, 3, dest), 0);
    assert.equal((await ch.fstat(fd)).size, 5);
    await ch.close(fd);
    await assert.rejects(ch.close(fd), code("EBADF"));
});

test("a read fd keeps the old bytes after a commit", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "old");
    const { fd } = await ch.open("agent/m1/f");
    await put(ch, "agent/m1/f", "newer");
    assert.equal(await readAll(ch, fd, 3), "old");
    assert.equal(dec.decode(fake.committed(S, "agent/m1/f")), "newer");
    const again = await ch.open("agent/m1/f");
    assert.equal(await readAll(ch, again.fd, 5), "newer");
});

test("with a txn, stat, opendir and open see pending state layered over the committed one", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/keep", "k");
    fake.seed(S, "agent/m1/gone", "g");
    fake.seed(S, "agent/m1/old", "o");
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/new", "w", t);
    await ch.write(wfd, 0, enc.encode("fresh"));
    await ch.closeWrite(wfd);
    await ch.mkdir("agent/m1/dir", t);
    await ch.unlink("agent/m1/gone", t);
    await ch.rename("agent/m1/old", "agent/m1/moved", t);
    const names = (await ch.opendir("agent/m1", { limit: 50, txn: t })).entries.map((e) => e.name);
    assert.deepEqual(names, ["dir", "keep", "moved", "new"]);
    assert.equal((await ch.stat("agent/m1/new", { txn: t })).size, 5);
    const { fd } = await ch.open("agent/m1/new", { txn: t });
    assert.equal(await readAll(ch, fd, 5), "fresh");
    const plain = (await ch.opendir("agent/m1", { limit: 50 })).entries.map((e) => e.name);
    assert.deepEqual(plain, ["gone", "keep", "old"]);
    await assert.rejects(ch.stat("agent/m1/new"), code("ENOENT"));
});

test("read and fstat accept a wfd and see its live pending bytes", async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/w", "w", t);
    await ch.write(wfd, 0, enc.encode("abc"));
    assert.equal(await readAll(ch, wfd, 3), "abc");
    await ch.write(wfd, 1, enc.encode("Z"));
    assert.equal(await readAll(ch, wfd, 3), "aZc");
    assert.equal((await ch.fstat(wfd)).size, 3);
});

test("hidden: stat and opendir show it, open and every read reject EACCES, hiding after open stops reads", async () => {
    const { fake, ch } = setup({ hidden: ["attached/h/secret"] });
    fake.seed(S, "attached/h/secret", "s");
    fake.seed(S, "attached/h/plain", "p");
    assert.equal((await ch.stat("attached/h/secret")).hidden, true);
    assert.equal((await ch.stat("attached/h/plain")).hidden, false);
    const ents = (await ch.opendir("attached/h", { limit: 10 })).entries;
    assert.deepEqual(ents.map((e) => [e.name, e.hidden]), [["plain", false], ["secret", true]]);
    await assert.rejects(ch.open("attached/h/secret"), code("EACCES"));
    const { fd } = await ch.open("attached/h/plain");
    assert.equal(await ch.read(fd, 0, 1, new Uint8Array(1)), 1);
    fake.hide(S, "attached/h/plain");
    await assert.rejects(ch.read(fd, 0, 1, new Uint8Array(1)), code("EACCES"));
    assert.equal((await ch.fstat(fd)).hidden, true);
});

// --- rule 5: opendir paging ---

test("opendir pages by limit with an opaque cursor, sorted, next absent on the last page", async () => {
    const { fake, ch } = setup();
    for (const n of ["e", "b", "d", "a", "c"]) fake.seed(S, `agent/m1/${n}`, n);
    const p1 = await ch.opendir("agent/m1", { limit: 2 });
    assert.deepEqual(p1.entries.map((e) => e.name), ["a", "b"]);
    assert.equal(typeof p1.next, "string");
    const p2 = await ch.opendir("agent/m1", { limit: 2, cursor: p1.next });
    assert.deepEqual(p2.entries.map((e) => e.name), ["c", "d"]);
    const p3 = await ch.opendir("agent/m1", { limit: 2, cursor: p2.next });
    assert.deepEqual(p3.entries.map((e) => e.name), ["e"]);
    assert.equal("next" in p3, false);
    assert.equal("next" in (await ch.opendir("agent/m1", { limit: 5 })), false);
    assert.equal(p1.entries[0].kind, "file");
    assert.equal(p1.entries[0].size, 1);
});

// --- rule 6: writes and transactions ---

test("openWrite flags: w empties, a appends, r+ needs the file, x refuses existing", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "abc");
    const t = await ch.begin();
    assert.equal((await ch.openWrite("agent/m1/f", "w", t)).size, 0);
    const t2 = await ch.begin();
    const a = await ch.openWrite("agent/m1/f", "a", t2);
    assert.equal(a.size, 3);
    await ch.write(a.wfd, 3, enc.encode("d"));
    assert.equal(await readAll(ch, a.wfd, 4), "abcd");
    await assert.rejects(ch.openWrite("agent/m1/nope", "r+", t2), code("ENOENT"));
    assert.equal((await ch.openWrite("agent/m1/created", "a", t2)).size, 0);
    await assert.rejects(ch.openWrite("agent/m1/nodir/x", "w", t2), code("ENOENT"));
    await assert.rejects(ch.openWrite("agent/m1/f/x", "w", t2), code("ENOTDIR"));
});

test("write zero-fills past the end, truncate resizes, closeWrite seals, commit lands atomically in order", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/gone", "g");
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/a.bin", "w", t);
    await ch.write(wfd, 3, enc.encode("xy"));
    assert.deepEqual([...await readBytes(ch, wfd, 5)], [0, 0, 0, 120, 121]);
    await ch.truncate(wfd, 4);
    assert.equal((await ch.fstat(wfd)).size, 4);
    await ch.truncate(wfd, 6);
    assert.deepEqual([...await readBytes(ch, wfd, 6)], [0, 0, 0, 120, 0, 0]);
    await ch.closeWrite(wfd);
    await assert.rejects(ch.write(wfd, 0, new Uint8Array(1)), code("EBADF"));
    await ch.mkdir("agent/m1/d", t);
    await ch.rename("agent/m1/a.bin", "agent/m1/d/a.bin", t);
    await ch.unlink("agent/m1/gone", t);
    assert.equal(fake.committed(S, "agent/m1/a.bin"), undefined);
    assert.deepEqual(fake.list(S), ["agent/m1/gone"]);
    await ch.commitTx(t);
    assert.deepEqual(fake.list(S), ["agent/m1/d/a.bin"]);
    await assert.rejects(ch.commitTx(t), code("EBADF"));
    await assert.rejects(ch.abortTx(t), code("EBADF"));
});
async function readBytes(ch, fd, n) {
    const d = new Uint8Array(n);
    const got = await ch.read(fd, 0, n, d);
    return d.subarray(0, got);
}

test("commit with a wfd still open rejects EINVAL and changes nothing; abort drops everything", async () => {
    const { fake, ch } = setup();
    const t = await ch.begin();
    await ch.mkdir("agent/m1/d", t);
    const { wfd } = await ch.openWrite("agent/m1/d/f", "w", t);
    await ch.write(wfd, 0, enc.encode("x"));
    await assert.rejects(ch.commitTx(t), code("EINVAL"));
    assert.deepEqual(fake.list(S), []);
    assert.equal((await ch.stat("agent/m1/d", { txn: t })).kind, "dir");
    await ch.closeWrite(wfd);
    await ch.abortTx(t);
    assert.deepEqual(fake.list(S), []);
    await assert.rejects(ch.stat("agent/m1/d"), code("ENOENT"));
    await assert.rejects(ch.stat("agent/m1/d", { txn: t }), code("EBADF"));
});

test("rmdir, and rename of a directory with its contents", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/a/b/c.txt", "c");
    const t = await ch.begin();
    await ch.rename("agent/m1/a", "agent/m1/z", t);
    assert.equal((await ch.stat("agent/m1/z/b/c.txt", { txn: t })).size, 1);
    await assert.rejects(ch.rmdir("agent/m1/z", t), code("ENOTEMPTY"));
    await ch.unlink("agent/m1/z/b/c.txt", t);
    await ch.rmdir("agent/m1/z/b", t);
    await ch.rmdir("agent/m1/z", t);
    await ch.commitTx(t);
    assert.deepEqual(fake.list(S), []);
    await assert.rejects(ch.stat("agent/m1/z"), code("ENOENT"));
});

test("an attemptTxn session's openWrite lands only on that txn's commit", async () => {
    const { fake, ch } = setup();
    const t = await ch.begin();
    ch.setSession(S, { attemptTxn: t });
    const other = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/f", "w", other);
    await ch.write(wfd, 0, enc.encode("hi"));
    await ch.closeWrite(wfd);
    await ch.commitTx(other);
    assert.equal(fake.committed(S, "agent/m1/f"), undefined);
    assert.equal((await ch.stat("agent/m1/f", { txn: t })).size, 2);
    await ch.commitTx(t);
    assert.equal(dec.decode(fake.committed(S, "agent/m1/f")), "hi");
});

// --- rule 7: the quota ---

test("quota: ENOSPC leaves the txn open; committed and pending bytes both count; attached/ never counts", async () => {
    const { fake, ch } = setup({ quotaBytes: 10 });
    fake.seed(S, "attached/h/big", "x".repeat(1000));
    fake.seed(S, "agent/m1/a", "12345");
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/b", "w", t);
    await ch.write(wfd, 0, enc.encode("12345"));
    await assert.rejects(ch.write(wfd, 5, enc.encode("6")), code("ENOSPC"));
    await assert.rejects(ch.truncate(wfd, 6), code("ENOSPC"));
    await ch.truncate(wfd, 3);
    await ch.write(wfd, 3, enc.encode("45"));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal(dec.decode(fake.committed(S, "agent/m1/b")), "12345");
    // a second open txn counts too
    const t2 = await ch.begin();
    const w2 = await ch.openWrite("agent/m1/c", "w", t2);
    await assert.rejects(ch.write(w2.wfd, 0, enc.encode("1")), code("ENOSPC"));
    assert.equal((await ch.stat("agent/m1/c", { txn: t2 })).size, 0);
    await ch.truncate(w2.wfd, 0);
    // replacing a committed file is charged only for growth
    const t3 = await ch.begin();
    const w3 = await ch.openWrite("agent/m1/a", "w", t3);
    await ch.write(w3.wfd, 0, enc.encode("12345"));
    await ch.closeWrite(w3.wfd);
    await ch.commitTx(t3);
});

test("quota counts a seeded r+ as 0 until it grows", async () => {
    const { fake, ch } = setup({ quotaBytes: 10 });
    fake.seed(S, "agent/m1/a", "1234567890");
    const t = await ch.begin();
    const { wfd, size } = await ch.openWrite("agent/m1/a", "r+", t);
    assert.equal(size, 10);
    await ch.write(wfd, 0, enc.encode("ZZ"));
    await assert.rejects(ch.write(wfd, 10, enc.encode("!")), code("ENOSPC"));
    await ch.truncate(wfd, 4);
    await ch.write(wfd, 4, enc.encode("56"));
});

// --- rule 8: dispose ---

test("dispose closes every fd, aborts every txn and rejects later calls EBADF", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "x");
    const other = fake.channel();
    other.setSession(S);
    const { fd } = await ch.open("agent/m1/f");
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/g", "w", t);
    await ch.closeWrite(wfd);
    ch.dispose();
    await assert.rejects(ch.read(fd, 0, 1, new Uint8Array(1)), code("EBADF"));
    await assert.rejects(ch.commitTx(t), code("EBADF"));
    await assert.rejects(ch.stat(""), code("EBADF"));
    assert.deepEqual(fake.list(S), ["agent/m1/f"]);
    await assert.rejects(other.commitTx(t), code("EBADF"));
});

// --- rule 9: the log ---

test("log records each call with its arguments minus buffers", async () => {
    const { fake, ch } = setup();
    fake.seed(S, "agent/m1/f", "abc");
    const { fd } = await ch.open("agent/m1/f");
    await ch.read(fd, 1, 2, new Uint8Array(2));
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/m1/g", "w", t);
    await ch.write(wfd, 0, enc.encode("q"));
    assert.deepEqual(fake.log.map((l) => l[0]), ["open", "read", "begin", "openWrite", "write"]);
    assert.deepEqual(fake.log[1], ["read", fd, 1, 2]);
    assert.deepEqual(fake.log[4], ["write", wfd, 0]);
    assert.equal(fake.log.filter((l) => l[0] === "read").length, 1);
});
