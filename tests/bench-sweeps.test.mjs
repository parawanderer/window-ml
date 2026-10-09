// Which spec each sweep ran (sweeps.mjs): the append-only log of sweeps, the provenance the page and spec.md show (who
// started it, the diff against the sweep before), and the page's Spec card drawn from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { recordSweep, readSweeps, specProvenance, specText, specHash, keepEarlierRun, historyRuns, cellsOnDisk, sortOnDisk } from "../tests/e2e/bench/sweeps.mjs";
import { expandCells, cellKey, cellPath } from "../tests/e2e/bench/cells.mjs";
import { writeReport, mdSink } from "../tests/e2e/bench/sinks.mjs";
import { staticPage } from "../tests/e2e/bench/serve.mjs";

const SPEC_A = 'export default {\n  name: "x",\n  tasks: [{ id: "t", task: "count the links" }],\n};\n';
const SPEC_B = SPEC_A.replace("count the links", "count the external links");
const sweep = (dir, source, by, extra = {}) => recordSweep(dir, { specPath: "tests/e2e/bench/specs/x.bench.ts", source, fingerprint: "abc123", dirty: false, by, ...extra });

// --- the sweep log ---

test("each sweep appends one record saying which spec text ran and who started it; nothing before it is rewritten", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-sweeps-"));
    await sweep(dir, SPEC_A, "person");
    const before = fs.readFileSync(path.join(dir, "sweeps.jsonl"), "utf8");
    const all = await sweep(dir, SPEC_B, "claude-code 3bdb7a23", { dirty: true });
    assert.ok(fs.readFileSync(path.join(dir, "sweeps.jsonl"), "utf8").startsWith(before), "the first record is untouched");
    assert.deepEqual(all.map((r) => [r.by, r.specHash, r.dirty]), [["person", specHash(SPEC_A), false], ["claude-code 3bdb7a23", specHash(SPEC_B), true]]);
    assert.equal(all[1].specSource, SPEC_B);
    assert.match(all[1].at, /^\d{4}-\d\d-\d\dT/);
    fs.appendFileSync(path.join(dir, "sweeps.jsonl"), '{"op":"sweep","at"');   // an interrupted append
    assert.equal((await readSweeps(dir)).length, 2, "a torn last line is skipped");
    assert.deepEqual(await readSweeps(path.join(dir, "none")), []);
});

test("a sweep records where its spec was on disk; a record from before that was kept reads as having none (an upgrade)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-sweeps-"));
    // What the code before this wrote: no `onDisk`.
    fs.writeFileSync(path.join(dir, "sweeps.jsonl"), JSON.stringify({ op: "sweep", at: "2026-10-09T09:00:00.000Z", by: "old", spec: "tests/e2e/bench/specs/x.bench.ts", specHash: specHash(SPEC_A), fingerprint: "f", dirty: false, specSource: SPEC_A }) + "\n");
    const all = await sweep(dir, SPEC_A, "new", { onDisk: "/home/a/clone/tests/e2e/bench/specs/x.bench.ts" });
    const p = specProvenance(all);
    assert.equal(p.onDisk, "/home/a/clone/tests/e2e/bench/specs/x.bench.ts");
    assert.equal(p.previous.onDisk, null);
    assert.match(specText(p), /^This sweep ran `\/home\/a\/clone\/tests\/e2e\/bench\/specs\/x\.bench\.ts`/m);
    assert.match(specText(specProvenance(all.slice(0, 1))), /^This sweep ran `tests\/e2e\/bench\/specs\/x\.bench\.ts`/m);
});

// --- what the page and spec.md say ---

test("provenance: the first sweep says so; an unchanged spec says unchanged; a changed one carries its diff", () => {
    const rec = (source, by) => ({ op: "sweep", at: "2026-10-09T10:00:00.000Z", by, spec: "s.bench.ts", specHash: specHash(source), fingerprint: "f", dirty: false, specSource: source });
    const first = specProvenance([rec(SPEC_A, "a")]);
    assert.equal(first.previous, null);
    assert.equal(first.changed, null);
    assert.match(specText(first), /first sweep recorded here/);

    const same = specProvenance([rec(SPEC_A, "a"), rec(SPEC_A, "b")]);
    assert.equal(same.changed, false);
    assert.equal(same.diff, null);
    assert.match(specText(same), /Previous: spec \w+, started by a .*\n\nThe spec is unchanged/);

    const changed = specProvenance([rec(SPEC_A, "a"), rec(SPEC_B, "agent")]);
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.stat, { added: 1, removed: 1 });
    const md = specText(changed);
    assert.match(md, /started by agent/);
    assert.match(md, /```diff\n[^]*-  tasks: \[\{ id: "t", task: "count the links" \}\],\n\+  tasks: \[\{ id: "t", task: "count the external links" \}\],/);
    assert.match(md, /\| 2026-10-09T10:00:00\.000Z \| agent \| \w{12} \| f \|/);
    assert.match(md, /## The spec as it ran\n\n```ts\nexport default/);
    assert.equal(specProvenance([]), null);
    assert.match(specText(null), /No sweep has been recorded/);
});

