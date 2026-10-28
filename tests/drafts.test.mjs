// drafts.test.mjs — the composer's drafts (src/sidebar/drafts.ts): what was typed survives a failed send, leaving the
// box, and a page that died with a send still unconfirmed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
const D = await import("../src/sidebar/drafts.ts");

beforeEach(() => store.clear());

test("a draft is saved as typed and read back; an empty one is removed", () => {
    D.saveDraft("rt:a", "half a thought");
    assert.equal(D.loadDraft("rt:a"), "half a thought");
    assert.equal(D.loadDraft("rt:b"), "", "each session keeps its own");
    D.saveDraft("rt:a", "");
    assert.equal(store.size, 0);
});

test("a send that is taken leaves nothing behind", async () => {
    const r = await D.sendHeld("rt:a", "hello", [], async () => {
        assert.equal(store.size, 1, "held while in flight");
        return { ok: true };
    });
    assert.deepEqual(r, { ok: true });
    assert.equal(D.loadDraft("rt:a"), "");
    assert.equal(store.size, 0);
});

test("a send that fails comes back, in front of what was typed meanwhile, with its images, and says so", async () => {
    const heard = [];
    const off = D.onDraftRestored((k) => heard.push(k));
    const r = await D.sendHeld("rt:a", "the long message", ["data:image/png;base64,AAAA"], async () => {
        // The box was emptied and the person started the next thing while it was in flight.
        D.saveDraft("rt:a", "and another");
        D.saveDraftImages("rt:a", ["data:image/png;base64,BBBB"]);
        return { ok: false, error: "network down" };
    });
    off();
    assert.equal(r.ok, false);
    assert.equal(D.loadDraft("rt:a"), "the long message\n\nand another");
    assert.deepEqual(D.loadDraftImages("rt:a"), ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]);
    assert.deepEqual(heard, ["rt:a"]);
    D.saveDraftImages("rt:a", []);
});

test("a send that throws counts as a failure and still comes back", async () => {
    const r = await D.sendHeld("rt:a", "kept", [], async () => { throw new Error("socket closed"); });
    assert.deepEqual(r, { ok: false, error: "socket closed" });
    assert.equal(D.loadDraft("rt:a"), "kept");
});

test("a send a dead page left unconfirmed is put back on the next load; one in flight on this page is not", async () => {
    store.set("wml-sending:rt:a", JSON.stringify([{ id: "otherpage:1", text: "sent as the app died" }]));
    D.saveDraft("rt:a", "typed after");
    let release;
    const inFlight = D.sendHeld("rt:a", "still going", [], () => new Promise((res) => { release = res; }));
    // The box was emptied by this send, so "typed after" is gone from the draft; the dead page's send comes back.
    assert.equal(D.loadDraft("rt:a"), "sent as the app died");
    assert.equal(D.loadDraft("rt:a"), "sent as the app died", "restored once, not again on every load");
    release({ ok: true });
    await inFlight;
    assert.equal(D.loadDraft("rt:a"), "sent as the app died");
});

test("joinDraft skips blank sides", () => {
    assert.equal(D.joinDraft("a", ""), "a");
    assert.equal(D.joinDraft("", "b"), "b");
    assert.equal(D.joinDraft("a", "  "), "a");
});

// --- images written through to IndexedDB (ml-drafts) ---
// A "reload" is a fresh import of drafts.ts (its own page id, empty Maps) over the same fake IndexedDB.
import { createRequire } from "node:module";
const fake = createRequire(import.meta.url)("fake-indexeddb");
let n = 0;
const reload = () => import(`../src/sidebar/drafts.ts?reload=${++n}`);
const IMG = (c) => `data:image/png;base64,${c}`;

test("images saved are back after a reload, and a box on screen is told", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    await A.draftsSettled();
    A.saveDraftImages("im:a", [IMG("AAAA"), IMG("BBBB")]);
    await A.draftsSettled();
    const B = await reload();
    const heard = [];
    B.onDraftRestored((k) => heard.push(k));
    assert.deepEqual(B.loadDraftImages("im:a"), [], "synchronous until the read lands");
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("im:a"), [IMG("AAAA"), IMG("BBBB")]);
    assert.deepEqual(heard, ["im:a"]);
});

test("an empty list deletes the key from the store", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    A.saveDraftImages("im:a", [IMG("AAAA")]);
    A.saveDraftImages("im:a", []);
    await A.draftsSettled();
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("im:a"), []);
});

test("a save made before the restore finishes wins over the restored copy; an empty mount-save does not", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    A.saveDraftImages("im:a", [IMG("OLD1")]);
    A.saveDraftImages("im:b", [IMG("BBBB")]);
    await A.draftsSettled();
    const B = await reload();
    B.saveDraftImages("im:a", [IMG("NEW1")]);
    B.saveDraftImages("im:b", []); // the composer's mount effect: nothing in memory yet, nothing changed
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("im:a"), [IMG("NEW1")]);
    assert.deepEqual(B.loadDraftImages("im:b"), [IMG("BBBB")]);
    const C = await reload();
    await C.draftsSettled();
    assert.deepEqual(C.loadDraftImages("im:a"), [IMG("NEW1")], "and the store holds the new one");
});

