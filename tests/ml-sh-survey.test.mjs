// ml-sh-survey.test.mjs — `ml.sh` inside the worker's read-only survey, end to end (src/sw/sw-run-host.ts `tryReadonly`, sw-survey-sh.ts):
// the script is auto-approved as a script, and EVERY call in it is still judged by the sh gate when it is made (a policy or the built-in
// default lets it run, no opinion asks the person inside the running step, a deny throws). Against the real worker with the fake process
// host (tests/fake-native-host.mjs), like tests/ml-sh.test.mjs does for the isolated route. The pure pieces are in tests/sw-survey-sh.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };

/** Answer every nested ask this way, recording each one asked (the harness's `onStep`). */
function answering(decision) {
    const asked = [];
    return {
        asked,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) {
                if (a.state !== "pending" || asked.some((x) => x.id === a.id)) continue;
                asked.push(a);
                if (decision !== null) void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision } });
            }
        },
    };
}
const valueOf = (result) => { const m = /^value: (.*)$/m.exec(result) ?? /^({.*\})$/m.exec(result); assert.ok(m, `no value in: ${result}`); return JSON.parse(m[1]); };
const via = (r) => r.log.filter((x) => x.kind.startsWith("readonly-") || x.kind.startsWith("exec-")).map((x) => [x.kind, x.reason]);
/** A script that runs `argv` through ml.sh and returns what it got, or what it threw. */
const runs = (argv) => () => `(async () => { try { const r = await ml.sh.run(${JSON.stringify(argv)}); return JSON.stringify({ ok: r.ok, code: r.code, approvedBy: r.approvedBy }); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

// --- the script is answered in the worker; the calls inside it are what is judged ---

test("a call the gate would not ask about runs inside the survey with no card, and the script is answered in the worker", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "a.txt\n", err: "", code: 0 }) });
    const ask = answering(true);
    const r = await runOn("readonly", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(valueOf(r.results[0]).ok, true);
    assert.equal(ask.asked.length, 0, "no card");
    assert.deepEqual(via(r), [["readonly-worker", "no-page-reads"]], "answered by the worker's survey: no isolated exec");
});

test("a call the gate WOULD ask about still asks, inside a script that is otherwise pure dialect, and runs once it is approved", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "done\n", err: "", code: 0 }) });
    const ask = answering(true);
    const r = await runOn("readonly", [runs(["python3", "x.py"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 1, "the person was asked about THE CALL, though the script needed no approval");
    assert.equal(valueOf(r.results[0]).ok, true);
    assert.deepEqual(via(r), [["readonly-worker", "no-page-reads"]]);
    assert.ok(host.names().includes("start"), "it started after the answer");
});

test("declined, the call throws Denied in the script (catchable), and nothing started", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(false);
    const r = await runOn("readonly", [runs(["python3", "x.py"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 1);
    assert.equal(valueOf(r.results[0]).code, "Denied");
    assert.ok(!host.names().includes("start"), "nothing started");
    assert.deepEqual(via(r), [["readonly-worker", "no-page-reads"]]);
});

// --- a script that started a program is never run again ---

test("a call, then something the worker's dialect lacks: the step ends there with the stop, and the program ran ONCE", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "ok\n", err: "", code: 0 }) });
    const ask = answering(true);
    const script = () => `(async () => { await ml.sh.run(["ls"]); return document.title; })()`;
    const r = await runOn("readonly", [script], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.match(r.results[0], /started 1 ml\.sh call \(ls: ok\)/);
    assert.match(r.results[0], /NOT run again/);
    assert.equal(host.names().filter((n) => n === "start").length, 1, "the program started once, not again on another leg");
    assert.ok(r.log.some((x) => x.kind === "readonly-sh-stopped"), "the run log says why the step ended");
    assert.ok(!r.log.some((x) => x.kind.startsWith("exec-")), "no isolated exec of the same script");
});

test("a page read BEFORE any call keeps the fall-through: nothing started, the script goes on to the person's gate", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "ok\n", err: "", code: 0 }) });
    const script = () => `(async () => { const t = document.title; return JSON.stringify(await ml.sh.run(["ls"])); })()`;
    const r = await runOn("readonly", [script], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: answering(true).onStep });
    assert.ok(!r.log.some((x) => x.kind === "readonly-sh-stopped"), "nothing had started, so there is nothing to stop");
    assert.deepEqual(via(r)[0], ["readonly-worker", "script-isolated"], "the fall-through is today's: to the person's gate, then an isolated world");
    assert.equal(host.names().filter((n) => n === "start").length, 0, "the survey itself started nothing before it reached the page");
});