test("provenance: a spec too long to diff says it changed and that it is too long, never shows an empty diff", () => {
    const long = (w) => Array.from({ length: 500 }, (_, i) => `line ${i} ${w}`).join("\n");
    const rec = (source) => ({ op: "sweep", at: "t", by: "a", spec: "s.json", specHash: specHash(source), fingerprint: "f", dirty: false, specSource: source });
    const p = specProvenance([rec(long("a")), rec(long("b"))]);
    assert.equal(p.changed, true);
    assert.equal(p.tooBig, true);
    assert.match(specText(p), /The spec changed; it is too long to diff here/);
});

// --- the page's Spec card ---

test("the Spec card shows who started the sweep, that the spec changed, and the lines that did; the spec is text, never markup", async () => {
    const hostile = SPEC_B.replace("count", "<img src=x onerror=\"window.__pwned=1\"> count");
    const rec = (source, by) => ({ op: "sweep", at: "2026-10-09T10:00:00.000Z", by, spec: "s.bench.ts", specHash: specHash(source), fingerprint: "f", dirty: true, specSource: source });
    const html = await staticPage({ name: "x", dims: [], runs: [], rows: [], jobs: 1, started: 0, finished: 1, spec: specProvenance([rec(SPEC_A, "person"), rec(hostile, "<b>agent</b>")]) });
    const doc = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true }).window.document;
    const card = doc.querySelector("#spec");
    assert.ok(card, "the card is there");
    assert.match(card.textContent, /started by<b>agent<\/b>/);
    assert.match(card.textContent, /changed.*since person's sweep/);
    assert.match(card.textContent, /uncommitted changes/);
    // The changed line as the panel draws a diff (code-diff.tsx): highlighted, under a gutter of its old and new line numbers.
    const added = [...card.querySelectorAll(".sdiff .dline-add")];
    assert.deepEqual(added.map((e) => e.querySelector(".dtext").textContent), [hostile.split("\n")[2]]);
    assert.deepEqual([...added[0].querySelectorAll(".dno")].map((n) => n.textContent), ["", "3"], "new on line 3, no old line");
    assert.equal(added[0].querySelector(".dsign").textContent, "+");
    assert.equal(card.querySelectorAll("img, b").length, 0, card.innerHTML);
    // The spec's text as the panel shows code: highlighted (its keywords coloured), one numbered row per line.
    assert.equal(card.querySelectorAll(".ssrc .cline").length, hostile.split("\n").length);
    assert.ok(card.querySelector(".ssrc .hljs-keyword"), "highlighted");
    assert.equal(card.querySelector(".ssrc .cline:nth-child(3) .lno").textContent, "3");
    assert.equal(doc.defaultView.__pwned, undefined);
    assert.ok(doc.querySelector('header a.badge[href="#spec"]'), "the header says the spec changed, and links to the card");
});

test("a sweep with no record (a page saved before sweeps were logged) has no Spec card", async () => {
    const doc = new JSDOM(await staticPage({ name: "x", dims: [], runs: [], rows: [], jobs: 1, started: 0, finished: 1 }), { runScripts: "dangerously", pretendToBeVisual: true }).window.document;
    assert.equal(doc.querySelector("#spec"), null);
    assert.equal(doc.querySelector('a[href="#spec"]'), null);
});

// --- a cell run again keeps the run it replaces ---

test("a cell run again moves its earlier run to history/, finished or not, and an empty cell has nothing to keep", async () => {
    const sweep = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
    const cell = (rel, files) => { fs.mkdirSync(path.join(sweep, rel), { recursive: true }); for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(sweep, rel, f), v); };
    cell("iv/m-a/r0", { "cell.json": JSON.stringify({ key: "abcdef1234567890" }), "run.md": "# the baseline" });
    const rel = await keepEarlierRun(sweep, "iv/m-a/r0");
    assert.match(rel, /^history\/iv\/m-a\/r0\/\d{4}-\d\d-\d\dT[\d-]+Z-abcdef12$/);
    assert.equal(fs.readFileSync(path.join(sweep, rel, "run.md"), "utf8"), "# the baseline", "moved whole");
    assert.ok(!fs.existsSync(path.join(sweep, "iv/m-a/r0")), "the cell is free for the new run");
    cell("iv/m-b/r0", { "run.md": "# it died half way" });
    assert.match(await keepEarlierRun(sweep, "iv/m-b/r0"), /-unfinished$/, "a run that never finished is kept too: its transcript is all there is");
    cell("iv/m-c/r0", {});
    assert.equal(await keepEarlierRun(sweep, "iv/m-c/r0"), null);
    assert.equal(await keepEarlierRun(sweep, "iv/none/r0"), null);
    assert.deepEqual((await historyRuns(sweep)).map((h) => h.cellPath), ["iv/m-a/r0", "iv/m-b/r0"]);
});

// --- the report is the whole sweep on disk ---

