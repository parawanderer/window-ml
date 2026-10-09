// What the bench writes for a model that reads it from a terminal instead of the page: timeline.md (the page's timeline
// data as text) and marks made with mark.mjs (the page's "mark wrong", as a command). Both are rendered from, or written
// to, the same data the page uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { timelineText, labelSeed, seedEndOf, SEED_LABEL } from "../tests/e2e/bench/timeline-text.mjs";
import { addMark, readMarks } from "../tests/e2e/bench/mark.mjs";
import { doneSummary, doneLine } from "../tests/e2e/bench/sinks.mjs";
import { checkMarks, readContinued, followContinued } from "../tests/e2e/interview.mjs";

// hold.mjs reads its list's path once, on import: a test's own, never the real one.
process.env.BENCH_HELD_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "held-")), "held.json");
const { holdMode, heldRuns, canShow, HELD_FILE } = await import("../tests/e2e/bench/hold.mjs");

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

test("timeline.md: a seeded run's scripted first turn is named as the spec's script, and its measured turns as the measured model", () => {
    // As eventsFrom draws one: every event carries the model the run STARTED on, the fake's, the measured turn's too.
    const events = labelSeed([
        ev("run", 0, 1000, { model: "fake-model", label: "run 1/2 · fake-model" }),
        ev("gen", 100, 900, { model: "fake-model", label: "fake-model" }),
        ev("run", 1000, 4000, { model: "fake-model", label: "run 2/2 · fake-model" }),
        ev("tool", 1500, 2500, { model: "fake-model", label: "answer" }),
        ev("load", 1100, 1400, { model: "qwen3:8b", label: "loading qwen3:8b" }),
    ], "fake-model", { seedEnd: 950, measured: "qwen3:8b" });
    assert.deepEqual(events.map((e) => [e.model, e.label]), [
        [SEED_LABEL, `run 1/2 · ${SEED_LABEL}`], [SEED_LABEL, SEED_LABEL],
        ["qwen3:8b", "run 2/2 · qwen3:8b"], ["qwen3:8b", "answer"], ["qwen3:8b", "loading qwen3:8b"],
    ]);
    const md = timelineText({ now: 4000, runs: [{ index: 0, events }] }, () => "a");
    assert.match(md, /seed \(scripted, from the spec\)/);
    assert.doesNotMatch(md, /fake-model/);
});

