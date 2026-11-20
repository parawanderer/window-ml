// files-attached.test.mjs — FILES_ATTACHED (the offscreen document asks the worker which files a session holds) and the
// offscreen document's FilesSource over it (src/python/files-source.ts), for Python's `/files` mount.

// The worker half runs the built worker in node:vm with a real run holding an attached text file (ml-wire-harness.mjs);
// the source half takes a fake store and a fake `send`. Spec: docs/spec/FILE_ATTACHMENTS.md, slice 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRun, OFFSCREEN, SITE, plain } from "./ml-wire-harness.mjs";
import { createFilesSource } from "../src/python/files-source.ts";
import { HANDLE_MAP } from "../src/page-relay.ts";

const TEXT = "alpha\nbeta\ngamma\n";
const ask = (bg, session, sender = OFFSCREEN) => bg.send({ type: "FILES_ATTACHED", session }, { ...sender }).then(plain);
const PAGE = { tab: { id: SITE.id, url: SITE.url }, url: SITE.url, origin: "https://site.example" };

// --- the worker's answer ---

test("FILES_ATTACHED answers the session's shelf in the wire shape to the offscreen document, and nothing to anyone else", { timeout: 30000 }, async () => {
    let seen;
    const { bg } = await wireRun(async (wire) => { seen = wire; }, { files: [{ name: "server.log", type: "text/plain", text: TEXT }], calls: [{ name: "python_exec", args: { code: "print(1)" } }], store: true });
    const session = seen.run;
    const ok = await ask(bg, session);
    assert.equal(ok.files.length, 1);
    const [f] = ok.files;
    assert.deepEqual(Object.keys(f).sort(), ["bytes", "handle", "key", "name", "sha256"]);
    assert.equal(f.name, "server.log");
    assert.equal(f.bytes, TEXT.length);
    assert.ok(f.handle && f.key && f.sha256);
    // The handle is the pointer's id, not the value-store key.
    assert.notEqual(f.handle, f.key);
    assert.deepEqual(await ask(bg, session, PAGE), { files: [] }, "a page's tab sender");
    assert.deepEqual(await ask(bg, session, { url: "chrome-extension://test/popup.html" }), { files: [] }, "another extension page");
    assert.deepEqual(await ask(bg, session, { url: "chrome-extension://test/offscreen.html", tab: { id: 1 } }), { files: [] }, "the offscreen URL on a tab");
    assert.deepEqual(await ask(bg, session, {}), { files: [] }, "no sender facts");
});

test("FILES_ATTACHED: a missing, empty, non-string or unknown session answers none, and no other session's files", { timeout: 30000 }, async () => {
    let seen;
    const { bg } = await wireRun(async (wire) => { seen = wire; }, { files: [{ name: "server.log", type: "text/plain", text: TEXT }], calls: [{ name: "python_exec", args: { code: "print(1)" } }], store: true });
    for (const session of [undefined, "", 7, null, {}, ["x"], "no-such-run", seen.run + "x"]) {
        assert.deepEqual(await ask(bg, session), { files: [] }, JSON.stringify(session));
    }
    assert.deepEqual(await bg.send({ type: "FILES_ATTACHED" }, { ...OFFSCREEN }).then(plain), { files: [] });
});

test("FILES_ATTACHED is not a page's message: the relay has no entry for it", () => {
    assert.equal("FILES_ATTACHED" in HANDLE_MAP, false);
    assert.ok(!Object.values(HANDLE_MAP).some((e) => e.type === "FILES_ATTACHED" || e.responseType === "FILES_ATTACHED"));
});

// --- the offscreen document's source ---

const row = (key, over = {}) => ({ key, sessions: ["s1"], bytes: 3, format: "file", held: true, createdAt: 1234, lastReadAt: 1234, ...over });
const fakeStore = (rows) => ({
    async get(key) {
        const r = rows.find((x) => x.key === key);
        if (!r) throw new Error("missing");
        return { row: r, blob: new Blob([key]) };
    },
    async rows() { return rows; },
});

