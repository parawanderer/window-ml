// page-answer-caps.test.mjs — a page's answer to a delegated call held to pageRead's caps (src/sw/page-answer-caps.ts):
// one constant shared with worker-page-read.ts, tables cut with their source's row count kept, oversized text and
// pictures dropped with a note, and the text result clipped for the model. The run-level red-team cases (a real run in
// the bundle, both run kinds) are in redteam-render-values.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { capPageAnswer, capPageTable, pageResultCap, droppedNote } = await import("../src/sw/page-answer-caps.ts");
const { checkPageTable, PAGE_TABLE_CAPS, PAGE_HTML_MAX } = await import("../src/sw/worker-page-read.ts");
const { UI_OUT_CAP } = await import("../src/contract/contract-chat.ts");
const { OUTPUT_CAP } = await import("../src/contract/contract-pointers.ts");

const C = PAGE_TABLE_CAPS;
/** A page's answer with `renderOut` a table of these columns and rows, and what capPageAnswer made of it, with its cuts. */
function capTable(columns, rows, extra = {}) {
    const cuts = [];
    const env = { result: "ok", renderOut: { type: "table", columns, rows, ...extra } };
    return { env, out: capPageAnswer(env, "exec", {}, (c) => cuts.push(c)), cuts };
}

// --- one set of caps: pageRead and a page's answer agree at every edge ---

// Each case is a table exactly AT one of the caps and one just past it. pageRead (`checkPageTable`) accepts the first and
// refuses the second; a page's answer leaves the first alone and cuts the second back to the cap. If either module
// stopped reading PAGE_TABLE_CAPS, one side of one edge would move and this fails.
const EDGES = {
    columns: (n) => ({ columns: Array.from({ length: n }, (_, i) => `c${i}`), rows: [] }),
    rows: (n) => ({ columns: ["a"], rows: new Array(n).fill([]) }),
    cells: (n) => { const w = 1000, row = new Array(w).fill(1); return { columns: Array.from({ length: w }, (_, i) => `c${i}`), rows: new Array(Math.ceil(n / w)).fill(row) }; },
    cell: (n) => ({ columns: ["a"], rows: [["x".repeat(n)]] }),
};
for (const [cap, make] of Object.entries(EDGES))
test(`the ${cap} cap is the same for pageRead and a page's answer: at it both keep the table, past it pageRead refuses and the answer is cut to it`, () => {
    const at = make(C[cap]), over = make(cap === "cells" ? C.cells + 1000 : C[cap] + 1);
    assert.ok(checkPageTable({ label: "t", data: { kind: "rows", ...at } }), `pageRead keeps a table at the ${cap} cap`);
    assert.equal(checkPageTable({ label: "t", data: { kind: "rows", ...over } }), null, `pageRead refuses one past the ${cap} cap`);
    const kept = capTable(at.columns, at.rows);
    assert.equal(kept.out, kept.env, `a page's answer at the ${cap} cap is untouched`);
    assert.deepEqual(kept.cuts, []);
    const cut = capTable(over.columns, over.rows).out.renderOut;
    if (cap === "columns") assert.equal(cut.columns.length, C.columns);
    if (cap === "rows") assert.equal(cut.rows.length, C.rows);
    if (cap === "cells") assert.equal(cut.rows.reduce((n, r) => n + r.length, 0), C.cells);
    if (cap === "cell") assert.equal(cut.rows[0][0].length, C.cell);
    // And the answer's cut table is one pageRead accepts.
    assert.ok(checkPageTable({ label: "t", data: { kind: "rows", columns: cut.columns, rows: cut.rows } }), `the cut table is within pageRead's ${cap} cap`);
});

test("the text cap is pageRead's document cap: a field at it is kept, one past it is dropped", () => {
    assert.equal(PAGE_HTML_MAX, C.html, "pageRead's document cap is the shared constant");
    const at = { result: "ok", renderOut: { type: "exec-out", stdout: "x".repeat(C.html) } };
    assert.equal(capPageAnswer(at, "exec", {}), at);
    const over = capPageAnswer({ result: "ok", renderOut: { type: "exec-out", stdout: "x".repeat(C.html + 1), value: "v" } }, "exec", {});
    assert.equal(over.renderOut.stdout, undefined);
    assert.equal(over.renderOut.value, "v", "the rest of the descriptor stays");
});

