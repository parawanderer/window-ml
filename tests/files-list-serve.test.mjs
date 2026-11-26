// FILES.LIST SERVER (src/session/files-list-serve.ts): the offscreen side of the `files.list` command, over the real
// ranged reader and a fake shelf whose Blobs count every read, so "a listing reads no bytes" is a measurement.
import test from "node:test";
import assert from "node:assert/strict";
import { RangedReader, DIR_PAGE_MAX } from "../src/session/ranged-reader.ts";
import { filesListServer } from "../src/session/files-list-serve.ts";

const T = { timeout: 5000 };

/** A shelf: `sessions` maps a session to its rows; every blob() and every read is counted. */
function fakeSource(sessions) {
    const stats = { blobCalls: 0 };
    return {
        stats,
        attached: async (s) => sessions[s] ?? [],
        secretForms: async () => [],
        blob: async () => { stats.blobCalls++; throw new Error("a listing must read no bytes"); },
    };
}

const row = (handle, name, bytes = 10) => ({ handle, name, key: `k-${handle}`, bytes, sha256: `sha-${handle}`, attachedMs: 5000 });

/** A server over a reader on `sessions`, counting the channels it opens and disposes. */
function setup({ sessions = { s1: [row("h1", "a.bin", 1000), row("h2", "b.txt", 50)], s2: [row("h9", "other.txt")] }, hidden = new Set(), agentCount } = {}) {
    const source = fakeSource(sessions);
    const reader = new RangedReader({ source, hidden: (s, p) => hidden.has(`${s}:${p}`), now: () => 123 });
    const chans = { opened: 0, disposed: 0 };
    const server = filesListServer({
        open: () => {
            const ch = reader.openChannel("files");
            chans.opened++;
            const dispose = ch.dispose.bind(ch);
            ch.dispose = () => { chans.disposed++; dispose(); };
            return ch;
        },
        attachedCount: async (s) => (sessions[s] ?? []).length,
        ...(agentCount ? { agentCount } : {}),
    });
    return { server, source, chans };
}

// --- files.list: the root, its count, and what an entry carries ---

test("files.list at the root lists attached/ and agent/ with the attached count; agent absent when no count is given", T, async () => {
    const { server } = setup();
    const r = await server.list("s1", "");
    assert.deepEqual(r.ok.entries.map((e) => [e.name, e.kind]), [["agent", "dir"], ["attached", "dir"]]);
    assert.deepEqual(r.ok.count, { attached: 2 });
});

test("files.list at the root carries the agent count when it reads, and leaves it out when it rejects", T, async () => {
    assert.deepEqual((await setup({ agentCount: async () => 7 }).server.list("s1", "")).ok.count, { attached: 2, agent: 7 });
    assert.deepEqual((await setup({ agentCount: async () => { throw new Error("db closed"); } }).server.list("s1", "")).ok.count, { attached: 2 });
});

test("files.list: only the root's FIRST page has a count, and no other directory has one", T, async () => {
    const { server } = setup();
    assert.equal((await server.list("s1", "attached")).ok.count, undefined);
    const first = await server.list("s1", "", { limit: 1 });
    assert.ok(first.ok.next);
    assert.equal((await server.list("s1", "", { cursor: first.ok.next, limit: 1 })).ok.count, undefined);
});

test("files.list: an entry is exactly name, kind, size, mtimeMs, hidden, readonly (no birthtime, no key)", T, async () => {
    const { server } = setup();
    const [h] = (await server.list("s1", "attached")).ok.entries;
    const [file] = (await server.list("s1", `attached/${h.name}`)).ok.entries;
    assert.deepEqual(Object.keys(file).sort(), ["hidden", "kind", "mtimeMs", "name", "readonly", "size"]);
    assert.deepEqual({ name: file.name, kind: file.kind, size: file.size, hidden: file.hidden, readonly: file.readonly }, { name: "a.bin", kind: "file", size: 1000, hidden: false, readonly: true });
});

test("files.list lists only the named session's files", T, async () => {
    const { server } = setup();
    assert.deepEqual((await server.list("s2", "attached")).ok.entries.map((e) => e.name), ["h9"]);
    assert.deepEqual((await server.list("s2", "")).ok.count, { attached: 1 });
});

// --- files.list: hidden entries and bytes ---

test("files.list lists a hidden file with its hidden mark and stored size, and reads no byte of any file", T, async () => {
    const { server, source } = setup({ hidden: new Set(["s1:attached/h1/a.bin"]) });
    for (const h of ["h1", "h2"]) await server.list("s1", `attached/${h}`);
    const [a] = (await server.list("s1", "attached/h1")).ok.entries;
    assert.deepEqual({ name: a.name, hidden: a.hidden, size: a.size }, { name: "a.bin", hidden: true, size: 1000 });
    assert.equal(source.stats.blobCalls, 0);
});

// --- files.list: refusals ---

