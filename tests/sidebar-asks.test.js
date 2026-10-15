// sidebar-asks.test.js — a step's nested asks on the surfaces (src/sidebar/transcript/ask-card.tsx): the card shows the
// call's resolved facts and never the script, its answer names the ask, an answered ask is a line, and the HUD card
// answers one from the keyboard. The worker's half is tests/nested-asks.test.mjs.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const ID = "a0123456789abcdef01234567";
const SCRIPT = "const r = await ml.sh.run(['git', 'status']); return r.code // SCRIPT-TEXT";
const FACTS = {
    argv: ["git", "--no-pager", "status"], program: { path: "/usr/bin/git", inRoot: false }, cwd: { path: "/w/proj", inRoot: true },
    env: { set: [], free: true }, secrets: [], paths: [], repo: { root: "/w/proj", reasons: [] }, repoConfigRunsCode: false,
    effects: "unknown", described: false, why: ["the program's version was not reported"], runner: false, mode: "host", sandboxed: false, placement: "host-plain",
};
const ask = (over = {}) => ({ id: ID, kind: "sh", facts: FACTS, state: "pending", raisedAt: 1000, ...over });
/** A running exec step (its own gate already approved) carrying asks. */
const running = (hash, asks) => agentStep(hash, 1, { seq: 1, pending: true, awaitingApproval: false, approval: "user", tool: "exec", arguments: { js: SCRIPT }, asks });

// --- the card in the transcript ---

/** Open the session's transcript from the sessions list. */
async function open(w) {
    w.shadow.querySelector(".row").click();
    await w.tick();
}

test("a waiting ask is a card under its step that shows the call's facts, never the script, and flags what to look at twice", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask1", "check the repo"));
    await w.dispatch(running("ask1", [ask()]));
    await open(w);
    const card = w.shadow.querySelector(".astep-approve.ask");
    assert.ok(card, "the ask's card rendered, with the step collapsed");
    const text = card.textContent;
    assert.match(text, /wants to start a program/);
    assert.match(text, /git --no-pager status/);
    assert.match(text, /\/w\/proj/);
    assert.doesNotMatch(text, /SCRIPT-TEXT|ml\.sh\.run/, "the card shows what will run, not the script that computed it");
    const warned = [...card.querySelectorAll(".ask-facts .warn dt")].map((d) => d.textContent);
    assert.ok(warned.includes("Sandbox"), "an unsandboxed call is flagged");
    assert.ok(warned.includes("Does"), "unknown effects are flagged");
    assert.equal(card.querySelector(".appr-btn.remember"), null, "an ask has no Keep: widening is a policy, never a button");
    assert.match(w.shadow.querySelector(".astep-preview")?.textContent || "", /needs approval/, "the collapsed step says it is waiting");
});

test("Approve on an ask posts its id beside the step's seq, and the card goes at once", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask2", "check the repo"));
    await w.dispatch(running("ask2", [ask()]));
    await open(w);
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve.ask .appr-btn.yes").click();
    await w.tick();
    const msg = posted.find((m) => m.__mlSidebarApp === "approval");
    assert.deepEqual([msg.hash, msg.seq, msg.decision, msg.ask, msg.persist], ["ask2", 1, true, ID, false]);
    assert.equal(w.shadow.querySelector(".astep-approve.ask"), null, "decided here, so not drawn again while the worker answers");
});

test("an answered ask is one line under its step, with how it ended and the person's note, and no buttons", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask3", "check the repo"));
    await w.dispatch(running("ask3", [ask({ state: "allowed", answeredAt: 4000 }), ask({ id: "a1123456789abcdef01234567", state: "denied", answeredAt: 9000, note: "not that branch", facts: { ...FACTS, argv: ["git", "checkout", "main"] } })]));
    await open(w);
    assert.equal(w.shadow.querySelector(".astep-approve.ask"), null);
    const lines = [...w.shadow.querySelectorAll(".astep-ask-done")].map((l) => l.textContent);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /git --no-pager status.*allowed after 3 s/);
    assert.match(lines[1], /git checkout main.*denied after 8 s.*not that branch/);
});

test("an ask only the external channel answers is drawn without buttons", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask4", "check the repo"));
    await w.dispatch(running("ask4", [ask({ external: true })]));
    await open(w);
    const card = w.shadow.querySelector(".astep-approve.ask");
    assert.ok(card);
    assert.equal(card.querySelector(".appr-btn"), null);
    assert.match(card.textContent, /external approver/);
});

test("the step's later events keep its asks: its DONE does not wipe what it asked", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask5", "check the repo"));
    await w.dispatch(running("ask5", [ask({ state: "allowed", answeredAt: 2000 })]));
    await w.dispatch(agentStep("ask5", 1, { seq: 1, tool: "exec", arguments: { js: SCRIPT }, result: "0", approval: "user" }));
    await open(w);
    assert.equal(w.shadow.querySelectorAll(".astep-ask-done").length, 1);
});

test("an ask of a kind this build does not know is drawn as its facts, and still answerable", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask6", "check the repo"));
    await w.dispatch(running("ask6", [ask({ kind: "teleport", facts: { where: "the moon" } })]));
    await open(w);
    const card = w.shadow.querySelector(".astep-approve.ask");
    assert.match(card.textContent, /asks for teleport/);
    assert.match(card.textContent, /where.*the moon/);
    assert.ok(card.querySelector(".appr-btn.yes"));
});

// --- the HUD card ---

test("HUD card: a waiting ask takes the card, Enter allows it by its id, and Esc on the next denies", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("askH", "check the repo"));
    await w.dispatch(running("askH", [ask()]));
    await w.flush();
    assert.ok(w.shadow.querySelector(".card-body .astep-approve.ask"), "the ask's card is the HUD's body");
    assert.match(w.shadow.querySelector(".card-head")?.textContent || "", /Approval needed/);
    assert.equal(w.shadow.querySelector(".card-foot-appr"), null, "the step gate's footer is not drawn for an ask");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.window.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const msg = posted.find((m) => m.__mlSidebarApp === "approval");
    assert.deepEqual([msg.decision, msg.ask, msg.seq], [true, ID, 1]);
});