// --- tables: cut to fit, the source's row count kept honest ---

test("a table cut short keeps its source's row count: the page's when it is no smaller than what it sent, else the rows it sent", () => {
    const rows = new Array(C.rows + 5).fill([1]);
    for (const [claimed, want] of [[undefined, C.rows + 5], [C.rows + 5, C.rows + 5], [9_000_000, 9_000_000], [3, C.rows + 5], [-1, C.rows + 5], [1.5, C.rows + 5], ["7", C.rows + 5]]) {
        const t = capTable(["a"], rows, claimed === undefined ? {} : { rowCount: claimed }).out.renderOut;
        assert.equal(t.rows.length, C.rows);
        assert.equal(t.rowCount, want, `claimed ${claimed}`);
        assert.equal(t.truncated, true);
    }
});

test("a cut is reported once per kind, with its size before and after", () => {
    const { cuts } = capTable(["a"], [["x".repeat(C.cell + 1)], ["x".repeat(C.cell + 2)], ...new Array(C.rows).fill([1])]);
    assert.deepEqual(cuts.map((c) => [c.slot, c.field, c.what, c.from, c.to]), [
        ["renderOut", "rows", "rows", C.rows + 2, C.rows],
        ["renderOut", "rows", "cell", 2, C.cell],
    ]);
});

test("an object or list cell survives capping with its content: a python frame's dict and list cells are values, never null", () => {
    // What a pandas frame with dict and list cells sends (python-runtime.ts), and the producer's own marker for a cell it
    // could not represent, which the table view draws as "unrenderable Probe" (render-panel.tsx `dfCell`).
    const rows = [["a", { q1: 1 }], ["b", [1, [2, { x: "y" }]]], ["c", { __ml_unrenderable__: "Probe" }]];
    const env = { result: "ok", renderOut: { type: "python-out", df: { columns: ["name", "meta"], rows, rowCount: 3 } } };
    assert.equal(capPageAnswer(env, "python_exec", {}), env, "within the caps, the frame is the same object");
    // And past another cap (the row cap), the cells of the rows kept still carry their content.
    const { out } = capTable(["name", "meta"], [...rows, ...new Array(C.rows).fill(["d", null])]);
    assert.deepEqual(out.renderOut.rows.slice(0, 3), rows);
});

test("a cell is held to the cell cap and never made null: an object's JSON cut to it, a non-finite number as its text, one with no JSON named by type", () => {
    const deep = { k: "v".repeat(C.cell) };
    const throwing = [{ toJSON() { throw new Error("no"); } }];
    const cyc = {}; cyc.self = cyc;
    const getter = { get boom() { throw new Error("no"); } };
    const { out, cuts } = capTable(["a", "b", "c", "d", "e", "f"], [[deep, Infinity, NaN, cyc, getter, throwing], "not a row"]);
    const [row, empty] = out.renderOut.rows;
    assert.equal(row[0], JSON.stringify(deep).slice(0, C.cell), "an object past the cap is its JSON, cut to it");
    assert.deepEqual(row.slice(1, 3), ["Infinity", "NaN"]);
    assert.deepEqual(row.slice(3), [{ __ml_unrenderable__: "object" }, { __ml_unrenderable__: "object" }, { __ml_unrenderable__: "list" }]);
    assert.ok(row.every((c) => c !== null), "no cell became null");
    assert.deepEqual(empty, [], "a row that is not an array is empty: there is no cell to keep");
    assert.deepEqual(cuts.map((c) => [c.what, c.from]), [["cell", 1], ["cell-type", 6]]);
});


