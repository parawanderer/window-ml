// readonly-sh.test.mjs — `ml.sh.run` and `ml.sh.read` as read-only dialect members (src/readonly-exec/policy.ts `mlFacade`,
// `SH_READONLY_METHODS`, evaluator.ts `onSh`): what a survey can do with them, and the ADVERSARIAL probes the dialect's rule
// asks for (docs/dev/readonly-exec.md, "The rule for extending the dialect"). The worker's survey only: another realm has
// no `ml.sh`, and the call's own judging (a policy, the built-in default, a nested ask, a deny) is the host's, in sw-shell-call.ts.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied, NeedsPage } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;
let PUT_RAN = 0, GETTER_RAN = 0;

/** An `ml` whose `sh` records what reached it, and refuses `rm` the way a declined card does (a catchable error with a code). */
function host() {
    const calls = [];
    const refuse = (msg) => Object.assign(new Error(msg), { code: "Denied" });
    const sh = {
        run: async (argv, opts) => { calls.push(["run", argv, opts]); if (argv[0] === "rm") throw refuse("ml.sh: the person declined"); return { ok: true, code: 0, stdout: { text: `${argv.join(" ")}\n` } }; },
        read: async (...a) => { calls.push(["read", ...a]); return { ok: true }; },
        put: async () => { PUT_RAN++; return { ok: true }; },
    };
    return { ml: { sh, range: (n) => Array.from({ length: n }, (_, i) => i) }, calls };
}
const run = (js, h = host(), opts = { realm: "worker" }) => evalReadonly(js, doc(), h.ml, undefined, opts);
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;

// --- what it is for: a script of read-only work and program calls runs in the dialect, with each call going to the host ---

test("a survey runs a program and reads its output, and the host gets a plain argv", async () => {
    const h = host();
    const r = await run(`const r = await ml.sh.run(["ls", "-la"]); return r.stdout.text`, h);
    assert.equal(r.value, "ls -la\n");
    assert.deepEqual(h.calls, [["run", ["ls", "-la"], undefined]]);
});

test("several calls in one survey, in a loop and in parallel, each reach the host", async () => {
    const h = host();
    const r = await run(`
        const out = [];
        for (const f of ["a", "b"]) out.push((await ml.sh.run(["wc", "-l", f])).stdout.text.trim());
        const both = await Promise.all([ml.sh.run(["ls"]), ml.sh.run(["pwd"])]);
        return [out, both.length]`, h);
    assert.deepEqual(r.value, [["wc -l a", "wc -l b"], 2]);
    assert.equal(h.calls.length, 4);
});

test("a refusal is a catchable error with its code, so a script can carry on past a call the person declined", async () => {
    const r = await run(`let note = null; try { await ml.sh.run(["rm", "x"]); } catch (e) { note = e.code; } const ok = await ml.sh.run(["ls"]); return [note, ok.ok]`);
    assert.deepEqual(r.value, ["Denied", true]);
});

// --- what it is not: nothing outside run and read, in any realm but the worker's ---

test("ml.sh.put is not in the dialect: the script is put to the person whole, and nothing wrote", async () => {
    const before = PUT_RAN;
    await assert.rejects(run(`await ml.sh.put("a", "b")`), outOfDialect);
    assert.equal(PUT_RAN, before);
});

test("the page's realm has no ml.sh: a survey naming it there is not in the dialect", async () => {
    const h = host();
    await assert.rejects(run(`await ml.sh.run(["ls"])`, h, { realm: "page" }), (e) => outOfDialect(e) || e instanceof NeedsPage || e instanceof TypeError);
    assert.equal(h.calls.length, 0, "nothing reached the host from the page's realm");
});

// --- adversarial: what a hostile script must not get from it ---

test("the member cannot be replaced, deleted or extended, and an alias still goes through the same two names", async () => {
    await assert.rejects(run(`ml.sh.run = () => 1`), outOfDialect);
    await assert.rejects(run(`ml.sh.extra = () => 1`), outOfDialect);
    await assert.rejects(run(`delete ml.sh.run`), outOfDialect);
    await assert.rejects(run(`ml.sh = {}`), outOfDialect);
    const r = await run(`const s = ml.sh; return (await s.run(["ls"])).ok`);
    assert.equal(r.value, true);
    await assert.rejects(run(`const s = ml.sh; await s.put("a", "b")`), outOfDialect);
});

test("a detached function, a call through call/apply/bind, or a computed name is not callable", async () => {
    await assert.rejects(run(`const f = ml.sh.run; return await f(["ls"])`), outOfDialect);
    await assert.rejects(run(`return await ml.sh.run.call(null, ["ls"])`), outOfDialect);
    await assert.rejects(run(`return await ml.sh.run.apply(null, [["ls"]])`), outOfDialect);
    await assert.rejects(run(`return await ml.sh["pu" + "t"]("a", "b")`), outOfDialect);
    await assert.rejects(run(`const k = "constructor"; return ml.sh[k]`), outOfDialect);
});

test("only plain data reaches the host: an argument the script built from anything else is refused, never read through", async () => {
    const h = host();
    await assert.rejects(run(`await ml.sh.run([() => "x"])`, h), (e) => !(e instanceof TypeError && /x$/.test(e.message)));
    await assert.rejects(run(`await ml.sh.run([Symbol("x")])`, h));
    await assert.rejects(run(`await ml.sh.run([ml])`, h), (e) => /plain data|not allowed|Cannot/.test(e.message) || outOfDialect(e));
    assert.equal(h.calls.length, 0, "no refused argument reached the host");
});

test("the arguments the host gets are copies: the script's array and options are not what it holds", async () => {
    const h = host();
    await run(`const argv = ["ls"]; const opts = { cwd: "/w" }; const p = ml.sh.run(argv, opts); argv.push("--oops"); opts.cwd = "/etc"; await p`, h);
    assert.deepEqual(h.calls[0][1], ["ls"]);
    assert.deepEqual({ ...h.calls[0][2] }, { cwd: "/w" });
    assert.notEqual(h.calls[0][1], undefined);
});

test("a result the host hands back cannot be written through: its objects are not the script's to mutate", async () => {
    await assert.rejects(run(`const r = await ml.sh.run(["ls"]); r.stdout.text = "changed"`), outOfDialect);
});

test("a third argument and extra arguments from the script are dropped, so it cannot pass its own context", async () => {
    const h = host();
    await run(`await ml.sh.run(["ls"], { cwd: "/w" }, { runId: "other", seq: 1 })`, h);
    assert.equal(h.calls[0].length, 3, "name, argv and options only");
});

test("a survey with a call that never returns still stops when the run does", async () => {
    const h = host();
    h.ml.sh.run = () => new Promise(() => {});
    const ctl = new AbortController();
    const p = run(`await ml.sh.run(["sleep", "9"])`, h, { realm: "worker", signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(p);
});

// --- halting: a program's time is the host's, not the step budget's ---

test("a loop of calls does not spend the step budget while each waits, and a tight loop of nothing still does", async () => {
    const h = host();
    const r = await run(`let n = 0; for (const i of ml.range(40)) { await ml.sh.run(["true"]); n++; } return n`, h, { realm: "worker", stepBudget: 3000 });
    assert.equal(r.value, 40);
    await assert.rejects(run(`while (true) {}`, h, { realm: "worker", stepBudget: 500 }));
});
