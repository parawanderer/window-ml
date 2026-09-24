// sidebar-output.test.js — what a tool's output looks like on screen: the shared output cell and its cap,
// code blocks and their gutters, tracebacks that link back into the code, the python bench, and tables.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, openSettings, hoverTip, openRun, sidebarCss } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// THE DIFF'S GUTTER, across every combination of the two things that decide it. The numbers earn their
// width because the new-side column matches the gutter of the code block below — read straight down between
// a diff row, a margin note and the failure mark. With that gutter off they line up with nothing, so they
// are just width taken in a narrow panel. A failure turns the block's gutter on by itself, so the two can
// never disagree; these tests are the proof of that rather than the hope.
const diffStep = (hash, { failed, seq = 1 } = {}) => ({
    seq, tool: "python_exec", arguments: { code: "x = 1\nreturn x" },
    result: failed ? "Python error: boom" : "1",
    renderIn: {
        type: "python-in", mode: "script", code: "x = 1\nreturn x",
        revision: { ref: "@tool:abc1234", tool: "python_exec", seq: 0, before: "x = 0\nreturn x", claim: "bumped it" },
    },
    ...(failed ? { renderOut: { type: "python-out", error: 'File "<python_exec>", line 1, in _user\nBoom' } } : {}),
});

for (const [lines, failed, wantNums, why] of [
    [false, false, false, "no gutter below and nothing went wrong → nothing to line up with"],
    [true, false, true, "you asked for line numbers, so the block has them and the diff matches"],
    [false, true, true, "a failure turns the block's gutter on by itself, so the diff follows"],
    [true, true, true, "both, and it is still one gutter"],
]) {
    test(`diff gutter: lines=${lines} failed=${failed} → numbers ${wantNums ? "shown" : "hidden"}`, async () => {
        const w = await loadSidebarWorld({ local: { ml_debug_codelines: lines } });
        await w.dispatch(agentStart("dg", "retry it"));
        await w.dispatch(agentStep("dg", 1, diffStep("dg", { failed })));
        w.shadow.querySelector(".row").click(); await w.tick();
        w.shadow.querySelector(".astep-head").click(); await w.tick();

        const diff = w.shadow.querySelector(".r-diff");
        assert.ok(diff, "the diff renders either way");
        // A failure opens it; a success shows one collapsed line, so open it to see the rows.
        if (!failed) { diff.querySelector(".r-diff-tri").click(); await w.tick(); }
        const rows = w.shadow.querySelectorAll(".r-diff-body .dline");
        assert.ok(rows.length, "the rows are drawn");
        assert.equal(w.shadow.querySelectorAll(".r-diff-body .dno").length > 0, wantNums, why);
        // The two must not disagree: if the diff numbers, the block below it numbers too.
        if (wantNums) assert.ok(w.shadow.querySelector(".r-py-in .lno"), "…and the block below has its gutter");
    });
}

// The table view's two modes (docs/spec/TABLE_VIEW.md): a table larger than the grid draws opens as a per-column SUMMARY,
// computed over the WHOLE table when the value store holds it and over the preview (saying so) when it does not; the copy
// control copies all of it only when all of it is reachable.
const bigTable = (value) => ({ type: "table", columns: ["id", "region"], rows: Array.from({ length: 200 }, (_, i) => [i, i % 2 ? "south" : "north"]), rowCount: 300, dtypes: { id: "int64", region: "str" }, delimiter: ",", ...(value ? { value } : {}) });

const openTableStep = async (w, hash, renderOut) => {
    await w.dispatch(agentStart(hash, "read the table"));
    await w.dispatch(agentStep(hash, 1, { tool: "fetch_url", arguments: { url: "https://x.test/t.csv" }, result: "type: csv", renderOut }));
    await w.dispatch(agentResult(hash, "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
};

// By the accessible NAME: the controls are icons, so their label is what carries the words — including the copy's,
// which says how much it will copy ("copy all 300 rows") and is the reason that one is not merely decorative.
const btn = (w, re) => [...w.shadow.querySelectorAll(".r-df-btn")].find((b) => re.test(b.getAttribute("aria-label") || ""));

// --- the shared output cell: streamed text, the cap, timestamps and the out footer -----------------------

// Live tool output (ctx.stream): a stream delta patches the running step's Out ADDITIVELY (Jupyter-style),
// and the DONE (with a result) supersedes it. The delta carries no `tool`, so it must not rebuild the row.
test("live tool output (sidebar): a stream delta fills the running step's Out; the DONE supersedes it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("liveout", "run code"));
    await w.dispatch(agentStep("liveout", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "loop()" } }));
    await w.dispatch(agentStep("liveout", 1, { seq: 1, streamOutput: "tick 1\ntick 2\n" }));   // a delta — NO tool
    await openRun(w);
    assert.match(w.shadow.querySelector(".astep-preview").textContent, /tick/, "the live output shows in the collapsed step preview (not 'running…')");
    w.shadow.querySelector(".astep-head").click(); await w.tick();
    const live = w.shadow.querySelector(".astep-streaming");
    assert.ok(live, "the live output renders in the Out block while the step runs");
    assert.match(live.textContent, /tick 1[\s\S]*tick 2/, "the streamed console output fills in");
    // A late delta keeps the pending row intact (tool/args preserved — the additive patch).
    assert.match(w.shadow.querySelector(".astep-head").textContent, /exec/, "the tool identity survived the additive delta");
    // DONE: the real result supersedes the live block.
    await w.dispatch(agentStep("liveout", 1, { seq: 1, tool: "exec", arguments: { js: "loop()" }, result: "console:\ntick 1\ntick 2\n\nvalue: 2" }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".astep-streaming"), null, "the live block clears once the result lands");
});

// The shared tool OUTPUT CELL: python_exec and exec BOTH render their Out into it, so it caps + scrolls +
// offers a resize grip identically — and any future code-ish tool (a bash_exec, say) inherits that by
// wrapping its own sections in the same component. Also pins the per-tool section labels (stdout vs console).
test("tool output cell: python_exec AND exec both render into the shared capped/scrollable cell", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("outcell", "run both"));
    await w.dispatch(agentStep("outcell", 1, {
        seq: 1, tool: "python_exec", arguments: { code: "print(1)" }, result: "stdout:\n1\n",
        renderOut: { type: "python-out", stdout: "1", value: "None" },
    }));
    await w.dispatch(agentStep("outcell", 2, {
        seq: 2, tool: "exec", arguments: { js: "console.log('a'); 7" }, result: "console:\na\n\nvalue: 7",
        renderOut: { type: "exec-out", stdout: "a", value: "7" },
    }));
    // A tool with NO renderer at all — its plain Out (a fetch_url page, a sampleText dump) must reuse the
    // SAME cell, which is the whole point of putting it on the generic path.
    await w.dispatch(agentStep("outcell", 3, { seq: 3, tool: "fetch_url", arguments: { url: "http://x/" }, result: "Fetched http://x/ — HTTP 200.\n\nsome page text" }));
    await w.dispatch(agentResult("outcell", "done", 3));
    await openRun(w);
    for (const head of [...w.shadow.querySelectorAll(".astep.tool .astep-head")]) { head.click(); await w.tick(); }
    // Each code tool's OUT renders its captured output through the shared cell — every text section of it,
    // since a returned VALUE can be as long as anything printed on the way there and is the half you most
    // often want to search. So: both tools, and both of their sections (stdout + value).
    const outCells = w.shadow.querySelectorAll(".r-py-out .r-outcell");
    assert.equal(outCells.length, 4, "BOTH tools' stdout AND value use the shared cell (not one bespoke each)");
    for (const cls of [".r-py-stdout", ".r-py-val"]) {
        assert.equal(w.shadow.querySelectorAll(`${cls} .r-outcell`).length, 2, `both tools' ${cls} is a cell`);
    }
    // …and the SAME component wraps the RAW view of either slot — a descriptor-less tool's plain Out, and
    // the raw In, which is the view you go to in order to SEARCH for a token and the one with no structure
    // of its own to cap it. A call carrying a base64 image or a wide table stretches the step to any height
    // otherwise, which is the case the cap exists for. The RENDERED In is not wrapped: it is already a code
    // block with its own chrome.
    const rawIns = [...w.shadow.querySelectorAll(".astep.tool .io")]
        .filter((io) => io.querySelector(".io-label")?.textContent.startsWith("In"));
    assert.ok(rawIns.length >= 3, "every step has an In block");
    assert.equal(w.shadow.querySelectorAll("[data-cite='in'] .r-outcell").length, rawIns.length,
        "each In's RAW view is a cell — findable and capped like an Out");
    // The rendered In stays uncelled — a code block already caps and scrolls itself.
    assert.equal(w.shadow.querySelectorAll(".r-py-in .r-outcell").length, 0, "the rendered In is not double-wrapped");
    for (const cell of outCells) {
        const scroll = cell.querySelector(".r-outscroll");
        assert.ok(scroll, "the cell scrolls its overflow");
        assert.match(scroll.getAttribute("style") || "", /max-height:\s*260px/, "capped at the configured height");
    }
    const labels = [...w.shadow.querySelectorAll(".r-py-lbl")].map(e => e.textContent);
    assert.ok(labels.includes("stdout"), "python's captured output is labelled stdout");
    assert.ok(labels.includes("console"), "exec's is labelled console (it captured console.log, not a stdout stream)");
});

// The captured-but-unseen tail: output past `seen` was clipped out of the model-facing result, so it renders
// MARKED (dimmed, under an explicit label) instead of silently reading as "what the model saw".
test("tool output: the part the model never received renders marked, not as plain output", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("unseen", "run it"));
    await w.dispatch(agentStep("unseen", 1, {
        seq: 1, tool: "exec", arguments: { js: "…" }, result: "console:\nSEEN… [+4 chars truncated]",
        renderOut: { type: "exec-out", stdout: "SEENUNSEEN", seen: 4, value: "1" },
    }));
    await w.dispatch(agentResult("unseen", "done", 1));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const marked = w.shadow.querySelector(".r-unseen");
    assert.ok(marked, "the surplus renders in its own marked block");
    assert.match(marked.textContent, /UNSEEN/, "…and it holds the text past the model's cut");
    assert.doesNotMatch(marked.textContent, /^SEEN[^U]/, "the part the model DID read stays in the normal block");
    assert.match(w.shadow.querySelector(".r-unseen-lbl").textContent, /NOT sent to the model/i, "labelled explicitly");
});

