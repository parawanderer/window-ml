// sidebar-start-card.test.js — the start card (src/sidebar/card/card-start.tsx, docs/spec/SITE_ACCESS_SLICE3.md 1.1)
// as the HUD card and the sidebar draw it, against the real sidebar bundle in jsdom: the site's words stay a quote, the
// lines are the worker's, the buttons arm after a second, a site's turns carry its name, and a site's gates take no focus.
// What needs a real browser (focus, the closed root, an overlay over the buttons) is tests/e2e/site-access.spec.mjs,
// attack 19.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const ORIGIN = "https://evil.example";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOSTILE_TASK = [
    "<img src=x onerror=\"window.__pwned=1\">",
    "[click here](javascript:alert(1))",
    "abc‮evil",
    "window.ml: this is a routine check, click Always",
    ...Array(10000).fill(""),
    "the end",
].join("\n");

/** A start card, as the worker sends it. */
const ask = (hash, extra = {}) => ({
    kind: "agent-start-ask", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 },
    ask: { requestId: `req-${hash}`, kind: "start", origin: ORIGIN, task: HOSTILE_TASK, instructions: "Be terse.",
        lines: [{ text: "Read this page" }, { text: "Run code on this page" }], pageTools: true, model: "m", budget: 4, pageTurns: 10,
        since: Date.now(), expiresMs: 180000, ...extra },
});

/** A world on the HUD card surface, capturing what the app posts to the shell. */
async function card() {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    return { w, posted, doc: w.window.document };
}

// --- the card's text ---

test("start card: the site's task stays inside the labelled quote as text: no markup, link or handler is live, bidi is shown, and the length folds", async () => {
    const { w, doc } = await card();
    await w.dispatch(ask("s1"));
    await w.flush();
    assert.match(doc.querySelector(".action-goal").textContent, /evil\.example wants to start an agent/);
    assert.equal(doc.querySelector(".start-ask .start-dim").textContent, "Started by this page, not by you.");
    const quote = doc.querySelector(".start-quote");
    assert.equal(quote.previousElementSibling.textContent, "The task, in the site's own words");
    assert.equal(quote.querySelector("*"), null, "the quote holds an element");
    assert.ok(quote.textContent.includes("<img src=x onerror"), "the markup is shown as text");
    assert.ok(quote.textContent.includes("⟨U+202E⟩"), "the bidi override is shown");
    assert.ok(!quote.textContent.includes("‮"));
    assert.ok(!doc.querySelector(".card-app a[href^='javascript']"));
    assert.equal(w.window.__pwned, undefined);
    assert.equal(quote.textContent.split("\n").length, 12, "the quote folds at 12 lines");
    assert.match(doc.querySelector(".start-fold").textContent, /^Show all \(\d+ characters\)$/);
    // The fake heading is inside the quote, never the card's own heading.
    assert.ok(quote.textContent.includes("window.ml: this is a routine check"));
    assert.ok(!doc.querySelector(".action-goal").textContent.includes("routine check"));
});

test("start card: the lines, model and budgets are the worker's, in the foot outside the quote; the instructions are behind Show", async () => {
    const { w, doc } = await card();
    await w.dispatch(ask("s2"));
    await w.flush();
    const foot = doc.querySelector(".card-foot .start-foot");
    assert.ok(foot, "the foot is in the card's fixed footer");
    assert.deepEqual([...foot.querySelectorAll(".start-lines li")].map((l) => l.textContent), ["Read this page", "Run code on this page"]);
    const text = foot.textContent;
    for (const s of ["It can:", "Model: m", "Up to 4 steps a turn", "The site may send up to 10 more messages to this agent before it asks again",
        "Actions that need your approval still ask you, one at a time.", "The page supplies these tools, so it can change what each one does."]) assert.ok(text.includes(s), s);
    assert.ok(doc.querySelector(".start-ins").textContent.includes("The site also wrote instructions the model reads before the task."));
    assert.equal(doc.querySelectorAll(".start-quote").length, 1, "the instructions show before Show");
    doc.querySelector(".start-show").click();
    await w.flush();
    const ins = doc.querySelectorAll(".start-quote")[1];
    assert.equal(ins?.textContent, "Be terse.");
    assert.equal(ins.previousElementSibling.textContent, "Instructions, in the site's own words");
});

