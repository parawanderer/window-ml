// What the bench writes for a model that reads it from a terminal instead of the page: timeline.md (the page's timeline
// data as text) and marks made with mark.mjs (the page's "mark wrong", as a command). Both are rendered from, or written
// to, the same data the page uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { timelineText, labelSeed, SEED_LABEL } from "../tests/e2e/bench/timeline-text.mjs";
import { addMark, readMarks } from "../tests/e2e/bench/mark.mjs";
import { checkMarks } from "../tests/e2e/interview.mjs";

const ev = (kind, t, until, extra = {}) => ({ kind, t, until, label: kind, model: "m", ...extra });

// --- timeline.md ---

test("timeline.md: every run on one clock, the runs that overlapped and for how long, then each run's spans", () => {
    const md = timelineText({ now: 9000, runs: [
        { index: 0, events: [ev("run", 1000, 5000), ev("gen", 1000, 2000), ev("tool", 2000, 4000, { label: "exec", phases: [{ kind: "model", until: 2500 }, { kind: "tool", until: 4000 }] }), ev("load", 500, 1000)] },
        { index: 1, events: [ev("run", 3000, 6000), ev("gen", 3000, 6000)] },
    ] }, (i) => ["a", "b"][i]);
    assert.match(md, /\| `a` \| 0\.00s \| 4\.50s \| 4\.5s \| 1 \| 1 \| 1 \| 0 \| 3\.0s \|/, "a load before the run starts the run's extent");
    assert.match(md, /\| `b` \| 2\.50s \| 5\.50s \| 3\.0s \|/);
    assert.match(md, /`a` and `b`: 2\.0s together \(2\.50s to 4\.50s\)/);
    assert.match(md, /- 1\.50s to 3\.50s · tool · exec · m · 2\.0s \(model 500ms, tool 1\.5s\)/);
});

test("timeline.md: a run still going is drawn to `now`; runs that never met have no overlap; cached runs are named as left out", () => {
    const md = timelineText({ now: 4000, runs: [
        { index: 0, events: [ev("run", 0, 1000)] },
        { index: 1, events: [ev("run", 2000, null, { open: true })] },
    ] }, (i) => `r${i}`, { cached: 2 });
    assert.match(md, /\| `r1` \| 2\.00s \| 4\.00s \| 2\.0s/);
    assert.match(md, /still running/);
    assert.match(md, /None: every run had the machine to itself/);
    assert.match(md, /2 cached run\(s\) are left out/);
    assert.match(timelineText(null, () => ""), /No run has events/);
});

test("timeline.md: a seeded run's scripted first turn is named as the spec's script, not as the fake model", () => {
    const events = labelSeed([
        ev("run", 0, 1000, { model: "fake-model", label: "run 1/2 · fake-model" }),
        ev("run", 1000, 4000, { model: "qwen3:8b", label: "run 2/2 · qwen3:8b" }),
    ], "fake-model");
    assert.deepEqual(events.map((e) => [e.model, e.label]), [[SEED_LABEL, `run 1/2 · ${SEED_LABEL}`], ["qwen3:8b", "run 2/2 · qwen3:8b"]]);
    const md = timelineText({ now: 4000, runs: [{ index: 0, events }] }, () => "a");
    assert.match(md, /seed \(scripted, from the spec\)/);
    assert.doesNotMatch(md, /fake-model/);
});

// --- marks from the command line ---

test("a mark made from the command line lands where the page's do, validated the same way, said by whom, and checked on later runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-marks-"));
    const m = await addMark(dir, { taskId: "t", who: "a", turn: 2, quote: "the snapshot excludes the call", note: "it does not", hash: null }, "claude-code test");
    assert.equal(m.by, "claude-code test");
    assert.match(m.at, /^\d{4}-\d\d-\d\dT/);
    await assert.rejects(addMark(dir, { taskId: "t", who: "a", turn: 0, quote: "q" }), /not a mark/);
    const [check] = checkMarks({ taskId: "t", who: "a", hash: "h", turns: [{ answer: "" }, { answer: "The snapshot EXCLUDES the call." }] }, await readMarks(dir));
    assert.equal(check.still, true);
    assert.equal(check.by, "claude-code test", "a check says whose mark it is");
});

test("marks are an append-only log: two writers at once both land, and neither rewrites what was there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-marks-"));
    const mark = (i, by) => addMark(dir, { taskId: "t", who: "a", turn: 1, quote: `line ${i}` }, by);
    await Promise.all(Array.from({ length: 20 }, (_, i) => mark(i, i % 2 ? "person (page)" : "agent")));
    const all = await readMarks(dir);
    assert.equal(all.length, 20, "no mark lost to another written at the same moment");
    assert.deepEqual(new Set(all.map((m) => m.by)), new Set(["person (page)", "agent"]));
    const before = fs.readFileSync(path.join(dir, "marks.jsonl"), "utf8");
    await mark(99, "agent");
    assert.ok(fs.readFileSync(path.join(dir, "marks.jsonl"), "utf8").startsWith(before), "what was there is untouched");
});

test("UPGRADE: marks written before the log (marks.json, no author) are still read, by 'unknown', ahead of the log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-marks-"));
    // What #462 wrote: an array, rewritten whole on each mark, with no `by`.
    fs.writeFileSync(path.join(dir, "marks.json"), JSON.stringify([{ id: "old1", taskId: "t", who: "a", turn: 1, quote: "x", note: "", hash: null, at: "2026-10-09T08:24:04.069Z" }]));
    await addMark(dir, { taskId: "t", who: "a", turn: 1, quote: "y" }, "agent");
    fs.appendFileSync(path.join(dir, "marks.jsonl"), '{"op":"mark","id":"torn"');   // an interrupted append
    const all = await readMarks(dir);
    assert.deepEqual(all.map((m) => [m.id === "old1" ? "old1" : "new", m.by]), [["old1", "unknown"], ["new", "agent"]]);
    const [check] = checkMarks({ taskId: "t", who: "a", hash: "h", turns: [{ answer: "it says x" }] }, all);
    assert.equal(check.still, true, "an old mark is still checked");
});

test("mark.mjs: with one interview in the sweep, --task is not needed; with several it is asked for", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-marks-"));
    const cli = (...a) => execFileSync(process.execPath, ["tests/e2e/bench/mark.mjs", dir, ...a], { encoding: "utf8", stdio: "pipe" });
    fs.writeFileSync(path.join(dir, "page.json"), JSON.stringify({ interviews: { rev: ["q1", "q2"] } }));
    assert.match(cli("--model", "a", "--turn", "2", "--quote", "wrong line", "--by", "codex 42"), /marked \w+ by codex 42: a turn 2/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "marks.jsonl"), "utf8").trim()).taskId, "rev");
    assert.match(cli("--list"), /rev {2}a {2}turn 2 {2}by codex 42/);
    fs.writeFileSync(path.join(dir, "page.json"), JSON.stringify({ interviews: { a: [], b: [] } }));
    assert.throws(() => cli("--model", "a", "--turn", "1", "--quote", "x"), /2 interviews \(a, b\): say which with --task/);
});
