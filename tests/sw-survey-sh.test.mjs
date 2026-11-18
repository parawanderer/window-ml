// sw-survey-sh.test.mjs — a survey that has started an `ml.sh` call is never run again (src/sw/sw-survey-sh.ts, docs/dev/readonly-exec.md,
// "ml.sh in the worker's survey"): every exit that would send the script on to the page, the person's approval or an isolated world
// becomes the step's final result, and a survey that started nothing keeps the fall-through.
import { test } from "node:test";
import assert from "node:assert";
import { evalReadonlyInWorker } from "../src/sw/sw-readonly.ts";
import { surveySh, guardSurvey } from "../src/sw/sw-survey-sh.ts";

const ctx = (signal = new AbortController().signal) => ({ runId: "r", seq: 1, local: { seq: 1, step: 1 }, signal, tokens: {} });
/** Stands in for the worker's shRun/shRead: answers by program, records every call it receives. */
function stand(answers = {}) {
    const calls = [];
    const via = async (_c, a) => {
        const prog = Array.isArray(a[0]) ? a[0][0] : a[0];
        calls.push(prog);
        if (typeof answers[prog] === "function") return answers[prog]();
        return answers[prog] ?? { ok: { ok: true, code: 0, stdout: { text: `SECRET OUTPUT OF ${prog}` } } };
    };
    return { calls, via: { run: via, read: via } };
}
const survey = (js, sh, signal) => guardSurvey(sh, () => evalReadonlyInWorker({ js }, { ml: { sh: sh.host, range: (n) => Array.from({ length: n }, (_, i) => i) }, signal }));

// --- a survey that started a program is never run again, on any exit ---

test("a call that ran, then a page read: the survey is stopped with a final result, not handed on", async () => {
    const s = stand(), sh = surveySh(ctx(), s.via);
    const w = await survey(`await ml.sh.run(["git", "status"]); return ml.queryAll("p")`, sh);
    assert.equal(w.kind, "stopped");
    assert.equal(w.why, "needs-page");
    assert.deepEqual(s.calls, ["git"], "the program ran once, in the survey");
    assert.match(w.result.result, /^Error: this script started 1 ml\.sh call \(git: ok\) and then reached for the page/);
    assert.match(w.result.result, /NOT run again/);
    assert.ok(!/SECRET OUTPUT/.test(w.result.result), "no output: it has not been through the bounds a result goes through");
});

test("a call that ran, then a member outside the dialect: stopped, whatever the refusal was", async () => {
    for (const tail of [`ml.sh.put("x", "y")`, `ml.setModel("m")`, `document.title`, `new Function("1")`]) {
        const s = stand(), sh = surveySh(ctx(), s.via);
        const w = await survey(`await ml.sh.run(["ls"]); return ${tail}`, sh);
        assert.equal(w.kind, "stopped", tail);
        assert.deepEqual(s.calls, ["ls"], `${tail}: the program ran once`);
    }
});

test("a call the person declined, then a page read: still stopped (a denied call is a started call)", async () => {
    const s = stand({ rm: { error: "ml.sh: the person declined", code: "Denied" } }), sh = surveySh(ctx(), s.via);
    const w = await survey(`try { await ml.sh.run(["rm", "x"]); } catch (e) {} return ml.queryAll("p")`, sh);
    assert.equal(w.kind, "stopped");
    assert.match(w.result.result, /rm: denied/);
});

test("a call that errors with its code stays catchable, and an unhandled script error is the script's own answer", async () => {
    const s = stand({ ls: { error: "ml.sh: nope", code: "Failed" } }), sh = surveySh(ctx(), s.via);
    const w = await survey(`await ml.sh.run(["ls"])`, sh);
    assert.equal(w.kind, "answered", "the script threw its own error after a call: that is a result, and nothing falls through");
    assert.match(w.result, /^Error:/, "its error text is scrubbed by the same check every error the model reads goes through");
});

test("any other throw out of the survey after a call is a stop too", async () => {
    const s = stand(), sh = surveySh(ctx(), s.via);
    const w = await guardSurvey(sh, async () => { await sh.host.run(["ls"]); throw new Error("host fell over"); });
    assert.equal(w.kind, "stopped");
    assert.equal(w.why, "threw");
    assert.deepEqual(s.calls, ["ls"]);
});

test("several calls are all named, by program and outcome", async () => {
    const s = stand({ rm: { error: "no", code: "Denied" } }), sh = surveySh(ctx(), s.via);
    const w = await survey(`await ml.sh.run(["/usr/bin/ls"]); try { await ml.sh.run(["rm"]); } catch (e) {} await ml.sh.read("p"); return ml.queryAll("p")`, sh);
    assert.match(w.result.result, /started 3 ml\.sh calls \(ls: ok; rm: denied; read: ok\)/);
});

// --- when it counts: before the judge, so a call waiting on the person blocks the re-run ---

test("a call is counted before its answer: one still waiting on the person's ask already blocks the re-run", async () => {
    let release;
    const s = stand({ sleep: () => new Promise((r) => { release = r; }) }), sh = surveySh(ctx(), s.via);
    const p = survey(`ml.sh.run(["sleep"]); return ml.queryAll("p")`, sh);   // not awaited: the script moves on to the page read
    const w = await p;
    assert.equal(sh.started.length, 1, "counted at the call, not at the answer");
    assert.equal(w.kind, "stopped");
    assert.match(w.result.result, /sleep: running/);
    release({ ok: { ok: true } });
});

test("Stop mid-call: the abort is the call's outcome, and the survey is not run again", async () => {
    const ac = new AbortController();
    const s = stand({ sleep: () => new Promise((_r, rej) => ac.signal.addEventListener("abort", () => rej(new Error("aborted")))) }), sh = surveySh(ctx(ac.signal), s.via);
    const p = survey(`await ml.sh.run(["sleep"]); return 1`, sh, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const w = await p;
    assert.ok(w.kind === "answered" || w.kind === "stopped", "a final result either way: never needs-page or refused");
    assert.equal(sh.started[0].outcome, "aborted");
    assert.deepEqual(s.calls, ["sleep"]);
});

// --- what is unchanged: no call started, no new rule ---

test("a page read BEFORE any call keeps the fall-through, and a script naming no ml.sh is untouched", async () => {
    const s = stand(), sh = surveySh(ctx(), s.via);
    const w = await survey(`const t = ml.queryAll("p"); return (await ml.sh.run(["ls"])).ok`, sh);
    assert.equal(w.kind, "needs-page");
    assert.deepEqual(s.calls, [], "nothing ran before the survey reached the page");
    const none = await guardSurvey(undefined, () => evalReadonlyInWorker({ js: `return ml.queryAll("p")` }, { ml: { range: (n) => Array.from({ length: n }, (_, i) => i) } }));
    assert.equal(none.kind, "needs-page");
});

test("a finished survey with calls is its own answer", async () => {
    const s = stand(), sh = surveySh(ctx(), s.via);
    const w = await survey(`return (await ml.sh.run(["ls"])).stdout.text`, sh);
    assert.equal(w.kind, "answered");
    assert.match(w.result, /SECRET OUTPUT OF ls/);
});
