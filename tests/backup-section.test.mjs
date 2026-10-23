// The Settings backup and restore screens (src/sidebar/settings/backup-section.tsx): the recovery key is shown once and
// only a right group typed back goes on, the form says what each choice does, a restore's preview puts sites first and
// says what a cut value or a risky setting does, and nothing about the key reaches a storage write.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, M, doc, win;
const writes = [];   // every value written to chrome.storage or localStorage, as JSON text
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    win = dom.window; doc = win.document;
    globalThis.window = win; globalThis.document = doc; globalThis.Node = win.Node;
    // Everything that can persist is a spy: a write of the recovery key anywhere would land in `writes`.
    const area = { get: async () => ({}), set: async (o) => { writes.push(JSON.stringify(o)); }, remove: async () => {} };
    const ls = win.localStorage, set = ls.setItem.bind(ls);
    globalThis.localStorage = ls; ls.setItem = (k, v) => { writes.push(`${k}=${v}`); set(k, v); };
    globalThis.chrome = { storage: { sync: area, local: area, session: area }, runtime: { sendMessage: (_m, cb) => cb({ error: "no worker in this test" }) } };
    globalThis.indexedDB = new (require_("fake-indexeddb").IDBFactory)();
    ({ h, render } = require_("preact"));
    M = await import("../src/sidebar/settings/backup-section.tsx");
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const root = () => doc.getElementById("root");
const show = (C, props) => { render(null, root()); render(h(C, props), root()); return root(); };
const buttons = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent);
const button = (host, label) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const type = async (input, v) => { input.value = v; input.dispatchEvent(new win.Event("input", { bubbles: true })); await tick(); };
const GROUPS = ["K7QF", "2MXR", "9TWD", "H4BN", "6CJV", "PZ3E", "8GYA"];

// --- the pure rules ---

test("a passphrase needs the minimum length and a matching repeat", () => {
    assert.match(M.passphraseProblem("short", "short"), /at least 12/);
    assert.match(M.passphraseProblem("a long enough one", "a long enough two"), /differ/);
    assert.equal(M.passphraseProblem("a long enough one", "a long enough one"), null);
});

test("a typed group matches case-blind and forgives the look-alikes the key never uses", () => {
    assert.ok(M.groupMatches(GROUPS, 3, "h4bn"));
    assert.ok(M.groupMatches(GROUPS, 3, " H4BN "));
    assert.ok(M.groupMatches(GROUPS, 6, "8gya"));
    assert.ok(!M.groupMatches(GROUPS, 3, "H4BM"));
    assert.ok(!M.groupMatches(GROUPS, 3, "2MXR"), "another group is not this group");
    assert.ok(!M.groupMatches(GROUPS, 9, ""), "a group that does not exist matches nothing");
});

test("the group asked for is always one the key has", () => {
    for (const r of [0, 0.3, 0.999999, 1]) assert.ok(M.pickGroupIndex(7, () => r) < 7);
});

test("one field takes a passphrase or a recovery key, told apart by shape", () => {
    assert.deepEqual(M.secretFromText("K7QF-2MXR-9TWD-H4BN-6CJV-PZ3E-8GYA"), { recoveryKey: "K7QF-2MXR-9TWD-H4BN-6CJV-PZ3E-8GYA" });
    assert.deepEqual(M.secretFromText(" k7qf 2mxr 9twd h4bn 6cjv pz3e 8gya "), { recoveryKey: "k7qf 2mxr 9twd h4bn 6cjv pz3e 8gya" });
    assert.deepEqual(M.secretFromText("correct horse battery staple"), { passphrase: "correct horse battery staple" });
    assert.deepEqual(M.secretFromText("K7QF-2MXR"), { passphrase: "K7QF-2MXR" });
});

test("the saved file is named with the form's extension and the date", () => {
    const d = new Date("2026-10-23T12:00:00Z");
    assert.equal(M.backupFileName("encrypted", d), "window-ml-backup-2026-10-23.wmlbak");
    assert.equal(M.backupFileName("plain", d), "window-ml-backup-2026-10-23.sqlite");
    assert.equal(M.backupFileName("gzip", d), "window-ml-backup-2026-10-23.sqlite.gz");
});

// --- the recovery screen ---

const recovery = (over) => ({ stage: "verify", groups: GROUPS, askIndex: 3, busy: false, message: "", onChoose() {}, onSaved() {}, onBack() {}, onVerified() {}, onCancel() {}, ...over });

test("the type-back refuses a wrong group and accepts the right one", async () => {
    const calls = [];
    const host = show(M.RecoveryKeyBody, recovery({ onVerified: () => calls.push("verified") }));
    assert.match(host.textContent, /Type group 4/);
    await type(host.querySelector("input"), "2MXR");   // a real group, the wrong one
    button(host, "Finish set-up").click(); await tick();
    assert.deepEqual(calls, []);
    assert.match(root().textContent, /not group 4/);
    await type(root().querySelector("input"), "h4bn");
    button(root(), "Finish set-up").click(); await tick();
    assert.deepEqual(calls, ["verified"]);
});

