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
