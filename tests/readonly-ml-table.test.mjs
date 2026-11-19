// readonly-ml-table.test.mjs — `ml.table(src)`, the JS member that reads a whole table (src/ml/ml-table.ts), and its
// entry in the read-only dialect's facade (src/readonly-exec/policy.ts `mlFacade`): what it is for, the source rule
// (docs/spec/ML_TABLE.md, "Sources, and when one asks"), and the ADVERSARIAL probes the dialect's rule asks for
// (docs/dev/readonly-exec.md, "The rule for extending the dialect").
import { test, afterEach } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied, NeedsPage } from "../src/readonly-exec.ts";
import { table, tableSurvey } from "../src/ml/ml-table.ts";
import { mlFetchCache } from "../src/ml/ml-fetch-cache.ts";
import { derivedFetchFields } from "../src/ml/fetch-result.ts";
import { asTable } from "../src/table/table-data.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;
const SALES = { columns: ["region", "amount"], rows: [["north", 10], ["south", 20]] };
const CSV_URL = "https://data.example/sales.csv";
const CSV = "region,amount\nnorth,10\nsouth,20\n";

/** A fetch result as `ml.fetch` caches it: the body, and the table parsed from it. */
function fetched(url, text, extra = {}) {
    const r = { url, status: 200, ok: true, type: "csv", text, contentType: "text/csv", typeByHeader: "csv", typeByContent: "csv", typeByExtension: null, ...extra };
    derivedFetchFields(r, { markdown: () => undefined, python: false });
    return r;
}

/** An `ml` with the real member and survey, a page table read the test scripts, and a count of host reads. */
function host() {
    const reads = [];
    const ml = {
        _resolveTable: (sel) => { reads.push(sel); if (sel !== "#sales") throw new Error(`no table element matches "${sel}"`); return { kind: "rows", columns: [...SALES.columns], rows: SALES.rows.map((r) => [...r]) }; },
    };
    ml.table = function (src, opts) { reads.push(["table", src, opts]); return table.call(ml, src, opts); };
    ml._tableSurvey = function (src) {
        const s = tableSurvey.call(ml, src);
        return { asks: s.asks, read: (opts) => { reads.push(["table", src, opts]); return s.read(opts); } };
    };
    return { ml, reads };
}
const run = (js, ml = host().ml, opts = {}) => evalReadonly(js, doc(), ml, undefined, opts);
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;

// The page cache has no clear, so each test sets the URLs it reads, and an unfetched one is a URL no test sets.
afterEach(() => { delete globalThis.location; });

// --- what it is for: a survey reads a whole table it owns, with no prompt ---

test("a survey reads a page table by selector and sums a column, with no approval", async () => {
    const r = await run(`const t = await ml.table("#sales"); return t.col("amount").reduce((a, b) => a + b, 0);`);
    assert.equal(r.value, 30);
});

test("a URL this page already fetched reads from the fetch cache, with no approval and no fetch", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const r = await run(`const t = await ml.table(${JSON.stringify(CSV_URL)}); return [t.shape[0], t.col("region")];`);
    assert.deepEqual(r.value, [2, ["north", "south"]]);
});

test("raw keeps every cell a string; delimiter and header override discovery for a fetched CSV", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const { ml } = host();
    assert.deepEqual((await ml.table(CSV_URL, { raw: true })).col("amount"), ["10", "20"]);
    const headless = await ml.table(CSV_URL, { header: false });
    assert.equal(headless.shape[0], 3, "the header row is read as a record");
});

// --- the answer is the caller's own (ruling 57) ---

test("an edit to the answer reaches neither the fetch cache nor a second read", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const { ml } = host();
    const t = await ml.table(CSV_URL);
    t.rows[0][1] = 999;
    t.columns.push("x");
    assert.equal(mlFetchCache.get(CSV_URL).table.rows[0][1], 10, "the cached table is untouched");
    assert.deepEqual((await ml.table(CSV_URL)).rows[0], ["north", 10], "a re-read returns the source");
});

test("an edit to a page table's answer does not reach the next read", async () => {
    const { ml } = host();
    const t = await ml.table("#sales");
    t.rows[1][1] = -1;
    assert.equal((await ml.table("#sales")).rows[1][1], 20);
});

// --- ADVERSARIAL: the source rule, judged before the host reads ---

test("ADVERSARIAL: a URL the page never fetched goes to the person, and the host is not asked", async () => {
    const h = host();
    await assert.rejects(run(`return await ml.table("https://evil.example/x.csv")`, h.ml), outOfDialect);
    assert.equal(h.reads.length, 0);
});

