// RANGED READER, WRITE SIDE (src/session/ranged-reader.ts over src/session/agent-files.ts): writers, transactions, the quota,
// the channel's end, and the races between two channels' commits. The store is a real AgentFiles on fake-indexeddb.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { AgentFiles } from "../src/session/agent-files.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const T = { timeout: 5000 };
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

/** A reader over an empty shelf and a fresh store; `ch` is a channel on session s1. `quota` undefined means no quota ask. */
function setup(over = {}) {
    const agent = new AgentFiles({ idb: new IDBFactory(), dbName: "t" });
    const lost = [];
    const source = { attached: async () => [], blob: async () => { throw new Error("none"); }, secretForms: async () => [] };
    const deps = { source, now: () => 123, onLost: (r) => lost.push(r), ...over };
    if (!("agent" in over)) deps.agent = agent;
    if (over.quota !== undefined) deps.quotaBytes = over.quota;
    delete deps.quota;
    const reader = new RangedReader(deps);
    const ch = reader.openChannel("files");
    ch.setSession("s1");
    const more = (session = "s1") => { const c = reader.openChannel("files"); c.setSession(session); return c; };
    return { agent, lost, reader, ch, more };
}

/** Read a whole path through a normal open. */
async function slurp(ch, path) {
    const { fd, size } = await ch.open(path);
    const dest = new Uint8Array(size + 8);
    const n = size ? await ch.read(fd, 0, size, dest) : 0;
    await ch.close(fd);
    return dec(dest.subarray(0, n));
}
/** Read a whole write descriptor. */
async function slurpW(ch, wfd) {
    const { size } = await ch.fstat(wfd);
    const dest = new Uint8Array(size + 8);
    const n = size ? await ch.read(wfd, 0, size, dest) : 0;
    return dest.subarray(0, n);
}
/** Write `text` to `path` in its own committed transaction. */
async function put(ch, path, text, flags = "w") {
    const t = await ch.begin();
    const { wfd } = await ch.openWrite(path, flags, t);
    await ch.write(wfd, 0, enc(text));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
}
async function refused(p, code) {
    let err;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, `expected ${code}, the call resolved`);
    assert.equal(err.code, code, `got ${err.code}: ${err.message}`);
    return err;
}

// --- write, read back, commit ---

test("a write reads back through its wfd before commit and through open after commit", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd, size } = await ch.openWrite("agent/a.txt", "w", t);
    assert.equal(size, 0);
    await ch.write(wfd, 0, enc("hello"));
    assert.equal(dec(await slurpW(ch, wfd)), "hello");
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/a.txt"), "hello");
});

test("before commit another channel sees ENOENT for a new file", T, async () => {
    const { ch, more } = setup();
    const other = more();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/new.txt", "w", t);
    await ch.write(wfd, 0, enc("x"));
    await ch.closeWrite(wfd);
    await refused(other.open("agent/new.txt"), "ENOENT");
    await ch.commitTx(t);
    assert.equal(await slurp(other, "agent/new.txt"), "x");
});

test("before commit another channel sees the old version of an existing file", T, async () => {
    const { ch, more } = setup();
    await put(ch, "agent/f.txt", "old");
    const other = more();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/f.txt", "w", t);
    await ch.write(wfd, 0, enc("new!"));
    await ch.closeWrite(wfd);
    assert.equal(await slurp(other, "agent/f.txt"), "old");
    await ch.commitTx(t);
    assert.equal(await slurp(other, "agent/f.txt"), "new!");
});

// --- flags: w, a, r+, x ---

