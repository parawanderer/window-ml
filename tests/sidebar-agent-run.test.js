// sidebar-agent-run.test.js — one ml.agent run as the panel sees it, over its whole life: events that
// arrive out of order, a mid-run steer, the step cap and Retry, a page that navigates under it, and what
// the run says about itself while it is still going.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, agentSay, agentSaySeen, streamConfig, openRun } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// --- a run's events arriving out of order: replays, stragglers and seals ---------------------------------

test("agent run: a straggler pending step (late in-flight START after the result) can't re-show a finished run as running", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bg1", "do the thing"));
    await w.dispatch(agentStep("bg1", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "found: x" }));
    await w.dispatch(agentResult("bg1", "All done — found x.", 1));   // seals the turn → status ok

    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "finished run: no running footer");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /All done/, "the final answer shows");

    // A background-hosted run's in-flight tool fans a LATE pending START for the NEXT step AFTER the result —
    // the cross-page / cancel straggler. Its DONE never comes (the run already ended). It must NOT flip the
    // finished run back to "running" (the "task's done but the sidebar still says running" bug).
    await w.dispatch(agentStep("bg1", 2, { seq: 2, pending: true, tool: "look", arguments: {} }));
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "a straggler pending START does NOT re-open the finished run");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /All done/, "the final answer still shows");
});

// Cross-page re-adoption REPLAYS the run's start + steps while the live agent-result fans separately, with no
// ordering guarantee. onDebug must converge to the SAME finished state for every interleaving — otherwise a
// completed cross-domain run shows "running" with no answer (the exact bug). These pin the two nasty orders.
test("agent run: an ORPHAN step/result (no `agent` start) does NOT manufacture a phantom '(no prompt)' session", async () => {
    const w = await loadSidebarWorld();
    // A stray step for a hash we never saw a start for (a DevTools ring-buffer that evicted the start, or a
    // mis-tagged event). It must NOT create a headless "(no prompt)" session stuck "In flight" (the multi-run
    // ghost-session bug). The event is HELD, not dropped.
    await w.dispatch(agentStep("orphan", 1, { seq: 1, tool: "look", arguments: {}, result: "saw the page" }));
    await w.dispatch(agentResult("orphan", "some answer", 1));
    await w.tick();
    assert.ok(w.shadow.querySelector(".empty"), "no phantom session — the list is still empty");
    assert.equal(w.shadow.querySelectorAll(".row").length, 0);
    // …but if the START later arrives (the cross-page replay race), the queued events are applied in order.
    await w.dispatch(agentStart("orphan", "look at the page and answer"));
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".row").length, 1, "the start materialises the real session");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /some answer/, "the queued result was applied");
    assert.ok(!w.shadow.querySelector(".pending-note"), "and it reads DONE (the queued result sealed it)");
});

test("agent run: agent-result arriving BEFORE the (replayed) start is not dropped — the answer survives", async () => {
    const w = await loadSidebarWorld();
    // The result wins the race onto the fresh page (no `agent` start yet). It must create a stub, not vanish.
    await w.dispatch(agentResult("race1", "The code is XDOMAIN-2025.", 2));
    await w.dispatch(agentStart("race1", "go read the code"));                    // replayed start lands AFTER
    await w.dispatch(agentStep("race1", 1, { seq: 1, tool: "navigate", arguments: { url: "/x" }, result: "ok" }));
    await w.dispatch(agentStep("race1", 2, { seq: 2, tool: "findByText", arguments: { text: "X" }, result: "found" }));
    await w.tick();
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /XDOMAIN-2025/, "the answer survived the result-first race");
    assert.ok(!w.shadow.querySelector(".pending-note"), "and the run reads DONE, not running");
});

test("agent run: a REPLAYED start event does not wipe steps/answer already applied from live events", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("race2", "do it"));
    await w.dispatch(agentStep("race2", 1, { seq: 1, tool: "navigate", arguments: { url: "/x" }, result: "ok" }));
    await w.dispatch(agentResult("race2", "All finished.", 1));                   // completes
    // The re-adopt replay re-sends the SAME start event. It must NOT recreate the session (wiping the answer).
    await w.dispatch(agentStart("race2", "do it"));
    await w.tick();
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /All finished/, "the answer wasn't wiped by the replayed start");
    assert.ok(!w.shadow.querySelector(".pending-note"), "and the run stays DONE");
});