// While a step is STILL RUNNING we already know where the model's cut will fall, so the doomed tail is greyed
// as it streams (with a "?" explainer) rather than springing the truncation on you at the end. The boundary
// comes from the call's own args, so a model-requested (approved) larger cap is respected live.
test("live output: the doomed tail is marked AS IT STREAMS, at the call's own raised cap", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("livecut", "run it"));
    await w.dispatch(agentStep("livecut", 1, { seq: 1, pending: true, tool: "exec",
        arguments: { js: "loop()", maxChars: 600, maxCharsReason: "need the whole dump" } }));
    await w.dispatch(agentStep("livecut", 1, { seq: 1, streamOutput: "A".repeat(700) }));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const lbl = w.shadow.querySelector(".r-unseen-lbl.live");
    assert.ok(lbl, "the streaming view marks where the model's cut will fall");
    assert.match(lbl.textContent, /cutoff/i, "…labelled as the model's cutoff, not a past-tense 'was clipped'");
    assert.match(await hoverTip(w, lbl), /NOT be part of the result sent to the model/i, "with a hover explainer");
    const tail = w.shadow.querySelector(".r-unseen");
    assert.ok(tail && tail.textContent.trim().length >= 100, "exactly the text past the RAISED 600-char cap is marked");
});

// The executor's per-line timestamps must SURVIVE the step settling: the finished Out renders the same
// captured text the stream produced, so the gutter shouldn't vanish the moment the tool returns.
test("streamed timestamps survive the DONE and time the settled output", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tsdone", "run it"));
    await w.dispatch(agentStep("tsdone", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "…" } }));
    await w.dispatch(agentStep("tsdone", 1, { seq: 1, streamOutput: "one\ntwo\n", streamMarks: [[0, 1731000000000], [4, 1731000002000]] }));
    // The DONE carries the real result + render, and NO marks — they must be kept, not wiped.
    await w.dispatch(agentStep("tsdone", 1, { seq: 1, tool: "exec", arguments: { js: "…" }, result: "console:\none\ntwo\n\nvalue: 1",
        renderOut: { type: "exec-out", stdout: "one\ntwo\n", value: "1" } }));
    await w.dispatch(agentResult("tsdone", "done", 1));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const stamps = [...w.shadow.querySelectorAll(".r-ts")].map(e => e.textContent).filter(Boolean);
    assert.ok(stamps.length >= 2, "the settled output still shows the executor's timestamps");
    assert.notEqual(stamps[0], stamps[1], "and a later line shows its own (changed) time");
    assert.match(await hoverTip(w, w.shadow.querySelector(".r-ts.hoverable")), /\d\d:\d\d:\d\d\.\d\d\d/, "hover carries millisecond precision");
});

// The rendered/raw toggle only exists once a descriptor lands (i.e. when the step settles), so it used to
// APPEAR on completion and push the whole block down. It's now reserved — present but inert — while output
// is still streaming, so the settled layout matches the live one.
test("rendered/raw toggle: reserved (disabled) while streaming, live once the step settles", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rrtog", "run it"));
    await w.dispatch(agentStep("rrtog", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "loop()" } }));
    await w.dispatch(agentStep("rrtog", 1, { seq: 1, streamOutput: "line 1\n" }));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const outToggle = () => [...w.shadow.querySelectorAll(".io")].find(io => /^Out/.test(io.querySelector(".io-label").textContent))?.querySelector(".rr-toggle");
    const live = outToggle();
    assert.ok(live, "the toggle's space is held while output streams");
    assert.match(live.className, /reserved/);
    assert.ok([...live.querySelectorAll("button")].every(b => b.disabled), "…but neither button is usable yet");
    // The DONE brings the descriptor → the same row becomes usable, no new row appearing.
    await w.dispatch(agentStep("rrtog", 1, { seq: 1, tool: "exec", arguments: { js: "loop()" }, result: "console:\nline 1\n\nvalue: 1",
        renderOut: { type: "exec-out", stdout: "line 1\n", value: "1" } }));
    await w.tick();
    const settled = outToggle();
    assert.ok(settled, "the toggle is still there");
    assert.doesNotMatch(settled.className, /reserved/);
    assert.ok([...settled.querySelectorAll("button")].every(b => !b.disabled), "both buttons work once it settles");
});

// NON-streaming runs must keep working exactly as before: no live output, the step just says "running…" and
// then shows the full result when it lands. (Streaming is opt-in; this is the path most runs take.)
test("non-streaming run: the step waits with 'running…' and then shows the full result", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nostream", "run it"));
    await w.dispatch(agentStep("nostream", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "work()" } }));
    await openRun(w);
    // Collapsed preview says running…; no live block, and no reserved toggle (nothing is streaming).
    assert.match(w.shadow.querySelector(".astep-preview").textContent, /running…/);
    assert.equal(w.shadow.querySelector(".astep-streaming"), null, "no live output block without streaming");
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    assert.equal(w.shadow.querySelector(".rr-toggle.reserved"), null, "nothing reserved — no descriptor is pending");
    const outBlock = () => [...w.shadow.querySelectorAll(".io")].find(io => /^Out/.test(io.querySelector(".io-label").textContent));
    assert.match(outBlock().textContent, /running…/, "the Out waits");
    // The DONE brings everything at once.
    await w.dispatch(agentStep("nostream", 1, { seq: 1, tool: "exec", arguments: { js: "work()" }, result: "console:\nall of it\n\nvalue: 42",
        renderOut: { type: "exec-out", stdout: "all of it", value: "42" } }));
    await w.dispatch(agentResult("nostream", "done", 1));
    await w.tick();
    const out = outBlock();
    assert.match(out.textContent, /all of it/, "the full captured output appears on completion");
    assert.match(out.textContent, /42/, "…and the returned value");
    assert.equal(w.shadow.querySelector(".r-ts"), null, "no timestamp gutter — nothing streamed, so there are no marks");
});