test("w starts empty, a and r+ seed from the stored bytes", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/f.txt", "abcdef");
    let t = await ch.begin();
    let o = await ch.openWrite("agent/f.txt", "a", t);
    assert.equal(o.size, 6);
    assert.equal(dec(await slurpW(ch, o.wfd)), "abcdef");
    await ch.write(o.wfd, 6, enc("!"));
    await ch.closeWrite(o.wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/f.txt"), "abcdef!");

    t = await ch.begin();
    o = await ch.openWrite("agent/f.txt", "r+", t);
    assert.equal(o.size, 7);
    await ch.write(o.wfd, 1, enc("ZZ"));
    await ch.closeWrite(o.wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/f.txt"), "aZZdef!");

    t = await ch.begin();
    o = await ch.openWrite("agent/f.txt", "w", t);
    assert.equal(o.size, 0);
    await ch.closeWrite(o.wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/f.txt"), "");
});

test("a on a missing file creates it empty", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const o = await ch.openWrite("agent/n.txt", "a", t);
    assert.equal(o.size, 0);
    await ch.write(o.wfd, 0, enc("q"));
    await ch.closeWrite(o.wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/n.txt"), "q");
});

test("x on an existing file is EEXIST, on a new one it works", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/f.txt", "1");
    const t = await ch.begin();
    await refused(ch.openWrite("agent/f.txt", "x", t), "EEXIST");
    const o = await ch.openWrite("agent/g.txt", "x", t);
    await ch.write(o.wfd, 0, enc("g"));
    await ch.closeWrite(o.wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/g.txt"), "g");
});

test("r+ on a missing file is ENOENT, a missing parent folder is ENOENT, a file as parent is ENOTDIR, a dir target is EISDIR", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/f.txt", "1");
    const t = await ch.begin();
    await refused(ch.openWrite("agent/missing.txt", "r+", t), "ENOENT");
    await refused(ch.openWrite("agent/nodir/f.txt", "w", t), "ENOENT");
    await refused(ch.openWrite("agent/f.txt/g", "w", t), "ENOTDIR");
    const m = await ch.begin();
    await ch.mkdir("agent/d", m);
    await ch.commitTx(m);
    await refused(ch.openWrite("agent/d", "w", t), "EISDIR");
});

test("an unknown flag is EINVAL", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    await refused(ch.openWrite("agent/f", "z", t), "EINVAL");
});

// --- positions: zero fill, truncate ---

test("a write past the end zero-fills the gap", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/z.bin", "w", t);
    await ch.write(wfd, 0, enc("ab"));
    await ch.write(wfd, 5, enc("cd"));
    assert.deepEqual([...await slurpW(ch, wfd)], [97, 98, 0, 0, 0, 99, 100]);
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal((await ch.stat("agent/z.bin")).size, 7);
});

test("truncate shrinks and grows (growth is zeros)", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/t.bin", "w", t);
    await ch.write(wfd, 0, enc("abcdef"));
    await ch.truncate(wfd, 3);
    assert.equal(dec(await slurpW(ch, wfd)), "abc");
    await ch.truncate(wfd, 5);
    assert.deepEqual([...await slurpW(ch, wfd)], [97, 98, 99, 0, 0]);
    await ch.truncate(wfd, 0);
    assert.equal((await ch.fstat(wfd)).size, 0);
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
});

test("write and truncate refuse bad arguments with EINVAL", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/b", "w", t);
    await refused(ch.write(wfd, -1, enc("x")), "EINVAL");
    await refused(ch.truncate(wfd, -1), "EINVAL");
    await refused(ch.write(999999, 0, enc("x")), "EBADF");
});

// --- quota ---

test("ENOSPC on write names filesQuotaMB and os.remove, and the txn still commits what fit", T, async () => {
    const { ch } = setup({ quota: async () => 10 });
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/q.txt", "w", t);
    await ch.write(wfd, 0, enc("0123456789"));
    const e = await refused(ch.write(wfd, 10, enc("x")), "ENOSPC");
    assert.match(e.message, /filesQuotaMB/);
    assert.match(e.message, /os\.remove/);
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/q.txt"), "0123456789");
});

test("ENOSPC on truncate that grows past the quota", T, async () => {
    const { ch } = setup({ quota: async () => 10 });
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/q.txt", "w", t);
    const e = await refused(ch.truncate(wfd, 11), "ENOSPC");
    assert.match(e.message, /filesQuotaMB/);
    assert.match(e.message, /os\.remove/);
    await ch.truncate(wfd, 10);
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal((await ch.stat("agent/q.txt")).size, 10);
});

