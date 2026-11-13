// mount-judge.test.mjs — a mounted folder's requests as src/shell/mount-judge.ts judges them, with no worker: the
// built-in default over the host's facts (FILE_ATTACHMENTS.md, the table "What runs free, what asks, what is refused"),
// and the mount calls of the host client over a fake port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeMount, fetchWhole, storeWhole } from "../src/shell/mount-judge.ts";
import { HostClient, HostError, hostOffersMounts, READ_CHUNK } from "../src/shell/host-protocol.ts";

const basis = { dev: 1, ino: 2, size: 3, mtimeNs: 4, sha256: "ab" };

/** The facts of a tracked, unchanged file in a writable mount; `over` changes some. */
const facts = (over = {}) => ({
    mount: "m1", path: "a.txt", inMount: true, mode: "rw", kind: "file", exists: true, secret: false, protected: false,
    ignored: false, inUploads: false, inAttached: false, gitUndoable: true, hardLinked: false, basis, ...over,
});

/** Every combination of the boolean facts and the tri-state ones, for a path that exists and one that does not. */
function* everyFacts() {
    const bools = ["secret", "protected", "inUploads", "inAttached", "hardLinked"];
    for (let mask = 0; mask < 1 << bools.length; mask++) {
        for (const mode of ["rw", "ro"]) for (const gitUndoable of [true, false, null]) for (const exists of [true, false]) {
            const f = facts({ mode, gitUndoable, exists, kind: exists ? "file" : null, basis: exists ? basis : null });
            bools.forEach((k, i) => { f[k] = !!(mask & (1 << i)); });
            if (f.inAttached) f.inUploads = true;
            yield f;
        }
    }
}

// --- reads ---

test("a read in a mount is free, a secret-looking one asks, and a missing file or a directory is refused", () => {
    assert.equal(judgeMount("read", facts()).verdict, "free");
    assert.equal(judgeMount("read", facts({ secret: true })).verdict, "ask");
    assert.equal(judgeMount("read", facts({ exists: false, kind: null, basis: null })).verdict, "refused");
    assert.equal(judgeMount("read", facts({ kind: "dir" })).verdict, "refused");
    assert.equal(judgeMount("read", facts({ kind: "symlink" })).verdict, "refused");
    assert.equal(judgeMount("read", facts({ mode: "ro" })).verdict, "free", "a read-only mount is read freely");
    assert.equal(judgeMount("read", facts({ gitUndoable: false })).verdict, "free", "git does not bound a read");
    assert.deepEqual(judgeMount("read", facts()).basis, basis, "the basis the read must carry is the host's");
});

// --- writes and deletes, enumerated ---

test("over every combination of facts, the hard refusals hold for a write whatever else applies", () => {
    for (const f of everyFacts()) {
        const v = judgeMount("write", f).verdict;
        const hard = f.mode === "ro" || f.protected || f.inAttached || (f.exists && f.hardLinked);
        if (hard) assert.equal(v, "refused", JSON.stringify(f));
        else assert.notEqual(v, "refused", JSON.stringify(f));
    }
});

test("over every combination of facts, a write that is not refused is free exactly when nothing asks", () => {
    for (const f of everyFacts()) {
        const v = judgeMount("write", f).verdict;
        if (v === "refused") continue;
        const asks = f.secret || (f.exists && !f.inUploads && f.gitUndoable !== true);
        assert.equal(v, asks ? "ask" : "free", JSON.stringify(f));
    }
});

test("over every combination of facts, a delete asks in attached/ and is refused only by mode, protection or absence", () => {
    for (const f of everyFacts()) {
        const v = judgeMount("delete", f).verdict;
        if (f.mode === "ro" || f.protected || !f.exists) { assert.equal(v, "refused", JSON.stringify(f)); continue; }
        const asks = f.secret || f.inAttached || (!f.inUploads && f.gitUndoable !== true);
        assert.equal(v, asks ? "ask" : "free", JSON.stringify(f));
        assert.notEqual(v, "refused", "a hard link does not refuse a delete: no other name changes");
    }
});

