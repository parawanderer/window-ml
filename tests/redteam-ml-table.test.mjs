// redteam-ml-table.test.mjs — an auto-approved survey reads no table its source rule did not allow (#ml.table): the source is
// resolved ONCE, so the kind the ask is decided on is the kind the read uses even for an object the page can shape; a fetch
// result is read from own data properties, never a getter; and the answer is a copy. Source: src/ml/ml-table.ts
// (tableSource, tableSurvey), src/readonly-exec/policy.ts (the facade's `table`), docs/spec/ML_TABLE.md.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";
import { table, tableSource, tableSurvey } from "../src/ml/ml-table.ts";
import { asTable } from "../src/table/table-data.ts";
import { derivedFetchFields, cacheCopy } from "../src/ml/fetch-result.ts";
import { READ_ONLY_TABLE } from "../src/table/table-brand.ts";
import { mlFetchCache } from "../src/ml/ml-fetch-cache.ts";

const SALES = { columns: ["region", "amount"], rows: [["north", 10], ["south", 20]] };
const CSV_URL = "https://data.example/sales.csv";
const CSV = "region,amount\nnorth,10\nsouth,20\n";
const fetched = (url, text, extra = {}) => {
    const r = { url, status: 200, ok: true, type: "csv", text, contentType: "text/csv", typeByHeader: "csv", typeByContent: "csv", typeByExtension: null, ...extra };
    derivedFetchFields(r, { markdown: () => undefined, python: false });
    return cacheCopy(r);
};
/** The dialect's `ml`, built as the facade expects it: the survey, and the member the facade wraps. */
function dialectHost() {
    const ml = { ...host(), dereference: async () => ({ table: storedTable() }) };
    ml._tableSurvey = function (src) { const s = tableSurvey.call(ml, src); return { asks: s.asks, read: (o) => s.read(o) }; };
    return ml;
}
const runCell = (js) => evalReadonly(js, new JSDOM("<!doctype html><body></body>").window.document, dialectHost(), undefined, {});
/** A stored table over a preview, with a reader that answers the whole table. */
function storedTable() {
    return asTable({ columns: ["n", "s"], rows: [["a", 1], ["b", 2]], shape: [4, 2], dtypes: { n: "object", s: "int64" }, truncated: true },
        { readColumns: async (names) => ({ rowCount: 4, columns: Object.fromEntries(names.map((n) => [n, n === "n" ? ["a", "b", "c", "d"] : [1, 2, 3, 4]])) }) });
}
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

// --- the pointer branch: a stored table is a value the store owns, not a handle on it ---

test("RED TEAM (ml.table): an @tool: pointer's table refuses every edit, and the store and the next read are unchanged", async () => {
    const store = { columns: ["n", "s"], rows: [["a", 1], ["b", 2]], shape: [4, 2], dtypes: { n: "object", s: "int64" }, truncated: true };
    const reader = (names) => Promise.resolve({ rowCount: 4, columns: Object.fromEntries(names.map((n) => [n, n === "n" ? ["a", "b", "c", "d"] : [1, 2, 3, 4]])) });
    const stored = asTable(store, { readColumns: reader });
    const ml = { ...host(), dereference: async () => ({ table: stored }) };
    const t = await table.call(ml, "@tool:abc123");
    for (const op of [(x) => { x.rows[0][1] = 999; }, (x) => x.rows.push(["evil", 0]), (x) => x.columns.push("evil")]) assert.throws(() => op(t), TypeError);
    assert.deepEqual(store.rows[0], ["a", 1], "the stored preview's cell was edited through the answer");
    assert.equal(store.rows.length, 2, "a row was pushed into the stored preview");
    assert.deepEqual(store.columns, ["n", "s"], "the stored columns were edited through the answer");
    const again = await table.call(ml, "@tool:abc123");
    assert.deepEqual(again.rows[0], ["a", 1], "the next read of the pointer carried the edit");
    // positive control: the store reader still answers the whole table.
    assert.deepEqual(await t.col("n"), ["a", "b", "c", "d"]);
});

// --- the answer is the survey's to edit, and an edit to it reaches nothing ---

test("RED TEAM (ml.table): a fetched table is read-only, and an edit attempt leaves the cache and the next read as they were", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const ml = { ...host(), table };
    const t = await table.call(ml, CSV_URL);
    assert.throws(() => { t.rows[0][1] = 999; }, TypeError, "a fetched table was writable");
    assert.throws(() => { t.columns.push("x"); }, TypeError);
    assert.equal((await table.call(ml, CSV_URL)).rows[0][1], 10, "a second read did not return the source");
    assert.equal(mlFetchCache.get(CSV_URL).table.rows[0][1], 10, "the cache was edited through the answer");
    // positive control: .copy() is the way to an editable one, and its edit reaches nothing.
    const c = t.copy();
    c.rows[0][1] = 999;
    assert.equal(mlFetchCache.get(CSV_URL).table.rows[0][1], 10, "the copy's edit reached the cache");
});