test("over the cap the least recently saved key goes first, and the memory keeps it", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    const big = IMG("x".repeat(Math.floor(A.CAP_BYTES / 2.5)));
    A.saveDraftImages("im:old", [big]);
    A.saveDraftImages("im:mid", [big]);
    A.saveDraftImages("im:new", [big]);
    await A.draftsSettled();
    assert.deepEqual(A.loadDraftImages("im:old"), [big], "this page still has it");
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("im:old"), []);
    assert.deepEqual(B.loadDraftImages("im:mid"), [big]);
    assert.deepEqual(B.loadDraftImages("im:new"), [big]);
});

test("storage that cannot open keeps today's in-memory behaviour, with no error", async () => {
    globalThis.indexedDB = { open() { throw new Error("SecurityError"); } };
    const A = await reload();
    A.saveDraftImages("im:a", [IMG("AAAA")]);
    assert.deepEqual(A.loadDraftImages("im:a"), [IMG("AAAA")]);
    const r = await A.sendHeld("im:a", "t", [IMG("AAAA")], async () => ({ ok: false }));
    assert.equal(r.ok, false);
    await A.draftsSettled();
    assert.deepEqual(A.loadDraftImages("im:a"), [IMG("AAAA")]);
    delete globalThis.indexedDB;
    const B = await reload();
    await B.draftsSettled();
    B.saveDraftImages("im:b", [IMG("BBBB")]);
    assert.deepEqual(B.loadDraftImages("im:b"), [IMG("BBBB")]);
});

test("a send held when the page died brings its images back with its text, when the box is drawn; a confirmed send clears them", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    A.saveDraftImages("im:a", [IMG("CCCC")]);
    // The page dies with the send in flight: its promise never settles.
    void A.sendHeld("im:a", "never confirmed", [IMG("AAAA")], () => new Promise(() => {}));
    await A.draftsSettled();
    const B = await reload();
    const heard = [];
    B.onDraftRestored((k) => heard.push(k));
    await B.draftsSettled();
    assert.deepEqual(heard, [], "nothing is claimed at load");
    assert.deepEqual(B.loadDraftImages("im:a"), []);
    assert.equal(B.loadDraft("im:a"), "never confirmed");
    assert.deepEqual(B.loadDraftImages("im:a"), [IMG("AAAA")]);
    await B.draftsSettled();
    assert.deepEqual(heard, ["im:a"]);
    const C = await reload();
    await C.draftsSettled();
    assert.deepEqual(C.loadDraftImages("im:a"), [IMG("AAAA")], "claimed once, now an ordinary draft");
    // A confirmed send leaves nothing.
    const ok = await C.sendHeld("im:z", "fine", [IMG("ZZZZ")], async () => ({ ok: true }));
    assert.equal(ok.ok, true);
    await C.draftsSettled();
    const D = await reload();
    await D.draftsSettled();
    assert.deepEqual(D.loadDraftImages("im:z"), []);
});

test("another page's send still in flight keeps its images when this page loads; once that page died, drawing the box takes them in order", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    let release;
    const live = A.sendHeld("im:a", "first", [IMG("1111")], () => new Promise((r) => { release = r; }));
    void A.sendHeld("im:a", "second", [IMG("2222")], () => new Promise(() => {}));
    await A.draftsSettled();
    // Another tab loads meanwhile. Text is in the shared localStorage, images in the shared store.
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("im:a"), [], "a live send's images are not claimed at load");
    // The first send succeeds on page A and drops its record; the second is never answered (page A dies).
    release({ ok: true });
    await live;
    await A.draftsSettled();
    assert.equal(B.loadDraft("im:a"), "second");
    assert.deepEqual(B.loadDraftImages("im:a"), [IMG("2222")]);
    const C = await reload();
    await C.draftsSettled();
    assert.deepEqual(C.loadDraftImages("im:a"), [IMG("2222")], "the confirmed send's images did not come back");
});

test("loadDraft before the restore finishes still gets the images once it does", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    void A.sendHeld("im:a", "dead one", [IMG("AAAA")], () => new Promise(() => {}));
    await A.draftsSettled();
    const B = await reload();
    const heard = [];
    B.onDraftRestored((k) => heard.push(k));
    assert.equal(B.loadDraft("im:a"), "dead one");
    assert.deepEqual(B.loadDraftImages("im:a"), [], "not yet");
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("im:a"), [IMG("AAAA")]);
    assert.deepEqual(heard, ["im:a"]);
});

test("a held record nobody claimed for a day is deleted, not restored", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    void A.sendHeld("im:a", "old", [IMG("AAAA")], () => new Promise(() => {}));
    await A.draftsSettled();
    store.clear(); // its text is gone too: an orphan
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 3600 * 1000;
    try {
        const B = await reload();
        await B.draftsSettled();
    } finally { Date.now = realNow; }
    const C = await reload();
    await C.draftsSettled();
    assert.equal(C.loadDraft("im:a"), "");
    assert.deepEqual(C.loadDraftImages("im:a"), []);
});

// --- the upgrade: a profile from before the images were stored ---