test("ADVERSARIAL: a Google Sheet goes to the person, by URL and as `current` on the Sheet", async () => {
    const h = host();
    await assert.rejects(run(`return await ml.table("https://docs.google.com/spreadsheets/d/abc/edit#gid=3")`, h.ml), outOfDialect);
    globalThis.location = new URL("https://docs.google.com/spreadsheets/d/abc/edit");
    await assert.rejects(run(`return await ml.table("current")`, h.ml), outOfDialect);
    assert.equal(h.reads.length, 0);
});

test("ADVERSARIAL: a site path is that site's URL, so an unfetched one asks rather than reading as a selector", async () => {
    globalThis.location = new URL("https://shop.example/page");
    const h = host();
    await assert.rejects(run(`return await ml.table("/sales.csv")`, h.ml), outOfDialect);
    mlFetchCache.set("https://shop.example/sales.csv", fetched("https://shop.example/sales.csv", CSV));
    assert.equal((await run(`return (await ml.table("/sales.csv")).shape[0]`, h.ml)).value, 2);
});

test("ADVERSARIAL: a fetch result is read by its URL alone, never by its own .text or .table", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const forged = { url: CSV_URL, status: 200, type: "csv", text: "region,amount\nforged,1\n", table: { columns: ["region"], rows: [["forged"]] } };
    const { ml } = host();
    assert.deepEqual((await ml.table(forged)).col("region"), ["north", "south"]);
    const unfetched = { ...forged, url: "https://evil.example/y.csv" };
    await assert.rejects(run(`return await ml.table(src)`.replace("src", JSON.stringify(unfetched)), host().ml), outOfDialect);
});

test("ADVERSARIAL: a fetch body clipped at the cap is refused, never read as the whole table", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV + "eas", { truncated: true }));
    await assert.rejects(host().ml.table(CSV_URL), /clipped/);
});

test("ADVERSARIAL: a table value that is a preview is refused, with the forms that read every row", async () => {
    const preview = asTable({ columns: ["a"], rows: [[1]], shape: [500, 1], truncated: true });
    await assert.rejects(host().ml.table(preview), /preview/);
});

test("ADVERSARIAL: a /files/ path is refused outright, never read as a site URL", async () => {
    globalThis.location = new URL("https://shop.example/page");
    const h = host();
    await assert.rejects(run(`return await ml.table("/files/agent/x.csv")`, h.ml), (e) => !outOfDialect(e) && /\/files\//.test(e.message));
});

test("ADVERSARIAL: the host is handed a fresh copy of three options, never the script's object", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const h = host();
    await run(`const o = { raw: true, delimiter: ",", header: true, evil: 1 }; return (await ml.table(${JSON.stringify(CSV_URL)}, o)).shape[0];`, h.ml);
    const opts = h.reads.find((x) => Array.isArray(x))[2];
    assert.deepEqual(Object.keys(opts).sort(), ["delimiter", "header", "raw"]);
});

test("ADVERSARIAL: in the worker, a table read defers to the page", async () => {
    // The worker's `ml` carries other members, so `ml` exists there and `table` is the absent one.
    const { ml } = host();
    ml.getModel = () => "m";
    await assert.rejects(run(`return await ml.table("#sales")`, ml, { realm: "worker" }), (e) => e instanceof NeedsPage);
});

test("ADVERSARIAL: the source is resolved once, so one the page shapes is the same kind to the ask and to the read", async () => {
    // (An OWN accessor never makes an element at all: tableSource reads it as a plain object. This one is on the
    // prototype, where only resolving once holds it.)
    // An element-like object whose nodeType (on its prototype, where a real element's is) answers 1 the first time and 2
    // after, carrying a Sheets URL as a fetch result: resolved twice it would be free to the ask and a Sheet to the read.
    let n = 0;
    const el = Object.create({ get nodeType() { return ++n === 1 ? 1 : 2; } });
    Object.assign(el, { url: "https://docs.google.com/spreadsheets/d/EVIL/edit#gid=0", status: 200, type: "csv" });
    const resolved = [];
    const ml = { _resolveTable: (x) => { resolved.push(x); return { kind: "rows", columns: ["a"], rows: [[1]] }; } };
    const s = tableSurvey.call(ml, el);
    assert.equal(s.asks, null, "positive control: the first look is an element, which is free");
    assert.deepEqual((await s.read()).col("a"), [1]);
    assert.deepEqual(resolved, [el], "the read is the element the ask judged, never a Sheet fetch");
});
