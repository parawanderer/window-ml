// interview.mjs (the part panel.mjs, converse.mjs and the bench share): the per-turn report a model reads, the
// follow-up driver, a person's marks turned into checks, and the endpoint that stores a mark. No browser and no model:
// every input is a fixture whose right reading is known. The page that shows the answers: bench-page.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    turnReport, parseTurnReport, readTurns, interviewDriver, interviewBench, checkMarks, validMark, panelSummary, loadInterview,
    readFollowUps, expectTally, loadInterviewFile, isInterviewFile, isInterviewTask, askText,
} from "../tests/e2e/interview.mjs";
const { defineInterview } = await import("../tests/e2e/bench/spec.ts");
import { startDashboard } from "../tests/e2e/bench/serve.mjs";
import { cellKey } from "../tests/e2e/bench/cells.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "interview-"));
/** A finished tool step and the turn's result, as the debug stream carries them. */
const step = (ts, tool, args = {}, result = "ok") => ({ kind: "agent-step", ts, tool, arguments: args, result });
const answer = (ts, summary) => ({ kind: "agent-result", ts, summary });

// --- the per-turn report: written for a model, parsed back for the summary ---

test("a turn report parses back to its answer, its tools in order, and whether it hit the cap", () => {
    const events = [step(1, "exec", { js: "1" }), step(2, "findByText"), step(3, "chat_metadata"), answer(4, "The total is 4.")];
    const md = turnReport(1, events, 0, { summary: "The total is 4." });
    assert.deepEqual(parseTurnReport(md), { answer: "The total is 4.", tools: ["exec", "findByText", "chat_metadata"], capped: false },
        "a camelCase tool name is a call too");
    const capped = turnReport(2, [], 3, { summary: "Stopped at the 20-step cap." });
    assert.equal(parseTurnReport(capped).capped, true);
});

test("a turn report holds only the steps after the previous turn", () => {
    const events = [step(1, "exec"), answer(2, "a"), step(3, "look"), answer(4, "b")];
    assert.deepEqual(parseTurnReport(turnReport(2, events, 2, { summary: "b" })).tools, ["look"]);
});

// --- the follow-up driver ---

test("the driver asks each follow-up in order, writes every turn, then ends the session", async () => {
    const dir = tmp();
    const { nextTurn, statuses } = interviewDriver({ asks: ["second?", "third?"], dir });
    const ev = [step(1, "exec"), answer(2, "one")];
    assert.equal(await nextTurn({ turn: 1, result: { summary: "one" }, events: ev }), "second?");
    ev.push(answer(3, "two"));
    assert.equal(await nextTurn({ turn: 2, result: { summary: "two" }, events: ev }), "third?");
    ev.push(step(4, "look"), answer(5, "three"));
    assert.equal(await nextTurn({ turn: 3, result: { summary: "three" }, events: ev }), null, "after the last ask, the session ends");
    const turns = readTurns(dir);
    assert.deepEqual(turns.map((t) => t.answer), ["one", "two", "three"]);
    assert.deepEqual(turns.map((t) => t.tools), [["exec"], [], ["look"]]);
    assert.equal(statuses.length, 3);
    assert.match(fs.readFileSync(path.join(dir, "status"), "utf8"), /turn 3 done/);
});

test("a turn with no answer of its own ends the interview, and is not credited with the last turn's answer", async () => {
    const dir = tmp();
    const { nextTurn, statuses } = interviewDriver({ asks: ["second?", "third?"], dir });
    const ev = [answer(1, "one")];
    await nextTurn({ turn: 1, result: { summary: "one" }, events: ev });
    // Turn 2 timed out: runOnce hands over the LAST agent-result it has, which is turn 1's.
    assert.equal(await nextTurn({ turn: 2, result: { summary: "one" }, events: ev }), null);
    assert.match(readTurns(dir)[1].answer, /did not finish/);
    assert.match(statuses.at(-1), /timed out in turn 2/);
});

// --- interviews as code: a check on each answer, and follow-ups an answer calls for ---

