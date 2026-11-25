// AGENT FILES (src/session/agent-files.ts): the store of a session's run-made files under `/files/agent/`, on
// fake-indexeddb with a fresh factory per test. Covers commit's ordering and atomicity, every error code, renames,
// forgetSession, the lost notes and the session list.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AgentFiles, AgentFilesError, LOST_KEPT } from "../src/session/agent-files.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const T = { timeout: 10000 };

/** A store on its own factory, with a clock the test moves. */
function setup() {
    const clock = { t: 1000 };
    const store = new AgentFiles({ idb: new IDBFactory(), dbName: "t", now: () => clock.t });
    return { store, clock };
}
const blob = (s) => new Blob([s]);
const put = (path, s) => ({ op: "put", path, data: blob(s) });

/** Assert a commit rejects with an AgentFilesError of `code` naming `path`. */
async function refused(p, code, path) {
    let err;
    try { await p; } catch (e) { err = e; }
    assert.ok(err instanceof AgentFilesError, `expected ${code}, got ${err}`);
    assert.equal(err.code, code);
    if (path !== undefined) assert.equal(err.path, path);
}

// --- put, node, children, usage ---

test("put then node, children, usage and blob", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "d" }, put("d/a.txt", "hello"), put("b.txt", "xy")]);
    const n = await store.node("s", "d/a.txt");
    assert.equal(n.kind, "file");
    assert.equal(n.size, 5);
    assert.equal(n.parent, "d");
    assert.ok(n.version && n.blob);
    assert.equal(await (await store.blob(n.blob)).text(), "hello");
    assert.deepEqual((await store.children("s", "")).map((x) => x.path).sort(), ["b.txt", "d"]);
    assert.deepEqual((await store.children("s", "d")).map((x) => x.path), ["d/a.txt"]);
    assert.equal(await store.usage("s"), 7);
    assert.equal(await store.node("s", "nope"), null);
    assert.equal(await store.usage("other"), 0);
});

test("an empty commit does nothing", T, async () => {
    const { store } = setup();
    await store.commit("s", []);
    assert.deepEqual(await store.all("s"), []);
});

// --- last commit wins ---

test("the last commit of a path wins, with a fresh version and the birth time kept", T, async () => {
    const { store, clock } = setup();
    await store.commit("s", [put("f", "one")]);
    const a = await store.node("s", "f");
    clock.t = 2000;
    await store.commit("s", [put("f", "second")]);
    const b = await store.node("s", "f");
    assert.notEqual(a.version, b.version);
    assert.notEqual(a.blob, b.blob);
    assert.equal(b.birthtimeMs, 1000);
    assert.equal(b.mtimeMs, 2000);
    assert.equal(b.size, 6);
    assert.equal(await (await store.blob(b.blob)).text(), "second");
    await assert.rejects(store.blob(a.blob), /gone/);
    assert.equal(await store.usage("s"), 6);
});

// --- atomicity ---

test("a failing op later in a commit leaves nothing of the earlier ones", T, async () => {
    const { store } = setup();
    await store.commit("s", [put("keep", "kept")]);
    const before = await store.node("s", "keep");
    await refused(store.commit("s", [put("keep", "overwritten"), { op: "mkdir", path: "newdir" }, put("new.txt", "n"), { op: "unlink", path: "missing" }]), "ENOENT", "missing");
    assert.deepEqual((await store.all("s")).map((n) => n.path), ["keep"]);
    const after = await store.node("s", "keep");
    assert.equal(after.version, before.version);
    assert.equal(await (await store.blob(after.blob)).text(), "kept");
});

// --- error codes ---

test("ENOENT for a missing parent (put, mkdir, rename target)", T, async () => {
    const { store } = setup();
    await refused(store.commit("s", [put("no/f", "x")]), "ENOENT", "no");
    await refused(store.commit("s", [{ op: "mkdir", path: "no/d" }]), "ENOENT", "no");
    await store.commit("s", [put("f", "x")]);
    await refused(store.commit("s", [{ op: "rename", from: "f", to: "no/g" }]), "ENOENT", "no");
    await refused(store.commit("s", [{ op: "rename", from: "absent", to: "g" }]), "ENOENT", "absent");
    await refused(store.commit("s", [{ op: "rmdir", path: "absent" }]), "ENOENT", "absent");
});