const SPEC = { name: "x", dimensions: { model: ["a", "b"] }, tasks: [{ id: "t", task: "count the links" }] };
const writeCell = (sweep, rel, saved) => { fs.mkdirSync(path.join(sweep, rel), { recursive: true }); fs.writeFileSync(path.join(sweep, rel, "cell.json"), JSON.stringify(saved)); };
const savedOf = (cell, fp, extra = {}) => ({ key: cellKey(cell, fp), combo: cell.combo, taskId: cell.task.id, repeat: cell.repeat, measurement: { ok: true, succeeded: true, steps: 2, runMs: 1000 }, ...extra });

test("a cell this invocation did not select is in the report when its key is this spec and build's, listed only when it is an earlier version's", async () => {
    const sweep = fs.mkdtempSync(path.join(os.tmpdir(), "ondisk-"));
    const all = expandCells(SPEC, { repeats: 2 });
    const [a0, a1, b0, b1] = ["model=a", "model=a", "model=b", "model=b"].map((_, i) => all[i]);
    writeCell(sweep, cellPath(a0), savedOf(a0, "fp2"));                       // selected now: neither
    writeCell(sweep, cellPath(b0), savedOf(b0, "fp2"));                       // same build, not selected: counted
    writeCell(sweep, cellPath(b1), savedOf(b1, "fp1"));                       // an earlier build: listed
    writeCell(sweep, "t/model-gone/r0", { key: "k", combo: { model: "gone" }, taskId: "t", repeat: 0, measurement: { ok: true } });   // a model no longer in the spec
    writeCell(sweep, "history/t/model-b/r1/2026-old", savedOf(b1, "fp2"));    // history is never the sweep's result
    const disk = await cellsOnDisk(sweep);
    assert.deepEqual(disk.map((d) => d.rel), ["t/model-a/r0", "t/model-b/r0", "t/model-b/r1", "t/model-gone/r0"]);
    const { same, older } = sortOnDisk(disk, { base: expandCells(SPEC, { repeats: 1 }), selected: new Set([a0, a1].map(cellPath)), fingerprint: "fp2" });
    assert.deepEqual(same.map((s) => [s.rel, s.cell.combo.model, s.cell.repeat]), [["t/model-b/r0", "b", 0]]);
    assert.equal(cellKey(same[0].cell, "fp2"), same[0].saved.key, "the cell rebuilt from the spec is the one that ran");
    assert.deepEqual(older.map((o) => o.path), ["t/model-b/r1", "t/model-gone/r0"]);
});

test("the report counts a run already on disk apart from those run and cached, and names the earlier version's by path", () => {
    const run = (extra) => ({ combo: { model: "a" }, taskId: "t", repeat: 0, state: "done", ok: true, succeeded: true, steps: 2, secs: 1, path: "t/model-a/r0", ...extra });
    const md = writeReport({ spec: SPEC, rows: [], runs: [run({}), run({ cached: true, onDisk: true, combo: { model: "b" }, path: "t/model-b/r0" })], fingerprint: "fp2", started: 0, finished: 60000, ran: 1, cached: 0, onDisk: 1,
        older: [{ path: "t/model-b/r1", taskId: "t", combo: { model: "b" }, repeat: 1 }] }, mdSink());
    assert.match(md, /2 runs \(1 run, 0 cached, 1 not selected this time but already on disk/);
    assert.match(md, /\| b \| t \| r0 \(on disk\) \|/);
    assert.match(md, /## Also on disk, from an earlier version\n\n.*\n\n- model=b · t · r1: \[t\/model-b\/r1\]\(t\/model-b\/r1\/run\.md\)/);
    assert.doesNotMatch(writeReport({ spec: SPEC, rows: [], runs: [], fingerprint: "f", started: 0, finished: 0 }, mdSink()), /earlier version/);
});

test("the page counts runs already on disk in their own badge and lists the earlier version's by path, linked to the transcript", async () => {
    const run = (extra) => ({ combo: { model: "a" }, taskId: "t", repeat: 0, state: "done", ok: true, succeeded: true, steps: 2, secs: 1, path: "t/model-a/r0", who: "a", ...extra });
    const html = await staticPage({ name: "x", dims: ["model"], runs: [run({}), run({ cached: true, onDisk: true, combo: { model: "b" }, path: "t/model-b/r0", who: "b" })], rows: [], jobs: 1, started: 0, finished: 1,
        older: [{ path: "t/model-b/r1", taskId: "t", combo: { model: "b" }, repeat: 1 }] });
    const doc = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true }).window.document;
    const badges = [...doc.querySelectorAll(".counts .badge")].map((b) => b.textContent);
    assert.ok(badges.includes("1 already on disk"), badges.join(" | "));
    assert.ok(!badges.some((b) => /cached/.test(b)), "a run from disk is not also counted as cached");
    const link = [...doc.querySelectorAll("a")].find((a) => a.textContent === "t/model-b/r1");
    assert.equal(link?.getAttribute("href"), "t/model-b/r1/run.md.html");
    assert.match(link.closest("section").textContent, /Also on disk, from an earlier version/);
});
