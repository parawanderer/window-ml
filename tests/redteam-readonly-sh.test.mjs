// redteam-readonly-sh.test.mjs — red-team rows for `ml.sh.run`/`ml.sh.read` as read-only dialect members
// (`SH_READONLY_METHODS`, `mlFacade`, evaluator.ts `onSh`), on the ruling of 2026-11-14: the two members join the
// read-only dialect, a script naming them runs in an isolated world only, and each call is judged on its own by the sh
// gate. One `// ---` section per property.
//
// Written against feat/sh-in-readonly-dialect at d44f67fd, which also binds `sh` into the worker's survey
// (sw-run-host.ts `tryReadonly` → sw-survey-sh.ts `surveySh`/`guardSurvey`), so a survey's calls are judged by the real
// gate. Sections A-E pin the dialect's half — every call handed over on its own, in a shape the gate can read — against
// a stand-in host; section F drives one script with two programs through the real wiring end to end, where a card for
// the second call is owed even though the first was allowed.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";
import { mlFacade } from "../src/readonly-exec/policy.ts";
import { routeExec, surveyMayEnterPage } from "../src/sw/exec-routing.ts";
import { evalReadonlyInWorker } from "../src/sw/sw-readonly.ts";
import { parseShRun, ShRefused } from "../src/shell/sh-call.ts";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;
const ANY = { userScripts: true, cdp: true }, NONE = { userScripts: false, cdp: false };

/** An `ml` whose `sh` records every call it is handed as `["run"|"read", ...args]`, and answers as the worker's does.
 *  `dereference` answers a String OBJECT, the way `DerefText` does (policy.ts's String-subclass note). */
function host() {
    const calls = [];
    const sh = {
        run: async (...a) => { calls.push(["run", ...a]); return { ok: true, code: 0, stdout: { text: `${(a[0] ?? []).join(" ")}\n` } }; },
        read: async (...a) => { calls.push(["read", ...a]); return { ok: true, text: "t" }; },
    };
    return { ml: { sh, dereference: (ref) => new String(`THE STORED TEXT of ${ref}`), range: (n) => Array.from({ length: n }, (_, i) => i) }, calls };
}
const run = (js, h = host()) => evalReadonly(js, doc(), h.ml, undefined, { realm: "worker" });

// --- A: a script naming ml.sh never runs in the page's world ---

// The page's mediated interpreter lives in the main world, where every page script shares its realm. A survey naming
// `ml.sh` may never be handed there, on any setting and whatever the browser offers; the exec of an approved run routes
// to a world of its own, and the fallback that hands a pointer-naming script to the main world with a note never applies.

test("RED TEAM: a survey naming ml.sh may not be evaluated in the page's world, and one that does not still may", () => {
    for (const js of [
        `return (await ml.sh.run(["ls"])).ok`,
        `return await ml.sh.read("p")`,
        `const s = ml.sh; return (await s.run(["ls"])).ok`,
        `ml . sh . run(["ls"])`,                    // whitespace is read through
        `const r = await ml.sh.run(["ls"]); return r.stdout.text`,
    ]) assert.equal(surveyMayEnterPage(js), false, `this survey would have been handed to the page: ${js}`);
    assert.equal(surveyMayEnterPage(`return ml.range(3).length`), true, "positive control: a script with no ml.sh is still surveyed in the page");
});

test("RED TEAM: an approved exec naming ml.sh runs in an isolated world, by either mechanism, and says it runs programs", () => {
    const viaScripts = routeExec(`ml.sh.run(["ls"])`, true, ANY);
    assert.equal(viaScripts.where, "isolated");
    assert.equal(viaScripts.reason, "sh");
    assert.equal(viaScripts.how, "userScripts");
    const viaCdp = routeExec(`ml.sh.read("p")`, true, { userScripts: false, cdp: true });
    assert.equal(viaCdp.where, "isolated");
    assert.equal(viaCdp.how, "cdp");
});

test("RED TEAM: world \"page\" is refused for a script naming ml.sh, and nothing runs in the main world", () => {
    const r = routeExec(`ml.sh.run(["ls"])`, true, ANY, { world: "page" });
    assert.equal(r.where, "refused");
    assert.equal(r.reason, "sh");
    assert.match(r.result, /runs programs through ml\.sh/, `the refusal names why: ${r.result}`);
});

