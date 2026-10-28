// The archive folder's pinned key (src/archive/archive-folder.ts `loadFolderPin`, part 3e): the key id this install
// expects the folder's months under, set by a page action only, dropped when another folder is picked, and what turns
// "another install's key" into "this folder's key changed". The Settings section is mounted for real over a fake
// IndexedDB (the handle and the keyring), a Map folder and a scripted worker.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { IDBFactory } = require_("fake-indexeddb");
const CHEAP = { argon: { m: 64, t: 1, p: 1 } };
const utf8 = new TextEncoder();

// A fake directory handle cannot be structured-cloned (it holds functions), so the clone that IndexedDB makes passes it through.
const realClone = globalThis.structuredClone;
globalThis.structuredClone = (v, o) => (v && v.__fakeHandle ? v : realClone(v, o));

let h, render, LocalArchiveFolder, doc, folder, backup, keyring, format;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ LocalArchiveFolder } = await import("../src/sidebar/settings/archive-section.tsx"));
    backup = await import("../src/sidebar/settings/backup-section.tsx");
    folder = await import("../src/archive/archive-folder.ts");
    keyring = await import("../src/backup/backup-keyring.ts");
    format = await import("../src/backup/backup-format.ts");
});

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(check, what) {
    for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 5)); }
    assert.fail(`never happened: ${what}`);
}

/** A directory handle over a Map of files that says its permission is granted. */
function handleOf(files) {
    return {
        __fakeHandle: true, name: "Archive", kind: "directory",
        queryPermission: async () => "granted",
        entries: async function* () { for (const n of files.keys()) yield [n, { kind: "file" }]; },
        getFileHandle: async (n) => { if (!files.has(n)) throw new Error("NotFound"); return { getFile: async () => new Blob([files.get(n)]) }; },
    };
}
const monthOf = (ring, body) => format.encryptFile(utf8.encode(body), ring, { kind: "archive-month" });

/**
 * A fresh browser: its IndexedDB, this install's keyring (passphrase `pw-here`), a picked folder holding `files`, and a
 * worker whose answers the test scripts. `script(action, form)` returns what the worker reports back.
 */
async function world({ files = new Map(), script = () => ({}) } = {}) {
    globalThis.indexedDB = new IDBFactory();
    const here = await keyring.setupKeyring(keyring.idbKeyringStore(), "pw-here", CHEAP);
    await folder.saveFolder(handleOf(files));
    const calls = [];
    const report = async (over) => ({ state: "connected", name: "Archive", pending: 0, lastSync: 1790000000000, form: "encrypted", keyring: await keyring.keyringState(keyring.idbKeyringStore()), ...over });
    globalThis.chrome = { runtime: { sendMessage: (msg, cb) => {
        const { action, form } = msg.payload;
        calls.push(action);
        void (async () => cb({ data: await report(await script(action, form)) }))();
    } } };
    return { here, files, calls, report };
}
const mount = async () => {
    const host = doc.getElementById("root");
    render(null, host);
    render(h(LocalArchiveFolder, { archiveOn: true }), host);
    await until(() => button(host, "Write now"), "the connected folder is drawn");
    await new Promise((r) => setTimeout(r, 40));   // the refresh goes on after it draws: counting the months, then the pin
    return host;
};
const button = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text || (text instanceof RegExp && text.test(b.textContent)));
const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true })); };
const choose = (host, i) => { const r = host.querySelectorAll('input[type="radio"]')[i]; r.checked = true; r.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true })); };
const other = async (pass = "pw-other") => { const made = await format.createKeyring(pass, CHEAP); return { ring: made.keyring, keyId: made.keyring.keyId }; };

// --- where the pin lives ---

test("the pin is stored beside the folder handle and any saveFolder drops it, a new folder, none, or the same one again", async () => {
    globalThis.indexedDB = new IDBFactory();
    assert.equal(await folder.loadFolderPin(), null, "nothing pinned on a new install");
    await folder.saveFolder(handleOf(new Map()));
    await folder.saveFolderPin("9f3a1c7e2b40d815");
    assert.equal(await folder.loadFolderPin(), "9f3a1c7e2b40d815");
    assert.equal((await folder.loadFolder()).name, "Archive", "the handle is untouched by the pin");
    await folder.saveFolder(handleOf(new Map()));
    assert.equal(await folder.loadFolderPin(), null, "another folder picked");
    await folder.saveFolderPin("c04b77aa19e2f6d3");
    await folder.saveFolder(null);
    assert.equal(await folder.loadFolderPin(), null, "stopped using the folder");
    assert.equal(await folder.loadFolder(), null);
    await folder.saveFolderPin("c04b77aa19e2f6d3");
    await folder.saveFolderPin(null);
    assert.equal(await folder.loadFolderPin(), null, "null drops it");
});

// --- the four places a page pins ---

