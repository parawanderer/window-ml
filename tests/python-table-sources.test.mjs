// python-table-sources.test.mjs — how a `tables` source string becomes a table: a path on the page's site is the URL
// fetch_url read there, looked up in the page's fetch cache (which stays the gate: nothing is fetched here).
import test from "node:test";
import assert from "node:assert";

const { _loadTable } = await import("../src/ml/ml-python.ts");
const { mlFetchCache } = await import("../src/ml/ml-fetch-cache.ts");

const onPage = (href) => { globalThis.location = new URL(href); };
const cacheCsv = (url) => mlFetchCache.set(url, { ok: true, url, type: "csv", table: { columns: ["amount"], rows: [[1], [2]] } });

// --- a path on this page's site ---

test("a path ('/sales.csv', './sales.csv') loads the table fetch_url read at that URL on the page's site", async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage("http://site.test/step3");
    cacheCsv("http://site.test/sales.csv");
    for (const src of ["/sales.csv", "./sales.csv"]) {
        const loaded = await _loadTable.call({}, "df", src);
        assert.equal(loaded.source.kind, "fetch", src);
        assert.deepEqual(loaded.data.rows, [[1], [2]], src);
    }
});

test("a path the page never fetched is refused from the cache, never fetched or read as a selector", async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage("http://site.test/step3");
    await assert.rejects(_loadTable.call({}, "df", "/never.csv"), (e) => /"http:\/\/site\.test\/never\.csv" is not in this page's fetch cache/.test(e.message) && !/CSS selector/.test(e.message));
});

test("off a web page (an extension page) a path is not resolved against it", async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage("chrome-extension://abcdef/chat.html");
    cacheCsv("chrome-extension://abcdef/sales.csv");
    await assert.rejects(_loadTable.call({ _queryAll: () => [] }, "df", "/sales.csv"), (e) => !/fetch cache/.test(e.message));
});

// --- a map key that is not a Python variable name ---

test("a non-identifier key loads under a name derived from it, and stays reachable by the key itself", async () => {
    const { derivedTableName, tableSpecs } = await import("../src/ml/ml-python.ts");
    const none = new Set();
    for (const [key, want] of [
        ["http://site.test/sales.csv", "sales"],          // GLM keyed the map by the URL it fetched
        ["/data/2024 report.csv?x=1", "_2024_report"],
        ["2bad", "_2bad"],
        ["my sales", "my_sales"],
        ["http://site.test/img.csv", "img_2"],            // `img` is preloaded: never shadowed
        ["???", "___"],
    ]) assert.equal(derivedTableName(key, none), want, key);
    assert.equal(derivedTableName("http://a/sales.csv", new Set(["sales"])), "sales_2", "a name taken in the same call");
    const url = "http://site.test/sales.csv";
    assert.deepEqual(tableSpecs({ [url]: url, ok: "#t" }), [{ name: "sales", src: url, alias: url }, { name: "ok", src: "#t" }]);
    assert.throws(() => tableSpecs({ pd: "#t" }), /reserved/, "a reserved name is still refused");
});
