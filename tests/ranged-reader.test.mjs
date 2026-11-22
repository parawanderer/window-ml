// RANGED READER (src/session/ranged-reader.ts): the one reader under `/files`, tested through a fake FilesSource whose
// Blobs count every slice and every arrayBuffer, so "nothing reads a whole file" is a measurement. Covers the layout,
// canonical paths, ranged reads, the error shape, hiding, descriptor lifetimes, races, paging and the read-only write side.
import test from "node:test";
import assert from "node:assert/strict";
import { RangedReader, DIR_PAGE_MAX, FILES_HOME } from "../src/session/ranged-reader.ts";
import { maskOverlap } from "../src/secret-mask.ts";

const T = { timeout: 5000 };
const KB = 1024;
const CHUNK = 512 * KB;
const URL_SECRET = "https://llm.internal.example:8443/v1";
const KEY_SECRET = "sk-test-0123456789abcdef";

/** A Blob stand-in over real bytes: records every slice, the size each arrayBuffer returned, and can hold reads on a gate. */
function countingBlob(bytes, stats, gate) {
    const real = new Blob([bytes]);
    return {
        size: real.size,
        slice(a, b) {
            stats.slices.push(b - a);
            const part = real.slice(a, b);
            return {
                arrayBuffer: async () => {
                    stats.slices_started?.();
                    if (gate) await gate.promise;
                    const ab = await part.arrayBuffer();
                    stats.sizes.push(ab.byteLength);
                    return ab;
                },
            };
        },
        arrayBuffer: async () => { stats.whole++; return real.arrayBuffer(); },
        text: async () => { stats.whole++; return real.text(); },
    };
}

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** The fake source: `sessions` maps a session to its rows; `data` maps a key to bytes. */
function fakeSource(sessions, data) {
    const stats = { blobCalls: 0, slices: [], sizes: [], whole: 0, formsCalls: 0 };
    const src = {
        stats,
        fail: null,
        gate: null,
        blobGate: null,
        forms: [],
        formsFail: false,
        attached: async (s) => sessions[s] ?? [],
        secretForms: async () => {
            stats.formsCalls++;
            if (src.formsFail) throw new Error(`registry at ${URL_SECRET} unreadable, key ${KEY_SECRET}`);
            return src.forms;
        },
        blob: async (key, session) => {
            stats.blobCalls++;
            if (src.blobGate) await src.blobGate.promise;
            if (src.fail) throw new Error(`fetch ${URL_SECRET} failed with key ${KEY_SECRET}`);
            const bytes = data[key];
            if (!bytes) throw new Error(`no ${key} for ${session}`);
            return countingBlob(bytes, stats, src.gate);
        },
    };
    return src;
}

const row = (handle, name, key, bytes, over = {}) => ({ handle, name, key, bytes: bytes.length, sha256: `sha-${handle}`, attachedMs: 5000, ...over });
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

/** One session "s1" holding h1 (a small file) and h2, plus "s2" holding h9; a reader and a channel on s1. */
function setup(over = {}) {
    const small = pattern(1000);
    const data = { k1: small, k2: pattern(50), k9: pattern(10), ...over.data };
    const sessions = { s1: [row("h1", "a.bin", "k1", small), row("h2", "b.txt", "k2", data.k2)], s2: [row("h9", "other.txt", "k9", data.k9)], ...over.sessions };
    const source = fakeSource(sessions, data);
    const hiddenSet = new Set();
    const reader = new RangedReader({ source, hidden: (s, p) => hiddenSet.has(`${s}:${p}`), now: () => 123 });
    const ch = reader.openChannel("files");
    ch.setSession("s1");
    return { source, reader, ch, hiddenSet, small, data };
}

/** Assert a promise rejects with a plain FsError of `code`; returns it. */
async function refused(p, code, syscall) {
    let err;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, `expected ${code}, the call resolved`);
    assert.equal(err.code, code, `got ${err.code}: ${err.message}`);
    if (syscall) assert.equal(err.syscall, syscall);
    return err;
}

// --- layout: what the root, attached/ and a handle list, and what stat says ---

test("root lists exactly agent and attached", T, async () => {
    const { ch } = setup();
    const page = await ch.opendir("", { limit: 50 });
    assert.deepEqual(page.entries.map((e) => e.name), ["agent", "attached"]);
});

test("attached lists the handles of the session", T, async () => {
    const { ch } = setup();
    const page = await ch.opendir("attached", { limit: 50 });
    assert.deepEqual(page.entries.map((e) => e.name), ["h1", "h2"]);
    assert.ok(page.entries.every((e) => e.kind === "dir" && e.readonly === true));
});

test("attached/<h> lists its one file", T, async () => {
    const { ch } = setup();
    const page = await ch.opendir("attached/h1", { limit: 50 });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].name, "a.bin");
    assert.equal(page.entries[0].kind, "file");
    assert.equal(page.entries[0].size, 1000);
});

