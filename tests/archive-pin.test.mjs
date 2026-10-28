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
        __fakeHandle: true, __files: files, name: "Archive", kind: "directory",
        isSameEntry: async (o) => o.__files === files,
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

test("the pin is stored beside the folder handle and saveFolder drops it, for another folder or none", async () => {
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

// --- a re-pick keeps the pin only for the same folder (part 3f) ---

test("a re-pick of the same folder keeps the pin, and the stored handle is replaced", async () => {
    globalThis.indexedDB = new IDBFactory();
    const files = new Map();
    await folder.saveFolder(handleOf(files));
    await folder.saveFolderPin("9f3a1c7e2b40d815");
    const again = handleOf(files);
    await folder.saveFolder(again);
    assert.equal(await folder.loadFolderPin(), "9f3a1c7e2b40d815", "same entry: the pin stays");
    assert.equal(await folder.loadFolder(), again, "and the new handle is the stored one");
});

test("a re-pick of a DIFFERENT folder still drops the pin, and so does anything isSameEntry cannot vouch for", async () => {
    const files = new Map();
    for (const [why, next] of [
        ["a different folder", () => handleOf(new Map())],
        ["null", () => null],
        ["a handle that throws on comparison", () => handleOf(files)],
    ]) {
        globalThis.indexedDB = new IDBFactory();
        const stored = handleOf(files);
        if (why.startsWith("a handle that throws")) stored.isSameEntry = async () => { throw new Error("gone"); };
        await folder.saveFolder(stored);
        await folder.saveFolderPin("9f3a1c7e2b40d815");
        await folder.saveFolder(next());
        assert.equal(await folder.loadFolderPin(), null, why);
    }
    // No stored handle, and a stored handle with no isSameEntry at all.
    globalThis.indexedDB = new IDBFactory();
    await folder.saveFolderPin("9f3a1c7e2b40d815");
    await folder.saveFolder(handleOf(files));
    assert.equal(await folder.loadFolderPin(), null, "no stored handle");
    globalThis.indexedDB = new IDBFactory();
    const bare = handleOf(files); delete bare.isSameEntry;
    await folder.saveFolder(bare);
    await folder.saveFolderPin("9f3a1c7e2b40d815");
    await folder.saveFolder(handleOf(files));
    assert.equal(await folder.loadFolderPin(), null, "a stored handle without isSameEntry");
});

test("THE UPGRADE: a pin saved as 3e saved it (a plain string under the key `pin`) survives a same-folder re-pick", async () => {
    globalThis.indexedDB = new IDBFactory();
    const files = new Map();
    await folder.saveFolder(handleOf(files));
    // What 3e wrote, by hand: nothing but a string under `pin`, in the folder's own store.
    const db = await new Promise((res, rej) => { const r = indexedDB.open("ml-archive-folder", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const t = db.transaction("h", "readwrite"); t.objectStore("h").put("9f3a1c7e2b40d815", "pin"); t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
    await folder.saveFolder(handleOf(files));
    assert.equal(await folder.loadFolderPin(), "9f3a1c7e2b40d815");
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
    assert.match(host.textContent, new RegExp(`These files say they are under ${A.keyId.replace(/(.{4})(?=.)/g, "$1 ")}`));
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

// --- junk does not hold the pin off; another key's month still does (part 3f; red-team probe of 3e) ---

const junk = () => new Uint8Array([1, 2, 3, 4]);
/** What the real worker reports for a month-shaped file that is not an archive. */
const junkSkip = (month) => ({ month, reason: "unreadable", error: "not an archive" });
const spaced = (id) => id.replace(/(.{4})(?=.)/g, "$1 ");

test("a month-shaped junk file does not hold the refresh pin off, on the first arm or after the pin was dropped", async () => {
    const skips = [];
    const { here, files } = await world({ script: () => ({ skipped: skips }) });
    files.set("2026-10.wmlbak", await monthOf(await keyring.loadKeyring(keyring.idbKeyringStore()), "SQLite format 3\0 ok"));
    // The writer plants the junk before the first sync, and the worker reports it as unreadable.
    files.set("2026-08.wmlbak", junk());
    skips.push(junkSkip("2026-08"));
    await mount();
    assert.equal(await folder.loadFolderPin(), here.keyId, "armed with junk in the folder");
    // The pin is lost another way (the folder is dropped and picked again); junk and its skip are still there.
    await folder.saveFolder(null);
    await folder.saveFolder(handleOf(files));
    assert.equal(await folder.loadFolderPin(), null, "dropped");
    await mount();
    assert.equal(await folder.loadFolderPin(), here.keyId, "re-armed with junk in the folder");
});

test("with the pin armed, junk and a same-folder re-pick keep the key-changed warning", async () => {
    const skips = [];
    const { here, files } = await world({ script: () => ({ skipped: skips }) });
    files.set("2026-10.wmlbak", await monthOf(await keyring.loadKeyring(keyring.idbKeyringStore()), "SQLite format 3\0 ok"));
    await mount();
    assert.equal(await folder.loadFolderPin(), here.keyId, "control: a clean first refresh pins this install's key");
    const made = await other("pw-other");
    files.set("2026-09.wmlbak", await monthOf(made.ring, "SQLite format 3\0 theirs"));
    skips.push({ month: "2026-09", reason: "other-key", error: "x", keyId: made.keyId });
    let host = await mount();
    assert.match(host.textContent, /This folder's key changed/, "control: with the pin armed the planted month raises the alarm");
    files.set("2026-08.wmlbak", junk());
    skips.push(junkSkip("2026-08"));
    await folder.saveFolder(handleOf(files));
    assert.equal(await folder.loadFolderPin(), here.keyId, "the same-folder re-pick kept the pin");
    host = await mount();
    assert.match(host.textContent, /This folder's key changed/, "junk cannot keep the warning dark");
});

test("a well-formed month under a key this install never held still pins nothing on refresh, junk or not, skip reported or not", async () => {
    const made = await other("pw-other");
    for (const withSkip of [true, false]) {
        const skips = withSkip ? [{ month: "2026-09", reason: "other-key", error: "x", keyId: made.keyId }] : [];
        const { files } = await world({ script: () => ({ skipped: skips }) });
        files.set("2026-09.wmlbak", await monthOf(made.ring, "SQLite format 3\0 theirs"));
        files.set("2026-08.wmlbak", junk());
        await mount();
        assert.equal(await folder.loadFolderPin(), null, `skip reported: ${withSkip}`);
    }
});

test("the changed-key and adopt wording for a relabelled month is the files' claim, and the wrong-secret line says the files may not be what they say", async () => {
    const skips = [];
    const { here, files } = await world({ script: () => ({ skipped: skips }) });
    const X = "c04b77aa19e2f6d3";
    const made = await other("pw-other");
    const theirs = await monthOf(made.ring, "theirs");
    const at = Buffer.from(theirs).indexOf(made.keyId);
    const relabelled = new Uint8Array(theirs);
    relabelled.set(utf8.encode(X), at);
    files.set("2026-10.wmlbak", relabelled);
    skips.push({ month: "2026-10", reason: "other-key", error: "x", keyId: X });
    await folder.saveFolderPin(here.keyId);
    const host = await mount();
    assert.match(host.querySelector(".arch-changed").textContent, new RegExp(`1 month says it is under ${spaced(X)}\\.`));
    assert.doesNotMatch(host.textContent, /month is under|months are under/, "never stated as fact");
    assert.match(host.querySelector(".arch-adopt").textContent, new RegExp(`These files say they are under ${spaced(X)}\\. Check it matches the key shown in Settings on the other machine before you enter its secret; entering it is what checks the files\\.`));
    assert.doesNotMatch(host.textContent, /may not be what they say/, "only after a wrong secret");
    typeInto(host.querySelector(".arch-adopt input"), "wrong"); await flush();
    button(host, "Use this folder's key").click();
    await until(() => /may not be what they say/.test(host.textContent), "the wrong-secret line");
    assert.match(host.querySelector(".arch-adopt .set-err").textContent, /If the key matched, these files may not be what they say\./);
});
