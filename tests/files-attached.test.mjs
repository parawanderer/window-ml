// files-attached.test.mjs — FILES_ATTACHED (the offscreen document asks the worker which files a session holds) and the
// offscreen document's FilesSource over it (src/python/files-source.ts), for Python's `/files` mount.

// The worker half runs the built worker in node:vm with a real run holding an attached text file (ml-wire-harness.mjs);
// the source half takes a fake store and a fake `send`. Spec: docs/spec/FILE_ATTACHMENTS.md, slice 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRun, OFFSCREEN, SITE, plain } from "./ml-wire-harness.mjs";
import { createFilesSource } from "../src/python/files-source.ts";
import { HANDLE_MAP } from "../src/page-relay.ts";
import { valueForms } from "../src/secret-registry.ts";

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

// --- the secrets' forms, for the mount's mask ---

const API_KEY = "sk-live-0123456789abcdef";
const REGISTERED = "hunter2-correct-horse";
const REGISTRY = { ml_secret_registry: [{ name: "DB_PASS", value: REGISTERED }] };
const askForms = (bg, sender = OFFSCREEN) => bg.send({ type: "FILES_SECRET_FORMS" }, { ...sender }).then(plain);

test("FILES_SECRET_FORMS answers the config's and the registry's forms to the offscreen document, and null to anyone else", { timeout: 30000 }, async () => {
    const { bg } = await wireRun(async () => {}, { calls: [{ name: "python_exec", args: { code: "print(1)" } }], configExtra: { apiKey: API_KEY }, local: REGISTRY });
    const { forms } = await askForms(bg);
    const finds = forms.map((f) => f.find);
    assert.ok(finds.includes(API_KEY), "the API key");
    assert.ok(finds.includes(REGISTERED), "the registered value");
    for (const f of valueForms(REGISTERED)) assert.ok(finds.includes(f), `the registered value's form ${f}`);
    assert.ok(forms.some((f) => f.ci === true && /host/.test(f.find)), "the server URL, in any case");
    for (const f of forms) assert.deepEqual(Object.keys(f).filter((k) => k !== "ci"), ["find", "put"], "a form carries its text, its case rule and the marker a name shows");
    for (const f of forms.filter((x) => valueForms(REGISTERED).includes(x.find) || x.find === REGISTERED)) assert.equal(f.put, "[REDACTED:DB_PASS]", "a registered value's marker names it, as the person's turn does");
    assert.equal(forms.find((f) => f.find === API_KEY).put, "[REDACTED:window-ml-api-key]", "the saved key's marker, as the person's turn writes it");
    assert.equal(forms.find((f) => f.ci === true && /host/.test(f.find)).put, "[server]", "a form the turn does not scrub keeps the config's marker");
    assert.equal(new Set(finds).size, finds.length, "each form once");
    assert.deepEqual([...finds].sort((a, b) => b.length - a.length), finds, "longest first");
    assert.deepEqual(await askForms(bg, PAGE), { forms: null }, "a page's tab sender");
    assert.deepEqual(await askForms(bg, { url: "chrome-extension://test/popup.html" }), { forms: null }, "another extension page");
    assert.deepEqual(await askForms(bg, { url: "chrome-extension://test/offscreen.html", tab: { id: 1 } }), { forms: null }, "the offscreen URL on a tab");
    assert.deepEqual(await askForms(bg, {}), { forms: null }, "no sender facts");
});