test("stat of a file: kind, size, times, readonly true", T, async () => {
    const { ch } = setup();
    const st = await ch.stat("attached/h1/a.bin");
    assert.equal(st.kind, "file");
    assert.equal(st.size, 1000);
    assert.equal(st.readonly, true);
    assert.equal(st.hidden, false);
    assert.equal(st.mtimeMs, 5000);
    assert.equal(st.birthtimeMs, 5000);
});

test("stat of the root and attached is a read-only dir; agent is a writable dir", T, async () => {
    const { ch } = setup();
    for (const [p, ro] of [["", true], ["attached", true], ["agent", false]]) {
        const st = await ch.stat(p);
        assert.equal(st.kind, "dir", p);
        assert.equal(st.readonly, ro, p);
    }
});

test("stat hidden flag comes from the hide rule, and the hidden file is still listed", T, async () => {
    const { ch, hiddenSet } = setup();
    hiddenSet.add("s1:attached/h2/b.txt");
    assert.equal((await ch.stat("attached/h2/b.txt")).hidden, true);
    assert.equal((await ch.stat("attached/h1/a.bin")).hidden, false);
    const page = await ch.opendir("attached/h2", { limit: 5 });
    assert.deepEqual(page.entries.map((e) => [e.name, e.hidden]), [["b.txt", true]]);
});

test("another session's file is ENOENT with the same message shape as a path that never existed", T, async () => {
    const { ch } = setup();
    const other = await refused(ch.stat("attached/h9/other.txt"), "ENOENT", "stat");
    const never = await refused(ch.stat("attached/hzz/nothing.txt"), "ENOENT", "stat");
    assert.equal(other.message.replace("h9/other.txt", "X"), never.message.replace("hzz/nothing.txt", "X"));
    assert.notEqual(other.code, "EACCES");
    await refused(ch.open("attached/h9/other.txt"), "ENOENT", "open");
    await refused(ch.opendir("attached/h9", { limit: 5 }), "ENOENT", "opendir");
});

// --- canonical paths: what is refused outright ---

test("a path that is not canonical is ENOENT", T, async () => {
    const { ch } = setup();
    for (const p of ["/attached", "attached/", "attached//x", "./x", "attached/../agent", "attached/h1/./a.bin", "a\0b", "/"]) {
        await refused(ch.stat(p), "ENOENT", "stat");
        await refused(ch.open(p), "ENOENT", "open");
    }
});

test("a non-string path is ENOENT", T, async () => {
    const { ch } = setup();
    for (const p of [undefined, null, 5, {}, ["attached"]]) await refused(ch.stat(p), "ENOENT", "stat");
});

test("a path through a file is ENOTDIR", T, async () => {
    const { ch } = setup();
    const e = await refused(ch.stat("attached/h1/a.bin/x"), "ENOTDIR", "stat");
    assert.equal(e.path, "attached/h1/a.bin/x");
    await refused(ch.open("attached/h1/a.bin/x"), "ENOTDIR", "open");
});

test("open of a directory is EISDIR; opendir of a file is ENOTDIR", T, async () => {
    const { ch } = setup();
    await refused(ch.open("attached/h1"), "EISDIR", "open");
    await refused(ch.open(""), "EISDIR", "open");
    await refused(ch.opendir("attached/h1/a.bin", { limit: 5 }), "ENOTDIR", "opendir");
});

// --- ranged reads ---

test("read at position 0, the middle and the last byte copies the source's bytes into dest at offset 0", T, async () => {
    const { ch, small } = setup();
    const { fd, size, version } = await ch.open("attached/h1/a.bin");
    assert.equal(size, 1000);
    assert.equal(version, "sha-h1");
    for (const [pos, len] of [[0, 10], [500, 20], [999, 1]]) {
        const dest = new Uint8Array(64).fill(0xaa);
        const n = await ch.read(fd, pos, len, dest);
        assert.equal(n, len);
        assert.deepEqual(dest.subarray(0, n), small.subarray(pos, pos + len));
        assert.ok(dest.subarray(n).every((b) => b === 0xaa), "bytes past n are untouched");
    }
});

test("read at and past the end answers 0 and leaves dest alone", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    for (const pos of [1000, 1001, 10 ** 9]) {
        const dest = new Uint8Array(8).fill(0xaa);
        assert.equal(await ch.read(fd, pos, 8, dest), 0);
        assert.ok(dest.every((b) => b === 0xaa));
    }
});

test("a read across the end is short", T, async () => {
    const { ch, small } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    const dest = new Uint8Array(100);
    assert.equal(await ch.read(fd, 990, 100, dest), 10);
    assert.deepEqual(dest.subarray(0, 10), small.subarray(990));
});

test("read of length 0 answers 0", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    assert.equal(await ch.read(fd, 0, 0, new Uint8Array(4)), 0);
});

