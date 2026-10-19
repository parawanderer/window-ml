// ml-wire.test.mjs — `ml` over the wire (docs/spec/ML_WIRE.md): every answer kind, a fake client against the worker.

// The worker's half (src/sw/sw-ml-wire.ts) in node:vm through a run's python_exec cell (tests/ml-wire-harness.mjs);
// the worker-free half (src/sw/ml-wire-serve.ts) imported directly, for the `ask` path no member reaches yet and the
// copy rules. What a hostile page must not get from the wire is tests/redteam-ml-wire.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serveWireCall, toWire, fromWire, wirePointer, WireError, openWireClient, deliverIfOpen } from "../src/sw/ml-wire-serve.ts";
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

// --- tag-shaped data crosses wrapped one level and comes back exactly (ML_WIRE.md, "What crosses") ---

test("fromWire(toWire(x)) is x for tag-shaped data: nested, doubly tag-shaped, in arrays, and bytes-shaped", () => {
    const cases = [
        { $x: 1 },
        { a: { $x: 1 }, b: [{ $y: { $z: 2 } }] },
        { $: 1 },
        { $: { $: 1 } },
        { $: { $secret: "s" } },
        [{ $a: 1 }, [{ $b: 2 }, { $: { $c: 3 } }]],
        { $bytes: "aGk=" },
        { plain: 1, list: [1, { $k: null }] },
    ];
    for (const x of cases) assert.deepEqual(fromWire(toWire(x)), x, JSON.stringify(x));
    assert.deepEqual(toWire({ $x: 1 }), { $: { $x: 1 } }, "positive control: tag-shaped data is wrapped on the way out");
    assert.deepEqual(toWire({ x: 1 }), { x: 1 }, "positive control: ordinary data is not");
    assert.deepEqual(fromWire({ $: { $: 1 } }), { $: 1 }, "exactly one level is unwrapped, not every `$`");
});

test("a cell's args in wire form are unwrapped once: data shaped like a tag arrives as data, never as a handle or bytes", async () => {
    const echo = { echo: { run: (...a) => a } };
    const asData = await serveWireCall(req("echo", [{ $: { $secret: "s" } }, { $: { $bytes: "aGk=" } }, { $: { $: 1 } }, [{ $: { $k: 1 } }]]), ctxOf(echo));
    assert.deepEqual(asData, { seq: 7, value: [{ $: { $secret: "s" } }, { $: { $bytes: "aGk=" } }, { $: { $: 1 } }, [{ $: { $k: 1 } }]] }, "the member got the dicts; the answer wraps them again");
    const seen = [];
    await serveWireCall(req("echo", [{ $: { $secret: "s" } }]), ctxOf({ echo: { run: (...a) => { seen.push(a); return null; } } }));
    assert.deepEqual(seen, [[{ $secret: "s" }]], "the member's own argument is the unwrapped dict");
});

test("a real $secret handle in a call's args is refused as SecretHandle, at any depth, and its member never runs", async () => {
    const ran = [];
    const members = { use: { run: (...a) => { ran.push(a); return 1; } } };
    for (const args of [[{ $secret: "gh" }], [[1, { k: { $secret: "gh" } }]], [{ $: { v: { $secret: "gh" } } }]]) {
        const a = await serveWireCall(req("use", args), ctxOf(members));
        assert.equal(a.error?.code, "SecretHandle", JSON.stringify(args));
        assert.match(a.error.message, /\(gh\)/, "the handle's name is told, never a value");
    }
    assert.deepEqual(ran, [], "no member saw a handle");
    assert.equal((await serveWireCall(req("use", [{ k: 1 }]), ctxOf(members))).value, 1, "positive control: plain data runs the member");
});

// --- the handle search reads a finite copy: nesting past the bound and cycles are refused first ---

test("an argument nested past the depth bound is refused as BadRequest before any handle search, and its member never runs", async () => {
    let deep = { $secret: "gh" };
    for (let i = 0; i < 80; i++) deep = { a: deep };
    let shallow = { $secret: "gh" };
    for (let i = 0; i < 10; i++) shallow = { a: shallow };
    const ran = [];
    const members = { use: { run: (...x) => { ran.push(x); return 1; } } };
    assert.equal((await serveWireCall(req("use", [shallow]), ctxOf(members))).error?.code, "SecretHandle", "positive control: within the bound, the handle is found");
    const a = await serveWireCall(req("use", [deep]), ctxOf(members));
    assert.equal(a.error?.code, "BadRequest");
    assert.match(a.error.message, /nests too deeply/);
    assert.deepEqual(ran, []);
});

