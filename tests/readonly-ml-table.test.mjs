// readonly-ml-table.test.mjs — `ml.table(src)`, the JS member that reads a whole table (src/ml/ml-table.ts), and its
// entry in the read-only dialect's facade (src/readonly-exec/policy.ts `mlFacade`): what it is for, the source rule
// (docs/spec/ML_TABLE.md, "Sources, and when one asks"), and the ADVERSARIAL probes the dialect's rule asks for
// (docs/dev/readonly-exec.md, "The rule for extending the dialect").
import { test, afterEach, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied, NeedsPage } from "../src/readonly-exec.ts";
import { table, tableSurvey } from "../src/ml/ml-table.ts";
import { mlFetchCache } from "../src/ml/ml-fetch-cache.ts";
import { derivedFetchFields, cacheCopy } from "../src/ml/fetch-result.ts";
import { asTable } from "../src/table/table-data.ts";
import { READ_ONLY_TABLE, isStoredTable, isFrozenTablePart } from "../src/table/table-brand.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;
const SALES = { columns: ["region", "amount"], rows: [["north", 10], ["south", 20]] };
const CSV_URL = "https://data.example/sales.csv";
const CSV = "region,amount\nnorth,10\nsouth,20\n";

/** A fetch result as `ml.fetch` caches it: the body, and the table parsed from it, through the cache's own copy. */
function fetched(url, text, extra = {}) {
    return cacheCopy(fetchedRaw(url, text, extra));
}
/** A fetch result as `ml.fetch` builds it, before it is cached. */
function fetchedRaw(url, text, extra = {}) {
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

// --- read-only where something else holds the table (ruling 57, as amended 2026-11-20) ---

/** The four parts of a table, each frozen, and a write to each refused: in strict code a write throws. */
function assertReadOnly(t, what) {
    for (const [name, part] of [["rows", t.rows], ["a row", t.rows[0]], ["columns", t.columns], ["shape", t.shape], ["dtypes", t.dtypes]])
        assert.ok(Object.isFrozen(part), `${what}: ${name} is frozen`);
    assert.throws(() => { t.rows[0][1] = 999; }, TypeError, `${what}: a cell write throws`);
    assert.throws(() => { t.rows.push(["x", 0]); }, TypeError, `${what}: a row push throws`);
    assert.throws(() => { t.columns.push("x"); }, TypeError, `${what}: a column push throws`);
    assert.throws(() => { t.shape[0] = 1; }, TypeError, `${what}: a shape write throws`);
    assert.throws(() => { t.dtypes.amount = "object"; }, TypeError, `${what}: a dtypes write throws`);
    assert.throws(() => { t.rows = []; }, (e) => e.message === READ_ONLY_TABLE, `${what}: the facade names the way out`);
}

/** An `ml` whose `dereference` answers `ref` with `table`, as a run's pointer would. */
function pointerHost(table) {
    const { ml } = host();
    ml.dereference = async () => ({ value: "", table });
    return ml;
}
const stored = () => {
    const reads = [];
    const t = asTable({ columns: ["region", "amount"], rows: [["north", 10], ["south", 20]], shape: [4, 2], dtypes: { region: "object", amount: "int64" }, truncated: true },
        { readColumns: async (names) => { reads.push(names); return { rowCount: 4, columns: Object.fromEntries(names.map((n) => [n, n === "region" ? ["north", "south", "east", "west"] : [10, 20, 30, 40]])) }; } });
    return { t, reads };
};

test("every source something else holds answers read-only at every level: a fetched URL, a fetch result, a pointer's whole table, a stored table", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const { ml } = host();
    assertReadOnly(await ml.table(CSV_URL), "a fetched URL");
    assertReadOnly(await ml.table(mlFetchCache.get(CSV_URL)), "a fetch result");
    const whole = { columns: ["region", "amount"], rows: [["north", 10], ["south", 20]], shape: [2, 2], dtypes: { region: "object", amount: "int64" } };
    assertReadOnly(await table.call(pointerHost(whole), "@tool:abc"), "a pointer's whole table");
    assertReadOnly(await table.call(pointerHost(stored().t), "@tool:abc"), "a stored table");
});