test("RED TEAM: with no isolated world an ml.sh exec is refused, never run in the page's world", () => {
    const plain = routeExec(`ml.sh.run(["ls"])`, true, NONE);
    assert.equal(plain.where, "refused", "not the main world, and not the pointer fallback");
    assert.equal(plain.reason, "sh");
    assert.match(plain.result, /only an isolated world is given/);
    assert.match(plain.result, /Settings/, "the refusal names the remedy");
    assert.equal(routeExec(`ml.sh.run(["ls"])`, true, NONE, { world: "isolated" }).where, "refused");
});

test("RED TEAM: a pointer in the same script does not earn the main-world fallback that a pointer alone gets", () => {
    // Without isolation a pointer-naming script on an approved page runs in the main world with a note; the SAME script
    // that also names ml.sh must not, since the page would be handed the runner with it.
    const pointerOnly = routeExec(`return ml.dereference("@tool:abc")`, true, NONE);
    assert.equal(pointerOnly.where, "main", "control: the pointer fallback still exists");
    for (const js of [
        `const d = ml.dereference("@tool:abc"); return (await ml.sh.run(["cat"])).ok`,
        `return (await ml.sh.run(["cat"])).ok // @tool:abc`,
        `return (await ml.sh.read("@tool:abc")).text`,
    ]) {
        const r = routeExec(js, true, NONE);
        assert.equal(r.where, "refused", `a pointer AND ml.sh fell through to ${r.where}: ${js}`);
        assert.equal(r.reason, "sh");
    }
});

test("RED TEAM: on a page whose site is not approved, an ml.sh exec is refused rather than run in the page", () => {
    const r = routeExec(`ml.sh.run(["ls"])`, false, NONE);
    assert.equal(r.where, "refused");
    assert.equal(r.reason, "unapproved-page");
});

test("RED TEAM: the spellings execNames cannot read are misses, and they are safe because the page's ml has no sh", () => {
    // `execNames` reads `ml.sh` lexically, so these route `plain`. That is the documented trade-off (a miss is safe:
    // what a script does not name literally is not sent with it), and for ml.sh it holds because window.ml carries no
    // `sh` at all — the page realm's facade below is the dialect-side half of the same claim, so a script taking one of
    // these finds nothing to call in the main world. Each shape is committed here rather than left as a probe.
    for (const js of [
        `return (await ml["sh"].run(["ls"])).ok`,
        `return (await ml?.sh?.run(["ls"])).ok`,
        `ml /* comment */ .sh.run(["ls"])`,
        `const { sh } = ml; return (await sh.run(["ls"])).ok`,
    ]) {
        assert.equal(routeExec(js, true, NONE).where, "main", `the lexical miss routes as documented: ${js}`);
        assert.equal(surveyMayEnterPage(js), true);
    }
    const page = mlFacade({ sh: { run: async () => ({ ok: true }) } }, undefined, undefined, undefined, "page");
    assert.equal("sh" in (page ?? {}), false, "the page realm's ml has no sh, so a miss has nothing to call there");
});

// --- B: every call is judged on its own, and nothing is memoised by the dialect ---

// The judgement is the gate's (sw-shell-call.ts judges each call as it is made: a policy or the built-in default, a card,
// a deny). What the dialect must not do is make a call disappear or reuse a decision: each call reaches the host, with the
// arguments the script passed for THAT call.

test("RED TEAM: the same argv passed twice is two calls to the gate, and neither is coalesced", async () => {
    const h = host();
    await run(`const a = ["ls"]; await ml.sh.run(a); await ml.sh.run(a); await ml.sh.run(["ls"])`, h);
    assert.equal(h.calls.length, 3, JSON.stringify(h.calls));
    assert.ok(h.calls.every((c) => c[1][0] === "ls"), JSON.stringify(h.calls));
    assert.notEqual(h.calls[0][1], h.calls[1][1], "each call hands the gate its own copy");
});

