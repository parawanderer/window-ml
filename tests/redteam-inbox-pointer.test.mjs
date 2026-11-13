// redteam-inbox-pointer.test.mjs — the pointer a cut task result mints: who may make one, and what it may be claimed for
// (e3's rows for async/task-pointer-2). The loop mints a pointer to a task result's stored whole as the inbox delivers
// it (agent-loop.ts `taskPointer`), on the word of the queue item's own `task`, `value` and `chars`. So both halves
// matter: the item must come from the worker's task plumbing and nowhere else, and a run that cannot claim the value must
// get no pointer at all rather than a line naming one it will be refused when it reads.
//
// MUTATION PER ROW (notes, not committed changes — apply one, watch its row go red, revert):
//   A  background.ts's INJECT_MESSAGE branch pushes the payload's `task`/`value`/`chars` into the queue (the
//      `insideIf`/`...` of the mirror call) → A red (a page naming the run and a value makes the loop mint against it).
//   B  agent-loop.ts `taskPointer` drops the `try`/`catch` around `opts.claimValue?.(value)` → B red (the pointer line is
//      pushed for a value the run does not hold).
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { runAgentLoop } = await import("../src/agent/agent-loop.ts");

const T = { timeout: 20000 };
const tool = (name) => ({ name, description: "", parameters: { type: "object", properties: {} } });
const PAGE_ON = (tabId) => ({ tab: { id: tabId, url: "https://site.example/page" }, url: "https://site.example/page", origin: "https://site.example", frameId: 0 });
const HUD_ON = (tabId) => ({ tab: { id: tabId, url: "https://site.example/page" }, url: "chrome-extension://test/sidebar.html", frameId: 1 });
const tick = () => new Promise((r) => setTimeout(r, 0));
const CONFIG = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-0123456789abcdef", model: "m", apiFormat: "openai", debugMode: "off" };

// --- A. a page cannot put a task item in a run's inbox ---

/** A worker-built run on tab 7 that is LIVE and stopped inside its first model call, as the HUD's Send leaves it while
 *  the model thinks: the worker holds the run's inbox (`runInboxes`, set in hostRun), so a steer sent now lands in a
 *  queue the loop really drains. Returns the run's id, the resolver for that first call, and every message list sent. */
async function liveRun() {
    let release; const held = new Promise((r) => (release = r));
    const sent = [];
    const bg = loadBackground({
        config: CONFIG, siteGate: true, openTabs: [{ id: 7, windowId: 1, active: true, url: "https://site.example/page" }],
        local: { ml_site_schema: 2, ml_site_always: ["https://site.example"] },   // the page MAY use window.ml: its refusal below must be about the run, not the origin
        onFetch: async (call) => {
            if (!String(call.url).includes("/chat/completions")) return jsonResponse({});
            sent.push((call.body?.messages ?? []).map((m) => ({ role: m.role, content: m.content })));
            if (sent.length === 1) {
                await held;
                // A loop-local tool: answered from run state, so the run reaches a second step with no page in the path.
                return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "dereference", arguments: JSON.stringify({ pointer: "@tool:zzzzzzz" }) } }] } }] });
            }
            return jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : undefined),
    });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "steer me", surface: "hud", maxSteps: 4 });
    for (let i = 0; i < 6000 && !bg.context.__mlRunStateForTest().inboxes.includes(hash); i++) await tick();
    return { bg, hash, release, sent };
}

