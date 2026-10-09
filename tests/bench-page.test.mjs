// The bench's pages, rendered in jsdom from their real bundles: the dashboard (bench/page/app.tsx, the saved
// report.html form of it), its Answers and Timeline cards, a run page's lane (run-lane.tsx), and the bar paint the
// panel's lane and these pages share (lane-paint.ts). No browser and no extension.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { staticPage } from "../tests/e2e/bench/serve.mjs";
import { renderMarkdownPage, lanePrelude } from "../tests/e2e/viewer.mjs";
import { runLaneScript } from "../tests/e2e/bench/page/bundle.mjs";
const { barPaint, phaseFill } = await import("../src/sidebar/resource/lane-paint.ts");

/** The saved dashboard for a state, with its script run. */
async function dashboard(state) {
    const html = await staticPage({ name: "panel", dims: [], runs: [], rows: [], jobs: 1, started: 0, finished: 1, ...state });
    return new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true }).window.document;
}
const card = (doc, title) => [...doc.querySelectorAll(".card")].find((c) => c.querySelector(":scope > header h2")?.textContent === title) ?? null;

/** One event the way `eventsFrom` derives it. */
const ev = (kind, t, until, extra = {}) => ({ kind, t, until, label: `${kind} ${t}`, model: "m:1", ref: { hash: "h" }, ...extra });

// --- the dashboard's Answers card ---

test("the answers card sets each turn's answers side by side, models as columns, linked to each run", async () => {
    const doc = await dashboard({
        dims: ["model"], interviews: { rev: ["do it", "review it"] },
        runs: ["a", "b"].map((m) => ({ combo: { model: m }, who: m, taskId: "rev", repeat: 0, state: "done", ok: true, path: `rev/model-${m}/r0`,
            turns: [{ answer: `${m} did it`, tools: ["exec"], capped: false }, { answer: `${m} reviewed`, tools: [], capped: false }], checks: [] })),
    });
    const answers = card(doc, "Answers");
    assert.ok(answers);
    assert.deepEqual([...answers.querySelectorAll(".ans .txt")].map((e) => e.textContent), ["a did it", "b did it", "a reviewed", "b reviewed"], "row by turn, column by model");
    assert.ok(answers.querySelector('a.view[href="rev/model-a/r0/run.md.html"]'), "each answer opens its run in the viewer");
    assert.equal(answers.querySelectorAll("button").length, 0, "a saved page cannot store a mark, so it offers none");
});

test("an answer is text: markup a model wrote (or copied off a hostile page) is shown, never run", async () => {
    const doc = await dashboard({
        dims: ["model"], interviews: { rev: ["<b>q</b>"] },
        runs: [{ combo: { model: "<i>m</i>" }, who: "<i>m</i>", taskId: "rev", repeat: 0, state: "done", ok: true, path: "p",
            turns: [{ answer: "<img src=x onerror=\"window.__pwned=1\">", tools: ["<script>"], capped: false }],
            checks: [{ id: "c", turn: 1, quote: "<svg onload=1>", note: "<u>n</u>", here: true, still: true }] }],
    });
    const answers = card(doc, "Answers");
    assert.equal(answers.querySelectorAll("img, svg, i:not(.spin), u, script").length, 0, answers.innerHTML);
    assert.match(answers.querySelector(".txt").textContent, /<img src=x/);
    assert.equal(doc.defaultView.__pwned, undefined);
    assert.match(answers.querySelector(".flag").textContent, /marked wrong.*<svg onload=1>/);
});

test("a sweep with no interview has no Answers card, and one with nothing run shows its runs as queued", async () => {
    const doc = await dashboard({ runs: [{ combo: {}, who: "x", taskId: "t", repeat: 0, state: "pending" }] });
    assert.equal(card(doc, "Answers"), null);
    assert.match(card(doc, "Runs").textContent, /queued/);
});

// --- the dashboard's Timeline card ---