// A GENUINE resumed off-mode turn (no agent-say bridge) still unseals: its first NON-pending step re-opens
// "running". Guards the fix above from over-blocking (only a bare pending START is inert on a sealed run).
test("agent run: a real resumed turn (a non-pending step past the sealed turn) DOES re-show running", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bg2", "do it"));
    await w.dispatch(agentStep("bg2", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult("bg2", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "sealed after the result");
    // A follow-up turn resumes; off-mode has no agent-say, so its first real step is the signal it's working.
    await w.dispatch(agentStep("bg2", 2, { thought: "let me continue" }));
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "a resumed turn's real step re-opens running");
});

test("a straggler step arriving AFTER a cancel does not re-show 'running' (background-run seal)", async () => {
    // Design-A/DevTools bug: a background-hosted run keeps fanning the in-flight tool's late DONE after the
    // user cancels; it lands AFTER the page's cancelled result and used to flip the session back to
    // "running" (footer + composer stuck), with no further result to clear it. The terminal result SEALS
    // the turn so a straggler (step ≤ the sealed step) can't resurrect it.
    const w = await loadSidebarWorld();
    const H = "cxl";
    await w.dispatch(agentStart(H, "click the button", "m", 20));
    await w.dispatch(agentStep(H, 6, { seq: 5, pending: true, tool: "locate", arguments: { description: "a button" } }));  // START (in-flight)
    await w.dispatch({ kind: "agent-result", id: H, ts: Date.now() + 100, save: false, session: { hash: H, turn: 6 }, summary: "Cancelled by the caller.", steps: 0, cancelled: true });
    // The straggler: the in-flight locate's DONE, same seq/step, arriving after the cancel.
    await w.dispatch(agentStep(H, 6, { seq: 5, tool: "locate", arguments: { description: "a button" }, result: "(Grounding missed.) No candidates." }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "no live 'running' footer after cancel + straggler");
    assert.ok(w.shadow.querySelector(".msg.asst"), "the cancelled answer still renders");
    // A genuine NEW turn (a step PAST the sealed step) still unseals → 'running' returns.
    await w.dispatch(agentStep(H, 7, { seq: 6, thought: "New turn." }));
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "a new-turn step past the sealed step re-shows running");
});

// --- steering a live run, and what the steer indicator shows ---------------------------------------------