test("FILES_SECRET_FORMS is not a page's message: the relay has no entry for it", () => {
    assert.equal("FILES_SECRET_FORMS" in HANDLE_MAP, false);
    assert.ok(!Object.values(HANDLE_MAP).some((e) => e.type === "FILES_SECRET_FORMS" || e.responseType === "FILES_SECRET_FORMS"));
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

test("secretForms: asks the worker at every call, keeps a form's text and case rule only, and throws a fixed message on a failed or malformed answer", async () => {
    const asked = [];
    let answer = { forms: [{ find: "s3cr3t-value", ci: false, extra: 1 }, { find: "Host.Example", ci: true }] };
    const src = createFilesSource({ store: () => fakeStore([]), send: async (m) => { asked.push(m); if (answer instanceof Error) throw answer; return answer; } });
    assert.deepEqual(await src.secretForms(), [{ find: "s3cr3t-value" }, { find: "Host.Example", ci: true }]);
    await src.secretForms();
    assert.deepEqual(asked, [{ type: "FILES_SECRET_FORMS" }, { type: "FILES_SECRET_FORMS" }], "no cache: one ask per call");
    for (const bad of [new Error("boom s3cr3t-value"), undefined, { forms: null }, { forms: "x" }, { forms: [{ find: 7 }] }, { forms: [null] }]) {
        answer = bad;
        await assert.rejects(() => src.secretForms(), (e) => e.message === "the secrets could not be read", JSON.stringify(String(bad)));
    }
});

// --- the quota of run-made files, and a discarded write ---

const askQuota = (bg, sender = OFFSCREEN) => bg.send({ type: "FILES_QUOTA", session: "s" }, { ...sender }).then(plain);
const POPUP_SENDER = { url: "chrome-extension://test/popup.html" };

test("FILES_QUOTA answers filesQuotaMB in bytes to the offscreen document (the default when unset), and null to anyone else", { timeout: 30000 }, async () => {
    const { bg } = await wireRun(async () => {}, { calls: [{ name: "python_exec", args: { code: "print(1)" } }] });
    assert.deepEqual(await askQuota(bg), { bytes: 1024 * 1024 * 1024 }, "a config from before the setting reads as the default");
    const set = (await wireRun(async () => {}, { calls: [{ name: "python_exec", args: { code: "print(1)" } }], configExtra: { filesQuotaMB: 3 } })).bg;
    assert.deepEqual(await askQuota(set), { bytes: 3 * 1024 * 1024 });
    assert.deepEqual(await askQuota(bg, PAGE), { bytes: null }, "a page's tab sender");
    assert.deepEqual(await askQuota(bg, POPUP_SENDER), { bytes: null }, "another extension page");
    assert.deepEqual(await askQuota(bg, { url: "chrome-extension://test/offscreen.html", tab: { id: 1 } }), { bytes: null }, "the offscreen URL on a tab");
    assert.deepEqual(await askQuota(bg, {}), { bytes: null }, "no sender facts");
});

test("FILES_LOST is recorded in the session's run log from the offscreen document only", { timeout: 30000 }, async () => {
    let seen;
    const { bg } = await wireRun(async (wire) => { seen = wire; }, { calls: [{ name: "python_exec", args: { code: "print(1)" } }] });
    const lost = async () => (await bg.send({ type: "DUMP_RUN_LOG", payload: { run: seen.run } }, POPUP_SENDER)).data.events.filter((e) => e.subsystem === "files");
    const rec = { type: "FILES_LOST", session: seen.run, path: "agent/w.npy", at: 1, reason: "channel-ended" };
    // Fire-and-forget, as the offscreen document sends it: nothing answers.
    const delivered = () => new Promise((r) => setTimeout(r, 10));
    for (const sender of [PAGE, POPUP_SENDER, { url: "chrome-extension://test/offscreen.html", tab: { id: 1 } }, {}]) void bg.send(rec, { ...sender });
    await delivered();
    assert.deepEqual(await lost(), [], "a sender other than the offscreen document recorded a discard");
    void bg.send(rec, { ...OFFSCREEN });
    await delivered();
    const got = await lost();
    assert.equal(got.length, 1);
    assert.equal(got[0].kind, "discarded");
    assert.equal(got[0].reason, "channel-ended");
    assert.equal(got[0].detail.path, "agent/w.npy");
});

test("FILES_QUOTA and FILES_LOST are not a page's messages: the relay has no entry for them", () => {
    for (const t of ["FILES_QUOTA", "FILES_LOST"]) {
        assert.equal(t in HANDLE_MAP, false, t);
        assert.ok(!Object.values(HANDLE_MAP).some((e) => e.type === t || e.responseType === t), t);
    }
});