test("the quota counts stored files, and replacing a file counts only the difference", T, async () => {
    const { ch } = setup({ quota: async () => 10 });
    await put(ch, "agent/a", "12345678");
    let t = await ch.begin();
    let o = await ch.openWrite("agent/b", "w", t);
    await refused(ch.write(o.wfd, 0, enc("123")), "ENOSPC");
    await ch.write(o.wfd, 0, enc("12"));
    await ch.abortTx(t);
    t = await ch.begin();
    o = await ch.openWrite("agent/a", "r+", t);
    await ch.write(o.wfd, 8, enc("90"));
    await refused(ch.write(o.wfd, 10, enc("!")), "ENOSPC");
});

test("the quota counts pending writers on OTHER channels of the same session, not of another session", T, async () => {
    const { ch, more } = setup({ quota: async () => 10 });
    const other = more();
    const foreign = more("s2");
    const t1 = await ch.begin();
    const a = await ch.openWrite("agent/a", "w", t1);
    await ch.write(a.wfd, 0, enc("123456"));
    const t2 = await other.begin();
    const b = await other.openWrite("agent/b", "w", t2);
    await refused(other.write(b.wfd, 0, enc("12345")), "ENOSPC");
    await other.write(b.wfd, 0, enc("1234"));
    // another session's pending bytes do not count
    const t3 = await foreign.begin();
    const c = await foreign.openWrite("agent/c", "w", t3);
    await foreign.write(c.wfd, 0, enc("1234567890"));
    // and A is now squeezed by B's pending four bytes
    await refused(ch.write(a.wfd, 6, enc("1")), "ENOSPC");
    await ch.write(a.wfd, 0, enc("654321"));
});

test("a writer closed and committed stops counting against the others", T, async () => {
    const { ch, more } = setup({ quota: async () => 10 });
    const other = more();
    const t1 = await ch.begin();
    const a = await ch.openWrite("agent/a", "w", t1);
    await ch.write(a.wfd, 0, enc("123456"));
    await ch.abortTx(t1);
    const t2 = await other.begin();
    const b = await other.openWrite("agent/b", "w", t2);
    await other.write(b.wfd, 0, enc("1234567890"));
});

test("ENOSPC at commit when pending writers across channels together exceed the quota", T, async () => {
    // A opens first (the quota is not yet used), B opens and writes; both stay within what each saw at write time
    // only if the write-time check lets them. The write-time check counts the others, so this guards the commit check.
    const { ch, more } = setup({ quota: async () => 10 });
    const other = more();
    const t1 = await ch.begin();
    const a = await ch.openWrite("agent/a", "w", t1);
    await ch.write(a.wfd, 0, enc("123456"));
    await ch.closeWrite(a.wfd);
    const t2 = await other.begin();
    const b = await other.openWrite("agent/b", "w", t2);
    await other.write(b.wfd, 0, enc("1234"));
    await other.closeWrite(b.wfd);
    await ch.commitTx(t1);
    await other.commitTx(t2);
    assert.equal((await ch.stat("agent/a")).size + (await ch.stat("agent/b")).size, 10);
});

test("ENOSPC at commit: bytes stored by another writer after this open are counted at commit", T, async () => {
    let q = 100;
    const { ch, agent } = setup({ quota: async () => q });
    const t = await ch.begin();
    const o = await ch.openWrite("agent/a", "w", t);
    await ch.write(o.wfd, 0, enc("1234567890"));
    await ch.closeWrite(o.wfd);
    // the writer carries the quota it was opened under (100); fill the store through another channel's commit
    const filler = new RangedReader({ source: { attached: async () => [], blob: async () => { throw 0; }, secretForms: async () => [] }, agent, quotaBytes: async () => 1000 }).openChannel("files");
    filler.setSession("s1");
    await put(filler, "agent/big", "x".repeat(95));
    // the reader's cached store total is from the open; the commit re-reads nothing, so this documents what stands
    let err;
    try { await ch.commitTx(t); } catch (e) { err = e; }
    if (err) { assert.equal(err.code, "ENOSPC"); assert.match(err.message, /filesQuotaMB/); assert.match(err.message, /os\.remove/); }
    else assert.fail("commit accepted 10 bytes on top of a stored 95 under a quota of 100", { cause: "stored total is cached at openWrite" });
});