test("pin 1: adopting the folder's key pins the adopted id, and before that the offer is the neutral one with the id to match", async () => {
    const A = await other("pw-of-a");
    const files = new Map([["2026-09.wmlbak", await monthOf(A.ring, "SQLite format 3\0 a")]]);
    const w = await world({ files, script: (action) => (action === "sync" ? { written: [], skipped: [{ month: "2026-09", reason: "other-key", error: "x", keyId: A.keyId }] } : action === "rekey" ? { written: [] } : {}) });
    const host = await mount();
    assert.equal(await folder.loadFolderPin(), null, "a month this install cannot open: no pin from the refresh");
    button(host, "Write now").click();
    await until(() => host.querySelector(".arch-adopt"), "the adopt block");
    assert.doesNotMatch(host.textContent, /key changed/, "no pin: the neutral offer");
    assert.match(host.textContent, new RegExp(`Key in these files: ${A.keyId.replace(/(.{4})(?=.)/g, "$1 ")}`));
    typeInto(host.querySelector(".arch-adopt input"), "pw-of-a"); await flush();
    button(host, "Use this folder's key").click();
    await until(async () => (await folder.loadFolderPin()) === A.keyId, "the pin follows the adoption");
    assert.equal((await keyring.keyringState(keyring.idbKeyringStore())).keyId, A.keyId);
    assert.ok(w.calls.includes("rekey"));
});

test("pin 2: switching the folder's form to encrypted pins this install's key; switching to another form pins nothing", async () => {
    let form = "plain";
    const w = await world({ script: (action, f) => { if (action === "form") form = f; return { form, written: [], removed: [] }; } });
    const host = await mount();
    assert.equal(await folder.loadFolderPin(), null, "plain: nothing to pin");
    choose(host, 1); await flush();
    button(host, /^Switch to/).click();
    await until(() => form === "gzip", "compressed sent");
    await flush(); await flush();
    assert.equal(await folder.loadFolderPin(), null, "compressed is not encrypted");
    choose(host, 0); await flush();
    button(host, /^Switch to/).click();
    await until(async () => (await folder.loadFolderPin()) === w.here.keyId, "pinned on the switch to encrypted");
});

test("pin 3: a restore that adopts a backup's key pins it when a folder is picked (that restore does not rekey the folder), and not when none is", async () => {
    await world();
    await backup.pinAdoptedBackupKey("c04b77aa19e2f6d3");
    assert.equal(await folder.loadFolderPin(), "c04b77aa19e2f6d3");
    globalThis.indexedDB = new IDBFactory();
    await backup.pinAdoptedBackupKey("c04b77aa19e2f6d3");
    assert.equal(await folder.loadFolderPin(), null, "no folder, no pin");
    assert.equal(await folder.loadFolder(), null);
});

test("pin 4: a refresh of a connected encrypted folder that has synced and has nothing skipped pins this install's key, once", async () => {
    const own = await world();
    own.files.set("2026-09.wmlbak", await monthOf((await keyring.loadKeyring(keyring.idbKeyringStore())), "SQLite format 3\0 mine"));
    await mount();
    await until(async () => (await folder.loadFolderPin()) === own.here.keyId, "pinned by the refresh");
    // Already pinned: a refresh never moves it, whatever the folder now holds.
    await folder.saveFolderPin("c04b77aa19e2f6d3");
    await mount();
    assert.equal(await folder.loadFolderPin(), "c04b77aa19e2f6d3");
});

for (const [why, setup, over] of [
    ["a month this install cannot open is in the folder", async (w) => { const o = await other(); w.files.set("2026-08.wmlbak", await monthOf(o.ring, "SQLite format 3\0 theirs")); }, {}],
    ["a month's file is damaged", async (w) => { w.files.set("2026-08.wmlbak", new Uint8Array([9, 9, 9])); }, {}],
    ["the folder never synced", async () => {}, { lastSync: null }],
    ["the form is not encrypted", async () => {}, { form: "gzip" }],
]) {
    test(`pin 4 is NOT set when ${why}`, async () => {
        const w = await world({ script: () => over });
        await setup(w);
        const host = await mount();
        assert.ok(button(host, "Write now"), "drawn, so the refresh ran");
        assert.equal(await folder.loadFolderPin(), null);
    });
}

// --- the warning ---

test("a pinned folder whose months turn up under another key says the folder's key changed, and adopting that key moves the pin and clears the warning", async () => {
    const A = await other("pw-of-a");
    let planted = false;
    const w = await world({ script: (action) => {
        if (action === "sync" && planted) return { written: [], skipped: [{ month: "2026-09", reason: "other-key", error: "x", keyId: A.keyId }] };
        return action === "rekey" ? { written: [], skipped: [] } : {};
    } });
    w.files.set("2026-08.wmlbak", await monthOf(await keyring.loadKeyring(keyring.idbKeyringStore()), "SQLite format 3\0 mine"));
    const host = await mount();
    await until(async () => (await folder.loadFolderPin()) === w.here.keyId, "the clean refresh pinned this install's key");
    // Someone puts a month under another key in the folder; the next sync skips it.
    w.files.set("2026-09.wmlbak", await monthOf(A.ring, "SQLite format 3\0 planted"));
    planted = true;
    button(host, "Write now").click();
    await until(() => host.querySelector(".arch-changed"), "the changed-key block");
    const text = host.querySelector(".arch-changed").textContent;
    assert.match(text, /This folder's key changed/);
    assert.ok(text.includes(w.here.keyId.replace(/(.{4})(?=.)/g, "$1 ")) && text.includes(A.keyId.replace(/(.{4})(?=.)/g, "$1 ")), "both ids");
    assert.ok(host.querySelector(".arch-adopt"), "adoption stays possible");
    typeInto(host.querySelector(".arch-adopt input"), "pw-of-a"); await flush();
    button(host, "Use this folder's key").click();
    await until(async () => (await folder.loadFolderPin()) === A.keyId, "adopting moves the pin");
    await until(() => !host.querySelector(".arch-changed"), "the warning is gone");
});