test("streamed output: a rule separates the timestamp gutter from the text", async () => {
    // The stamps are right-aligned in a fixed column; without an edge, leading whitespace in the output has
    // nothing to be measured against. Same device as a line-number gutter's rule.
    const css = sidebarCss();
    // DRAWN BY THE CONTAINER, not by each row: as a per-row border it stopped at the last line, which is
    // right in a transcript and wrong in the bench, where the block fills a pane you sized yourself and the
    // column ended in mid-air. Pinned to both edges, so it is as tall as whatever it is inside.
    const rule = /\n\.r-timed::after \{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.ok(rule, "the gutter rule exists");
    assert.match(rule, /position:\s*absolute/, "positioned, so it can span the container rather than a row");
    assert.match(rule, /top:\s*0/, "…pinned to the top");
    assert.match(rule, /bottom:\s*0/, "…and the bottom, which is what makes it outlive the last line");
    const row = /\n\.r-ts \{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.ok(row, "the gutter column still exists");
    assert.doesNotMatch(row, /border-right/, "and the rows no longer draw their own — two would double up");
    assert.match(row, /padding-right/, "spaced by padding so the rule sits inside the row gap");
});

// A COLLAPSED running step. "running…" says the thing is alive; it does not say whether it has been alive
// for two seconds or two minutes, which is the difference between waiting and going to look.
test("a collapsed running step counts up, and stays quiet for the first half second", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tick", "do a slow thing"));
    // ts is when the step STARTED. A step that has just begun shows the word and no number: an ordinary
    // fast tool must not flash a figure on its way past.
    await w.dispatch(agentStep("tick", 1, { seq: 1, tool: "python_exec", pending: true, ts: Date.now() }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    // Opening the detail view can itself take longer than half a second on a loaded CI runner, and then the
    // counter is right to appear. So the step is re-stamped as just started immediately before the read.
    await w.dispatch(agentStep("tick", 1, { seq: 1, tool: "python_exec", pending: true, ts: Date.now() }));
    await w.tick();
    const preview = () => w.shadow.querySelector(".astep-preview").textContent;
    assert.match(preview(), /running…/);
    assert.equal(w.shadow.querySelector(".astep-elapsed"), null, "silent under half a second");

    // …and one that has been going a while says how long, in the row you are looking at rather than only
    // inside the step you would have to open.
    const stamp = Date.now() - 4200;
    await w.dispatch(agentStep("tick", 1, { seq: 1, tool: "python_exec", pending: true, ts: stamp }));
    await w.tick();
    const el = w.shadow.querySelector(".astep-elapsed");
    assert.ok(el, "past the threshold it reports the elapsed time");
    // The figure is read against the component's last 100 ms tick, so on a starved event loop (Node 22 on a
    // loaded CI runner showed 3.9s) it TRAILS the true elapsed time. It may trail; it may not run ahead, and it
    // must clearly be the step's age rather than a fresh count.
    const shown = Number(/\((\d+(?:\.\d+)?)s\)/.exec(el.textContent)?.[1]);
    const actual = (Date.now() - stamp) / 1000;
    assert.ok(shown <= actual + 0.05, `never ahead of the clock: showed ${shown}s after ${actual.toFixed(2)}s`);
    assert.ok(shown >= 3, `the step's age, not a fresh count: showed ${el.textContent}`);
    assert.match(preview(), /running….*\(\d+\.\d+s\)/, "beside the word, not instead of it");
});

test("the elapsed timer stops when the step lands, and the settled figure takes over", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tick2", "do a slow thing"));
    await w.dispatch(agentStep("tick2", 1, { seq: 1, tool: "exec", pending: true, ts: Date.now() - 3000 }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".astep-elapsed"), "ticking while it runs");
    // DONE. A finished step has a measured `toolMs`, so the estimate has nothing left to say.
    await w.dispatch(agentStep("tick2", 1, { seq: 1, tool: "exec", result: "2", toolMs: 3100 }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".astep-elapsed"), null, "the live counter is gone once it landed");
});

// HOW LONG IT RAN, under the output. A script's elapsed time is the one fact about it the transcript cannot
// give you: the timestamps either side include the model's own turn. And while it is still going, the
// difference between "slow" and "stuck".
//
// It hangs off the CONSOLE when there is one and off the last section when there is not — the console is not
// always there, and conjuring an empty one to hold a footer would be chrome pretending to be output.

test("out footer: the elapsed time sits inside the console when there IS one", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ran1", "compute"));
    await w.dispatch(agentStep("ran1", 1, {
        seq: 1, tool: "python_exec", toolMs: 1234, arguments: { code: "print(1)" }, result: "ok",
        renderOut: { type: "python-out", stdout: "1\n", value: "42" },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep-head").click();
    await w.tick();

    const foot = w.shadow.querySelector(".r-ranfor");
    assert.ok(foot, "the footer rendered");
    assert.match(foot.textContent, /ran in 1\.2s/, "the tool's own wall clock, humanised");
    assert.ok(foot.closest(".r-py-stdout"), "…inside the console section, which exists here");
});

test("out footer: with no console it goes after the last section instead", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ran2", "compute"));
    await w.dispatch(agentStep("ran2", 1, {
        seq: 1, tool: "python_exec", toolMs: 400, arguments: { code: "1+1" }, result: "ok",
        renderOut: { type: "python-out", value: "2" },   // nothing printed
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep-head").click();
    await w.tick();

    const foots = [...w.shadow.querySelectorAll(".r-ranfor")];
    assert.equal(foots.length, 1, "exactly one footer — never both placements");
    assert.equal(foots[0].closest(".r-py-stdout"), null, "there is no console to sit in");
    assert.match(foots[0].textContent, /ran in 400ms/);
    // And no empty console section was conjured up to hold it.
    assert.equal(w.shadow.querySelector(".r-py-stdout"), null);
});

test("out footer: while the step is RUNNING it counts up instead", async () => {
    const w = await loadSidebarWorld();
    // The step started 2.5s ago, and the footer's job is to show time since THAT — not since the panel
    // opened, and not a settled figure.
    const startedAt = Date.now() - 2500;
    await w.dispatch(agentStart("ran3", "compute"));
    await w.dispatch(agentStep("ran3", 1, {
        seq: 1, tool: "python_exec", pending: true, ts: startedAt,
        arguments: { code: "time.sleep(9)" }, streamOutput: "working\n",
        renderOut: { type: "python-out", stdout: "working\n" },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const open = w.shadow.querySelector(".astep-head");
    if (open) { open.click(); await w.tick(); }

    const foot = w.shadow.querySelector(".r-ranfor");
    assert.ok(foot, "a running step has one too — that is the case it matters most for");
    assert.match(foot.textContent, /running…/, "it says it has not finished");
    assert.ok(foot.classList.contains("live"));
    // NOT a final "ran in": a settled figure on a step still going would be a measurement that is quietly
    // still growing.
    assert.doesNotMatch(foot.textContent, /ran in/);

    // AGAINST THE SAME CLOCK THE STAMP CAME FROM, not against a literal. This asserted the digit was a 2 or
    // a 3, which made it a measurement of how fast the TEST RUNNER is: everything between the stamp and the
    // render — building the world, two dispatches, two clicks, two ticks — is counted too, so a loaded CI
    // box read 4.1s and failed. Node 26 tripped it in CI while 22 and 24 passed, which is the shape of a
    // machine-speed assertion rather than a product one.
    const shown = Number(/([\d.]+)\s*s/.exec(foot.textContent)?.[1]);
    const elapsed = (Date.now() - startedAt) / 1000;
    assert.ok(Number.isFinite(shown), `the footer shows a figure — got ${JSON.stringify(foot.textContent)}`);
    assert.ok(shown >= 2.4, `counted from the STEP's start, not from when the panel opened (${shown}s)`);
    // The footer repaints on a one-second tick, so what it shows is the elapsed time at its LAST paint — read at an
    // arbitrary moment after that, it trails the clock by up to the tick plus however late a loaded runner paints
    // (CI measured 1.6s behind on Node 26). So: never AHEAD of the clock, and not frozen — within the tick and a
    // generous lag — rather than a tolerance that measures the runner's speed again.
    assert.ok(shown <= elapsed + 0.05, `never ahead of the clock it counts from (showed ${shown}s, actual ${elapsed.toFixed(1)}s)`);
    assert.ok(elapsed - shown < 3,
        `and it is that clock's elapsed time, not a frozen figure (showed ${shown}s, actual ${elapsed.toFixed(1)}s)`);
});

// --- a code block on screen: theming, the line gutter, beautifying and the diff --------------------------

test("exec code is beautified for display when the descriptor sets format", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bty", "run js"));
    const ugly = "[...document.querySelectorAll('a')].map(x=>{const y=x.href;return {y}})";
    await w.dispatch(agentStep("bty", 1, { tool: "exec", arguments: { js: ugly }, result: "ok", renderIn: { type: "code", text: ugly, lang: "javascript", format: true } }));
    await w.dispatch(agentResult("bty", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();

    const code = w.shadow.querySelector("details.io .code").textContent;
    assert.match(code, /=> \{/, "arrow body spaced out by the beautifier");
    assert.ok(code.split("\n").length >= 3, "reflowed onto multiple lines (source was one line)");
});

test("code colour theme: a stored preset or VS Code theme is applied when the panel loads", async () => {
    // The default draws on the panel's own colours, so it sets no surface override.
    const def = await loadSidebarWorld();
    assert.equal(def.window.document.documentElement.style.getPropertyValue("--code-bg"), "");
    // A stored preset: its stylesheet goes in, and its surface colours ride the root.
    const nord = await loadSidebarWorld({ local: { ml_code_theme: "nord" } });
    assert.equal(nord.window.document.documentElement.style.getPropertyValue("--code-bg").trim(), "#2E3440");
    assert.ok([...nord.window.document.querySelectorAll("style")].some((s) => /#81A1C1/i.test(s.textContent)), "Nord's stylesheet is live");
    // A stored VS Code theme is converted from its source text on load.
    const text = require("node:fs").readFileSync(require("node:path").join(__dirname, "fixtures/vscode-theme.jsonc"), "utf8");
    const vs = await loadSidebarWorld({ local: { ml_code_theme: "vscode", ml_code_theme_vscode: { name: "Fixture Sunset", text } } });
    assert.equal(vs.window.document.documentElement.style.getPropertyValue("--code-bg").trim(), "#1b1426");
    assert.ok([...vs.window.document.querySelectorAll("style")].some((s) => s.textContent.includes(".hljs-keyword{color:#ff4f9a")));
    // …and, by default, the whole PANEL too: its colours and its light/dark, over a panel set to light.
    const html = vs.window.document.documentElement;
    assert.equal(html.style.getPropertyValue("--bg").trim(), "#160f20");
    assert.equal(html.style.getPropertyValue("--code-sel").trim(), "#6b4f9a55", "the theme's own selection tint");
    assert.equal(html.getAttribute("data-theme"), "dark", "a dark theme makes the panel dark");
    // With the panel toggle OFF, the code keeps the theme and the panel keeps its own palette.
    const codeOnly = await loadSidebarWorld({ sync: { theme: "light" }, local: { ml_code_theme: "vscode", ml_code_theme_vscode: { name: "Fixture Sunset", text }, ml_code_theme_ui: false } });
    const h2 = codeOnly.window.document.documentElement;
    assert.equal(h2.style.getPropertyValue("--bg"), "", "no panel token set");
    assert.equal(h2.style.getPropertyValue("--code-bg").trim(), "#1b1426");
    assert.equal(h2.getAttribute("data-theme"), "light");
});

test("code line-number gutter: off by default, toggled on via settings, applied from storage", async () => {
    // Applied from storage on mount.
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    const html = w.window.document.documentElement;
    assert.equal(html.getAttribute("data-codelines"), "on", "gutter attr set from storage.local");
    await w.dispatch(agentStart("ln", "x"));
    await w.dispatch(agentStep("ln", 1, { tool: "exec", arguments: { js: "a;\nb;\nc;" }, result: "ok", renderIn: { type: "code", text: "a;\nb;\nc;", lang: "javascript" } }));
    await w.dispatch(agentResult("ln", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");   // the In block (the JS)
    const nos = [...inB.querySelectorAll(".code.numbered .cline .lno")].map(n => n.textContent);
    assert.deepEqual(nos, ["1", "2", "3"], "one right-aligned number per source line");
});

test("code line-number gutter: a ONE-line block is not numbered by the preference alone", async () => {
    // The gutter exists so you can find a line something else names; nothing names line 1 of `23`, so a lone
    // "1" beside a one-line value or snippet is noise. (A mark still numbers it — pinned by the traceback tests.)
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    await w.dispatch(agentStart("ln1", "x"));
    await w.dispatch(agentStep("ln1", 1, { tool: "exec", arguments: { js: "document.title" }, result: "ok", renderIn: { type: "code", text: "document.title", lang: "javascript" } }));
    await w.dispatch(agentResult("ln1", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");
    assert.ok(inB.querySelector(".code"), "the block is there");
    assert.equal(inB.querySelectorAll(".code.numbered").length, 0, "…and draws no gutter for its single line");
});

test("numbered gutter preserves line content — no spurious span-reopen prefix", async () => {
    // Regression: a text token starting with " s" was misread as a <span> open and
    // re-emitted on every following line (e.g. "searchResults = " leaking downward).
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    const js = "const searchResults = 1;\nconsole.log('n:', searchResults);\nreturn searchResults;";
    await w.dispatch(agentStart("lnp", "x"));
    await w.dispatch(agentStep("lnp", 1, { tool: "exec", arguments: { js }, result: "1", renderIn: { type: "code", text: js, lang: "javascript" } }));
    await w.dispatch(agentResult("lnp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");
    const lines = [...inB.querySelectorAll(".code.numbered .cline .lcode")].map(n => n.textContent);
    assert.deepEqual(lines, js.split("\n"), "each rendered line matches its source line exactly");
});

test("code display prefs: wrap⇄scroll + line-number toggles flip root attrs and persist", async () => {
    const w = await loadSidebarWorld();
    const html = w.window.document.documentElement;
    assert.equal(html.getAttribute("data-codewrap"), "on", "wrap on by default");
    assert.equal(html.getAttribute("data-codelines"), "off", "gutter off by default");

    await openSettings(w, "Appearance");

    const sel = [...w.shadow.querySelectorAll(".settings select")].find(s => [...s.options].some(o => o.value === "scroll"));
    sel.value = "scroll";
    sel.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(html.getAttribute("data-codewrap"), "off", "wrap → scroll");
    assert.equal(w.localStore.ml_debug_codewrap, false, "scroll persisted");

    const chk = [...w.shadow.querySelectorAll(".settings .set-check")]
        .find(l => /line numbers/i.test(l.textContent)).querySelector("input");
    chk.click();
    await w.tick();
    assert.equal(html.getAttribute("data-codelines"), "on", "line numbers toggled on");
    assert.equal(w.localStore.ml_debug_codelines, true, "line numbers persisted");
});

// THE POINTER CHIP is ONE component (ui-kit's PointerChip) — the copy chip under a step and the "revises"
// pill on a retry both draw through it. It was a CSS copy for a while, which is exactly how two surfaces
// start drawing the same thing differently; this is what stops that coming back.
test("a pointer reads the same whether it is copied under a step or revised by one", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("chip", "retry it"));
    await w.dispatch(agentStep("chip", 1, {
        seq: 1, tool: "python_exec", result: "1", token: "@tool:abc1234",
        arguments: { code: "x = 1" },
        renderIn: { type: "python-in", mode: "script", code: "x = 1",
                    revision: { ref: "@tool:dead000", tool: "python_exec", seq: 0, before: "x = 0" } },
    }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep-head").click(); await w.tick();

    const chips = [...w.shadow.querySelectorAll(".tok-chip")];
    assert.equal(chips.length, 2, "the step's own pointer, and the one it revises");
    // Same shell, so the same class carries the chrome and each still says its own thing.
    assert.ok(chips.every((c) => c.querySelector("code")), "both draw the reference as code");
    assert.ok(chips.every((c) => c.querySelector(".tt-pop")), "…and both explain themselves on hover");
});

// WHAT THE PILL SAYS depends on whether the model NAMED the output it is revising. A name it wrote is worth
// more than a hex address; a name we invent is worth less than one.
test("the revises pill shows the model's own name for the call, and the raw pointer when it has none", async () => {
    const step = (revision) => ({
        seq: 1, tool: "python_exec", result: "1", arguments: { code: "x = 1" },
        renderIn: { type: "python-in", mode: "script", code: "x = 1", revision },
    });
    // NAMED: the tool prefixes it, so "the q1+q2 totals" cannot be mistaken for a step title.
    const named = await loadSidebarWorld();
    await named.dispatch(agentStart("n", "retry"));
    await named.dispatch(agentStep("n", 1, step({ ref: "@tool:abc1234", tool: "python_exec", seq: 0, before: "x = 0", label: "the q1+q2 totals" })));
    named.shadow.querySelector(".row").click(); await named.tick();
    named.shadow.querySelector(".astep-head").click(); await named.tick();
    const pill = named.shadow.querySelector(".r-diff-ref");
    assert.equal(pill.textContent.replace(/\s+/g, " ").trim().split("Go to")[0].trim(), "python_exec: the q1+q2 totals");

    // UNNAMED: the raw pointer, which you can at least copy and dereference — better than a label we made up.
    const bare = await loadSidebarWorld();
    await bare.dispatch(agentStart("b", "retry"));
    await bare.dispatch(agentStep("b", 1, step({ ref: "@tool:dead000", tool: "python_exec", seq: 0, before: "x = 0" })));
    bare.shadow.querySelector(".row").click(); await bare.tick();
    bare.shadow.querySelector(".astep-head").click(); await bare.tick();
    const barePill = bare.shadow.querySelector(".r-diff-ref");
    assert.match(barePill.textContent, /@tool:dead000/);
    assert.doesNotMatch(barePill.textContent, /python_exec:/, "no invented name, and no empty prefix either");
});

test("diff gutter: a row carries only the side it exists on, and the new side matches the block below", async () => {
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    await w.dispatch(agentStart("dg2", "retry it"));
    await w.dispatch(agentStep("dg2", 1, diffStep("dg2", {})));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep-head").click(); await w.tick();
    w.shadow.querySelector(".r-diff-tri").click(); await w.tick();

    const del = w.shadow.querySelector(".dline-del"), add = w.shadow.querySelector(".dline-add");
    const nos = (el) => [...el.querySelectorAll(".dno")].map((n) => n.textContent);
    assert.deepEqual(nos(del), ["1", ""], "a deletion has no line in the NEW text");
    assert.deepEqual(nos(add), ["", "1"], "an addition has none in the OLD");
    // The point of the new column: it is the same number the code block below draws for that line.
    const blockLine = [...w.shadow.querySelectorAll(".r-py-in .cline")]
        .find((el) => el.textContent.includes("x = 1"))?.getAttribute("data-line");
    assert.equal(nos(add)[1], blockLine, "the diff's new-side number IS the block's line number");
    // A gap keeps the columns so the sign stays in one place down the block.
    const same = w.shadow.querySelector(".dline:not(.dline-add):not(.dline-del)");
    if (same) assert.equal(same.querySelectorAll(".dno").length, 2);
});

// --- a traceback that points back at the code that raised it ---------------------------------------------

// The rendered traceback: line numbers that are LINKS into the reflowed code.
//
// A traceback's whole content is a line number, and the rendered view reflows the code — so this is the one
// thing that must not silently disagree. The formatter publishes its map on the In block; the traceback maps
// through it. The text is never rewritten: this is a rendering of it.
test("python: a traceback's user lines are links, and the deepest one is marked", async () => {
    const err = [
        "Traceback (most recent call last):",
        '  File "<exec>", line 175, in <module>',
        '  File "<python_exec>", line 5, in _user',
        '  File "<python_exec>", line 2, in inner',
        "ValueError: boom",
    ].join("\n");
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: false, error: err, stdout: "" }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "x = 1"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();

    const links = [...w.shadow.querySelectorAll(".bench-outbody .tb-line")];
    assert.equal(links.length, 2, "both <python_exec> frames are addressable");
    // The CONTROL is the whole frame reference, not the bare number: two characters is a poor hit target,
    // and what you are clicking is the frame. (The bench draws unreflowed source, so the numbers are the
    // interpreter's own here — the remap only has something to do when the code moved.)
    assert.deepEqual(links.map((b) => b.textContent),
        ['File "<python_exec>", line 5', 'File "<python_exec>", line 2']);
    // The DEEPEST user frame is where it actually failed; the ones above are the call path.
    const rows = [...w.shadow.querySelectorAll(".bench-outbody .tbline")];
    const failed = rows.filter((r) => r.classList.contains("tb-fail"));
    assert.equal(failed.length, 1, "exactly one line is called out as the failure");
    // The tooltip is a hidden child of the row (read into the shared floating layer on hover), so it is in
    // `textContent` too — compare the row without it.
    const rowText = (el) => { const c = el.cloneNode(true); c.querySelectorAll(".tt-pop").forEach((n) => n.remove()); return c.textContent; };
    assert.match(rowText(failed[0]).replace(/\s+/g, " "), /line 2, in inner/);
    // The prelude's own frame is about nothing the user wrote — dimmed, never dropped: the raw view has to
    // stay recoverable, and deleting a line of what the model received is what the raw-view rule forbids.
    const dim = rows.filter((r) => r.classList.contains("dim"));
    assert.equal(dim.length, 1);
    assert.match(dim[0].textContent, /<exec>/);
    assert.match(w.shadow.querySelector(".bench-outbody .code.tb").textContent, /ValueError: boom/,
        "and every line of the original is still there");
});

// WHERE IT BROKE, marked on the CODE. A traceback tells you a number; the number is only useful once you
// have found the line it names, which on a reflowed block is not the line the number literally says.
test("python: the failing line is marked in the code, mapped through the reflow", async () => {
    // Line 3 is the failing one, and line 4 is long enough that the reflow moves everything after it.
    const code = [
        "import pandas as pd",
        "def total(frame):",
        "    return frame['nope'].sum()",
        "rows = pd.DataFrame([{'aaaaaaaaaaaaaaa': 1, 'bbbbbbbbbbbbbbb': 2, 'ccccccccccccccc': 3, 'ddddddddddddddd': 4}])",
        "total(rows)",
    ].join("\n");
    const err = [
        "Traceback (most recent call last):",
        '  File "<exec>", line 170, in <module>',
        '  File "<python_exec>", line 5, in _user',
        '  File "<python_exec>", line 3, in total',
        "KeyError: 'nope'",
    ].join("\n");
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    await w.dispatch(agentStart("pyfail", "crunch"));
    await w.dispatch(agentStep("pyfail", 1, {
        // The result IS the traceback — that is what the model received, and the raw view has to be able to
        // give it back verbatim once the render starts showing different numbers.
        seq: 1, tool: "python_exec", arguments: { code }, result: err,
        renderIn: { type: "python-in", mode: "script", code },
        renderOut: { type: "python-out", error: err },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep-head").click();   // a step is collapsed until you open it
    await w.tick();

    const marked = w.shadow.querySelector(".cline.cline-fail");
    assert.ok(marked, "the failing line is called out in the code, not only in the traceback");
    assert.match(marked.textContent, /frame\['nope'\]/, "…and it is the line that actually failed");
    // It is the DEEPEST user frame — line 3 — not the call path (line 5) and not the prelude's `<exec>`.
    assert.doesNotMatch(marked.textContent, /total\(rows\)/);
    // The caveat appears only when the formatter MOVED that line. This one it did not, so saying it might
    // have looked different would be noise that undermines the times it is true. The panel's own tooltip,
    // not a native `title`: the native one waits about a second, which on a mark you are hovering to find
    // out what it means is long enough to have given up.
    assert.equal(marked.getAttribute("title"), null, "not the slow native tooltip");
    assert.equal(marked.querySelector(".tt-pop").textContent, "This line failed.");

    // The traceback's own line numbers are links, and they inherit its colour rather than introducing a
    // third one — a blue number inside red error text reads as a different KIND of number.
    const links = [...w.shadow.querySelectorAll(".tb-line")];
    // THE NUMBERS SHOWN ARE THE ROWS ABOVE, not the ones CPython printed. The code beside this is reflowed,
    // so repeating the traceback's own number sends the reader to a line that is not the one that failed —
    // which is the entire failure mode this whole subsystem exists to prevent, reintroduced by the render.
    // Line 3 did not move, so it reads 3; the call site on line 5 did, so it reads where it now sits.
    // Read the expected rows off the DRAWN code rather than recomputing the map: the invariant is that the
    // traceback and the block agree, and comparing the render against itself is what actually says so.
    const rowOf = (needle) => [...w.shadow.querySelectorAll(".cline")]
        .find((el) => el.textContent.includes(needle))?.getAttribute("data-line");
    const callSite = rowOf("total(rows)"), failed = rowOf("frame['nope']");
    // The CONTROL is the whole frame reference, not the bare number: two characters is a poor hit target,
    // and what you are clicking is the frame.
    assert.deepEqual(links.map((b) => b.textContent),
        [`File "<python_exec>", line ${callSite}`, `File "<python_exec>", line ${failed}`]);
    assert.ok(links.every((b) => b.textContent.startsWith('File "')), "…so `File \"` is inside the button too");
    assert.notEqual(callSite, "5", "…and the test would prove nothing if the reflow had not moved it");
    // A moved number's tooltip says BOTH, so the two views cannot read as a contradiction.
    assert.match(links[0].parentElement.querySelector(".tt-pop").textContent, /model wrote it as line 5/);
    assert.doesNotMatch(links[1].parentElement.querySelector(".tt-pop").textContent, /model wrote it as/,
        "…and the line that did not move says nothing, since an unconditional caveat is noise");

    // The remap belongs to the RENDER and nowhere else. The raw view is the model-facing text verbatim, so
    // the numbers CPython actually produced stay recoverable there (the raw-view rule).
    const rawBtn = [...w.shadow.querySelectorAll(".rr-toggle button")].filter((b) => b.textContent === "raw");
    rawBtn[rawBtn.length - 1].click();
    await w.tick();
    const rawTxt = w.shadow.querySelector(".astep [data-cite='out']").textContent;
    assert.match(rawTxt, /line 5, in _user/, "the raw view keeps the number the model was given");
    assert.match(rawTxt, /line 3, in total/);
});

// THE JS TWIN of the remap. `exec` has no traceback to render — an evaluated script's stack is almost
// entirely the wrapper — so it reports one line, and the same rule applies to it: the number shown is the
// row the reader is looking at, while the model keeps the number it was given.
test("exec: the rendered error names the row on SCREEN, and raw keeps the model's line", async () => {
    // One dense line the beautifier breaks into many, so the model's line 1 is not row 1 of what is drawn.
    const js = "const rows=[{a:1},{a:2},{a:3}];\nreturn rows.map(r=>r.b.toFixed(1));";
    const msg = "Cannot read properties of undefined (reading 'toFixed') (line 2)";
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    await w.dispatch(agentStart("jsfail", "crunch"));
    await w.dispatch(agentStep("jsfail", 1, {
        seq: 1, tool: "exec", arguments: { js }, result: `Error: ${msg}`,
        renderIn: { type: "code", text: js, lang: "javascript", format: true },
        renderOut: { type: "exec-out", error: msg, errorLine: 2 },
    }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep-head").click(); await w.tick();

    const link = w.shadow.querySelector(".r-py-err .tb-line");
    assert.ok(link, "the failure's line is a control, not just text");
    const drawn = [...w.shadow.querySelectorAll(".cline")]
        .find((el) => el.textContent.includes("toFixed"))?.getAttribute("data-line");
    assert.notEqual(drawn, "2", "the beautifier moved it — otherwise this test proves nothing");
    // The whole `(line N)` is the control, for the same reason the python frame is.
    assert.equal(link.textContent, `(line ${drawn})`, "the rendered error names the row the reader is looking at");
    assert.match(link.parentElement.querySelector(".tt-pop").textContent, /model wrote it as line 2/);

    // …and the model-facing text is unchanged, recoverable in raw.
    const rawBtn = [...w.shadow.querySelectorAll(".rr-toggle button")].filter((b) => b.textContent === "raw");
    rawBtn[rawBtn.length - 1].click(); await w.tick();
    assert.match(w.shadow.querySelector(".astep [data-cite='out']").textContent, /\(line 2\)/,
        "the model was told its OWN line, and that is what raw shows");
});

// TWO FAILING STEPS OPEN AT ONCE. A document-wide lookup finds the FIRST In block on the page, so both
// tracebacks jumped into the first step's code — confidently, and at a line number that meant nothing there.
test("python: each traceback jumps into ITS OWN step's code, not the first one on the page", async () => {
    const codeA = ["a1 = 1", "a2 = 2", "raise ValueError('A')"].join("\n");
    const codeB = ["b1 = 1", "b2 = 2", "b3 = 3", "b4 = 4", "raise ValueError('B')"].join("\n");
    const tb = (line) => [
        "Traceback (most recent call last):",
        '  File "<exec>", line 170, in <module>',
        `  File "<python_exec>", line ${line}, in _user`,
        "ValueError: x",
    ].join("\n");

    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    await w.dispatch(agentStart("two", "two failures"));
    for (const [i, code, line] of [[1, codeA, 3], [2, codeB, 5]]) {
        await w.dispatch(agentStep("two", i, {
            seq: i, tool: "python_exec", arguments: { code }, result: "Python error",
            renderIn: { type: "python-in", mode: "script", code },
            renderOut: { type: "python-out", error: tb(line) },
        }));
    }
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const head of w.shadow.querySelectorAll(".astep-head")) { head.click(); await w.tick(); }

    const steps = [...w.shadow.querySelectorAll(".astep")];
    assert.equal(steps.length, 2, "both steps are open");
    // Each step marks its OWN failing line: step 1 at line 3, step 2 at line 5.
    const marked = steps.map((st) => st.querySelector(".cline.cline-fail")?.textContent || "");
    assert.match(marked[0], /raise ValueError\('A'\)/, "step 1 marks its own line 3");
    assert.match(marked[1], /raise ValueError\('B'\)/, "step 2 marks its own line 5 — not step 1's");

    // And clicking the SECOND traceback's link lands in the SECOND step's code. The bug was that it found
    // the first `[data-cite='in']` in the whole document and pulsed a line there.
    const link = steps[1].querySelector(".tb-line");
    assert.ok(link, "the second step's traceback has a link");
    link.click();
    // NO tick: the pulse is a class added imperatively, and a Preact re-render rewrites an element's class
    // list from its own vdom — the same hazard `scrollToStepSeq` documents. Asserting after a flush would be
    // testing whether the class survived a render, not whether the jump landed in the right place.
    assert.equal(steps[0].querySelector(".cline-pulse, .cline-pulse-fail"), null,
        "the FIRST step's code was not touched");
    assert.ok(steps[1].querySelector(".cline-pulse, .cline-pulse-fail"),
        "…the second step's was");
    // The deepest frame is the failure, so it flashes RED — green would be the one colour that line is not.
    assert.ok(steps[1].querySelector(".cline-pulse-fail"), "the failing line flashes red, not green");
});

// --- the python bench: running a script and rendering what came back -------------------------------------

test("python bench: opens from the header, runs a script, and renders the sandbox result", async () => {
    const w = await loadSidebarWorld({ pythonExec: (p) => ({ ok: true, value: p.hardened ? 1 : 2, stdout: "hi\n" }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    assert.ok(ta, "the code editor renders");
    ta.value = "print('hi')\nreturn 1";
    ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();
    // The PYTHON_EXEC payload carried the code; default mode readonly → hardened.
    const runs = w.pyCalls.filter((c) => !c.env);
    assert.equal(runs.length, 1, "ONE run — the env probe below is not a second execution of your script");
    assert.match(runs[0].code, /print\('hi'\)/);
    assert.equal(runs[0].hardened, true, "readonly mode → hardened");
    // …and the run's completion is when the version chip is filled in: the sandbox is warm NOW, so learning
    // what it is costs nothing, where doing it on mount would make every glance at the bench pay a cold start.
    assert.ok(w.pyCalls.some((c) => c.env), "the env probe rides the run's completion");
    // The result renders in the output PANE — the same section renderers the log uses, composed as TABS
    // rather than as stacked disclosures. In a log a step is a row in a scrolling transcript you read top to
    // bottom, so a folded stdout is a kindness; in the bench you are in a loop, and the output you ran the
    // script to see was arriving collapsed behind two clicks on every run.
    const out = w.shadow.querySelector(".bench-outbody");
    assert.ok(out, "result renders in the output pane");
    assert.deepEqual([...w.shadow.querySelectorAll(".bench-tab")].map((b) => b.textContent), ["stdout", "value"],
        "one tab per section the result actually has");
    // You LAND ON THE VALUE — stdout comes first, but what you ran the script for is the answer, not the
    // printing on the way to it. An auto-pick never sticks; only a tab you clicked does.
    assert.equal(w.shadow.querySelector(".bench-tab.on").textContent, "value");
    assert.match(out.textContent, /1/, "the returned value is what is on screen");
    assert.equal(out.querySelector(".r-py-sec"), null, "…and nothing is folded behind a disclosure here");
    // stdout is one click, not two: in the log it is a `details` you open, which in a loop you were paying
    // on every single run.
    [...w.shadow.querySelectorAll(".bench-tab")].find((b) => b.textContent === "stdout").click();
    await w.flush();
    assert.match(w.shadow.querySelector(".bench-outbody").textContent, /hi/, "stdout shown");
    // The info note is a tooltip now, not always-shown prose.
    assert.equal(w.shadow.querySelector(".bench-note"), null, "no always-shown note");
    assert.ok(w.shadow.querySelector(".bench-info .tt-pop"), "the note is a hover tooltip");
});

test("python bench: a returned DataFrame renders as a real table (PyDfTable), not a text repr", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "  foo  bar\n0  1  4", stdout: "", table: { columns: ["foo", "bar"], rows: [[1, 4], [2, 5]] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "return df"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".bench-outbody .r-df-scroll"), "the value section renders as a real table");
    // The DataFrame table (PyDfTable) shows the column headers.
    assert.match(w.shadow.querySelector(".bench-outbody").textContent, /foo/);
    assert.match(w.shadow.querySelector(".bench-outbody").textContent, /bar/);
    // …and WITHOUT the log's hide/show control: the tab strip already decides what is on screen, so a
    // second control for "do not show me this" only undoes the choice the first one just made.
    assert.equal(w.shadow.querySelector(".bench-outbody .r-df-bar"), null, "no collapse bar in the bench");
});

// A pandas column can legitimately hold a dict or a list — `dict(per_q)` in a cell is an ordinary thing to
// write — and `String()` renders those as "[object Object]": a wrong answer printed exactly where the reader
// is looking for the right one. It shipped for as long as it did because nothing asserted on a non-scalar
// cell's TEXT.
test("python bench: a DataFrame cell holding a dict renders as JSON, not [object Object]", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "", stdout: "",
        table: { columns: ["metric", "value"], rows: [
            ["Grand total", 6260],
            ["Per quarter", { Q1: 1500, Q2: 1600 }],
            ["Tags", ["a", "b"]],
            ["Missing", null],
        ] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "return out"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();
    const text = w.shadow.querySelector(".bench-outbody").textContent;
    assert.doesNotMatch(text, /\[object Object\]/, "a dict cell is not JS default coercion");
    assert.match(text, /"Q1":\s*1500/, "…it is the value, as JSON");
    assert.match(text, /\["a","b"\]|\[\s*"a"/, "and so is a list cell");
    assert.match(text, /NaN/, "a null cell still reads as NaN, the pandas spelling");
    assert.match(text, /6260/, "scalars are untouched");
});

// A value we genuinely cannot serialise is NOT an empty cell, and must not look like one. `[object Object]`
// was the old answer: a wrong fact printed exactly where the reader is looking for the right one.
test("python bench: a cell that cannot be serialised says so, and says what it was", async () => {
    const circular = { name: "loop" };
    circular.self = circular;
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "", stdout: "",
        table: { columns: ["metric", "value"], rows: [["fine", 1], ["broken", circular]] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "return out"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();
    const cell = w.shadow.querySelector(".bench-outbody .r-td-unrend");
    assert.ok(cell, "the unrenderable cell is marked, not left blank or coerced");
    assert.match(cell.textContent, /unrenderable/);
    // The TYPE is most of the answer to "why is my column empty".
    const tip = await hoverTip(w, cell);
    assert.match(tip, /could not be serialised/i);
    assert.match(tip, /the model received the value itself/i,
        "…and it says the failure is in the PREVIEW, not in the run");
    assert.doesNotMatch(w.shadow.querySelector(".bench-outbody").textContent, /\[object Object\]/);
});

// `{}` for something that is NOT an empty object is the same wrong fact in the same place, just quieter — and
// unlike a function, a Map/Set/Error survives a structured clone, so these genuinely arrive.
test("python bench: a Map, a Set or an Error is marked rather than printed as {}", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "", stdout: "",
        table: { columns: ["what", "value"], rows: [
            ["a real empty object", {}],
            ["a Map", new Map([["a", 1], ["b", 2]])],
            ["an Error", new Error("nope")],
        ] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "return out"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();

    const marks = [...w.shadow.querySelectorAll(".bench-outbody .r-td-unrend")];
    assert.equal(marks.length, 2, "the Map and the Error are marked; a genuinely empty object is not");
    assert.deepEqual(marks.map((m) => m.textContent), ["unrenderable Map", "unrenderable Error"],
        "…and each says what it WAS, which is most of the answer to 'why is my column empty'");
    // A plain `{}` is left alone: there, `{}` is the truth.
    assert.match(w.shadow.querySelector(".bench-outbody").textContent, /\{\}/);
});

// The SANDBOX-marked case, which the two above cannot produce: pandas flattens an arbitrary object to `{}`
// on its way out, so by the time it reaches the browser there is nothing left to detect. The type is
// recorded at the producer (python-runtime.ts) and read back here — the two halves of one mechanism, and
// this is the half that draws it.
test("python bench: a cell the SANDBOX marked names its Python type, and blames the preview", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "", stdout: "",
        table: { columns: ["name", "meta"], rows: [
            ["a", { q1: 1 }],
            ["b", { __ml_unrenderable__: "Widget" }],
        ] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "return out"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();

    const marks = [...w.shadow.querySelectorAll(".bench-outbody .r-td-unrend")];
    assert.equal(marks.length, 1, "only the marked cell; the dict beside it has a JSON form and keeps it");
    assert.equal(marks[0].textContent, "unrenderable Widget", "the PYTHON type, carried across");
    // The cause differs from the browser-side one and so does the explanation: naming the wrong cause sends
    // the reader looking in the wrong half of the system.
    const tip = await hoverTip(w, marks[0]);
    assert.match(tip, /would show as an empty object/i);
    assert.doesNotMatch(tip, /circular/i);
    assert.match(w.shadow.querySelector(".bench-outbody .r-df-table").textContent, /"q1"/,
        "the dict cell is untouched — the marker is only for what would otherwise be LOST");
});

test("python bench: full mode sends hardened:false", async () => {
    const w = await loadSidebarWorld();
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const sel = w.shadow.querySelector(".bench-mode select");
    sel.value = "full";
    sel.dispatchEvent(new w.window.Event("change"));
    const ta = w.shadow.querySelector(".bench-code textarea");   // jsdom: CodeEditor's textarea fallback
    ta.value = "return 1";
    ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-play").click();
    await w.tick();
    assert.equal(w.pyCalls[0].hardened, false, "full mode → not hardened");
});

// The environment panel opens OVER the editor, so "click off it" is the first thing anyone tries to dismiss
// it — and it did nothing: the only way out was finding the button again, behind the panel you were trying
// to close.
// (`composed: true` on the synthetic events: a real pointer event crosses the shadow boundary and a
// hand-built one does not, so without it the document-level listener never sees the click and the test
// would report the dismiss as broken when it works.)
test("python bench: the environment panel closes on an outside click, and on Escape", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: 1, stdout: "" }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    // `flush`, not `tick`: the dismiss is armed in an EFFECT, and Preact defers those — a click delivered
    // before the listener exists finds nothing to close it, which reads as the feature not working.
    const openIt = async () => { w.shadow.querySelector(".bench-env-btn").click(); await w.flush(); };

    await openIt();
    assert.ok(w.shadow.querySelector(".bench-env-body"), "the panel opens");

    // A click INSIDE it must not close it — you are reading and filtering.
    w.shadow.querySelector(".bench-env-body").dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".bench-env-body"), "…and stays open while you use it");

    // A click anywhere else closes it.
    w.shadow.querySelector(".bench-code").dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await w.flush();
    assert.equal(w.shadow.querySelector(".bench-env-body"), null, "clicking off it dismisses it");

    // Escape does too.
    await openIt();
    assert.ok(w.shadow.querySelector(".bench-env-body"), "reopened");
    w.window.document.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await w.flush();
    assert.equal(w.shadow.querySelector(".bench-env-body"), null, "Escape dismisses it");
});

test("python bench: the BUTTON still toggles — the outside-click handler must not fight it", async () => {
    // The trap: a capture-phase dismiss that also fires for the button would close the panel and let the
    // button's own click reopen it, so it would look like the dismiss never worked. Or, if ordered the other
    // way, the button would appear dead on the second press.
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: 1, stdout: "" }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const btn = () => w.shadow.querySelector(".bench-env-btn");
    btn().dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
    btn().click(); await w.tick();
    assert.ok(w.shadow.querySelector(".bench-env-body"), "first press opens");
    btn().dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
    btn().click(); await w.tick();
    assert.equal(w.shadow.querySelector(".bench-env-body"), null, "second press closes");
});

// --- python_exec on a step: its notebook In, its Out and its sources -------------------------------------

test("python-in: an external-sheet source renders a smart chip with the real title (not the raw id)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pysh", "sum the sheet"));
    await w.dispatch(agentStep("pysh", 1, { tool: "python_exec", arguments: { code: "return df.sum()" }, result: "ok",
        renderIn: { type: "python-in", mode: "script", code: "return df.sum()",
            tables: [{ name: "df", source: { kind: "sheet-external", label: "SHEETID44CHARS", name: "Quarterly Sales" }, columns: ["A"], rows: [[1]] }] } }));
    await w.dispatch(agentResult("pysh", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const chip = w.shadow.querySelector(".r-py-in .sheet-chip");
    assert.ok(chip, "the sheet source is a smart chip");
    assert.match(chip.querySelector(".sheet-chip-name").textContent, /Quarterly Sales/, "shows the real title, not the id");
    assert.match(chip.getAttribute("href"), /spreadsheets\/d\/SHEETID44CHARS/, "links to the sheet by id");
});

test("python_exec render: In is a notebook cell (mode + input image + source); Out is stdout + token", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pyc", "click the star"));
    await w.dispatch(agentStep("pyc", 1, {
        tool: "python_exec", arguments: { code: "return [10, 20]", cast: "pt" },
        result: "stdout:\nfound\n\n→ @pt:abcd1234 at (10, 20).",
        renderIn: { type: "python-in", mode: "pt", code: "return [10, 20]", image: "data:image/png;base64,INIMG" },
        renderOut: { type: "python-out", stdout: "found\n", token: "@pt:abcd1234" },
    }));
    await w.dispatch(agentResult("pyc", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();

    // In slot = the python-in cell header.
    const inCell = toolStep.querySelector(".r-py-in");
    assert.ok(inCell, "In renders the python-in cell");
    assert.match(inCell.querySelector(".r-py-mode").textContent, /cast: pt/, "mode line reflects the cast");
    assert.equal(inCell.querySelector(".r-py-img img").getAttribute("src"), "data:image/png;base64,INIMG", "input image shown");
    assert.match(inCell.querySelector(".code").textContent, /return \[10, 20\]/, "source highlighted");

    // Out slot = the python-out block: stdout + the minted token.
    const outCell = toolStep.querySelector(".r-py-out");
    assert.ok(outCell, "Out renders the python-out block");
    assert.match(outCell.querySelector(".r-py-stdout").textContent, /found/, "stdout shown byte-exact");
    assert.match(outCell.querySelector(".r-py-token").textContent, /@pt:abcd1234/, "minted token shown");

    // The Out raw toggle falls back to the exact result string the model received.
    const outBlock = [...toolStep.querySelectorAll("details.io")].find(b => b.querySelector(".r-py-out"));
    [...outBlock.querySelectorAll(".rr-toggle button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.match(outBlock.textContent, /→ @pt:abcd1234 at \(10, 20\)/, "Out raw = the model-facing result");
});

test("python_exec render: a Python error surfaces the traceback in the Out block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pye", "compute"));
    await w.dispatch(agentStep("pye", 1, {
        tool: "python_exec", arguments: { code: "return 1/0" },
        result: "Python error: ZeroDivisionError: division by zero",
        renderIn: { type: "python-in", mode: "script", code: "return 1/0" },
        renderOut: { type: "python-out", error: "Traceback (most recent call last):\nZeroDivisionError: division by zero" },
    }));
    await w.dispatch(agentResult("pye", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();

    assert.match(toolStep.querySelector(".r-py-mode").textContent, /script/, "no cast → script mode");
    assert.equal(toolStep.querySelector(".r-py-in .r-py-img"), null, "no input image row for an image-less run");
    assert.match(toolStep.querySelector(".r-py-err").textContent, /ZeroDivisionError/, "traceback shown");
});

// --- a table on screen: the summary, the grid and finding a cell in it -----------------------------------

test("table view: a table past the grid's rows opens as a SUMMARY of its preview, saying so, and flips to the rows", async () => {
    const w = await loadSidebarWorld();
    await openTableStep(w, "tv1", bigTable());
    assert.match(w.shadow.querySelector(".r-df-basis").textContent, /Summary of the first 200 of 300 rows only: the whole table is not stored\./);
    const sumRows = [...w.shadow.querySelectorAll(".r-df-sum tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent));
    assert.deepEqual(sumRows.map((r) => r.slice(0, 5)), [["id", "int64", "200", "0", "200"], ["region", "str", "200", "0", "2"]]);
    assert.match(sumRows[1][5], /north 100 · south 100/);
    assert.ok(btn(w, /^copy 200 rows$/), "no store: the copy control still names the prefix");
    btn(w, /^rows$/).click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".r-df-sum"), null);
    assert.equal(w.shadow.querySelectorAll(".r-df-table tbody tr").length, 200);
});

test("table view: with the whole table in the value store, the summary covers every row and the copy control copies all of it", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const { ValueStore } = await import("../src/value-store.ts");
    const idb = new IDBFactory();
    const csv = ["id,region", ...Array.from({ length: 300 }, (_, i) => `${i},${i < 250 ? "north" : "west"}`)].join("\n");
    const { key } = await new ValueStore({ idb, budgetBytes: () => 1e9 }).put(new Blob([csv]), { format: "csv" });
    const w = await loadSidebarWorld({ indexedDB: idb });
    await openTableStep(w, "tv2", bigTable(key));
    for (let i = 0; i < 40 && !/all 300 rows/.test(w.shadow.querySelector(".r-df-basis")?.textContent ?? ""); i++) await w.tick();
    assert.match(w.shadow.querySelector(".r-df-basis").textContent, /^Summary of all 300 rows\.$/);
    const region = [...w.shadow.querySelectorAll(".r-df-sum tbody tr")][1];
    assert.match(region.textContent, /north 250 · west 50/, "the values past the preview are in it");
    assert.ok(btn(w, /^copy all 300 rows$/));

    // A key the store no longer holds: the summary falls back to the preview and says why.
    const w2 = await loadSidebarWorld({ indexedDB: idb });
    await openTableStep(w2, "tv3", bigTable("v00000000000000ff"));
    for (let i = 0; i < 40 && !/could not be read/.test(w2.shadow.querySelector(".r-df-basis")?.textContent ?? ""); i++) await w2.tick();
    assert.match(w2.shadow.querySelector(".r-df-basis").textContent, /first 200 of 300 rows only\. The whole table could not be read: the stored value v00000000000000ff is not in the store/);
    assert.ok(btn(w2, /^copy 200 rows$/), "and the copy control goes back to naming the prefix");
});

test("table view: Ctrl+F in a focused table finds cells in the grid on screen (not its index gutter), in either mode", async () => {
    const w = await loadSidebarWorld();
    await openTableStep(w, "tv4", { ...bigTable(), rowCount: 20, rows: bigTable().rows.slice(0, 20).map(([i, r]) => [i + 1000, i === 7 ? "needle" : r]) });
    const df = w.shadow.querySelector(".r-df");
    assert.equal(df.querySelector(".r-df-sum"), null, "20 rows: the rows view");
    const search = async (text) => {
        const q = df.querySelector(".r-find-q");
        q.value = text; q.dispatchEvent(new w.window.Event("input", { bubbles: true }));
        await w.flush();
        return df.querySelector(".r-find-n").textContent;
    };
    df.querySelector(".r-df-body").dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await w.tick();
    assert.ok(df.querySelector(".r-find-q"), "the find bar opens on the table");
    assert.equal(await search("needle"), "1 of 1");
    assert.equal(await search("7"), "1 of 2", "the ids 1007 and 1017, not the gutter's 7 and 17 as well: the index is not data");
    // Summary mode searches what it shows: column names and their values.
    btn(w, /^summary$/).click();
    await w.tick();
    assert.ok(df.querySelector(".r-df-sum"));
    assert.match(await search("region"), /^1 of 1$/);
});

// --- the raw In cell, the embedded render, and the panel's own tooltip -----------------------------------

// THE TOOLTIP HAS TWO RENDER MODES, picked by the TYPE of what it is given — one function, no way to
// choose the wrong one. A STRING is markdown TEXT, because that is where content from outside arrives (a
// JSON Schema's description, a tool result, a model's prose) and treating it as markup would be an
// injection. Anything else is authored JSX.
//
// Asserted against the MODULE rather than through a world: the sidebar runs its own copy of preact in a vm
// sandbox, so a vnode built here would not be one the world could render — and what is worth pinning is
// which slot a value lands in, not preact's ability to draw it.
test("a tooltip treats a string as markdown text and anything else as an authored node", async () => {
    const { cursorTipOn, cursorTip } = await import("../src/sidebar/ui-kit.tsx");
    const set = (content) => {
        cursorTip.value = null;
        cursorTipOn(content).onPointerMove({ clientX: 1, clientY: 2 });
        return cursorTip.value;
    };
    const str = set("reads `df['total']` and *sorts* by it");
    assert.equal(str.text, "reads `df['total']` and *sorts* by it", "kept as TEXT, to be rendered as markdown");
    assert.equal(str.node, undefined, "…and not as a node, which would render it as markup");

    // Anything that is not a string is ours, and goes down the node path untouched.
    const vnode = { type: "span", props: { children: "authored" } };
    const rich = set(vnode);
    assert.equal(rich.node, vnode);
    assert.equal(rich.text, undefined);

    // Leaving resets it, so a tip cannot outlive the thing it was about.
    cursorTipOn("x").onPointerLeave();
    assert.equal(cursorTip.value, null);
});

// …and the renderer a string goes through ESCAPES. This is the whole reason a string is markdown rather
// than markup: schema descriptions and tool results are not ours to trust.
test("the tooltip's markdown renderer renders formatting and escapes markup", async () => {
    const { mdInline } = await import("../src/sidebar/format.ts");
    const html = mdInline("reads `df['total']` and *sorts* by it");
    // The apostrophes are entity-escaped inside the code span, which is the renderer doing its job.
    assert.match(html, /<code>df\[&#39;total&#39;\]<\/code>/);
    assert.match(html, /<em>sorts<\/em>/);
    assert.doesNotMatch(html, /^<p>/, "inline: no paragraph wrapper to break a one-line tip");

    const hostile = mdInline("<img src=x onerror=alert(1)> and <b>bold?</b>");
    assert.doesNotMatch(hostile, /<img/, "no element is created from the text");
    assert.doesNotMatch(hostile, /<b>/);
    assert.match(hostile, /&lt;img src=x/, "…it is shown as the text it is");
});

// WHAT INLINE MARKDOWN WILL NOT DO. These surfaces — a margin note, a tooltip, the model's claim — carry
// text we did not author, in places with no room. So: no images (unbounded pixels in a gutter, and a tool
// result could put them there), and no links to the outside web from a model's prose (a one-click egress in
// chrome the reader trusts, whose text and destination markdown lets disagree). Pinned, because both are
// currently true by ACCIDENT of how the inline renderer works and would be easy to lose.
test("inline markdown renders no images and no model-authored external links", async () => {
    const { mdInline } = await import("../src/sidebar/format.ts");
    for (const src of ["![shot](data:image/png;base64,AAAA)", "![shot](https://example.com/x.png)"]) {
        const html = mdInline(src);
        assert.doesNotMatch(html, /<img/, `no image from ${src}`);
        assert.doesNotMatch(html, /src=/, "…and nothing that could become one");
    }
    // A pointer link stays TEXT here: making it a link needs the run to navigate to (the step's seq), which
    // this renderer has none of — and a link that goes nowhere is worse than plain text. The answer
    // renderer, which HAS that context, is where pointer links live.
    assert.doesNotMatch(mdInline("see [the totals](@tool:abc1234)"), /<a /);
});

// The panel had three of these written three different ways, all a pill button that injected a box into the
// layout on click — which reads as content appearing rather than a section opening, gives no hint it can be
// closed, and jumps whatever is below it. One component, so the next one is free and they cannot disagree
// about what a chevron means.

test("disclosure: opens, closes, and keeps its content mounted so reopening is instant", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("disc1", "a task", "m", 20, {
        system: "SYSTEM PROMPT TEXT", tools: [{ name: "exec", description: "run js", parameters: { type: "object", properties: {} } }],
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    // The agent-options block is itself collapsed; open it to reach the sections inside.
    w.shadow.querySelector(".agent-opts .block-head").click();
    await w.tick();

    const heads = [...w.shadow.querySelectorAll(".disc-head")];
    assert.ok(heads.length >= 2, "the agent options block uses it for the system prompt and the tool defs");
    const sys = heads.find(h => /system prompt/.test(h.textContent));
    assert.ok(sys, "the system prompt is a disclosure, not a bare button");
    const disc = sys.closest(".disc");

    // CLOSED is the resting state, and it SAYS so — a reader using the keyboard gets the same answer.
    assert.equal(sys.getAttribute("aria-expanded"), "false");
    assert.ok(!disc.classList.contains("open"));
    // The body is in the DOM while closed: there has to be something for the grid to slide, and content that
    // only exists once open can only appear.
    assert.ok(disc.querySelector(".disc-body"), "the body is mounted, collapsed by the grid");
    assert.match(disc.querySelector(".disc-body").textContent, /SYSTEM PROMPT TEXT/,
        "…including its content, so reopening is instant and a landed fetch stays landed");
    assert.equal(disc.querySelector(".disc-body").getAttribute("aria-hidden"), "true",
        "and it is hidden from assistive tech while collapsed, since it is visually not there");

    sys.click();
    await w.tick();
    assert.equal(sys.getAttribute("aria-expanded"), "true");
    assert.ok(disc.classList.contains("open"), "opening is a CLASS, so the slide is CSS and nothing measures");
    assert.equal(disc.querySelector(".disc-body").getAttribute("aria-hidden"), "false");

    // And it closes again — the thing a button that injects a box could never do.
    sys.click();
    await w.tick();
    assert.equal(sys.getAttribute("aria-expanded"), "false");
    assert.ok(!disc.classList.contains("open"));
});

test("disclosure: a count rides the header, and the chevron is the only decoration", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("disc2", "a task", "m", 20, {
        system: "sys", tools: [
            { name: "exec", description: "", parameters: { type: "object", properties: {} } },
            { name: "look", description: "", parameters: { type: "object", properties: {} } },
        ],
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".agent-opts .block-head").click();
    await w.tick();
    const tools = [...w.shadow.querySelectorAll(".disc-head")].find(h => /tool definitions/.test(h.textContent));
    assert.ok(tools);
    // The count is a NOTE on the header rather than part of the label: "(24)" welded into the sentence made
    // the label change every time the number did, which is not what a section is called.
    assert.equal(tools.querySelector(".disc-note").textContent, "2");
    assert.ok(tools.querySelector(".tri"), "a chevron, which the CSS turns");
});

// A step's RAW In is where you go to search for a token — a selector buried in a wide args object, the one
// key that differs between two calls — and it is the view with no structure of its own to cap it. So it
// gets the same cell an Out does: capped, scrollable, and findable with Ctrl+F.
test("the raw In is a findable cell, and the JSON tree inside it is what gets searched", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rawfind", "look at args"));
    await w.dispatch(agentStep("rawfind", 1, {
        seq: 1, tool: "click", arguments: { selector: "#checkout-submit-button", index: 0, verify: true },
        result: "clicked",
    }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep-head").click(); await w.tick();

    const inBlock = [...w.shadow.querySelectorAll(".io")]
        .find((io) => io.querySelector(".io-label")?.textContent.startsWith("In"));
    const cell = inBlock.querySelector(".r-outcell");
    assert.ok(cell, "the raw In renders through the shared cell");
    // The JSON TREE is inside it — that composition is the point of the change, since the tree is what you
    // are searching. It is expanded by default (`allOpen`), so a find is not looking at collapsed nodes.
    assert.ok(cell.querySelector(".jt-args"), "…with the JSON tree inside, not instead of it");
    assert.match(cell.textContent, /checkout-submit-button/);

    // Ctrl+F inside the cell opens its find bar, and the tree's text is searchable.
    cell.querySelector(".r-outscroll").dispatchEvent(
        new w.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await w.tick();
    const q = cell.querySelector(".r-find-q");
    assert.ok(q, "the find bar opens on the raw In, the same as on an Out");
    q.value = "checkout"; q.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.flush();
    assert.match(cell.querySelector(".r-find-n")?.textContent ?? "", /1 of 1/,
        "it finds the selector in the tree — one match, not 'No results'");
});

// THE COMPOSITION QUESTION the cell raises: a JSON tree that could collapse would hide text from the find,
// and a search reporting "No results" over data that is right there reads as the find being broken. It
// cannot happen, and this is why: the raw In passes `allOpen`, which makes every node non-collapsible at
// EVERY depth (`collapsible = !allOpen`), so there is nothing to hide. Pinned, because the day someone
// makes this tree collapsible for good reasons, the find silently starts lying.
test("the raw In's JSON tree cannot collapse at any depth, so nothing hides from the find", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("deep", "nested args"));
    await w.dispatch(agentStep("deep", 1, {
        seq: 1, tool: "python_exec", result: "ok",
        arguments: { tables: { sales: { source: "#grid", opts: { header: { row: 2, tag: "buried-marker" } } } } },
    }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep-head").click(); await w.tick();

    const cell = [...w.shadow.querySelectorAll(".io")]
        .find((io) => io.querySelector(".io-label")?.textContent.startsWith("In"))
        .querySelector(".r-outcell");
    // Four levels deep, and every level is drawn — no chevron, no click target, nothing to fold away.
    assert.match(cell.textContent, /buried-marker/, "the deepest value is rendered, not behind a fold");
    assert.equal(cell.querySelectorAll(".jt-branch .tri").length, 0, "no node offers to collapse");
    assert.equal(cell.querySelectorAll(".jt-clickable").length, 0, "…and none is clickable");
    assert.equal(cell.querySelectorAll(".jt-preview").length, 0,
        "no node is showing a COLLAPSED preview instead of its contents");

    // So a find reaches it. This is the assertion that would fail the day the tree becomes collapsible.
    cell.querySelector(".r-outscroll").dispatchEvent(
        new w.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await w.tick();
    const q = cell.querySelector(".r-find-q");
    q.value = "buried-marker"; q.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.flush();
    assert.match(cell.querySelector(".r-find-n").textContent, /1 of 1/, "the four-deep value is findable");
});

// An EMBED wraps a whole rendered output, and a DataFrame render brings its own controls — copy CSV, hide
// table, a sortable column header. Clicking one bubbled to the embed's jump and yanked the reader up to the
// source step, which is the opposite of the request: they were operating the table in front of them.
test("embed: a click on the render's OWN controls does not jump to the source step", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("em", "totals"));
    await w.dispatch(agentStep("em", 1, { seq: 1, tool: "python_exec", token: "aa11bb2", result: "table",
        renderOut: { type: "python-out", df: { columns: ["rep", "total"], rows: [["Gia", 850], ["Kim", 810]] } } }));
    await w.dispatch(agentResult("em", "Ranked:\n\n![rep totals](@tool:aa11bb2:out)", 1));
    await openRun(w);
    const embed = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(embed, "the embed renders");
    assert.ok(embed.querySelector("table"), "…as the DataFrame render, with its own controls");

    let jumps = 0;
    for (const el of w.shadow.querySelectorAll("*")) el.scrollIntoView = () => { jumps++; };

    const copy = [...embed.querySelectorAll("button")].find((b) => /copy csv/i.test(b.getAttribute("aria-label") || ""));
    assert.ok(copy, "the DataFrame render offers copy CSV");
    copy.dispatchEvent(new w.window.MouseEvent("click", { bubbles: true }));
    await w.tick();
    assert.equal(jumps, 0, "copy CSV operated the table and did NOT scroll to the source");

    const th = embed.querySelector("th:not(.r-df-idx)");
    assert.ok(th, "…and the columns are sortable headers");
    th.dispatchEvent(new w.window.MouseEvent("click", { bubbles: true }));
    await w.tick();
    assert.equal(jumps, 0, "a sort header is a control too — a <th> with a handler, not a <button>");

    // …and the INERT parts still jump, or the guard would have removed the feature rather than scoped it.
    const cell = embed.querySelector("tbody td");
    assert.ok(cell, "a body cell is inert");
    cell.dispatchEvent(new w.window.MouseEvent("click", { bubbles: true }));
    // A citation to a COLLAPSED step now scrolls once the step has settled rather than at the moment of the
    // click — it opens it, and where the step was before it opened is not where the reader wants to be
    // (step-scroll.ts). So this waits for those frames, which is what a person watching it also does — POLLED, not
    // a fixed wait: jsdom's frames are timers, and a loaded machine let a 120ms wait expire before they ran.
    for (let t = 0; jumps === 0 && t < 50; t++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(jumps > 0, "clicking the render itself still goes to the step that produced it");
});

// A CITATION IS A DIFFERENT PLACE TO SHOW CODE, NOT A DIFFERENT KIND OF THING. An embedded
// `![the code](@tool:…:in)` rendered a bare `Code`, so the same block was explainable at its step and inert
// three lines further down in the answer, purely because of where it was cited. Both go through CodeRender
// now, which is also what keeps the surface split in ONE place (CodeTools) rather than two.
test("embed: a cited code block carries the same affordances the step's own block has", async () => {
    const w = await loadSidebarWorld({ config: { utilityModel: "small:1b" } });
    await w.dispatch(agentStart("ce", "compute"));
    await w.dispatch(agentStep("ce", 1, { seq: 1, tool: "python_exec", token: "cc11dd2", result: "42",
        arguments: { code: "q = [1, 2]\nreturn sum(q)" },
        renderIn: { type: "python-in", mode: "script", code: "q = [1, 2]\nreturn sum(q)" } }));
    await w.dispatch(agentResult("ce", "Here it is:\n\n![the code](@tool:cc11dd2:in)", 1));
    await openRun(w);
    const embed = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(embed, "the embed renders");
    assert.ok(embed.querySelector(".code-block"), "…as a real code block, not a bare pre");
    const tools = embed.querySelector(".code-tools");
    assert.ok(tools, "…with its toolbar");
    const labels = [...tools.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || b.textContent || "").toLowerCase());
    assert.ok(labels.some((l) => /explain/.test(l)), "explain is offered on the panel");
    assert.ok(labels.some((l) => /bench/.test(l)), "…and so is the bench, which the panel can navigate to");
});

test("embed: on the HUD card the cited block keeps explain and drops the bench", async () => {
    // The card is a reading surface with no navigation of its own: sending someone to the bench from a
    // corner card either does nothing or replaces what they were reading. Understanding the code is exactly
    // what the card IS for, so explain stays. Asserted here because the embed reaches CodeTools by a
    // different route from a step's own block and could have bypassed the split entirely.
    const w = await loadSidebarWorld({ sync: { debugMode: "off" }, config: { utilityModel: "small:1b" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("ch", "compute", "m"));
    await w.dispatch(agentStep("ch", 1, { seq: 1, tool: "python_exec", token: "cc11dd3", result: "42",
        arguments: { code: "return 42" },
        renderIn: { type: "python-in", mode: "script", code: "return 42" } }));
    await w.dispatch(agentResult("ch", "Here:\n\n![the code](@tool:cc11dd3:in)", 1));
    await w.flush();

    // LOUD, not a shrug: a guard that returns early when the embed is missing is how this passes on the day
    // the card stops rendering citations at all.
    const embed = w.window.document.querySelector(".card-body .tok-ref");
    assert.ok(embed, "the card renders the cited block");
    const tools = embed.querySelector(".code-tools");
    assert.ok(tools, "…with a toolbar");
    const labels = [...tools.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || b.textContent || "").toLowerCase());
    assert.ok(labels.some((l) => /explain/.test(l)), "explain stays on the card");
    assert.ok(!labels.some((l) => /bench/.test(l)), "the bench does NOT — the card cannot navigate there");
});

// THE GAUGE AND THE FIGURES BESIDE IT MUST AGREE ABOUT WHAT USAGE THE SESSION HAS. They read it from two
// near-copies: the in/out figures took both `steps` and `turns`, the gauge took ONE of them chosen by
// `s.kind`. So a session whose usage landed on the other collection showed its spend with no gauge at all —
// which reads as the gauge having broken, a foot away from a number that is plainly updating.
test("usage: the gauge reads the same samples as the in/out figures, whichever collection they landed on", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 1000, expiresAt: null }] });
    await w.dispatch(agentStart("mix", "compute", "gemma4:31b"));
    // Usage on a TURN of a session whose kind is "agent" — the mismatch the gauge used to fall through.
    await w.dispatch({ kind: "agent-say", id: "mix", ts: Date.now(), save: false,
        session: { hash: "mix", turn: 0 }, text: "go" });
    await w.dispatch(agentStep("mix", 1, { seq: 1, thought: "thinking",
        usage: { promptTokens: 300, completionTokens: 20, totalTokens: 320, genMs: 100 } }));
    await w.dispatch(agentResult("mix", "done", 1));
    await w.raw({ __mlSidebarOpen: true });   // shell open → the ps poll can supply the denominator
    await openRun(w);
    await w.tick(); await w.flush();
    assert.ok(w.shadow.querySelector(".run-stats"), "the in/out figures render");
    assert.ok(w.shadow.querySelector(".usage-gauge"), "…and so does the gauge, from the same samples");
});

test("usage: occupancy is the LATEST sample by time, not whichever collection is concatenated last", async () => {
    // Ordering matters because occupancy means "how full is the window NOW". Concatenating steps-then-turns
    // would make a turn the last sample even when a step is newer, and report a stale occupancy.
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 1000, expiresAt: null }] });
    const t0 = Date.now();
    await w.dispatch(agentStart("ord", "compute", "gemma4:31b"));
    await w.dispatch(agentStep("ord", 1, { seq: 1, ts: t0 + 1000, thought: "later",
        usage: { promptTokens: 700, completionTokens: 0, totalTokens: 700, genMs: 10 } }));
    await w.dispatch(agentStep("ord", 2, { seq: 2, ts: t0 + 2000, thought: "latest",
        usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200, genMs: 10 } }));
    await w.dispatch(agentResult("ord", "done", 2));
    await w.raw({ __mlSidebarOpen: true });
    await openRun(w);
    await w.tick(); await w.flush();
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /20%/,
        "the newest sample (200/1000), not the largest and not the first");
});

// THE THINKING COUNT: exact when the turn COUNTED it (the engine's running total while the call was thinking, or a
// server's real reasoning_tokens), a `~` estimate from the text only when it did not.
test("a thinking block shows the counted token figure without `~`, and the estimate with it", async () => {
    const w = await loadSidebarWorld();
    const start = (hash) => ({ kind: "agent", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, task: "t", config: { maxSteps: 5, system: "s", tools: [] } });
    const thought = "x".repeat(1400);   // chars/4 → ~350
    await w.dispatch(start("rt1"));
    await w.dispatch({ kind: "agent-step", id: "rt1", ts: Date.now(), save: false, session: { hash: "rt1", turn: 1 }, step: 1, localStep: 1, reasoning: thought, usage: { promptTokens: 10, completionTokens: 400, totalTokens: 410, reasoningTokens: 337 } });
    await w.dispatch({ kind: "agent-result", id: "rt1", ts: Date.now(), save: false, session: { hash: "rt1", turn: 1 }, summary: "done", steps: 1, hitCap: false });
    w.raw({ __mlSidebarOpen: true });
    await w.flush();
    [...w.shadow.querySelectorAll(".row")].find((r) => /rt1|t/.test(r.textContent))?.click();
    await w.flush();
    const counted = w.shadow.querySelector(".athinking .astep-tokest")?.textContent;
    assert.equal(counted, "337 tokens", "counted: no tilde, the engine's number");

    const w2 = await loadSidebarWorld();
    await w2.dispatch(start("rt2"));
    await w2.dispatch({ kind: "agent-step", id: "rt2", ts: Date.now(), save: false, session: { hash: "rt2", turn: 1 }, step: 1, localStep: 1, reasoning: thought, usage: { promptTokens: 10, completionTokens: 400, totalTokens: 410 } });
    await w2.dispatch({ kind: "agent-result", id: "rt2", ts: Date.now(), save: false, session: { hash: "rt2", turn: 1 }, summary: "done", steps: 1, hitCap: false });
    w2.raw({ __mlSidebarOpen: true });
    await w2.flush();
    [...w2.shadow.querySelectorAll(".row")].find((r) => /rt2|t/.test(r.textContent))?.click();
    await w2.flush();
    assert.equal(w2.shadow.querySelector(".athinking .astep-tokest")?.textContent, "~350 tokens", "not counted: marked as the estimate it is");
});
