// secrets-section.test.mjs — the Settings "Secrets" page (src/sidebar/settings/secrets-section.tsx): the registered names and
// the count, an add that is validated on the page, sent once and never echoed, and a remove by name. The worker's side of
// `SECRET_REGISTRY` is tests/secret-registry.test.mjs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, M, doc;
const sent = [];
let names = ["GITHUB_TOKEN", "DB_PASSWORD"];
let answer = (p) => {
    if (p.op === "add") names = [...names.filter((n) => n !== p.name), p.name];
    if (p.op === "remove") names = names.filter((n) => n !== p.name);
    return { data: { names: [...names], count: names.length } };
};
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.chrome = {
        runtime: { lastError: undefined, sendMessage: (msg, cb) => { sent.push(structuredClone(msg)); cb(answer(msg.payload)); } },
        storage: { onChanged: { addListener() {}, removeListener() {} } },
    };
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    M = await import("../src/sidebar/settings/secrets-section.tsx");
});

const tick = () => new Promise((r) => setTimeout(r, 40));
async function waitFor(fn, ms = 2000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v || Date.now() >= deadline) return v;
        await new Promise((r) => setTimeout(r, 25));
    }
}
async function show() {
    names = ["GITHUB_TOKEN", "DB_PASSWORD"];
    const host = doc.getElementById("root");
    render(null, host);
    sent.length = 0;
    render(h(M.SecretsSectionBody, {}), host);
    await waitFor(() => host.querySelector(".secrets-add"));
    return host;
}
const type = (el, value) => { el.value = value; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const addBtn = (host) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Add");
const VALUE = "s3cr3t-VALUE-xyz";

// --- the list ---

test("the list shows each registered name and the count against the cap", async () => {
    const host = await show();
    assert.deepEqual([...host.querySelectorAll(".secrets-row")].map((r) => r.dataset.secretName), ["GITHUB_TOKEN", "DB_PASSWORD"]);
    assert.match(host.querySelector(".secrets-count").textContent, /2 of 64/);
    const v = host.querySelector(".secrets-value");
    assert.equal(v.type, "password");
    assert.equal(v.getAttribute("autocomplete"), "off");
});

// --- add ---

test("add sends name and value, then clears the value field, and the value is nowhere in the page", async () => {
    const host = await show();
    type(host.querySelector(".secrets-name"), "NEW_KEY");
    type(host.querySelector(".secrets-value"), VALUE);
    await tick();
    addBtn(host).click();
    await tick();
    assert.deepEqual(sent.at(-1).payload, { op: "add", name: "NEW_KEY", value: VALUE });
    assert.equal(host.querySelector(".secrets-value").value, "");
    assert.ok(host.querySelector('[data-secret-name="NEW_KEY"]'));
    assert.ok(!doc.body.textContent.includes(VALUE));
    assert.ok(!doc.body.innerHTML.includes(VALUE));
});

test("a worker refusal is shown and the value field is cleared all the same", async () => {
    const host = await show();
    const prev = answer;
    answer = () => ({ error: "no room" });
    type(host.querySelector(".secrets-name"), "NEW_KEY");
    type(host.querySelector(".secrets-value"), VALUE);
    await tick();
    addBtn(host).click();
    await tick();
    answer = prev;
    assert.match(host.querySelector(".secrets-err").textContent, /no room/);
    assert.equal(host.querySelector(".secrets-value").value, "");
    assert.ok(!doc.body.innerHTML.includes(VALUE));
});

test("an invalid name or a short value is refused on the page with its reason, nothing sent, value cleared", async () => {
    const host = await show();
    type(host.querySelector(".secrets-name"), "lower-case");
    type(host.querySelector(".secrets-value"), VALUE);
    await tick();
    addBtn(host).click();
    await tick();
    assert.equal(sent.length, 1, "only the initial read was sent");
    assert.match(host.querySelector(".secrets-err").textContent, /A-Z, 0-9 and _/);
    assert.equal(host.querySelector(".secrets-value").value, "");
    assert.equal(host.querySelector(".secrets-name").value, "lower-case", "the name is not rewritten");
    type(host.querySelector(".secrets-name"), "GOOD_NAME");
    type(host.querySelector(".secrets-value"), "short");
    await tick();
    addBtn(host).click();
    await tick();
    assert.equal(sent.length, 1);
    assert.match(host.querySelector(".secrets-err").textContent, /characters/);
    assert.ok(!doc.body.innerHTML.includes(VALUE));
});

// --- remove ---

test("remove sends the name", async () => {
    const host = await show();
    host.querySelector('[data-secret-name="GITHUB_TOKEN"] button').click();
    await tick();
    assert.deepEqual(sent.at(-1).payload, { op: "remove", name: "GITHUB_TOKEN" });
    assert.equal(host.querySelector('[data-secret-name="GITHUB_TOKEN"]'), null);
});
