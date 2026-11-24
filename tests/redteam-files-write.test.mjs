// redteam-files-write.test.mjs — what a hostile cell must NOT get from the write side of `/files` (#2121): the quota
// `filesQuotaMB` enforces (FILE_ATTACHMENTS.md, "Writes"), the store of run-made files (src/session/agent-files.ts), and
// the reader's write verbs over it (src/session/ranged-reader.ts). A cell can write only under `/files/agent/`, only
// inside its session, and only within the session's quota: the quota counts every pending file of the session on every
// channel (so two channels cannot spend it twice) and is checked again inside the store's transaction (so a commit from
// elsewhere between the reader's check and its write cannot cross it, and an ENOSPC commit leaves none of its files);
// no write verb reaches the person's attachments, climbs out with `..`, or names a hidden path; a channel that goes with
// a file uncommitted discards it and keeps the stored version; and a session's channel never reads or writes another
// session's files. A real AgentFiles on fake-indexeddb, as ranged-reader-write.test.mjs builds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { AgentFiles } from "../src/session/agent-files.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const T = { timeout: 10000 };
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

/** A reader over an empty shelf and a fresh store; `ch` is a channel on session s1. */
function setup(over = {}) {
    const agent = over.agent ?? new AgentFiles({ idb: new IDBFactory(), dbName: "t" });
    const lost = [];
    const asked = { blob: 0 };
    const source = { attached: async () => [], blob: async () => { asked.blob++; throw new Error("none"); }, secretForms: async () => [] };
    const deps = { source, now: () => 123, onLost: (r) => lost.push(r), ...over };
    delete deps.quota; delete deps.hidden;
    deps.agent = agent;
    if (over.quota) deps.quotaBytes = over.quota;
    if (over.hidden) deps.hidden = over.hidden;
    const reader = new RangedReader(deps);
    const ch = reader.openChannel("files");
    ch.setSession("s1");
    const more = (session = "s1") => { const c = reader.openChannel("files"); c.setSession(session); return c; };
    return { agent, lost, asked, reader, ch, more };
}

/** Read a whole path through a normal open. */
async function slurp(ch, path) {
    const { fd, size } = await ch.open(path);
    const dest = new Uint8Array(size + 8);
    const n = size ? await ch.read(fd, 0, size, dest) : 0;
    await ch.close(fd);
    return dec(dest.subarray(0, n));
}
/** Write `text` to `path` in its own committed transaction. */
async function put(ch, path, text, flags = "w") {
    const t = await ch.begin();
    const { wfd } = await ch.openWrite(path, flags, t);
    await ch.write(wfd, 0, enc(text));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
}
/** The call must reject with `code`; returns the error. */
async function refused(p, code) {
    let err;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, `expected ${code}, the call resolved`);
    assert.equal(err.code, code, `got ${err.code}: ${err.message}`);
    return err;
}

// --- the quota counts pending parts on every channel, and again at the store's commit ---

test("RED TEAM (files write): the quota counts every pending file of the session on any channel, so two channels cannot spend it twice", T, async () => {
    const { ch, more } = setup({ quota: async () => 10 });
    const other = more();
    const ta = await ch.begin();
    const a = (await ch.openWrite("agent/a.txt", "w", ta)).wfd;
    await ch.write(a, 0, enc("aaaaaa"));
    const tb = await other.begin();
    const b = (await other.openWrite("agent/b.txt", "w", tb)).wfd;
    // 6 pending on one channel plus 6 on the other is over the quota, though neither alone is.
    await refused(other.write(b, 0, enc("bbbbbb")), "ENOSPC");
    await other.write(b, 0, enc("bbbb"));                       // positive control: 6 + 4 fits
    await other.closeWrite(b); await other.commitTx(tb);
    await ch.closeWrite(a); await ch.commitTx(ta);
    assert.equal(await slurp(other, "agent/a.txt"), "aaaaaa");
    assert.equal(await slurp(other, "agent/b.txt"), "bbbb");
    // Stored, both count too: a third file of any size is over.
    const c = more();
    const t = await c.begin();
    const w = (await c.openWrite("agent/c.txt", "w", t)).wfd;
    await refused(c.write(w, 0, enc("c")), "ENOSPC");
    await refused(c.truncate(w, 1), "ENOSPC");
    await c.abortTx(t);
    await refused(c.open("agent/c.txt"), "ENOENT");
});

test("RED TEAM (files write): a commit that lands over the quota fails WHOLE — none of its files land, and what another commit stored stands", T, async () => {
    // Two readers over ONE store: each counts its own channels' pending parts, so this is the commit that lands
    // between one reader's check and its write, which only the store's in-transaction check sees.
    const agent = new AgentFiles({ idb: new IDBFactory(), dbName: "t" });
    const one = setup({ agent, quota: async () => 12 });
    const two = setup({ agent, quota: async () => 12 });
    const t = await one.ch.begin();
    const x = (await one.ch.openWrite("agent/x.bin", "w", t)).wfd;
    await one.ch.write(x, 0, enc("xxxxxx"));              // 6 pending here, 6 ≤ 12
    await put(two.ch, "agent/y.bin", "yyyyyyy");          // the other reader commits 7: 6 + 7 > 12 once both land
    await one.ch.closeWrite(x);
    await refused(one.ch.commitTx(t), "ENOSPC");
    const check = two.more();
    assert.equal(await slurp(check, "agent/y.bin"), "yyyyyyy", "the commit that fit was rolled back too");
    await refused(check.open("agent/x.bin"), "ENOENT");
});

// --- no write verb reaches outside /files/agent/ ---

