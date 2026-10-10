// The sweep's status as files for a model on the CLI (tests/e2e/bench/status.mjs), from the same state the page renders:
// status.md says how far along it is, what runs, what it spent per driver, the memory budget with the chart's readings
// as a table, the held runs with their commands, and a pause with its resume command; status.json is that state less
// what has its own file; the writer replaces each file whole, writes at most every so often with the latest state
// landing, builds the state only when it writes, and flushes at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { statusText, statusJson, writeStatus, statusWriter } from "../tests/e2e/bench/status.mjs";

const GB = 1024 ** 3, MB = 1024 ** 2;
const T0 = Date.parse("2026-10-10T14:00:00Z");
const tally = (o) => ({ calls: 0, computed: 0, computedCalls: 0, reported: 0, reportedCalls: 0, local: 0, unpriced: 0, pending: 0, ...o });
const STATE = {
    name: "cuts2", finished: null,
    runs: [
        { combo: { model: "glm" }, taskId: "icon-heart", repeat: 0, state: "done", ok: true },
        { combo: { model: "glm" }, taskId: "csv", repeat: 1, state: "done", ok: false },
        { combo: { model: "minimax" }, taskId: "csv", repeat: 0, state: "running", live: { step: 3, maxSteps: 12, last: "exec → 42" } },
        { combo: { model: "minimax" }, taskId: "csv", repeat: 1, state: "pending" },
    ],
    timeline: { runs: [], now: 0 }, resources: { capacities: [], samples: [] },
    spend: { currency: "USD", total: tally({ calls: 5, computed: 0.0123, computedCalls: 3, reported: 0.011, reportedCalls: 3, local: 2 }),
        models: { minimax: tally({ calls: 3, computed: 0.0123, computedCalls: 3, reported: 0.011, reportedCalls: 3 }), glm: tally({ calls: 2, local: 2 }) }, runs: {} },
    memory: {
        limit: 8 * GB, used: 3.5 * GB, byKind: { runner: 200 * MB, held: 2.2 * GB, running: 1.1 * GB }, available: 9 * GB, total: 16 * GB, reserve: 4 * GB, room: 4.5 * GB,
        active: true, whenFull: "pause", paused: "the memory limit: …", resume: "cd /r && node --import tsx tests/e2e/bench/run.mjs s.ts", hints: ["Keep one, release the duplicates."],
        runner: { heap: 90 * MB },
        groups: [{ key: "glm · csv · wrong answer", count: 2, rss: 2.2 * GB, sweeps: ["cuts2"], commands: { attach: "cd /r && node tests/e2e/converse.mjs --attach d \"<message>\"", keepOne: "cd /r && node --import tsx tests/e2e/bench/hold.mjs --stop 2", release: "cd /r && node --import tsx tests/e2e/bench/hold.mjs --stop 1 2" } }],
        wouldHold: [{ cell: "glm · csv · r3", failure: "timed out", dir: "tests/e2e/artifacts/bench/cuts2/csv/r3" }],
        history: Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * 5000, values: { runner: 200 * MB, held: (i >= 20 ? 2.2 : 1.1) * GB, running: 1.1 * GB }, room: 4 * GB })),
    },
};

// --- the text ---

test("status.md: progress, what runs now, spend per driver, and a pause with how to resume", () => {
    const md = statusText(STATE, T0);
    assert.match(md, /^# cuts2: running\n\n2 of 4 runs done, 1 failed; PAUSED at the memory budget\./);
    assert.match(md, /- csv · minimax · r0: step 3 of 12 \(exec → 42\)/);
    assert.match(md, /\| minimax \| 3 \| 0\.0123 USD \(3\) \| 0\.0110 USD \(3\) \|/);
    assert.match(md, /\| glm \| 2 \| {2}\| {2}\| 2 \|/);
    assert.match(md, /PAUSED: the memory limit: …\nResume: cd \/r && node --import tsx tests\/e2e\/bench\/run\.mjs s\.ts/);
});

test("status.md: the memory budget, the chart's readings as a table with the peak, held groups with every command, what was not held", () => {
    const md = statusText(STATE, T0);
    assert.match(md, /3\.5 GB of a 8\.0 GB limit; 9\.0 GB available, 4\.0 GB kept free; room for 4\.5 GB\. At the limit: pause\./);
    assert.match(md, /- runner: 200 MB \(node heap 90 MB\)/);
    assert.match(md, /Over the sweep \(the page's chart; 40 readings, peak 3\.5 GB at 14:01:40\)/);
    const rows = md.split("\n").filter((l) => /^\| \d\d:\d\d:\d\d \|/.test(l));
    assert.equal(rows.length, 12, "spread to a dozen rows");
    assert.ok(rows[0].startsWith("| 14:00:00 |") && rows.at(-1).startsWith("| 14:03:15 |"), "the first and the last reading");
    for (const c of Object.values(STATE.memory.groups[0].commands)) assert.ok(md.includes(`\`${c}\``), c);
    assert.match(md, /- 2 × glm · csv · wrong answer \(2\.2 GB, cuts2\)/);
    assert.match(md, /- glm · csv · r3 \(timed out\): tests\/e2e\/artifacts\/bench\/cuts2\/csv\/r3/);
    assert.match(md, /hold\.mjs --menu/);
});

test("status.md leaves out what is not there: no spend, no budget in force, nothing running, a finished sweep", () => {
    const md = statusText({ name: "s", finished: T0, runs: [{ state: "done", ok: true }], memory: { ...STATE.memory, active: false, groups: [], paused: null } }, T0);
    assert.match(md, /^# s: finished\n\n1 of 1 runs done\. Written/);
    for (const h of ["## Running now", "## Spend", "## Memory", "rewritten every few seconds"]) assert.ok(!md.includes(h), h);
    assert.match(statusText({ ...STATE, memory: { ...STATE.memory, reserve: 0 } }, T0), /no reserve \(a limit set by hand\)/);
});

test("status.json is the page's state less the timeline and the box's samples, which have files of their own", () => {
    const j = statusJson(STATE);
    assert.equal(j.timeline, undefined);
    assert.equal(j.resources, undefined);
    assert.deepEqual([j.spend, j.memory, j.runs], [STATE.spend, STATE.memory, STATE.runs]);
});

// --- the writer ---

test("both files are written whole, with no temporary file left behind", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bench-status-"));
    writeStatus(dir, STATE, T0);
    assert.deepEqual(readdirSync(dir).sort(), ["status.json", "status.md"]);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")).name, "cuts2");
    assert.match(readFileSync(path.join(dir, "status.md"), "utf8"), /^# cuts2/);
});

test("the writer writes at most every so often, the latest state lands, it builds the state only to write it, and flush writes now", async () => {
    const wrote = [];
    let built = 0;
    const w = statusWriter("d", { everyMs: 40, write: (_d, s) => wrote.push(s) });
    for (let i = 0; i < 50; i++) w.update(() => { built++; return i; });
    assert.equal(wrote.length, 0, "nothing synchronously");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(wrote, [49], "one write, of the latest");
    assert.equal(built, 1, "built once, not once per update");
    w.update(() => "a"); w.update(() => "b");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(wrote, [49], "the next waits out the interval");
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(wrote, [49, "b"]);
    w.update(() => "c");
    w.flush({ final: true });
    assert.deepEqual(wrote.at(-1), { final: true }, "the final state, at once");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(wrote.length, 3, "and the pending one does not land after it");
});
