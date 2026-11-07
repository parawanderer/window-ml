// task-say.test.mjs — a detached call's result as the run reads and shows it (docs/spec/ASYNC_CALLS.md, mode 1): the
// loop pushes it as a user-role message that no one typed, `ml.current.meta` names its task, only the worker can write
// its event (`agent-task-say`), and the transcript and both exports name the task as its speaker, never "you".

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./stub-css.mjs";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { pageMayWrite } from "../src/event-admission.ts";
import { SessionIndex } from "../src/session/session-index.ts";
const { serializeSession } = await import("../src/sidebar/export/export.ts");
const { sessionToJson } = await import("../src/sidebar/export/export-json.ts");
const require = createRequire(import.meta.url);
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const RESULT = "[task t1a2b3c done after 47 s: ml.sh exit 0, ok; stdout empty; stderr empty]";
const taskSay = (hash, over = {}) => ({ kind: "agent-task-say", id: hash, ts: Date.now() + 1, save: false, session: { hash, turn: 0 }, text: RESULT, task: "t1a2b3c", ...over });

// --- the loop: a task's result is a user-role message no one typed ---

test("a drained task result is a user message whose meta names the task, with no surface or client, and the latest sender stays the person's", async () => {
    let snap;
    const queued = [];
    const turns = [
        { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }] },
        { content: "", tool_calls: [{ id: "c2", name: "exec", arguments: { js: "2" } }] },
        { content: "done", tool_calls: [] },
    ];
    let i = 0, n = 0;
    await runAgentLoop("build it", { tools: [{ name: "exec" }], runHash: "h1", origin: { surface: "hud" }, contextSink: (f) => { snap = f; } }, {
        callModel: async () => turns[i++] || { content: "" },
        runTool: async () => { if (n++ === 0) queued.push({ text: RESULT, task: "t1a2b3c" }); else queued.push("and the tests?"); return { result: "ok" }; },
        approve: async () => true, autoApprove: () => "readonly",
        buildMessages: (task) => [{ role: "system", content: "sys" }, { role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        pushUser: (m, text) => m.push({ role: "user", content: text }),
        drainInbox: () => queued.splice(0),
    });
    const s = snap({ model: "m" });
    const users = s.messages.map((m, j) => [m, s.meta[j]]).filter(([m]) => m.role === "user");
    assert.deepEqual(users.map(([m]) => m.content), ["build it", RESULT, "and the tests?"]);
    const [, task] = users[1];
    assert.equal(task.task, "t1a2b3c");
    assert.equal(task.surface, null, "a task's result claims a surface");
    assert.equal(task.client, undefined, "a task's result claims a sender");
    assert.equal(users[0][1].task, undefined, "the person's message is marked as a task's");
    assert.equal(users[2][1].surface, "hud", "a task's result replaced the run's latest origin");
    assert.deepEqual(s.client, users[2][1].client, "ml.current.client is the latest PERSON's");
});

// --- the event: only the worker writes it ---

test("a page can never write agent-task-say: event admission refuses it, and the session index takes it only from the worker, once per task", () => {
    for (const claim of ["none", "hosts", "owns"]) assert.equal(pageMayWrite("agent-task-say", claim), false, claim);
    const ix = new SessionIndex({ runtime: "local", spawn: "w1", now: () => 1000 });
    const h = "aaaa0009";
    assert.equal(ix.ingest({ kind: "agent", id: h, ts: 1, save: false, session: { hash: h, turn: 0 }, task: "t", model: "m", maxSteps: 4, config: null }, { tabId: 1, trusted: true }).accepted, true);
    assert.equal(ix.ingest(taskSay(h), { tabId: 1, trusted: false, page: { url: "https://site/", title: "x" } }).accepted, false, "a page wrote a task's result");
    assert.equal(ix.ingest(taskSay(h), { tabId: 1, trusted: true }).accepted, true, "positive control: the worker's is taken");
    assert.equal(ix.ingest(taskSay(h), { tabId: 1, trusted: true }).accepted, false, "a replay of the same task's result was kept twice");
    assert.equal(ix.ingest(taskSay(h, { task: "tffffff" }), { tabId: 1, trusted: true }).accepted, true, "another task's result was taken for a duplicate");
});

// --- the exports: what the model read, under the task's name ---

const session = () => ({
    hash: "abc", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 9, status: "ok", turns: [], steps: [],
    task: "build it",
    says: [{ text: RESULT, ts: 3, atStep: 1, seen: true, task: "t1a2b3c" }, { text: "and the tests?", ts: 4, atStep: 1 }],
    answers: [{ text: "done", ts: 5, atStep: 2, status: "ok" }],
});

test("the Markdown export heads a task's result with the task, keeps its text whole, and never as User Asked", () => {
    const { md } = serializeSession(session());
    assert.match(md, /Task t1a2b3c Result/);
    assert.ok(md.includes(RESULT), "the text the model read is not in the export");
    assert.equal((md.match(/User Asked/g) || []).length, 1, "the person's follow-up and nothing else is User Asked");
});

test("the JSON export marks a task's result with its task id, and the person's message with none", () => {
    const msgs = sessionToJson(session()).session.messages;
    const task = msgs.find((m) => m.text === RESULT), person = msgs.find((m) => m.text === "and the tests?");
    assert.equal(task.role, "user");
    assert.equal(task.task, "t1a2b3c");
    assert.equal(person.task, undefined);
});

// --- the transcript: the bubble's speaker is the task ---

test("the sidebar draws a task's result with the task as its speaker, never 'you', and the person's own message as 'you'", async () => {
    const s = await loadSidebarWorld({});
    const h = "taskrun1";
    await s.dispatch(agentStart(h, "build it", "m"));
    await s.dispatch(taskSay(h));
    await s.flush();
    s.shadow.querySelector(".row").click();
    await s.flush();
    const bubbles = [...s.window.document.querySelectorAll(".msg.user")];
    const whos = bubbles.map((e) => e.querySelector(".who")?.textContent);
    assert.deepEqual(whos, ["you", "task t1a2b3c"], JSON.stringify(whos));
    assert.ok(bubbles[1].classList.contains("from-task"));
    assert.ok(bubbles[1].textContent.includes("ml.sh exit 0"), "the bubble shows what the model read");
});
