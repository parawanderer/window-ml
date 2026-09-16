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
    namedColumns, dtypesOf, castTableColumns, parseCsv, MAX_TABLE_ROWS,
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

test("dtypes follow read_csv: whole numbers are int64, a blank forces float64, text is object", () => {
    const t = tableFromDelimited([
        "id,price,qty,name",
        "1,12.50,3,Ada",
        "2,9.99,,Bob",       // the blank qty is what forces float64
        "3,4.00,7,Cy",
    ].join("\n"));
    assert.deepEqual(t.dtypes, { id: "int64", price: "float64", qty: "float64", name: "object" });
    assert.deepEqual(t.shape, [3, 4]);
});

test("a numeric column with a stray non-number stays object, but 90% numeric casts (the outlier → null)", () => {
    const mostly = tableFromDelimited(["n", "1", "2", "3", "4", "5", "6", "7", "8", "9", "n/a"].join("\n"));
    assert.equal(mostly.dtypes.n, "float64");          // the outlier became null → NaN → float
    assert.equal(mostly.rows[9][0], null);
    const half = tableFromDelimited(["n", "1", "2", "nope", "also-nope"].join("\n"));
    assert.equal(half.dtypes.n, "object");
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
    assert.match(out, /dtypes: id int64, label object/);
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
    // The cap counts parsed LINES, so a table with a header keeps one data row fewer — the contract is
    // "never more than the cap, and never silently", not an exact count.
    assert.ok(t.rows.length <= MAX_TABLE_ROWS && t.rows.length >= MAX_TABLE_ROWS - 1, `kept ${t.rows.length}`);
    assert.match(tablePreview(t), /only the first [\d,]+ rows were parsed/);
});

test("tableOf describes any producer's rows identically (a DOM table, a fetch, later Parquet)", () => {
    const t = tableOf(["a", "b"], [[1, "x"], [2, "y"]]);
    assert.deepEqual(t.shape, [2, 2]);
    assert.deepEqual(t.dtypes, { a: "int64", b: "object" });
    assert.equal(t.delimiter, undefined);   // nothing was delimited
});

test("dtypesOf reads the CAST values, so it describes what pandas will actually get", () => {
    // Strings that look numeric but were not cast (raw mode) are object — the description must not claim
    // a dtype the DataFrame will not have.
    assert.deepEqual(dtypesOf(["n"], [["1"], ["2"]]), { n: "object" });
    assert.deepEqual(dtypesOf(["n"], [[1], [2]]), { n: "int64" });
    assert.deepEqual(dtypesOf(["n"], [[1], [null]]), { n: "float64" });
    assert.deepEqual(dtypesOf(["n"], []), { n: "object" });
});
