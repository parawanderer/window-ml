// Which spec each sweep ran (sweeps.mjs): the append-only log of sweeps, the provenance the page and spec.md show (who
// started it, the diff against the sweep before), and the page's Spec card drawn from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { recordSweep, readSweeps, specProvenance, specText, specHash } from "../tests/e2e/bench/sweeps.mjs";
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
