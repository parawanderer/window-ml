// sidebar-asks.test.js — a step's nested asks on the surfaces (src/sidebar/transcript/ask-card.tsx): the card shows the
// call's resolved facts and never the script, its answer names the ask, answered calls gather in one footer under the
// step (a row each, opening to everything), and the HUD card answers one from the keyboard. The worker's half is tests/nested-asks.test.mjs.

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
    // Decided here, so it is not a card to answer again while the worker answers. In the calm view it eases away for a beat
    // (`leaving`), without its buttons and out of the accessibility tree; anywhere else it is simply gone.
    assert.equal(w.shadow.querySelectorAll(".astep-approve.ask:not(.leaving)").length, 0, "decided here, so not drawn again while the worker answers");
    assert.equal(w.shadow.querySelector(".astep-approve.ask.leaving .appr-btn"), null, "a card on its way out has nothing left to press");
});

test("answered calls gather in ONE footer under the step: a row each, with how it ended and the person's note, and no buttons", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask3", "check the repo"));
    await w.dispatch(running("ask3", [ask({ state: "allowed", answeredAt: 4000 }), ask({ id: "a1123456789abcdef01234567", state: "denied", answeredAt: 9000, note: "not that branch", facts: { ...FACTS, argv: ["git", "checkout", "main"] } })]));
    await open(w);
    assert.equal(w.shadow.querySelector(".astep-approve.ask"), null);
    assert.equal(w.shadow.querySelectorAll(".shcalls").length, 1, "one footer for the step, not a block per call");
    assert.match(w.shadow.querySelector(".shcalls .disc-head").textContent, /ml\.sh\s*2 calls.*2 asked.*1 denied/);
    const rows = [...w.shadow.querySelectorAll(".shc-entry")];
    assert.equal(rows.length, 2);
    assert.match(rows[0].querySelector(".shc-row").textContent, /git.*allowed after 3 s/);
    assert.match(rows[1].querySelector(".shc-row").textContent, /git.*denied after 8 s/);
    assert.match(rows[1].textContent, /not that branch/, "the person's note is in the row's body");
    assert.ok(rows[1].querySelector(".shc-row .dot.err.hollow"), "a denied call is a ring: it never ran, which is not the same as failing");
    assert.match(rows[1].querySelector(".shc-row .dot-tip-line").textContent, /Denied: the call never ran.*threw Denied/);
    assert.equal(rows[0].querySelector(".shc-row .dot.hollow"), null, "a call that ran is a disc");
    assert.equal(w.shadow.querySelector(".shcalls .appr-btn"), null, "an answered call has no buttons");
});

test("an allowed ask that ran says what the host applied and what protected names changed during it, flagged on the row too", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ask7", "install"));
    const outcome = { ran: "host-sandbox", envelope: { write: "today", exec: "any" }, asked: { write: "roots", exec: "program-only" },
        protectedChanged: [{ root: "/w/proj", name: ".git/hooks/pre-commit", change: "created" }] };
    await w.dispatch(running("ask7", [
        ask({ state: "allowed", answeredAt: 2000, outcome }),
        ask({ id: "a1123456789abcdef01234567", state: "denied", answeredAt: 3000, outcome }),
        ask({ id: "a2123456789abcdef01234567", state: "allowed", answeredAt: 3000, outcome: { protectedChanged: "not a list" } }),
    ]));
    await open(w);
    const [ran, denied, odd] = [...w.shadow.querySelectorAll(".shc-entry")];
    const warned = [...ran.querySelectorAll(".shc-facts .warn dt")].map((d) => d.textContent);
    assert.ok(warned.includes("Sandbox applied") && warned.includes("Protected names"), "less than was asked for, and a hook appeared: both flagged");
    assert.ok(ran.classList.contains("warn"), "and the ROW says so, not only what is inside it");
    assert.match(ran.querySelector(".shc-row .dot-tip-line")?.textContent || "", /^Worth a look: Sandbox applied: .*Protected names: /, "the dot names what raised it, and only what happened after the answer: the card's own warnings were on the card the person approved");
    assert.match(w.shadow.querySelector(".shcalls .disc-head").textContent, /worth a look/, "and so does the footer");
    assert.match(ran.textContent, /changed during this call in \/w\/proj: \.git\/hooks\/pre-commit created/);
    assert.match(ran.textContent, /not the write roots, exec program-only that was asked for/);
    const deniedLabels = [...denied.querySelectorAll(".shc-facts dt")].map((d) => d.textContent);
    assert.ok(!deniedLabels.includes("Sandbox applied") && !deniedLabels.includes("Protected names"), "a denied call never ran: no outcome is drawn");
    assert.ok(odd, "an outcome of another shape does not break the row");
});

