// ml-wire.test.mjs — `ml` over the wire (docs/spec/ML_WIRE.md): every answer kind, a fake client against the worker.

// The worker's half (src/sw/sw-ml-wire.ts) in node:vm through a run's python_exec cell (tests/ml-wire-harness.mjs);
// the worker-free half (src/sw/ml-wire-serve.ts) imported directly, for the `ask` path no member reaches yet and the
// copy rules. What a hostile page must not get from the wire is tests/redteam-ml-wire.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serveWireCall, toWire, wirePointer, WireError, openWireClient, deliverIfOpen } from "../src/sw/ml-wire-serve.ts";
import { ML_READONLY_METHODS } from "../src/readonly-exec/policy.ts";
import { wireRun, wireCall } from "./ml-wire-harness.mjs";

const T = { timeout: 30000 };
const ctxOf = (members, over = {}) => ({ run: "r1", members, later: () => {}, isOpen: () => true, scrub: async (s) => s, ...over });
const req = (call, args = [], over = {}) => ({ type: "ML_CALL", client: "c", run: "r1", seq: 7, call, args, ...over });

// --- every answer kind from the worker, through a run's python cell ---

test("a run's python cell gets a wire client bound to its run, and its calls answer value, pointer and error", T, async () => {
    const got = {};
    const { pyRuns } = await wireRun(async (wire, bg) => {
        got.wire = wire;
        got.config = await wireCall(bg, wire, "config");
        got.schema = await wireCall(bg, wire, "schema", [{ a: 1, b: ["x"] }]);
        got.range = await wireCall(bg, wire, "range", [3]);
        got.deref = await wireCall(bg, wire, "dereference", ["fetch_url"]);
        got.piped = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: ".columns" }]);
        got.absent = await wireCall(bg, wire, "chat", ["hi"]);
    });
    assert.equal(pyRuns.length, 1, "positive control: the cell ran");
    assert.match(got.wire.client, /^mlw-/, "the PY_RUN carries a fresh client handle");
    assert.ok(typeof got.wire.run === "string" && got.wire.run.length > 0, "bound to the worker's run");
    assert.equal(typeof got.config.value?.model, "string", "config() answers a value");
    assert.ok(!JSON.stringify(got.config).includes("sk-test"), "the key is not in the public config");
    assert.equal(typeof got.schema.value, "string", "schema() answers its type string");
    assert.deepEqual(got.range.value, [0, 1, 2]);
    assert.match(got.deref.value?.text, /north,12/, "dereference answers the run's capture");
    assert.equal(got.deref.value?.meta?.tool, "fetch_url");
    assert.deepEqual(JSON.parse(got.piped.value?.text), ["region", "total"], "the pipe ran in the worker");
    assert.equal(got.absent.error?.code, "Absent", "a member the realm lacks is an error the client reports");
    assert.match(got.absent.error.message, /ml\.chat is not available here: this code has ml\./);
});

test("a capture larger than the model saw answers what the run's store holds: the wire adds no read past it", T, async () => {
    // With no value store (this harness's default) the pointer keeps the text the model was shown (fetch_url's
    // "[first 4000 of N chars]"), and a pipe reads that text. With one, the whole body is stored and read whole:
    // tests/text-captures.test.mjs.
    const big = Array.from({ length: 30000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const got = {};
    await wireRun(async (wire, bg) => {
        got.whole = await wireCall(bg, wire, "dereference", ["fetch_url"]);
        got.piped = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "head 30000" }]);
    }, { body: big, url: "https://data.example/notes.txt" });
    assert.match(got.whole.value?.text ?? "", /\[first \d[\d,]* of 1,?548,?889 chars\]/);
    assert.ok(got.piped.value.text.length < 10000, "a pipe reads the stored text, not the body");
    assert.match(got.whole.value.meta?.id, /^[0-9a-f]{7}$/);
});

test("the read-only realm's members are ML_READONLY_METHODS minus what reads the page, and nothing else", T, async () => {
    const answers = {};
    await wireRun(async (wire, bg) => {
        for (const m of ML_READONLY_METHODS) answers[m] = await wireCall(bg, wire, m, m === "range" ? [1] : m === "schema" ? [1] : m === "dereference" ? ["fetch_url"] : []);
    });
    const absent = Object.keys(answers).filter((m) => answers[m].error?.code === "Absent").sort();
    assert.deepEqual(absent, ["a11y", "queryAll"], "only the page readers are absent");
    for (const m of ["config", "models", "getModel", "range", "schema", "dereference"]) assert.ok("value" in answers[m], `positive control: ${m} answers`);
});

test("a full-mode cell is a full client, and this round its members are the read-only set", T, async () => {
    let got;
    await wireRun(async (wire, bg) => { got = { cfg: await wireCall(bg, wire, "config"), chat: await wireCall(bg, wire, "chat") }; }, { mode: "full" });
    assert.equal(typeof got.cfg.value?.model, "string");
    assert.equal(got.chat.error?.code, "Absent", "no gated member is on the wire until the consent path is");
});

// --- the server's rules, without a worker ---