test("each turn's check runs on its answer and steps; a check that throws counts as not expected", async () => {
    const dir = tmp();
    const { nextTurn } = interviewDriver({ dir, task: "find it", expect: (t) => t.tools.includes("findByText"), why: "it searched",
        asks: [{ ask: "which tool?", expect: (t, run) => t.answer.includes(run.turns[0].tools[0]), why: "names the tool it used" }, { ask: "boom?", expect: () => { throw new Error("bad check"); } }, "free?"] });
    const ev = [step(1, "findByText", { text: "x" }), answer(2, "found")];
    assert.equal(await nextTurn({ turn: 1, result: { summary: "found" }, events: ev }), "which tool?");
    ev.push(answer(3, "I used findByText"));
    assert.equal(await nextTurn({ turn: 2, result: { summary: "I used findByText" }, events: ev }), "boom?");
    ev.push(answer(4, "?"));
    assert.equal(await nextTurn({ turn: 3, result: { summary: "?" }, events: ev }), "free?");
    ev.push(answer(5, "ok"));
    assert.equal(await nextTurn({ turn: 4, result: { summary: "ok" }, events: ev }), null);
    const turns = readTurns(dir);
    assert.deepEqual(turns.map((t) => t.expect ?? null), [true, true, false, null]);
    assert.equal(turns[1].why, "names the tool it used");
    assert.match(turns[2].expectError, /bad check/);
    assert.deepEqual(expectTally(turns), { passed: 2, total: 3 });
    assert.equal(expectTally([{ answer: "" }]), null, "nothing checked: no tally");
});

test("a follow-up is asked after its turn when the answer calls for it, once, and is kept apart from the interview's turns", async () => {
    const dir = tmp();
    const { nextTurn } = interviewDriver({ dir, task: "find it", asks: ["which tool?", "anything else?"],
        followUps: [
            { after: 2, when: (t) => !/exec/.test(t.answer), ask: (t) => `You said "${t.answer}". Why not exec?` },
            { after: 2, when: () => true, ask: "And the cost?" },
            { after: 1, when: () => false, ask: "never" },
        ] });
    const ev = [answer(1, "found")];
    assert.equal(await nextTurn({ turn: 1, result: { summary: "found" }, events: ev }), "which tool?", "after turn 1 nothing is called for");
    ev.push(answer(2, "findByText"));
    assert.equal(await nextTurn({ turn: 2, result: { summary: "findByText" }, events: ev }), 'You said "findByText". Why not exec?');
    ev.push(answer(3, "it was enough"));
    assert.equal(await nextTurn({ turn: 3, result: { summary: "it was enough" }, events: ev }), "And the cost?", "a second follow-up of the same turn, judged on that turn");
    ev.push(answer(4, "cheap"));
    assert.equal(await nextTurn({ turn: 4, result: { summary: "cheap" }, events: ev }), "anything else?", "then the interview goes on");
    ev.push(answer(5, "no"));
    assert.equal(await nextTurn({ turn: 5, result: { summary: "no" }, events: ev }), null);
    const turns = readTurns(dir, 3);
    assert.deepEqual(turns.map((t) => t.answer), ["found", "findByText", "no"], "the interview's own turns, by their place in it");
    assert.equal(turns[2].n, 5, "turn 3 of the interview was turn 5 of the session");
    assert.deepEqual(readFollowUps(dir).map((f) => [f.after, f.n, f.answer]), [[2, 3, "it was enough"], [2, 4, "cheap"]]);
});

test("defineInterview checks its shape; a .interview.ts file loads and becomes a bench task carrying its checks and follow-ups", async () => {
    assert.throws(() => defineInterview({ task: " " }), /no task/);
    assert.throws(() => defineInterview({ task: "t", asks: [{ ask: "" }] }), /no text/);
    assert.throws(() => defineInterview({ task: "t", followUps: [{ ask: "x" }] }), /when/);
    const dir = tmp();
    const file = path.join(dir, "probe-tools.interview.ts");
    fs.writeFileSync(file, `import { defineInterview } from ${JSON.stringify(path.resolve("tests/e2e/bench/spec.ts"))};
export default defineInterview({ about: "a", surface: "hud", task: { ask: "find it", expect: (t) => t.answered, why: "answered" },
    asks: ["which tool?", { ask: "why?", expect: (t) => t.answer.length > 0 }], followUps: [{ when: () => true, ask: "more?" }] });
`);
    assert.ok(isInterviewFile(file) && isInterviewFile("x/bloat.json") && !isInterviewFile("x/smoke.bench.ts"));
    const iv = await loadInterviewFile(file);
    assert.equal(iv.name, "probe-tools");
    const [task] = interviewBench(iv, ["m"]).tasks;
    assert.equal(task.task, "find it");
    assert.equal(task.why, "answered");
    assert.equal(typeof task.expect, "function");
    assert.deepEqual(task.asks.map(askText), ["which tool?", "why?"]);
    assert.equal(task.followUps.length, 1);
    assert.equal(task.surface, "hud");
    assert.ok(isInterviewTask(task) && isInterviewTask({ task: "t", followUps: [{}] }) && !isInterviewTask({ task: "t" }));
    await assert.rejects(loadInterviewFile(path.join(dir, "x.interview.ts")), /Cannot find|ERR_MODULE_NOT_FOUND|not exist/);
});