test("agent run: a mid-run steer shows QUEUED, then flips to SEEN when the agent drains it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("steer1", "do a thing"));
    await w.dispatch(agentStep("steer1", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentSay("steer1", "actually focus on the header", "sy_1"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let badge = w.shadow.querySelector(".steer-seen");
    assert.ok(badge, "the steer bubble carries a delivery indicator");
    assert.ok(badge.classList.contains("wait"), "it starts QUEUED (not yet picked up)");
    // The loop drains it at the next boundary → seen.
    await w.dispatch(agentSaySeen("steer1", "sy_1"));
    await w.tick();
    badge = w.shadow.querySelector(".steer-seen");
    assert.ok(badge.classList.contains("on"), "after the drain it flips to SEEN");
    // The initial task bubble is NOT a steer → no indicator on it.
    assert.equal(w.shadow.querySelectorAll(".steer-seen").length, 1, "only the steer carries the indicator, not the task");
});

test("agent run: an agent-say-seen that races AHEAD of its bubble still marks it seen (order-independent)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("steer2", "do a thing"));
    // The SEEN event wins the race onto the fresh page (cross-page replay reorder) — arriving before the bubble.
    await w.dispatch(agentSaySeen("steer2", "sy_9"));
    await w.dispatch(agentSay("steer2", "steer arriving late", "sy_9"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const badge = w.shadow.querySelector(".steer-seen");
    assert.ok(badge && badge.classList.contains("on"), "the bubble renders already SEEN (the earlier seen was remembered)");
});

// REGRESSION: `agent-say` is overloaded — it also carries a follow-up run()'s TASK (a continuation), which
// has NO sayId and is processed immediately, NOT letterboxed. That must NOT get the queued/seen badge (it was
// showing a permanent amber "queued" dot that never flipped — the DevTools-panel status bug). Reducer-level,
// so this guards BOTH surfaces (the panel is the same app, per the parity rule).
test("devtools/panel: a follow-up run() task (continuation agent-say, no sayId) shows NO steer indicator", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cont1", "first question"));
    await w.dispatch(agentStep("cont1", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult("cont1", "first answer", 1));
    // The follow-up: an agent-say WITHOUT a sayId (a new turn's task, not a mid-run steer).
    await w.dispatch({ kind: "agent-say", id: "cont1", ts: Date.now() + 5, save: false, session: { hash: "cont1", turn: 0 }, text: "and what else?" });
    await w.dispatch(agentResult("cont1", "second answer", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const userTexts = [...w.shadow.querySelectorAll(".msg.user .utext")].map(e => e.textContent);
    assert.ok(userTexts.includes("and what else?"), "the follow-up still renders as a you bubble");
    assert.equal(w.shadow.querySelectorAll(".steer-seen").length, 0, "no steer badge on the task or a continuation — only genuine mid-run steers get it");
});

// --- a run that stopped: the step cap, Continue, Retry and a fatal error ---------------------------------

test("step-cap stop (sidebar): the answer offers 'Continue (+N steps)' → posts continueRun for that run", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cap1", "big task", "m", 20));
    await w.dispatch(agentResult("cap1", "Stopped at the 20-step cap without finishing.", 20, true));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const btn = w.shadow.querySelector(".continue-run");
    assert.ok(btn, "the Continue button renders on a step-capped answer");
    assert.match(btn.textContent, /Continue/);
    assert.match(btn.textContent, /\+20 steps/, "shows the fresh step budget");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    btn.click();
    const msg = posted.find(m => m.__mlSidebarApp === "continueRun");
    assert.ok(msg, "clicking posts a continueRun message");
    assert.equal(msg.hash, "cap1");
    assert.equal(msg.maxSteps, undefined, "a plain press carries no budget: the run keeps the cap it had");
});

test("step-cap stop (sidebar): the chevron beside Continue offers the other budgets, and sends the one picked", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cap2", "big task", "m", 20));
    await w.dispatch(agentResult("cap2", "Stopped at the 20-step cap without finishing.", 20, true));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const more = w.shadow.querySelector(".continue-more");
    assert.ok(more, "a capped run offers the budget chooser");
    more.click();
    await w.tick();
    const items = [...w.shadow.querySelectorAll(".ctx-item")].map(b => b.textContent);
    // The run's OWN cap is not offered again — it is what the button beside this already does.
    assert.deepEqual(items, ["+10 steps", "+50 steps"]);
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    [...w.shadow.querySelectorAll(".ctx-item")].find(b => b.textContent === "+50 steps").click();
    const msg = posted.find(m => m.__mlSidebarApp === "continueRun");
    assert.ok(msg, "picking a budget posts a continueRun message");
    assert.equal(msg.hash, "cap2");
    assert.equal(msg.maxSteps, 50, "the budget that was picked rides along");
});

test("step-cap stop (sidebar): a normal (non-capped) or CANCELLED answer shows NO Continue button", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ok1", "task", "m", 20));
    await w.dispatch(agentResult("ok1", "All done.", 3, false));   // clean finish
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".continue-run"), null, "a completed run has nothing to continue");
    // A cancelled run is capped-styled but must NOT offer continue (the user stopped it deliberately).
    const w2 = await loadSidebarWorld();
    await w2.dispatch(agentStart("cx", "task", "m", 20));
    await w2.dispatch({ ...agentResult("cx", "Cancelled by the caller.", 2, false), cancelled: true });
    w2.shadow.querySelector(".row").click();
    await w2.tick();
    assert.equal(w2.shadow.querySelector(".continue-run"), null, "a cancelled run offers no Continue");
});

// A FAILED RUN OFFERED NO WAY FORWARD but to type something, and a failure is usually not about what was
// asked: the backend restarting underneath a run answered "Model not found" for a model that was serving a
// minute earlier and was listed again a minute later. Retry is the SAME resume a step-capped run's Continue
// sends — by hash, from the stored state, with no follow-up text — so it re-asks the turn that failed without
// adding a message to the transcript.
test("a failed run (sidebar) offers Retry, which resumes the same run", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rt1", "a task", "m", 20));
    await w.dispatch({ ...agentResult("rt1", "", 1, false), error: 'HTTP 400 from http://gpubox:3000/api/chat/completions: {"detail":"Model not found"}' });
    w.shadow.querySelector(".row").click();
    await w.tick();
    const btn = [...w.shadow.querySelectorAll(".continue-run")].find((b) => /Retry/.test(b.textContent));
    assert.ok(btn, "a failed run offers Retry rather than leaving only the composer");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    btn.click();
    const msg = posted.find((m) => m.__mlSidebarApp === "continueRun");
    assert.ok(msg, "…and it is the same resume Continue sends, so nothing new is appended");
    assert.equal(msg.hash, "rt1");
});