test("the default rows: git can undo is free, cannot or cannot be asked asks, a new file is free", () => {
    assert.equal(judgeMount("write", facts()).verdict, "free");
    assert.equal(judgeMount("write", facts({ gitUndoable: false })).verdict, "ask");
    assert.equal(judgeMount("write", facts({ gitUndoable: null })).verdict, "ask");
    assert.equal(judgeMount("write", facts({ exists: false, kind: null, basis: null, gitUndoable: false })).verdict, "free");
    assert.equal(judgeMount("write", facts({ inUploads: true, gitUndoable: false })).verdict, "free", "the uploads row stands in for git's");
    assert.equal(judgeMount("write", facts({ inUploads: true, secret: true })).verdict, "ask", "a secret-looking file in the uploads folder asks");
    assert.equal(judgeMount("write", facts({ exists: false, kind: null, mode: "ro" })).verdict, "refused", "a new file in a read-only mount");
    assert.equal(judgeMount("write", facts({ exists: false, kind: null, inUploads: true, inAttached: true })).verdict, "refused", "a new file in attached/");
    assert.equal(judgeMount("write", facts({ kind: "dir" })).verdict, "refused");
    assert.equal(judgeMount("write", facts({ inMount: false })).verdict, "refused");
});

test("every row names the fact behind it, and the verdict is the most restrictive row", () => {
    for (const f of everyFacts()) for (const op of ["read", "write", "delete"]) {
        const j = judgeMount(op, f);
        assert.ok(j.rows.length > 0, `${op} ${JSON.stringify(f)}`);
        for (const r of j.rows) assert.ok(r.fact && r.why, JSON.stringify(r));
        const worst = j.rows.some((r) => r.verdict === "refused") ? "refused" : j.rows.some((r) => r.verdict === "ask") ? "ask" : "free";
        assert.equal(j.verdict, worst);
    }
});

// --- renames ---

test("a rename is judged as its source's delete and a new name, refused onto an existing name or into attached/", () => {
    const free = facts({ path: "b.txt", exists: false, kind: null, basis: null });
    assert.equal(judgeMount("rename", facts(), free).verdict, "free");
    assert.equal(judgeMount("rename", facts({ gitUndoable: false }), free).verdict, "ask");
    assert.equal(judgeMount("rename", facts(), facts({ path: "b.txt" })).verdict, "refused", "the target exists");
    assert.equal(judgeMount("rename", facts(), { ...free, inAttached: true, inUploads: true }).verdict, "refused");
    assert.equal(judgeMount("rename", facts({ inAttached: true, inUploads: true }), free).verdict, "refused", "out of attached/");
    assert.equal(judgeMount("rename", facts(), { ...free, protected: true }).verdict, "refused");
    assert.equal(judgeMount("rename", facts(), { ...free, secret: true }).verdict, "ask");
    assert.equal(judgeMount("rename", facts()).verdict, "refused", "a rename whose target was not looked at");
});

// --- the host client's mount calls ---

/** A port whose other end the test plays. */
function fakePort() {
    const sent = [];
    let onMsg;
    return { sent, port: { send: (m) => sent.push(m), onMessage: (cb) => { onMsg = cb; }, onClose: () => {} }, reply: (m) => onMsg(m) };
}

/** Answer every call as it is sent, with `answer(msg)`. */
function autoPort(answer) {
    const f = fakePort();
    const send = f.port.send;
    f.port.send = (m) => { send(m); queueMicrotask(() => f.reply({ seq: m.seq, ...answer(m) })); };
    return f;
}

test("only `mounts: true` in hello offers the mount calls; anything else reads as an older host", () => {
    assert.equal(hostOffersMounts({ mounts: true }), true);
    for (const m of [false, "yes", 1, {}, null, undefined]) assert.equal(hostOffersMounts({ mounts: m }), false, String(m));
    assert.equal(hostOffersMounts(undefined), false);
});

