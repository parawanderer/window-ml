// sidebar-prompt-display.test.js — a message whose model-facing text had a right-clicked element folded in, as the
// panel draws it: what the person TYPED with the element as a chip where attachments go, and a rendered/raw switch to
// the exact text the model got (PromptDisplay, src/contract/contract-run.ts). Covers the transcript bubble, the HUD's
// Show work, the session row, the Markdown export, and a session recorded before the display existed (the UPGRADE).

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const EL = { selector: "#price", role: "cell", text: "€4.20\nper kilo", anchorText: "€4.20", media: [], links: [] };
/** What askAboutTask makes of a question about EL: the text the model gets, and what older builds recorded alone. */
const framed = (q) => [
    "The user RIGHT-CLICKED an element on the page to ask about it. Its clean content is below.",
    "\n--- SELECTED CONTENT (role: cell; selector: #price) ---", EL.text, "--- END SELECTED CONTENT ---",
    "\nYou can act on this element directly with its selector `#price` (click/type/findByText, or ml.queryAll scoped to it) if you need more than the text above.",
    `\nUser's question: ${q}`,
].join("\n");
const display = (typed) => ({ typed, context: [{ kind: "element", element: EL }] });
const startWith = (hash, q, withDisplay = true) => ({ ...agentStart(hash, framed(q)), ...(withDisplay ? { display: display(q) } : {}) });
const sayWith = (hash, q) => ({ kind: "agent-say", id: hash, ts: Date.now() + 150, save: false, session: { hash, turn: 0 }, text: framed(q), display: display(q) });
const openRun = async (w) => { w.shadow.querySelector(".row").click(); await w.tick(); };
/** The first user bubble's text, and whether the element chip and the switch are drawn with it. */
const bubble = (w, i = 0) => {
    const msg = w.shadow.querySelectorAll(".msg.user")[i];
    const ctx = msg?.nextElementSibling?.classList.contains("sent-ctx") ? msg.nextElementSibling
        : msg?.nextElementSibling?.nextElementSibling?.classList?.contains("sent-ctx") ? msg.nextElementSibling.nextElementSibling : null;
    return { msg, text: msg?.querySelector(".utext")?.textContent ?? "", chip: ctx?.querySelector(".el-pill"), toggle: msg?.querySelector(".rr-toggle") };
};

// --- the transcript bubble ---

test("an ask-about task shows what was typed and the element as a chip; raw shows what the model got", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(startWith("ask1", "is this cheap?"));
    await openRun(w);
    let b = bubble(w);
    assert.equal(b.text, "is this cheap?");
    assert.ok(!w.shadow.body.textContent.includes("SELECTED CONTENT"), "none of the framing is drawn");
    assert.ok(b.chip, "the element is a chip where attachments go");
    assert.match(b.chip.textContent, /cell · "€4\.20"/);
    assert.ok(!b.chip.querySelector(".el-pill-x"), "a sent element cannot be removed");
    assert.ok(b.toggle, "the message has a rendered/raw switch");
    [...b.toggle.querySelectorAll("button")].find((x) => x.textContent === "raw").click();
    await w.tick();
    b = bubble(w);
    assert.match(b.text, /SELECTED CONTENT[\s\S]*€4\.20[\s\S]*User's question: is this cheap\?/, "raw is the model's text, whole");
    assert.equal(w.shadow.querySelectorAll(".sent-ctx").length, 0, "raw draws no chip: the element is in the text");
});

test("a follow-up with an element is drawn the same way as the task", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask2", "first"));
    await w.dispatch(agentResult("ask2", "ok", 0));
    await w.dispatch(sayWith("ask2", "and this?"));
    await openRun(w);
    assert.equal(bubble(w, 0).toggle, null, "a plain task has no switch: its text IS what was typed");
    const b = bubble(w, 1);
    assert.equal(b.text, "and this?");
    assert.ok(b.chip && b.toggle);
});

test("an element sent with no words: the bubble holds the switch and the chip, and the row names what was attached", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch({ ...agentStart("ask3", framed("Tell me about the selected content.")), display: display("") });
    assert.match(w.shadow.querySelector(".row").textContent, /About a selected cell/);
    await openRun(w);
    const b = bubble(w);
    assert.equal(b.text, "");
    assert.ok(b.chip && b.toggle);
});

test("the session row is titled by what was typed, not the framing", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(startWith("ask4", "is this cheap?"));
    const row = w.shadow.querySelector(".row").textContent;
    assert.match(row, /is this cheap\?/);
    assert.ok(!/RIGHT-CLICKED/.test(row));
});

// --- the UPGRADE: what older builds recorded ---

test("UPGRADE: a session recorded before the display existed shows its framed task as before, with no switch", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(startWith("old1", "is this cheap?", false));
    assert.match(w.shadow.querySelector(".row").textContent, /RIGHT-CLICKED/, "its title is what it always was");
    await openRun(w);
    const b = bubble(w);
    assert.match(b.text, /SELECTED CONTENT[\s\S]*User's question: is this cheap\?/);
    assert.equal(b.toggle, null);
    assert.equal(w.shadow.querySelectorAll(".sent-ctx").length, 0);
});

// --- the HUD card's Show work ---

test("HUD Show work: the task reads as typed with the chip, and opening it offers the raw text", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(startWith("card1", "is this cheap?"));
    await w.dispatch(agentStep("card1", 1, { seq: 1, tool: "findByText", arguments: { text: "€" }, result: "found €4.20" }));
    await w.dispatch(agentResult("card1", "yes", 1));
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".card-work-toggle").click();
    await w.tick();
    const you = doc.querySelector(".acard-you");
    assert.ok(you, "the task is in the trace");
    assert.match(you.querySelector(".astep-preview").textContent, /is this cheap\?/);
    assert.ok(!/SELECTED CONTENT/.test(you.textContent));
    assert.ok(you.querySelector(".sent-ctx .el-pill"), "the element chip");
    you.querySelector(".astep-head").click();
    await w.tick();
    [...you.querySelectorAll(".rr-toggle button")].find((x) => x.textContent === "raw").click();
    await w.tick();
    assert.match(doc.querySelector(".acard-you").textContent, /SELECTED CONTENT[\s\S]*User's question: is this cheap\?/);
});

// --- run.md ---

async function exportMarkdown(w) {
    let blob = null;
    w.window.URL.createObjectURL = (b) => { blob = b; return "blob:mock"; };
    w.window.URL.revokeObjectURL = () => {};
    w.window.HTMLAnchorElement.prototype.click = function () {};
    w.shadow.querySelector('[aria-label="Export log"]').click();
    await w.tick();
    [...w.shadow.querySelectorAll(".menu-item")].find((b) => b.textContent.startsWith("Markdown")).click();
    await w.tick();
    return blob.text();
}

test("run.md: the task and a follow-up show what was typed and the element, with the model's text in a raw disclosure", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(startWith("md1", "is this cheap?"));
    await w.dispatch(agentResult("md1", "yes", 0));
    await w.dispatch(sayWith("md1", "and this?"));
    await w.dispatch(agentResult("md1", "no", 0));
    await openRun(w);
    const md = await exportMarkdown(w);
    assert.match(md, /Task[^\n]*is this cheap\?/);
    assert.match(md, /Element[^\n]*cell `#price` · "€4\.20"/);
    assert.match(md, /Task · raw \(as the model got it\)[\s\S]*User's question: is this cheap\?/, "the task's model text is in the log");
    assert.match(md, /## User Asked\s+and this\?[\s\S]*Element: cell `#price`[\s\S]*raw \(as the model got it\)[\s\S]*User's question: and this\?/);
});