test("a profile with text drafts in localStorage and no image store loads the text, no images, no error", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    store.set("wml-draft:old:1", JSON.stringify("text typed last week"));
    const A = await reload();
    const heard = [];
    A.onDraftRestored((k) => heard.push(k));
    await A.draftsSettled();
    assert.equal(A.loadDraft("old:1"), "text typed last week");
    assert.deepEqual(A.loadDraftImages("old:1"), []);
    assert.deepEqual(heard, []);
});

// --- attached text files, kept like the images (docs/spec/FILE_ATTACHMENTS.md, slice 1) ---

const LOG = { name: "server.log", type: "text/plain", text: "boot ok\nlistening\n" };
const CSV = { name: "rows.csv", type: "text/csv", text: "a,b\n1,2\n" };

test("files saved are back after a reload, a box on screen is told, and an empty list deletes them", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    await A.draftsSettled();
    A.saveDraftFiles("fi:a", [LOG, CSV]);
    await A.draftsSettled();
    const B = await reload();
    const heard = [];
    B.onDraftRestored((k) => heard.push(k));
    assert.deepEqual(B.loadDraftFiles("fi:a"), [], "synchronous until the read lands");
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftFiles("fi:a"), [LOG, CSV]);
    assert.deepEqual(heard, ["fi:a"]);
    B.saveDraftFiles("fi:a", []);
    await B.draftsSettled();
    const C = await reload();
    await C.draftsSettled();
    assert.deepEqual(C.loadDraftFiles("fi:a"), []);
});

test("images and files in one box are restored independently, each under its own key", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    A.saveDraftImages("fi:m", [IMG("AAAA")]);
    A.saveDraftFiles("fi:m", [LOG]);
    A.saveDraftFiles("fi:n", [CSV]);
    await A.draftsSettled();
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("fi:m"), [IMG("AAAA")]);
    assert.deepEqual(B.loadDraftFiles("fi:m"), [LOG]);
    assert.deepEqual(B.loadDraftFiles("fi:n"), [CSV]);
});

test("a send that fails puts its files back in front of the ones attached meanwhile", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    const r = await A.sendHeld("fi:f", "the question", [], async () => {
        assert.deepEqual(A.loadDraftFiles("fi:f"), [], "the box was emptied for the send");
        A.saveDraftFiles("fi:f", [CSV]);
        return { ok: false, error: "network down" };
    }, [LOG]);
    assert.equal(r.ok, false);
    assert.deepEqual(A.loadDraftFiles("fi:f"), [LOG, CSV]);
});

test("a send that is taken leaves no files behind in memory or in the store", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    const ok = await A.sendHeld("fi:g", "fine", [], async () => ({ ok: true }), [LOG]);
    assert.equal(ok.ok, true);
    assert.deepEqual(A.loadDraftFiles("fi:g"), []);
    await A.draftsSettled();
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftFiles("fi:g"), []);
    assert.equal(B.loadDraft("fi:g"), "");
    assert.deepEqual(B.loadDraftFiles("fi:g"), [], "and nothing is claimed back by a later load");
});

test("a send held when the page died brings its files back with its text, when the box is drawn", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    void A.sendHeld("fi:h", "never confirmed", [], () => new Promise(() => {}), [LOG]);
    await A.draftsSettled();
    const B = await reload();
    const heard = [];
    B.onDraftRestored((k) => heard.push(k));
    await B.draftsSettled();
    assert.deepEqual(heard, [], "nothing is claimed at load");
    assert.deepEqual(B.loadDraftFiles("fi:h"), []);
    assert.equal(B.loadDraft("fi:h"), "never confirmed");
    assert.deepEqual(B.loadDraftFiles("fi:h"), [LOG]);
    await B.draftsSettled();
    assert.deepEqual(heard, ["fi:h"]);
    const C = await reload();
    await C.draftsSettled();
    assert.deepEqual(C.loadDraftFiles("fi:h"), [LOG], "claimed once, now an ordinary draft");
});

test("UPGRADE: a store written before files existed (images only) loads, with no files and no error", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    A.saveDraftImages("fi:old", [IMG("OLD0")]);
    await A.draftsSettled();
    // Strip the file support's records entirely: nothing about files was ever written, as by the old code.
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftImages("fi:old"), [IMG("OLD0")]);
    assert.deepEqual(B.loadDraftFiles("fi:old"), []);
});

test("a record that is not a file is dropped on restore rather than becoming a broken chip", async () => {
    globalThis.indexedDB = new fake.IDBFactory();
    const A = await reload();
    await A.draftsSettled();
    const db = await new Promise((res, rej) => { const r = indexedDB.open("ml-drafts", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res) => {
        const tx = db.transaction("images", "readwrite");
        tx.objectStore("images").put({ id: "file:fi:bad", key: "fi:bad", imgs: ["not json", JSON.stringify({ name: 3 })], bytes: 20, at: Date.now() });
        tx.oncomplete = () => res();
    });
    db.close();
    const B = await reload();
    await B.draftsSettled();
    assert.deepEqual(B.loadDraftFiles("fi:bad"), []);
});
