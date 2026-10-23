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

// --- one budget a cell: every call its code makes draws on one step budget (ML_WIRE.md) ---

test("a cell's piped dereferences share one step budget: a loop of calls each under its own cap is stopped, and the next cell starts whole", T, async () => {
    // `grep a+b` over a run of "a" backtracks quadratically: about 90k steps here, well under the 3M one call may cost
    // alone (regex-cost.ts UNCHARGED_SEARCH_STEPS), so before the budget a loop of them was never stopped.
    const url = "https://data.example/a.txt";
    const cells = [];
    await wireRun(async (wire, bg) => {
        const answers = [];
        for (let i = 0; i < 80; i++) {
            const a = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep a+b" }]);
            answers.push(a);
            if (a.error) break;
        }
        cells.push({ answers, config: await wireCall(bg, wire, "config") });
    }, { body: "a".repeat(3900) + "\n", url, calls: [
        { name: "fetch_url", args: { url } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        { name: "python_exec", args: { code: "print(2)", mode: "readonly" } },
    ] });
    assert.equal(cells.length, 2, "positive control: both cells ran");
    const [first, second] = cells;
    const last = first.answers.at(-1);
    assert.equal(last.error?.code, "OverBudget", `the loop is stopped by the budget, not by the cap: ${JSON.stringify(last).slice(0, 200)}`);
    assert.match(last.error.message, /over their 3,000,000 steps together/);
    assert.ok(first.answers.length >= 10 && first.answers.length < 80, `stopped after ${first.answers.length} calls`);
    assert.ok(first.answers.slice(0, -1).every((a) => "value" in a), "every call before it answered");
    assert.equal(typeof first.config.value?.model, "string", "a call that does no metered work still answers");
    assert.equal(second.answers.length, first.answers.length, "the next cell's client starts with a whole budget");
});

test("calls a cell makes at once draw on the same budget as calls in turn: Promise.all buys no extra work", T, async () => {
    const url = "https://data.example/a.txt";
    const cells = [];
    const call = (bg, wire) => wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep a+b" }]);
    await wireRun(async (wire, bg) => {
        if (!cells.length) {
            let n = 0;
            for (; n < 80; n++) if ((await call(bg, wire)).error) break;
            cells.push({ answered: n });
        } else {
            const all = await Promise.all(Array.from({ length: 80 }, () => call(bg, wire)));
            cells.push({ answered: all.filter((a) => "value" in a).length, codes: [...new Set(all.filter((a) => a.error).map((a) => a.error.code))] });
        }
    }, { body: "a".repeat(3900) + "\n", url, calls: [
        { name: "fetch_url", args: { url } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        { name: "python_exec", args: { code: "print(2)", mode: "readonly" } },
    ] });
    assert.equal(cells.length, 2, "positive control: both cells ran");
    assert.ok(cells[0].answered >= 10 && cells[0].answered < 80, `in turn: ${cells[0].answered}`);
    assert.equal(cells[1].answered, cells[0].answered, "at once: the same number answer");
    assert.deepEqual(cells[1].codes, ["OverBudget"], "and the rest are refused by the budget");
});

test("a stage with no regex charges what it reads and makes, and a sed that would build past MAX_STRING is refused before it builds", T, async () => {
    // A stored megabyte: `head` reads and makes about 16k steps' worth each way, so no search is needed to spend the budget.
    const url = "https://data.example/big.txt";
    const got = {};
    await wireRun(async (wire, bg) => {
        got.sed = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: `sed s/a/${"x".repeat(20)}/g` }]);
        let n = 0;
        for (; n < 200; n++) {
            const a = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "head 1" }]);
            if (a.error) { got.last = a; break; }
            if (n === 0) got.first = a;
        }
        got.answered = n;
    }, { body: "a".repeat(1_000_000) + "\n", url, store: true });
    assert.equal(got.sed.error?.code, "OverBudget", JSON.stringify(got.sed).slice(0, 200));
    assert.match(got.sed.error.message, /too much for one call to build/);
    assert.equal(got.first?.value?.text?.length, 1_000_000, "positive control: the whole stored text is read, not its preview");
    assert.equal(got.last?.error?.code, "OverBudget");
    assert.ok(got.answered >= 60 && got.answered < 200, `head alone answered ${got.answered} times`);
});