test("the timeline draws each run that has events as its own lane, on one shared axis, and leaves out cached runs", async () => {
    const runs = [
        { combo: { m: "a" }, who: "a", taskId: "t", repeat: 0, state: "done", ok: true },
        { combo: { m: "b" }, who: "b", taskId: "t", repeat: 0, state: "done", ok: true },
        { combo: { m: "c" }, who: "c", taskId: "t", repeat: 0, state: "done", ok: true, cached: true },
    ];
    const doc = await dashboard({
        dims: ["m"], runs,
        timeline: { now: 10_000, runs: [
            { index: 0, events: [ev("run", 0, 4000), ev("gen", 0, 2000)] },
            { index: 1, events: [ev("run", 6000, 10_000, { ref: { hash: "h2" } }), ev("gen", 6000, 9000, { ref: { hash: "h2" } })] },
        ] },
    });
    const tl = card(doc, "Timeline");
    assert.deepEqual([...tl.querySelectorAll(".who")].map((w) => w.textContent), ["t · a · r0", "t · b · r0"]);
    assert.match(tl.textContent, /1 cached run/);
    // One axis for both: the first run's 4 s run bar starts at 0% and is 40% wide; the second starts at 60%.
    const lefts = [...tl.querySelectorAll(".rc-ev-run")].map((b) => [b.style.left, b.style.width]);
    assert.deepEqual(lefts, [["0%", "40%"], ["60%", "40%"]]);
    assert.match(tl.querySelector(".rc-ev-gen").getAttribute("title"), /gen 0 \(m:1\) · 2\.0s/);
});

// --- a run's own page ---

test("a run page draws its lane from inert data, with its script admitted by hash and nothing else", () => {
    const script = runLaneScript();
    const html = renderMarkdownPage("# a run\n\n## Step 1 · exec\n\nok", {
        title: "t", assetBase: "",
        prelude: lanePrelude({ events: [ev("run", 0, 3000, { label: "</script><script>window.__pwned=1</script>" }), ev("tool", 500, 2500, { phases: [{ kind: "model", until: 1500 }, { kind: "wait", until: 2000 }, { kind: "tool", until: 2500 }] })], now: 3000 }),
        scripts: [script],
    });
    const csp = /script-src ([^;]+);/.exec(html)[1];
    assert.ok(csp.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`), "the lane script is admitted by its hash");
    assert.ok(!csp.includes("unsafe-inline"));
    const doc = new JSDOM(html, { runScripts: "dangerously" }).window.document;
    assert.equal(doc.defaultView.__pwned, undefined, "a label cannot close the data tag");
    const lane = doc.getElementById("wml-lane");
    assert.equal(lane.querySelectorAll(".rc-ev").length, 2);
    assert.ok(lane.querySelector(".rc-ev-tool .rc-ev-wait"), "a step's approval wait is drawn as its texture overlay, as in the panel");
    // Placed as its own section between the title block and the transcript.
    assert.deepEqual([...doc.querySelectorAll("details.sec summary h2")].map((h) => h.textContent), ["Timeline", "Step 1 · exec"]);
});

// --- one bar's paint, shared by the panel's lane and these pages ---

test("barPaint: a load keeps its dots and no overlays; a run takes its colour only through --model", () => {
    const load = barPaint(ev("load", 0, 1000, { phases: [{ kind: "weights", until: 600 }, { kind: "context", until: 1000 }] }));
    assert.match(load.style.background, /^radial-gradient/);
    assert.deepEqual(load.overlays.map((o) => o.cls), ["rc-ev-ctxphase"], "a load's context half is the one overlay");
    const run = barPaint(ev("run", 0, 1000));
    assert.equal(run.style.background, undefined, "an inline background would reset the checkerboard .rc-ev-run draws");
    assert.ok(run.style["--model"]);
    assert.equal(run.cls, "rc-ev-run linked");
});

test("barPaint: a pattern never becomes a gradient stop, for every phase kind", () => {
    // A pattern in a linear-gradient's stop list makes the whole declaration invalid: the block draws as nothing.
    const kinds = ["model", "wait", "tool", "think", "answer", "call", "queue", "net", "boot", "dispatch", "weights", "context", "prefill", "decode", "other", "swap", "load"];
    for (const k of kinds) {
        const p = barPaint(ev("tool", 0, 1000, { phases: [{ kind: "model", until: 400 }, { kind: k, until: 1000 }] }));
        assert.ok(!/linear-gradient\([^]*(repeating-|radial-gradient\()/.test(p.style.background), `${k}: ${p.style.background}`);
        const fill = phaseFill(k, "m:1");
        const patterned = fill.startsWith("repeating-") || fill.startsWith("radial-gradient(");
        if (patterned && k !== "wait" && k !== "context") assert.ok(p.overlays.some((o) => o.cls === "rc-ev-pattern" && o.background === fill), `${k} is drawn as an overlay`);
    }
});
