// ml-facade.test.mjs — the Python `ml` facade (src/python/ml-facade.ts) under real CPython, against a fake transport that
// answers each request the way the `ml` wire does (docs/spec/ML_WIRE.md). Self-skips without dist/pyodide.

// The transport is Python here, an async function recording each request and answering from a script, so these tests
// pin the facade alone: what it sends, and how each answer kind reaches the cell. The real channel (the worker's
// closure-held post, the offscreen document stamping the client) is wired after the Pyodide lockdown.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { ML_FACADE, ML_FACADE_NAMES } from "../src/python/ml-facade.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
let py;

before(async () => {
    if (skip) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    py.runPython(ML_FACADE);
});

/**
 * Run `cell` with a fresh facade over a fake transport.
 * @param answers Python source of a function `answer(req) -> dict`, given the decoded request; `seq` is filled in
 * @param cell the cell's body (awaits allowed), whose `out` dict is returned
 * @returns `{ out, sent }`: what the cell put in `out`, and every request the transport received, as JSON text
 */
async function facadeRun(answers, cell) {
    const src = `
import json as _j, base64 as _b, types as _t
# The harness's own references, taken before the cell runs (a cell may patch the modules): the codec's and the transport's.
_loads, _dumps = _j.loads, _j.dumps
_codec = _t.SimpleNamespace(loads=_loads, dumps=_dumps, b64encode=_b.b64encode, b64decode=_b.b64decode)
_sent = []
${answers}
async def _send(raw):
    _sent.append(raw)
    req = _loads(raw)
    a = answer(req)
    return _dumps({"seq": req["seq"], **a}) if "seq" not in a else _dumps(a)
ml, MlError = _ml_make(_send, _codec)
out = {}
async def _cell():
${cell.split("\n").map((l) => "    " + l).join("\n")}
await _cell()
_dumps({"out": out, "sent": _sent}, default=repr)
`;
    // A namespace of its own per run, as a cell has, given only the factory.
    const globals = py.toPy({});
    globals.set("_ml_make", py.globals.get("_ml_make"));
    const r = JSON.parse(await py.runPythonAsync(src, { globals }));
    return { out: r.out, sent: r.sent.map((s) => JSON.parse(s)) };
}

// --- what the facade sends ---

test("a member call sends one request: seq, call and args, and nothing it did not get from the cell", { skip }, async () => {
    const { out, sent } = await facadeRun(`def answer(req): return {"value": {"model": "m1"}}`, `out["cfg"] = await ml.config()`);
    assert.deepEqual(out.cfg, { model: "m1" }, "the value reaches the cell as plain data");
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]).sort(), ["args", "call", "seq"], "no client, no run: the offscreen document stamps those");
    assert.deepEqual(sent[0], { seq: 1, call: "config", args: [] });
});

test("keyword arguments travel as one trailing options object; seq counts up per call", { skip }, async () => {
    const { sent } = await facadeRun(`def answer(req): return {"value": {"text": "x"}}`,
        `await ml.dereference("@tool:a1b2c3d", pipe=".rows | head 5")\nawait ml.dereference("@tool:a1b2c3d")`);
    assert.deepEqual(sent.map((s) => [s.seq, s.args]), [[1, ["@tool:a1b2c3d", { pipe: ".rows | head 5" }]], [2, ["@tool:a1b2c3d"]]]);
});

test("a namespace member is one call named by its dotted path, one level deep; a private or deeper name is not", { skip }, async () => {
    const { out, sent } = await facadeRun(`def answer(req): return {"value": {"code": 0}}`,
        `out["r"] = await ml.sh.run(["ls"], cwd="src")\nfor k, f in (("private", lambda: ml.sh._call), ("deeper", lambda: ml.sh.run.x)):\n    try:\n        f()\n        out[k] = "allowed"\n    except AttributeError:\n        out[k] = "refused"`);
    assert.deepEqual(out.r, { code: 0 });
    assert.deepEqual(sent, [{ seq: 1, call: "sh.run", args: [["ls"], { cwd: "src" }] }]);
    assert.deepEqual([out.private, out.deeper], ["refused", "refused"]);
});

// --- how each answer reaches the cell ---

test("an error answer is an MlError the cell catches, with the wire's code, and the cell goes on", { skip }, async () => {
    const { out } = await facadeRun(`def answer(req): return {"error": {"code": "Absent", "message": "ml.chat is not available here"}} if req["call"] == "chat" else {"value": 1}`,
        `try:\n    await ml.chat("hi")\nexcept MlError as e:\n    out["code"], out["msg"] = e.code, str(e)\nout["after"] = await ml.range(1)`);
    assert.equal(out.code, "Absent");
    assert.match(out.msg, /^Absent: ml\.chat is not available here/);
    assert.equal(out.after, 1, "a refusal is not a crash");
});

test("a pointer answer is an MlPointer naming its token, and passing it back sends the token", { skip }, async () => {
    const { out, sent } = await facadeRun(
        `def answer(req): return {"pointer": {"token": "@tool:9f2e1a0", "label": "notes", "size": 1548889}} if len(req["args"]) == 1 else {"value": {"text": "line 20000"}}`,
        `p = await ml.dereference("@tool:a1b2c3d")\nout["str"], out["size"], out["repr"] = str(p), p.size, repr(p)\nout["piped"] = await ml.dereference(p, pipe="head 1")`);
    assert.equal(out.str, "@tool:9f2e1a0");
    assert.equal(out.size, 1548889);
    assert.match(out.repr, /read it with a pipe/);
    assert.deepEqual(sent[1].args, ["@tool:9f2e1a0", { pipe: "head 1" }]);
    assert.deepEqual(out.piped, { text: "line 20000" });
});

