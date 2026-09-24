// sidebar-card.test.js — the HUD corner card: the answer and its media, Show work, the Spotlight
// composer, several live runs sharing the card, and the orb's own live chrome.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, agentSay, agentSaySeen, streamConfig } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// Dispatch a 2-TASK run (task → answer, then a follow-up say → answer) so Show-work has >1 block to segment.
async function twoTaskRun(w, hash) {
    await w.dispatch(agentStart(hash, "find cats", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "cat" }, result: "found cats" }));
    await w.dispatch(agentResult(hash, "Found the cats.", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "now find dogs" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "findByText", arguments: { text: "dog" }, result: "found dogs" }));
    await w.dispatch(agentResult(hash, "Found the dogs.", 2));
    await w.flush();
}

// Events with EXPLICIT ts so createdTs (tab order) + lastTs (latest-active) are deterministic.
const cStart = (hash, task, ts, config = null) => ({ kind: "agent", id: hash, ts, save: false, session: { hash, turn: 0 }, task, model: "m", maxSteps: 10, config });

const cStep = (hash, step, ts, fields) => ({ kind: "agent-step", id: hash, ts, save: false, session: { hash, turn: step }, step, ...fields });

const cResult = (hash, summary, ts, steps = 1, extra = {}) => ({ kind: "agent-result", id: hash, ts, save: false, session: { hash, turn: steps }, summary, steps, hitCap: false, ...extra });

const APPROVAL_STEP = { seq: 0, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#danger" },
    renderIn: { type: "action", verb: "Click", kind: "button", target: "Delete account", selector: "#danger" } };

const pointerDown = (win, el) => el.dispatchEvent(new win.Event("pointerdown", { bubbles: true, cancelable: true }));

// --- the HUD card as a surface: the answer, its media, and what must not leak to it ----------------------

// ─── off-mode approval CARD (the "card" surface) ───
// The shell hosts the SAME app iframe as a corner card and tells it `__mlSidebarSurface: "card"`. The
// app then renders a curated view of the one background-hosted run, drives its own reveal via
// `__mlSidebarCard`, and gates approval through the same unforgeable `__mlSidebarApp: "approval"` path.

test("card surface: a pending approval shows the action directly + Approve posts the unforgeable decision", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);   // capture what the app posts to its parent (the shell)

    await w.raw({ __mlSidebarSurface: "card" });
    assert.equal(w.window.document.documentElement.dataset.surface, "card", "switched to the card surface");

    const hash = "cardrun1";
    await w.dispatch(agentStart(hash, "delete the account", "m"));
    // The tool provides an `action` intent descriptor (verb + human target + highlight selector).
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "#danger" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "Delete account", selector: "#danger" } }));
    await w.flush();

    // A pending approval reveals the card EXPANDED (urgent — you act on it), showing the intent sentence.
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "pending approval shows expanded directly");
    const doc = w.window.document;
    assert.match(doc.querySelector(".card-head-txt").textContent, /Approval needed/);
    const sentence = doc.querySelector(".action-sentence").textContent;
    assert.match(sentence, /click the button/, "plain-English intent");
    assert.match(sentence, /Delete account/, "human target, not the selector");
    // The card highlighted the real element on the page as a pulsing-green approval spotlight.
    assert.ok(posted.some(m => m.__mlHighlight && m.__mlHighlight.selector === "#danger" && m.__mlHighlight.kind === "approve"), "pulsing highlight on the target");

    // The Deny/Approve controls live in the fixed footer (outside the scroll area), with key hints.
    const approve = doc.querySelector(".card-foot .appr-btn.yes");
    assert.ok(approve && approve.textContent.includes("Approve"), "Approve control rendered in the footer");
    approve.click(); await w.flush();

    const decision = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(decision, "posted an approval decision to the shell (→ SET_APPROVAL)");
    assert.equal(decision.hash, hash);
    assert.equal(decision.seq, 0);
    assert.equal(decision.decision, true);
});

test("card surface: the final answer shows; debug steps/thinking don't leak", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardrun2";
    await w.dispatch(agentStart(hash, "survey the page", "m"));
    await w.dispatch(agentStep(hash, 1, { reasoning: "thinking about it…" }));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "exec", arguments: { js: "x" }, result: "ok", approval: "readonly" }));
    await w.dispatch(agentResult(hash, "The page has three sections.", 1));
    await w.flush();

    // A finished run shows its ANSWER directly (expanded) — no click needed; only the answer, no rows.
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "finished run reveals the answer directly");
    const body = w.window.document.querySelector(".card-body");
    assert.ok(body, "answer body rendered");
    assert.doesNotMatch(body.textContent, /thinking about it/, "thinking is hidden in the card");
    assert.ok(!body.querySelector(".astep"), "no debug step rows leak into the card");
    assert.ok(body.querySelector(".card-answer"), "answer rendered as plain markdown");
    assert.match(body.textContent, /three sections/, "the final answer shows");
});

test("card surface: answer element visuals render in the HUD card (user-facing deliverable)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "ansmedia";
    const media = [{ image: "data:image/png;base64,CATPIC", label: "the best cat", selector: "img.cat" }];
    await w.dispatch(agentStart(hash, "find the best cat", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "answer", arguments: { selector: "img.cat" }, result: "Answer: 1 element(s)" }));
    await w.dispatch({ ...agentResult(hash, "Here's the best cat.", 1), answerMedia: media });
    await w.flush();

    const body = w.window.document.querySelector(".card-body");
    const gallery = body.querySelector(".card-answer-media");
    assert.ok(gallery, "the HUD card renders the answer-media gallery");
    assert.equal(gallery.querySelectorAll("img").length, 1, "one answer image");
    assert.match(gallery.querySelector("img").getAttribute("src"), /CATPIC/, "the captured crop is the src");
    // "Show work" moved ABOVE the answer.
    const work = body.querySelector(".card-work-toggle, [class*=card-work]");
    const answer = body.querySelector(".card-answer");
    if (work && answer) assert.ok(body.innerHTML.indexOf("card-work") < body.innerHTML.indexOf("card-answer"), "Show work is above the answer");
});

test("card surface: answer media renders inline vs highlight-chip, and hover-highlights the page element", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "ansmode";
    const media = [
        { image: "data:image/png;base64,IMG", label: "the cat", selector: "img.cat", kind: "image", mode: "inline" },
        { image: "", label: "the buy button", selector: "button.buy", kind: "element", mode: "highlight" },
    ];
    await w.dispatch(agentStart(hash, "find things", "m"));
    await w.dispatch({ ...agentResult(hash, "found them", 1), answerMedia: media });
    await w.flush();
    const gallery = w.window.document.querySelector(".card-answer-media");
    assert.ok(gallery.querySelector(".am-inline img"), "inline mode shows the image");
    assert.ok(gallery.querySelector(".am-chip"), "highlight mode shows a compact chip");
    assert.match(gallery.querySelector(".am-chip").textContent, /buy button|locate on page/, "the chip labels the element");

    // Hovering the inline item highlights the corresponding element on the page (the debug highlighter).
    posted.length = 0;
    gallery.querySelector(".am-inline").dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    assert.ok(posted.some(m => m.__mlHighlight && m.__mlHighlight.selector === "img.cat"), "hover posts a highlight for the element");
    gallery.querySelector(".am-inline").dispatchEvent(new w.window.MouseEvent("pointerleave", { bubbles: true }));
    assert.ok(posted.some(m => m.__mlHighlight === null), "leaving clears the highlight");
});