test("a python frame, and the frames a python cell loaded, are held to the same caps", () => {
    const rows = new Array(C.rows + 1).fill([1]);
    const out = capPageAnswer({ result: "ok",
        renderIn: { type: "python-in", mode: "script", code: "df", tables: [{ name: "df", source: { kind: "page" }, columns: ["a"], rows }] },
        renderOut: { type: "python-out", df: { columns: ["a"], rows, rowCount: rows.length } } }, "python_exec", {});
    assert.equal(out.renderOut.df.rows.length, C.rows);
    assert.equal(out.renderOut.df.rowCount, C.rows + 1);
    assert.equal(out.renderIn.tables[0].rows.length, C.rows);
    assert.equal(out.renderIn.tables[0].rowCount, C.rows + 1);
});

test("capPageTable leaves a table with no rows array, and anything that is not an object, as it came", () => {
    const note = () => assert.fail("nothing to cut");
    for (const t of [{ columns: ["a"] }, { rows: "x" }]) assert.equal(capPageTable(t, note), t);
    for (const env of [null, undefined, "text", 7]) assert.equal(capPageAnswer(env, "exec", {}), env);
});

// --- the model's copy: what an honest producer writes passes whole ---

// pageResultCap's room for exec and python_exec is read off what their producers write: two slots clipped at the call's
// cap (console and value; error and stdout), each with its "[first N of M chars]" note, and the fixed notes around them.
// The producers run here for real (tools.ts, python-tool.ts) at their raised ceiling with every note they can add, and
// what they wrote must pass unclipped. Two slots and their notes are more than twice the cap, so a room of 2x cuts them.
test("an honest exec result at its raised ceiling, every note included, passes unclipped", async () => {
    const { loadDomWorld } = require("./helpers");
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find((t) => t.name === "exec");
    // Past the output ceiling (overNote), a value past the cap, and a raise past the ceiling (clampNote).
    const out = await exec.run({ js: "const s = 'x'.repeat(9000000); for (let i = 0; i < 4; i++) console.log(s); 'v'.repeat(9000)", maxChars: 1e9, maxCharsReason: "need it" });
    assert.match(out.content, /output stopped at the 32000000-char limit/);
    assert.match(out.content, /clamped to 8000 chars/);
    assert.ok(out.content.length > 2 * OUTPUT_CAP.exec.ceiling, `${out.content.length}`);
    const env = { result: out.content };
    assert.equal(capPageAnswer(env, "exec", { maxChars: 1e9, maxCharsReason: "need it" }), env);
});

test("an honest python_exec error with its stdout, at the raised ceiling, passes unclipped", async () => {
    const { loadDomWorld } = require("./helpers");
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: false, error: "e".repeat(30000), stdout: "s".repeat(30000), stdoutDropped: 99 });
    const args = { code: "x", maxChars: 1e9, maxCharsReason: "need it" };
    const out = await ml.pythonTool().run(args);
    assert.match(out.content, /^Python error: e{20000}… \[first 20000 of 30000 chars\]/);
    assert.ok(out.content.length > 2 * OUTPUT_CAP.python_exec.ceiling, `${out.content.length}`);
    const env = { result: out.content };
    assert.equal(capPageAnswer(env, "python_exec", args), env);
});

// --- pictures and text over the size: dropped, and the model told ---

test("a picture or text over the size is dropped from the render, the inline images and a locate's substeps, each with a note after the model's copy", () => {
    const big = "data:image/png;base64," + "A".repeat(C.html);
    const cuts = [];
    const out = capPageAnswer({
        result: "looked", image: big, imageLabel: "shot", images: [{ image: big }, { image: "data:image/png;base64,AA" }],
        renderIn: { type: "locate", mode: "grid", model: "m", substeps: [{ label: "pick", image: big, prompt: "p" }] },
        renderOut: { type: "image", src: big, label: "a capture" },
    }, "click", {}, (c) => cuts.push(c));
    assert.equal(out.image, undefined);
    assert.equal(out.imageLabel, undefined);
    assert.deepEqual(out.images, [{ image: "data:image/png;base64,AA" }]);
    assert.deepEqual(out.renderIn.substeps, [{ label: "pick", prompt: "p" }]);
    assert.equal(out.renderOut.src, undefined);
    assert.ok(out.result.startsWith("looked\n\n"), out.result.slice(0, 80));
    for (const f of ["renderOut.src", "renderIn.substeps.0.image", "image", "images.0"]) assert.ok(out.result.includes(droppedNote(f, big.length)), f);
    assert.deepEqual(cuts.map((c) => c.what), ["image", "image", "image", "image"]);
});