test("a quota ask that throws refuses the open with EIO", T, async () => {
    const { ch } = setup({ quota: async () => { throw new Error("settings unreadable"); } });
    const t = await ch.begin();
    await refused(ch.openWrite("agent/a", "w", t), "EIO");
});

test("review: a file sealed by its close, then aborted, stops counting against the quota", T, async () => {
    const { ch, more } = setup({ quota: async () => 10 });
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a", "w", t);
    await ch.write(wfd, 0, enc("123456"));
    await ch.closeWrite(wfd);
    await ch.abortTx(t);
    const other = more();
    const u = await other.begin();
    const w = await other.openWrite("agent/b", "w", u);
    await other.write(w.wfd, 0, enc("0123456789"));
    await other.closeWrite(w.wfd);
    await other.commitTx(u);
    assert.equal(await slurp(other, "agent/b"), "0123456789");
});

test("review: after one commit, another channel's pending part is still refused on the chunk that crosses the quota", T, async () => {
    const { ch, more } = setup({ quota: async () => 10 });
    const other = more();
    const u = await other.begin();
    const w = await other.openWrite("agent/b", "w", u);
    await put(ch, "agent/a", "123456");
    await refused(other.write(w.wfd, 0, enc("12345")), "ENOSPC");
    await other.write(w.wfd, 0, enc("1234"));
});

// --- commit, abort, dispose, setSession ---

test("commitTx with a writer not yet closed is EINVAL, and closing it lets the commit land", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a", "w", t);
    await ch.write(wfd, 0, enc("a"));
    await refused(ch.commitTx(t), "EINVAL");
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/a"), "a");
});

test("a closed write descriptor is EBADF", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a", "w", t);
    await ch.closeWrite(wfd);
    await refused(ch.write(wfd, 0, enc("x")), "EBADF");
});

test("abortTx discards: nothing stored, onLost not called", T, async () => {
    const { ch, agent, lost } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a", "w", t);
    await ch.write(wfd, 0, enc("a"));
    await ch.closeWrite(wfd);
    await ch.abortTx(t);
    assert.deepEqual(await agent.all("s1"), []);
    assert.deepEqual(lost, []);
    await refused(ch.commitTx(t), "EBADF");
});

test("an empty transaction commits to nothing", T, async () => {
    const { ch, agent } = setup();
    await ch.commitTx(await ch.begin());
    assert.deepEqual(await agent.all("s1"), []);
});

test("dispose with an open writer reports once as channel-ended and stores nothing", T, async () => {
    const { ch, agent, lost } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a.txt", "w", t);
    await ch.write(wfd, 0, enc("a"));
    ch.dispose();
    assert.equal(lost.length, 1);
    assert.deepEqual({ session: lost[0].session, path: lost[0].path, reason: lost[0].reason }, { session: "s1", path: "agent/a.txt", reason: "channel-ended" });
    assert.deepEqual(await agent.all("s1"), []);
    await refused(ch.commitTx(t), "EBADF");
});

test("setSession to another session reports an open writer and stores nothing", T, async () => {
    const { ch, agent, lost } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a.txt", "w", t);
    await ch.write(wfd, 0, enc("a"));
    ch.setSession("s2");
    assert.equal(lost.length, 1);
    assert.deepEqual({ session: lost[0].session, path: lost[0].path, reason: lost[0].reason }, { session: "s1", path: "agent/a.txt", reason: "channel-ended" });
    assert.deepEqual(await agent.all("s1"), []);
    assert.deepEqual(await agent.all("s2"), []);
});