test("card surface: a steer's SEEN indicator renders in the HUD Show-work too (surface parity)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "cardsteer";
    // The live QUEUED→SEEN transition is proven by the DevTools reducer tests (same reducer + SteerSeen
    // component); here we just confirm the indicator ALSO renders on the HUD surface. The compact card only
    // exposes the trace once revealed (after completion), so drive a full run: one steer SEEN, one left QUEUED.
    await w.dispatch(agentStart(hash, "do the task", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentSay(hash, "focus on the header", "sy_c1"));
    await w.dispatch(agentSaySeen(hash, "sy_c1"));                      // the agent drained this one
    await w.dispatch(agentSay(hash, "and the footer", "sy_c2"));        // this one never got picked up
    await w.dispatch(agentResult(hash, "done", 2));
    await w.flush();
    // Open "Show work" — the trace (and its steer bubbles) live there in the card.
    const toggle = w.window.document.querySelector(".card-work-toggle");
    assert.ok(toggle, "the completed card exposes a Show-work toggle");
    toggle.click();
    await w.tick();
    const badges = [...w.window.document.querySelectorAll(".card-body .steer-seen")];
    assert.ok(badges.some(b => b.classList.contains("on")), "the drained steer shows SEEN in the card");
    assert.ok(badges.some(b => b.classList.contains("wait")), "the undrained steer stays QUEUED in the card");
});

test("card surface: orb-steer opens an inline steer box on a LIVE run and sends via say()", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "orbsteer";
    // A LIVE run (started + one tool step, no result) → the compact card is just the working orb, no input.
    await w.dispatch(agentStart(hash, "keep working", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-steer-in"), "no steer box until you ask for it");

    // The shell's orb corner-menu "Steer this run…" posts this into the app.
    await w.raw({ __mlSteerRun: { hash } });
    await w.flush();
    const input = w.window.document.querySelector(".card-steer-in");
    assert.ok(input, "the steer box opens on the live card");

    // Type + Enter → a sessionSend for THIS run (the page routes it to say() while the run is live).
    input.value = "focus on the pricing table";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();   // let Preact re-render so the keydown handler closes over the new text
    w.window.document.querySelector(".card-steer-in").dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarApp === "sessionSend" && m.hash === hash && m.text === "focus on the pricing table"), "Enter sends the steer via sessionSend");
    // Stays OPEN after a send (you may steer again), and the field cleared.
    assert.ok(w.window.document.querySelector(".card-steer-in"), "the steer box stays open after sending");
    assert.equal(w.window.document.querySelector(".card-steer-in").value, "", "the field cleared for the next nudge");

    // × closes it → back to the working orb (no steer box).
    w.window.document.querySelector(".card-steer-x").click();
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-steer-in"), "closing returns to the orb");
});

test("card surface: the steer box auto-closes when the run finishes", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "steerclose";
    await w.dispatch(agentStart(hash, "work", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.raw({ __mlSteerRun: { hash } });
    await w.flush();
    assert.ok(w.window.document.querySelector(".card-steer-in"), "steer box is open mid-run");
    await w.dispatch(agentResult(hash, "all done", 1));   // run completes
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-steer-in"), "the steer box is gone once the run finished");
    assert.ok(w.window.document.querySelector(".card-reply, .card-answer"), "the finished card shows its answer/reply instead");
});

test("card surface: 'Add to current run' opens the composer in APPEND mode and sends to the open session", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "addrun";
    // A live run is open in the HUD.
    await w.dispatch(agentStart(hash, "work on the page", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.flush();

    // Right-click "Add this to the current run" → the shell resolves the element and posts this in.
    const ctx = { selector: "div#price", role: "region", anchorText: "Pricing", text: "Pro plan $20/mo" };
    await w.raw({ __mlAddToCurrentRun: { ctx } });
    await w.flush();
    // The composer opens in APPEND mode: the element pill shows, and the head names the target (not "New task").
    assert.ok(w.window.document.querySelector(".card-cmp-input"), "the composer opened");
    assert.ok(w.window.document.querySelector(".el-pill"), "the element context rides along as a pill");
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Steer|Add to run/, "the head shows it's appending, not a new task");

    // Type + send → routes to sessionSend for the OPEN run (with the element context), NOT a fresh startRun.
    const ta = w.window.document.querySelector(".card-cmp-input");
    ta.value = "what does this cost?";
    ta.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    w.window.document.querySelector(".appr-btn.yes").click();
    await w.tick();
    const sent = posted.find(m => m.__mlSidebarApp === "sessionSend");
    assert.ok(sent, "it posts a sessionSend, not a startRun");
    assert.ok(!posted.some(m => m.__mlSidebarApp === "startRun"), "no fresh run was started");
    assert.equal(sent.hash, hash, "targets the open run's hash");
    assert.equal(sent.text, "what does this cost?", "carries the typed text");
    assert.equal(sent.elementContext.selector, "div#price", "carries the element context to fold in page-side");
});

test("card surface: 'Add to current run' with NO open run falls back to a fresh composer (never a dead entry)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "m" } });   // a model is set so the new-run path isn't blocked by the preflight
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    // Nothing running/open.
    await w.raw({ __mlAddToCurrentRun: { ctx: { selector: "p#x", role: "paragraph", text: "hi" } } });
    await w.flush();
    assert.ok(w.window.document.querySelector(".card-cmp-input"), "the composer still opens");
    const ta = w.window.document.querySelector(".card-cmp-input");
    ta.value = "summarise this";
    ta.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    w.window.document.querySelector(".appr-btn.yes").click();
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarApp === "startRun"), "with no open run it starts a FRESH run");
    assert.ok(!posted.some(m => m.__mlSidebarApp === "sessionSend"), "…not an append");
});

test("card surface: a NEW round with no answer CLEARS the prior answer media (reset to 0)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "ansreset";
    await w.dispatch(agentStart(hash, "find the cat", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "answer", arguments: { selector: "img.cat" }, result: "Answer: 1 element(s)" }));
    await w.dispatch({ ...agentResult(hash, "here it is", 1), answerMedia: [{ image: "data:image/png;base64,CATPIC", label: "cat" }] });
    await w.flush();
    assert.ok(w.window.document.querySelector(".card-answer-media"), "media shows after the answer");

    // A NEW round (a follow-up turn) that designates NOTHING → the prior answer media clears.
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "and now?" });
    await w.dispatch(agentStep(hash, 2, { thought: "nothing to return" }));
    await w.dispatch(agentResult(hash, "nothing to return this time", 2));   // no answerMedia on this turn
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-answer-media"), "the prior answer media is cleared on the new round");
});

test("card surface: a finished run has an inline reply that continues the SAME session", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardreply1";
    await w.dispatch(agentStart(hash, "do a thing", "m"));
    await w.dispatch(agentResult(hash, "Done.", 1));
    await w.flush();

    // Collapsed by default — a slim ghost affordance (icon + label), NOT a filled input. Click to open it.
    const opener = w.window.document.querySelector(".card-reply.collapsed .card-reply-open");
    assert.ok(opener, "the finished card shows the collapsed reply affordance");
    assert.ok(!w.window.document.querySelector(".card-reply-in"), "the input is hidden until opened");
    opener.click(); await w.flush();

    // Open state: the input + a nested send that's hidden (+ disabled) until you type.
    const input = w.window.document.querySelector(".card-reply .card-reply-in");
    const send = w.window.document.querySelector(".card-reply .card-reply-send");
    assert.ok(input && send, "clicking reveals the inline reply input + nested send");
    assert.ok(send.disabled && !send.classList.contains("show"), "send is hidden + disabled while the box is empty");

    input.value = "and now the next thing";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.flush();
    assert.ok(!send.disabled && send.classList.contains("show"), "typing reveals + enables the send button");
    send.click();
    await w.flush();

    const sent = posted.find(m => m.__mlSidebarApp === "sessionSend");
    assert.ok(sent && sent.hash === hash && sent.text === "and now the next thing",
        "the reply posts sessionSend {hash,text} — the same channel the panel composer uses");
});

