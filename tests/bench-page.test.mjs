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
    assert.equal(answers.querySelectorAll("button.danger").length, 0, "a saved page cannot store a mark, so it offers none");
});

test("an answer is text: markup a model wrote (or copied off a hostile page) is shown, never run", async () => {
    const doc = await dashboard({
        dims: ["model"], interviews: { rev: ["<b>q</b>"] },
        runs: [{ combo: { model: "<i>m</i>" }, who: "<i>m</i>", taskId: "rev", repeat: 0, state: "done", ok: true, path: "p",
            turns: [{ answer: "<img src=x onerror=\"window.__pwned=1\">", tools: ["<script>"], capped: false }],
            checks: [{ id: "c", turn: 1, quote: "<svg onload=1>", note: "<u>n</u>", here: true, still: true }] }],
    });
    const answers = card(doc, "Answers");
    assert.equal(answers.querySelectorAll(":not(.foldbtn) > svg, img, i:not(.spin), u, script").length, 0, answers.innerHTML);
    assert.match(answers.querySelector(".txt").textContent, /<img src=x/);
    assert.equal(doc.defaultView.__pwned, undefined);
    assert.match(answers.querySelector(".flag").textContent, /marked wrong.*<svg onload=1>/);
});

test("a sweep with no interview has no Answers card, and one with nothing run shows its runs as queued", async () => {
    const doc = await dashboard({ runs: [{ combo: {}, who: "x", taskId: "t", repeat: 0, state: "pending" }] });
    assert.equal(card(doc, "Answers"), null);
    assert.match(card(doc, "Runs").textContent, /queued/);
});

test("an answer renders as markdown with the panel's renderer, and the toggle shows the exact text the model sent", async () => {
    const answer = "**Cut** the `title` clause:\n\n- it repeats\n- <script>window.__pwned=1</script>";
    const doc = await dashboard({
        dims: ["model"], interviews: { rev: ["q"] },
        runs: [{ combo: { model: "a" }, who: "a", taskId: "rev", repeat: 0, state: "done", ok: true, path: "p", turns: [{ answer, tools: [], capped: false }], checks: [] }],
    });
    const txt = () => card(doc, "Answers").querySelector(".ans .txt");
    assert.ok(txt().classList.contains("md"), "markdown is the default");
    assert.equal(txt().querySelector("strong").textContent, "Cut");
    assert.equal(txt().querySelector("code").textContent, "title");
    assert.equal(txt().querySelectorAll("li").length, 2);
    assert.equal(txt().querySelectorAll("script").length, 0, "markup a model wrote is escaped, never run");
    assert.equal(doc.defaultView.__pwned, undefined);
    const raw = [...card(doc, "Answers").querySelectorAll(".seg button")].find((b) => b.textContent === "raw");
    raw.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!txt().classList.contains("md"));
    assert.equal(txt().textContent, answer, "raw is the answer verbatim");
});

// --- the dashboard's run identity: models and hash ---

test("each run's models are one group (driver, vision, utility), and its hash is the panel's short click-to-copy chip", async () => {
    const hash = "7379c07c91cbe0d986e7bd2e014b4d6e";
    const doc = await dashboard({
        dims: ["model"], interviews: { rev: ["q"] },
        runs: ["a", "b"].map((m) => ({ combo: { model: m }, who: m, taskId: "rev", repeat: 0, state: "done", ok: true, path: `p/${m}`, hash,
            models: { driver: m, vision: "v", utility: null }, turns: [{ answer: "x", tools: [], capped: false }], checks: [] })),
    });
    assert.deepEqual([...doc.querySelectorAll(".models .mset")].map((g) => [...g.querySelectorAll(".role")].map((r) => r.textContent)),
        [["drivera", "visionv", "utilitynone"], ["driverb", "visionv", "utilitynone"]]);
    const chip = card(doc, "Answers").querySelector(".ah .hash.copyable");
    assert.equal(chip.textContent, hash.slice(0, 8), "shown short, as git does");
    assert.equal(chip.parentElement.querySelector(".tt-pop").textContent, `click to copy ${hash}`, "the tip names the whole hash, which is what a click copies");
    assert.ok(card(doc, "Runs").querySelector("td .hash.copyable"));
});