test("read longer than 512 KiB is EINVAL", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    await refused(ch.read(fd, 0, CHUNK + 1, new Uint8Array(CHUNK + 1)), "EINVAL", "read");
    assert.equal(await ch.read(fd, 0, CHUNK, new Uint8Array(CHUNK)), 1000, "exactly 512 KiB is allowed");
});

test("read with a negative or non-integer position or length is EINVAL", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    const d = new Uint8Array(8);
    for (const [pos, len] of [[-1, 4], [1.5, 4], [NaN, 4], [Infinity, 4], ["0", 4], [0, -1], [0, 1.5], [0, NaN], [0, "4"]]) {
        await refused(ch.read(fd, pos, len, d), "EINVAL", "read");
    }
});

test("read into a dest that is not a Uint8Array is EINVAL", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    await refused(ch.read(fd, 0, 4, [0, 0, 0, 0]), "EINVAL", "read");
    await refused(ch.read(fd, 0, 4, undefined), "EINVAL", "read");
});

test("read into a dest shorter than length fills only dest", T, async () => {
    const { ch, small } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    const dest = new Uint8Array(3);
    assert.equal(await ch.read(fd, 10, 100, dest), 3);
    assert.deepEqual(dest, small.subarray(10, 13));
});

test("a 3 MiB file read in 512 KiB chunks never slices more than 512 KiB and never reads the whole Blob", T, async () => {
    const big = pattern(3 * 1024 * KB);
    const { ch, source } = setup({ data: { kbig: big }, sessions: { s1: [row("hb", "big.bin", "kbig", big)] } });
    const { fd, size } = await ch.open("attached/hb/big.bin");
    assert.equal(size, big.length);
    const dest = new Uint8Array(CHUNK);
    const got = new Uint8Array(big.length);
    let pos = 0;
    for (;;) {
        const n = await ch.read(fd, pos, CHUNK, dest);
        if (n === 0) break;
        got.set(dest.subarray(0, n), pos);
        pos += n;
    }
    assert.equal(pos, big.length);
    assert.deepEqual(got, big);
    assert.equal(source.stats.slices.length, 6);
    // Each range is read widened by the mask's overlap on each side (the scrub inside the read), never more.
    const most = CHUNK + 2 * maskOverlap(source.forms);
    assert.ok(Math.max(...source.stats.slices) <= most);
    assert.ok(Math.max(...source.stats.sizes) <= most);
    assert.equal(source.stats.whole, 0, "arrayBuffer/text was never called on the whole Blob");
});

test("open and stat read no bytes at all", T, async () => {
    const { ch, source } = setup();
    await ch.stat("attached/h1/a.bin");
    const { fd } = await ch.open("attached/h1/a.bin");
    await ch.fstat(fd);
    await ch.opendir("attached/h1", { limit: 5 });
    assert.equal(source.stats.slices.length, 0);
    assert.equal(source.stats.whole, 0);
});

test("fstat answers the open file's stat", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    const st = await ch.fstat(fd);
    assert.equal(st.kind, "file");
    assert.equal(st.size, 1000);
    assert.equal(st.readonly, true);
});

// --- the scrub inside the read: every match becomes as many `*`, length and offsets kept ---

const SECRET = "s3cr3t-value-0123";
const stars = (n) => "*".repeat(n);
/** A file of `n` bytes of `.` with `text` written at each offset in `at`. */
const fileWith = (n, text, at) => { const b = new Uint8Array(n).fill(0x2e); for (const o of at) b.set(new TextEncoder().encode(text), o); return b; };
/** One session "s1" holding `bytes` as attached/hs/f.bin, with `forms` registered. */
function scrubSetup(bytes, forms = [{ find: SECRET }]) {
    const r = setup({ data: { ks: bytes }, sessions: { s1: [row("hs", "f.bin", "ks", bytes)] } });
    r.source.forms = forms;
    return r;
}
const readAt = async (ch, fd, pos, len) => { const d = new Uint8Array(len); const n = await ch.read(fd, pos, len, d); return new TextDecoder("latin1").decode(d.subarray(0, n)); };

test("a registered value in a file reads as as many `*`; the size, st_size and every other byte are unchanged", T, async () => {
    const bytes = fileWith(100, SECRET, [10, 60]);
    const { ch } = scrubSetup(bytes);
    const { fd, size } = await ch.open("attached/hs/f.bin");
    assert.equal(size, 100);
    assert.equal((await ch.fstat(fd)).size, 100);
    assert.equal((await ch.stat("attached/hs/f.bin")).size, 100);
    const got = await readAt(ch, fd, 0, 100);
    assert.equal(got, `${".".repeat(10)}${stars(SECRET.length)}${".".repeat(60 - 10 - SECRET.length)}${stars(SECRET.length)}${".".repeat(100 - 60 - SECRET.length)}`);
    assert.equal(got.length, 100);
});

