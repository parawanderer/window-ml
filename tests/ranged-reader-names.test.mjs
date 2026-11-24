// RANGED READER, NAMES (src/session/ranged-reader.ts, maskName in src/secret-mask.ts): a file's name under `/files` is
// shown masked, and every call resolves the shown name back to the file. Rules 1-8 of docs/spec/FILE_ATTACHMENTS.md,
// "Names under `/files`". The store is a real AgentFiles on fake-indexeddb; the forms are a mutable array per test.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { AgentFiles } from "../src/session/agent-files.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const T = { timeout: 5000 };
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

const S1 = "sekret-one", S2 = "sekret-two", SECRET = "hunter2-db";
const K = "[REDACTED:K]";
const f = (find, put = K, ci) => ({ find, put, ...(ci ? { ci } : {}) });

const row = (handle, name, key, bytes) => ({ handle, name, key, bytes: bytes.length, sha256: `sha-${handle}`, attachedMs: 5000 });

/** A reader over a real store; `forms` is the array `secretForms` returns, pushed to by a test. */
function setup(over = {}) {
    const agent = new AgentFiles({ idb: new IDBFactory(), dbName: "t" });
    const forms = [];
    const stats = { formsCalls: 0 };
    const data = over.data ?? {};
    const source = {
        forms, formsFail: false,
        attached: async () => over.attached ?? [],
        blob: async (key) => new Blob([data[key] ?? new Uint8Array()]),
        secretForms: async () => {
            stats.formsCalls++;
            if (source.formsFail) throw new Error("registry at https://secret.example key SK-LEAK unreadable");
            return source.forms;
        },
    };
    const reader = new RangedReader({ source, now: () => 123, onLost: () => {}, agent });
    const ch = reader.openChannel("files");
    ch.setSession("s1");
    return { agent, reader, ch, source, forms, stats };
}

async function put(ch, path, text, flags = "w") {
    const t = await ch.begin();
    const { wfd } = await ch.openWrite(path, flags, t);
    await ch.write(wfd, 0, enc(text));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
}
async function slurp(ch, path) {
    const { fd, size } = await ch.open(path);
    const dest = new Uint8Array(size + 8);
    const n = size ? await ch.read(fd, 0, size, dest) : 0;
    await ch.close(fd);
    return dec(dest.subarray(0, n));
}
async function refused(p, code) {
    let err;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, `expected ${code}, the call resolved`);
    assert.equal(err.code, code, `got ${err.code}: ${err.message}`);
    return err;
}
const names = async (ch, dir) => (await ch.opendir(dir, { limit: 100 })).entries.map((e) => e.name);

// --- listing (rule 1) ---

test("an agent file whose name holds a secret is listed by its shown name, with its stat", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "hello");
    forms.push(f(SECRET, "[REDACTED:DB_PASS]"));
    const page = await ch.opendir("agent", { limit: 10 });
    assert.deepEqual(page.entries.map((e) => e.name), ["[REDACTED:DB_PASS].txt"]);
    assert.equal(page.entries[0].kind, "file");
    assert.equal(page.entries[0].size, 5);
});

test("an attached file whose name holds a secret is listed by its shown name", T, async () => {
    const bytes = enc("abc");
    const { ch, forms } = setup({ attached: [row("h1", `${SECRET}.pdf`, "k1", bytes)], data: { k1: bytes } });
    forms.push(f(SECRET, "[REDACTED:DB_PASS]"));
    const page = await ch.opendir("attached/h1", { limit: 10 });
    assert.deepEqual(page.entries.map((e) => e.name), ["[REDACTED:DB_PASS].pdf"]);
    assert.equal(page.entries[0].size, 3);
});

test("a listing never holds the raw secret anywhere", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "x");
    const t = await ch.begin();
    await ch.mkdir(`agent/${SECRET}-dir`, t);
    await ch.commitTx(t);
    await put(ch, `agent/${SECRET}-dir/${SECRET}`, "y");
    forms.push({ find: SECRET });
    for (const dir of ["agent", "agent/[REDACTED]-dir"]) {
        const page = await ch.opendir(dir, { limit: 1 });
        assert.ok(!JSON.stringify(page).includes(SECRET), JSON.stringify(page));
    }
});

test("a value registered mid-session is masked from the next listing on", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "x");
    assert.deepEqual(await names(ch, "agent"), [`${SECRET}.txt`]);
    forms.push(f(SECRET, "[REDACTED:LATE]"));
    assert.deepEqual(await names(ch, "agent"), ["[REDACTED:LATE].txt"]);
});

// --- sort (rule 2) ---