test("an unpiped dereference of a stored text is charged its size: a loop of them is stopped, config still answers, and the next cell starts whole", T, async () => {
    // Before: a read with no pipe copied the stored megabyte for nothing, every call, until the cell's watchdog.
    const url = "https://data.example/big.txt";
    const size = 1_000_001, cells = [];
    await wireRun(async (wire, bg) => {
        const answers = [];
        for (let i = 0; i < 400; i++) {
            const a = await wireCall(bg, wire, "dereference", ["fetch_url"]);
            answers.push(a);
            if (a.error) break;
        }
        cells.push({ answers, config: await wireCall(bg, wire, "config") });
    }, { body: "a".repeat(1_000_000) + "\n", url, store: true, calls: [
        { name: "fetch_url", args: { url } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        { name: "python_exec", args: { code: "print(2)", mode: "readonly" } },
    ] });
    assert.equal(cells.length, 2, "positive control: both cells ran");
    const [first, second] = cells;
    const last = first.answers.at(-1);
    assert.equal(last.error?.code, "OverBudget", `stopped by the budget after ${first.answers.length} calls: ${JSON.stringify(last).slice(0, 160)}`);
    assert.equal(first.answers[0].value?.text.length, size, "positive control: the whole stored text is read");
    const expected = Math.floor(3_000_000 / (Math.ceil(size / 64) + 1));
    assert.ok(Math.abs(first.answers.length - 1 - expected) <= 1, `answered ${first.answers.length - 1} times, expected about ${expected}`);
    assert.equal(typeof first.config.value?.model, "string", "a call that does no metered work still answers");
    assert.equal(second.answers.length, first.answers.length, "the next cell's client starts with a whole budget");
});

test("a call's arguments are charged their size before they are copied: a loop sending a megabyte is stopped, config still answers, and the next cell starts whole", T, async () => {
    const big = "x".repeat(1_000_000), cells = [];
    await wireRun(async (wire, bg) => {
        const answers = [];
        for (let i = 0; i < 400; i++) {
            const a = await wireCall(bg, wire, "schema", [{ a: big }]);
            answers.push(a);
            if (a.error) break;
        }
        cells.push({ answers, config: await wireCall(bg, wire, "config") });
    }, { calls: [
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        { name: "python_exec", args: { code: "print(2)", mode: "readonly" } },
    ] });
    assert.equal(cells.length, 2, "positive control: both cells ran");
    const [first, second] = cells;
    const last = first.answers.at(-1);
    assert.equal(last.error?.code, "OverBudget", `stopped by the budget after ${first.answers.length} calls: ${JSON.stringify(last).slice(0, 160)}`);
    const expected = Math.floor(3_000_000 / Math.ceil(1_000_000 / 64));
    assert.ok(Math.abs(first.answers.length - 1 - expected) <= 1, `answered ${first.answers.length - 1} times, expected about ${expected}`);
    assert.equal(typeof first.config.value?.model, "string", "a call with no arguments still answers");
    assert.equal(second.answers.length, first.answers.length, "the next cell's client starts with a whole budget");
});

test("grep's context assembly is linear in the lines it reads, so a -A over many matching lines answers at the cost it is charged", T, async () => {
    // Red-team on #1007: `inRange` asked every match per line (lines x matched), so 40,000 matching lines held the
    // thread for seconds while the charge, which sees chars and the regex search, moved 3,048 steps. A cell could do
    // it about a thousand times. The assembly now walks the matches with one cursor.
    const url = "https://data.example/lines.txt";
    const body = ("x\n").repeat(120_000);
    const got = {};
    await wireRun(async (wire, bg) => {
        let t0 = performance.now();
        got.plain = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep x" }]);
        got.plainMs = performance.now() - t0;
        t0 = performance.now();
        got.context = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep -A 1 x" }]);
        got.ms = performance.now() - t0;
        got.small = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "head 20 | grep -A 1 x" }]);
    }, { body, url, store: true });
    assert.ok("value" in got.plain, "positive control: the same grep without a context flag answers");
    assert.match(got.small.value.text, /^x/m, "a context flag on a small input answers and still marks context");
    assert.equal(got.context.value?.text.split("\n").length, 120_000, `every line is in range: ${JSON.stringify(got.context).slice(0, 200)}`);
    // Relative to the same read without context, so a slow machine slows both. At 120,000 lines the plain grep took
    // 14 ms and lines x matched 2,378 ms; the cursor takes about what the plain grep does.
    assert.ok(got.ms < 5 * got.plainMs + 100, `-A took ${Math.round(got.ms)} ms against ${Math.round(got.plainMs)} ms for the plain grep`);
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