test("a value split across a 512 KiB range boundary is masked in both reads, each its own half", T, async () => {
    const at = CHUNK - 5;
    const bytes = fileWith(CHUNK + 1000, SECRET, [at]);
    const { ch } = scrubSetup(bytes);
    const { fd } = await ch.open("attached/hs/f.bin");
    const a = await readAt(ch, fd, 0, CHUNK);
    const b = await readAt(ch, fd, CHUNK, CHUNK);
    assert.equal(a.slice(-6), `.${stars(5)}`);
    assert.equal(b.slice(0, SECRET.length - 5 + 1), `${stars(SECRET.length - 5)}.`);
    assert.ok(!(a + b).includes(SECRET.slice(0, 5)) && !(a + b).includes(SECRET.slice(5)), "no fragment of it in either read");
    assert.equal(a.length + b.length, CHUNK + 1000);
});

test("the widened window is clamped at the file's start and end: a value at byte 0 and one ending at the last byte are masked", T, async () => {
    const bytes = fileWith(50, SECRET, [0, 50 - SECRET.length]);
    const { ch, source } = scrubSetup(bytes);
    const { fd } = await ch.open("attached/hs/f.bin");
    assert.equal(await readAt(ch, fd, 0, 3), "***");
    assert.equal(await readAt(ch, fd, 47, 3), "***");
    assert.equal(await readAt(ch, fd, 47, 100), "***", "a read past the end is cut at it");
    assert.ok(source.stats.slices.every((n) => n <= 50), "never sliced past the file");
});

test("a form longer than the range still masks it when it straddles both edges", T, async () => {
    const long = `${SECRET}-${"x".repeat(300)}`;
    const bytes = fileWith(1000, long, [100]);
    const { ch } = scrubSetup(bytes, [{ find: long }]);
    const { fd } = await ch.open("attached/hs/f.bin");
    assert.equal(await readAt(ch, fd, 250, 3), "***");
    assert.equal(await readAt(ch, fd, 100 + long.length - 1, 2), "*.");
    assert.equal(await readAt(ch, fd, 99, 2), ".*");
});

test("a ci form masks either case; a form with non-ASCII characters is matched as its UTF-8 bytes", T, async () => {
    const text = "GET HTTP://Host.Example/x and pässwörd-1234";
    const bytes = new TextEncoder().encode(text);
    const { ch } = scrubSetup(bytes, [{ find: "http://host.example", ci: true }, { find: "pässwörd-1234" }]);
    const { fd, size } = await ch.open("attached/hs/f.bin");
    assert.equal(size, bytes.length);
    assert.equal(await readAt(ch, fd, 0, size), `GET ${stars(19)}/x and ${stars(new TextEncoder().encode("pässwörd-1234").length)}`);
});

test("the forms are asked at every read: a value registered after a read masks the next one through the same descriptor", T, async () => {
    const bytes = fileWith(100, SECRET, [20]);
    const { ch, source } = scrubSetup(bytes, []);
    const { fd } = await ch.open("attached/hs/f.bin");
    assert.ok((await readAt(ch, fd, 0, 100)).includes(SECRET));
    source.forms = [{ find: SECRET }];
    assert.ok(!(await readAt(ch, fd, 0, 100)).includes(SECRET));
    assert.equal(source.stats.formsCalls, 2);
});

test("forms that cannot be read, or are malformed, fail the read with EIO naming nothing, and write nothing into dest", T, async () => {
    const bytes = fileWith(100, SECRET, [20]);
    const { ch, source } = scrubSetup(bytes);
    const { fd } = await ch.open("attached/hs/f.bin");
    for (const set of [() => { source.formsFail = true; }, () => { source.formsFail = false; source.forms = null; }, () => { source.forms = [{ find: 7 }]; }, () => { source.forms = [null]; }]) {
        set();
        const dest = new Uint8Array(100).fill(9);
        const e = await refused(ch.read(fd, 0, 100, dest), "EIO", "read");
        assert.ok(!e.message.includes(URL_SECRET) && !e.message.includes(KEY_SECRET) && !e.message.includes(SECRET));
        assert.ok(dest.every((x) => x === 9), "dest untouched");
    }
});

