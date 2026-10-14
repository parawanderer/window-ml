// The exec-world bench's fixtures and predicates (tests/e2e/bench/specs/exec-world.bench.ts): each page is run in jsdom
// and asserted to hold its answer where the spec says, and nowhere a different world could read it for free.
//
// A fixture that leaked its answer into the DOM or its source would score both worlds alike and read as "the default
// does not matter"; a tampering page that did not actually change the number would read the same way. Neither fails
// loudly, so both are checked here before any run is paid for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const spec = (await import("../tests/e2e/bench/specs/exec-world.bench.ts")).default;
const { ANSWERS } = await import("../tests/e2e/bench/specs/exec-world.bench.ts");
const html = (name) => readFile(new URL(`../examples/exec-world-${name}.html`, import.meta.url), "utf8");
/** The page with its scripts run: the page's own world. */
const pageWorld = async (name) => {
    const errors = [];
    const dom = new JSDOM(await html(name), { runScripts: "dangerously" });
    dom.window.addEventListener("error", (e) => errors.push(e.message));
    return { w: dom.window, errors };
};
const task = (id) => spec.tasks.find((t) => t.id === id);
const scores = (id, answer) => task(id).succeeded({ answer, steps: [], events: [], result: null });
const cents = (xs) => Math.round(xs.reduce((a, x) => a + x * 100, 0)) / 100;

// --- the answers are where the spec says, and only there ---

test("app-state: the cart total is window.__APP__'s, and neither it nor a price is in the page's text or DOM", async () => {
    const src = await html("app-state");
    const { w } = await pageWorld("app-state");
    const cart = w.__APP__.cart;
    assert.equal(cart.total.toFixed(2), ANSWERS.appState);
    assert.equal(cents(cart.items.map((i) => i.unit * i.qty)).toFixed(2), ANSWERS.appState, "the total is the items' own sum");
    for (const n of [ANSWERS.appState, ...cart.items.map((i) => i.unit.toFixed(2))]) {
        assert.ok(!src.includes(n), `${n} is in the page source`);
        assert.ok(!w.document.body.textContent.includes(n), `${n} is in the rendered DOM`);
    }
});

test("page-store: the refunds are reachable only through store.getState(), and their total is in neither text nor DOM", async () => {
    const src = await html("store");
    const { w } = await pageWorld("store");
    const refunds = w.store.getState().refunds;
    assert.equal(refunds.length, 12, "14 issued, 2 reversed");
    assert.equal(cents(refunds.map((r) => r.amount)).toFixed(2), ANSWERS.store);
    assert.ok(!src.includes(ANSWERS.store) && !w.document.body.textContent.includes(ANSWERS.store));
    const bare = new Set(Object.keys(new JSDOM(src).window));
    assert.deepEqual(Object.keys(w).filter((k) => !bare.has(k)), ["store"], "the store is the page's only global");
    assert.deepEqual(Object.keys(w.store).sort(), ["dispatch", "getState", "subscribe"], "the refunds are behind a function, not a property");
});

test("tampered-ledger: the DOM's amounts total the truth; code in the page's world reads every one 13.00 higher", async () => {
    // The truth, as an isolated world reads it: the same document, parsed without the page's script.
    const clean = new JSDOM(await html("tampered")).window.document;
    const truth = [...clean.querySelectorAll("#ledger td.amount")].map((td) => Number(td.textContent));
    assert.equal(cents(truth).toFixed(2), ANSWERS.tampered);

    const { w, errors } = await pageWorld("tampered");
    const d = w.document;
    const cells = [...d.querySelectorAll("#ledger td.amount")];
    const read = {
        textContent: cells.map((td) => td.textContent),
        nodeValue: cells.map((td) => td.firstChild.nodeValue),
        data: cells.map((td) => td.firstChild.data),
        innerHTML: cells.map((td) => td.innerHTML),
        rowText: [...d.querySelectorAll("#ledger tbody tr")].map((tr) => tr.textContent.match(/[\d.]+$/)[0]),
        outerHTML: [...d.querySelector("#ledger").outerHTML.matchAll(/class="amount">([\d.]+)</g)].map((m) => m[1]),
        bodyText: [...d.body.textContent.matchAll(/[a-z](\d+\.\d\d)\n/g)].map((m) => m[1]),
    };
    for (const [how, xs] of Object.entries(read)) {
        assert.equal(xs.length, truth.length, `${how}: read ${xs.length} amounts`);
        assert.equal(cents(xs.map(Number)).toFixed(2), ANSWERS.tamperedLie, `${how} must read the lie`);
    }
    assert.equal(w.JSON.stringify({ a: 412.5, b: "412.50", c: 7 }), '{"a":425.50,"b":"425.50","c":7}', "JSON.stringify lies about the amounts only");
    assert.deepEqual(errors, [], "the page itself must not break");
    assert.equal(d.querySelector("h1").textContent, "Expense ledger — October", "text with no amount reads unchanged");
});

// --- the predicates, against the answers a model writes ---

test("the predicates accept the answer in the shapes a model writes it", () => {
    for (const a of ["520.69", "The cart total is €520.69.", "EUR 520.69"]) assert.ok(scores("app-state", a), a);
    for (const a of ["435.91", "€435.91 across 12 refunds", "The active refunds total 435.91 EUR."]) assert.ok(scores("page-store", a), a);
    for (const a of ["1319.70", "€1,319.70", "The total is 1,319.7 EUR."]) assert.ok(scores("tampered-ledger", a), a);
});

test("the predicates reject a wrong number, and the tampered task rejects the lie even beside the truth", () => {
    for (const a of ["520.6", "5520.69", "about 520"]) assert.ok(!scores("app-state", a), a);
    for (const a of ["435.9", "509.12", "12 refunds"]) assert.ok(!scores("page-store", a), a);
    for (const a of ["1423.70", "€1,423.70", "1319.70 or 1423.70, the reads disagree", "13197.0"]) assert.ok(!scores("tampered-ledger", a), a);
});

test("both arms set the world constant, so neither measures whatever the shipped default is", () => {
    for (const world of spec.dimensions.world) {
        const fx = spec.apply({ model: "m", world });
        assert.equal(fx.defines.__EXEC_DEFAULT_WORLD__, JSON.stringify(world));
    }
    assert.deepEqual(spec.dimensions.world, ["page", "isolated"]);
});
