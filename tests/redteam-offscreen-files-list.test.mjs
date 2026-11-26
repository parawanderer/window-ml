// redteam-offscreen-files-list.test.mjs — RED TEAM for the offscreen document's half of the file browser (#2183):
// the FILES_LIST listener's sender gate, and what a listing of a hidden directory must show.
//
// The property: only the service worker's word opens a directory. A content script (a tab's page), another
// extension, and a message with no sender are answered nothing and never reach the reader — no channel is opened and
// no FILES_ATTACHED/FILES_HIDE_LIST ask goes out, so the refusal is before any work, not after it. And a listing never
// turns a hidden path visible: a `hide` that matches a DIRECTORY holds what is under it, a failed hide-list ask hides
// everything, and no listing reads a byte of any file.
//
// src/offscreen.ts is imported for real under a mocked `chrome` and a fake `Worker` (the scaffolding of
// python-bench-stop-offscreen.test.mjs); the listing rows run the real filesListServer over the real RangedReader.
import { test } from "node:test";
import assert from "node:assert/strict";

// --- a fake chrome and Worker around the real offscreen document ---

const listeners = [];
const sentToWorker = [];   // chrome.runtime.sendMessage payloads (the offscreen document talking to the service worker)
class FakeWorker { constructor() { this.posts = []; } postMessage(m) { this.posts.push(m); } terminate() {} }
globalThis.Worker = FakeWorker;
// The idle reap arms a clock of minutes on every idle worker; a live timer would hold this process open.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (ms >= 60_000) t.unref(); return t; };
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => {
            sentToWorker.push(m);
            if (m?.type === "FILES_HIDE_LIST") return Promise.resolve({ entries: [] });   // nothing is hidden
            if (m?.type === "FILES_ATTACHED") return Promise.resolve({ files: [] });
            if (m?.type === "FILES_QUOTA") return Promise.resolve({ bytes: 12 * 1024 * 1024 });
            return Promise.resolve(undefined);
        },
    },
    storage: {
        session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: () => {} },
    },
};
await import("../src/offscreen.ts");
const { RangedReader } = await import("../src/session/ranged-reader.ts");
const { filesListServer } = await import("../src/session/files-list-serve.ts");
const { resolveHidden } = await import("../src/files-hide.ts");

const T = { timeout: 10000 };
const SW = { id: "test" };   // the service worker's sender: our id, no tab
/** Deliver a runtime message to the document's listeners; resolves with its answer, or undefined when none came. */
const send = (msg, sender = SW) => new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) { if (fn(msg, sender, resolve) === true) { handled = true; break; } }
    if (!handled) resolve(undefined);
});
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const asks = () => sentToWorker.filter((m) => ["FILES_ATTACHED", "FILES_HIDE_LIST", "FILES_QUOTA"].includes(m?.type));

// --- FILES_LIST: the service worker's word only ---

test("RED TEAM: a tab's content script and another extension get no answer to FILES_LIST, and the reader is never asked anything", T, async () => {
    const before = asks().length;
    for (const sender of [
        { id: "test", url: "https://news.example/article", tab: { id: 7, url: "https://news.example/article" }, frameId: 0 },
        { id: "evil", url: "chrome-extension://evil/offscreen.html" },
        { url: "chrome-extension://test/offscreen.html", tab: { id: 7, url: "https://news.example/" } },
        {},
    ]) {
        assert.equal(await send({ type: "FILES_LIST", session: "s1", path: "" }, sender), undefined);
        await tick();
    }
    assert.deepEqual(asks(), [], "a refused FILES_LIST opened no channel and asked the worker nothing");
    assert.equal(asks().length, before);
});

test("RED TEAM: the service worker's FILES_LIST is answered, and so is the offscreen document's own page — the gate's positive control", T, async () => {
    const before = asks().length;
    const r = await send({ type: "FILES_LIST", session: "s1", path: "" });
    assert.equal(r.ok.entries.map((e) => e.name).sort().join(","), "agent,attached");
    assert.ok(asks().length > before, "the answer came from the reader, which asked the worker for its counts");
    // Our own extension pages are the same trust domain as the worker (sidebar.html is web-accessible, so this is the
    // boundary worth stating: a FRAMED sidebar is our own code, not a page's, and nothing it sends is a page's message).
    assert.notEqual(await send({ type: "FILES_LIST", session: "s1", path: "" }, { id: "test", url: "chrome-extension://test/sidebar.html" }), undefined);
});