test("a zip with a stored member holding the value keeps every offset: its central directory still points at its entries", T, async () => {
    // A stored (uncompressed) member's bytes are the file's bytes, so the mask lands inside the member and nowhere else.
    const member = new TextEncoder().encode(`user=admin\npass=${SECRET}\n`);
    const name = new TextEncoder().encode("creds.txt");
    const u16 = (v) => [v & 0xff, v >> 8], u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    const local = [...u32(0x04034b50), ...u16(10), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(member.length), ...u32(member.length), ...u16(name.length), ...u16(0), ...name, ...member];
    const central = [...u32(0x02014b50), ...u16(10), ...u16(10), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(member.length), ...u32(member.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name];
    const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(local.length), ...u16(0)];
    const zip = Uint8Array.from([...local, ...central, ...end]);
    const { ch } = scrubSetup(zip);
    const { fd, size } = await ch.open("attached/hs/f.bin");
    const d = new Uint8Array(size);
    assert.equal(await ch.read(fd, 0, size, d), zip.length);
    const dv = new DataView(d.buffer);
    const eocd = size - 22;
    assert.equal(dv.getUint32(eocd, true), 0x06054b50);
    const cdAt = dv.getUint32(eocd + 16, true);
    assert.equal(dv.getUint32(cdAt, true), 0x02014b50, "the central directory is where the end record says");
    assert.equal(dv.getUint32(dv.getUint32(cdAt + 42, true), true), 0x04034b50, "the member's header is where the directory says");
    const dataAt = 30 + name.length;
    const got = new TextDecoder().decode(d.subarray(dataAt, dataAt + member.length));
    assert.equal(got, `user=admin\npass=${stars(SECRET.length)}\n`);
});

// --- errors: plain objects, nothing a source said ---

test("a refused call rejects with a plain object, not an Error", T, async () => {
    const { ch } = setup();
    const e = await refused(ch.stat("nope"), "ENOENT", "stat");
    assert.ok(!(e instanceof Error));
    assert.equal(Object.getPrototypeOf(e), Object.prototype);
    assert.equal(e.path, "nope");
    assert.equal(typeof e.message, "string");
    assert.ok(e.message.includes("nope"));
});

test("an error without a path has no path key", T, async () => {
    const { ch } = setup();
    const e = await refused(ch.close(999), "EBADF", "close");
    assert.ok(!("path" in e));
});

test("a source failure on open becomes EIO naming neither the URL nor the key", T, async () => {
    const { ch, source } = setup();
    source.fail = true;
    const e = await refused(ch.open("attached/h1/a.bin"), "EIO", "open");
    assert.ok(!(e instanceof Error));
    assert.ok(!e.message.includes(URL_SECRET) && !e.message.includes("llm.internal") && !e.message.includes(KEY_SECRET));
    assert.ok(!JSON.stringify(e).includes(KEY_SECRET));
});

test("a source failure on listing becomes EIO naming neither the URL nor the key", T, async () => {
    const sessions = new Proxy({}, { get: () => { throw new Error(`down ${URL_SECRET} ${KEY_SECRET}`); } });
    const source = { attached: async (s) => sessions[s], blob: async () => { throw new Error("x"); } };
    const ch = new RangedReader({ source }).openChannel("files");
    ch.setSession("s1");
    const e = await refused(ch.stat("attached"), "EIO", "stat");
    assert.ok(!e.message.includes(URL_SECRET) && !e.message.includes(KEY_SECRET));
});

test("a source failure when a range is read becomes EIO naming neither the URL nor the key", T, async () => {
    const src = fakeSource({ s1: [row("h1", "a.bin", "k1", pattern(10))] }, { k1: pattern(10) });
    const orig = src.blob;
    src.blob = async (...a) => {
        const b = await orig(...a);
        return { size: b.size, slice: () => ({ arrayBuffer: async () => { throw new Error(`read ${URL_SECRET} ${KEY_SECRET}`); } }) };
    };
    const ch2 = new RangedReader({ source: src }).openChannel("files");
    ch2.setSession("s1");
    const { fd: fd2 } = await ch2.open("attached/h1/a.bin");
    const e = await refused(ch2.read(fd2, 0, 4, new Uint8Array(4)), "EIO", "read");
    assert.ok(!e.message.includes(URL_SECRET) && !e.message.includes(KEY_SECRET));
});

// --- hidden: refused at open and at every read ---

test("open of a hidden path is EACCES naming the path as hidden", T, async () => {
    const { ch, hiddenSet, source } = setup();
    hiddenSet.add("s1:attached/h1/a.bin");
    const e = await refused(ch.open("attached/h1/a.bin"), "EACCES", "open");
    assert.equal(e.path, "attached/h1/a.bin");
    assert.match(e.message, /attached\/h1\/a\.bin.*hidden/);
    assert.equal(source.stats.blobCalls, 0, "the bytes were never fetched");
});

test("a file hidden after open makes the next read EACCES, and it is still listed hidden", T, async () => {
    const { ch, hiddenSet } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    assert.equal(await ch.read(fd, 0, 4, new Uint8Array(4)), 4);
    hiddenSet.add("s1:attached/h1/a.bin");
    const dest = new Uint8Array(4).fill(0xaa);
    const e = await refused(ch.read(fd, 0, 4, dest), "EACCES", "read");
    assert.equal(e.path, "attached/h1/a.bin");
    assert.ok(dest.every((b) => b === 0xaa));
    const page = await ch.opendir("attached/h1", { limit: 5 });
    assert.equal(page.entries[0].hidden, true);
});