test("text the page did not write says where it came from: the sweep's name and description, each question, each answer", async () => {
    const doc = await dashboard({
        name: "panel-bloat", description: "Review your own prompt.", dims: ["model"], interviews: { rev: ["What code is shown?", "x".repeat(700)] },
        spec: { spec: "tests/e2e/panel/bloat.json", history: [], source: "" },
        runs: [{ combo: { model: "a" }, who: "a", taskId: "rev", repeat: 0, state: "done", ok: true, path: "p", turns: [{ answer: "CROSSPAGE-9471", tools: [], capped: false }], checks: [] }],
    });
    const tip = (el) => el.closest(".tt").getAttribute("data-tip");
    assert.match(tip(doc.querySelector("h1")), /sweep's name, from tests\/e2e\/panel\/bloat\.json/);
    assert.match(tip(doc.querySelector(".desc")), /description, from tests\/e2e\/panel\/bloat\.json: written by whoever wrote the spec, not by this page/);
    const asked = [...doc.querySelectorAll(".q .asked")];
    assert.equal(asked[0].textContent, "What code is shown?");
    assert.match(tip(asked[0]), /sent each model as turn 1, verbatim/);
    assert.match(tip(asked[1]), /Cut at 600 characters here/);
    assert.match(tip(doc.querySelector(".ans .txt")), /What a answered at turn 1, rendered as markdown/);
});

test("every column, tile and card heading explains itself on hover, in the panel's tooltip, never the browser's", async () => {
    const doc = await dashboard({
        dims: ["model"], interviews: { rev: ["q"] },
        rows: [{ combo: { model: "a" }, taskId: "rev", agg: { runs: 1, errors: 0, steps: { mean: 2, sd: null, n: 1 } } }],
        runs: [{ combo: { model: "a" }, who: "a", taskId: "rev", repeat: 0, state: "done", ok: true, path: "p", hash: "h".repeat(32), steps: 2, secs: 1,
            models: { driver: "a", vision: null, utility: "u" }, turns: [{ answer: "x", tools: ["exec"], capped: true }], checks: [] }],
    });
    const tipOf = (el) => el.querySelector("[data-tip]")?.getAttribute("data-tip") || el.closest("[data-tip]")?.getAttribute("data-tip");
    for (const th of doc.querySelectorAll("th")) assert.ok(tipOf(th), `column "${th.textContent}" has a tip`);
    for (const t of doc.querySelectorAll(".tile")) assert.ok(tipOf(t), `tile "${t.textContent}" has a tip`);
    for (const h of doc.querySelectorAll(".card > header h2")) assert.ok(tipOf(h), `card "${h.textContent}" has a tip`);
    for (const r of doc.querySelectorAll(".mset .role")) assert.ok(tipOf(r), "each model role says what it does");
    const { COLUMNS } = await import("../tests/e2e/bench/metrics.mjs");
    for (const c of COLUMNS) assert.ok(c.about, `metrics.mjs column ${c.key} says what it is`);
    const results = [...doc.querySelectorAll(".card")].find((c) => c.querySelector("h2")?.textContent === "Results");
    assert.equal(tipOf([...results.querySelectorAll("th")].find((th) => th.textContent === "steps")), COLUMNS.find((c) => c.key === "steps").about, "a result column's tip is metrics.mjs's `about`");
    assert.equal(doc.querySelectorAll("#app [title]").length, 0, "no browser tooltips");
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
    assert.match(tl.querySelector(".rc-ev-gen").getAttribute("aria-label"), /gen 0 \(m:1\) · 2\.0s/);
    assert.equal(tl.querySelectorAll("[title]").length, 0, "the panel's tooltip, never the browser's");
    // Hovering a bar shows the panel's own event tooltip (event-tip.tsx), with what the event was and how long it took.
    const win = doc.defaultView;
    const tick = () => new Promise((r) => win.setTimeout(r, 20));   // Preact renders a state change on its next tick
    tl.querySelector(".rc-ev-gen").dispatchEvent(new win.PointerEvent("pointerenter", { bubbles: false, clientX: 50, clientY: 50 }));
    await tick();
    const tip = tl.querySelector(".rc-tip.rc-tip-event");
    assert.ok(tip, "a tooltip on hover");
    assert.match(tip.textContent, /gen 0/);
    assert.match(tip.textContent, /2\.0s|2s/);
    tl.querySelector(".rc-ev-gen").dispatchEvent(new win.PointerEvent("pointerleave", { bubbles: false }));
    await tick();
    assert.equal(tl.querySelector(".rc-tip"), null, "and gone when the pointer leaves");
    // A chip per value of the dimension hides that value's runs, and shows them again.
    const chip = (v) => [...tl.querySelectorAll(".tlfilter .rc-lane-chip")].find((c) => c.textContent.startsWith(v));
    assert.deepEqual([...tl.querySelectorAll(".tlfilter .rc-lane-chip")].map((c) => c.textContent), ["runs 2", "calls 2", "a 1", "b 1"]);
    chip("b").click();
    await tick();
    assert.deepEqual([...tl.querySelectorAll(".who")].map((w) => w.textContent), ["t · a · r0"]);
    assert.equal(chip("b").getAttribute("aria-pressed"), "false");
    chip("b").click();
    await tick();
    assert.equal(tl.querySelectorAll(".who").length, 2);
});

test("an event-kind chip hides that kind in the box row and every run's lane at once, and shows it again", async () => {
    const runs = [{ combo: { m: "a" }, who: "a", taskId: "t", repeat: 0, state: "done", ok: true }];
    const doc = await dashboard({
        dims: ["m"], runs,
        resources: { samples: [], capacities: [], events: [ev("load", 0, 1000, { via: "server" }), ev("serve", 1000, 3000, { via: "server" })] },
        timeline: { now: 4000, runs: [{ index: 0, events: [ev("run", 0, 4000), ev("gen", 1000, 3000), ev("load", 0, 1000)] }] },
    });
    const tl = card(doc, "Timeline");
    const win = doc.defaultView;
    const tick = () => new Promise((r) => win.setTimeout(r, 20));
    const chips = () => [...tl.querySelectorAll(".tlfilter .rc-lane-chip")].map((c) => c.textContent);
    // The panel's labels in the panel's order, each counted over the box row and the runs together.
    assert.deepEqual(chips(), ["runs 1", "calls 1", "loads 2", "serving 1"]);
    assert.equal(tl.querySelectorAll(".rc-ev-load").length, 2);
    const loads = [...tl.querySelectorAll(".tlfilter .rc-lane-chip")].find((c) => c.textContent.startsWith("loads"));
    loads.click();
    await tick();
    assert.equal(tl.querySelectorAll(".rc-ev-load").length, 0, "gone from the box row and the run's lane");
    assert.equal(tl.querySelectorAll(".rc-ev-serve").length, 1, "other kinds stay");
    assert.deepEqual(chips(), ["runs 1", "calls 1", "loads 2", "serving 1"], "a hidden kind keeps its chip and count");
    loads.click();
    await tick();
    assert.equal(tl.querySelectorAll(".rc-ev-load").length, 2);
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

// --- folding cards, cloud shades, the spec's links, the chart's window and keys ---

test("every card after the summary folds to its header from the chevron in its corner; the summary does not", async () => {
    const doc = await dashboard({ dims: ["m"], runs: [{ combo: { m: "a" }, taskId: "t", repeat: 0, state: "done", who: "a", ok: true }],
        rows: [{ combo: { m: "a" }, taskId: "t", agg: { runs: 1, errors: 0 } }], columns: [] });
    assert.equal(doc.querySelector("main > .card").querySelector(".foldbtn"), null, "the summary has no fold");
    const results = card(doc, "Results");
    const btn = results.querySelector(":scope > .foldbtn");
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    assert.match(btn.getAttribute("data-tip"), /^Hide the results/);
    btn.click();
    await new Promise((r) => doc.defaultView.setTimeout(r, 20));
    assert.ok(results.classList.contains("folded"));
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    assert.ok(results.querySelector("table"), "its content stays mounted, hidden by the stylesheet");
    assert.equal(doc.querySelectorAll("#app [title]").length, 0);
});

test("the Spec card shows the spec's path on disk, linked to the file at the build's commit; the build links to the commit", async () => {
    const hash = "118a480b5725bc4fb246e90a948eedc2a44281f3";
    const spec = { at: "2026-10-09T10:00:00Z", by: "a", specHash: "99c98c58f379", fingerprint: hash, dirty: false, spec: "tests/e2e/bench/specs/x.bench.ts", onDisk: "/home/a/clone/tests/e2e/bench/specs/x.bench.ts",
        source: "export default {};\n", sweeps: 1, previous: null, changed: null, diff: null, tooBig: false, stat: null, history: [] };
    const doc = await dashboard({ spec, repo: "https://github.com/o/r" });
    const links = [...doc.querySelectorAll("#spec a[href]")].map((a) => [a.textContent, a.getAttribute("href")]);
    assert.deepEqual(links, [
        ["/home/a/clone/tests/e2e/bench/specs/x.bench.ts", `https://github.com/o/r/blob/${hash}/tests/e2e/bench/specs/x.bench.ts`],
        [hash, `https://github.com/o/r/commit/${hash}`],
    ]);
    assert.ok([...doc.querySelectorAll("#spec a[href]")].every((a) => a.getAttribute("rel")?.includes("noopener")));
    // A dirty build's commit is not what ran: the tips say so.
    const dirty = await dashboard({ spec: { ...spec, fingerprint: `${hash}+1a2b3c4d`, dirty: true }, repo: "https://github.com/o/r" });
    assert.match(dirty.querySelector(`#spec a[href$="/commit/${hash}"]`).getAttribute("data-tip"), /uncommitted changes .* not in that commit/);
    // No repo known, or a record from before the path was kept: the repo path, as text.
    const old = await dashboard({ spec: { ...spec, onDisk: null } });
    assert.equal(old.querySelectorAll("#spec a[href]").length, 0);
    assert.match(old.querySelector("#spec dd code").textContent, /^tests\/e2e\/bench\/specs\/x\.bench\.ts$/);
});

test("a cloud model is drawn in its own shade of its hue: a local model keeps the plain hue", async () => {
    const run = (m) => ({ combo: { model: m }, taskId: "t", repeat: 0, state: "done", who: m, ok: true, models: { driver: m } });
    const doc = await dashboard({ dims: ["model"], runs: [run("local:7b"), run("cloud.model")], cloud: ["cloud.model"],
        timeline: { now: 10_000, runs: [0, 1].map((index) => ({ index, events: [ev("run", index * 1000, index * 1000 + 500)] })) } });
    const swatch = (m) => [...doc.querySelectorAll(".tlfilter .rc-lane-chip")].find((c) => c.textContent.startsWith(m)).querySelector(".swatch").style.background;
    assert.match(swatch("cloud.model"), /^color-mix\(in srgb, #[0-9a-f]{6} 55%, var\(--fg\)\)$/i);
    assert.match(swatch("local:7b"), /^(#[0-9a-f]{6}|rgb\()/i);
});

test("a finished sweep's chart is framed to the sweep, and Esc on the page reaches the chart's keys", async (t) => {
    const { readSample, packSamples } = await import("../tests/e2e/bench/resource-poll.mjs");
    const GiB = 1024 ** 3;
    const info = { compute: { system_compute: { cpu_cores: 8, total_memory: 64 * GiB, free_memory: 32 * GiB, free_swap: 0 }, supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 24 * GiB, free_memory: 20 * GiB, compute: "8.6", driver: "13" }] } };
    const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith("/api/ps") ? { models: [] } : info) });
    const reads = [];
    for (let k = 0; k < 20; k++) reads.push(await readSample({ chatUrl: "http://box/api/chat/completions" }, { fetchImpl, now: () => 1000 + k * 2000 }));
    const html = await staticPage({ name: "x", dims: [], runs: [{ combo: {}, taskId: "t", repeat: 0, state: "done", who: "x", ok: true }], rows: [], jobs: 1,
        started: 5000, finished: 30_000, resources: packSamples(reads), timeline: { now: 30_000, runs: [{ index: 0, events: [ev("run", 6000, 20_000)] }] } });
    const w = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true }).window;
    t.after(() => w.close());   // the chart ticks on an interval
    const tick = () => new Promise((r) => w.setTimeout(r, 30));
    await tick();
    assert.ok(w.document.querySelector(".tlchart .rc-scrub"), "framed to 5 s to 30 s, inside the readings' 1 s to 39 s: the strip shows where");
    w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    assert.equal(w.document.querySelector(".tlchart .rc-scrub"), null, "Esc let go of the frame: the whole of the readings, no strip");
});
