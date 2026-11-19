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

// --- a path and a selector told apart: one rule, the same answer on the page and in the worker ---

test("sitePathUrl: a path starts with /, ./ or ../ and resolves on the page's origin; everything else is not one", async () => {
    const { sitePathUrl } = await import("../src/ml/ml-python.ts");
    const page = "http://site.test/a/step3";
    for (const [src, want] of [
        ["/sales.csv", "http://site.test/sales.csv"],
        ["./sales.csv", "http://site.test/a/sales.csv"],
        ["../sales.csv", "http://site.test/sales.csv"],
        ["/../../../x.csv", "http://site.test/x.csv"],          // dot segments stop at the root: never another origin
        ["/data/2024 report.csv?x=1", "http://site.test/data/2024%20report.csv?x=1"],
        ["//evil.test/x.csv", null],                            // protocol-relative: another host
        ["/\\evil.test/x.csv", null],                           // the URL parser reads `\` as `/`: off-origin, refused
        ["x.csv", null],                                        // a selector: element x, class csv
        ["sales", null], ["#sales", null], ["table#sales", null], [".sales", null], ["current", null],
        ["http://site.test/sales.csv", null],                  // already a URL: the caller's own branch
        ["", null],
    ]) assert.equal(sitePathUrl(src, page), want, src);
    assert.equal(sitePathUrl("/sales.csv", "chrome-extension://abcdef/chat.html"), null, "an extension page is not a site");
    assert.equal(sitePathUrl("/sales.csv", "about:blank"), null);
    assert.equal(sitePathUrl("/sales.csv", "not a url"), null);
});

test("the page's loader and the worker's give the same answer for the same source, path or selector", async (t) => {
    t.after(() => { delete globalThis.location; });
    const { workerTable } = await import("../src/sw/worker-tools.ts");
    const page = "http://site.test/a/step3";
    onPage(page);
    const fetched = "http://site.test/sales.csv";
    const table = { columns: ["amount"], rows: [[1], [2]] };
    mlFetchCache.set(fetched, { ok: true, url: fetched, type: "csv", table });
    const dom = { kind: "rows", columns: ["dom"], rows: [["x"]] };
    /** The DOM reader both hosts end at: one table under `#sales`, and a selector error for anything else. */
    const readDom = (sel) => { if (sel === "#sales") return dom; throw new Error(`"${sel}" is not a valid CSS selector`); };
    const ctx = { tabId: 1, tabUrl: () => page, cache: new Map([[fetched, { ok: true, url: fetched, type: "csv", table }]]),
        media: { table: async (sel) => ({ label: sel, data: readDom(sel) }) } };
    /** What a loader did with the source, in words the two hosts share. */
    const outcome = async (load) => {
        try {
            const r = await load();
            return `${r.source.kind}:${r.data.columns[0]}`;
        } catch (e) {
            const url = /"(https?:\/\/[^"]+)"/.exec(e.message)?.[1];
            if (/fetch cache|among this run's fetches/.test(e.message)) return `not fetched:${url}`;
            if (/CSS selector/.test(e.message)) return "selector error";
            return `other: ${e.message}`;
        }
    };
    for (const [src, want] of [
        ["/sales.csv", "fetch:amount"],
        ["../sales.csv", "fetch:amount"],
        [fetched, "fetch:amount"],
        ["./sales.csv", "not fetched:http://site.test/a/sales.csv"],
        ["/never.csv", "not fetched:http://site.test/never.csv"],
        ["#sales", "dom:dom"],
        ["x.csv", "selector error"],
    ]) {
        const onPage_ = await outcome(() => _loadTable.call({ _resolveTable: (sel) => readDom(sel) }, "df", src));
        const inWorker = await outcome(() => workerTable(ctx, "df", src, false));
        assert.equal(onPage_, want, `page: ${src}`);
        assert.equal(inWorker, want, `worker: ${src}`);
    }
});
