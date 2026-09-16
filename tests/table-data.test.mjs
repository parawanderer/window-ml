// The table representation every producer shares: delimiter discovery, the pandas-shaped description
// (shape/columns/dtypes), and what a model is shown of a table it did not fetch.
//
// The classification tests carry the most weight here. Broadening the sniff from "commas only" to four
// candidate delimiters buys semicolon and tab files, and it also makes new things LOOK like tables —
// source code, a Markdown table, a one-column list. Each of those has a case below, because the failure
// is silent: a mis-sniffed body is not an error, it is a "csv" that parses into nonsense columns.
import test from "node:test";
import assert from "node:assert";
import {
    tableFromDelimited, tableOf, tablePreview, sniffDelimiter, looksCsv,
    namedColumns, dtypesOf, castTableColumns, parseCsv, hasHeaderRow, asTable, NotATable, MAX_TABLE_ROWS,
} from "../src/table-data.ts";

test("the delimiter is DISCOVERED, not assumed — comma, semicolon, tab and pipe all parse", () => {
    for (const [delim, body] of [
        [",", "a,b\n1,2"],
        [";", "a;b\n1;2"],
        ["\t", "a\tb\n1\t2"],
        ["|", "a|b\n1|2"],
    ]) {
        const t = tableFromDelimited(body);
        assert.equal(t.delimiter, delim, `delimiter for ${JSON.stringify(body)}`);
        assert.deepEqual(t.columns, ["a", "b"]);
        assert.deepEqual(t.rows, [[1, 2]]);
    }
});

test("an explicit delimiter overrides discovery (the Sheets export knows it is commas)", () => {
    // One column and no comma anywhere: discovery has nothing to go on, so a caller that KNOWS must win.
    const t = tableFromDelimited("title\nfirst;second\nthird;fourth", { delimiter: "," });
    assert.equal(t.delimiter, ",");
    assert.deepEqual(t.columns, ["title"]);
    assert.deepEqual(t.rows, [["first;second"], ["third;fourth"]]);
});

test("RFC-4180 quoting survives: embedded delimiters, newlines and doubled quotes", () => {
    const t = tableFromDelimited('name,note\n"Smith, Ada","said ""hi""\nthen left"\n');
    assert.deepEqual(t.columns, ["name", "note"]);
    assert.deepEqual(t.rows, [["Smith, Ada", 'said "hi"\nthen left']]);
    assert.equal(t.shape[0], 1);
});