test("property: an own __proto__ key cannot hide a handle from handlesIn or put one on the copy's prototype", async () => {
    // Before #757: toWire's `out[k] = …` invoked the __proto__ setter for k === "__proto__", so the copy lost the
    // key, its [[Prototype]] became the attacker value (copied.$secret === "gh" via inheritance), handlesIn saw no
    // own $secret, and the member ran. The member's own copy was clean (fromWire copies own keys only); the break
    // was the missed refusal and the attacker-controlled prototype on the wire-form args object.
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

test("property: a handle three wrap levels down is refused by handlesIn like any other", async () => {
    // Before #757: handlesIn's wrap branch looked at the values inside ONE `{ "$": {…} }` and, for a nested wrap,
    // again one level; at three `$` levels the innermost `$secret` was never reached. A facade that wraps
    // tag-shaped data at every level can put a real handle there.
    const v = { $: { $: { $: { $secret: "gh" } } } };
    const ran = [];
    const a = await serveWireCall(req("use", [v]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
    assert.equal(a.error?.code, "SecretHandle", "a handle at any wrapping depth is still a handle");
    assert.deepEqual(ran, []);
});

// --- handlesIn is not exported: it has no depth bound of its own ---

test("handlesIn stays unexported — it has no depth bound of its own and is only safe behind toWire's", async () => {
    // serveWireCall copies through toWire first, which refuses nesting past MAX_DEPTH and cycles, so the
    // search only ever walks a finite tree. handlesIn itself recurses with no bound of its own: exported and
    // pointed at untrusted input, a deep nest would blow the stack before any refusal. Pin it unexported;
    // a caller that wants it out gives it its own bound and its own test first. (Lane 1 left this as "should
    // it ever be exported"; no use for exporting it appeared, so this is the pin, not the bound.)
    const mod = await import("../src/sw/ml-wire-serve.ts");
    assert.equal(Object.prototype.hasOwnProperty.call(mod, "handlesIn"), false,
        "handlesIn is not an export of ml-wire-serve.ts");
    assert.equal(mod.handlesIn, undefined);
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

// --- second-adversary pass: key evasions, depth shapes, forged tags after the one-level unwrap (b05d1d7c) ---

test("property: a non-enumerable or symbol $secret cannot reach the member while hiding from handlesIn", async () => {
    // toWire copies only Object.keys (enumerable own string keys) and refuses accessors; handlesIn runs on
    // that copy. A non-enumerable or symbol-keyed $secret is dropped by toWire, so it is neither refused
    // nor delivered — the member never sees a handle. The enumerable one is the positive control.
    const hidden = {};
    Object.defineProperty(hidden, "$secret", { value: "gh", enumerable: false });
    hidden.k = 1;
    const sym = { k: 1, [Symbol.for("$secret")]: "gh" };
    const seen = [];
    const members = { use: { run: (...x) => { seen.push(x); return 1; } } };
    for (const [label, v] of [["non-enumerable", hidden], ["symbol-keyed", sym]]) {
        const a = await serveWireCall(req("use", [v]), ctxOf(members));
        assert.equal(a.error, undefined, `${label}: the call is not refused (the key never crossed)`);
        assert.equal(seen.length, 1, `${label}: the member ran`);
        assert.equal(Object.prototype.hasOwnProperty.call(seen[0][0], "$secret"), false, `${label}: no own $secret reached the member`);
        assert.equal(seen[0][0].$secret, undefined, `${label}: no inherited $secret either`);
        seen.length = 0;
    }
    const a = await serveWireCall(req("use", [{ $secret: "gh", k: 1 }]), ctxOf(members));
    assert.equal(a.error?.code, "SecretHandle", "positive control: an enumerable $secret is refused");
    assert.deepEqual(seen, []);
});

test("property: an accessor $secret refuses the whole call as BadRequest, and its member never runs", async () => {
    // toWire throws on any accessor (it copies data properties only), so the call fails closed before
    // handlesIn runs. The member must not see a half-copied args array.
    const acc = { k: 1 };
    Object.defineProperty(acc, "$secret", { get: () => "gh", enumerable: true });
    const ran = [];
    const a = await serveWireCall(req("use", [acc]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
    assert.equal(a.error?.code, "BadRequest");
    assert.match(a.error.message, /accessor/);
    assert.deepEqual(ran, []);
    assert.equal((await serveWireCall(req("use", [{ $secret: "gh" }]), ctxOf({ use: { run: () => 1 } }))).error?.code, "SecretHandle",
        "positive control: an enumerable data $secret is SecretHandle, not BadRequest");
});

test("property: a handle is refused at every array/nesting shape, including sparse arrays and long chains", async () => {
    const H = { $secret: "gh" };
    const sparse = []; sparse[0] = 1; sparse[5] = H;
    let chain = H;
    for (let i = 0; i < 12; i++) chain = { [`k${i}`]: chain };
    const beside = { ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, i])), $secret: "gh" };
    const shapes = {
        "sparse array": [sparse],
        "array of arrays of arrays": [[[H]]],
        "twelve-key chain": chain,
        "beside 20 other keys": beside,
        "handle as an array element among many": [[1, 2, 3, H, 4]],
        "handle in a wrap's array value": { $: { v: [1, [H]] } },
        "handle under a numeric-looking key": { "0": H },
        "handle beside a $ key that is not the wrap": { $bytes: "x", $secret: "gh" },
    };
    const ran = [];
    for (const [label, v] of Object.entries(shapes)) {
        const a = await serveWireCall(req("use", [v]), ctxOf({ use: { run: (...x) => { ran.push(x); return 1; } } }));
        assert.equal(a.error?.code, "SecretHandle", label);
        assert.match(a.error.message, /\(gh\)/, label);
    }
    assert.deepEqual(ran, [], "no member saw a handle");
    assert.equal((await serveWireCall(req("use", [[1, 2, 3]]), ctxOf({ use: { run: () => 1 } }))).value, 1, "positive control");
});

test("property: forged wire tags after the one-level unwrap are data, never capabilities", async () => {
    // _out emits a bare {"$bytes": b64} for real bytes and wraps data {"$bytes": …} as {"$": {"$bytes": …}}.
    // After fromWire both look identical. No member may decode $bytes from an argument or re-read $secret
    // as a live handle. parseShRun's second scanner refuses $secret in env values; every other member must
    // treat the dict as opaque data.
    const seen = [];
    const members = {
        echo: { run: (...x) => { seen.push(x); return x[0]; } },
    };
    // Forged $bytes as data: arrives as the plain dict {"$bytes": …}, not as bytes.
    await serveWireCall(req("echo", [{ $: { $bytes: "Zm9yZ2Vk" } }]), ctxOf(members));
    assert.deepEqual(seen[0][0], { $bytes: "Zm9yZ2Vk" }, "the member got the dict, not decoded bytes");
    assert.equal(typeof seen[0][0], "object", "it is a dict, not a Uint8Array");
    seen.length = 0;
    // Forged $secret as data: arrives as the plain dict {"$secret": …}, not as a live handle.
    await serveWireCall(req("echo", [{ $: { $secret: "forged" } }]), ctxOf(members));
    assert.deepEqual(seen[0][0], { $secret: "forged" }, "the member got the dict, not a live handle");
    seen.length = 0;
    // Real bytes: toWire's bare {"$bytes": …} — same shape after unwrap, also a dict to the member.
    await serveWireCall(req("echo", [{ $bytes: "cmVhbA==" }]), ctxOf(members));
    assert.deepEqual(seen[0][0], { $bytes: "cmVhbA==" }, "real bytes also arrive as the tag dict on the args side");
    seen.length = 0;
    // The real handle is refused — the positive control that handlesIn still runs before the unwrap.
    const a = await serveWireCall(req("echo", [{ $secret: "gh" }]), ctxOf(members));
    assert.equal(a.error?.code, "SecretHandle", "a bare $secret is still refused");
    assert.deepEqual(seen, []);
});

test("property: the wrap exemption delivers a multi-key inner dict as data, and parseShRun still refuses it", async () => {
    // handlesIn's comment says the exempted object is "a tag-shaped dict the facade wrapped one level", but the
    // code exempts ANY object directly inside {"$": {…}}. The facade only wraps tag-shaped dicts (one key
    // starting with $), so a multi-key inner object is a FORGED wire form — unreachable through _out (it would
    // cross bare and be caught). Pin both layers: handlesIn delivers it as data, and the one member that
    // re-reads $secret (parseShRun's env scanner) refuses it.
    const seen = [];
    await serveWireCall(req("echo", [{ $: { $secret: "gh", other: 1 } }]), ctxOf({ echo: { run: (...x) => { seen.push(x); return null; } } }));
    assert.deepEqual(seen[0][0], { $secret: "gh", other: 1 }, "the exemption delivers the multi-key dict as data, not as a handle");
    // The facade path for the same DATA: not tag-shaped (two keys), so it crosses bare and is caught.
    assert.equal((await serveWireCall(req("echo", [{ $secret: "gh", other: 1 }]), ctxOf({ echo: { run: () => 1 } }))).error?.code, "SecretHandle",
        "the same data through the facade is refused (bare, not wrapped)");
    // parseShRun's env scanner is the one sink that re-reads $secret — it refuses both shapes.
    const { parseShRun, ShRefused } = await import("../src/shell/sh-call.ts");
    assert.throws(() => parseShRun([["true"], { env: { X: { $secret: "gh", other: 1 } } }]), (e) => e instanceof ShRefused && e.code === "SecretHandle");
    assert.throws(() => parseShRun([["true"], { env: { X: { $secret: "gh" } } }]), (e) => e instanceof ShRefused && e.code === "SecretHandle");
    // Positive control: a plain env value is accepted.
    assert.equal(parseShRun([["true"], { env: { X: "1" } }]).env.X, "1");
});

test("property: parseShRun refuses a $secret in an env value even when handlesIn's wrap exemption let it through", async () => {
    // Wire form {"$": {"$secret": "gh"}} is facade-wrapped DATA. handlesIn exempts it (the designed
    // one-level unwrap); fromWire delivers {"$secret": "gh"} to the member. parseShRun's second scanner
    // must still refuse it — that is the defence in depth for a member that re-reads $secret.
    const { parseShRun, ShRefused } = await import("../src/shell/sh-call.ts");
    // Positive control: the unwrapped dict is exactly what a member sees after the exemption.
    const seen = [];
    await serveWireCall(req("echo", [{ $: { $secret: "gh" } }]), ctxOf({ echo: { run: (...x) => { seen.push(x); return null; } } }));
    assert.deepEqual(seen[0][0], { $secret: "gh" }, "the member sees the unwrapped dict");
    // And parseShRun refuses that shape in env values.
    assert.throws(() => parseShRun([["true"], { env: { X: { $secret: "gh" } } }]), (e) => e instanceof ShRefused && e.code === "SecretHandle");
    // A multi-key dict with $secret is also refused (not tag-shaped, so no wrap exemption applies).
    assert.throws(() => parseShRun([["true"], { env: { X: { $secret: "gh", other: 1 } } }]), (e) => e instanceof ShRefused && e.code === "SecretHandle");
    // Positive control: a plain string env value is accepted.
    const ok = parseShRun([["true"], { env: { X: "1" } }]);
    assert.equal(ok.env.X, "1");
});