test("the key screen shows the groups once, with copy, download and print, and says what losing it means", () => {
    const host = show(M.RecoveryKeyBody, recovery({ stage: "show" }));
    assert.deepEqual([...host.querySelectorAll(".bk-group")].map((g) => g.textContent), GROUPS);
    assert.deepEqual(buttons(host).slice(0, 3), ["Copy", "Download as .txt", "Print"]);
    assert.match(host.textContent, /If you lose both the passphrase and this key, nobody can open these files\./);
});

test("the passphrase step states why the length matters and holds Continue until both match", async () => {
    const host = show(M.RecoveryKeyBody, recovery({ stage: "choose", groups: [] }));
    assert.match(host.textContent, /at least 12 characters/);
    assert.equal(button(host, "Continue").disabled, true);
    const [a, b] = host.querySelectorAll("input");
    await type(a, "a long enough pass"); await type(b, "a long enough pass");
    assert.equal(button(root(), "Continue").disabled, false);
});

// --- the backup form ---

const backupProps = (over) => ({ keyringSet: true, busy: false, message: "", result: null, onMake() {}, ...over });

test("a plain or compressed backup offers the API-key box, off by default; an encrypted one does not", async () => {
    assert.equal(show(M.BackupBody, backupProps()).querySelector("input[type=checkbox]"), null, "encrypted, the default");
    for (const initialForm of ["plain", "gzip"]) {
        const box = show(M.BackupBody, backupProps({ initialForm })).querySelector("input[type=checkbox]");
        assert.ok(box, initialForm);
        assert.equal(box.checked, false, "off by default");
    }
});

test("the form says why encrypted and where the decryptor script is; Make sends the choice", async () => {
    const calls = [];
    const host = show(M.BackupBody, backupProps({ initialForm: "plain", onMake: (...a) => calls.push(a) }));
    assert.match(host.textContent, /holds every session/);
    assert.match(host.textContent, /tools\/wmlbak-decrypt\.mjs/);
    host.querySelector("input[type=checkbox]").click(); await tick();
    button(root(), "Make a backup").click();
    assert.deepEqual(calls, [["plain", true]]);
});

test("a finished backup reports its size and sessions, that the key was left out, and any unclassified key", () => {
    const host = show(M.BackupBody, backupProps({ initialForm: "plain", result: { size: 2048, sessions: 1, form: "plain", apiKeyOmitted: true, unclassified: [{ area: "local", key: "ml_x" }], savedAs: "b.sqlite" } }));
    assert.match(host.textContent, /Saved b\.sqlite: 2\.00 KiB, 1 session\./);
    assert.match(host.textContent, /The API key was left out\./);
    assert.match(host.textContent, /Developer warning.*local\.ml_x/);
});

// --- restore ---

const restoreProps = (over) => ({ state: { kind: "idle" }, message: "", onPick() {}, onUnlock() {}, onRestore() {}, onReread() {}, onCancel() {}, ...over });

test("needs-key asks for a passphrase or recovery key; wrong-secret says so and keeps the field", () => {
    const needs = show(M.RestoreBody, restoreProps({ state: { kind: "needs-key" } }));
    assert.ok(needs.querySelector("input"));
    assert.doesNotMatch(needs.textContent, /does not open this file/);
    assert.match(needs.textContent, /another install/);
    const wrong = show(M.RestoreBody, restoreProps({ state: { kind: "needs-key", wrong: true } }));
    assert.ok(wrong.querySelector("input"), "the field stays");
    assert.match(wrong.textContent, /does not open this file/);
});

test("unlocking shows a progress state and disables the buttons", () => {
    const host = show(M.RestoreBody, restoreProps({ state: { kind: "unlocking" } }));
    assert.match(host.textContent, /Unlocking…/);
    assert.ok(host.querySelector(".pbar"));
    assert.ok([...host.querySelectorAll("button")].every((b) => b.disabled));
});

const offer = (over = {}) => ({
    contents: { sessions: 5, newSessions: 2, digest: "d", hashes: ["a", "b", "c"], settings: null, created: null, more: 1,
        adding: [{ hash: "a", title: "First chat", createdTs: 1792000000000, bytes: 2048 }, { hash: "b", title: "Second chat", createdTs: 1791900000000, bytes: 1024 }] },
    plan: {
        unchanged: 0, dropped: [], notes: [], apiKeyIncluded: false,
        sites: [{ origin: "https://shop.example", use: ["unset", "always"], agents: ["unset", "unset"], selfApprove: [false, false], becomesApproved: true, gainsSelfApprove: false }],
        policies: [{ id: "p", label: "Docs reader", effect: "allow", consumer: "exec", kind: "added", source: "fetch.url.startsWith('https://docs.example/')" }],
        changes: [
            { area: "sync", key: "chatUrl", kind: "changed", group: "risky", before: "http://a/v1", after: "http://b/v1", shown: { before: '"http://a/v1"', after: '"http://b/v1"' }, why: "this backup carries no API key, so THIS browser's saved API key would be sent to this address" },
            { area: "sync", key: "modelFilter", kind: "changed", group: "risky", before: "", after: "x".repeat(200), shown: { before: '""', after: `"${"x".repeat(156)}...`, truncated: true, length: { before: 2, after: 202 } }, why: "the whitelist of models" },
            { area: "sync", key: "theme", kind: "changed", group: "settings", before: "light", after: "dark", shown: { before: '"light"', after: '"dark"' } },
        ],
    },
    ...over,
});

