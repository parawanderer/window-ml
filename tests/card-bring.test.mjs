// The HUD's "bring a session here" list (src/sidebar/card/card-bring.tsx): a running session is marked, and a queued move
// is told to the person as information while the list stays up. What the worker offers is tested in tests/move-run.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, M, services, doc, ext;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    const win = dom.window; doc = win.document;
    globalThis.window = win; globalThis.document = doc; globalThis.Node = win.Node;
    globalThis.chrome = { storage: { sync: {}, local: {}, session: {} }, runtime: { sendMessage: (_m, cb) => cb({ error: "no worker in this test" }) } };
    ({ h, render } = require_("preact"));
    services = await import("../src/sidebar/services.ts");
    ext = (await import("../src/sidebar/services-ext.ts")).extensionServices;
    M = await import("../src/sidebar/card/card-bring.tsx");
});
after(() => services.installServices(ext));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const root = () => doc.getElementById("root");
const ROWS = [
    { hash: "a1", title: "Settled one", url: "https://a.example/x", lastTs: 1000, held: true },
    { hash: "b2", title: "Running one", url: "https://b.example/y", lastTs: 2000, held: true, running: true },
];
async function mountList(answer) {
    services.installServices({ ...ext, bringHere: async () => answer });
    let done = 0;
    render(null, root());
    render(h(M.BringHereList, { rows: ROWS, now: 5000, onBack() {}, onDone() { done++; } }), root());
    await tick();
    return { done: () => done, row: (title) => [...root().querySelectorAll(".card-bring-row")].find((b) => b.textContent.includes(title)) };
}

// --- a running session in the list, and a queued move ---

test("a running row says it is running, a settled one does not", async () => {
    const l = await mountList({ ok: true });
    assert.match(l.row("Running one").textContent, /running/);
    assert.doesNotMatch(l.row("Settled one").textContent, /running/);
});

test("a queued answer shows the worker's sentence, no error, keeps the list open and ends the card after about 2.5 s", async () => {
    const SENTENCE = "The session is running: it moves to this tab when its current step ends.";
    const l = await mountList({ ok: true, queued: SENTENCE });
    l.row("Running one").click();
    await tick();
    assert.ok(root().textContent.includes(SENTENCE), "the sentence is shown");
    assert.equal(root().querySelector(".card-cmp-err"), null, "it is not an error");
    assert.ok(root().querySelector(".card-bring-list"), "the list stays open");
    assert.equal(l.done(), 0, "not done yet");
    await tick(2700);
    assert.equal(l.done(), 1, "done after the sentence was readable");
});

test("an immediate move calls onDone at once; a refusal shows the error and not done", async () => {
    let l = await mountList({ ok: true });
    l.row("Settled one").click(); await tick();
    assert.equal(l.done(), 1);
    l = await mountList({ error: "nope" });
    l.row("Settled one").click(); await tick();
    assert.equal(l.done(), 0);
    assert.equal(root().querySelector(".card-cmp-err").textContent, "nope");
});

// --- the extension's own seam: MOVE_RUN's answer, as the list reads it ---

test("the extension's bringHere passes the worker's queued sentence through, and a plain move or a refusal as before", async () => {
    const answer = (resp) => { globalThis.chrome.runtime.sendMessage = (_m, cb) => cb(resp); return ext.bringHere("a1"); };
    assert.deepEqual(await answer({ data: { queued: "later" } }), { ok: true, queued: "later" });
    assert.deepEqual(await answer({ data: true }), { ok: true });
    assert.deepEqual(await answer({ error: "no" }), { error: "no" });
});
