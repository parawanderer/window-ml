// An `ml.table` wire answer made ready for the sandbox (src/python/table-answer.ts): the offscreen document reads a
// stored table's bytes, or a `/files/` file through the run's reader, and decides a file's format, delimiter and header
// by the JS reader's own rules before the worker binds the bytes into the cell.
import test from "node:test";
import assert from "node:assert/strict";
import { tableAnswerBytes, tableOpts, hoistKey, UNHOISTED_TABLE } from "../src/python/table-answer.ts";

const enc = (s) => new TextEncoder().encode(s).buffer;
const fileAnswer = (data = {}) => ({ seq: 4, value: { source: { kind: "file", label: "/files/attached/f1/s.csv" }, data: { kind: "file", path: "/files/attached/f1/s.csv", ...data } } });
const deps = (file, stored) => ({
    file: async (p) => { if (typeof file === "function") return file(p); return file; },
    stored: async (k) => { if (!stored) throw new Error("no such value"); return stored(k); },
});

// --- answers that carry no bytes ---

test("a rows, html or error answer passes unchanged and carries no buffer", async () => {
    for (const a of [{ seq: 1, value: { data: { kind: "rows", columns: ["a"], rows: [[1]] } } }, { seq: 1, value: { data: { kind: "html", html: "<table>" } } }, { seq: 1, error: { code: "Denied" } }, null]) {
        const r = await tableAnswerBytes(a, deps(enc("")));
        assert.equal(r.answer, a);
        assert.equal(r.buffer, undefined);
    }
});

// --- a stored value ---

test("a stored value gets its bytes and format, and loses its key", async () => {
    const buf = enc("a,b\n1,2\n");
    const r = await tableAnswerBytes({ seq: 2, value: { data: { kind: "value", key: "k9", label: "t", columns: ["a", "b"] } } }, deps(null, (k) => { assert.equal(k, "k9"); return { format: "csv", buffer: buf }; }));
    assert.equal(r.buffer, buf);
    assert.deepEqual(r.answer.value.data, { kind: "value", label: "t", columns: ["a", "b"], format: "csv" });
});

test("a stored value the store no longer has is the call's error", async () => {
    const r = await tableAnswerBytes({ seq: 2, value: { data: { kind: "value", key: "gone" } } }, deps(null, null));
    assert.equal(r.answer.seq, 2);
    assert.equal(r.answer.error.code, "Failed");
    assert.match(r.answer.error.message, /could not read the stored table/);
});

// --- a /files file ---

test("a CSV file: the reader gets the path under /files, the delimiter and the header are discovered", async () => {
    let asked;
    const r = await tableAnswerBytes(fileAnswer(), deps((p) => { asked = p; return enc("name;qty\nx;1\ny;2\n"); }));
    assert.equal(asked, "attached/f1/s.csv");
    assert.deepEqual(r.answer.value.data, { kind: "value", format: "csv", delimiter: ";" });
    assert.ok(r.buffer);
});

test("a headerless file is marked headerless; the call's own delimiter and header win", async () => {
    const r = await tableAnswerBytes(fileAnswer(), deps(enc("1,2\n3,4\n5,6\n")));
    assert.equal(r.answer.value.data.headerless, true);
    const given = await tableAnswerBytes(fileAnswer({ delimiter: "|", header: true }), deps(enc("1,2\n3,4\n")));
    assert.equal(given.answer.value.data.delimiter, "|");
    assert.equal(given.answer.value.data.headerless, undefined);
    assert.equal(given.answer.value.data.header, true);
});

test("Parquet and Arrow files are told by their magic, whatever their name", async () => {
    const pq = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0, 0, 0, 0, 0x50, 0x41, 0x52, 0x31]).buffer;
    assert.equal((await tableAnswerBytes(fileAnswer(), deps(pq))).answer.value.data.format, "parquet");
    const arrow = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0, 0, 1, 2]).buffer;
    assert.equal((await tableAnswerBytes(fileAnswer(), deps(arrow))).answer.value.data.format, "arrow-file");
});

test("a binary file is never decoded as text: it is NotATable, and no bytes cross", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).buffer;
    const r = await tableAnswerBytes(fileAnswer(), deps(png));
    assert.equal(r.answer.error.code, "NotATable");
    assert.equal(r.buffer, undefined);
});

test("text with no delimiter is NotATable", async () => {
    const r = await tableAnswerBytes(fileAnswer(), deps(enc("just a sentence of prose\n")));
    assert.equal(r.answer.error.code, "NotATable");
});

test("the reader's errno is the call's code (a hidden file, a file over the cap), and no bytes cross", async () => {
    for (const code of ["EACCES", "EFBIG", "ENOENT"]) {
        const r = await tableAnswerBytes(fileAnswer(), deps(() => { throw Object.assign(new Error(`refused ${code}`), { code }); }));
        assert.equal(r.answer.error.code, code);
        assert.equal(r.answer.seq, 4);
        assert.equal(r.buffer, undefined);
    }
    const plain = await tableAnswerBytes(fileAnswer(), deps(() => { throw new Error("x"); }));
    assert.equal(plain.answer.error.code, "Failed");
});

// --- options and keys ---

test("tableOpts takes raw, a one-character delimiter and header, and refuses the rest", () => {
    assert.deepEqual(tableOpts(undefined), {});
    assert.deepEqual(tableOpts({ raw: true, delimiter: "\t", header: false }), { raw: true, delimiter: "\t", header: false });
    for (const bad of [[], "x", 3, { delimiter: ";;" }, { delimiter: "" }, { raw: 1 }, { sep: "," }, { __proto__: null, header: "yes" }])
        assert.throws(() => tableOpts(bad), (e) => e.code === "BadRequest", JSON.stringify(bad));
});

test("hoistKey tells options apart and ignores the source's surrounding space", () => {
    assert.equal(hoistKey(" s ", {}), hoistKey("s", {}));
    assert.notEqual(hoistKey("s", {}), hoistKey("s", { raw: true }));
    assert.notEqual(hoistKey("s", {}), hoistKey("s", { header: false }));
    assert.match(UNHOISTED_TABLE, /ml\.table\("<source>"\)/);
});