// --- the model's copy of the text result ---

test("the model's copy of a page's text is cut by clipOut at the panel's cap, or at room for a capped tool's two slots", () => {
    assert.equal(pageResultCap("click", {}), UI_OUT_CAP);
    assert.equal(pageResultCap("my_page_tool", { maxChars: 1e9 }), UI_OUT_CAP, "only a tool with a model cap reads maxChars");
    assert.equal(pageResultCap("exec", {}), Math.max(UI_OUT_CAP, 3 * OUTPUT_CAP.exec.default));
    assert.equal(pageResultCap("exec", { maxChars: 1e9, maxCharsReason: "r" }), Math.max(UI_OUT_CAP, 3 * OUTPUT_CAP.exec.ceiling));
    assert.equal(pageResultCap("python_exec", { maxChars: OUTPUT_CAP.python_exec.ceiling, maxCharsReason: "r" }), 3 * OUTPUT_CAP.python_exec.ceiling);
    assert.equal(pageResultCap("__proto__", {}), UI_OUT_CAP);
    const cuts = [];
    const long = "y".repeat(UI_OUT_CAP + 10);
    const out = capPageAnswer({ result: long }, "click", {}, (c) => cuts.push(c));
    assert.equal(out.result, `${"y".repeat(UI_OUT_CAP)}… [first ${UI_OUT_CAP} of ${UI_OUT_CAP + 10} chars]`);
    assert.deepEqual(cuts, [{ slot: "envelope", field: "result", what: "result", from: UI_OUT_CAP + 10, to: UI_OUT_CAP }]);
});

test("control: an answer within every cap is returned as the same object, and an exec result at its producer's largest is not cut", () => {
    const env = { result: "clicked", renderIn: { type: "action", verb: "Click", target: "Save" },
        renderOut: { type: "table", columns: ["a", "b"], rows: [[1, "x"], [2, null]], rowCount: 2 } };
    assert.equal(capPageAnswer(env, "click", {}), env);
    // What exec's own producer writes at its raised cap: a clipped console and a clipped value, with their notes.
    const slot = (n) => `${"z".repeat(n)}… [first ${n} of ${n * 4} chars]`;
    const execResult = `console:\n${slot(OUTPUT_CAP.exec.ceiling)}\n\nvalue: ${slot(OUTPUT_CAP.exec.ceiling)}\n\n(output limit clamped to ${OUTPUT_CAP.exec.ceiling} chars — the hard ceiling.)`;
    const e2 = { result: execResult };
    assert.equal(capPageAnswer(e2, "exec", { maxChars: 1e9, maxCharsReason: "need it" }), e2);
});

// --- lists that are not tables: a keyval's pairs, an elements' items, an exec-out's notes ---

// They reach the sidebar step, the session store and the exports, never the pointer or the model, and were the open item
// #629 left: held whole, bounded only by Chrome's message cap. Held to the table caps now: entries as rows, strings as cells.
const LISTS = [
    ["keyval", "pairs", (s) => [s, s]],
    ["elements", "items", (s) => ({ path: s, text: s, index: 0 })],
    ["exec-out", "stdoutNotes", (s) => s],
    ["exec-out", "valueNotes", (s) => s],
];
for (const [type, field, entry] of LISTS)
test(`the ${type} descriptor's ${field} is held to the table caps: entries past the row cap dropped, a string past the cell cap cut`, () => {
    const at = { result: "ok", renderOut: { type, [field]: [entry("x".repeat(C.cell)), ...new Array(C.rows - 1).fill(entry("y"))] } };
    assert.equal(capPageAnswer(at, "probe", {}), at, `a ${field} at both caps is untouched`);
    const cuts = [];
    const over = capPageAnswer({ result: "ok", renderOut: { type, [field]: [entry("x".repeat(C.cell + 1)), ...new Array(C.rows).fill(entry("y"))] } }, "probe", {}, (c) => cuts.push(c));
    const list = over.renderOut[field];
    assert.equal(list.length, C.rows);
    const first = list[0], long = typeof first === "string" ? first : Array.isArray(first) ? first[0] : first.path;
    assert.equal(long.length, C.cell);
    assert.deepEqual(cuts.map((c) => [c.slot, c.field, c.what, c.from]), [["renderOut", field, "rows", C.rows + 1], ["renderOut", field, "cell", typeof first === "string" ? 1 : 2]]);
});