test("blob: the Blob of a held row of the session; a key another session holds, an unheld row and a missing key throw", async () => {
    const src = createFilesSource({ store: () => fakeStore([row("k1"), row("k2", { sessions: ["s2"] }), row("k3", { held: undefined }), row("k4", { sessions: ["s1", "s2"] })]), send: async () => ({}) });
    assert.equal(await (await src.blob("k1", "s1")).text(), "k1");
    assert.equal(await (await src.blob("k4", "s2")).text(), "k4", "a shared row serves each holder");
    await assert.rejects(() => src.blob("k2", "s1"), /not a file of this session/);
    await assert.rejects(() => src.blob("k3", "s1"), /not a file of this session/);
    await assert.rejects(() => src.blob("nope", "s1"));
    await assert.rejects(() => src.blob("k1", ""), /not a file of this session/);
});

test("attached: maps the worker's answer, takes attachedMs from the row's createdAt (0 when absent), asks with the session", async () => {
    const sent = [];
    const files = [
        { handle: "h1", name: "a.txt", key: "k1", bytes: 5, sha256: "aa" },
        { handle: "h2", name: "b.txt", key: "gone", bytes: 6, sha256: "bb" },
    ];
    const src = createFilesSource({ store: () => fakeStore([row("k1", { createdAt: 777 })]), send: async (m) => { sent.push(m); return { files }; } });
    assert.deepEqual(await src.attached("s1"), [
        { handle: "h1", name: "a.txt", key: "k1", bytes: 5, sha256: "aa", attachedMs: 777 },
        { handle: "h2", name: "b.txt", key: "gone", bytes: 6, sha256: "bb", attachedMs: 0 },
    ]);
    assert.deepEqual(sent, [{ type: "FILES_ATTACHED", session: "s1" }]);
});

test("attached: a failed message, no answer or a malformed answer lists nothing; a malformed entry is skipped; a store that fails still lists", async () => {
    const mk = (send, store = () => fakeStore([])) => createFilesSource({ store, send });
    assert.deepEqual(await mk(async () => { throw new Error("no worker"); }).attached("s1"), []);
    assert.deepEqual(await mk(async () => undefined).attached("s1"), []);
    assert.deepEqual(await mk(async () => ({ files: "x" })).attached("s1"), []);
    const good = { handle: "h", name: "n", key: "k", bytes: 1, sha256: "s" };
    assert.deepEqual((await mk(async () => ({ files: [null, { handle: 1 }, good] })).attached("s1")).map((f) => f.handle), ["h"]);
    const broken = { get: async () => { throw new Error("x"); }, rows: async () => { throw new Error("idb"); } };
    assert.deepEqual((await mk(async () => ({ files: [good] }), () => broken).attached("s1")).map((f) => f.attachedMs), [0]);
});

test("attached: the store's rows are scanned once per new key, not at every listing (the reader lists at every path)", async () => {
    const rows = [row("k1", { createdAt: 10 })];
    let scans = 0;
    const store = { ...fakeStore(rows), async rows() { scans++; return rows; } };
    let answer = { files: [{ handle: "h1", name: "a.txt", key: "k1", bytes: 3, sha256: "x" }] };
    const src = createFilesSource({ store: () => store, send: async () => answer });
    for (let i = 0; i < 5; i++) assert.equal((await src.attached("s1"))[0].attachedMs, 10);
    assert.equal(scans, 1);
    rows.push(row("k2", { createdAt: 20 }));   // attached since the first scan
    answer = { files: [...answer.files, { handle: "h2", name: "b.txt", key: "k2", bytes: 3, sha256: "y" }] };
    assert.deepEqual((await src.attached("s1")).map((f) => f.attachedMs), [10, 20]);
    assert.equal(scans, 2, "a new key scans again");
});