test("ENOTDIR for a parent that is a file", T, async () => {
    const { store } = setup();
    await store.commit("s", [put("f", "x")]);
    await refused(store.commit("s", [put("f/g", "y")]), "ENOTDIR", "f");
    await refused(store.commit("s", [{ op: "mkdir", path: "f/d" }]), "ENOTDIR", "f");
    await refused(store.commit("s", [{ op: "rmdir", path: "f" }]), "ENOTDIR", "f");
});

test("EISDIR for a put over a folder and an unlink of a folder", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "d" }]);
    await refused(store.commit("s", [put("d", "x")]), "EISDIR", "d");
    await refused(store.commit("s", [{ op: "unlink", path: "d" }]), "EISDIR", "d");
});

test("EEXIST for mkdir over a folder or a file", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "d" }, put("f", "x")]);
    await refused(store.commit("s", [{ op: "mkdir", path: "d" }]), "EEXIST", "d");
    await refused(store.commit("s", [{ op: "mkdir", path: "f" }]), "EEXIST", "f");
});

test("ENOTEMPTY for rmdir of a folder with something in it, and not once it is empty", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "d" }, put("d/f", "x")]);
    await refused(store.commit("s", [{ op: "rmdir", path: "d" }]), "ENOTEMPTY", "d");
    await store.commit("s", [{ op: "unlink", path: "d/f" }, { op: "rmdir", path: "d" }]);
    assert.equal(await store.node("s", "d"), null);
});

test("EINVAL for renaming a folder into itself", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "d" }, { op: "mkdir", path: "d/e" }]);
    await refused(store.commit("s", [{ op: "rename", from: "d", to: "d/e/x" }]), "EINVAL", "d/e/x");
    assert.equal((await store.all("s")).length, 2);
});

test("renaming over a folder or onto a file by kind: EISDIR, ENOTDIR, ENOTEMPTY", T, async () => {
    const { store } = setup();
    await store.commit("s", [put("f", "x"), { op: "mkdir", path: "d" }, { op: "mkdir", path: "full" }, put("full/k", "k")]);
    await refused(store.commit("s", [{ op: "rename", from: "f", to: "d" }]), "EISDIR", "d");
    await refused(store.commit("s", [{ op: "rename", from: "d", to: "f" }]), "ENOTDIR", "f");
    await refused(store.commit("s", [{ op: "rename", from: "d", to: "full" }]), "ENOTEMPTY", "full");
});

test("a rename onto itself is a no-op", T, async () => {
    const { store } = setup();
    await store.commit("s", [put("f", "x")]);
    const before = await store.node("s", "f");
    await store.commit("s", [{ op: "rename", from: "f", to: "f" }]);
    assert.deepEqual(await store.node("s", "f"), before);
});

// --- rename ---

test("renaming a folder moves its descendants", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "a" }, { op: "mkdir", path: "a/b" }, put("a/b/f", "deep"), put("a/g", "g"), put("ab", "sibling with a shared prefix")]);
    await store.commit("s", [{ op: "rename", from: "a", to: "z" }]);
    assert.deepEqual((await store.all("s")).map((n) => n.path).sort(), ["ab", "z", "z/b", "z/b/f", "z/g"]);
    const f = await store.node("s", "z/b/f");
    assert.equal(f.parent, "z/b");
    assert.equal(await (await store.blob(f.blob)).text(), "deep");
    assert.deepEqual((await store.children("s", "z")).map((n) => n.path).sort(), ["z/b", "z/g"]);
    assert.deepEqual(await store.children("s", "a"), []);
});