test("files.list refuses a file's path as invalid (not a directory) and an unknown path as not-found", T, async () => {
    const { server } = setup();
    assert.deepEqual(await server.list("s1", "attached/h1/a.bin"), { fail: "invalid", message: "not a directory" });
    assert.deepEqual(await server.list("s1", "attached/nope"), { fail: "not-found", message: "no such directory" });
    assert.deepEqual(await server.list("s1", "elsewhere"), { fail: "not-found", message: "no such directory" });
});

test("files.list refuses a path outside the mount as invalid, never resolving it, and opens no channel for it", T, async () => {
    const { server, chans } = setup();
    for (const p of ["/attached", "attached/", "attached/../agent", "./attached", "attached//h1", "a\0b", "/files/attached", "../s2/attached", "x".repeat(5000), undefined, null, 5, {}, ["attached"]]) {
        const r = await server.list("s1", p);
        assert.equal(r.fail, "invalid", `${JSON.stringify(p)?.slice(0, 40)} was not refused invalid`);
    }
    assert.equal(chans.opened, 0);
});

test("files.list refuses a limit outside 1..500 or not a whole number, and a cursor it did not give", T, async () => {
    const { server } = setup();
    for (const limit of [0, -1, DIR_PAGE_MAX + 1, 1.5, "5", null, NaN]) assert.equal((await server.list("s1", "attached", { limit })).fail, "invalid", `limit ${limit}`);
    assert.ok((await server.list("s1", "attached", { limit: DIR_PAGE_MAX })).ok);
    for (const cursor of ["forged", 5, {}, ""]) assert.equal((await server.list("s1", "attached", { cursor })).fail, "invalid", `cursor ${JSON.stringify(cursor)}`);
});

test("files.list: a cursor is checked by its shape only, and one written by hand still lists only the named session's own entries", T, async () => {
    const { server } = setup();
    // The reader's form is `c:<ordinal>:<shown name>`; anything else is refused before a name is read.
    for (const cursor of ["c:", "c:h1", "c:x:h1", "c:1234567:h1", "h1"]) assert.equal((await server.list("s1", "attached", { cursor })).fail, "invalid", cursor);
    assert.deepEqual((await server.list("s1", "attached", { cursor: "c:0:" })).ok.entries.map((e) => e.name), ["h1", "h2"]);
    assert.deepEqual((await server.list("s1", "attached", { cursor: "c:0:h1" })).ok.entries.map((e) => e.name), ["h2"]);
    assert.deepEqual((await server.list("s1", "attached", { cursor: "c:999999:h0" })).ok.entries.map((e) => e.name), ["h1", "h2"]);
});

test("files.list: a cursor cannot change the session or the path of the command that carries it", T, async () => {
    const { server } = setup();
    // A cursor taken from s2's listing, or written to name another path or session, lists s1's `attached/` after it.
    const s2page = await server.list("s2", "attached", { limit: 1 });
    const fromS2 = s2page.ok.next ?? "c:0:h0";
    for (const cursor of [fromS2, "c:0:../s2/attached", "c:0:agent", "c:0:/files/attached/h9", "c:0:s2:attached/h9", "c:0:h0/../../s2", "c:../s2/attached", "c:s2:attached/h9"]) {
        const r = await server.list("s1", "attached", { cursor });
        if (r.fail) { assert.equal(r.fail, "invalid", cursor); continue; }
        for (const e of r.ok.entries) assert.ok(["h1", "h2"].includes(e.name), `${cursor} listed ${e.name}`);
    }
    // And in s1's agent/ (empty here), a cursor naming attached entries lists nothing of attached/.
    const r = await server.list("s1", "agent", { cursor: "c:0:" });
    assert.deepEqual(r.ok.entries, []);
});

test("files.list with no session is refused and opens no channel", T, async () => {
    const { server, chans } = setup();
    for (const s of [undefined, "", 5]) assert.equal((await server.list(s, "")).fail, "invalid");
    assert.equal(chans.opened, 0);
});

// --- files.list: paging and channel lifetime ---

test("files.list pages by next: the pages together are the whole directory, in order, and the last has no next", T, async () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`h${i}`, `f${i}.txt`));
    const { server } = setup({ sessions: { s1: rows } });
    const whole = (await server.list("s1", "attached")).ok.entries.map((e) => e.name);
    const seen = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
        const r = await server.list("s1", "attached", { limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...r.ok.entries.map((e) => e.name));
        cursor = r.ok.next;
        if (!cursor) break;
    }
    assert.deepEqual(seen, whole);
    assert.equal(whole.length, 7);
});

test("files.list opens one channel per request and disposes of it, refused or not", T, async () => {
    const { server, chans } = setup();
    await server.list("s1", "");
    await server.list("s1", "attached/h1/a.bin");
    await server.list("s1", "attached", { cursor: "forged" });
    assert.deepEqual(chans, { opened: 3, disposed: 3 });
});

test("files.list: a root whose attached count cannot be read is refused rather than answered without it", T, async () => {
    const source = fakeSource({ s1: [row("h1", "a.bin")] });
    const reader = new RangedReader({ source, hidden: () => false });
    const server = filesListServer({ open: () => reader.openChannel("files"), attachedCount: async () => { throw new Error("worker gone"); } });
    assert.equal((await server.list("s1", "")).fail, "invalid");
});