test("the preview lists sites first, then policies with their predicate, then risky settings with why, the rest collapsed", () => {
    const host = show(M.RestoreBody, restoreProps({ state: { kind: "preview", offer: offer() } }));
    const heads = [...host.querySelectorAll(".bk-h")].map((e) => e.textContent);
    assert.match(heads[0], /These sites will be able to use window\.ml/);
    assert.deepEqual(heads.slice(1, 3).map((t) => t.replace(/ .*/, "")), ["Policies", "Settings"]);
    assert.match(host.textContent, /https:\/\/shop\.example/);
    assert.equal(host.querySelector(".bk-src").textContent, "fetch.url.startsWith('https://docs.example/')", "the predicate, not only the label");
    assert.match(host.textContent, /this backup carries no API key, so THIS browser's saved API key would be sent to this address/);
    const rest = host.querySelector("details");
    assert.match(rest.querySelector("summary").textContent, /1 other setting/);
    assert.equal(rest.open, false, "the rest is collapsed");
});

test("a cut value says how much was shown and opens whole on request", async () => {
    const host = show(M.RestoreBody, restoreProps({ state: { kind: "preview", offer: offer() } }));
    assert.match(host.textContent, /First 160 of 202 characters/);
    assert.equal(host.querySelectorAll(".bk-src").length, 1, "only the policy's predicate until asked");
    button(host, "Show the whole value").click(); await tick();
    assert.ok([...root().querySelectorAll(".bk-src")].some((e) => e.textContent === "x".repeat(200)));
});

test("the new sessions are listed with title, date and size, then how many more", () => {
    const host = show(M.RestoreBody, restoreProps({ state: { kind: "preview", offer: offer() } }));
    assert.match(host.textContent, /First chat/);
    assert.match(host.textContent, /2\.00 KiB/);
    assert.match(host.textContent, /and 1 more/);
    assert.match(host.textContent, /Restore sessions \(2 new\)/);
});

test("Restore sends what the person chose, and unticking both disables it", async () => {
    const calls = [];
    const host = show(M.RestoreBody, restoreProps({ state: { kind: "preview", offer: offer() }, onRestore: (o) => calls.push(o) }));
    button(host, "Restore").click();
    assert.deepEqual(calls, [{ sessions: true, settings: true }]);
    for (const box of host.querySelectorAll("input[type=checkbox]")) { box.click(); await tick(); }
    assert.equal(button(root(), "Restore").disabled, true);
});

test("a file that changed since the preview says so and offers to read it again", () => {
    const calls = [];
    const host = show(M.RestoreBody, restoreProps({ state: { kind: "changed" }, onReread: () => calls.push("again") }));
    assert.match(host.textContent, /changed after it was previewed/);
    button(host, "Read it again").click();
    assert.deepEqual(calls, ["again"]);
});

// --- the key never reaches storage ---

test("setting up encryption writes the recovery key to no storage, and stores no keyring until it is typed back", async () => {
    const { keyringState, idbKeyringStore } = await import("../src/backup/backup-keyring.ts");
    writes.length = 0;
    const host = show(M.LocalBackup, {});
    await tick(100);
    button(host, "Set up encryption and back up…").click(); await tick();
    const [a, b] = root().querySelectorAll("input");
    await type(a, "a long enough passphrase"); await type(b, "a long enough passphrase");
    button(root(), "Continue").click();
    for (let i = 0; i < 100 && !root().querySelector(".bk-group"); i++) await tick(50);   // Argon2 runs here
    const groups = [...root().querySelectorAll(".bk-group")].map((g) => g.textContent);
    assert.equal(groups.length, 7, "the key is shown");
    assert.equal((await keyringState(idbKeyringStore())).set, false, "nothing is stored while the key is only shown");
    button(root(), "I have saved it").click(); await tick();
    const ask = Number(/Type group (\d)/.exec(root().textContent)[1]);
    await type(root().querySelector("input"), groups[ask - 1]);
    button(root(), "Finish set-up").click();
    for (let i = 0; i < 40 && !(await keyringState(idbKeyringStore())).set; i++) await tick(50);
    assert.equal((await keyringState(idbKeyringStore())).set, true, "stored once the key was typed back");
    const all = writes.join("\n");
    for (const g of groups) assert.ok(!all.includes(g), `group ${g} reached a storage write`);
    assert.ok(!all.includes("a long enough passphrase"), "nor did the passphrase");
});