test("a folder sorts by its shown names, not the stored ones", T, async () => {
    const { ch, forms } = setup();
    const raw = `m-${SECRET}x`;
    assert.ok("a" < raw && raw < "z");
    for (const n of ["a", "z", raw]) await put(ch, `agent/${n}`, "1");
    assert.deepEqual(await names(ch, "agent"), ["a", "m-" + `${SECRET}x`, "z"]);
    forms.push(f(`m-${SECRET}`, "[REDACTED:K]"));
    assert.deepEqual(await names(ch, "agent"), ["[REDACTED:K]x", "a", "z"]);
});

// --- resolution (rule 3) ---

test("open and stat by the shown name reach the file, and the raw name works too", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, `body ${SECRET} end`);
    forms.push({ find: SECRET });
    assert.equal((await ch.stat("agent/[REDACTED].txt")).kind, "file");
    assert.equal(await slurp(ch, "agent/[REDACTED].txt"), `body ${"*".repeat(SECRET.length)} end`);
    assert.equal(await slurp(ch, `agent/${SECRET}.txt`), `body ${"*".repeat(SECRET.length)} end`);
});

test("a folder under a secret name resolves by its shown name for the path below it", T, async () => {
    const { ch, forms } = setup();
    const t = await ch.begin();
    await ch.mkdir(`agent/${SECRET}`, t);
    await ch.commitTx(t);
    await put(ch, `agent/${SECRET}/in.txt`, "deep");
    forms.push({ find: SECRET });
    assert.equal(await slurp(ch, "agent/[REDACTED]/in.txt"), "deep");
});

test("the exact match wins: a file literally named as a shown name opens, not the one that shows as it", T, async () => {
    const { ch, agent, forms } = setup();
    // Seeded in the store: a create under this literal name is refused (rule 8), so this is a file from before.
    await agent.commit("s1", [{ op: "put", path: K, data: new Blob(["literal"]) }, { op: "put", path: S1, data: new Blob(["masked-one"]) }]);
    forms.push(f(S1));
    assert.deepEqual(await names(ch, "agent"), [K, K]);
    assert.equal(await slurp(ch, `agent/${K}`), "literal");
});

// --- collision (rule 4) ---

test("two files sharing a shown name are both listed, and a lookup by it is EACCES ambiguous", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${S1}y`, "1");
    await put(ch, `agent/${S2}y`, "2");
    forms.push(f(S1), f(S2));
    assert.deepEqual(await names(ch, "agent"), [`${K}y`, `${K}y`]);
    for (const p of [ch.stat(`agent/${K}y`), ch.open(`agent/${K}y`)]) {
        const err = await refused(p, "EACCES");
        assert.ok(err.message.includes("ambiguous, 2 files"), err.message);
        assert.ok(!err.message.includes(S1) && !err.message.includes(S2), err.message);
    }
});

// --- errors name the path as written (rule 5) ---

test("an error names the path as written, never the stored name", T, async () => {
    const { ch, forms } = setup();
    const t = await ch.begin();
    await ch.mkdir(`agent/${SECRET}`, t);
    await ch.commitTx(t);
    await put(ch, `agent/${SECRET}/present`, "1");
    forms.push(f(SECRET));
    const written = `agent/${K}/missing`;
        const err = await refused(ch.stat(written), "ENOENT");
    assert.equal(err.path, written);
    assert.ok(err.message.includes(written), err.message);
    assert.ok(!JSON.stringify({ p: err.path, m: err.message }).includes(SECRET), err.message);
});

// --- one lookup for writes (rule 6) ---

test("openWrite w on the shown name overwrites the existing file", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "old");
    forms.push({ find: SECRET });
    await put(ch, "agent/[REDACTED].txt", "newer!");
    const page = await ch.opendir("agent", { limit: 10 });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].size, 6);
    assert.equal(await slurp(ch, `agent/${SECRET}.txt`), "newer!");
});

test("openWrite x on the shown name is EEXIST", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "old");
    forms.push({ find: SECRET });
    const t = await ch.begin();
    await refused(ch.openWrite("agent/[REDACTED].txt", "x", t), "EEXIST");
});

test("unlink by the shown name removes the raw file", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "old");
    forms.push({ find: SECRET });
    const t = await ch.begin();
    await ch.unlink("agent/[REDACTED].txt", t);
    await ch.commitTx(t);
    assert.deepEqual(await names(ch, "agent"), []);
    await refused(ch.stat(`agent/${SECRET}.txt`), "ENOENT");
});

test("rename from the shown name to a plain name moves the raw file", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${SECRET}.txt`, "moved");
    forms.push({ find: SECRET });
    const t = await ch.begin();
    await ch.rename("agent/[REDACTED].txt", "agent/plain", t);
    await ch.commitTx(t);
    assert.deepEqual(await names(ch, "agent"), ["plain"]);
    assert.equal(await slurp(ch, "agent/plain"), "moved");
});