test("an error's fields beside code and message reach the caller as detail: EFBIG's size and cap", async () => {
    const f = fakePort();
    const c = new HostClient(f.port);
    const p = c.fetch({ session: "s", mount: "m1", path: "big", basis, offset: 0, length: 1 << 30 });
    assert.equal(f.sent[0].args.length, READ_CHUNK, "a fetch asks for at most one chunk");
    f.reply({ seq: f.sent[0].seq, error: { code: "EFBIG", message: "big is 9 bytes", size: 9, cap: 4 } });
    await assert.rejects(p, (e) => e instanceof HostError && e.code === "EFBIG" && e.detail.size === 9 && e.detail.cap === 4);
});

test("a whole read sends the judged basis with every chunk and reassembles the bytes", async () => {
    const body = new Uint8Array(READ_CHUNK + 10).map((_, i) => i % 251);
    const b = { ...basis, size: body.length };
    const f = autoPort((m) => {
        const { offset, length } = m.args;
        const part = body.subarray(offset, offset + length);
        return { value: { mount: "m1", path: "x", offset, size: body.length, eof: offset + part.length >= body.length, data: { $bytes: Buffer.from(part).toString("base64") } } };
    });
    const got = await fetchWhole(new HostClient(f.port), { session: "s", mount: "m1", path: "x" }, b, 1 << 20);
    assert.deepEqual(got, body);
    assert.equal(f.sent.length, 2);
    for (const m of f.sent) assert.deepEqual(m.args.basis, b);
});

test("a whole read over the cap fails EFBIG before anything is sent, and a size that moved fails ChangedSinceJudged", async () => {
    const f = fakePort();
    await assert.rejects(fetchWhole(new HostClient(f.port), { session: "s", mount: "m1", path: "x" }, { ...basis, size: 10 }, 5), (e) => e.code === "EFBIG" && e.detail.size === 10);
    assert.equal(f.sent.length, 0);
    const g = autoPort((m) => ({ value: { offset: m.args.offset, size: 99, eof: true, data: { $bytes: "" } } }));
    await assert.rejects(fetchWhole(new HostClient(g.port), { session: "s", mount: "m1", path: "x" }, basis, 5), (e) => e.code === "ChangedSinceJudged");
});

test("a whole write sends the basis only for an existing file, chunks the bytes, and commits the store by its id", async () => {
    const f = autoPort((m) => ({ value: m.call === "store" ? { id: "s9" } : { id: "s9", received: 0 } }));
    const c = new HostClient(f.port);
    const bytes = new Uint8Array(READ_CHUNK * 2 + 1);
    await storeWhole(c, { session: "s", mount: "m1", path: "x" }, bytes, null, 1 << 30);
    assert.deepEqual(f.sent.map((m) => m.call), ["store", "write", "write", "write", "commit"]);
    assert.equal("basis" in f.sent[0].args, false, "a new file is stored with no basis at all");
    assert.deepEqual(f.sent.slice(1, 4).map((m) => m.args.offset), [0, READ_CHUNK, READ_CHUNK * 2]);
    assert.deepEqual(f.sent[4].args, { id: "s9" }, "a store's commit has no `replace`: the basis decides");
    f.sent.length = 0;
    await storeWhole(c, { session: "s", mount: "m1", path: "x" }, new Uint8Array(1), basis, 1 << 30);
    assert.deepEqual(f.sent[0].args.basis, basis);
});

test("a whole write that fails between chunks discards its store", async () => {
    const f = autoPort((m) => (m.call === "write" ? { error: { code: "BadRequest", message: "no" } } : { value: { id: "s9" } }));
    await assert.rejects(storeWhole(new HostClient(f.port), { session: "s", mount: "m1", path: "x" }, new Uint8Array(4), null, 99), (e) => e.code === "BadRequest");
    assert.deepEqual(f.sent.map((m) => m.call), ["store", "write", "discard"]);
    assert.deepEqual(f.sent[2].args, { id: "s9" });
});