test("a descriptor type named after an Object.prototype member is no list type: its answer passes as it came", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
        const env = { result: "ok", renderOut: { type, pairs: [["a", "b"]], items: [{ path: "p" }] } };
        assert.equal(capPageAnswer(env, "probe", {}), env, type);
    }
});

// --- controls: an answer within every cap, and a cut answer cut again ---

// One descriptor of every kind (contract-render.ts), each field at an ordinary size: what an honest page sends.
const ORDINARY = {
    action: { type: "action", verb: "Click", target: "Save", selector: "#save" },
    code: { type: "code", text: "document.title", lang: "javascript", marks: [{ start: 0, end: 8, from: "x" }] },
    elements: { type: "elements", items: [{ path: "div > a", text: "Home", index: 0 }] },
    "exec-out": { type: "exec-out", stdout: "a\nb", seen: 3, value: "1", stdoutNotes: ["note"], valueNotes: ["note"] },
    image: { type: "image", src: "data:image/png;base64,AA", label: "shot" },
    keyval: { type: "keyval", pairs: [["url", "https://site.example/"], ["title", "Site"]] },
    locate: { type: "locate", mode: "grid", model: "m", substeps: [{ label: "pick", image: "data:image/png;base64,AA", prompt: "p" }] },
    look: { type: "look", image: "data:image/png;base64,AA", output: "a page", label: "look" },
    "python-in": { type: "python-in", mode: "script", code: "df", tables: [{ name: "df", source: { kind: "dom", label: "#t" }, columns: ["a"], rows: [[1], [null]], rowCount: 2 }] },
    "python-out": { type: "python-out", stdout: "x", value: "1", df: { columns: ["a"], rows: [[1]], rowCount: 1 } },
    table: { type: "table", columns: ["a", "b"], rows: [[1, "x"], [true, null]], rowCount: 2 },
};
test("control: an answer of every descriptor kind within every cap is returned as the same object, and nothing is logged", () => {
    for (const [kind, d] of Object.entries(ORDINARY)) {
        const env = { result: "ok", renderIn: d, renderOut: d, image: "data:image/png;base64,AA", images: [{ image: "data:image/png;base64,AA" }] };
        const cuts = [];
        assert.equal(capPageAnswer(env, "probe", {}, (c) => cuts.push(c)), env, kind);
        assert.deepEqual(cuts, [], kind);
    }
});

test("a cut render cut again is the same object: the caps are a fixed point", () => {
    const big = "x".repeat(C.html + 1);
    const once = capPageAnswer({ result: "ok",
        renderIn: { type: "python-in", mode: "script", code: "df", tables: [{ name: "df", columns: ["a"], rows: new Array(C.rows + 3).fill([1]), rowCount: C.rows + 3 }] },
        renderOut: { type: "table", columns: Array.from({ length: C.columns + 1 }, (_, i) => `c${i}`), rows: [["y".repeat(C.cell + 1), { o: 1 }], ...new Array(C.rows).fill([])], stdout: big } }, "probe", {});
    const cuts = [];
    const again = capPageAnswer({ ...once, result: "ok" }, "probe", {}, (c) => cuts.push(c));
    assert.equal(again.renderIn, once.renderIn);
    assert.equal(again.renderOut, once.renderOut);
    assert.deepEqual(cuts, []);
});