// --- ruling 89: every mutator is refused, in strict code and silently in sloppy, and nothing evades the freeze ---

const MUTATORS = [
    ["a cell write", "t.rows[0][1] = 999"],
    ["a row push", "t.rows.push(['x', 0])"],
    ["a cell push", "t.rows[0].push('x')"],
    ["a column push", "t.columns.push('x')"],
    ["sort", "t.rows.sort()"],
    ["reverse", "t.rows.reverse()"],
    ["splice", "t.rows.splice(0, 1)"],
    ["fill", "t.rows.fill([])"],
    ["a length set", "t.rows.length = 0"],
    ["a dtypes write", "t.dtypes.n = 'object'"],
    ["a shape write", "t.shape[0] = 1"],
    ["Object.assign onto a row", "Object.assign(t.rows[0], { 0: 'x' })"],
];

test("RED TEAM (ml.table): every mutator on a fetched table throws in strict code, and the table is unchanged", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const ml = { ...host(), table };
    for (const [what, op] of MUTATORS) {
        const t = await table.call(ml, CSV_URL);
        assert.throws(() => new Function("t", `"use strict"; ${op}`)(t), TypeError, `${what} did not throw`);
        assert.deepEqual(t.rows[0], ["north", 10], `${what} changed the table`);
        assert.deepEqual(t.columns, ["region", "amount"], `${what} changed the columns`);
    }
});

test("RED TEAM (ml.table): in sloppy code every mutator is a silent no-op, and the value it named is unchanged", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const ml = { ...host(), table };
    for (const [what, op] of MUTATORS) {
        const t = await table.call(ml, CSV_URL);
        try { new Function("t", op)(t); } catch { /* a method call on a frozen array throws in sloppy code too; an assignment is silent */ }
        assert.equal(t.rows[0][1], 10, `${what} wrote through a frozen part`);
        assert.equal(t.rows.length, 2, `${what} changed the row count`);
        assert.equal(t.columns.length, 2, `${what} changed the columns`);
    }
});

test("RED TEAM (ml.table): in the dialect every mutator is refused with the way out, never a silent copy", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const u = JSON.stringify(CSV_URL);
    for (const [what, op] of MUTATORS) {
        const js = `const t = await ml.table(${u}); ${op}; return 1;`;
        const err = await runCell(js).then(() => null, (e) => e);
        assert.ok(err, `${what} was allowed in the dialect`);
        assert.match(String(err.message), /read-only/, `${what}: ${err.message}`);
    }
});

test("RED TEAM (ml.table): the freeze is not evaded by defineProperty, setPrototypeOf, call/apply/bind or destructuring", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const u = JSON.stringify(CSV_URL);
    const EVASIONS = [
        ["defineProperty on the facade", `Object.defineProperty(t, "rows", { value: [] });`],
        ["defineProperty on a frozen row", `Object.defineProperty(t.rows[0], "0", { value: "x" });`],
        ["setPrototypeOf on the facade", `Object.setPrototypeOf(t, {});`],
        ["call", `t.call(null);`],
        ["apply", `t.apply(null, []);`],
        ["bind", `t.bind(null);`],
        ["a destructured rows", `const { rows } = t; rows[0][0] = "x";`],
    ];
    for (const [what, op] of EVASIONS) {
        const js = `const t = await ml.table(${u}); ${op} return 1;`;
        const err = await runCell(js).then(() => null, (e) => e);
        assert.ok(err, `${what} was allowed`);
    }
    // positive control: the named method still exists and answers an editable table.
    const ok = await runCell(`const t = await ml.table(${u}); const c = t["copy"](); c.rows[0][1] = 1; return c.rows[0][1];`);
    assert.equal(ok.value, 1);
});

test("RED TEAM (ml.table): a frozen table carried in a script-made container stays unowned", async () => {
    mlFetchCache.set(CSV_URL, fetched(CSV_URL, CSV));
    const u = JSON.stringify(CSV_URL);
    for (const op of [`const xs = [t]; xs[0].rows[0][1] = 9;`, `const o = { t }; o.t.rows[0][1] = 9;`, `const xs = [t]; xs[0].columns.push("x");`]) {
        const err = await runCell(`const t = await ml.table(${u}); ${op} return 1;`).then(() => null, (e) => e);
        assert.ok(err, op);
    }
});

test("RED TEAM (ml.table): a copy of a stored table is editable, reads every row, and hands out no reader", async () => {
    const ml = dialectHost();
    const t = await table.call(ml, "@tool:abc");
    const c = t.copy();
    c.rows[0][1] = 99;
    assert.equal(c.rows[0][1], 99, "a copy is not editable");
    assert.deepEqual(await c.col("n"), ["a", "b", "c", "d"], "the copy lost the store reader");
    assert.equal(t.rows[0][1], 1, "the copy's edit reached the stored preview");
    assert.throws(() => c.readColumns, /not something it answers to/, "the reader is reachable off the copy");
});