test("a finished or cancelled run offers no Retry", async () => {
    // Retry is for a run that FAILED. A clean finish has nothing to redo, and a cancel was deliberate — offering
    // to re-run what the user just stopped would be the button arguing with them.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rt2", "task", "m", 20));
    await w.dispatch(agentResult("rt2", "All done.", 3, false));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(![...w.shadow.querySelectorAll(".continue-run")].some((b) => /Retry/.test(b.textContent)), "no Retry on a success");
});

test("step-cap stop (HUD card): the corner card offers 'Continue (+N steps)' → posts continueRun (parity)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("capC", "big task", "m", 50));
    await w.dispatch(agentStep("capC", 1, { seq: 1, tool: "fetch_url", arguments: { url: "https://x.test" }, result: "…", approval: "user" }));
    await w.dispatch(agentResult("capC", "Stopped at the 50-step cap without finishing.", 50, true));
    await w.tick();
    const btn = w.shadow.querySelector(".continue-run");
    assert.ok(btn, "the Continue button renders on the HUD card too");
    assert.match(btn.textContent, /\+50 steps/);
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    btn.click();
    const msg = posted.find(m => m.__mlSidebarApp === "continueRun");
    assert.ok(msg && msg.hash === "capC", "the card posts continueRun for its run");
});

test("an agent that hits the step cap is flagged as stopped/error", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag3", "endless task"));
    await w.dispatch(agentResult("ag3", "Stopped at the 10-step cap without finishing.", 10, true));
    assert.ok(w.shadow.querySelector(".row .dot.err"), "capped run marked error");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.capped").textContent, /step cap/);
});

test("agent run: a fatal error marks the session failed and shows the message in the debug view", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("errS", "do the thing", "m"));
    await w.dispatch(agentStep("errS", 1, { tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch({ kind: "agent-result", id: "errS", ts: Date.now(), save: false, session: { hash: "errS", turn: 1 }, summary: "", steps: 1, hitCap: false, error: "connection refused" });

    const row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".dot.err"), "the session dot goes red");
    row.click(); await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.err .errtext").textContent, /connection refused/, "the run's error is shown");
});

test("agent step pill shows the PER-TURN step (localStep), not the cumulative one — maxSteps is a per-turn budget", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("mt", "turn one", "m", 20));
    await w.dispatch(agentStep("mt", 1, { localStep: 1, tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch(agentStep("mt", 2, { localStep: 2, tool: "exec", arguments: { js: "x" }, result: "ok" }));
    await w.dispatch(agentResult("mt", "done one", 2));
    // A follow-up run() continues the SESSION: its cumulative step is offset (3, 4…) so groups don't merge,
    // but the pill must reset to the per-turn count (1/20, 2/20) — the run got a fresh 20-step budget.
    await w.dispatch({ kind: "agent-say", id: "mt", ts: Date.now(), save: false, session: { hash: "mt", turn: 0 }, text: "turn two" });
    await w.dispatch(agentStep("mt", 3, { localStep: 1, tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch(agentStep("mt", 4, { localStep: 2, tool: "exec", arguments: { js: "y" }, result: "ok" }));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const pills = [...w.shadow.querySelectorAll(".step-pill")].map(p => p.textContent.replace(/\s+/g, " ").trim());
    // Two turns, each counting 1/20, 2/20 — NOT 3/20, 4/20 on the second turn.
    assert.deepEqual(pills, ["step 1/20", "step 2/20", "step 1/20", "step 2/20"],
        "the pill resets per turn (localStep), never showing the cumulative 3/20 · 4/20");
});

// --- a run while it is still going: the running footer, and what the trace withholds ---------------------

test("a running agent shows …running, then the answer arrives live", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag2", "do a thing"));
    assert.ok(w.shadow.querySelector(".row .dot.pending"), "row pending while running");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "…running while in flight");

    await w.dispatch(agentResult("ag2", "all done", 1));   // lands while detail is open
    assert.ok(!w.shadow.querySelector(".pending-note"), "…running cleared live");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /all done/);
});

test("running footer swaps to 'waiting for your approval' when blocked, and back the instant you decide", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agB", "do a thing"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let note = w.shadow.querySelector(".pending-note");
    assert.ok(note && !note.classList.contains("blocked"), "actively running: not blocked");
    assert.match(note.textContent, /running/);

    // A step lands awaiting the gate → the footer goes amber/blocked with the approval copy.
    await w.dispatch(agentStep("agB", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#go" } }));
    note = w.shadow.querySelector(".pending-note");
    assert.ok(note.classList.contains("blocked"), "blocked while awaiting approval");
    assert.match(note.textContent, /waiting for your approval/i);

    // Click Approve → the footer must drop 'blocked' immediately, WITHOUT waiting for the tool's DONE.
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.tick();
    note = w.shadow.querySelector(".pending-note");
    assert.ok(note && !note.classList.contains("blocked"), "no longer blocked the instant you approve (before DONE)");
});

test("the DEBUG DETAIL does NOT render answer media (that's HUD-only, the sidebar is a trace)", async () => {
    const w = await loadSidebarWorld();
    const hash = "ansmedia2";
    await w.dispatch(agentStart(hash, "find it", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "answer", arguments: { selector: "img.cat" }, result: "Answer: 1 element(s)" }));
    await w.dispatch({ ...agentResult(hash, "done", 1), answerMedia: [{ image: "data:image/png;base64,CATPIC", label: "x", selector: "img.cat" }] });
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".card-answer-media"), "no answer-media gallery in the debug detail");
    assert.doesNotMatch(w.shadow.querySelector(".msg.asst").innerHTML, /CATPIC/, "the crop isn't leaked into the debug detail");
});