test("RED TEAM: a call the gate refuses does not carry into the next one", async () => {
    const h = host();
    const declining = { ...h.ml, sh: { ...h.ml.sh, run: async (...a) => { h.calls.push(["run", ...a]); if (a[0][0] === "rm") throw Object.assign(new Error("declined"), { code: "Denied" }); return { ok: true }; } } };
    const r = await evalReadonly(`let code = null; try { await ml.sh.run(["rm", "x"]); } catch (e) { code = e.code; } const ok = await ml.sh.run(["ls"]); return [code, ok.ok]`, doc(), declining, undefined, { realm: "worker" });
    assert.deepEqual(r.value, ["Denied", true]);
    assert.deepEqual(h.calls.map((c) => c[1]), [["rm", "x"], ["ls"]], "both calls reached the gate, in the script's order");
});

test("RED TEAM: each call is copied when it is made, so a later write to the script's array reaches only the later call", async () => {
    const h = host();
    await run(`const a = ["ls"]; const p1 = ml.sh.run(a); a[0] = "rm"; const p2 = ml.sh.run(a); await Promise.all([p1, p2])`, h);
    assert.deepEqual(h.calls.map((c) => c[1]), [["ls"], ["rm"]], JSON.stringify(h.calls));
});

// The end-to-end double judgement, which a stand-in host cannot show, is section F at the end of this file: one script,
// two programs, through `tryReadonly` and the real sh gate.

// --- C: the shapes the dialect hands the gate ---

test("RED TEAM: a pointer token in argv reaches the gate as its own characters, and the gate refuses it as a held value", async () => {
    const h = host();
    await run(`return (await ml.sh.run(["cat", "@tool:abc"])).ok`, h);
    assert.deepEqual(h.calls[0][1], ["cat", "@tool:abc"], "the dialect hands the token over, it does not resolve it into a path");
    assert.throws(() => parseShRun(h.calls[0].slice(1)),
        (e) => e instanceof ShRefused && e.code === "BadRequest" && /a held value, not a path/.test(e.message) && /ml\.dereference/.test(e.message),
        "the gate refuses the token itself, naming what to do instead");
});

test("RED TEAM: an argv entry the script built from the page is refused before any call is made", async () => {
    const h = host();
    await assert.rejects(run(`return await ml.sh.run(["cat", document.querySelector("#p")])`, h), (e) => e?.constructor?.name === "NeedsPage" || e?.constructor?.name === "Denied");
    assert.equal(h.calls.length, 0, "nothing reached the gate");
});

test("RED TEAM: a third argument is dropped and the options arrive as inert own data the gate reads by name", async () => {
    const h = host();
    await run(`return await ml.sh.run(["ls"], JSON.parse('{"__proto__":{"polluted":true}}'), { runId: "other", seq: 1 })`, h);
    assert.equal(h.calls[0].length, 3, "name, argv and options only");
    const opts = h.calls[0][2];
    assert.equal(Object.getPrototypeOf(opts), null, "the copy is the script's data, never an object with a prototype to walk");
    assert.throws(() => parseShRun(h.calls[0].slice(1)), (e) => e instanceof ShRefused && /has no option "__proto__"/.test(e.message), "the gate refuses the key by name");
});

// --- D: a script that reads the page and runs a program reaches the person, never the page ---

// Shane's ruling places this case in the isolated world. The worker leg answers a page read `needs-page` and the page leg
// may not be used (the script names ml.sh); with nothing started `guardSurvey` keeps the fall-through, so the real wiring
// hands the script to the person's gate and then an isolated world — the outcome asserted here, not a fall to the main
// world. End to end, with a page read before the call: tests/ml-sh-survey.test.mjs.