test("bytes cross as {$bytes: base64} both ways; a secret handle stays opaque and goes back as it came", { skip }, async () => {
    const { out, sent } = await facadeRun(
        `def answer(req): return {"value": {"blob": {"$bytes": "AAEC/w=="}, "key": {"$secret": "github"}, "echo": req["args"]}}`,
        `v = await ml.schema(b"\\x00\\x01")\nout["blob"] = list(v["blob"])\nout["key"] = repr(v["key"])\ntry:\n    v["key"].x = 1\nexcept AttributeError:\n    out["readonly"] = True\nawait ml.schema(v["key"])`);
    assert.deepEqual(out.blob, [0, 1, 2, 255]);
    assert.equal(out.key, "<secret 'github'>");
    assert.equal(out.readonly, true);
    assert.deepEqual(sent[0].args, [{ $bytes: "AAE=" }]);
    assert.deepEqual(sent[1].args, [{ $secret: "github" }]);
});

test("data shaped like a tag is data: a wrapped {$bytes} arrives as the dict, a cell's {$secret} leaves wrapped", { skip }, async () => {
    const { out, sent } = await facadeRun(
        `def answer(req): return {"value": {"doc": {"$": {"$bytes": "x"}}, "nested": {"$": {"$": {"a": 1}}}}}`,
        `v = await ml.dereference("@tool:a1b2c3d")\nout["doc"], out["docType"] = v["doc"], type(v["doc"]).__name__\nout["nested"] = v["nested"]\nawait ml.schema({"$secret": "github"}, {"$bytes": "AA=="}, {"$x": 1, "y": 2})`);
    assert.deepEqual(out.doc, { $bytes: "x" }, "the dict, not bytes");
    assert.equal(out.docType, "dict");
    assert.deepEqual(out.nested, { $: { a: 1 } }, "one level unwrapped, no more");
    assert.deepEqual(sent[1].args, [{ $: { $secret: "github" } }, { $: { $bytes: "AA==" } }, { $x: 1, y: 2 }],
        "a cell's tag-shaped dict never crosses as a tag; a dict with more keys is not tag-shaped");
});

test("a value marked truncated says so in the cell's output, unasked", { skip }, async () => {
    const { out } = await facadeRun(`def answer(req): return {"value": {"text": "abc"}, "truncated": True, "size": 1548889}`,
        `import io, contextlib\nbuf = io.StringIO()\nwith contextlib.redirect_stdout(buf):\n    await ml.dereference("@tool:a1b2c3d")\nout["printed"] = buf.getvalue()`);
    assert.match(out.printed, /^\[ml\.dereference: this is a preview of 1,548,889 chars, not the whole value\]/);
});

test("an answer for another seq, an unreadable one, or one with no kind is an MlError, never a value", { skip }, async () => {
    const { out } = await facadeRun(
        `def answer(req):\n    return {"x": {"seq": 99, "value": 1}, "y": {"seq": req["seq"]}}.get(req["call"], {"value": 1})`,
        `for name in ("x", "y"):\n    try:\n        await getattr(ml, name)()\n        out[name] = "returned"\n    except MlError as e:\n        out[name] = e.code`);
    assert.deepEqual(out, { x: "Failed", y: "Failed" });
});

// --- what the cell can do to it ---

test("a cell that patches json or base64 does not change what the facade sends or reads", { skip }, async () => {
    const { out, sent } = await facadeRun(`def answer(req): return {"value": {"ok": True}}`,
        `import json, base64\nkept = (json.dumps, json.loads, base64.b64encode)\njson.dumps = lambda *a, **k: "PATCHED"\njson.loads = lambda *a, **k: {"seq": -1}\nbase64.b64encode = lambda *a: b"PATCHED"\ntry:\n    out["v"] = await ml.config()\n    out["b"] = await ml.schema(b"\\x00")\nfinally:\n    json.dumps, json.loads, base64.b64encode = kept`);
    assert.deepEqual(out.v, { ok: true });
    assert.deepEqual(sent[1].args, [{ $bytes: "AA==" }], "the facade's own base64, not the patched module's");
});

test("ml is read-only, and its private names are not members", { skip }, async () => {
    const { out, sent } = await facadeRun(`def answer(req): return {"value": 1}`,
        `for k, f in (("set", lambda: setattr(ml, "config", 1)), ("member", lambda: setattr(ml.config, "_name", "chat")), ("private", lambda: ml._call)):\n    try:\n        f()\n        out[k] = "allowed"\n    except AttributeError:\n        out[k] = "refused"`);
    assert.deepEqual(out, { set: "refused", member: "refused", private: "refused" });
    assert.equal(sent.length, 0);
});

test("the names the facade defines are the ones it says it defines", () => {
    assert.deepEqual([...ML_FACADE_NAMES], ["ml", "MlError"]);
    assert.match(ML_FACADE, /return _Ml\(\), MlError\n/);
});