test("parseCsv keeps its header row and its comma default (the Sheets path's contract)", () => {
    assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

// ---- dtypes: pandas' rules, because the point is that a model can guess them ----

test("dtypes follow pandas 3: whole numbers are int64, a blank forces float64, text is str", () => {
    const t = tableFromDelimited([
        "id,price,qty,name",
        "1,12.50,3,Ada",
        "2,9.99,,Bob",       // the blank qty is what forces float64
        "3,4.00,7,Cy",
    ].join("\n"));
    assert.deepEqual(t.dtypes, { id: "int64", price: "float64", qty: "float64", name: "str" });
    assert.deepEqual(t.shape, [3, 4]);
});

test("a numeric-looking column below the cast threshold stays TEXT (str), but 90% numeric casts (the outlier → null)", () => {
    const mostly = tableFromDelimited(["n", "1", "2", "3", "4", "5", "6", "7", "8", "9", "n/a"].join("\n"));
    assert.equal(mostly.dtypes.n, "float64");          // the outlier became null → NaN → float
    assert.equal(mostly.rows[9][0], null);
    const half = tableFromDelimited(["n", "1", "2", "nope", "also-nope"].join("\n"));
    // Not cast, so every cell is still a string — which pandas 3 calls `str`, not `object`.
    assert.equal(half.dtypes.n, "str");
    assert.deepEqual(half.rows[2], ["nope"]);
});

test("corporate number formatting casts: thousands, currency, percent, accounting parens", () => {
    const t = tableFromDelimited('v\n"1,234"\n$56\n78%\n(90)');
    assert.deepEqual(t.rows.map(r => r[0]), [1234, 56, 78, -90]);
    assert.equal(t.dtypes.v, "int64");
});

test("castTableColumns leaves an ID column alone rather than dropping its leading zero", () => {
    // Every value parses as a number, but they are ZIPs — which is why `raw` exists. Without it the cast is
    // correct-by-its-own-rule and wrong for the data, so the escape hatch has to keep working.
    const cast = castTableColumns(["zip"], [["01234"], ["02115"]]);
    assert.deepEqual(cast, [[1234], [2115]]);
    const raw = tableFromDelimited("zip\n01234\n02115", { raw: true });
    assert.deepEqual(raw.rows, [["01234"], ["02115"]]);
});

// ---- column names: usable as keys, the way pandas makes them ----

test("blank and duplicate headers are named like pandas (Unnamed: N, a.1)", () => {
    assert.deepEqual(namedColumns(["a", "", "a", " b "]), ["a", "Unnamed: 1", "a.1", "b"]);
    // A duplicate must not collapse the dtypes record onto one key.
    const t = tableFromDelimited("total,total\n1,2");
    assert.deepEqual(t.columns, ["total", "total.1"]);
    assert.deepEqual(Object.keys(t.dtypes), ["total", "total.1"]);
});

// ---- header detection: a data row mistaken for a header DELETES a record ----

test("a headerless CSV keeps every record and numbers its columns, as read_csv(header=None)", () => {
    const t = tableFromDelimited("1000,north,9.99\n1001,south,13.49\n1002,west,20.49");
    assert.deepEqual(t.columns, ["0", "1", "2"]);
    assert.equal(t.headerless, true);
    assert.equal(t.shape[0], 3, "the first row is DATA — losing it is the bug this exists for");
    assert.deepEqual(t.rows[0], [1000, "north", 9.99]);
});

test("a real header is detected: text over columns that are numbers underneath", () => {
    const t = tableFromDelimited("id,region,revenue\n1000,north,9.99\n1001,south,13.49");
    assert.deepEqual(t.columns, ["id", "region", "revenue"]);
    assert.equal(t.headerless, undefined);
    assert.equal(t.shape[0], 2);
});

test("an all-text table defaults to HAVING a header — the safer of the two wrong answers", () => {
    // Nothing distinguishes row 0 from the body here, so the heuristic cannot decide. Guessing "header"
    // costs a junk row VISIBLY; guessing "data" deletes a record and mislabels every column invisibly.
    const t = tableFromDelimited("name,city\nAda,Lyon\nBob,Porto");
    assert.deepEqual(t.columns, ["name", "city"]);
    assert.equal(t.headerless, undefined);
});

test("header detection is overridable in both directions, because a heuristic will be wrong", () => {
    assert.deepEqual(tableFromDelimited("id,name\n1,Ada", { header: false }).columns, ["0", "1"]);
    assert.deepEqual(tableFromDelimited("1,Ada\n2,Bob", { header: true }).columns, ["1", "Ada"]);
    assert.equal(tableFromDelimited("1,Ada\n2,Bob", { header: true }).shape[0], 1);
});

test("hasHeaderRow ignores text columns and decides on the ones that carry evidence", () => {
    // `region` is text everywhere and says nothing; `revenue` is numeric in the body, so its first cell
    // decides. A single-row table has nothing to compare against and defaults to a header.
    assert.equal(hasHeaderRow([["region", "revenue"], ["north", "9.99"], ["south", "13.49"]]), true);
    assert.equal(hasHeaderRow([["north", "9.99"], ["south", "13.49"], ["west", "20.49"]]), false);
    assert.equal(hasHeaderRow([["a", "b"]]), true);
});

test("a headerless table SAYS so in the preview — numeric column names must not read as lost ones", () => {
    const out = tablePreview(tableFromDelimited("1,Ada\n2,Bob\n3,Cy"));
    assert.match(out, /no header row was detected/);
    assert.match(out, /Nothing was dropped/);
    assert.match(out, /"header": true/, "and says how to correct it");
});

// ---- classification: what must NOT look like a table ----

test("sniffDelimiter rejects what only LOOKS delimited: prose, one column, ragged rows", () => {
    assert.equal(sniffDelimiter("Hello world, this is prose."), null);      // one line
    assert.equal(sniffDelimiter("alpha\nbeta\ngamma"), null);               // one column
    assert.equal(sniffDelimiter("a,b,c\n1,2\n3,4,5,6"), null);              // widths disagree
    assert.equal(looksCsv("just some prose here.\nand a second line."), false);
});

test("source code is not a table, though every line ends in the same semicolon", () => {
    // The regression the existing dom tests caught when the sniff widened: `const x = 1;` splits into two
    // consistent semicolon-delimited fields whose second is always empty.
    assert.equal(sniffDelimiter("const x = 1;\nexport default x;"), null);
    assert.equal(sniffDelimiter("foo();\nbar();\nbaz();"), null);
    // The one that got through the "empty in every row" rule and was caught by an e2e test: a trailing `}`
    // means the last column is NOT empty everywhere, so the sniff still sees a table. Nothing about the BODY
    // rules this out — which is why classifyContent gives a named code extension priority over a guessed
    // delimiter (see dom.ts), and why this case is pinned there rather than only here.
    assert.equal(sniffDelimiter("export const answer: number = 42;\nexport function id(x) { return x; }"), ";");
    // The rule that rejects them is "a column empty in EVERY row", so a real trailing empty column in an
    // otherwise populated table still parses.
    assert.equal(sniffDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
});

test("a Markdown table is prose, not data, despite parsing cleanly as pipe-delimited", () => {
    const md = "| name | qty |\n|------|-----|\n| Ada  | 3   |\n| Bob  | 10  |";
    assert.equal(sniffDelimiter(md), null);
    assert.equal(looksCsv(md), false);
    // A genuine pipe-separated export has no rule row and still resolves.
    assert.equal(sniffDelimiter("name|qty\nAda|3\nBob|10"), "|");
});

// ---- the model-facing preview ----

test("the preview reads as a df.head(): the rows, the real shape, and the dtypes", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${i},row${i}`);
    const t = tableFromDelimited(["id,label", ...rows].join("\n"));
    const out = tablePreview(t, { rows: 3 });
    assert.match(out, /^id,label\n0,row0\n1,row1\n2,row2\n/);
    assert.match(out, /\[40 rows x 2 columns\] \(first 3\)/);
    assert.match(out, /dtypes: id int64, label str/);
    assert.equal(out.includes("row3"), false);   // it is a HEAD, not the table
});

test("the preview NEVER pads for alignment — a model pays for every space (AGENTS.md)", () => {
    const t = tableFromDelimited("shortcol,a_much_longer_column_name\n1,x\n22222,y");
    const out = tablePreview(t);
    assert.equal(/ {2,}/.test(out), false, `preview contains alignment padding:\n${out}`);
});

test("a preview quotes a cell that would otherwise break the shape it is drawn in", () => {
    const t = tableFromDelimited('a,b\n"x,y","he said ""no"""');
    const out = tablePreview(t);
    assert.match(out, /"x,y","he said ""no"""/);
});

test("the preview names the source so the model can load the WHOLE table, not the rows it saw", () => {
    const t = tableFromDelimited("a,b\n1,2");
    assert.equal(tablePreview(t).includes("python_exec"), false);           // only when a source is given
    const out = tablePreview(t, { source: '"https://x/data.csv"' });
    assert.match(out, /pass "https:\/\/x\/data\.csv" to python_exec's `tables`/);
});

test("a table cut at the row cap says so — a prefix must not read as the whole file", () => {
    const body = ["n", ...Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, i) => String(i))].join("\n");
    const t = tableFromDelimited(body);
    assert.equal(t.truncated, true);
    // Exactly the cap in DATA rows (the header is not one of them), and `shape` counts the whole file — it
    // used to report the kept rows, one short of the cap, as the table's size.
    assert.equal(t.rows.length, MAX_TABLE_ROWS);
    assert.deepEqual(t.shape, [MAX_TABLE_ROWS + 10, 1]);
    assert.match(tablePreview(t, { source: '"u"' }), /for the first 200,000 rows as a DataFrame \(a prefix of the 200,010;/, "python_exec gets the kept rows, and the hint says so");
    assert.doesNotMatch(tablePreview(t, { source: '"u"' }), /for all/);
    assert.match(tablePreview(t), new RegExp(`\\[${(MAX_TABLE_ROWS + 10).toLocaleString("en-US")} rows x 1 columns\\]`));
    assert.match(tablePreview(t), /only the first [\d,]+ rows were parsed/);
});

test("tableOf describes any producer's rows identically (a DOM table, a fetch, later Parquet)", () => {
    const t = tableOf(["a", "b"], [[1, "x"], [2, "y"]]);
    assert.deepEqual(t.shape, [2, 2]);
    assert.deepEqual(t.dtypes, { a: "int64", b: "str" });
    assert.equal(t.delimiter, undefined);   // nothing was delimited
});

test("a PREFIX of a table still reports the whole table's size", () => {
    // What a pointer to a fetched CSV holds: the render descriptor ships at most a couple of hundred rows to
    // the UI and the export, so without the source count the pointer would describe a 50,000-row file as a
    // 200-row one — a plausible number, and the one a model would then answer with.
    const t = tableOf(["a"], [[1], [2]], 50000);
    assert.deepEqual(t.shape, [50000, 1]);
    assert.equal(t.truncated, true);
    assert.equal(t.rows.length, 2);
    assert.match(tablePreview(t), /\[50,000 rows x 1 columns\] \(first 2\)/);
    // And a complete table is not marked truncated just because a count was passed.
    assert.equal(tableOf(["a"], [[1], [2]], 2).truncated, undefined);
});

test("dtypesOf matches pandas 3.0.2 EXACTLY, case by case — measured in Pyodide, not recalled", () => {
    // Each row here was produced by running `pd.DataFrame(rows).dtypes` in this repo's own Pyodide. Two surprise:
    // strings with a null stay `str`, but booleans with a null become `object`. A preview that promises a dtype
    // the DataFrame then contradicts is the sample-as-the-whole kind of wrong, in miniature.
    const measured = [
        ["ints", [[1], [2]], "int64"],
        ["ints + null", [[1], [null]], "float64"],
        ["floats", [[1.5], [2]], "float64"],
        ["strings", [["a"], ["b"]], "str"],
        ["strings + null", [["a"], [null]], "str"],
        ["all null", [[null], [null]], "object"],
        ["bools", [[true], [false]], "bool"],
        ["str + num", [["a"], [1]], "object"],
        ["bool + null", [[true], [null]], "object"],
    ];
    for (const [label, rows, want] of measured) {
        assert.equal(dtypesOf(["c"], rows).c, want, label);
    }
});

test("dtypesOf reads the CAST values, so it describes what pandas will actually get", () => {
    // Strings that look numeric but were not cast (raw mode) are str — the description must not claim
    // a dtype the DataFrame will not have.
    assert.deepEqual(dtypesOf(["n"], [["1"], ["2"]]), { n: "str" });
    assert.deepEqual(dtypesOf(["n"], [[1], [2]]), { n: "int64" });
    assert.deepEqual(dtypesOf(["n"], [[1], [null]]), { n: "float64" });
    assert.deepEqual(dtypesOf(["n"], []), { n: "object" });
});

// ---- the FACADE: a small real surface, and a throw instead of `undefined` ----
//
// The type describes itself in pandas' vocabulary, which invites pandas' SYNTAX. Plain JavaScript answers
// `t[["a","b"]]` with `undefined`, and `undefined` flows into an answer without ever looking wrong — so the
// contract here is that a pandas reach FAILS, loudly, naming the nearest thing that exists.

const FACADE = () => asTable(tableFromDelimited("order_id,region,revenue\n1000,north,9.99\n1001,south,13.49\n1002,west,20.49"));

test("the facade's four operations do what their pandas namesakes do", () => {
    const t = FACADE();
    assert.deepEqual(t.col("revenue"), [9.99, 13.49, 20.49]);
    assert.deepEqual(t.select(["region", "revenue"]).columns, ["region", "revenue"]);
    assert.deepEqual(t.select(["region", "revenue"]).rows[0], ["north", 9.99]);
    assert.deepEqual(t.records()[0], { order_id: 1000, region: "north", revenue: 9.99 });
    assert.deepEqual(t.head(2).rows, [[1000, "north", 9.99], [1001, "south", 13.49]]);
    // The data stays reachable exactly as before — the facade ADDS, it does not replace.
    assert.deepEqual(t.shape, [3, 3]);
    assert.equal(t.dtypes.revenue, "float64");
});

test("head() is a smaller FRAME; select() keeps the row count it did not change", () => {
    const t = FACADE();
    assert.deepEqual(t.head(2).shape, [2, 3], "df.head(2).shape is (2, cols) — not the source's count");
    assert.deepEqual(t.select(["region"]).shape, [3, 1], "choosing columns does not change how many rows there are");
});

test("a pandas reach THROWS and names the nearest real spelling", () => {
    const t = FACADE();
    // `t[["a","b"]]` reaches the proxy as the key "a,b" — an array stringifies on property access — which is
    // the tell for the exact idiom, so the message can answer it precisely.
    assert.throws(() => t[["region", "revenue"]], (e) => e instanceof NotATable && /t\.select\(\["region", "revenue"\]\)/.test(e.message));
    assert.throws(() => t.revenue, (e) => e instanceof NotATable && /t\.col\("revenue"\)/.test(e.message));
    // Something that is not a column at all gets the inventory instead of a guess.
    assert.throws(() => t.groupby, (e) => e instanceof NotATable && /col\(name\) \/ select\(names\) \/ records\(\) \/ head\(n\)/.test(e.message));
    assert.throws(() => t.col("nope"), (e) => e instanceof NotATable && /This table has: order_id, region, revenue/.test(e.message));
});

test("the python_exec hint appears ONLY when python_exec is actually available", () => {
    const withPy = asTable(tableFromDelimited("a,b\n1,2"), { python: true });
    const without = asTable(tableFromDelimited("a,b\n1,2"), { python: false });
    assert.throws(() => withPy.groupby, /pass the table's source to python_exec/);
    assert.throws(() => without.groupby, (e) => !/python_exec/.test(e.message), "advice for a tool the run does not have is worse than none");
});

test("the facade is READ-ONLY — it holds output a step already produced", () => {
    const t = FACADE();
    assert.throws(() => { t.rows = []; }, (e) => e instanceof NotATable && /read-only/.test(e.message));
    assert.throws(() => { t.newThing = 1; }, NotATable);
});

test("INTEROP keys never throw — `await` and JSON.stringify read unknown objects speculatively", async () => {
    const t = FACADE();
    // `then` decides whether await treats this as a thenable. Throwing there breaks `await someTable`, which
    // is exactly what a model writes after `ml.fetch`.
    const awaited = await t;
    assert.deepEqual(awaited.shape, [3, 3]);
    const round = JSON.parse(JSON.stringify(t));
    assert.deepEqual(round.columns, ["order_id", "region", "revenue"]);
    assert.deepEqual(round.rows[0], [1000, "north", 9.99]);
});

test("a facade over a PREFIX keeps saying so — wrapping must not launder the sample", () => {
    const t = asTable(tableOf(["a"], [[1], [2]], 50000));
    assert.deepEqual(t.shape, [50000, 1]);
    assert.equal(t.truncated, true);
    assert.equal(t.select(["a"]).truncated, true, "a column subset of a prefix is still a prefix");
});

test("a table at EXACTLY the cap is complete, with or without a header", () => {
    const rows = Array.from({ length: MAX_TABLE_ROWS }, (_, i) => String(i));
    const withHeader = tableFromDelimited(["n", ...rows].join("\n"));
    assert.equal(withHeader.truncated, undefined, "the header line is not a data row, so nothing was dropped");
    assert.deepEqual(withHeader.shape, [MAX_TABLE_ROWS, 1]);
    const headerless = tableFromDelimited(rows.join("\n"), { header: false });
    assert.equal(headerless.truncated, undefined);
    assert.deepEqual(headerless.shape, [MAX_TABLE_ROWS, 1]);
    const over = tableFromDelimited([...rows, "x"].join("\n"), { header: false });
    assert.equal(over.truncated, true);
    assert.deepEqual(over.shape, [MAX_TABLE_ROWS + 1, 1]);
});

// ---- Arrow IPC: the File and Stream formats, decoded with dtypes READ from the schema ----
import { tableFromArrays, tableToIPC, vectorFromArray, Utf8, Bool, Float64, Int64, Int32, Dictionary, DateMillisecond } from "apache-arrow";
import { tableFromArrow, looksArrowFile } from "../src/table-data.ts";

const arrowBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const stock = () => tableFromArrays({
    sku: vectorFromArray(["A-100", "A-101", "B-200"], new Utf8()),
    price: vectorFromArray([12.5, null, 4.0], new Float64()),
    stock: vectorFromArray([3n, 0n, 41n], new Int64()),
    maybe: vectorFromArray([1n, null, 3n], new Int64()),
    discontinued: vectorFromArray([false, true, false], new Bool()),
    region: vectorFromArray(["north", "south", "north"], new Dictionary(new Utf8(), new Int32())),
    day: vectorFromArray([new Date(0), new Date(86_400_000), null], new DateMillisecond()),
});

test("an Arrow IPC FILE decodes to a TableLike whose dtypes are pandas' for the declared types, nulls included", async () => {
    const t = await tableFromArrow(arrowBuf(tableToIPC(stock(), "file")));
    assert.deepEqual(t.columns, ["sku", "price", "stock", "maybe", "discontinued", "region", "day"]);
    assert.deepEqual(t.shape, [3, 7]);
    assert.deepEqual(t.dtypes, { sku: "str", price: "float64", stock: "int64", maybe: "float64", discontinued: "bool", region: "str", day: "str" });
    assert.deepEqual(t.rows[0], ["A-100", 12.5, 3, 1, false, "north", "1970-01-01T00:00:00.000Z"]);
    assert.deepEqual(t.rows[1].slice(1, 4), [null, 0, null]);
    assert.equal(t.truncated, undefined);
});

test("an Arrow IPC STREAM decodes the same, and a capped decode keeps the file's real row count", async () => {
    const stream = arrowBuf(tableToIPC(stock(), "stream"));
    assert.equal(looksArrowFile(stream), false, "a stream has no magic");
    const t = await tableFromArrow(stream, { maxRows: 2 });
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.shape, [3, 7], "shape is the source's, not the decoded prefix's");
    assert.equal(t.truncated, true);
});

test("looksArrowFile reads the ARROW1 magic, and bytes that are not Arrow do not decode", async () => {
    assert.equal(looksArrowFile(arrowBuf(tableToIPC(stock(), "file"))), true);
    assert.equal(looksArrowFile(arrowBuf(new TextEncoder().encode("id,name\n1,a"))), false);
    await assert.rejects(tableFromArrow(arrowBuf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))));
});