test("RED TEAM: a DOM read plus an ml.sh call is answered by neither realm, so the call reaches the person", async () => {
    const withSh = mlFacade(host().ml, undefined, undefined, undefined, "worker");
    const withoutSh = mlFacade({ ...host().ml, sh: undefined }, undefined, undefined, undefined, "worker");
    for (const js of [
        `const t = document.body.innerText; const r = await ml.sh.run(["ls"]); return [t, r.ok]`,
        `const r = await ml.sh.run(["ls"]); const t = document.body.innerText; return [r.ok, t]`,
        `ml.queryAll("p"); return (await ml.sh.run(["ls"])).ok`,
    ]) {
        assert.equal(surveyMayEnterPage(js), false, `the page leg would have been open: ${js}`);
        const out = await evalReadonlyInWorker({ js }, { ml: withSh });
        assert.equal(out.kind, "needs-page", `the worker answered a page read: ${JSON.stringify(out)}`);
        const shipped = await evalReadonlyInWorker({ js }, { ml: withoutSh });
        assert.equal(shipped.kind, "needs-page", `slice 1's faceless worker must still reach the person: ${JSON.stringify(shipped)}`);
    }
});

test("RED TEAM: a survey that reads the page first makes no program call before it is refused", async () => {
    const h = host();
    const out = await evalReadonlyInWorker({ js: `const t = document.body.innerText; return (await ml.sh.run(["ls"])).ok` }, { ml: mlFacade(h.ml, undefined, undefined, undefined, "worker") });
    assert.equal(out.kind, "needs-page");
    assert.equal(h.calls.length, 0, "nothing ran before the survey reached the page it may not have");
});

// --- E: the handoff is plain data, in the shapes a script actually writes ---

// `plainCopy`'s contract (policy.ts) is what the gate is promised: strings, finite numbers, booleans, null, and arrays and
// plain objects of those, by own data properties, with a hole or an accessor refused. These are the shapes a model writes
// for a program call, and the three promises that did not hold at 26d7eb73.

test("RED TEAM: a pointer's text is an argv entry — the String object ml.dereference returns is its string", async () => {
    const h = host();
    // The natural spelling for handing a stored text to a program, and the shape the isolated world exists to serve.
    const r = await run(`return (await ml.sh.run(["cat", ml.dereference("@tool:abc")])).ok`, h);
    assert.equal(r.value, true);
    assert.deepEqual(h.calls[0][1], ["cat", "THE STORED TEXT of @tool:abc"], "the gate gets the string, as it does from String(d)");
    // Control: the same value written as a primitive works, so what is refused is the String OBJECT, not the text.
    const h2 = host();
    await run(`const d = ml.dereference("@tool:abc"); return (await ml.sh.run(["cat", String(d)])).ok`, h2);
    assert.deepEqual(h2.calls[0][1], ["cat", "THE STORED TEXT of @tool:abc"]);
});

test("RED TEAM: an argv with a hole is refused by the dialect, not handed to the gate as a sparse array", async () => {
    const h = host();
    await assert.rejects(run(`const a = []; a[1] = "ls"; return await ml.sh.run(a)`, h),
        (e) => e instanceof TypeError && /hole/.test(e.message), "plainCopy promises to refuse a hole");
    await assert.rejects(run(`const a = new Array(2); a[1] = "ls"; return await ml.sh.run(a)`, h),
        (e) => e instanceof TypeError && /hole/.test(e.message));
    assert.equal(h.calls.length, 0, "the gate was handed a sparse argv");
});

test("RED TEAM: an omitted second argument written as undefined is the absence the gate already treats it as", async () => {
    const h = host();
    await run(`const opts = undefined; return (await ml.sh.run(["ls"], opts)).ok`, h);
    assert.deepEqual(h.calls[0], ["run", ["ls"], undefined], "the gate reads undefined as no options, as it reads null");
    const h2 = host();
    await run(`return (await ml.sh.read("p", undefined)).ok`, h2);
    assert.deepEqual(h2.calls[0], ["read", "p", undefined], "read's range is optional in the same way");
});

// --- F: the real wiring, one script, two programs, each call judged where it is made ---

// Sections A-E hand the dialect a stand-in host, so they pin the SHAPE of each call and nothing about the gate. These
// rows run the same script through the worker's own survey (sw-run-host.ts `tryReadonly` → sw-survey-sh.ts `surveySh`,
// then `guardSurvey`) against the REAL sh gate and the fake process host (tests/isolated-harness.mjs,
// tests/fake-native-host.mjs): the call the built-in default allows starts with no card, the next call is judged on its
// own, and its card is raised between the two starts. MEASURED at d44f67fd by making `surveySh` answer every later call
// with the first call's answer (`ok`, no judge — a per-survey allow memo): F1 reds with 0 cards where 1 is owed, and F2
// reds with 2 starts where the second call was declined.

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };

