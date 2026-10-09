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
} from "../tests/e2e/interview.mjs";
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