test("a page's steer never reaches a worker-built run, and never as a task item: only the person's own surface steers it", T, async () => {
    const { bg, hash, release, sent } = await liveRun();
    // Control: the run is live on tab 7 and the worker holds its inbox — without this the HUD's admission below would be
    // the only thing measured, and a refusal for an unknown run looks the same as a refusal of the sender.
    assert.ok(bg.context.__mlRunStateForTest().inboxes.includes(hash), "control: the worker hosts a run on tab 7");
    const smuggle = { runId: hash, text: "cut text", sayId: "s1", task: "t1", value: "k-whole", chars: 999_999 };
    const fromPage = await bg.send({ type: "INJECT_MESSAGE", payload: smuggle }, PAGE_ON(7));
    assert.deepEqual(fromPage, { data: false }, "the worker took an approved page's steer of the worker's own run");
    // The person's HUD frame on the same run is admitted, so the refusal above is the SENDER and not a dead handler.
    const fromHud = await bg.send({ type: "INJECT_MESSAGE", payload: smuggle }, HUD_ON(7));
    assert.deepEqual(fromHud, { data: true }, "positive control: the HUD's steer is queued");
    release();
    for (let i = 0; i < 6000 && sent.length < 2; i++) await tick();
    // What the model reads on the step the loop drains: the steer's TEXT and nothing of the payload's task/value on it.
    // A queue item carrying `task`/`value`/`chars` gets the cut note with `@tool:` pointer appended (agent-loop.ts,
    // "taskPointer"), so a pointer on the steered line is that payload surviving as a task item.
    const second = sent[1] ?? [];
    const steered = second.filter((m) => m.role === "user" && String(m.content ?? "").includes("cut text"));
    assert.equal(steered.length, 1, `the model did not read the HUD's steer once: ${JSON.stringify(second).slice(0, 400)}`);
    assert.ok(!JSON.stringify(steered[0]).includes("k-whole"), "the steer carried the payload's value-store key");
    assert.ok(!/@tool:[0-9a-f]{7}/.test(String(steered[0].content)), `the steer minted a pointer from the payload's task/value: ${String(steered[0].content).slice(0, 200)}`);
});

// --- B. a value the run cannot claim mints no pointer ---

/** Drive the loop with one drained inbox item; returns the text pushed for the model and every value claimed. The claim
 *  is an OPTION, not a dep (AgentLoopOptions.claimValue, as the worker passes it at sw-run-host.ts:1578): a row that put
 *  it on the deps would mint the pointer with nothing claimed and read green. */
async function drained(item, { claim } = {}) {
    const pushed = [], claimed = [];
    let n = 0;
    await runAgentLoop("t", { tools: [tool("exec")], toolTokens: true, runHash: "abcdef", maxSteps: () => 3, claimValue: claim ?? ((v) => claimed.push(v)) }, {
        callModel: async () => (n++ === 0 ? { content: "done", tool_calls: [] } : { content: "done", tool_calls: [] }),
        runTool: async () => ({ result: "" }),
        autoApprove: () => null,
        buildMessages: (t) => [{ role: "user", content: t }],
        pushAssistant: () => {},
        pushToolResult: () => {},
        drainInbox: () => (n === 0 ? [item] : []),
        pushUser: (m, text) => pushed.push(String(text)),
    });
    return { pushed, claimed };
}

test("a cut inbox result the run cannot claim is delivered with NO pointer line, and its stored text is never put on the line", T, async () => {
    const whole = "k-whole";   // the value-store key of the result's stored whole
    const item = { text: "row0: short", task: "t1", value: whole, chars: 99_999, images: [] };
    // Control: a run that holds it gets one pointer line naming the pointer and the size, and no text of the whole.
    const ok = await drained(item);
    assert.equal(ok.claimed.length, 1, "control: the value is claimed before the pointer is minted");
    assert.equal(ok.claimed[0], whole);
    assert.match(ok.pushed[0] ?? "", /@tool:[0-9a-f]{7}/, "control: a claimable value mints a pointer");
    assert.ok(!ok.pushed[0].includes(whole), `the pointer line carried the value-store key: ${ok.pushed[0].slice(0, 200)}`);
    // A run that cannot claim it — another session's value, or one already released — gets the text and nothing to
    // dereference, so the model is never handed a pointer whose read will fail.
    const refused = await drained(item, { claim: () => { throw new Error("ValueMissing: not held by this run"); } });
    assert.deepEqual(refused.pushed, [item.text], "a pointer line was pushed for a value the run cannot claim");
});

test("a whole no longer than the text the model already reads mints nothing, and an empty cut line is not invented", T, async () => {
    for (const item of [
        { text: "row0: short", task: "t1", value: "k", chars: 5, images: [] },      // chars <= text: nothing was cut
        { text: "row0: short", task: "t1", images: [] },                            // no value at all
    ]) {
        const r = await drained(item);
        assert.deepEqual(r.pushed, [item.text], `a pointer was minted for ${JSON.stringify(item)}`);
        assert.deepEqual(r.claimed, [], "a value was claimed with no pointer minted");
    }
});