// --- the page changing under a run: navigate and resume dividers -----------------------------------------

test("agent run: a successful navigate step renders a page-transition divider in the log", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nav1", "go to example and read it"));
    await w.dispatch(agentStep("nav1", 1, { seq: 1, tool: "navigate", arguments: { url: "https://example.com/page" }, result: "Navigating to https://example.com/page …" }));
    await w.dispatch(agentStep("nav1", 2, { seq: 2, tool: "findByText", arguments: { text: "hi" }, result: "found" }));
    await w.dispatch(agentResult("nav1", "Done.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const div = w.shadow.querySelector(".nav-divider");
    assert.ok(div, "a page-transition divider renders after the navigate step");
    assert.match(div.textContent, /navigated to/);
    assert.match(div.querySelector(".nav-url").textContent, /example\.com\/page/);
});

test("agent run: a session picked up on another page renders a RESUME divider, and says what it lost", async () => {
    const w = await loadSidebarWorld();
    const t0 = Date.now();
    await w.dispatch({ ...agentStart("res1", "read the headline"), ts: t0 });
    await w.dispatch({ ...agentStep("res1", 1, { seq: 1, tool: "findByText", arguments: { text: "hi" }, result: "found" }), ts: t0 + 1 });
    await w.dispatch({ ...agentResult("res1", "Done.", 1), ts: t0 + 2 });
    await w.dispatch({
        kind: "session-resumed", id: "res1-r1", ts: t0 + 172_800_000, save: false, session: { hash: "res1", turn: 0 },
        url: "https://new.example/page", fromUrl: "https://old.example/", afterMs: 172_800_000,
        dropped: ["the page's state object", "approval grants (consent is per page, and is asked again)"],
    });
    w.shadow.querySelector(".row").click();
    await w.tick();

    const div = w.shadow.querySelector(".resume-divider");
    assert.ok(div, "a resume divider renders");
    assert.match(div.textContent, /resumed on/);
    assert.match(div.querySelector(".nav-url").textContent, /new\.example\/page/);
    // The gap is the point: two days is "2d", not the arithmetic.
    assert.match(div.textContent, /after 2d/);
    // And it is told apart from a NAVIGATION, which is a different fact about a run.
    assert.doesNotMatch(div.textContent, /navigated to/);
});

test("agent run: two resumes are two dividers, and a repeat of one is not", async () => {
    const w = await loadSidebarWorld();
    const t0 = Date.now();
    await w.dispatch({ ...agentStart("res2", "t"), ts: t0 });
    await w.dispatch({ ...agentResult("res2", "Done.", 1), ts: t0 + 2 });
    const note = (id, url, ts) => ({ kind: "session-resumed", id, ts, save: false, session: { hash: "res2", turn: 0 }, url, afterMs: 60_000, dropped: ["approval grants"] });
    await w.dispatch(note("res2-r1", "https://a.example/", t0 + 60_000));
    await w.dispatch(note("res2-r2", "https://b.example/", t0 + 120_000));
    await w.dispatch(note("res2-r1", "https://a.example/", t0 + 60_000));   // a reconnect replays the ring
    w.shadow.querySelector(".row").click();
    await w.tick();

    const urls = [...w.shadow.querySelectorAll(".resume-divider .nav-url")].map((e) => e.textContent);
    assert.equal(urls.length, 2, "one divider per resume, and a repeated note is the same resume");
    assert.match(urls[0], /a\.example/);
    assert.match(urls[1], /b\.example/);
});

test("agent run: a DENIED navigate does NOT render a transition divider (the page didn't change)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nav2", "try to leave"));
    await w.dispatch(agentStep("nav2", 1, { seq: 1, tool: "navigate", approval: "denied", arguments: { url: "https://evil.example/" }, result: "Denied by the user." }));
    await w.dispatch(agentResult("nav2", "Stayed put.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".nav-divider"), "no divider for a nav that didn't happen");
});