test("the seed's end is its first answer; before the seed has answered, everything so far is the seed", () => {
    assert.equal(seedEndOf([{ kind: "agent-step", ts: 5 }, { kind: "agent-result", ts: 950 }, { kind: "agent-result", ts: 4000 }]), 950);
    assert.equal(seedEndOf([{ kind: "agent-step", ts: 5 }]), Infinity);
    const live = labelSeed([ev("gen", 100, 900, { model: "fake-model", label: "fake-model" })], "fake-model", { seedEnd: Infinity, measured: "qwen3:8b" });
    assert.equal(live[0].model, SEED_LABEL);
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

// --- the sweep's end, for a caller waiting on it ---

test("done: counts what ran, what came from the cache, what errored and what a predicate scored; the exit says whether any errored", () => {
    const run = (over) => ({ state: "done", ok: true, succeeded: null, cached: false, ...over });
    const runs = [run({ succeeded: true }), run({ succeeded: false }), run({ ok: false }), run({ cached: true, succeeded: true }), { state: "pending", ok: false }];
    const d = doneSummary("pb", runs, { report: "a/report.md", page: "http://127.0.0.1:7331" });
    assert.deepEqual({ ...d, at: null }, { name: "pb", runs: 5, ran: 3, cached: 1, ok: 3, errors: 1, rateLimited: 0, correct: 2, wrong: 1, retried: 0, report: "a/report.md", page: "http://127.0.0.1:7331", held: [], at: null, exit: 2 });
    assert.equal(doneLine(d), "BENCH DONE pb runs=5 ran=3 cached=1 ok=3 errors=1 rate_limited=0 correct=2 wrong=1 held=0 report=a/report.md page=http://127.0.0.1:7331");
    const clean = doneSummary("pb", [run({})], { report: "r.md" });
    assert.equal(clean.exit, 0);
    assert.match(doneLine(clean), /^BENCH DONE pb .* page=none$/, "no page without --serve");
});

test("done: a rate-limited error is counted apart, and how many errored cells ran again is said", () => {
    const d = doneSummary("pb", [{ state: "done", ok: false, rateLimited: true }, { state: "done", ok: false }], { report: "r.md", retried: 2 });
    assert.equal(d.errors, 2);
    assert.equal(d.rateLimited, 1);
    assert.equal(d.retried, 2);
    assert.match(doneLine(d), / errors=2 rate_limited=1 /);
});


// --- runs held open after the sweep ---

const cellOf = (task, combo = {}) => ({ task: { id: "t", ...task }, combo, repeat: 0, effects: {} });

test("hold: the task's own setting, unless the command line says; a selector picks cells, `failures` narrows to the bad runs", () => {
    assert.equal(holdMode(cellOf({})), null, "not held by default");
    assert.equal(holdMode(cellOf({ hold: true })), "always");
    assert.equal(holdMode(cellOf({ hold: "failures" })), "failures");
    assert.equal(holdMode(cellOf({}), ["all"]), "always");
    assert.equal(holdMode(cellOf({}), ["failures"]), "failures");
    assert.equal(holdMode(cellOf({ hold: true }), ["task=other"]), null, "the command line wins over the task");
    assert.equal(holdMode(cellOf({}, { model: "a" }), ["model=a"]), "always");
    assert.equal(holdMode(cellOf({}, { model: "b" }), ["model=a", "failures"]), null);
    assert.equal(holdMode(cellOf({}, { model: "a" }), ["model=a", "failures"]), "failures");
});

test("hold: held.json lists only runs whose process is alive, and BENCH DONE counts what the sweep left open", () => {
    const dead = 2 ** 22 + 12345;   // above macOS's and Linux's default pid_max
    fs.writeFileSync(HELD_FILE, JSON.stringify([
        { pid: process.pid, cell: "a · t · r0", sweep: "s", dir: "x", attach: "node tests/e2e/converse.mjs --attach x \"<message>\"", expiresAt: "2026-10-09T12:00:00.000Z" },
        { pid: dead, cell: "b · t · r0", sweep: "s", dir: "y", attach: "…", expiresAt: "2026-10-09T12:00:00.000Z" },
    ]));
    assert.deepEqual(heldRuns().map((h) => h.cell), ["a · t · r0"]);
    fs.writeFileSync(HELD_FILE, "not json");
    assert.deepEqual(heldRuns(), [], "an unreadable list holds nothing");
    const d = doneSummary("pb", [{ state: "done", ok: true }], { report: "r.md", held: [{ pid: 1, cell: "a", attach: "…" }] });
    assert.match(doneLine(d), / held=1 report=/);
    assert.match(doneLine(doneSummary("pb", [], { report: "r.md" })), / held=0 /);
});

test("hold: a held run's browser is a window to show later wherever there is a screen; a Linux box without one runs headless", () => {
    assert.equal(canShow({}, "darwin"), true);
    assert.equal(canShow({}, "win32"), true);
    assert.equal(canShow({}, "linux"), false);
    assert.equal(canShow({ DISPLAY: ":0" }, "linux"), true);
    assert.equal(canShow({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
});

test("continued: the turns added to a held run, each with its answer from the outbox, and the page follows them as they come", async () => {
    const sweep = fs.mkdtempSync(path.join(os.tmpdir(), "cont-"));
    const dir = path.join(sweep, "t/m/r0");
    fs.mkdirSync(path.join(dir, "outbox"), { recursive: true });
    assert.deepEqual(readContinued(dir), [], "none yet");
    fs.writeFileSync(path.join(dir, "outbox", "turn-3.md"), "# Turn 3\n\n## Answer\n\nIt used exec.\n\n## Steps\n\n- **exec** {}\n  → 2\n");
    fs.writeFileSync(path.join(dir, "continued.jsonl"), JSON.stringify({ turn: 3, ask: "which tools?", at: "2026-10-09T12:00:00.000Z", answered: true }) + "\nnot json\n" + JSON.stringify({ turn: 4, ask: "and then?", at: null, answered: false }) + "\n");
    assert.deepEqual(readContinued(dir), [
        { turn: 3, ask: "which tools?", at: "2026-10-09T12:00:00.000Z", answer: "It used exec.", tools: ["exec"], capped: false },
        { turn: 4, ask: "and then?", at: null, answer: "", tools: [], capped: false },
    ], "a torn line is skipped, a turn without its report has no answer yet");

    const runs = [{ path: "t/m/r0", held: "…" }, { path: "t/n/r0" }, { path: "" }];
    let calls = 0;
    const stop = followContinued(sweep, () => runs, () => { calls++; }, 20);
    assert.equal(calls, 1, "read once at the start");
    assert.equal(runs[0].continued.length, 2);
    assert.equal(runs[1].continued, undefined, "a run with nothing added is left alone");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 1, "nothing new, no change");
    fs.appendFileSync(path.join(dir, "continued.jsonl"), JSON.stringify({ turn: 5, ask: "last", at: null, answered: true }) + "\n");
    const t = Date.now() + 8;
    fs.utimesSync(path.join(dir, "continued.jsonl"), t / 1000, t / 1000);
    for (const until = Date.now() + 2000; calls < 2 && Date.now() < until;) await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.equal(calls, 2);
    assert.deepEqual(runs[0].continued.map((c) => c.turn), [3, 4, 5]);
});