/** A script that runs each argv in turn, catching what the gate throws, and reports every outcome in the script's order. */
const each = (argvs) => () => `(async () => {
    const out = [];
    for (const argv of ${JSON.stringify(argvs)}) {
        try { const r = await ml.sh.run(argv); out.push({ argv, ok: r.ok, code: r.code }); }
        catch (e) { out.push({ argv, threw: e.message, code: e.code }); }
    }
    return JSON.stringify({ out });
})()`;
const inside = (result) => { const m = /^value: (.*)$/m.exec(result) ?? /^({.*\})$/m.exec(result); assert.ok(m, `no value in: ${result}`); return JSON.parse(m[1]).out; };
/** Answer each nested ask with the next of `decisions`, recording the ask and how many programs had STARTED when it was raised. */
function answering(host, decisions) {
    const asked = [];
    return {
        asked,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) {
                if (a.state !== "pending" || asked.some((x) => x.id === a.id)) continue;
                asked.push({ id: a.id, starts: host.names().filter((n) => n === "start").length });
                void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: decisions[Math.min(asked.length - 1, decisions.length - 1)] } });
            }
        },
    };
}
/** The programs that actually STARTED, in order: a call is spawned once to judge it (facts, the card) and started after. */
const started = (host) => host.calls.filter((c) => c.call === "start").map((c) => host.calls.find((s) => s.call === "spawn" && s.id === c.args.id)?.args.argv.join(" ") ?? c.args.id);
const legs = (r) => r.log.filter((x) => x.kind.startsWith("readonly-") || x.kind.startsWith("exec-")).map((x) => [x.kind, x.reason]);

test("RED TEAM: one script running `ls` then `python3 x.py` is judged twice — one card, and two starts in the script's order", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "ok\n", err: "", code: 0 }) });
    const ask = answering(host, [true]);
    const r = await runOn("readonly", [each([["ls"], ["python3", "x.py"]])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    // The worker answered the script, so neither start below is a second leg re-running it.
    assert.deepEqual(legs(r), [["readonly-worker", "no-page-reads"]], `the script was run again on another leg: ${JSON.stringify(legs(r))}`);
    assert.deepEqual(started(host), ["ls", "python3 x.py"], `the programs that started, in order: ${JSON.stringify(started(host))}`);
    // ONE card, raised after the default-allowed call had already started: the first call's allow did not answer for the second.
    assert.equal(ask.asked.length, 1, `the person was asked ${ask.asked.length} times: ${JSON.stringify(ask.asked)}`);
    assert.equal(ask.asked[0].starts, 1, `the card was not raised between the two starts: ${JSON.stringify(ask.asked)}`);
    assert.deepEqual(inside(r.results[0]).map((o) => [o.argv.join(" "), o.ok]), [["ls", true], ["python3 x.py", true]], `the script's own outcomes: ${r.results[0]}`);
});

test("RED TEAM: two programs that each need an answer get a card each, and the second's decline starts nothing", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "ok\n", err: "", code: 0 }) });
    const ask = answering(host, [true, false]);
    const r = await runOn("readonly", [each([["python3", "a.py"], ["python3", "b.py"]])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.deepEqual(legs(r), [["readonly-worker", "no-page-reads"]], `the script was run again on another leg: ${JSON.stringify(legs(r))}`);
    // A card per call, each raised after exactly the starts before it: an allow that answered for a later call would show
    // as one card here, or as none.
    assert.deepEqual(ask.asked.map((a) => a.starts), [0, 1], `one card per call, raised in the script's order: ${JSON.stringify(ask.asked)}`);
    assert.deepEqual(started(host), ["python3 a.py"], `a declined call started anyway: ${JSON.stringify(started(host))}`);
    const out = inside(r.results[0]);
    assert.equal(out[0].ok, true, JSON.stringify(out));
    assert.equal(out[1].code, "Denied", `the declined call did not reach the script as Denied: ${JSON.stringify(out[1])}`);
});