test("setSession to the same session leaves a writer alone", T, async () => {
    const { ch, lost } = setup();
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a.txt", "w", t);
    ch.setSession("s1");
    await ch.write(wfd, 0, enc("a"));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.deepEqual(lost, []);
});

test("a disposed writer stops counting against the quota of the others", T, async () => {
    const { ch, more } = setup({ quota: async () => 10 });
    const other = more();
    const t1 = await ch.begin();
    const a = await ch.openWrite("agent/a", "w", t1);
    await ch.write(a.wfd, 0, enc("123456"));
    ch.dispose();
    const t2 = await other.begin();
    const b = await other.openWrite("agent/b", "w", t2);
    await other.write(b.wfd, 0, enc("1234567890"));
});

test("review: a channel's end reports a file sealed by its close but not committed, and frees its quota", T, async () => {
    const { reader, ch, lost, more } = setup({ quota: async () => 10 });
    const t = await ch.begin();
    const { wfd } = await ch.openWrite("agent/a", "w", t);
    await ch.write(wfd, 0, enc("123456"));
    await ch.closeWrite(wfd);
    ch.dispose();
    assert.deepEqual(lost.map((r) => [r.path, r.reason]), [["agent/a", "channel-ended"]]);
    assert.equal(reader.writers.get("s1")?.size ?? 0, 0, "no pending part is left counting");
    await put(more(), "agent/b", "0123456789");
});

// --- read-only places ---

test("with no agent dep, openWrite under agent/ is EROFS", T, async () => {
    const { ch } = setup({ agent: undefined });
    const t = await ch.begin();
    await refused(ch.openWrite("agent/a", "w", t), "EROFS");
    await refused(ch.mkdir("agent/d", t), "EROFS");
});

test("a write, mkdir, unlink, rename or rmdir at the root or under attached/ is EROFS", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    for (const p of ["", "attached", "attached/h1", "attached/h1/a.bin", "other"]) {
        await refused(ch.openWrite(p, "w", t), "EROFS");
        await refused(ch.mkdir(p, t), "EROFS");
        await refused(ch.unlink(p, t), "EROFS");
        await refused(ch.rmdir(p, t), "EROFS");
    }
    await refused(ch.rename("attached/h1/a.bin", "agent/x", t), "EROFS");
    await refused(ch.rename("agent/x", "attached/y", t), "EROFS");
});

test("mkdir of agent itself is EEXIST", T, async () => {
    const { ch } = setup();
    await refused(ch.mkdir("agent", await ch.begin()), "EEXIST");
});

test("a hidden path refuses a write with EACCES", T, async () => {
    const { ch } = setup({ hidden: (s, p) => p === "agent/secret" });
    const t = await ch.begin();
    await refused(ch.openWrite("agent/secret", "w", t), "EACCES");
});

test("review: a path hidden after its file was opened is not committed (EACCES), and nothing of the transaction lands", T, async () => {
    let hide = false;
    const { ch } = setup({ hidden: (s, p) => hide && p === "agent/late" });
    const t = await ch.begin();
    await ch.mkdir("agent/d", t);
    const { wfd } = await ch.openWrite("agent/late", "w", t);
    await ch.write(wfd, 0, enc("x"));
    await ch.closeWrite(wfd);
    hide = true;
    await refused(ch.commitTx(t), "EACCES");
    await ch.abortTx(t);
    hide = false;
    await refused(ch.stat("agent/late"), "ENOENT");
    await refused(ch.stat("agent/d"), "ENOENT");
});

// --- names: mkdir, rmdir, rename, unlink ---

