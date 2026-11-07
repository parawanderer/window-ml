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
const { agentStart, agentStep, agentResult } = require("./sidebar-helpers");
import { readFileSync } from "node:fs";

after(closeSidebarWorlds);

const RESULT = "[task t1a2b3c done after 47 s: ml.sh exit 0, ok; stdout empty; stderr empty]";
const taskSay = (hash, over = {}) => ({ kind: "agent-task-say", id: hash, ts: Date.now() + 1, save: false, session: { hash, turn: 0 }, text: RESULT, task: "t1a2b3c", status: "done", ms: 47000, code: 0, ...over });

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
    const labels = (b) => [...b.querySelectorAll("[aria-label], button")].map((e) => e.getAttribute("aria-label") || e.textContent.trim());
    assert.deepEqual(labels(bubbles[0]), ["Copy this message", "Edit this message"], "positive control: the person's message offers Edit");
    assert.deepEqual(labels(bubbles[1]), ["Copy this message"], "a task's result offers an Edit it can never have");
});

// --- the calm surfaces: one quiet line, never a bubble on the person's side ---

test("a task's result is drawn both ways in the transcript, and the calm view's stylesheet shows only the quiet line", async () => {
    const s = await loadSidebarWorld({});
    const h = "taskrun2";
    await s.dispatch(agentStart(h, "build it", "m"));
    await s.dispatch(taskSay(h));
    await s.flush();
    s.shadow.querySelector(".row").click();
    await s.flush();
    const say = s.window.document.querySelector(".task-say");
    assert.ok(say, "no task say in the transcript");
    const line = say.querySelector(":scope > .task-line");
    assert.equal(line.querySelector(".disc-label").textContent, "✓ task t1a2b3c finished · 47 s · exit 0", "the line reads the event's facts, not the text");
    assert.ok(say.querySelector(":scope > .task-dev .msg.user.from-task"), "the dev view's labelled bubble");
    assert.equal(line.querySelector(".msg.user, .umsg-acts"), null, "the calm line carries a bubble or its Copy/Edit");
    line.querySelector(".disc-head").click();
    await s.flush();
    assert.equal(line.querySelector(".task-line-raw").textContent, RESULT, "opening the line shows exactly what the model got");
    const css = readFileSync(new URL("../src/sidebar/sidebar.css", import.meta.url), "utf8");
    assert.match(css, /^\.task-say > \.task-line \{ display: none; \}$/m, "the dev view hides the line");
    assert.match(css, /^html\[data-calm\] \.task-say > \.task-line \{ display: block; \}$/m, "the calm view shows the line");
    assert.match(css, /^html\[data-calm\] \.task-say > \.task-dev \{ display: none; \}$/m, "the calm view hides the bubble");
});

test("the HUD card's Show work draws a task's result as the quiet line, never as 'you asked'", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const h = "taskcard1";
    await w.dispatch(agentStart(h, "build it", "m"));
    await w.dispatch(agentStep(h, 1, { seq: 1, tool: "exec", arguments: { js: "1" }, result: "ok" }));
    await w.dispatch(taskSay(h, { status: "failed", ms: 3000, code: null, task: "t9f8e7d" }));
    await w.dispatch(agentResult(h, "done", 1));
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".card-work-toggle").click();
    await w.tick();
    const lines = [...doc.querySelectorAll(".task-line")];
    assert.deepEqual(lines.map((l) => l.querySelector(".disc-label").textContent), ["✗ task t9f8e7d failed · 3 s"], "a failed task with no exit code");
    assert.equal([...doc.querySelectorAll(".acard-you")].length, 1, "the task's result became a 'you asked' row");
});