test("rename over a file replaces it and its old blob is gone", T, async () => {
    const { store } = setup();
    await store.commit("s", [put("src", "new bytes"), put("dst", "old")]);
    const oldBlob = (await store.node("s", "dst")).blob;
    const srcNode = await store.node("s", "src");
    await store.commit("s", [{ op: "rename", from: "src", to: "dst" }]);
    assert.equal(await store.node("s", "src"), null);
    const n = await store.node("s", "dst");
    assert.equal(n.blob, srcNode.blob);
    assert.equal(n.version, srcNode.version);
    assert.equal(await (await store.blob(n.blob)).text(), "new bytes");
    await assert.rejects(store.blob(oldBlob), /gone/);
    assert.equal(await store.usage("s"), 9);
});

test("rename over an empty folder replaces it", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "a" }, { op: "mkdir", path: "b" }]);
    await store.commit("s", [{ op: "rename", from: "a", to: "b" }]);
    assert.deepEqual((await store.all("s")).map((n) => n.path), ["b"]);
});

test("unlink removes the node and its blob", T, async () => {
    const { store } = setup();
    await store.commit("s", [put("f", "x")]);
    const k = (await store.node("s", "f")).blob;
    await store.commit("s", [{ op: "unlink", path: "f" }]);
    assert.equal(await store.node("s", "f"), null);
    await assert.rejects(store.blob(k), /gone/);
});

test("ops apply in order, each against what the ones before left", T, async () => {
    const { store } = setup();
    await store.commit("s", [{ op: "mkdir", path: "d" }, put("d/f", "x"), { op: "rename", from: "d/f", to: "g" }, { op: "rmdir", path: "d" }]);
    assert.deepEqual((await store.all("s")).map((n) => n.path), ["g"]);
});

// --- forgetSession, sessions, lost ---

test("forgetSession deletes one session's nodes, blobs and lost notes and leaves another's alone", T, async () => {
    const { store } = setup();
    await store.commit("a", [{ op: "mkdir", path: "d" }, put("d/f", "aaa")]);
    await store.commit("b", [put("f", "bbb")]);
    const aBlob = (await store.node("a", "d/f")).blob, bBlob = (await store.node("b", "f")).blob;
    await store.noteLost({ session: "a", path: "agent/x", at: 1, reason: "channel-ended" });
    await store.noteLost({ session: "b", path: "agent/y", at: 2, reason: "channel-ended" });
    assert.equal(await store.forgetSession("a"), 2);
    assert.deepEqual(await store.all("a"), []);
    assert.deepEqual(await store.lost("a"), []);
    await assert.rejects(store.blob(aBlob), /gone/);
    assert.equal((await store.all("b")).length, 1);
    assert.equal(await (await store.blob(bBlob)).text(), "bbb");
    assert.equal((await store.lost("b")).length, 1);
    assert.equal(await store.forgetSession("never"), 0);
});

test("sessions lists every session that has files", T, async () => {
    const { store } = setup();
    assert.deepEqual(await store.sessions(), []);
    await store.commit("a", [put("f", "1")]);
    await store.commit("a", [put("g", "2")]);
    await store.commit("b", [{ op: "mkdir", path: "d" }]);
    assert.deepEqual((await store.sessions()).sort(), ["a", "b"]);
    await store.forgetSession("a");
    assert.deepEqual(await store.sessions(), ["b"]);
});

test("the same path in two sessions is two files", T, async () => {
    const { store } = setup();
    await store.commit("a", [put("f", "from a")]);
    await store.commit("b", [put("f", "from b!")]);
    assert.equal((await store.node("a", "f")).size, 6);
    assert.equal((await store.node("b", "f")).size, 7);
});

test("noteLost keeps at most LOST_KEPT per session, the newest", T, async () => {
    const { store } = setup();
    await store.noteLost({ session: "other", path: "agent/o", at: 0, reason: "channel-ended" });
    for (let i = 0; i < LOST_KEPT + 5; i++) await store.noteLost({ session: "s", path: `agent/f${i}`, at: i, reason: "channel-ended" });
    const kept = await store.lost("s");
    assert.equal(kept.length, LOST_KEPT);
    assert.equal(kept[0].path, "agent/f5");
    assert.equal(kept[kept.length - 1].path, `agent/f${LOST_KEPT + 4}`);
    assert.equal((await store.lost("other")).length, 1);
});