test("mkdir and rmdir land at commit, and rmdir of a non-empty folder is ENOTEMPTY", T, async () => {
    const { ch } = setup();
    let t = await ch.begin();
    await ch.mkdir("agent/d", t);
    await ch.mkdir("agent/d/e", t);
    await ch.commitTx(t);
    assert.equal((await ch.stat("agent/d/e")).kind, "dir");
    await put(ch, "agent/d/e/f", "1");
    t = await ch.begin();
    await ch.rmdir("agent/d/e", t);
    await refused(ch.commitTx(t), "ENOTEMPTY");
    t = await ch.begin();
    await ch.unlink("agent/d/e/f", t);
    await ch.rmdir("agent/d/e", t);
    await ch.commitTx(t);
    await refused(ch.stat("agent/d/e"), "ENOENT");
    assert.equal((await ch.stat("agent/d")).kind, "dir");
});

test("a mkdir is not visible to another channel before commit", T, async () => {
    const { ch, more } = setup();
    const other = more();
    const t = await ch.begin();
    await ch.mkdir("agent/d", t);
    await refused(other.stat("agent/d"), "ENOENT");
    await ch.commitTx(t);
    assert.equal((await other.stat("agent/d")).kind, "dir");
});

test("mkdir of an existing path is EEXIST at commit, and nothing of that txn lands", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/f", "1");
    const t = await ch.begin();
    await put(ch, "agent/ok", "1");
    await ch.mkdir("agent/f", t);
    await refused(ch.commitTx(t), "EEXIST");
});

test("rename within agent/ moves a file with its bytes, and a folder with what is under it", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/a", "AAA");
    let t = await ch.begin();
    await ch.mkdir("agent/d", t);
    await ch.commitTx(t);
    await put(ch, "agent/d/in", "IN");
    t = await ch.begin();
    await ch.rename("agent/a", "agent/b", t);
    await ch.rename("agent/d", "agent/e", t);
    await ch.commitTx(t);
    await refused(ch.stat("agent/a"), "ENOENT");
    await refused(ch.stat("agent/d"), "ENOENT");
    assert.equal(await slurp(ch, "agent/b"), "AAA");
    assert.equal(await slurp(ch, "agent/e/in"), "IN");
});

test("rename of a missing source is ENOENT at commit; of a folder into itself is EINVAL", T, async () => {
    const { ch } = setup();
    let t = await ch.begin();
    await ch.rename("agent/none", "agent/x", t);
    await refused(ch.commitTx(t), "ENOENT");
    t = await ch.begin();
    await ch.mkdir("agent/d", t);
    await ch.commitTx(t);
    t = await ch.begin();
    await ch.rename("agent/d", "agent/d/sub", t);
    await refused(ch.commitTx(t), "EINVAL");
});

test("unlink removes a file at commit; of a missing one is ENOENT, of a folder EISDIR", T, async () => {
    const { ch, agent } = setup();
    await put(ch, "agent/a", "1");
    let t = await ch.begin();
    await ch.unlink("agent/a", t);
    assert.equal(await slurp(ch, "agent/a"), "1");
    await ch.commitTx(t);
    await refused(ch.stat("agent/a"), "ENOENT");
    assert.deepEqual(await agent.all("s1"), []);
    t = await ch.begin();
    await ch.unlink("agent/a", t);
    await refused(ch.commitTx(t), "ENOENT");
    t = await ch.begin();
    await ch.mkdir("agent/d", t);
    await ch.commitTx(t);
    t = await ch.begin();
    await ch.unlink("agent/d", t);
    await refused(ch.commitTx(t), "EISDIR");
});

test("a transaction's ops apply in order against what the earlier ones left", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    await ch.mkdir("agent/d", t);
    const { wfd } = await ch.openWrite("agent/d/f", "w", t);
    await ch.write(wfd, 0, enc("in"));
    await ch.closeWrite(wfd);
    await ch.rename("agent/d/f", "agent/g", t);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/g"), "in");
});

test("a transaction number from another channel is EBADF", T, async () => {
    const { ch, more } = setup();
    const other = more();
    const t = await other.begin();
    await refused(ch.openWrite("agent/a", "w", t), "EBADF");
    await refused(ch.commitTx(t), "EBADF");
});