test("card surface: a between-step thought expands the orb into a live prose CAPTION (Progress)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // default agentHud = progress
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "prose1";
    await w.dispatch(agentStart(hash, "sum up the table", "m"));
    await w.dispatch(agentStep(hash, 1, { thought: "Reading the quarterly sales table…" }));
    await w.flush();
    assert.ok(posted.some(m => m.__mlSidebarCard === "orbprose"), "the orb widens to the caption (orbprose) state");
    const label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label && /Reading the quarterly sales table/.test(label.textContent), "the caption shows the model's between-step prose");
});

test("card surface: the live caption STRIPS markdown/HTML the model emits (plain pill, no literal syntax)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "mdcap";
    await w.dispatch(agentStart(hash, "task", "m"));
    await w.dispatch(agentStep(hash, 1, { thought: "**Scanning** the `settings` <b>panel</b> — see [docs](http://x)" }));
    await w.flush();
    const label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    const text = label ? label.textContent : "";
    assert.match(text, /Scanning the settings panel — see docs/, "formatting removed, words kept");
    assert.ok(!/[*`<>]|\]\(/.test(text), "no literal markdown/HTML syntax leaks into the pill");
});

test("card surface: live prose is SUPPRESSED in Quiet mode (no caption, no orb)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", agentHud: "quiet" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "prose2";
    await w.dispatch(agentStart(hash, "task", "m"));
    await w.dispatch(agentStep(hash, 1, { thought: "Working on it…" }));
    await w.flush();
    assert.ok(!posted.some(m => m.__mlSidebarCard === "orbprose"), "no live caption in quiet mode");
    assert.ok(!w.window.document.querySelector(".card-orb"), "no orb rendered at all");
});

test("card surface: the live caption updates to the current step — it doesn't STICK to a prior step's prose", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // progress HUD
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "stick";
    await w.dispatch(agentStart(hash, "read then click", "m"));
    // Step 1: the model NARRATES (thought), then runs a tool.
    await w.dispatch(agentStep(hash, 1, { thought: "Scanning the settings panel…" }));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "describeElement", arguments: { selector: "pref-panel" }, result: "…" }));
    await w.flush();
    let label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label && /Scanning the settings panel/.test(label.textContent), "the narrated step shows its prose caption");
    // Step 2: a NEW tool step with NO narration (empty thought, usage only). The caption must NOT stay stuck.
    await w.dispatch(agentStep(hash, 2, { thought: "", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
    await w.dispatch(agentStep(hash, 2, { seq: 1, tool: "click", arguments: { selector: "@pt:ab" }, result: "Clicked." }));
    await w.flush();
    label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(!label || !/Scanning the settings panel/.test(label.textContent), "the stale narration is gone once a new tool runs without prose");
    // The orb still renders (working) — it just shows the current tool's activity instead of the stale text.
    assert.ok(w.window.document.querySelector(".card-orb"), "the working orb is still shown");
});

test("card surface: a type approval calls out type-AND-SUBMIT (dotted underline), plain type doesn't", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // submit:true — the approval must emphasise that it will SEND, not just type.
    await w.dispatch(agentStart("subT", "search cats", "m"));
    await w.dispatch(agentStep("subT", 1, { seq: 0, pending: true, awaitingApproval: true, tool: "type", arguments: { selector: "input", text: "cats", submit: true } }));
    await w.flush();
    let sentence = w.window.document.querySelector(".action-sentence");
    assert.ok(sentence && sentence.querySelector(".action-submit"), "type+submit is emphasised with .action-submit");
    assert.match(sentence.textContent, /and submit it/i, "the sentence spells out the submit");

    // A plain type (no submit) — no emphasis.
    const w2 = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w2.window.postMessage = () => {};
    await w2.raw({ __mlSidebarSurface: "card" });
    await w2.dispatch(agentStart("plainT", "type a draft", "m"));
    await w2.dispatch(agentStep("plainT", 1, { seq: 0, pending: true, awaitingApproval: true, tool: "type", arguments: { selector: "input", text: "cats" } }));
    await w2.flush();
    sentence = w2.window.document.querySelector(".action-sentence");
    assert.ok(sentence && !sentence.querySelector(".action-submit"), "a plain type has no submit emphasis");
});

test("card surface: quiet HUD suppresses the working pill, but an approval still surfaces the card", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", agentHud: "quiet" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "quiet1";
    await w.dispatch(agentStart(hash, "read the page", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));   // running (no gate)
    await w.flush();
    assert.ok(!posted.some(m => m.__mlSidebarCard === "orb"), "no idle orb in quiet mode");
    assert.ok(!w.window.document.querySelector(".card-orb"), "orb is not rendered");

    // An actual approval must STILL surface the card (quiet only drops the idle pill, never the gate).
    await w.dispatch(agentStep(hash, 2, { seq: 1, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "#x" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "X", selector: "#x" } }));
    await w.flush();
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "the approval still shows the card");
});

test("card surface: a fatal run error surfaces (Run failed + the message), even in quiet mode", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", agentHud: "quiet" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardErr";
    await w.dispatch(agentStart(hash, "do the thing", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));   // running (quiet → no pill)
    await w.dispatch({ kind: "agent-result", id: hash, ts: Date.now(), save: false, session: { hash, turn: 1 }, summary: "", steps: 1, hitCap: false, error: "model call failed: HTTP 500" });
    await w.flush();

    // A terminal error reveals the card even in quiet mode (you need to know the run died).
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "the error reveals the card");
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Run failed/);
    assert.match(w.window.document.querySelector(".card-error").textContent, /HTTP 500/);
});

test("card surface: a running run shows the liquid orb + right-click asks for the corner menu", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardrun3";
    await w.dispatch(agentStart(hash, "read the page", "m"));
    // A running tool step (pending, but NOT awaiting approval) → the liquid tool orb.
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));
    await w.flush();

    assert.ok(posted.some(m => m.__mlSidebarCard === "orb"), "reveals the working orb while running");
    const orb = w.window.document.querySelector(".card-orb");
    assert.ok(orb, "orb rendered");
    assert.match(orb.querySelector(".card-orb-ic")?.textContent || "", /👁/, "shows the look tool emoji");
    // Hover → the blob RESHAPES into a labelled capsule spelling out the current tool.
    orb.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.ok(posted.some(m => m.__mlSidebarCard === "orblabel"), "hover stretches the orb into the labelled capsule");
    assert.match(w.window.document.querySelector(".card-orb-label")?.textContent || "", /screen/i, "the capsule names the current tool (look → viewing the screen)");

    // Right-clicking the orb asks the shell to draw the corner menu (shell-side, unclipped).
    orb.dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarCornerMenu), "right-click requests the corner menu");
});

test("card surface: a cancelled run reads as 'Cancelled'", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cxld";
    await w.dispatch(agentStart(hash, "long task", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch({ kind: "agent-result", id: hash, ts: Date.now(), save: false, session: { hash, turn: 1 }, summary: "", steps: 1, hitCap: false, cancelled: true });
    await w.flush();

    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Cancelled/, "the headline shows Cancelled");
});

// --- Show work on the card: task blocks, summaries and on-demand Explain ---------------------------------

test("card Show-work: a multi-TASK run segments into collapsible blocks (priors collapsed, latest expanded)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // no utilityModel → prompt fallback
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await twoTaskRun(w, "multitask");
    w.window.document.querySelector(".card-work-toggle").click();   // open Show work
    await w.tick();
    const blocks = w.window.document.querySelectorAll(".run-block");
    assert.equal(blocks.length, 2, "two task blocks");
    assert.ok(!blocks[0].querySelector(".run-block-body"), "the prior block is collapsed");
    assert.ok(blocks[1].querySelector(".run-block-body"), "the latest block is expanded");
    assert.match(blocks[0].querySelector(".run-block-sum").textContent, /find cats/, "prompt fallback in the collapsed header");
    assert.match(blocks[0].querySelector(".run-block-n").textContent, /1 step/, "step-count chip");
});

test("card Show-work: a single-task run is NOT segmented (flat trace, no blocks)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("single", "find cats", "m"));
    await w.dispatch(agentStep("single", 1, { seq: 1, tool: "findByText", arguments: { text: "cat" }, result: "found" }));
    await w.dispatch(agentResult("single", "Found them.", 1));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click();
    await w.tick();
    assert.equal(w.window.document.querySelectorAll(".run-block").length, 0, "no per-task blocks for a single task");
    assert.ok(w.window.document.querySelector(".card-work-trace"), "the flat trace still renders");
});

test("card Show-work: a block header renders inline `$…$` math (summaries/prompts carry latex)", async () => {
    // The block header is utility-model / prompt prose that often carries inline `$…$` (e.g. "derivative of
    // $\sin^2(x)$"); it must typeset via markdown+math, not show literal `$…$`. (No utilityModel here → the
    // header is the prompt fallback, which is enough to exercise the render.)
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "blkmath";
    await w.dispatch(agentStart(hash, "Find the derivative of $\\sin^2(x)$", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult(hash, "done", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "findByText", arguments: { text: "y" }, result: "ok" }));
    await w.dispatch(agentResult(hash, "done2", 2));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click(); await w.tick();
    const sum = w.window.document.querySelectorAll(".run-block-sum")[0];
    assert.ok(sum, "block 0 has a header");
    assert.ok(sum.querySelector(".katex"), "inline $…$ in the block header typesets via KaTeX");
    assert.ok(!sum.textContent.includes("$"), "no literal $ delimiters remain in the header");
});

test("card Show-work: the utility model summarises each block (lazy on open, replaces the prompt, cached)", async () => {
    let calls = 0;
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", utilityModel: "gemma4:e2b" },
        // Count only BLOCK-summary calls (payload starts "Request:") — genTitle also fires a utility call.
        fetchLlm: (payload) => {
            const isBlock = payload.extend === "utility" && (payload.messages || []).some(m => typeof m.content === "string" && m.content.startsWith("Request:"));
            // Prefix "Summary:" the way a real model does despite the "no preamble" instruction — the app must strip it.
            if (isBlock) { calls++; return { data: `Summary: Block summary ${calls}` }; }
            return { data: "a title" };
        },
    });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await twoTaskRun(w, "sum");
    assert.equal(calls, 0, "not fired until Show work is opened (lazy)");
    w.window.document.querySelector(".card-work-toggle").click();
    await w.flush(); await w.tick();
    const blocks = w.window.document.querySelectorAll(".run-block");
    const sum0 = blocks[0].querySelector(".run-block-sum");
    assert.match(sum0.textContent, /Block summary/, "the utility summary replaces the prompt");
    assert.ok(!/^summary:/i.test(sum0.textContent.trim()), "the model's 'Summary:' preamble is stripped");
    assert.ok(blocks[0].querySelector(".run-block-sum.ml-reveal"), "the summary fades in");
    // The tooltip UPDATES to reflect the summary now shown (was stale, pinned to the prompt), and still keeps
    // the original request for reference.
    const tip = sum0.getAttribute("title");
    assert.match(tip, /Block summary/, "the tooltip shows the (untruncated) summary now displayed");
    assert.match(tip, /Request:/, "…and still carries the original request");
    assert.equal(calls, 2, "the utility model fired once per block");
    // Re-open → cached, no refire.
    w.window.document.querySelector(".card-work-toggle").click();   // close
    await w.tick();
    w.window.document.querySelector(".card-work-toggle").click();   // reopen
    await w.tick();
    assert.equal(calls, 2, "cached — no refire on reopen");
});

test("card Show-work: on-demand Explain fetches a plain-English gloss for a code step (card only)", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", utilityModel: "util" },
        fetchLlm: () => ({ data: "Sums every column and returns the grand total." }),
    });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "workE";
    await w.dispatch(agentStart(hash, "sum it", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "python_exec", arguments: { code: "df.sum()" }, result: "42", approval: "sandbox" }));
    await w.dispatch(agentResult(hash, "The total is 42.", 1));
    await w.flush();

    const doc = w.window.document;
    doc.querySelector(".card-work-toggle").click(); await w.tick();          // expand Show work
    const step = doc.querySelector(".card-work-trace .astep.tool");
    // The Explain affordance lives UNDER the collapsed step (not nested in its expand) — no head click.
    assert.ok(!step.querySelector(".astep-body"), "the step is still collapsed");
    const btn = [...step.querySelectorAll("button")].find(b => /Explain this Python/.test(b.textContent));
    assert.ok(btn, "an Explain affordance shows on the collapsed code step in the card trace");

    btn.click(); await w.flush();
    assert.match(step.querySelector(".step-explain").textContent, /grand total/, "the gloss lands inline");

    // Right-click the toggle → an export menu (Markdown / PDF), reusing the debug-bar export logic.
    doc.querySelector(".card-work-toggle").dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await w.tick();
    const menu = doc.querySelector(".card-export-menu");
    assert.ok(menu, "right-click opens the export menu");
    const labels = [...menu.querySelectorAll(".menu-item")].map(b => b.textContent);
    assert.ok(labels.some(t => /Markdown/.test(t)) && labels.some(t => /PDF/.test(t)), "offers Markdown + PDF export");
});

// --- the card composer (Spotlight): starting a run, and picking its model --------------------------------

test("card composer (Spotlight): opens as a task input, Send posts a real startRun + closes", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    // The shell relays the Alt+Space command as __mlSidebarComposer: "open".
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    assert.ok(posted.some(m => m.__mlSidebarCard === "composer"), "the HUD morphs into the centered composer state");
    const input = doc.querySelector(".card-cmp-input");
    assert.ok(input, "the composer input renders");
    assert.match(doc.querySelector(".card-head-txt").textContent, /New task/);

    // Empty → Send disabled.
    const sendBtn = [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent));
    assert.ok(sendBtn.disabled, "Send is disabled with no text");

    // Pretty step-budget segmented control, default preset selected.
    const on = doc.querySelector(".seg .seg-opt.on");
    assert.ok(on && on.textContent === "20", "the default step budget (20) is the selected preset");

    // Type + Send → posts a real startRun with the task, and the composer closes.
    input.value = "summarise this page";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();
    const start = posted.find(m => m.__mlSidebarApp === "startRun");
    assert.ok(start, "Send posts a startRun to the shell");
    assert.equal(start.task, "summarise this page", "carries the typed task");
    assert.equal(start.maxSteps, 20, "carries the default step budget");
    assert.ok(!doc.querySelector(".card-cmp-input"), "the composer closes after sending");
    // The HUD acknowledges immediately (no dead gap before the run's first event): a "Starting…" bridge orb.
    assert.ok(posted.some(m => m.__mlSidebarCard === "orb"), "the HUD balls up into a working orb on send");
    assert.match(doc.querySelector(".card-orb-ic")?.textContent || "", /💭/, "the bridge orb shows the thinking emoji");
});

test("card composer: no model configured → an inline nudge, NOT a run (pre-flight)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "" } });   // fresh install, no model picked
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;

    doc.querySelector(".card-cmp-input").value = "do something";
    doc.querySelector(".card-cmp-input").dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();

    assert.ok(!posted.some(m => m.__mlSidebarApp === "startRun"), "no run is started with no model");
    const err = doc.querySelector(".card-cmp-err");
    assert.ok(err && /model/i.test(err.textContent), "an inline 'set a model' nudge shows instead");
    assert.ok(doc.querySelector(".card-cmp-input"), "the composer stays open (not closed) so you can fix it");
});

test("card composer: backend unreachable → a NEW run is BLOCKED with an inline notice (only new runs paused)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3", chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();   // the on-mount health probe flags the dead box
    const doc = w.window.document;
    // Proactively (before even typing) the composer shows the backend is down.
    assert.match(doc.querySelector(".card-cmp-err")?.textContent || "", /Backend unreachable/i, "a proactive offline notice shows");

    doc.querySelector(".card-cmp-input").value = "do something";
    doc.querySelector(".card-cmp-input").dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();

    assert.ok(!posted.some(m => m.__mlSidebarApp === "startRun"), "no NEW run is started while the box is down");
    assert.match(doc.querySelector(".card-cmp-err").textContent, /Backend unreachable/i, "the block reason is shown");
    assert.ok(doc.querySelector(".card-cmp-input"), "the composer stays open so it can send once the box is back");
});

// AN EMBEDDING MODEL CANNOT ANSWER A TASK, and this picker chooses who answers one. Listed, it sits between
// two models that would have worked and costs a round trip to be told so — which is exactly what happened
// with `embeddinggemma:300m` on a box that has several gemma builds.
test("commander: the model picker offers chat models only", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", model: "llama3" },
        models: ["llama3", "embeddinggemma:300m", "mystery-model", "gpt-4o"],
        ollamaModels: ["llama3", "embeddinggemma:300m", "mystery-model"],
        listModels: () => ({
            data: ["llama3", "embeddinggemma:300m", "mystery-model", "gpt-4o"],
            ollamaModels: ["llama3", "embeddinggemma:300m", "mystery-model"],
            // What /api/show says each one can do. `mystery-model` is UNCLASSIFIABLE — an old server, or a
            // model the probe could not describe — and a cloud id has no entry at all.
            kinds: {
                "llama3": ["completion", "tools"],
                "embeddinggemma:300m": ["embedding"],
                "mystery-model": null,
            },
        }),
    });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    await w.flush();

    const rows = [...doc.querySelectorAll(".cmp-model-row")].map((r) => r.textContent);
    const has = (m) => rows.some((r) => r.includes(m));
    assert.ok(has("llama3"), `a chat model is listed: ${rows}`);
    assert.ok(!has("embeddinggemma:300m"), `an embedding model is NOT: ${rows}`);
    // FAILS OPEN on anything it cannot classify: dropping a model that works is worse than listing one that
    // does not, so only an AFFIRMATIVE "this embeds" removes a row. A cloud id has no capabilities at all and
    // must survive that.
    assert.ok(has("mystery-model"), `an unclassifiable model stays: ${rows}`);
    assert.ok(has("gpt-4o"), `a cloud model stays: ${rows}`);
});

test("card composer: the model picker overrides the run's model, and a cloud pick adds a per-call vision toggle", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", model: "llama3" },
        models: ["llama3", "gpt-4o"], ollamaModels: ["llama3"],   // gpt-4o is non-Ollama (cloud) → offers native vision
    });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;

    // The chip shows the configured default; an Ollama default has NO native-vision toggle (auto-detected).
    assert.match(doc.querySelector(".cmp-model-name").textContent, /llama3/, "the chip shows the default model");
    assert.ok(!doc.querySelector(".cmp-vis"), "an Ollama default gets no vision toggle");

    // Open the dropdown → both allowed models listed, the default row starred.
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    const rows = [...doc.querySelectorAll(".cmp-model-row")];
    assert.equal(rows.length, 2, "the dropdown lists the allowed models (LIST_MODELS)");
    const starOn = doc.querySelector(".cmp-model-row .cmp-model-star.on");
    assert.ok(starOn && /llama3/.test(starOn.closest(".cmp-model-row").textContent), "the default model row is starred");

    // Pick the cloud model → it becomes the run's model, and the eye (native vision) appears.
    rows.find(r => /gpt-4o/.test(r.textContent)).click();
    await w.tick();
    assert.match(doc.querySelector(".cmp-model-name").textContent, /gpt-4o/, "the chip updates to the picked model");
    const eye = doc.querySelector(".cmp-vis");
    assert.ok(eye, "a non-Ollama pick surfaces the per-call vision toggle");
    eye.click();   // enable native vision for THIS run
    await w.tick();
    assert.ok(doc.querySelector(".cmp-vis.on"), "the vision toggle reads as on");

    // Type + Send → the startRun carries the per-call model AND vision:true.
    const input = doc.querySelector(".card-cmp-input");
    input.value = "read the chart";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();
    const start = posted.find(m => m.__mlSidebarApp === "startRun");
    assert.equal(start.model, "gpt-4o", "the per-call model rides the startRun payload");
    assert.equal(start.vision, true, "the per-call native-vision override rides along");
});

test("card composer: the default Ollama model sends NO per-call model/vision override", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3" }, models: ["llama3", "gpt-4o"], ollamaModels: ["llama3"] });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    const input = doc.querySelector(".card-cmp-input");
    input.value = "click login";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();
    const start = posted.find(m => m.__mlSidebarApp === "startRun");
    assert.equal(start.model, undefined, "no per-call model when the default is used — createAgent falls back to config");
    assert.equal(start.vision, undefined, "no vision override for an auto-detected Ollama model");
});

test("card composer: the ★ persists the picked model as the default (SET_MODEL)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3" }, models: ["llama3", "gpt-4o"], ollamaModels: ["llama3"] });
    w.window.postMessage = () => {};
    const sent = [];
    w.window.chrome.runtime.sendMessage = (msg, cb) => { sent.push(msg); if (cb) cb({ data: msg && msg.payload ? msg.payload.model : null }); };
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    const cloudRow = [...doc.querySelectorAll(".cmp-model-row")].find(r => /gpt-4o/.test(r.textContent));
    cloudRow.querySelector(".cmp-model-star").click();
    await w.tick();
    const setMsg = sent.find(m => m.type === "SET_MODEL");
    assert.ok(setMsg, "clicking the ★ sends a SET_MODEL");
    assert.equal(setMsg.payload.model, "gpt-4o", "SET_MODEL targets the row's model");
});

test("card composer: the dropdown ALWAYS includes the configured default (even a cloud one not in the server list) and sorts A→Z", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", model: "deepseek-v4-pro" },   // a cloud default NOT present in the server model list
        models: ["gemma4:e4b", "alpha:2b"], ollamaModels: ["gemma4:e4b", "alpha:2b"],
    });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    const names = [...doc.querySelectorAll(".cmp-model-row .cmp-model-row-name")].map(n => n.textContent);
    assert.deepEqual(names, ["alpha:2b", "deepseek-v4-pro", "gemma4:e4b"], "the default is present and the list is alphabetical");
    const starred = doc.querySelector(".cmp-model-row .cmp-model-star.on").closest(".cmp-model-row");
    assert.match(starred.textContent, /deepseek-v4-pro/, "the default (not in the server list) is the starred row");
});

// --- several runs at once: the tab strip, its badges and the collapsed summary ---------------------------

test("card concurrency: a second run does NOT steal the card from a run awaiting approval (badge-don't-steal)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // Run A hits an approval gate → it becomes the selected, expanded card.
    await w.dispatch(cStart("A", "delete the account", 1000));
    await w.dispatch(cStep("A", 1, 1010, APPROVAL_STEP));
    await w.flush();
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "A's approval is shown");

    // Run B starts LATER and streams steps (higher lastTs than A). It must NOT hijack the visible approval.
    await w.dispatch(cStart("B", "summarise the page", 2000));
    await w.dispatch(cStep("B", 1, 2010, { thought: "reading…" }));
    await w.dispatch(cStep("B", 1, 2020, { seq: 0, tool: "look", arguments: {}, result: "ok" }));
    await w.flush();

    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "still A's approval — B added a tab, it didn't steal the view");
    assert.match(w.window.document.querySelector(".action-sentence").textContent, /Delete account/, "the shown approval is still A's target");
});

test("card concurrency: the selected run stays put even after the OTHER run finishes", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "delete the account", 1000));
    await w.dispatch(cStep("A", 1, 1010, APPROVAL_STEP));      // A pending → selected
    await w.dispatch(cStart("B", "quick lookup", 2000));
    await w.dispatch(cResult("B", "The answer is 42.", 2100)); // B finishes with an answer
    await w.flush();

    // Selection is sticky on A's approval; B's completion does not yank the card over to B's answer.
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "A's approval still holds the card");
    assert.doesNotMatch(w.window.document.body.textContent, /The answer is 42/, "B's answer did not steal the view");
});

test("card concurrency: dismissing the shown run falls back to the OTHER run, not a blank card", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "task B", 1200));
    await w.dispatch(cResult("B", "Answer B.", 1300));
    await w.flush();
    // No pending run → auto-pick the most recently active (B, lastTs 1300).
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer B/, "the most-recent finished run shows first");

    // × on the finished card dismisses THIS run only (pointerdown, as the real handler binds).
    pointerDown(w.window, w.window.document.querySelector(".card-head .card-x"));
    await w.flush();
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer A/, "dismiss revealed the other run, not an empty/hidden card");

    // Dismiss the last one too → the card goes away entirely.
    pointerDown(w.window, w.window.document.querySelector(".card-head .card-x"));
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-answer"), "dismissing the last run hides the card");
});

test("card concurrency: a single run behaves exactly as before (no tab strip)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(cStart("solo", "one task", 1000));
    await w.dispatch(cResult("solo", "All done.", 1100));
    await w.flush();
    assert.match(w.window.document.querySelector(".card-answer").textContent, /All done/, "the single finished run shows its answer");
    assert.ok(!w.window.document.querySelector(".card-tabs"), "no tab strip for a single run");
});

test("card concurrency: >1 run shows a tab strip; clicking a tab switches the shown run", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "task B", 1200));
    await w.dispatch(cResult("B", "Answer B.", 1300));
    await w.flush();

    const tabs = w.window.document.querySelectorAll(".card-tabs .card-tab");
    assert.equal(tabs.length, 2, "two tabs for two runs");
    // Stable order by createdTs: A then B. B (latest) is the shown/active one by default.
    assert.match(tabs[0].querySelector(".card-tab-label").textContent, /task A/);
    assert.match(tabs[1].querySelector(".card-tab-label").textContent, /task B/);
    assert.ok(tabs[1].classList.contains("on"), "the latest run's tab is active by default");
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer B/, "B's answer shows");

    // Click A's tab → the card switches to A (manual selection sticks).
    tabs[0].click(); await w.flush();
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer A/, "clicking A's tab shows A");
    assert.ok(w.window.document.querySelectorAll(".card-tabs .card-tab")[0].classList.contains("on"), "A's tab is now active");
});

test("card concurrency: a run awaiting approval shows an amber pulse dot on its tab (badge)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // A is a finished run the user is viewing; B (later) hits an approval gate.
    await w.dispatch(cStart("A", "finished task", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "risky task", 1200));
    await w.dispatch(cStep("B", 1, 1210, APPROVAL_STEP));
    await w.flush();

    // selectedRun prefers the PENDING run → B's approval is shown, with tabs.
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "the pending run surfaces");
    const bTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /risky task/.test(t.textContent));
    assert.ok(bTab.querySelector(".card-tab-dot.pend"), "the pending run's tab carries the amber pulse dot");
    assert.ok(bTab.classList.contains("pend"), "…and the tab is flagged pending");
    // A's tab shows the done ✓, not a pulse.
    const aTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /finished task/.test(t.textContent));
    assert.ok(aTab.querySelector(".card-tab-fin"), "the finished run's tab shows a done glyph");
    assert.ok(!aTab.querySelector(".card-tab-dot"), "…and no pending dot");
});

test("card concurrency: a running run's tab shows a spinner; the × on a tab dismisses THAT run", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "done task", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "working task", 1200));
    await w.dispatch(cStep("B", 1, 1210, { thought: "still going…" }));
    await w.flush();

    // Two runs → tabs; B is working (higher lastTs) so it's shown as a compact toast with a spinner tab.
    const bTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /working task/.test(t.textContent));
    assert.ok(bTab.querySelector(".card-tab-spin"), "the running run's tab shows a spinner");

    // × on A's tab dismisses A only → one tab left, no strip (single run), B still shown.
    const aTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /done task/.test(t.textContent));
    pointerDown(w.window, aTab.querySelector(".card-tab-x"));
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-tabs"), "dismissing down to one run drops the tab strip");
    // With only one run left, B (working) reverts to the bare orb (single-run look) — still shown, not hidden.
    assert.ok(w.window.document.querySelector(".card-orb"), "the remaining working run shows as an orb");
});

test("card concurrency: the expanded head NAMES the selected run (its title), not a generic 'Task complete'", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(cStart("A", "count the sales rows", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "summarise the reviews", 1200));
    await w.dispatch(cResult("B", "Answer B.", 1300));
    await w.flush();

    // Multi-run detail: the head is the SELECTED run's title (B, latest), not "Task complete".
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /summarise the reviews/);
    assert.doesNotMatch(w.window.document.querySelector(".card-head-txt").textContent, /Task complete/);
    // The tab carries the full title as a hover tooltip (native title=), so a shrunk tab is still identifiable.
    const aTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /count the sales/.test(t.textContent));
    assert.match(aTab.getAttribute("title") || "", /count the sales rows/, "the tab's full title is the hover tooltip");
    // Switch to A → the head renames to A's title.
    aTab.click(); await w.flush();
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /count the sales rows/);
});

test("card concurrency: collapsing a multi-run card shows a calm SUMMARY (count badge, no tabs, no per-run title)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    for (const [h, t, a] of [["A", "task A", 1000], ["B", "task B", 1200], ["C", "task C", 1400]]) {
        await w.dispatch(cStart(h, t, a));
        await w.dispatch(cResult(h, `Answer ${h}.`, a + 100));
    }
    await w.flush();

    // Collapse via the ▾ header button → the calm summary.
    w.window.document.querySelector(".card-head .card-icon").click(); await w.flush();
    assert.ok(w.window.document.querySelector(".card-toast.summary"), "collapsed to the summary toast");
    assert.match(w.window.document.querySelector(".card-toast-head").textContent, /All tasks complete/, "generic status, all done");
    assert.equal(w.window.document.querySelector(".card-count").textContent, "3", "count badge = number of runs");
    assert.ok(!w.window.document.querySelector(".card-tabs"), "the summary has NO tab strip");
    assert.ok(!w.window.document.querySelector(".card-toast-sub"), "no per-run title subtitle in the summary");
    assert.ok(!w.window.document.querySelector(".card-answer"), "no per-run answer in the summary");

    // Clicking the summary re-expands to the tabbed detail with the selected run's answer.
    w.window.document.querySelector(".card-toast.summary").click(); await w.flush();
    assert.ok(w.window.document.querySelector(".card-tabs"), "clicking the summary reopens the tabbed detail");
    assert.ok(w.window.document.querySelector(".card-answer"), "…with the selected run's answer");
});

test("card concurrency: the summary reads 'Some tasks complete' while one run is still working", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));   // done
    await w.dispatch(cStart("B", "task B", 1200));
    await w.dispatch(cStep("B", 1, 1210, { thought: "still working…" }));   // running
    await w.flush();

    // B (working) is the selected detail; collapse to the summary.
    w.window.document.querySelector(".card-head .card-icon").click(); await w.flush();
    assert.match(w.window.document.querySelector(".card-toast-head").textContent, /Some tasks complete/, "1 of 2 done → 'Some tasks complete'");
    assert.equal(w.window.document.querySelector(".card-count").textContent, "2");
});

test("card concurrency: several runs merely WORKING stay a single orb — it narrates the last op across runs", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // progress HUD → live caption
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // Two runs, both only working (no approval, no answer) → no card content to reach → keep the bare orb.
    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cStep("A", 1, 1010, { thought: "run A: reading the header…" }));
    await w.dispatch(cStart("B", "task B", 1100));
    await w.dispatch(cStep("B", 1, 1110, { thought: "run B: scanning the table…" }));
    await w.flush();

    assert.ok(!w.window.document.querySelector(".card-tabs"), "no tab strip while every run is merely working");
    const label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label && /run B: scanning the table/.test(label.textContent), "the orb narrates the most recent op (run B)");

    // Run A then does the newer op → the SAME single orb now narrates A (last op across runs).
    await w.dispatch(cStep("A", 2, 1200, { thought: "run A: clicking submit…" }));
    await w.flush();
    const label2 = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label2 && /run A: clicking submit/.test(label2.textContent), "the orb follows the latest op across runs");
    assert.ok(!w.window.document.querySelector(".card-tabs"), "still one orb, no tabs");
});

// --- the corner card's live chrome: the orb, its caption and the corner menu -----------------------------

test("HUD card: a streaming answer renders as CLEAN text — no DevTools activity line or model chip", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    await w.dispatch(agentStart("cs", "how many servers?", "m", 20, streamConfig({ stream: true })));
    // The answer streams in (liveStream.content) → the card expands to show it live.
    await w.dispatch({ kind: "agent-stream", id: "cs", ts: Date.now(), save: false, session: { hash: "cs", turn: 1 }, step: 1, localStep: 1, content: "Fourteen servers, one on http." });
    await w.flush();
    const body = w.shadow.querySelector(".card-body");
    const answer = body.querySelector(".card-answer.md");
    assert.ok(answer, "the streaming answer is a clean markdown block (like the finished answer)");
    assert.match(answer.textContent, /Fourteen servers/, "the streamed content shows");
    assert.equal(body.querySelector(".card-working"), null, "no 'Running JavaScript…' activity line in the HUD");
    assert.equal(body.querySelector(".model-name"), null, "no model chip (that's DevTools/sidebar chrome)");
});

test("HUD card: a streaming follow-up collapses an open 'Show work' and keeps it ABOVE the answer (no reflow spam)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    // A finished run WITH work, and its answer.
    await w.dispatch(agentStart("fu", "read the config", "m", 20, streamConfig({ stream: true })));
    await w.dispatch(agentStep("fu", 1, { seq: 1, tool: "exec", arguments: { js: "1" }, result: "1", approval: "readonly" }));
    await w.dispatch(agentResult("fu", "It lists 14 servers.", 1));
    await w.tick();
    // Expand "Show work" on the finished answer (the state the user leaves it in).
    const toggle = w.shadow.querySelector(".card-work-toggle");
    assert.ok(toggle, "the finished card shows a Show-work toggle");
    toggle.click(); await w.tick();
    assert.match(w.shadow.querySelector(".card-work-toggle").textContent, /Hide work/, "it's expanded before the follow-up");
    // Now a follow-up streams in (say → the answer streams via agent-stream content).
    await w.dispatch(agentSay("fu", "and which use http?", undefined, Date.now() + 5));
    await w.dispatch({ kind: "agent-stream", id: "fu", ts: Date.now() + 6, save: false, session: { hash: "fu", turn: 2 }, step: 2, localStep: 2, content: "Only one uses http." });
    await w.flush();
    // The open trace is COLLAPSED so it doesn't loom over / reflow with the streaming answer.
    assert.match(w.shadow.querySelector(".card-work-toggle").textContent, /Show work/, "Show work collapses when the follow-up starts streaming");
    // The streaming answer renders as CLEAN markdown text — like the finished answer. NO "Running JavaScript…"
    // activity line and NO DevTools model-chip / reply-bubble chrome (those don't belong in the HUD).
    const body = w.shadow.querySelector(".card-body");
    const answer = body.querySelector(".card-answer.md");
    assert.ok(answer, "the streaming answer renders as a clean markdown block");
    assert.match(answer.textContent, /Only one uses http/, "the streamed content is shown");
    assert.equal(body.querySelector(".card-working"), null, "no 'Running JavaScript…' activity line during answer streaming");
    assert.equal(body.querySelector(".model-name"), null, "no DevTools model chip (CopyModel) in the HUD");
    // And the trace stays ABOVE the streaming answer (same order as the done state) — no bottom↔top jump.
    const work = body.querySelector(".card-work");
    assert.ok(work && (work.compareDocumentPosition(answer) & w.window.Node.DOCUMENT_POSITION_FOLLOWING), "Show work stays ABOVE the streaming answer");
});

test("HUD 'Show work' blocks: a mid-run STEER doesn't shift a follow-up message into the previous block", async () => {
    // `run.says` is overloaded — a new-turn follow-up (a continuation, NO sayId) AND a mid-run steer (HAS a
    // sayId). buildRunBlocks used to index says[i-1] by answer, so a steer shifted every later message: the
    // steer became a block's prompt and the real follow-up (the LATEST message) vanished. Continuations must
    // index the prompts; steers render inline in the block they were sent in.
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    const H = "steerblk";
    let t = Date.now();
    await w.dispatch(agentStart(H, "task one", "m", 20));
    await w.dispatch(agentStep(H, 1, { tool: "exec", arguments: { js: "1" }, result: "r1" }));
    await w.dispatch(agentResult(H, "answer one", 1));
    await w.dispatch(agentSay(H, "question two", undefined, ++t));       // continuation (new turn), no sayId
    await w.dispatch(agentStep(H, 2, { tool: "exec", arguments: { js: "2" }, result: "r2" }));
    await w.dispatch(agentSay(H, "STEERED note", "steer1", ++t));        // MID-RUN steer, has a sayId
    await w.dispatch(agentStep(H, 3, { tool: "exec", arguments: { js: "3" }, result: "r3" }));
    await w.dispatch(agentResult(H, "answer two", 3));
    await w.dispatch(agentSay(H, "question three", undefined, ++t));     // the LATEST follow-up (was getting lost)
    await w.dispatch(agentStep(H, 4, { tool: "exec", arguments: { js: "4" }, result: "r4" }));
    await w.dispatch(agentResult(H, "answer three", 4));
    await w.tick();
    w.shadow.querySelector(".card-work-toggle").click(); await w.tick();   // open Show work
    const heads = [...w.shadow.querySelectorAll(".run-block-sum")].map(s => s.textContent);
    assert.equal(heads.length, 3, "three blocks (task + two follow-ups)");
    // No utility model in the test → the block header falls back to the prompt text.
    assert.match(heads[1], /question two/, "block 2's prompt is the continuation Q2");
    assert.match(heads[2], /question three/, "block 3's prompt is Q3 — the latest message is NOT lost / shifted");
    assert.ok(!heads.some(h => /STEERED note/.test(h)), "the steer is NOT promoted to a block prompt");
    // Expand block 2 (Q2's turn) — the steer sent during it renders INLINE there, and Q3 is NOT swallowed in.
    const blocks = [...w.shadow.querySelectorAll(".run-block")];
    blocks[1].querySelector(".run-block-head").click(); await w.tick();
    const b1 = blocks[1].textContent;
    assert.match(b1, /STEERED note/, "the mid-run steer renders inline in the block it was sent in");
    assert.doesNotMatch(b1, /question three/, "the latest follow-up did NOT get injected into the previous block");
});

test("HUD activity: a pending fetch_url shows the fetch activity (globe), not the ⚙️ generic default", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("fua", "get the servers list"));
    await w.dispatch(agentStep("fua", 1, { seq: 1, pending: true, tool: "fetch_url", arguments: { url: "https://x.test/a.json" } }));
    await w.flush();
    const txt = w.shadow.querySelector("body").textContent;
    assert.ok(txt.includes("🌐"), "the fetch (globe) activity icon shows in the HUD");
    assert.ok(!txt.includes("⚙️"), "and NOT the generic ⚙️ 'Running fetch_url' fallback");
});

test("card corner menu: the request carries the run hash + live flag (for Copy id / Cancel)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cancelme";
    await w.dispatch(agentStart(hash, "do a thing", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));
    await w.flush();

    // While RUNNING → live:true (Cancel is offered), and the hash rides along for Copy run id.
    w.window.document.querySelector(".card-orb").dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    const live = posted.filter(m => m.__mlSidebarCornerMenu).pop();
    assert.equal(live.__mlSidebarCornerMenu.hash, hash, "carries the run hash");
    assert.equal(live.__mlSidebarCornerMenu.live, true, "a running run is cancellable");

    // Once it finishes → live:false (nothing to cancel), hash still present.
    await w.dispatch(agentResult(hash, "done", 1));
    await w.flush();
    w.window.document.querySelector(".card-head").dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    const done = posted.filter(m => m.__mlSidebarCornerMenu).pop();
    assert.equal(done.__mlSidebarCornerMenu.live, false, "a finished run is not cancellable");
    assert.equal(done.__mlSidebarCornerMenu.hash, hash, "still carries the hash (Copy run id)");

    // With the menu open, the NEXT pointerdown inside the card asks the shell to dismiss it — the shell's
    // own outside-click handler can't see an in-iframe click (and the page window is already blurred).
    posted.length = 0;
    w.window.dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarCornerMenuDismiss), "an in-card click dismisses the open menu");
});

// THE RUN-STATS BAR IS CUMULATIVE SPEND, across every turn of a session — unlike the gauge beside it, which
// is the LATEST call's occupancy on purpose (each call re-sends the whole history, so summing occupancy would
// count the same prefix once per turn). Reported as stopping at the first turn's figures on a follow-up.
test("run stats: a follow-up turn's spend is added, not replaced", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "overlay" }, models: ["m"] });
    await w.dispatch(agentStart("agf", "do a thing", "m"));
    await w.dispatch(agentStep("agf", 0, { thought: "one", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }));
    await w.dispatch(agentResult("agf", "done", 1));
    // …then a FOLLOW-UP on the same session, which is a second turn with its own steps and its own spend.
    await w.dispatch(agentStep("agf", 0, { thought: "two", usage: { promptTokens: 400, completionTokens: 60, totalTokens: 460 } }));
    await w.dispatch(agentResult("agf", "done again", 2));
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    const bar = w.shadow.querySelector(".run-stats");
    assert.ok(bar, "the bar renders");
    const txt = bar.textContent.replace(/\s+/g, " ");
    // BOTH turns are billed: 100+400 in, 20+60 out. Showing the latest call's figures would read 400/60 —
    // which is what the gauge shows, and the whole reason these are two different readings.
    assert.match(txt, /500 in/, `cumulative prompt spend: ${txt}`);
    assert.match(txt, /80 out/, `cumulative completion spend: ${txt}`);
});

// The HUD orb's live liveness readout (sidebar/orb-status.ts, wired into hud-card). STREAMING gets the rich
// detail (a ticking token count); NON-STREAMING can't know tokens mid-generation, so it degrades to the
// humanized phase + a stall heartbeat. Both must reach the rendered orb caption. (Pure-fn coverage lives in
// tests/orb-status.test.mjs; these prove the wiring renders.)
test("HUD orb (streaming): the thinking phase carries a LIVE token count in the orb caption", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("orbtok", "compute stats", "m", 20, streamConfig({ stream: true })));
    // A long reasoning stream (no reply content yet) → the calm thinking orb, decorated with a ticking count.
    await w.dispatch({ kind: "agent-stream", id: "orbtok", ts: Date.now(), save: false, session: { hash: "orbtok", turn: 1 }, step: 1, localStep: 1, reasoning: "z".repeat(4800) });
    await w.flush();
    const label = w.shadow.querySelector(".card-orb-label");
    assert.ok(label, "the streaming orb auto-expands to a caption (there's live detail to show)");
    // The count is its OWN span, not part of the label: the pill ellipsizes on width, and concatenated it
    // was the number that got cut — the one part of the pill still saying something.
    assert.doesNotMatch(label.textContent, /tok/, "the label is the phase, and it is what may be truncated");
    assert.match(w.shadow.querySelector(".card-orb-live").textContent, /~1\.2k tok/, "the live count rides beside it");
});

test("HUD orb (non-streaming): a STALLED run shows an elapsed heartbeat + phase, and NO token count", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("orbstall", "survey", "m", 20, streamConfig()));   // stream OFF
    // A pending tool whose last activity was 8s ago, with nothing streaming — the "did the glue break?" case.
    await w.dispatch({ ...agentStep("orbstall", 1, { seq: 1, pending: true, tool: "look", arguments: {} }), ts: Date.now() - 8000 });
    await w.flush();
    const label = w.shadow.querySelector(".card-orb-label");
    assert.ok(label, "the stalled orb auto-expands so the liveness readout is visible");
    assert.match(label.textContent, /^Viewing the screen…$/, "the phase");
    // The elapsed readout is what proves the pipe is alive, so it sits where truncation cannot reach it —
    // a cut "· 1…" is the liveness proof saying nothing at the moment you most need it.
    const live = w.shadow.querySelector(".card-orb-live");
    assert.match(live.textContent, /· \d+s/, "the elapsed heartbeat");
    assert.doesNotMatch(live.textContent, /tok/, "non-streaming has no live token count (can't know mid-generation)");
});