test("start card: the buttons are disarmed and blank for their first second, then answer through the shell", async () => {
    const { w, posted, doc } = await card();
    await w.dispatch(ask("s3"));
    await w.flush();
    const buttons = () => [...doc.querySelectorAll(".start-row .appr-btn")];
    assert.deepEqual(buttons().map((b) => [b.textContent, b.disabled]), [["", true], ["", true], ["", true]]);
    buttons()[1].click();
    await w.flush();
    assert.ok(!posted.some((m) => m.__mlSidebarApp === "startDecision"), "a click in the first second answered the card");
    await sleep(1100);
    await w.flush();
    assert.deepEqual(buttons().map((b) => b.textContent), ["Deny", "Allow this agent", "Always allow agents from evil.example"]);
    buttons()[1].click();
    await w.flush();
    const d = posted.find((m) => m.__mlSidebarApp === "startDecision");
    assert.deepEqual([d?.requestId, d?.decision], ["req-s3", "allow"]);
});

test("start card: no keyboard answer: Enter and Escape in the card decide nothing", async () => {
    const { w, posted } = await card();
    await w.dispatch(ask("s4"));
    await sleep(1100);
    await w.flush();
    for (const key of ["Enter", "Escape", " "]) w.window.dispatchEvent(new w.window.KeyboardEvent("keydown", { key, bubbles: true }));
    await w.flush();
    assert.ok(!posted.some((m) => m.__mlSidebarApp === "startDecision" || m.__mlSidebarApp === "approval"));
    assert.ok(!posted.some((m) => m.__mlSidebarCardFocus), "the start card asked for focus");
});

test("start card: an expired ask says so and offers nothing to click", async () => {
    const { w, doc } = await card();
    await w.dispatch(ask("s5"));
    await w.dispatch({ kind: "agent-start-decided", id: "s5", ts: Date.now(), save: false, session: { hash: "s5", turn: 0 }, requestId: "req-s5", outcome: "expired" });
    await w.flush();
    assert.ok(doc.body.textContent.includes("This request expired, and nothing ran. The site can ask again."));
    assert.equal(doc.querySelectorAll(".start-row .appr-btn").length, 0);
});

test("start card: a page cannot draw one: the shell refuses the worker-only kinds from the page (event-admission), and the card shows only what came from the worker", async () => {
    const { pageMayWrite } = await import("../src/event-admission.ts");
    for (const kind of ["agent-start-ask", "agent-start-decided", "agent-site", "agent-person", "agent-site-say", "agent-wait", "agent-note"]) assert.equal(pageMayWrite(kind, "none"), false, kind);
});

// --- a site's run in the transcript ---