test("the summary says how many answers were as expected, which were not and why, and each follow-up under its answer", () => {
    const iv = { task: "find it", asks: [{ ask: "which tool?" }] };
    const turns = [{ answer: "found", tools: [], capped: false, expect: true }, { answer: "exec", tools: [], capped: false, expect: false, why: "names findByText" }];
    const md = panelSummary("p", iv, [{ model: "m", turns, statuses: [], prompt: "1", expected: 2,
        followUps: [{ after: 2, n: 3, ask: "Why exec?", answer: "habit", tools: [], capped: false }] }], [], null);
    assert.match(md, /\| as expected \|/);
    assert.match(md, /\| `m` \| .* \| 1\/2 \|/);
    assert.match(md, /> which tool\?/);
    assert.match(md, /- NOT as expected: names findByText/);
    assert.match(md, /- follow-up \(turn 3\): Why exec\?\n\n> habit/);
});

// --- an interview file as a bench spec ---

test("an interview becomes one task over a model dimension, run once each, with no predicate", () => {
    const dir = tmp();
    const file = path.join(dir, "review.json");
    fs.writeFileSync(file, JSON.stringify({ task: "do it", asks: ["review it"], about: "why", surface: "hud", sharedWatches: ["x"] }));
    const iv = loadInterview(file);
    const spec = interviewBench(iv, ["a", "b"]);
    assert.equal(spec.name, "panel-review");
    assert.equal(spec.repeats, 1);
    assert.deepEqual(spec.dimensions, { model: ["a", "b"] });
    assert.deepEqual(spec.apply({ model: "b" }), { backend: { model: "b" } });
    const [t] = spec.tasks;
    assert.deepEqual([t.id, t.task, t.asks, t.surface, t.sharedWatches], ["review", "do it", ["review it"], "hud", ["x"]]);
    assert.equal(t.succeeded, undefined, "a reader is not scored");
    assert.equal(interviewBench(iv, ["a"], { surface: "console" }).tasks[0].surface, null, "--surface console overrides the file's hud");
});

test("an interview file without a task, or with asks that are not strings, is refused", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ asks: ["x"] }));
    fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ task: "t", asks: "x" }));
    assert.throws(() => loadInterview(path.join(dir, "a.json")), /no "task"/);
    assert.throws(() => loadInterview(path.join(dir, "b.json")), /asks/);
});

test("cellKey: an interview's fields are part of a cell's identity, and a cell without them keeps its old key", () => {
    const base = { combo: { model: "m" }, task: { id: "a", task: "t" }, repeat: 0, effects: {} };
    const k = cellKey(base, "c");
    // Pinned: the key this cell had BEFORE these fields existed, so adding them did not discard every cached sweep.
    assert.equal(k, "6855caf87529df46");
    assert.equal(cellKey({ ...base, task: { ...base.task, asks: undefined, surface: null } }, "c"), k);
    for (const extra of [{ asks: ["q"] }, { surface: "hud" }, { sharedWatches: ["x"] }, { watchNotes: { x: "n" } }]) {
        assert.notEqual(cellKey({ ...base, task: { ...base.task, ...extra } }, "c"), k, JSON.stringify(extra));
    }
    assert.notEqual(cellKey({ ...base, effects: { surface: "hud" } }, "c"), k);
});

// --- a person's marks, and the checks they become ---

test("a mark is checked against the same model's later answer at the same turn, verbatim up to case and spacing", () => {
    const mark = { id: "m1", taskId: "t", who: "a", turn: 2, quote: "The snapshot  EXCLUDES the current call", note: "it does not", hash: "h1" };
    const run = (hash, ans) => ({ taskId: "t", who: "a", hash, turns: [{ answer: "x" }, { answer: ans }] });
    assert.deepEqual(checkMarks(run("h1", "… the snapshot excludes the current call …"), [mark])[0],
        { id: "m1", turn: 2, quote: mark.quote, note: "it does not", by: "unknown", at: null, here: true, still: true });
    const later = checkMarks(run("h2", "the snapshot\nexcludes the current call"), [mark])[0];
    assert.equal(later.here, false);
    assert.equal(later.still, true, "a line rewrapped is still the same line");
    assert.equal(checkMarks(run("h3", "It includes the current call."), [mark])[0].still, false);
    assert.equal(checkMarks({ ...run("h4", ""), turns: [{ answer: "x" }] }, [mark])[0].still, null, "no answer at that turn: unknown, not passed");
    assert.deepEqual(checkMarks({ ...run("h5", "excludes"), who: "b" }, [mark]), [], "another model's answer is not checked");
    assert.deepEqual(checkMarks({ ...run("h6", "excludes"), taskId: "u" }, [mark]), [], "nor another interview's");
});

