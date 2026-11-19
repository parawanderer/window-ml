// redteam-ml-table.test.mjs — an auto-approved survey reads no table its source rule did not allow (#ml.table): the kind the
// ask is decided on is the kind the read uses, a source's own getters are never run to decide it, and the answer is a value
// the survey cannot write back. Source: src/ml/ml-table.ts (tableSource, tableSourceAsks), src/readonly-exec/policy.ts (the
// facade's `table`), docs/spec/ML_TABLE.md, "Sources, and when one asks", "Ownership".
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { table, tableSource, tableSourceAsks } from "../src/ml/ml-table.ts";
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
function host() {
    const reads = [];
    const ml = {
        _resolveTable: (sel) => { reads.push(sel); return { kind: "rows", columns: [...SALES.columns], rows: SALES.rows.map((r) => [...r]) }; },
        _tableAsks: (src) => tableSourceAsks(tableSource(src)),
    };
    ml.table = function (src, opts) { reads.push(["table", src, opts]); return table.call(ml, src, opts); };
    return { ml, reads };
}

// --- the ask and the read must be about the same source ---

test("RED TEAM (ml.table): the kind the ask is decided on is the kind the read uses, for a source the page can shape", {
    todo: "tableSourceAsks(tableSource(src)) runs once for the ask and table() runs it again: a page element whose nodeType accessor answers 1 the first time and 2 after, with expandos url/status/type, reads as an element (free) to the ask and as a Google Sheet to the read, so FETCH_SHEET runs with no card",
}, async () => {
    const win = new JSDOM("<!doctype html><body><div id='x'>t</div></body>").window;
    const el = win.document.getElementById("x");
    let n = 0;
    Object.defineProperty(el, "nodeType", { get() { return ++n === 1 ? 1 : 2; }, configurable: true });
    el.url = "https://docs.google.com/spreadsheets/d/EVIL/edit#gid=0";
    el.status = 200;
    el.type = "csv";
    const asked = tableSource(el);
    assert.equal(tableSourceAsks(asked), null, "positive control: the first look is free");
    const read = tableSource(el);
    assert.deepEqual(read, asked, `the read resolved the source to ${read.kind} after the ask decided on ${asked.kind}`);
});

test("RED TEAM (ml.table): a fetch result is read from its own data properties, so a url getter is never run", async () => {
    let ran = false;
    const src = { get url() { ran = true; return CSV_URL; }, status: 200, type: "csv", text: CSV };
    const k = tableSource(src);
    assert.equal(ran, false, "tableSource ran the page's url getter");
    assert.equal(k.kind, "bad", `a getter url was accepted as a fetch result: ${JSON.stringify(k)}`);
});

// --- the answer is the survey's to edit, and an edit to it reaches nothing ---

test("RED TEAM (ml.table): editing the answer reaches neither the page table nor a second read", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const { ml } = host();
    const t = await ml.table(CSV_URL);
    t.rows[0][1] = 999;
    t.columns.push("x");
    assert.equal((await ml.table(CSV_URL)).rows[0][1], 10, "a second read returned the edited copy");
    assert.equal(mlFetchCache.get(CSV_URL).table.rows[0][1], 10, "the cache was edited through the answer");
});