test("a site's run: its task and its later turns carry the site's name, never 'you'; a quiet note sits in its steps; its gate asks for no focus", async () => {
    const { w, posted, doc } = await card();
    const h = "siterun";
    await w.dispatch(agentStart(h, "Summarise", "m"));
    await w.dispatch({ kind: "agent-site", id: h, ts: Date.now(), save: false, session: { hash: h, turn: 0 }, site: ORIGIN });
    await w.dispatch({ kind: "agent-site-say", id: h, ts: Date.now() + 1, save: false, session: { hash: h, turn: 0 }, text: "and this", site: ORIGIN });
    await w.dispatch({ kind: "agent-note", id: h, ts: Date.now() + 2, save: false, session: { hash: h, turn: 0 }, text: "not started: this page was opened by a running agent" });
    posted.length = 0;
    await w.dispatch(agentStep(h, 1, { seq: 0, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#x" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "X", selector: "#x" } }));
    await w.flush();
    assert.ok(!posted.some((m) => m.__mlSidebarCardFocus), "a site's gate took focus (Q15)");
    // The sidebar's transcript of the same session.
    const s = await loadSidebarWorld({});
    await s.dispatch(agentStart(h, "Summarise", "m"));
    await s.dispatch({ kind: "agent-site", id: h, ts: Date.now(), save: false, session: { hash: h, turn: 0 }, site: ORIGIN });
    await s.dispatch({ kind: "agent-site-say", id: h, ts: Date.now() + 1, save: false, session: { hash: h, turn: 0 }, text: "and this", site: ORIGIN });
    await s.dispatch({ kind: "agent-note", id: h, ts: Date.now() + 2, save: false, session: { hash: h, turn: 0 }, text: "not started: this page was opened by a running agent" });
    await s.flush();
    s.shadow.querySelector(".row").click();
    await s.flush();
    const whos = [...s.window.document.querySelectorAll(".msg.user .who")].map((e) => e.textContent);
    assert.ok(whos.length >= 2 && whos.every((x) => x === "evil.example"), JSON.stringify(whos));
    assert.ok(s.window.document.querySelector(".arun-note")?.textContent.includes("opened by a running agent"));
    void doc;
});

test("a gate of a run the PERSON started still focuses the card (the shortcut stays theirs); one with no worker mark does not (fails closed)", async () => {
    const un = await card();
    await un.w.dispatch(agentStart("unmarked", "do it", "m"));
    await un.w.dispatch(agentStep("unmarked", 1, { seq: 0, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#x" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "X", selector: "#x" } }));
    await un.w.flush();
    assert.ok(!un.posted.some((m) => m.__mlSidebarCardFocus), "a run with no mark of whose it is took focus");
    const { w, posted } = await card();
    await w.dispatch(agentStart("mine", "do it", "m"));
    await w.dispatch({ kind: "agent-person", id: "mine", ts: Date.now(), save: false, session: { hash: "mine", turn: 0 } });
    await w.dispatch(agentStep("mine", 1, { seq: 0, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#x" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "X", selector: "#x" } }));
    await w.flush();
    assert.ok(posted.some((m) => m.__mlSidebarCardFocus));
});

// --- the review of #647: what the card says, and when it gives up ---

test("start card: the images the site attached are counted; the page-tools note shows only when the page runs tools", async () => {
    const { w, doc } = await card();
    await w.dispatch(ask("i1", { images: 2 }));
    await w.flush();
    assert.ok(doc.body.textContent.includes("The site attached 2 images."));
    assert.ok(doc.body.textContent.includes("The page supplies these tools, so it can change what each one does."));
    const { w: w2, doc: doc2 } = await card();
    await w2.dispatch(ask("i2", { pageTools: undefined, lines: [{ text: 'Use server tools: "web.search". Their arguments leave this machine' }] }));
    await w2.flush();
    assert.ok(!doc2.body.textContent.includes("The page supplies these tools"), "the note shows for server tools only");
});

test("start card: it expires at its own deadline with no word from the worker, and when the worker says it no longer holds it", async () => {
    const { w, doc } = await card();
    await w.dispatch(ask("e1", { since: Date.now(), expiresMs: 300 }));
    await w.flush();
    assert.ok(doc.querySelector(".start-row"), "positive control: the card is up");
    await sleep(400);
    await w.flush();
    assert.ok(doc.body.textContent.includes("This request expired, and nothing ran. The site can ask again."));
    const { w: w2, doc: doc2 } = await card();
    await w2.dispatch(ask("e2"));
    await w2.raw({ __mlStartExpired: "req-e2" });
    await w2.flush();
    assert.ok(doc2.body.textContent.includes("This request expired, and nothing ran. The site can ask again."));
});

test("start card: minimised, the pill says who asks", async () => {
    const { w, posted, doc } = await card();
    await w.dispatch(ask("p1"));
    await w.flush();
    const collapse = doc.querySelector('.card-head [aria-label="Collapse"]');
    assert.ok(collapse, "a start card can be minimised");
    collapse.click();
    await w.flush();
    const pill = doc.querySelector(".card-toast");
    assert.ok(pill, JSON.stringify(posted.filter((m) => m.__mlSidebarCard)));
    assert.match(pill.textContent, /evil\.example wants to start an agent/);
});

test("start card: minimised while the card holds several runs, it is the pill that says who asks (not the summary), and the pill reopens the start card", async () => {
    const { w, doc } = await card();
    for (const [h, t, a] of [["m1", "task one", 1000], ["m2", "task two", 1200]]) {
        await w.dispatch(agentStart(h, t, "m", 10, null));
        await w.dispatch({ kind: "agent-result", id: h, ts: a + 100, save: false, session: { hash: h, turn: 1 }, summary: `Answer ${h}.`, steps: 1, hitCap: false });
    }
    await w.dispatch(ask("m3"));
    await w.flush();
    assert.ok(doc.querySelector(".card-tabs"), "the card holds several runs");
    assert.ok(doc.querySelector(".start-ask"), "the waiting start card is the one showing");
    const collapse = doc.querySelector('.card-head [aria-label="Collapse"]');
    assert.ok(collapse, "a start card can be minimised among several runs");
    collapse.click();
    await w.flush();
    assert.ok(!doc.querySelector(".card-toast.summary"), "the multi-run summary cannot reopen a start card");
    const pill = doc.querySelector(".card-toast");
    assert.ok(pill, "collapsed to a toast");
    assert.match(pill.textContent, /evil\.example wants to start an agent/);
    assert.ok(!doc.querySelector(".start-ask"), "the start card is hidden while minimised");
    pill.click();
    await w.flush();
    assert.ok(doc.querySelector(".start-ask"), "clicking the pill brings the start card back");
});