test("ask: a gated call answers ask first, then its value or a Denied once the person decides", async () => {
    let decide;
    const later = [];
    const members = { send: { run: (x) => ({ sent: x }), gate: async () => ({ ask: "Send x?", decided: new Promise((r) => { decide = r; }) }) } };
    const first = await serveWireCall(req("send", ["x"]), ctxOf(members, { later: (a) => later.push(a) }));
    assert.deepEqual(first, { seq: 7, ask: { card: "Send x?" } });
    decide(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(later, [{ seq: 7, value: { sent: "x" } }]);
    const no = [];
    await serveWireCall(req("send", ["y"]), ctxOf({ send: { run: () => { throw new Error("ran"); }, gate: async () => ({ ask: "?", decided: Promise.resolve(false) }) } }, { later: (a) => no.push(a) }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(no[0].error.code, "Denied", "a declined call never runs");
});

test("an ask's final answer is pushed as ML_ANSWER to an open client, and a closed client is sent nothing", async () => {
    const sent = [];
    const { handle, close } = openWireClient({ from: { kind: "offscreen" }, run: "r1", realm: "full" });
    let decide;
    const members = { send: { run: (x) => ({ sent: x }), gate: async () => ({ ask: "Send x?", decided: new Promise((r) => { decide = r; }) }) } };
    const later = (a) => deliverIfOpen(handle, a, (m) => sent.push(m));
    const first = await serveWireCall(req("send", ["x"]), ctxOf(members, { later }));
    assert.deepEqual(first, { seq: 7, ask: { card: "Send x?" } });
    decide(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [{ type: "ML_ANSWER", client: handle, answer: { seq: 7, value: { sent: "x" } } }], "the push carries the client and the seq");
    close();
    assert.equal(deliverIfOpen(handle, { seq: 8, value: 1 }, (m) => sent.push(m)), false);
    assert.equal(sent.length, 1, "a closed client is sent nothing");
});

test("a gated call whose client closed while it waited never runs its member, and a card unanswered past the cap fails", async () => {
    let decide, open = true;
    const ran = [], later = [];
    const members = { send: { run: () => { ran.push(1); return 1; }, gate: async () => ({ ask: "?", decided: new Promise((r) => { decide = r; }) }) } };
    await serveWireCall(req("send"), ctxOf(members, { later: (a) => later.push(a), isOpen: () => open }));
    open = false;
    decide(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual([ran, later], [[], []], "approved after the close: nothing ran, nothing was sent");
    const slow = [];
    await serveWireCall(req("send"), ctxOf({ send: { run: () => { ran.push(2); }, gate: async () => ({ ask: "?", decided: new Promise(() => {}) }) } }, { later: (a) => slow.push(a), askTimeoutMs: 5 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(slow[0]?.error?.code, "Denied");
    assert.match(slow[0].error.message, /went unanswered/);
    assert.deepEqual(ran, [], "the member never ran");
});

test("a gate's allow runs the member and its deny refuses it", async () => {
    const ran = [];
    const m = (d) => ({ run: () => { ran.push(d); return 1; }, gate: async () => d });
    assert.deepEqual(await serveWireCall(req("x"), ctxOf({ x: m({ allow: true }) })), { seq: 7, value: 1 });
    assert.equal((await serveWireCall(req("x"), ctxOf({ x: m({ deny: "no" }) }))).error.code, "Denied");
    assert.equal(ran.length, 1);
});

test("a member's pointer, its WireError code and its throw each become their own answer", async () => {
    const members = {
        p: { run: () => wirePointer({ token: "@tool:abc1234", label: "big", size: 99 }) },
        w: { run: () => { throw new WireError("TooLarge", "too big"); } },
        t: { run: () => { throw new Error("boom"); } },
    };
    assert.deepEqual(await serveWireCall(req("p"), ctxOf(members)), { seq: 7, pointer: { token: "@tool:abc1234", label: "big", size: 99 } });
    assert.deepEqual(await serveWireCall(req("w"), ctxOf(members)), { seq: 7, error: { code: "TooLarge", message: "too big" } });
    assert.deepEqual(await serveWireCall(req("t"), ctxOf(members)), { seq: 7, error: { code: "Failed", message: "ml.t: boom" } });
});

test("a malformed request is a BadRequest, and an error's text goes through the scrubber", async () => {
    for (const bad of [null, {}, req("x", "notarray"), req(5), req("x", [], { seq: -1 }), req("x", [], { seq: 1.5 })]) {
        assert.equal((await serveWireCall(bad, ctxOf({ x: { run: () => 1 } }))).error?.code, "BadRequest", JSON.stringify(bad));
    }
    const a = await serveWireCall(req("x"), ctxOf({ x: { run: () => { throw new Error("at http://host/secret"); } } }, { scrub: async (s) => s.replace(/http:\S+/, "<server>") }));
    assert.equal(a.error.message, "ml.x: at <server>");
});

test("toWire copies plain data and bytes, and refuses functions, accessors, class instances and cycles", () => {
    assert.deepEqual(toWire({ a: [1, "s", null, true], b: { c: undefined, d: 2 }, n: NaN }), { a: [1, "s", null, true], b: { d: 2 }, n: null });
    assert.deepEqual(toWire(new Uint8Array([104, 105])), { $bytes: "aGk=" });
    const cyc = {}; cyc.self = cyc;
    for (const v of [() => 1, { f() {} }, Object.defineProperty({}, "g", { get: () => 1, enumerable: true }), new Map(), new (class K {})(), cyc, Symbol("s"), 1n]) {
        assert.throws(() => toWire(v), WireError);
    }
    const shared = { x: 1 };
    assert.deepEqual(toWire([shared, shared]), [{ x: 1 }, { x: 1 }], "a repeated object is not a cycle");
});