// --- what a run says about itself: the options block and the run-stats bar -------------------------------

test("stream:true: live reasoning fills a live thinking block (ticking count); a real step then clears it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("st1", "read the diff", "m", 20, streamConfig({ stream: true })));
    await w.dispatch({ kind: "agent-stream", id: "st1", ts: Date.now(), save: false, session: { hash: "st1", turn: 1 }, step: 1, localStep: 1, reasoning: "Let me look at the routes file section…" });
    w.shadow.querySelector(".row").click();
    await w.tick();
    // Streams into a LIVE thinking block inside the SAME .aturn shell (StepPill) a finished step uses — so it
    // doesn't jump when it settles.
    const turn = w.shadow.querySelector(".aturn:has(.athinking.live)");
    assert.ok(turn, "the live thinking sits in an .aturn group");
    assert.match(turn.querySelector(".step-pill").textContent, /step 1\/20/, "with the SAME StepPill the settled step shows");
    const think = turn.querySelector(".athinking.live");
    assert.match(think.textContent, /~\d+ tokens/, "the ticking token estimate shows");
    think.querySelector(".astep-head").click(); await w.tick();   // expand to watch the text
    assert.match(w.shadow.querySelector(".athinking.live .astep-body").textContent, /routes file section/, "the accumulated thinking text is there");
    // A real step landing supersedes the live preview.
    await w.dispatch(agentStep("st1", 1, { seq: 1, tool: "exec", arguments: { js: "1" }, result: "1", approval: "readonly" }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".athinking.live"), null, "the live thinking clears when the step's real events land");
});

test("stream:true: live reply CONTENT streams into the SAME reply bubble shape (model chip, no copy/raw yet)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("st2", "answer me", "m", 20, streamConfig({ stream: true })));
    await w.dispatch({ kind: "agent-stream", id: "st2", ts: Date.now(), save: false, session: { hash: "st2", turn: 1 }, step: 1, localStep: 1, content: "The file loads fine and lists 14 servers." });
    w.shadow.querySelector(".row").click(); await w.tick();
    const reply = w.shadow.querySelector(".msg.asst.streaming");
    assert.ok(reply, "the streaming reply uses the same .msg.asst bubble (streaming variant)");
    assert.match(reply.textContent, /14 servers/, "the streaming answer text shows");
    assert.ok(reply.querySelector(".live-dot"), "with a live pulse (in place of the chevron/dot)");
    assert.equal(reply.querySelector(".raw-btn"), null, "and no raw toggle yet (lands when it settles)");
});

test("agent options: shows 'streaming: on' when the run streamed, 'off' otherwise", async () => {
    const on = await loadSidebarWorld();
    await on.dispatch(agentStart("so1", "t", "m", 20, streamConfig({ stream: true })));
    await on.dispatch(agentResult("so1", "done", 1));
    on.shadow.querySelector(".row").click(); await on.tick();
    on.shadow.querySelector(".agent-opts .block-head").click(); await on.tick();
    assert.match(on.shadow.querySelector(".agent-opts .opts").textContent, /streaming: on/);

    const off = await loadSidebarWorld();
    await off.dispatch(agentStart("so2", "t", "m", 20, streamConfig()));   // no stream flag
    await off.dispatch(agentResult("so2", "done", 1));
    off.shadow.querySelector(".row").click(); await off.tick();
    off.shadow.querySelector(".agent-opts .block-head").click(); await off.tick();
    assert.match(off.shadow.querySelector(".agent-opts .opts").textContent, /streaming: off/);
});

