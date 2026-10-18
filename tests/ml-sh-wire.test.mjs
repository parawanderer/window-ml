// ml-sh-wire.test.mjs — `ml.sh` over the `ml` wire (src/sw/sw-ml-wire.ts): a run's python_exec cell calls `sh.run` and
// `sh.read` as a wire client, and each call is decided as an exec's is (src/sw/sw-shell-call.ts). The step an ask rides is
// a fact of the client's handle, recorded when the worker opened it for the python_exec step (docs/spec/ML_WIRE.md); the
// request names no step. The built worker in node:vm (tests/ml-wire-harness.mjs) with a fake process host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRun, wireCall } from "./ml-wire-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
/** The model's calls: python_exec alone, in `mode`. */
const py = (mode) => [{ name: "python_exec", args: { code: "await ml.sh.run(['ls'])", mode } }];

/** Answer every nested ask with `decision`, recording each ask and the step event it arrived on. */
function answering(decision) {
    const asked = [];
    return {
        asked,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) {
                if (a.state !== "pending" || asked.some((x) => x.a.id === a.id)) continue;
                asked.push({ a, tool: ev.tool, seq: ev.seq });
                if (decision !== null) void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision } });
            }
        },
    };
}

// --- a full cell has ml.sh, bound to the step that started it ---

test("a full-mode cell's sh.run runs through the host, and its output is read by range with sh.read", T, async () => {
    const big = "y".repeat(70000) + "END";
    const host = fakeNativeHost({ done: () => ({ out: big, err: "", code: 0 }) });
    let r, part;
    await wireRun(async (wire, bg) => {
        r = await wireCall(bg, wire, "sh.run", [["ls"]]);
        part = await wireCall(bg, wire, "sh.read", [r.value?.stdout?.token, { offset: 70000, length: 10 }]);
    }, { calls: py("full"), configExtra: ON, onNative: host.onNative });
    assert.equal(r.value?.ok, true, JSON.stringify(r));
    assert.equal(r.value.approvedBy, "builtin", "a read inside the roots is free");
    assert.equal(r.value.stdout.complete, false);
    assert.equal(part.value?.text, "END");
    assert.ok(host.names().includes("start"));
});

test("a call no policy answers asks on the python_exec step that opened the client; the request names no step", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(true);
    let r, wireSeen;
    await wireRun(async (wire, bg) => {
        wireSeen = wire;
        r = await wireCall(bg, wire, "sh.run", [["python3", "x.py"]]);
    }, { calls: py("full"), configExtra: ON, onNative: host.onNative, onStep: ask.onStep });
    assert.deepEqual(Object.keys(wireSeen).sort(), ["client", "run"], "the cell is handed a handle and its run, no step");
    assert.equal(ask.asked.length, 1);
    assert.equal(ask.asked[0].tool, "python_exec", "the ask is on the step that started the cell");
    assert.equal(ask.asked[0].a.kind, "sh");
    assert.equal(JSON.stringify(ask.asked[0].a.facts.argv), JSON.stringify(["python3", "x.py"]));
    assert.equal(r.value?.approvedBy, "person");
});

test("a declined call is a Denied error the cell can catch; nothing starts", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(false);
    let r;
    await wireRun(async (wire, bg) => { r = await wireCall(bg, wire, "sh.run", [["python3", "x.py"]]); },
        { calls: py("full"), configExtra: ON, onNative: host.onNative, onStep: ask.onStep });
    assert.equal(r.error?.code, "Denied", JSON.stringify(r));
    assert.ok(!host.names().includes("start"));
});

// --- who does not get it ---

test("a read-only cell has no sh: Absent, and the host is never reached", T, async () => {
    const host = fakeNativeHost();
    let r;
    await wireRun(async (wire, bg) => { r = await wireCall(bg, wire, "sh.run", [["ls"]]); },
        { calls: py("readonly"), configExtra: ON, onNative: host.onNative });
    assert.equal(r.error?.code, "Absent");
    // hello and configure are the worker measuring its capabilities at start (ml.sh is on); nothing was resolved or run.
    assert.deepEqual(host.calls.filter((c) => !["hello", "configure"].includes(c.call)), []);
});

test("a request that names a step or another run gets nothing more: the handle's run and step decide", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(true);
    let other, stepped;
    await wireRun(async (wire, bg) => {
        other = await wireCall(bg, wire, "sh.run", [["ls"]], { run: "someone-else" });
        stepped = await wireCall(bg, wire, "sh.run", [["python3", "x.py"]], { step: 999, seq: 4242 });
    }, { calls: py("full"), configExtra: ON, onNative: host.onNative, onStep: ask.onStep });
    assert.equal(other.error?.code, "Refused", "another run's id is refused before any member runs");
    assert.equal(stepped.value?.approvedBy, "person", "positive control: the call itself went through");
    assert.equal(ask.asked.length, 1);
    assert.equal(ask.asked[0].tool, "python_exec", "the ask is still on the handle's step");
    assert.equal(host.calls.filter((c) => c.call === "spawn").length, 1, "the other run's request reached no host");
});

test("after the cell ends its handle has no sh: a late call is refused and reaches no host", T, async () => {
    const host = fakeNativeHost();
    let kept, late;
    const { bg } = await wireRun(async (wire) => { kept = wire; }, { calls: py("full"), configExtra: ON, onNative: host.onNative });
    late = await wireCall(bg, kept, "sh.run", [["ls"]]);
    assert.equal(late.error?.code, "Refused");
    assert.equal(host.calls.filter((c) => c.call === "spawn").length, 0);
});