// --- a listing of a hidden directory ---

/**
 * The reader's `files` volume over a fake agent store holding `//spec`, where a value is a file's size and `null` is a
 * directory: `.ssh/id_rsa` (a credential directory, held by its built-in shape) and `notes/a.txt`, `notes/b.txt`.
 * `agent.blob` throws, so any listing that read a byte fails the test that made it.
 */
function setup(entries, { rule } = {}) {
    const spec = { ".ssh": null, ".ssh/id_rsa": 546, notes: null, "notes/a.txt": 12, "notes/b.txt": 34 };
    const kids = (rel) => Object.keys(spec).filter((k) => k !== rel && k.startsWith(rel === "" ? "" : `${rel}/`) && !k.slice(rel === "" ? 0 : rel.length + 1).includes("/")).map((path) => ({ path }));
    const agent = {
        children: async (s, rel) => kids(rel),
        node: async (s, rel) => {
            if (!(rel in spec)) return null;
            if (spec[rel] === null) return { kind: "dir", mtimeMs: 7000, path: rel };
            return { kind: "file", size: spec[rel], mtimeMs: 7000, birthtimeMs: 7000, version: "v1", blob: `k-${rel}`, path: rel };
        },
        blob: async () => { throw new Error("a listing must read no bytes"); },
        usage: async () => 0,
        commit: async () => ({}),
    };
    const reader = new RangedReader({
        source: { attached: async () => [], secretForms: async () => [], blob: async () => { throw new Error("no attachment is read"); } },
        agent,
        hidden: rule ?? ((s, p) => Promise.resolve().then(() => resolveHidden(p === "" ? "/files" : `/files/${p}`, entries).hidden)),
        now: () => 123,
    });
    const server = filesListServer({ open: () => reader.openChannel("files"), attachedCount: async () => 0 });
    const names = async (path) => (await server.list("s1", path)).ok.entries.map((e) => [e.name, e.hidden]).sort();
    return { server, names };
}

test("RED TEAM: a hide on a DIRECTORY holds what is under it — the directory's own listing marks every child hidden, so no name a person held is offered as visible", T, async () => {
    const { names } = setup([{ id: "h1", effect: "hide", source: "/files/agent/.ssh", layer: "session" }]);
    assert.deepEqual(await names("agent"), [[".ssh", true], ["notes", false]]);
    assert.deepEqual(await names("agent/.ssh"), [["id_rsa", true]], "the held directory's child is hidden too, never a visible name with its size beside it");
});

test("RED TEAM: a `show` releases exactly the path it names, inside a held directory and outside it; the listing still reads no byte of any file", T, async () => {
    const { names } = setup([
        { id: "h1", effect: "hide", source: "/files/agent/notes", layer: "session" },
        { id: "s1", effect: "show", source: "/files/agent/notes/a.txt", layer: "session" },
    ]);
    assert.deepEqual(await names("agent/notes"), [["a.txt", false], ["b.txt", true]]);
    assert.deepEqual(await names("agent"), [[".ssh", false], ["notes", true]], "the directory itself stays held: a show of one child does not release the row");
});

test("RED TEAM: a `show` cannot release a credential directory — the pattern is refused, so a hold on .ssh keeps holding everything under it", T, async () => {
    const { names } = setup([
        { id: "h1", effect: "hide", source: "/files/agent/.ssh", layer: "session" },
        { id: "s1", effect: "show", source: "/files/agent/.ssh/id_rsa", layer: "session" },
        { id: "s2", effect: "show", source: "/files/agent/.ssh/*", layer: "session" },
    ]);
    assert.deepEqual(await names("agent/.ssh"), [["id_rsa", true]], "both shows name .ssh, and both are refused");
});

test("RED TEAM: a hide-list ask that cannot be answered hides everything — an unreadable rule never lists a file as visible", T, async () => {
    // The reader's own fail-closed path: a hide rule that throws is "hidden", which is what makeHideRule hands it when
    // the worker cannot answer (files-hide-rule.ts).
    const withRule = setup([], { rule: () => { throw new Error("the worker went away"); } });
    assert.deepEqual(await withRule.names("agent"), [[".ssh", true], ["notes", true]]);
    assert.deepEqual(await withRule.names("agent/.ssh"), [["id_rsa", true]]);
    // Positive control: with no rule at all, the same tree lists its names as visible.
    const noRule = setup([]);
    assert.deepEqual(await noRule.names("agent"), [[".ssh", false], ["notes", false]]);
});
