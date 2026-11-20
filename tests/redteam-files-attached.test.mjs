// redteam-files-attached.test.mjs — the shelf FILES_ATTACHED answers is the offscreen document's alone, one session's, and no path
// shape reaches a key it did not list (#2058): a look-alike offscreen URL, any page or content script, a second run's shelf, and a
// `..` path are each refused, and the reader's blob source is never asked for them. The worker half is the built worker in
// node:vm (tests/ml-wire-harness.mjs); the reader half builds src/session/ranged-reader.ts over a fake source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRun, OFFSCREEN, SITE, plain } from "./ml-wire-harness.mjs";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { createFilesSource } from "../src/python/files-source.ts";
import { filesAttached } from "../src/sw/sw-python.ts";

const TEXT = "alpha\nbeta\n";
const TEXT2 = "one\ntwo\n";
const ask = (bg, session, sender = OFFSCREEN) => bg.send({ type: "FILES_ATTACHED", session }, { ...sender }).then(plain);
const ONE = [{ name: "server.log", type: "text/plain", text: TEXT }];
const runWithFiles = async (files, shared = {}) => {
    let seen;
    const out = await wireRun(async (wire) => { seen = wire; }, { files, calls: [{ name: "python_exec", args: { code: "print(1)" } }], store: true, ...shared });
    return { ...out, session: seen.run };
};

// --- the sender: the offscreen document's exact URL, nothing that looks like it ---

test("RED TEAM (files): only the offscreen document's exact URL is answered; every look-alike and every page gets nothing", { timeout: 30000 }, async () => {
    const { bg, session } = await runWithFiles(ONE);
    const ok = await ask(bg, session);
    assert.equal(ok.files.length, 1, "positive control: the offscreen document is answered");
    const LOOKALIKES = [
        ["a query after the path", { id: "test", url: "chrome-extension://test/offscreen.html?x=1" }],
        ["a fragment", { id: "test", url: "chrome-extension://test/offscreen.html#y" }],
        ["a child path", { id: "test", url: "chrome-extension://test/offscreen.html/evil" }],
        ["a sibling path", { id: "test", url: "chrome-extension://test/offscreen.htm" }],
        ["another extension's offscreen", { id: "other", url: "chrome-extension://other/offscreen.html" }],
        ["a trailing space", { id: "test", url: "chrome-extension://test/offscreen.html " }],
        ["a page's tab", { tab: { id: SITE.id, url: SITE.url }, url: SITE.url, origin: "https://site.example" }],
        ["a content script on a page", { id: "test", tab: { id: SITE.id, url: SITE.url }, url: SITE.url, origin: "https://site.example" }],
        ["an extension page that is not offscreen", { id: "test", url: "chrome-extension://test/sidebar.html", origin: "chrome-extension://test" }],
        ["no facts at all", {}],
    ];
    for (const [what, sender] of LOOKALIKES) assert.deepEqual(await ask(bg, session, sender), { files: [] }, what);
});

test("RED TEAM (files): a page's sender is refused whether its origin is approved or not — the gate never reads consent", () => {
    globalThis.chrome = { runtime: { getURL: (p) => "chrome-extension://test/" + p } };
    try {
        for (const sender of [
            { tab: { id: SITE.id, url: SITE.url }, url: SITE.url, origin: "https://site.example" },              // not approved, or approved: same answer
            { id: "test", tab: { id: SITE.id, url: SITE.url }, url: SITE.url, origin: "https://site.example" },  // a content script
        ]) {
            assert.deepEqual(filesAttached({ session: "any" }, sender), { files: [] }, JSON.stringify(sender));
        }
    } finally { delete globalThis.chrome; }
});

// --- one run's shelf, never another's ---

test("RED TEAM (files): two runs on one store answer their own shelves only, and neither answers the other's session", { timeout: 180000 }, async () => {
    const { IDBFactory } = (await import("node:module")).createRequire(import.meta.url)("fake-indexeddb");
    const idb = new IDBFactory();
    const a = await runWithFiles(ONE, { idb });
    const b = await runWithFiles([{ name: "other.log", type: "text/plain", text: TEXT2 }], { idb });
    const fa = (await ask(a.bg, a.session)).files;
    const fb = (await ask(b.bg, b.session)).files;
    assert.deepEqual(fa.map((f) => f.name), ["server.log"]);
    assert.deepEqual(fb.map((f) => f.name), ["other.log"]);
    assert.deepEqual(await ask(a.bg, b.session), { files: [] }, "run a's worker answered run b's session");
    assert.deepEqual(await ask(b.bg, a.session), { files: [] }, "run b's worker answered run a's session");
    // positive control: each handle is the other's not (distinct shelves, distinct values).
    assert.notEqual(fa[0].handle, fb[0].handle);
});

// --- the reader: no path shape resolves to a key it was not listed ---

/** A reader over a source listing one file, recording every blob it is asked for. */
function readerOverOneFile() {
    const asked = [];
    const source = {
        attached: async () => [{ handle: "h1", name: "server.log", key: "k1", bytes: TEXT.length, sha256: "s", attachedMs: 1 }],
        blob: async (key) => { asked.push(key); return new Blob([TEXT]); },
        secretForms: async () => [],
    };
    const reader = new RangedReader({ source });
    const ch = reader.openChannel("files");
    ch.setSession("run-1");
    return { ch, asked };
}

test("RED TEAM (files): a path that climbs out or is not canonical is ENOENT, and the blob source is never asked", async () => {
    const { ch, asked } = readerOverOneFile();
    for (const p of ["attached/../agent/x", "../attached/h1/server.log", "/attached/h1/server.log", "attached//h1/server.log", "attached/h1/../../x", "attached/h1/./../x"]) {
        await assert.rejects(ch.stat(p), (e) => e?.code === "ENOENT", `${p} was not ENOENT: ${JSON.stringify(await ch.stat(p).catch((e) => e))}`);
    }
    assert.deepEqual(asked, [], "the blob source was asked for a path it did not list");
    // positive control: the listed path opens and reads.
    const r = await ch.open("attached/h1/server.log");
    assert.equal(r.size, TEXT.length);
});

test("RED TEAM (files): a blob key another session holds or one not held is refused, and a guessed key never reads another's bytes", async () => {
    const storeRows = {
        k1: { held: true, sessions: ["run-1"] },
        k2: { held: true, sessions: ["run-2"] },
        k3: { held: false, sessions: ["run-1"] },
    };
    const store = {
        get: async (key) => {
            const row = storeRows[key];
            if (!row) throw new Error("no such row");
            return { row, blob: new Blob(["bytes of " + key]) };
        },
        rows: async () => [],
    };
    const source = createFilesSource({ store: () => store, send: async (m) => (m.type === "FILES_SECRET_FORMS" ? { forms: [] } : { files: [] }) });
    for (const [key, session, what] of [["k2", "run-1", "another session's key"], ["k3", "run-1", "an unheld row"], ["k1", "run-2", "this row under another session"]]) {
        await assert.rejects(source.blob(key, session), /not a file of this session/, what);
    }
    await assert.rejects(source.blob("guess", "run-1"), undefined, "a guessed key must throw");   // the store's own miss
    assert.equal(await (await source.blob("k1", "run-1")).text(), "bytes of k1");
});