test("the hide rule is asked with the session and the canonical path", T, async () => {
    const asked = [];
    const source = fakeSource({ s1: [row("h1", "a.bin", "k1", pattern(5))] }, { k1: pattern(5) });
    const ch = new RangedReader({ source, hidden: (s, p) => { asked.push([s, p]); return false; } }).openChannel("files");
    ch.setSession("s1");
    await ch.open("attached/h1/a.bin");
    assert.ok(asked.some(([s, p]) => s === "s1" && p === "attached/h1/a.bin"));
});

// --- descriptors and sessions ---

test("close then read is EBADF; a second close is EBADF", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    await ch.close(fd);
    await refused(ch.read(fd, 0, 4, new Uint8Array(4)), "EBADF", "read");
    await refused(ch.fstat(fd), "EBADF", "fstat");
    await refused(ch.close(fd), "EBADF", "close");
});

test("a descriptor that was never opened is EBADF", T, async () => {
    const { ch } = setup();
    for (const fd of [0, 1, 2, 3, 12345, -1, 1.5, "3", undefined]) await refused(ch.read(fd, 0, 1, new Uint8Array(1)), "EBADF", "read");
});

test("an fd from channel A is EBADF on channel B, even for the same session", T, async () => {
    const { reader, ch } = setup();
    const chB = reader.openChannel("files");
    chB.setSession("s1");
    const { fd } = await ch.open("attached/h1/a.bin");
    await refused(chB.read(fd, 0, 1, new Uint8Array(1)), "EBADF", "read");
    await refused(chB.close(fd), "EBADF", "close");
    assert.equal(await ch.read(fd, 0, 1, new Uint8Array(1)), 1, "A's fd still works");
});

test("descriptor numbers are never reused across channels", T, async () => {
    const { reader, ch } = setup();
    const chB = reader.openChannel("files");
    chB.setSession("s1");
    const a = await ch.open("attached/h1/a.bin");
    const b = await chB.open("attached/h1/a.bin");
    assert.notEqual(a.fd, b.fd);
});

test("setSession to another hash makes an earlier fd EBADF", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    ch.setSession("s2");
    await refused(ch.read(fd, 0, 1, new Uint8Array(1)), "EBADF", "read");
    await refused(ch.fstat(fd), "EBADF", "fstat");
    assert.equal((await ch.stat("attached/h9/other.txt")).size, 10, "the new session's files are served");
    await refused(ch.stat("attached/h1/a.bin"), "ENOENT", "stat");
});

test("a session change closes the channel's descriptors and transactions: switching back revives neither", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    const txn = await ch.begin();
    ch.setSession("s2");
    ch.setSession("s1");
    await refused(ch.read(fd, 0, 1, new Uint8Array(1)), "EBADF", "read");
    await refused(ch.commitTx(txn), "EBADF", "commit");
});

test("setSession(null) and the empty string make every call EBADF", T, async () => {
    for (const hash of [null, ""]) {
        const { ch } = setup();
        const { fd } = await ch.open("attached/h1/a.bin");
        ch.setSession(hash);
        await refused(ch.stat(""), "EBADF", "stat");
        await refused(ch.opendir("", { limit: 5 }), "EBADF", "opendir");
        await refused(ch.open("attached/h1/a.bin"), "EBADF", "open");
        await refused(ch.read(fd, 0, 1, new Uint8Array(1)), "EBADF", "read");
        await refused(ch.fstat(fd), "EBADF", "fstat");
        await refused(ch.close(fd), "EBADF", "close");
        await refused(ch.begin(), "EBADF", "begin");
        assert.equal(ch.home, undefined);
    }
});

test("a channel with no session yet answers EBADF", T, async () => {
    const reader = new RangedReader({ source: fakeSource({}, {}) });
    const ch = reader.openChannel("files");
    assert.equal(ch.home, undefined);
    await refused(ch.stat(""), "EBADF", "stat");
});

test("dispose makes every call EBADF, home undefined, and setSession afterwards changes nothing", T, async () => {
    const { ch } = setup();
    const { fd } = await ch.open("attached/h1/a.bin");
    const t = await ch.begin();
    ch.dispose();
    assert.equal(ch.home, undefined);
    await refused(ch.stat(""), "EBADF");
    await refused(ch.opendir("", { limit: 1 }), "EBADF");
    await refused(ch.open("attached/h1/a.bin"), "EBADF");
    await refused(ch.read(fd, 0, 1, new Uint8Array(1)), "EBADF");
    await refused(ch.fstat(fd), "EBADF");
    await refused(ch.close(fd), "EBADF");
    await refused(ch.commitTx(t), "EBADF");
    await refused(ch.abortTx(t), "EBADF");
    ch.setSession("s1");
    assert.equal(ch.home, undefined);
    await refused(ch.stat(""), "EBADF");
});

test("dispose of one channel leaves another channel's descriptors working", T, async () => {
    const { reader, ch } = setup();
    const chB = reader.openChannel("files");
    chB.setSession("s1");
    const { fd } = await chB.open("attached/h1/a.bin");
    ch.dispose();
    assert.equal(await chB.read(fd, 0, 1, new Uint8Array(1)), 1);
});