// --- cursor (rule 7) ---

test("a folder of three colliding names pages to its end with limit 1, a cursor never holding a secret", T, async () => {
    const { ch, forms } = setup();
    for (const n of [`${S1}a`, `${S1}b`, `${S1}c`]) await put(ch, `agent/${n}`, "1");
    forms.push(f(S1));
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 10; guard++) {
        const page = await ch.opendir("agent", { limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...page.entries.map((e) => e.name));
        if (!page.next) { cursor = undefined; break; }
        assert.ok(page.next.startsWith("c:"), page.next);
        assert.ok(!page.next.includes(S1), page.next);
        cursor = page.next;
    }
    assert.equal(cursor, undefined, "paging stopped");
    assert.deepEqual(seen, [`${K}a`, `${K}b`, `${K}c`].sort());
});

test("three entries sharing exactly one shown name are all visited, none repeated", T, async () => {
    const { ch, forms } = setup();
    for (const n of [`${S1}`, `${S2}`, `${SECRET}`]) await put(ch, `agent/${n}`, n);
    forms.push(f(S1), f(S2), f(SECRET));
    const sizes = [];
    let cursor;
    let pages = 0;
    do {
        const page = await ch.opendir("agent", { limit: 1, ...(cursor ? { cursor } : {}) });
        sizes.push(...page.entries.map((e) => e.size));
        cursor = page.next;
        pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(sizes.sort((a, b) => a - b), [S1.length, SECRET.length, S2.length].sort((a, b) => a - b));
});

test("a cursor of another shape is EINVAL", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/a", "1");
    await refused(ch.opendir("agent", { limit: 1, cursor: "c:abc" }), "EINVAL");
    await refused(ch.opendir("agent", { limit: 1, cursor: "a" }), "EINVAL");
});

// --- reserved (rule 8) ---

test("a create, a mkdir or a rename to a new name holding [REDACTED: is EACCES reserved", T, async () => {
    const { ch } = setup();
    await put(ch, "agent/src", "1");
    let t = await ch.begin();
    const e1 = await refused(ch.openWrite("agent/new[REDACTED:X]", "w", t), "EACCES");
    assert.ok(e1.message.includes("reserved"), e1.message);
    const e2 = await refused(ch.mkdir("agent/new[REDACTED:X]", t), "EACCES");
    assert.ok(e2.message.includes("reserved"), e2.message);
    const e3 = await refused(ch.rename("agent/src", "agent/new[REDACTED:X]", t), "EACCES");
    assert.ok(e3.message.includes("reserved"), e3.message);
});

for (const [label, last, form] of [
    ["[REDACTED:X]", "x[REDACTED:X]y", undefined],
    ["the bare [REDACTED]", "x[REDACTED]y", undefined],
    ["[a GitHub token]", "x[a GitHub token]y", undefined],
    ["a form's put, [server]", "x[server]y", { find: "srv-secret", put: "[server]" }],
]) {
    test(`a create under agent/ whose name holds ${label} is EACCES reserved`, T, async () => {
        const { ch, forms } = setup();
        if (form) forms.push(form);
        const t = await ch.begin();
        const err = await refused(ch.openWrite(`agent/${last}`, "w", t), "EACCES");
        assert.ok(err.message.includes("reserved"), err.message);
    });
}

test("a file that already exists under that literal name opens for write", T, async () => {
    const { ch, agent } = setup();
    await agent.commit("s1", [{ op: "put", path: "old[REDACTED:X]", data: new Blob(["1"]) }]);
    await put(ch, "agent/old[REDACTED:X]", "second");
    assert.equal(await slurp(ch, "agent/old[REDACTED:X]"), "second");
});

// --- forms that fail ---

test("secretForms rejecting makes opendir EIO, with nothing of the source's error", T, async () => {
    const { ch, source } = setup();
    await put(ch, "agent/a", "1");
    source.formsFail = true;
    const err = await refused(ch.opendir("agent", { limit: 10 }), "EIO");
    assert.ok(!err.message.includes("secret.example") && !err.message.includes("SK-LEAK"), err.message);
});

// --- the exact-match fast path ---

test("stat of a plain raw path that exists does not ask for the forms", T, async () => {
    const { ch, stats } = setup();
    await put(ch, "agent/plain", "1");
    const before = stats.formsCalls;
    await ch.stat("agent/plain");
    assert.equal(stats.formsCalls, before);
});