test("RED TEAM (files write): no write verb reaches outside /files/agent/, and the person's attachments are never asked for", T, async () => {
    const { ch, asked } = setup();
    const t = await ch.begin();
    for (const [what, code, call] of [
        ["the root", "EROFS", () => ch.openWrite("notes.txt", "w", t)],
        ["an attachment", "EROFS", () => ch.openWrite("attached/h1/x.txt", "w", t)],
        ["an absolute path", "ENOENT", () => ch.openWrite("/files/agent/x.txt", "w", t)],
        ["a climb out", "ENOENT", () => ch.openWrite("agent/../attached/h1/x.txt", "w", t)],
        ["a dot segment", "ENOENT", () => ch.openWrite("agent/./x.txt", "w", t)],
        ["a trailing slash", "ENOENT", () => ch.openWrite("agent/d/", "w", t)],
        ["a NUL", "ENOENT", () => ch.openWrite("agent/x\0.txt", "w", t)],
        ["unlink an attachment", "EROFS", () => ch.unlink("attached/h1/x.txt", t)],
        ["rename onto an attachment", "EROFS", () => ch.rename("agent/a.txt", "attached/h1/x.txt", t)],
        ["mkdir an attachment folder", "EROFS", () => ch.mkdir("attached/h1/new", t)],
        ["rmdir an attachment folder", "EROFS", () => ch.rmdir("attached/h1", t)],
    ]) await refused(call(), code);
    // Positive control: agent/ is writable, and the shelf's own bytes were never asked for.
    await ch.closeWrite((await ch.openWrite("agent/ok.txt", "w", t)).wfd);
    await put(ch, "agent/ok.txt", "ok");
    assert.equal(await slurp(ch, "agent/ok.txt"), "ok");
    assert.equal(asked.blob, 0, "a write asked the attachment source for bytes");
});

// --- a hidden path is refused, by the write verbs and by the read-back ---

test("RED TEAM (files write): a hidden path is refused by every write verb, and a descriptor cannot read the bytes of a file hidden after it was opened", T, async () => {
    let hidden = false;
    const { ch } = setup({ hidden: async (_s, p) => hidden && p.startsWith("agent/secret") });
    await put(ch, "agent/secret.txt", "TOPSECRET");
    assert.equal(await slurp(ch, "agent/secret.txt"), "TOPSECRET", "positive control: visible, it reads");
    // A descriptor opened while visible, then the person hides the file: the read-back is refused, not served from the
    // part the descriptor was seeded with.
    const t0 = await ch.begin();
    const w = await ch.openWrite("agent/secret.txt", "a", t0);
    hidden = true;
    await refused(ch.read(w.wfd, 0, 9, new Uint8Array(9)), "EACCES");
    await ch.abortTx(t0);
    const t = await ch.begin();
    for (const [what, call] of [
        ["openWrite w", () => ch.openWrite("agent/secret.txt", "w", t)],
        ["openWrite a", () => ch.openWrite("agent/secret.txt", "a", t)],
        ["openWrite r+", () => ch.openWrite("agent/secret.txt", "r+", t)],
        ["unlink", () => ch.unlink("agent/secret.txt", t)],
        ["rename away", () => ch.rename("agent/secret.txt", "agent/moved.txt", t)],
        ["mkdir inside", () => ch.mkdir("agent/secret/dir", t)],
        ["rmdir", () => ch.rmdir("agent/secret", t)],
    ]) await refused(call(), "EACCES");
    // A rule that throws is a hidden path too: the answer is never "visible".
    const { ch: flaky } = setup({ hidden: (_s, p) => { if (p === "agent/x.txt") throw new Error("the rule failed"); return false; } });
    const t2 = await flaky.begin();
    await refused(flaky.openWrite("agent/x.txt", "w", t2), "EACCES");
});

// --- a channel that goes with a file uncommitted ---

test("RED TEAM (files write): a channel that goes with a file uncommitted discards it, reports it once, and the stored version stands", T, async () => {
    const { ch, lost, more } = setup();
    await put(ch, "agent/f.txt", "v1");
    const other = more();
    const t = await ch.begin();
    const w = (await ch.openWrite("agent/f.txt", "r+", t)).wfd;
    await ch.write(w, 0, enc("EVIL!!"));
    ch.dispose();
    assert.equal(lost.length, 1, "the discarded file was not reported exactly once");
    assert.equal(lost[0].path, "agent/f.txt");
    assert.equal(lost[0].reason, "channel-ended");
    assert.equal(await slurp(other, "agent/f.txt"), "v1", "the discarded write landed");
    // Positive control: a commit on another channel reports no discard.
    await put(other, "agent/g.txt", "v2");
    assert.equal(lost.length, 1);
});

// --- one session's channel, never another's files ---

test("RED TEAM (files write): a channel never reads or overwrites another session's file, and a session change discards what it held", T, async () => {
    const { ch, lost, more } = setup();
    const s2 = more("s2");
    await put(ch, "agent/a.txt", "s1-bytes");
    await refused(s2.open("agent/a.txt"), "ENOENT");
    const t = await s2.begin();
    const w = (await s2.openWrite("agent/a.txt", "w", t)).wfd;   // s2's own file at the same path; no seeding across sessions
    await s2.write(w, 0, enc("s2-bytes"));
    await s2.closeWrite(w); await s2.commitTx(t);
    assert.equal(await slurp(ch, "agent/a.txt"), "s1-bytes", "a write under one session changed another's file");
    assert.equal(await slurp(s2, "agent/a.txt"), "s2-bytes");
    // A session change closes what the channel had open, like its end.
    const t2 = await ch.begin();
    const o = (await ch.openWrite("agent/b.txt", "w", t2)).wfd;
    await ch.write(o, 0, enc("x"));
    ch.setSession("s3");
    assert.deepEqual(lost.map((l) => l.path), ["agent/b.txt"]);
    await refused(more("s1").open("agent/b.txt"), "ENOENT");
});