test("ml.fetch's own table is read-only from the first read, and an edit attempt leaves the cache's next answer unchanged", () => {
    const r = fetchedRaw(CSV_URL, CSV);
    const cached = cacheCopy(r);
    assert.equal(r.table, cached.table, "the caller and the cache hold the one table");
    assertReadOnly(r.table, "the caller's ml.fetch result");
    assert.throws(() => { r.table.rows[0][1] = 999; }, TypeError);
    assert.deepEqual(cached.table.rows[0], ["north", 10], "the cache's next answer is unchanged");
});

test("a read-only answer is not copied: two reads of one source share its rows", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const { ml } = host();
    assert.equal((await ml.table(CSV_URL)).rows, (await ml.table(CSV_URL)).rows);
    const s = stored().t;
    const p = pointerHost(s);
    assert.equal((await table.call(p, "@tool:abc")).rows, s.rows, "a stored table's answer is over the store's own preview, frozen");
});

test("select and head of a read-only table are read-only too", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const t = await host().ml.table(CSV_URL);
    for (const [what, d] of [["select", t.select(["region", "amount"])], ["head", t.head(1)]]) {
        assert.ok(Object.isFrozen(d.rows) && Object.isFrozen(d.rows[0]) && Object.isFrozen(d.columns), `${what} is frozen`);
        assert.throws(() => { d.rows[0][0] = "x"; }, TypeError, `${what}: a cell write throws`);
    }
});

test("copy() is editable and independent: an edit reaches neither the source, the cache, nor a second copy", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const t = await host().ml.table(CSV_URL);
    const a = t.copy(), b = t.copy();
    a.rows[0][1] = 999; a.rows.push(["east", 30]); a.columns.push("x");
    assert.deepEqual(t.rows[0], ["north", 10], "the source");
    assert.deepEqual(mlFetchCache.get(CSV_URL).table.rows, [["north", 10], ["south", 20]], "the cache");
    assert.deepEqual(b.rows, [["north", 10], ["south", 20]], "a second copy");
    assert.deepEqual(b.columns, ["region", "amount"]);
    const h = a.head(1), sel = a.select(["amount"]);
    h.rows[0][0] = "y"; sel.rows[0][0] = -1;
    assert.equal(h.rows[0][0], "y", "a copy's head is editable");
    assert.equal(sel.rows[0][0], -1, "a copy's select is editable");
});

test("copy() of a stored table copies only the rows in hand and still reads every row from the store", async () => {
    const { t, reads } = stored();
    const c = (await table.call(pointerHost(t), "@tool:abc")).copy();
    assert.ok(isStoredTable(c), "the copy keeps the store reader");
    assert.equal(c.rows.length, 2, "only the preview is copied");
    assert.notEqual(c.rows, t.rows);
    c.rows[0][1] = 999;
    assert.equal(t.rows[0][1], 10, "the store's preview is untouched");
    assert.deepEqual(await c.col("amount"), [10, 20, 30, 40], "col() reads every row");
    assert.deepEqual(reads, [["amount"]]);
});

test("in the dialect: a write to a read-only table is refused with the way out, and a copy is the script's to edit", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const u = JSON.stringify(CSV_URL);
    for (const js of [`const t = await ml.table(${u}); t.rows[0][1] = 999; return 1;`, `const t = await ml.table(${u}); t.rows.push(["x", 1]); return 1;`,
        `const t = await ml.table(${u}); t.columns.push("x"); return 1;`, `const t = await ml.table(${u}); t.head(1).rows[0][0] = "x"; return 1;`]) {
        const err = await run(js).then(() => null, (e) => e);
        assert.ok(err, js);
        assert.equal(err.message, READ_ONLY_TABLE, js);
    }
    const r = await run(`const c = (await ml.table(${u})).copy(); c.rows[0][1] = 999; c.rows.push(["east", 30]); return [c.rows[0][1], c.rows.length];`);
    assert.deepEqual(r.value, [999, 3]);
    assert.deepEqual(mlFetchCache.get(CSV_URL).table.rows[0], ["north", 10], "the cache is untouched by the copy's edit");
});

// --- the caller's own where nothing else holds it: editable, with no copy (ruling 89) ---