test("a cyclic argument is refused as BadRequest, and its member never runs", async () => {
    const cyc = { $: {} };
    cyc.$.self = cyc;
    const ran = [];
    const a = await serveWireCall(req("use", [cyc]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
    assert.equal(a.error?.code, "BadRequest");
    assert.match(a.error.message, /cyclic/);
    assert.deepEqual(ran, []);
});

test("a key named __proto__ crosses as an own key, in and out", async () => {
    const v = JSON.parse('{"__proto__": {"x": 1}, "k": 1}');
    const seen = [];
    const a = await serveWireCall(req("echo", [v]), ctxOf({ echo: { run: (x) => { seen.push(x); return x; } } }));
    assert.equal(Object.getPrototypeOf(seen[0]), Object.prototype, "the member's copy keeps the plain prototype");
    assert.deepEqual(Object.keys(seen[0]), ["__proto__", "k"], "the member sees the key as data");
    assert.deepEqual(Object.getOwnPropertyDescriptor(seen[0], "__proto__").value, { x: 1 });
    assert.deepEqual(Object.keys(a.value), ["__proto__", "k"], "and the answer carries it back as an own key");
});

// --- a real $secret handle is refused at every wrap shape (handlesIn) ---

test("property: a real $secret handle is refused at every wrap shape, and its member never runs", async () => {
    const H = { $secret: "gh" };
    const shapes = {
        "top": H,
        "list of dicts": [{ a: { b: H } }],
        "beside a $ key": { $: 1, $secret: "gh" },
        "array under $": { $: [H] },
        "inside a $ wrap's value": { $: { v: H } },
        "two wraps deep": { $: { $: H } },
        "under constructor": { constructor: H },
        "depth 3 under a non-$ key": { a: { b: { c: H } } },
        "array of wraps": [{ $: { v: H } }],
    };
    const ran = [];
    for (const [label, v] of Object.entries(shapes)) {
        const a = await serveWireCall(req("use", [v]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
        assert.equal(a.error?.code, "SecretHandle", label);
        assert.match(a.error.message, /\(gh\)/, `${label}: the handle's name is told, never a value`);
    }
    assert.deepEqual(ran, [], "no member saw a handle");
    assert.equal((await serveWireCall(req("use", [{ k: 1 }]), ctxOf({ use: { run: () => 1 } }))).value, 1, "positive control");
});

test("property FAILS TODAY: an own __proto__ key hides a handle from handlesIn and pollutes the copy's prototype", async () => {
    // toWire's `out[k] = …` invokes the __proto__ setter for k === "__proto__", so the copy loses the key, its
    // [[Prototype]] becomes the attacker value (copied.$secret === "gh" via inheritance), handlesIn sees no own
    // $secret, and the member runs. The member's own copy is clean (fromWire copies own keys only) — the break is
    // the missed refusal and the attacker-controlled prototype on the wire-form args object.
    const v = JSON.parse('{"__proto__": {"$secret": "gh"}, "k": 1}');
    const ran = [];
    const a = await serveWireCall(req("use", [v]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
    assert.equal(a.error?.code, "SecretHandle", "a handle under an own __proto__ key is still a handle");
    assert.deepEqual(ran, []);
    // And the copy must not carry attacker data on its prototype.
    const copy = toWire([v], 0, new Set(), false);
    assert.equal(Object.getPrototypeOf(copy[0]), Object.prototype, "toWire's copy keeps the plain prototype");
    assert.equal(copy[0].$secret, undefined, "no inherited $secret on the copy");
});

test("property FAILS TODAY: a handle three wrap levels down escapes handlesIn", async () => {
    // handlesIn's wrap branch looks at the values inside ONE `{ "$": {…} }` and, for a nested wrap, again one
    // level; at three `$` levels the innermost `$secret` is never reached. A facade that wraps tag-shaped data at
    // every level can put a real handle there.
    const v = { $: { $: { $: { $secret: "gh" } } } };
    const ran = [];
    const a = await serveWireCall(req("use", [v]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
    assert.equal(a.error?.code, "SecretHandle", "a handle at any wrapping depth is still a handle");
    assert.deepEqual(ran, []);
});

// --- after the one-level unwrap, data is data ---

test("property: a handle-shaped dict that arrived as wrapped data reaches the member as a plain dict, and is not re-read as a handle", async () => {
    const seen = [];
    const echo = { echo: { run: (...x) => { seen.push(x); return x[0]; } } };
    // Wire form of the cell's data { $secret: "s" }: the facade wraps tag-shaped data one level.
    const a = await serveWireCall(req("echo", [{ $: { $secret: "s" } }]), ctxOf(echo));
    assert.equal(a.error, undefined, "wrapped handle-shaped DATA is not refused as a handle");
    assert.deepEqual(seen, [[{ $secret: "s" }]], "the member gets the unwrapped dict, with its own $secret key");
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0][0], "$secret"), true, "it is a plain own key, not a live handle");
    assert.deepEqual(a.value, { $: { $secret: "s" } }, "the answer wraps it again on the way out; nothing re-tags it");
});

test("property: the dual of the over-peel bug — a double wrap of DATA unwraps exactly one level", async () => {
    const seen = [];
    const echo = { echo: { run: (...x) => { seen.push(x); return null; } } };
    await serveWireCall(req("echo", [{ $: { $: 1 } }]), ctxOf(echo));
    assert.deepEqual(seen, [[{ $: 1 }]], "one level unwrapped: the member sees a dict with a $ key, not the bare value");
    seen.length = 0;
    await serveWireCall(req("echo", [{ $: { $: { $k: 2 } } }]), ctxOf(echo));
    assert.deepEqual(seen, [[{ $: { $k: 2 } }]], "a triple wrap reaches the member as a double: still one level");
    seen.length = 0;
    await serveWireCall(req("echo", [{ $: { $: { $secret: "s" } } }]), ctxOf(echo));
    assert.equal(seen.length, 0, "a handle inside the wraps is refused at any depth, and is not this property");
});