test("a quote selected from the RENDERED answer matches the raw markdown the model sent, and an old raw quote still does", () => {
    const answer = "1. **Cut** the `title` clause: see [the docs](https://x.test/a_b).\n2. | col | _two_ |";
    const run = { taskId: "t", who: "a", hash: "h", turns: [{ answer }] };
    const mark = (quote) => ({ id: quote, taskId: "t", who: "a", turn: 1, quote, hash: null });
    // What a browser's selection gives from the markdown view: no list number, no `**`, no backticks, the link's text.
    const rendered = mark("Cut the title clause: see the docs.");
    // UPGRADE: a mark made before answers rendered as markdown quoted the raw text, syntax and all.
    const raw = mark("**Cut** the `title` clause");
    const table = mark("col two");
    const wrong = mark("Keep the title clause");
    assert.deepEqual(checkMarks(run, [rendered, raw, table, wrong]).map((c) => [c.id, c.still]),
        [[rendered.id, true], [raw.id, true], [table.id, true], [wrong.id, false]]);
});

test("a mark from the page is accepted only with its fields typed and bounded", () => {
    const ok = { taskId: "t", who: "a", turn: 1, quote: "q" };
    assert.deepEqual(validMark(ok), { taskId: "t", who: "a", turn: 1, quote: "q", note: "", hash: null });
    for (const bad of [null, "x", { ...ok, taskId: "" }, { ...ok, who: 3 }, { ...ok, turn: 0 }, { ...ok, turn: 1.5 },
        { ...ok, quote: "", note: "" }, { ...ok, quote: "x".repeat(4001) }, { ...ok, hash: {} }]) {
        assert.equal(validMark(bad), null, JSON.stringify(bad)?.slice(0, 80));
    }
});

test("the summary names skipped models, ends, and the checks on each answer", () => {
    const md = panelSummary("rev", { task: "do it", asks: ["review"] }, [
        { model: "a", turns: [{ answer: "fine", tools: ["exec"], capped: false }, { answer: "it excludes x", tools: [], capped: false }],
            statuses: [], prompt: "1,000", expected: 2,
            checks: [{ turn: 2, quote: "excludes x", note: "wrong", here: false, still: true }] },
        { model: "b", turns: [{ answer: "ok", tools: [], capped: false }], statuses: ["timed out in turn 2"], prompt: "?", expected: 2 },
    ], [{ model: "c", why: "HTTP 404" }], "hud");
    assert.match(md, /`c`: HTTP 404/);
    assert.match(md, /\| `a` \| 1 \/ 0 \| all turns \|/);
    assert.match(md, /\| `b` \| 0 \| after turn 1: timed out in turn 2 \|/);
    assert.match(md, /- still says a line marked wrong: "excludes x" \(wrong\)/);
});

// --- storing a mark: POST /mark ---

test("POST /mark stores a mark through onMark, takes JSON only, and refuses what is not a mark", async () => {
    const got = [];
    const d = await startDashboard({ artifactRoot: tmp(), port: 0, onMark: async (b) => { const m = validMark(b); if (m) got.push(m); return m; } });
    const post = (body, type = "application/json") => fetch(`${d.url}/mark`, { method: "POST", headers: { "content-type": type }, body });
    try {
        const mark = { taskId: "t", who: "a", turn: 1, quote: "q", note: "n" };
        assert.equal((await post(JSON.stringify(mark))).status, 200);
        assert.equal((await post(JSON.stringify(mark), "text/plain")).status, 415,
            "text/plain is what another origin can send without a preflight");
        assert.equal((await post("{not json")).status, 400);
        assert.equal((await post(JSON.stringify({ taskId: "t" }))).status, 400);
        assert.equal((await post("x".repeat(70_000))).status, 413);
        assert.equal(got.length, 1);
    } finally { await d.stop(); }
    const plain = await startDashboard({ artifactRoot: tmp(), port: 0 });
    try {
        assert.equal((await fetch(`${plain.url}/mark`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404,
            "a dashboard with nowhere to store a mark has no /mark");
    } finally { await plain.stop(); }
});