test("agent options: the tool definitions viewer renders a JSON tree of each tool's parameter schema", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tdv", "do stuff", "m", 10, {
        system: "you are an automation agent", customSystem: false, maxSteps: 10,
        think: null, env: true, vision: null, systemAppend: null,
        tools: [{
            name: "click", requiresApproval: true, vision: false,
            description: "Click an element by selector.",
            parameters: { type: "object", properties: { selector: { type: "string", description: "a CSS selector" } }, required: ["selector"] },
        }],
    }));
    await w.dispatch(agentResult("tdv", "done", 0));
    w.shadow.querySelector(".row").click();
    await w.tick();

    // Open the "agent options" block, then reveal the tool definitions.
    w.shadow.querySelector(".block .block-head").click();
    await w.tick();
    const toolsBtn = [...w.shadow.querySelectorAll(".disc-head")].find(b => /tool definitions/.test(b.textContent));
    assert.ok(toolsBtn, "a 'tool definitions' toggle appears when the config carries full defs");
    toolsBtn.click();
    await w.tick();

    const def = w.shadow.querySelector(".tooldef");
    // Collapsed by default: the name + badges show, the description/params don't.
    assert.match(def.querySelector(".tooldef-name").textContent, /click/, "the tool name");
    assert.ok(def.querySelector(".tooldef-warn"), "requiresApproval shows a warn marker (even collapsed)");
    assert.equal(def.querySelector(".tooldef-desc"), null, "description hidden until expanded");
    // Expand the card → description + params appear.
    def.querySelector(".tooldef-head.clickable").click();
    await w.tick();
    assert.match(def.querySelector(".tooldef-desc").textContent, /Click an element/, "the description");
    // The JSON tree: a foldable `parameters` root; expanding it reveals the schema keys.
    const root = def.querySelector(".tooldef-params .jt-branch");
    assert.match(root.textContent, /parameters/, "the tree roots at `parameters`");
    root.click();   // expand
    await w.tick();
    assert.match(def.querySelector(".tooldef-params").textContent, /selector/, "expanded tree shows a nested property");
});

test("agent options block renders the config + reveals the system prompt", async () => {
    const cfg = {
        system: "You are an automation agent operating on the page.", customSystem: false,
        tools: [{ name: "look", requiresApproval: false }, { name: "click", requiresApproval: true }],
        maxSteps: 8, think: null, env: true, vision: null, systemAppend: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ao", "task", "gemma", 8, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".block .block-label").textContent, /agent options/);

    w.shadow.querySelector(".block .block-head").click();   // expand
    await w.tick();
    assert.match(w.shadow.querySelector(".opts").textContent, /maxSteps: 8/);
    assert.match(w.shadow.querySelector(".opts").textContent, /tools \(2\): look, click ⚠/);

    w.shadow.querySelector(".sys-block .disc-head").click();   // open the system prompt section
    await w.tick();
    assert.match(w.shadow.querySelector(".sys-block .code").textContent, /automation agent/);
});

test("agent options: warns when no vision model resolved (look/locate unavailable)", async () => {
    const cfg = {
        system: "s", customSystem: false,
        tools: [{ name: "findByText", requiresApproval: false }],   // no vision tool
        maxSteps: 10, think: null, env: true, vision: null, systemAppend: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nv", "task", "text-model", 10, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".block-head .arg-warn").textContent, /no vision/);
    w.shadow.querySelector(".block .block-head").click();   // expand
    await w.tick();
    assert.match(w.shadow.querySelector(".arg-issues").textContent, /visual tools unavailable/);
});

test("agent options: no vision warning when a vision tool IS wired", async () => {
    const cfg = {
        system: "s", customSystem: false,
        tools: [{ name: "look", requiresApproval: false, vision: true }],
        maxSteps: 10, think: null, env: true, vision: null, systemAppend: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("hv", "task", "qwen2.5vl", 10, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".block-head .arg-warn"), null, "no warning when look is present");
});

// The DevTools run-stats bar (RunStatsBar) — cumulative token SPEND + generation rate below the detail
// composer, each figure independently toggled (chrome.storage.local prefs), with a provenance tooltip. Usage
// rides the per-STEP emits (one per model call), so the bar sums across calls. Panel chrome only.
test("DevTools run-stats bar: cumulative in/out tokens summed across calls (default on)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rstat", "compute"));
    await w.dispatch(agentStep("rstat", 1, { seq: 1, tool: "python_exec", arguments: { code: "1" }, result: "1", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, genMs: 500 } }));
    await w.dispatch(agentStep("rstat", 2, { seq: 2, thought: "final", usage: { promptTokens: 140, completionTokens: 30, totalTokens: 170, genMs: 600 } }));
    await w.dispatch(agentResult("rstat", "done", 2));
    await openRun(w);
    const bar = w.shadow.querySelector(".run-stats");
    assert.ok(bar, "the run-stats bar renders");
    // Two figures now, each with its own arrow: one shared ↕ made the arrow mean "tokens" and left the
    // direction to the words, which is backwards for a readout you take in at a glance.
    assert.match(bar.textContent, /240 in/, "cumulative IN summed across both calls");
    assert.match(bar.textContent, /50 out/, "…and cumulative OUT");
    const stats = [...bar.querySelectorAll(".rstat")].filter((e) => !e.classList.contains("rstat-tps"));
    assert.equal(stats.length, 2, "in and out are separate figures");
    assert.equal(stats[0].querySelectorAll("svg").length, 1, "each carries its own direction arrow");
    assert.equal(stats[1].querySelectorAll("svg").length, 1);
    assert.doesNotMatch(bar.textContent, /tok\/s/, "tok/s is OFF by default");
});