test("home is /files/agent once there is a session", T, async () => {
    const { ch } = setup();
    assert.equal(ch.home, "/files/agent");
    assert.equal(FILES_HOME, "/files/agent");
});

test("openChannel on an unknown volume throws", T, async () => {
    const { reader } = setup();
    assert.throws(() => reader.openChannel("history"), /no volume/);
});

// --- the race: a range or an open in flight when the channel changes ---

test("a read in flight when its fd is closed rejects EBADF and leaves dest untouched", T, async () => {
    const { ch, source } = setup();
    source.gate = deferred();
    const { fd } = await ch.open("attached/h1/a.bin");
    const dest = new Uint8Array(16).fill(0xaa);
    const settled = refused(ch.read(fd, 0, 16, dest), "EBADF", "read");
    await ch.close(fd);
    source.gate.resolve();
    await settled;
    assert.ok(dest.every((b) => b === 0xaa));
});

test("a read in flight when the channel is disposed rejects EBADF and leaves dest untouched", T, async () => {
    const { ch, source } = setup();
    source.gate = deferred();
    const { fd } = await ch.open("attached/h1/a.bin");
    const dest = new Uint8Array(16).fill(0xaa);
    const settled = refused(ch.read(fd, 0, 16, dest), "EBADF", "read");
    ch.dispose();
    source.gate.resolve();
    await settled;
    assert.ok(dest.every((b) => b === 0xaa));
});

test("a read in flight when the session changes rejects EBADF and leaves dest untouched", T, async () => {
    const { ch, source } = setup();
    source.gate = deferred();
    const { fd } = await ch.open("attached/h1/a.bin");
    const dest = new Uint8Array(16).fill(0xaa);
    const settled = refused(ch.read(fd, 0, 16, dest), "EBADF", "read");
    ch.setSession("s2");
    source.gate.resolve();
    await settled;
    assert.ok(dest.every((b) => b === 0xaa));
});

test("a read in flight that is not disturbed lands its bytes once released", T, async () => {
    const { ch, source, small } = setup();
    source.gate = deferred();
    const { fd } = await ch.open("attached/h1/a.bin");
    const dest = new Uint8Array(16).fill(0xaa);
    const p = ch.read(fd, 0, 16, dest);
    source.gate.resolve();
    assert.equal(await p, 16);
    assert.deepEqual(dest, small.subarray(0, 16));
});

test("an open racing a dispose rejects EBADF and leaves no descriptor behind", T, async () => {
    const { ch, source } = setup();
    source.blobGate = deferred();
    const settled = refused(ch.open("attached/h1/a.bin"), "EBADF", "open");
    ch.dispose();
    source.blobGate.resolve();
    await settled;
});

test("an open racing a session change rejects EBADF", T, async () => {
    const { ch, source } = setup();
    source.blobGate = deferred();
    const settled = refused(ch.open("attached/h1/a.bin"), "EBADF", "open");
    ch.setSession("s2");
    source.blobGate.resolve();
    await settled;
});

// --- opendir paging ---

const manyHandles = (n) => Array.from({ length: n }, (_, i) => row(`h${String(i).padStart(4, "0")}`, "f.txt", "kx", pattern(1)));

test("opendir with 7 handles and limit 3 chains pages by cursor, each entry once, the last page without next", T, async () => {
    const { ch } = setup({ sessions: { s1: manyHandles(7) }, data: { kx: pattern(1) } });
    const seen = [];
    const sizes = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
        const page = await ch.opendir("attached", { limit: 3, ...(cursor ? { cursor } : {}) });
        sizes.push(page.entries.length);
        seen.push(...page.entries.map((e) => e.name));
        if (!page.next) break;
        cursor = page.next;
    }
    assert.deepEqual(sizes, [3, 3, 1]);
    assert.deepEqual(seen, manyHandles(7).map((r) => r.handle));
});

test("an exactly full last page has no next", T, async () => {
    const { ch } = setup({ sessions: { s1: manyHandles(6) }, data: { kx: pattern(1) } });
    const p1 = await ch.opendir("attached", { limit: 3 });
    assert.ok(p1.next);
    const p2 = await ch.opendir("attached", { limit: 3, cursor: p1.next });
    assert.equal(p2.entries.length, 3);
    assert.equal(p2.next, undefined);
});

test("opendir caps a page at 500 entries whatever the limit", T, async () => {
    const { ch } = setup({ sessions: { s1: manyHandles(600) }, data: { kx: pattern(1) } });
    assert.equal(DIR_PAGE_MAX, 500);
    const p1 = await ch.opendir("attached", { limit: 10_000 });
    assert.equal(p1.entries.length, 500);
    assert.ok(p1.next);
    const p2 = await ch.opendir("attached", { limit: 10_000, cursor: p1.next });
    assert.equal(p2.entries.length, 100);
    assert.equal(p2.next, undefined);
});