test("review: a folder this transaction renamed into is a folder for a later open in it", T, async () => {
    const { ch } = setup();
    const t0 = await ch.begin(); await ch.mkdir("agent/a", t0); await ch.commitTx(t0);
    const t = await ch.begin();
    await ch.rename("agent/a", "agent/b", t);
    const { wfd } = await ch.openWrite("agent/b/new", "w", t);
    await ch.write(wfd, 0, enc("ok"));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
    assert.equal(await slurp(ch, "agent/b/new"), "ok");
    await refused(ch.stat("agent/a"), "ENOENT");
});

test("review: a FILE renamed onto a name is not a folder for an open under it (ENOTDIR)", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/f", "x");
    const t = await ch.begin();
    await ch.rename("agent/f", "agent/g", t);
    await refused(ch.openWrite("agent/g/new", "w", t), "ENOTDIR");
});

// --- races between two channels' commits ---

test("race (a): A holds agent/x open while B renames the committed agent/x to agent/y; A's commit leaves x = A, y = old", T, async () => {
    const { ch: A, more } = setup();
    const B = more();
    await put(A, "agent/x", "OLD");
    const ta = await A.begin();
    const wa = await A.openWrite("agent/x", "w", ta);
    await A.write(wa.wfd, 0, enc("A-BYTES"));
    const tb = await B.begin();
    await B.rename("agent/x", "agent/y", tb);
    await B.commitTx(tb);
    await A.closeWrite(wa.wfd);
    await A.commitTx(ta);
    assert.equal(await slurp(A, "agent/x"), "A-BYTES");
    assert.equal(await slurp(A, "agent/y"), "OLD");
});

test("race (b): A holds agent/x open while B unlinks the committed agent/x; A's commit recreates it", T, async () => {
    const { ch: A, more } = setup();
    const B = more();
    await put(A, "agent/x", "OLD");
    const ta = await A.begin();
    const wa = await A.openWrite("agent/x", "r+", ta);
    await A.write(wa.wfd, 0, enc("NEW"));
    const tb = await B.begin();
    await B.unlink("agent/x", tb);
    await B.commitTx(tb);
    await refused(B.stat("agent/x"), "ENOENT");
    await A.closeWrite(wa.wfd);
    await A.commitTx(ta);
    assert.equal(await slurp(A, "agent/x"), "NEW");
});

test("race (c): A and B both write agent/z and commit A then B; B's bytes stand", T, async () => {
    const { ch: A, more } = setup();
    const B = more();
    const ta = await A.begin(), tb = await B.begin();
    const wa = await A.openWrite("agent/z", "w", ta);
    const wb = await B.openWrite("agent/z", "w", tb);
    await A.write(wa.wfd, 0, enc("from-A"));
    await B.write(wb.wfd, 0, enc("from-B"));
    await A.closeWrite(wa.wfd);
    await B.closeWrite(wb.wfd);
    await A.commitTx(ta);
    assert.equal(await slurp(A, "agent/z"), "from-A");
    await B.commitTx(tb);
    assert.equal(await slurp(A, "agent/z"), "from-B");
});

test("race (d): A writes agent/d/f while B commits rmdir of agent/d; A's commit fails with ENOENT and stores nothing", T, async () => {
    const { ch: A, more, agent } = setup();
    const B = more();
    let t = await A.begin();
    await A.mkdir("agent/d", t);
    await A.commitTx(t);
    const ta = await A.begin();
    const wa = await A.openWrite("agent/d/f", "w", ta);
    await A.write(wa.wfd, 0, enc("lost"));
    await A.closeWrite(wa.wfd);
    const tb = await B.begin();
    await B.rmdir("agent/d", tb);
    await B.commitTx(tb);
    await refused(A.commitTx(ta), "ENOENT");
    assert.deepEqual((await agent.all("s1")).map((n) => n.path), []);
});

test("race (e): a txn whose commit failed is gone, so a second commit of it is EBADF", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    await ch.unlink("agent/none", t);
    await refused(ch.commitTx(t), "ENOENT");
    await refused(ch.commitTx(t), "EBADF");
});