test("DevTools run-stats bar: tok/s shows when enabled + a provenance tooltip records how it was measured", async () => {
    const w = await loadSidebarWorld({ local: { ml_debug_stats_tps: true } });   // enable the tok/s figure
    await w.dispatch(agentStart("rstat2", "compute"));
    // 60 completion tokens over 2s of Ollama eval time = 30 tok/s (generation-only basis).
    await w.dispatch(agentStep("rstat2", 1, { seq: 1, thought: "t", usage: { promptTokens: 100, completionTokens: 60, totalTokens: 160, evalMs: 2000 } }));
    await w.dispatch(agentResult("rstat2", "done", 1));
    await openRun(w);
    const bar = w.shadow.querySelector(".run-stats");
    assert.match(bar.textContent, /30\.0 tok\/s/, "60 tokens ÷ 2s eval = 30 tok/s");
    assert.match(bar.querySelector(".tt-pop").textContent, /Ollama generation time/, "the tooltip records the rate's provenance");
});

// LIVE, with the run OPEN (reported 2026-09-16: the bar sat still while tokens streamed). Two faults: the bar reads the
// stats signals, so it was memoized on a session object that is mutated in place and never re-rendered mid-run; and it
// summed finished calls only, ignoring the engine's running count on the call streaming now.
test("DevTools run-stats bar: OUT climbs while a call streams, then settles on the call's own count", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rlive", "compute"));
    await w.dispatch(agentStep("rlive", 1, { seq: 1, tool: "python_exec", arguments: { code: "1" }, result: "1", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, genMs: 500 } }));
    await openRun(w);
    const out = () => w.shadow.querySelector(".run-stats")?.textContent.match(/([\d,]+) out/)?.[1];
    assert.equal(out(), "20", "the finished call");
    const stream = (tokens) => w.dispatch({ kind: "agent-stream", id: "rlive", ts: Date.now(), save: false, session: { hash: "rlive", turn: 2 }, step: 2, localStep: 2, reasoning: "thinking about it", tokens });
    await stream(7); await w.flush();
    assert.equal(out(), "27", "the streaming call's running count is added as it arrives");
    await stream(35); await w.flush();
    assert.equal(out(), "55", "…and keeps climbing (a running total, never summed)");
    await w.dispatch(agentStep("rlive", 2, { seq: 2, thought: "done", usage: { promptTokens: 140, completionTokens: 40, totalTokens: 180, genMs: 600 } }));
    await w.flush();
    assert.equal(out(), "60", "the landed step replaces the live count with its own, counted once");
});

test("DevTools run-stats bar: renders nothing before any usage is reported", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rstat3", "compute"));
    await w.dispatch(agentStep("rstat3", 1, { seq: 1, pending: true, tool: "look", arguments: {} }));   // no usage yet
    await openRun(w);
    assert.equal(w.shadow.querySelector(".run-stats"), null, "no bar until the model reports token counts");
});