test("opendir with a bad cursor is EINVAL", T, async () => {
    const { ch } = setup();
    for (const cursor of ["zzz", "", 5, {}, null]) await refused(ch.opendir("attached", { limit: 3, cursor }), "EINVAL", "opendir");
});

test("opendir with limit 0, negative, fractional or missing is EINVAL", T, async () => {
    const { ch } = setup();
    for (const limit of [0, -1, 1.5, NaN, undefined, "3"]) await refused(ch.opendir("attached", { limit }), "EINVAL", "opendir");
    await refused(ch.opendir("attached", undefined), "EINVAL", "opendir");
});

test("a cursor past the last name answers an empty page without next", T, async () => {
    const { ch } = setup();
    const page = await ch.opendir("attached", { limit: 3, cursor: "c:zzzz" });
    assert.deepEqual(page, { entries: [] });
});

test("two attachments with the same handle list the handle once", T, async () => {
    const { ch } = setup({ sessions: { s1: [row("h1", "a", "k1", pattern(5)), row("h1", "a", "k1", pattern(5))] } });
    const page = await ch.opendir("attached", { limit: 10 });
    assert.deepEqual(page.entries.map((e) => e.name), ["h1"]);
});

// --- the write side: slice 1 is read-only ---

test("begin returns a number", T, async () => {
    const { ch } = setup();
    assert.equal(typeof (await ch.begin()), "number");
});

test("write verbs on agent/x and attached/... under a begun txn are EROFS", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    for (const p of ["agent/x", "attached/h1/a.bin", "attached/new"]) {
        await refused(ch.openWrite(p, "w", t), "EROFS", "open");
        await refused(ch.mkdir(p, t), "EROFS", "mkdir");
        await refused(ch.unlink(p, t), "EROFS", "unlink");
        await refused(ch.rmdir(p, t), "EROFS", "rmdir");
        await refused(ch.rename(p, "agent/y", t), "EROFS", "rename");
        await refused(ch.rename("agent/y", p, t), "EROFS", "rename");
    }
});

test("write verbs with a bogus txn are EBADF", T, async () => {
    const { ch } = setup();
    for (const t of [0, 999, -1, "1", undefined, null]) {
        await refused(ch.openWrite("agent/x", "w", t), "EBADF");
        await refused(ch.mkdir("agent/x", t), "EBADF");
        await refused(ch.unlink("agent/x", t), "EBADF");
        await refused(ch.rmdir("agent/x", t), "EBADF");
        await refused(ch.rename("agent/x", "agent/y", t), "EBADF");
    }
});

test("a write verb with a non-canonical path under a begun txn is ENOENT", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    await refused(ch.mkdir("/agent/x", t), "ENOENT", "mkdir");
    await refused(ch.openWrite("agent/../x", "w", t), "ENOENT", "open");
});

test("write, truncate and closeWrite on any number are EBADF", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    for (const n of [0, 3, t, 999]) {
        await refused(ch.write(n, 0, new Uint8Array(1)), "EBADF", "write");
        await refused(ch.truncate(n, 0), "EBADF", "ftruncate");
        await refused(ch.closeWrite(n), "EBADF", "close");
    }
});

test("commitTx and abortTx of a begun txn resolve, and a second one is EBADF", T, async () => {
    const { ch } = setup();
    const a = await ch.begin();
    const b = await ch.begin();
    assert.notEqual(a, b);
    await ch.commitTx(a);
    await refused(ch.commitTx(a), "EBADF", "commit");
    await refused(ch.abortTx(a), "EBADF", "abort");
    await ch.abortTx(b);
    await refused(ch.abortTx(b), "EBADF", "abort");
    await refused(ch.mkdir("agent/x", a), "EBADF");
});

test("a txn from another session is EBADF", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    ch.setSession("s2");
    await refused(ch.commitTx(t), "EBADF", "commit");
    await refused(ch.mkdir("agent/x", t), "EBADF");
    await refused(ch.stat("", { txn: t }), "EBADF", "stat");
});

test("a txn from another channel is EBADF, and a txn number is not a descriptor", T, async () => {
    const { reader, ch } = setup();
    const chB = reader.openChannel("files");
    chB.setSession("s1");
    const t = await ch.begin();
    await refused(chB.commitTx(t), "EBADF", "commit");
    await refused(ch.read(t, 0, 1, new Uint8Array(1)), "EBADF", "read");
    await ch.commitTx(t);
});

test("reads accept a live txn and reject a bogus one", T, async () => {
    const { ch } = setup();
    const t = await ch.begin();
    assert.equal((await ch.stat("attached/h1/a.bin", { txn: t })).size, 1000);
    await refused(ch.stat("attached/h1/a.bin", { txn: 4242 }), "EBADF", "stat");
    await refused(ch.open("attached/h1/a.bin", { txn: 4242 }), "EBADF", "open");
});