test("a table read for this call alone is editable and not frozen: a page table, and a fetched CSV parsed with options", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const { ml } = host();
    for (const [what, t] of [["a page table", await ml.table("#sales")], ["a parse with raw", await ml.table(CSV_URL, { raw: true })]]) {
        assert.ok(!Object.isFrozen(t.rows) && !Object.isFrozen(t.rows[0]) && !Object.isFrozen(t.columns), `${what} is not frozen`);
        t.rows[0][1] = 999; t.rows.push(["east", 30]);
        assert.equal(t.rows[0][1], 999, what);
    }
    assert.deepEqual(mlFetchCache.get(CSV_URL).table.rows[0], ["north", 10], "a parse with options never reaches the cache's table");
});

/** The service worker's end of the page channel, for a Sheet read: answers each FETCH_SHEET_REQUEST with `csv`, and records the URLs asked. */
function sheetWorker(csv) {
    const asked = [];
    let far = null;
    globalThis.window = { dispatchEvent: (e) => { far = e.ports[0]; return true; } };
    return import("../src/page-channel.ts").then(({ toIsolated }) => {
        toIsolated({ type: "PING" });   // opens the main side, which hands its far port to the window above
        far.onmessage = (e) => {
            if (e.data?.type !== "FETCH_SHEET_REQUEST") return;
            asked.push(e.data.payload.url);
            far.postMessage({ type: "FETCH_SHEET_RESPONSE", requestId: e.data.requestId, result: { csv, name: "Sales" } });
        };
        return { asked, close: () => far.close() };
    });
}

test("a Google Sheet's table is parsed for this call alone: editable, not frozen, and a second read does not see the first's edit", async () => {
    const worker = await sheetWorker("a,b\n1,2\n3,4\n");
    after(() => { worker.close(); delete globalThis.window; });
    const SHEET = "https://docs.google.com/spreadsheets/d/abc/edit#gid=3";
    const { ml } = host();
    const t = await ml.table(SHEET);
    assert.equal(worker.asked.length, 1, "the page channel was asked once, for the Sheet's CSV export");
    assert.match(worker.asked[0], /docs\.google\.com\/spreadsheets\/d\/abc\/export\?/);
    assert.deepEqual(t.columns, ["a", "b"]);
    assert.deepEqual(t.rows, [[1, 2], [3, 4]]);
    for (const [name, part] of [["rows", t.rows], ["a row", t.rows[0]], ["columns", t.columns]]) {
        assert.ok(!Object.isFrozen(part), `${name} is not frozen`);
        assert.ok(!isFrozenTablePart(part), `${name} is not a frozen table part`);
    }
    t.rows[0][1] = 999; t.rows.push([5, 6]); t.columns.push("c");
    assert.equal(t.rows[0][1], 999, "a cell write succeeds and is visible");
    assert.equal(t.rows.length, 3);
    const again = await ml.table(SHEET);
    assert.equal(worker.asked.length, 2, "the second read is a fresh fetch and parse");
    assert.deepEqual(again.rows, [[1, 2], [3, 4]], "the first call's edit is not seen");
    assert.deepEqual(again.columns, ["a", "b"]);
    assert.notEqual(again.rows, t.rows);
});

test("in the dialect a page table is the script's to edit, down to its rows", async () => {
    const r = await run(`const t = await ml.table("#sales"); t.rows[0][1] = 999; t.rows.push(["east", 30]); return [t.rows[0][1], t.rows.length];`);
    assert.deepEqual(r.value, [999, 3]);
});

test("a table value the caller passes is handed back over the caller's own rows, with no copy; a read-only one stays read-only", async () => {
    const mine = { columns: ["region", "amount"], rows: [["north", 10], ["south", 20]], shape: [2, 2], dtypes: { region: "object", amount: "int64" } };
    const t = await host().ml.table(mine);
    assert.equal(t.rows, mine.rows, "not copied");
    t.rows[0][1] = 5;
    assert.equal(mine.rows[0][1], 5, "the caller's own rows");
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const ro = await host().ml.table(CSV_URL);
    const back = await host().ml.table(ro);
    assert.equal(back.rows, ro.rows);
    assert.throws(() => { back.rows[0][1] = 1; }, TypeError, "what the cache holds stays read-only");
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
