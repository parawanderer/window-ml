// redteam-ml-table.test.mjs — an auto-approved survey reads no table its source rule did not allow (#ml.table): the source is
// resolved ONCE, so the kind the ask is decided on is the kind the read uses even for an object the page can shape; a fetch
// result is read from own data properties, never a getter; and the answer is a copy. Source: src/ml/ml-table.ts
// (tableSource, tableSurvey), src/readonly-exec/policy.ts (the facade's `table`), docs/spec/ML_TABLE.md.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { table, tableSource, tableSurvey } from "../src/ml/ml-table.ts";
import { mlFetchCache } from "../src/ml/ml-fetch-cache.ts";
import { derivedFetchFields } from "../src/ml/fetch-result.ts";

const SALES = { columns: ["region", "amount"], rows: [["north", 10], ["south", 20]] };
const CSV_URL = "https://data.example/sales.csv";
const CSV = "region,amount\nnorth,10\nsouth,20\n";
const fetched = (url, text, extra = {}) => {
    const r = { url, status: 200, ok: true, type: "csv", text, contentType: "text/csv", typeByHeader: "csv", typeByContent: "csv", typeByExtension: null, ...extra };
    derivedFetchFields(r, { markdown: () => undefined, python: false });
    return r;
};
/** The host member's `this`: the page-table read a survey may reach. */
const host = () => ({ _resolveTable: () => ({ kind: "rows", columns: [...SALES.columns], rows: SALES.rows.map((r) => [...r]) }) });

// --- the ask and the read are one resolution ---

test("RED TEAM (ml.table): a source the page can shape is resolved once, so what the ask judged is what the read would read", async () => {
    const win = new JSDOM("<!doctype html><body><div id='x'>t</div></body>").window;
    const el = win.document.getElementById("x");
    let n = 0;
    Object.defineProperty(el, "nodeType", { get() { return ++n === 1 ? 1 : 2; }, configurable: true });
    el.url = "https://docs.google.com/spreadsheets/d/EVIL/edit#gid=0";
    el.status = 200;
    el.type = "csv";
    // The survey resolves once: the ask it reports is about the same kind its read would take.
    const s = tableSurvey.call(host(), el);
    assert.match(s.asks ?? "", /Google Sheet/, `an element carrying a Sheets URL was read with a free ask: ${JSON.stringify(s.asks)}`);
    // And two resolutions of that object agree, so no look can decide one kind and a later one another.
    assert.deepEqual(tableSource(el), tableSource(el), "the same object resolved to two kinds");
});

test("RED TEAM (ml.table): positive control: a real element is free to read, and its read is the page table", async () => {
    const win = new JSDOM("<!doctype html><body><table id='sales'><tr><td>north</td><td>10</td></tr></table></body>").window;
    const el = win.document.getElementById("sales");
    const s = tableSurvey.call(host(), el);
    assert.equal(s.asks, null, `a real element asked: ${s.asks}`);
    globalThis.document = win.document;   // elPath names the element by its place in the page
    try {
        const t = await s.read({});
        assert.deepEqual(t.rows[0], SALES.rows[0]);
    } finally { delete globalThis.document; }
});

test("RED TEAM (ml.table): a fetch result is read from its own data properties, so a url getter is never run", async () => {
    let ran = false;
    const src = { get url() { ran = true; return CSV_URL; }, status: 200, type: "csv", text: CSV };
    const k = tableSource(src);
    assert.equal(ran, false, "tableSource ran the page's url getter");
    assert.equal(k.kind, "bad", `a getter url was accepted as a fetch result: ${JSON.stringify(k)}`);
});

// --- the answer is the survey's to edit, and an edit to it reaches nothing ---

test("RED TEAM (ml.table): editing the answer reaches neither the fetch cache nor a second read", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const ml = { ...host(), table };
    const t = await table.call(ml, CSV_URL);
    t.rows[0][1] = 999;
    t.columns.push("x");
    assert.equal((await table.call(ml, CSV_URL)).rows[0][1], 10, "a second read returned the edited copy");
    assert.equal(mlFetchCache.get(CSV_URL).table.rows[0][1], 10, "the cache was edited through the answer");
});