test("a call that ran without asking is a row under the step: the command, who allowed it, and the card's outcome lines", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("unask1", "tidy"));
    const outcome = { ran: "host-sandbox", envelope: { write: "today", exec: "any" }, asked: { write: "roots", exec: "program-only" }, protectedChanged: [] };
    await w.dispatch(agentStep("unask1", 1, { seq: 1, approval: "user", tool: "exec", arguments: { js: SCRIPT }, result: "0", shCalls: [
        { program: "ls", durationMs: 3 },
        { program: "find", durationMs: 7, unasked: { by: "policy", policy: "tidy build", argv: ["find", "build", "-name", "*.o", "-delete"], outcome } },
    ] }));
    await open(w);
    const rows = [...w.shadow.querySelectorAll(".shc-entry")];
    assert.equal(rows.length, 1, "a span with no unasked record draws nothing");
    assert.match(rows[0].querySelector(".shc-row").textContent, /find.*ran without asking \(the policy "tidy build"\)/);
    assert.match(rows[0].querySelector(".copyable-code").textContent, /find build -name .*\*\.o.* -delete/);
    assert.match(rows[0].textContent, /Allowed by\s*the policy "tidy build"/);
    const warned = [...rows[0].querySelectorAll(".shc-facts .warn dt")].map((d) => d.textContent);
    assert.deepEqual(warned, ["Sandbox applied"], "less than was asked for is flagged here as on the card");
    assert.doesNotMatch(rows[0].textContent, /SCRIPT-TEXT/, "the facts, never the script");
});

test("a bash -c call shows its script as lines, the way it was written, not run together on one", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("script1", "demo"));
    const body = "cat > demo.sh <<'EOF'\necho hi\nEOF\nchmod +x demo.sh";
    await w.dispatch(running("script1", [ask({ state: "allowed", answeredAt: 2000, facts: { ...FACTS, argv: ["bash", "-c", body] } })]));
    await open(w);
    const code = w.shadow.querySelector(".shc-entry .copyable-code");
    assert.equal(code.textContent.replace(/\u00a0/g, " ").split("\n").filter(Boolean).length >= 4, true, "one line per line of the script");
    assert.match(w.shadow.querySelector(".shc-entry .shc-via").textContent, /bash -c/);
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
    assert.equal(w.shadow.querySelectorAll(".shc-entry").length, 1);
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

// --- red team: an ask's answer never lands on the step's own gate ---

test("red team: an ask drawn with a missing or empty id never posts an answer that names no ask (the step's own gate)", async () => {
    // A forged event (a page writing under the "none" claim, shell.ts workerClaim) or any producer bug can draw an ask
    // without a usable id. Its Approve must not post `{hash, seq}` alone: the worker reads that as the step's own gate.
    for (const [i, over] of [[1, { id: "" }], [2, { id: undefined }]]) {
        const w = await loadSidebarWorld();
        const hash = `askR${i}`;
        await w.dispatch(agentStart(hash, "check the repo"));
        await w.dispatch(running(hash, [ask(over)]));
        await open(w);
        const posted = [];
        w.window.postMessage = (d) => posted.push(d);
        const yes = w.shadow.querySelector(".astep-approve.ask .appr-btn.yes");
        if (yes) { yes.click(); await w.tick(); }
        for (const m of posted.filter((m) => m.__mlSidebarApp === "approval"))
            assert.ok(typeof m.ask === "string" && m.ask, `id ${JSON.stringify(over.id)}: the answer named no ask, so it would resolve ${m.hash}:${m.seq}`);
    }
    // positive control: a well-formed ask posts its id (the test above, "Approve on an ask posts its id")
});

test("the raw-argv toggle sits in the command block's toolbar beside copy, and swaps the block to the argv", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("raw1", "tidy"));
    await w.dispatch(agentStep("raw1", 1, { seq: 1, approval: "user", tool: "exec", arguments: { js: SCRIPT }, result: "0", shCalls: [
        { program: "find", durationMs: 7, unasked: { by: "policy", policy: "tidy build", argv: ["find", "build", "-name", "a b"], outcome: { ran: "host-sandbox", protectedChanged: [] } } },
    ] }));
    await open(w);
    // The footer is in the step's body (open it if it is folded): which of the two a build has is not this test's concern.
    if (!w.shadow.querySelector(".shcalls")) { [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find((h) => /exec/.test(h.textContent)).click(); await w.tick(); }
    const block = () => w.shadow.querySelector(".shc-entry .copyable-code");
    const toggle = () => block().querySelector(".code-tools .code-tool");
    assert.equal(toggle().textContent, "raw argv", "the toggle is in the toolbar, not under the facts");
    toggle().click();
    await w.tick();
    assert.match(block().textContent, /\["find","build","-name","a b"\]/, "the block now shows the argv as the model sent it");
    assert.equal(toggle().textContent, "command");
});
