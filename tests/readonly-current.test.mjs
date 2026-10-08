"use strict";
// readonly-current.test.mjs — `ml.current`: a run reading its own context from a read-only `exec`
// (docs/spec/CURRENT_CONTEXT.md), and the WORKER realm it is read in.
//
// Four layers, in the order data flows: the loop RECORDS what only the moment of appending knows, the snapshot
// ASSEMBLES it, the dialect READS it under its usual guarantees, and the worker realm keeps it out of the page. The
// security property is the last one, and it is a property of two realms together: the worker has the run's context and
// no page, the page has a DOM and no run context, so a survey needing both is refused on both sides.
import { test, after } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { Worker } from "node:worker_threads";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { snapshotCurrent, logText, messageId, UNRECORDED } from "../src/agent/current-context.ts";
import { evalReadonly, NotInDialect, Denied, NeedsPage, ABRIDGE_OVER, describeSwaps } from "../src/readonly-exec.ts";
import { evalReadonlyInWorker } from "../src/sw/sw-readonly.ts";
import { mlPipe } from "../src/pointers/text-pipe.ts";
import { toolToken } from "../src/util.ts";
import { execCodeIn } from "../src/pointers/pointer-macro.ts";

const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;
const LONG_SYSTEM = "You are an agent. ".repeat(200);   // 3,600 chars, like the real one: what the print boundary is for

/** A snapshot of a small, realistic run: a system prompt, the task, an assistant turn calling a tool, its result. */
function sampleSnapshot(now = 1_000_000) {
    return snapshotCurrent({
        run: { id: "runhash1", model: "gemma4:31b", step: 2, maxSteps: 10, startedTs: now - 60_000 },
        messages: [
            { role: "system", content: LONG_SYSTEM },
            { role: "user", content: "find the price" },
            { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }] },
            { role: "tool", tool_call_id: "c1", content: "x".repeat(900) },
        ],
        recorded: [
            { ...UNRECORDED, ts: now - 60_000, step: 0 },
            { ...UNRECORDED, ts: now - 60_000, step: 0, surface: "hud" },
            { ...UNRECORDED, ts: now - 50_000, step: 1, counted: 37 },
            { ...UNRECORDED, ts: now - 10_000, step: 1, seq: 1, tool: "exec", truncated: true },
        ],
        log: [{ t: now - 20_000, level: "warn", subsystem: "page", kind: "discarded", origin: "sw", run: "runhash1", key: "SECRET-KEY" },
              { t: now - 15_000, subsystem: "page", kind: "reloaded", reason: "gone", origin: "sw", run: "runhash1", detail: { tab: 7 } }],
        now,
    });
}
const doc = () => new JSDOM("<!doctype html><body><p id='p'>hi</p></body>").window.document;
/** The worker realm, with what a worker can answer for itself. */
const workerMl = { config: async () => ({ model: "gemma4:31b" }), range: (n) => Array.from({ length: n }, (_, i) => i), pipe: mlPipe };
const inWorkerRealm = (js, snap = sampleSnapshot()) => evalReadonly(js, null, workerMl, undefined, { realm: "worker", current: snap });

// --- the snapshot: what `ml.current` is, assembled from what the loop recorded ------------------------------------------

test("meta is parallel to messages, with ages, gaps, sizes and where a prompt was typed", () => {
    const s = sampleSnapshot();
    assert.equal(s.meta.length, s.messages.length);
    const [sys, task, asst, tool] = s.meta;
    assert.equal(task.surface, "hud", "a user message says where it was typed");
    assert.equal(sys.surface, null, "and nothing else does");
    assert.equal(task.ageMs, 60_000);
    assert.equal(tool.gapMs, 40_000, "the gap since the previous message, pre-computed");
    assert.deepEqual([asst.tokens, asst.tokensBasis], [37, "counted"], "the engine's own count, labelled as one");
    assert.equal(sys.tokensBasis, "estimated");
    assert.equal(sys.tokens, Math.ceil(LONG_SYSTEM.length / 4));
    assert.deepEqual([tool.tool, tool.seq, tool.step, tool.truncated], ["exec", 1, 1, true]);
});

test("a message's id is stable across snapshots, checkable, and never a @tool: id of the same run", () => {
    const a = sampleSnapshot(1_000_000), b = sampleSnapshot(2_000_000);
    assert.deepEqual(a.meta.map((m) => m.id), b.meta.map((m) => m.id), "the same message has the same id at another instant");
    assert.equal(new Set(a.meta.map((m) => m.id)).size, a.meta.length, "distinct");
    for (let i = 0; i < 4; i++) assert.notEqual(messageId("runhash1", i), toolToken("runhash1", i), "its own namespace");
});

test("history from an earlier turn is UNKNOWN, never stamped now; images are counted and kept out of the estimate", () => {
    const s = snapshotCurrent({
        run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
        messages: [{ role: "user", content: "old" }, { role: "user", content: "look", images: ["data:image/png;base64," + "A".repeat(50_000)] }],
        recorded: [], now: 10,
    });
    assert.deepEqual([s.meta[0].ts, s.meta[0].ageMs, s.meta[0].gapMs], [null, null, null]);
    assert.equal(s.meta[1].images, 1);
    assert.equal(s.meta[1].tokens, 1, "the 50k-char data URL is not estimated as 12,500 tokens of text");
});

test("the snapshot is a COPY: nothing done to it reaches the messages the loop holds", () => {
    const loopMessages = [{ role: "user", content: "keep me" }];
    const s = snapshotCurrent({ run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 }, messages: loopMessages, recorded: [], now: 1 });
    s.messages[0].content = "changed";
    assert.equal(loopMessages[0].content, "keep me");
});

test("the log is records AND greppable text; the withheld key never appears", () => {
    const { log } = sampleSnapshot();
    assert.ok(Array.isArray(log));
    assert.deepEqual(log.map((r) => r.kind), ["discarded", "reloaded"]);
    assert.deepEqual(Object.keys(log[1]).sort(), ["detail", "kind", "level", "reason", "subsystem", "ts"]);
    assert.ok(!JSON.stringify(log).includes("SECRET-KEY") && !log.text.includes("SECRET-KEY"), "`key` is withheld from a model as from a page");
    assert.equal(log.text, logText(log));
    assert.match(log.text, /^1970-01-01T00:16:20Z warn page discarded\n1970-01-01T00:16:25Z info page reloaded gone \{"tab":7\}$/);
    assert.doesNotMatch(log.text, / {2}/, "no padding: a model reads it");
    // A record with no level is `info` on every line, so the level is always the second word and a pattern can
    // anchor on it.
    assert.deepEqual(log.map((r) => r.level), ["warn", "info"]);
});

// --- the loop records each message as it is appended -----------------------------------------------------------------

function loopDeps(turns, { onTool } = {}) {
    let i = 0, snap = null;
    const queued = [];
    const deps = {
        callModel: async () => turns[i++] || { content: "" },
        runTool: async (name, args) => onTool ? onTool(name, args) : { result: `ran:${name}` },
        approve: async () => true,
        autoApprove: () => "readonly",
        buildMessages: (task) => [{ role: "system", content: "sys" }, { role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        pushUser: (m, text) => m.push({ role: "user", content: text }),
        drainInbox: () => queued.splice(0),
    };
    return { deps, queued, sink: (f) => { snap = f; }, snap: (x) => snap(x) };
}

test("the loop records the task's surface, each step, each tool, a counted reply, and a steered prompt's own surface", async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 12 };
    const L = loopDeps([
        { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }], usage },
        { content: "thinking out loud", tool_calls: [{ id: "c2", name: "exec", arguments: { js: "2" } }], usage, reasoning: "hidden chain" },
        { content: "done", tool_calls: [], usage },
    ]);
    let seen;
    L.deps.runTool = async () => {
        if (!seen) L.queued.push({ text: "also check the tax", origin: { surface: "chat", remote: true } });
        seen = true;
        return { result: "ok", renderOut: { type: "exec-out", stdout: "y".repeat(800), seen: 500 } };
    };
    await runAgentLoop("find the price", { tools: [{ name: "exec" }], runHash: "h1", origin: { surface: "hud" }, contextSink: L.sink }, L.deps);
    const s = L.snap({ model: "gemma4:31b" });
    const roles = s.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user", "assistant", "tool", "assistant"]);
    const m = s.meta;
    assert.equal(m[1].surface, "hud", "the task carries the run's own surface");
    assert.equal(m[4].surface, "chat", "a steering message carries where IT was typed");
    assert.deepEqual([m[2].tokensBasis, m[2].tokens], ["counted", 12], "a reply with no reasoning is measured by its count");
    assert.equal(m[5].tokensBasis, "estimated", "a reply that also reasoned is NOT: its count includes reasoning not re-sent");
    assert.deepEqual([m[3].tool, m[3].seq, m[3].step, m[3].truncated], ["exec", 1, 1, true], "the model saw 500 of 800");
    assert.ok(m.every((x) => typeof x.ts === "number"), "every message this turn appended has a time");
    assert.equal(s.run.model, "gemma4:31b");
    assert.equal(s.run.id, "h1");
});

// --- the dialect reads it: plain data, a synchronous join, and the write rules -----------------------------------------

test("the spec's own join runs as written: messages and meta zip by index, synchronously, inside a callback", async () => {
    const { value } = await inWorkerRealm(`const meta = ml.current.meta;
return ml.current.messages
    .map((m, i) => ({ m, meta: meta[i] }))
    .filter(x => x.meta.tokens > 100)
    .map(x => x.meta.id + " " + x.m.role + " " + x.meta.tokens + "t");`);
    assert.equal(value.length, 2, "the system prompt and the long tool result");
    assert.match(value[0], / system 900t$/);
});

test("WRITE RULES: messages throw a TypeError the model reads (never the approval gate); meta and run are copies it owns", async () => {
    for (const js of [
        `ml.current.messages[0].content = "x"`,
        `ml.current.messages.push({ role: "user", content: "x" })`,
        `ml.current.messages.splice(0, 1)`,
        `ml.current.messages.sort()`,
        `ml.current.messages[2].tool_calls[0].name = "evil"`,
        `ml.current.messages[2].tool_calls.pop()`,
        `const m = ml.current.messages[1]; m.content += "!"`,
        `const { messages } = ml.current; messages.length = 0`,
    ]) {
        await assert.rejects(inWorkerRealm(js), (e) => e instanceof TypeError && /ml\.current\.messages is read-only/.test(e.message), js);
    }
    // A top-level copy is the script's own: writable one level down, and the protection stays on what it aliases.
    assert.equal((await inWorkerRealm(`const c = { ...ml.current.messages[1] }; c.content = "mine"; return c.content`)).value, "mine");
    await assert.rejects(inWorkerRealm(`const c = { ...ml.current.messages[2] }; c.tool_calls.push(1)`), TypeError);
    // meta: annotate a working copy, which is how a compaction is planned.
    assert.equal((await inWorkerRealm(`const m = ml.current.meta; m[0].drop = true; m.push({ note: 1 }); return m.length + ":" + m[0].drop`)).value, "5:true");
    assert.equal((await inWorkerRealm(`ml.current.run.step = 99; return ml.current.run.step`)).value, 99);
});

test("WRITE RULES: an annotated meta never reaches the next snapshot, and the snapshot source is never touched", async () => {
    const snap = sampleSnapshot();
    await inWorkerRealm(`ml.current.meta[0].tokens = 1; ml.current.meta.pop(); ml.current.run.id = "forged"`, snap);
    assert.equal(snap.meta.length, 4, "the snapshot's own meta array is unchanged");
    assert.notEqual(snap.meta[0].tokens, 1);
    assert.equal(snap.run.id, "runhash1");
});

test("ADVERSARIAL: nothing on ml.current is a live object, a realm, or a way to address another run", async () => {
    assert.deepEqual((await inWorkerRealm(`Object.keys(ml.current)`)).value, ["run", "messages", "meta", "log"], "no id lookup to forge");
    for (const js of [
        `ml.current.constructor`, `ml.current.messages.constructor`, `ml.current.meta[0].__proto__`,
        `ml.current.log.constructor.constructor("return this")()`, `ml.current["__proto__"]`,
    ]) await assert.rejects(inWorkerRealm(js), outOfDialect, js);
});

test("THE PRINT BOUNDARY: a large message prints as a summary naming how to print it whole; the value is untouched", async () => {
    const { value, logs } = await inWorkerRealm(`console.log(ml.current.messages); return ml.current.messages[0].content.length`);
    assert.equal(value, LONG_SYSTEM.length, "the real length, whatever the print showed");
    const printed = JSON.parse(logs[0]);
    assert.equal(printed[0].abridged, "print ml.current.messages[0].content for all 3600 chars");
    assert.equal(printed[0].chars, 3600);
    assert.equal(printed[1].content, "find the price", "a small message prints whole");
    assert.match(printed[3].abridged, /messages\[3\]/, "by SIZE, not role: a large tool result abridges too");
    // A tool-calling turn whose bulk is its ARGUMENTS points at them, not at its empty content.
    const big = sampleSnapshot();
    big.messages[2].tool_calls[0].arguments = { js: "x".repeat(800) };
    const callTurn = JSON.parse((await inWorkerRealm(`console.log(ml.current.messages[2])`, big)).logs[0]);
    assert.equal(callTurn.abridged, `print ml.current.messages[2].tool_calls for all ${JSON.stringify(big.messages[2].tool_calls).length} chars`);
    assert.match(callTurn.preview, /^\[\{"id":"c1"/);
    // And a survey that ENDS in console.log has the value JavaScript gives it.
    assert.equal((await inWorkerRealm(`console.log("hi")`)).value, undefined);
    // Naming the content prints it, an explicit act over honest data.
    const named = await inWorkerRealm(`console.log(ml.current.messages[0].content)`);
    assert.equal(named.logs[0].length, LONG_SYSTEM.length);
    // A RETURNED row is abridged the same way, wherever it sits in the result.
    const ret = await inWorkerRealm(`return ml.current.messages.slice(0, 1).map(m => ({ m }))`);
    assert.match(ret.value[0].m.abridged, /messages\[0\]/);
    assert.ok(ABRIDGE_OVER < 900);
});

test("THE PRINT BOUNDARY SAYS WHAT IT CHANGED: a note in JSONPath, after the clip, for every substitution", async () => {
    const { logs, prints } = await inWorkerRealm(`console.log(ml.current.messages)`);
    assert.ok(logs.length === 1);
    // Rows 0 (the system prompt) and 3 (the long tool result) were summarised the same way: one note, one union.
    assert.deepEqual(describeSwaps(prints.console), ["[console.log printed a VIEW: $[0,3].content REPLACED by virtual $[0,3]['chars','preview','abridged']; the value is unchanged, so print a path to see it]"]);
    // A field that keeps its name and changes TYPE says so (a tool-calling turn's arguments become a count).
    const big = sampleSnapshot();
    big.messages[2].tool_calls[0].arguments = { js: "x".repeat(800) };
    const r = await inWorkerRealm(`return ml.current.messages[2]`, big);
    assert.deepEqual(describeSwaps(r.prints.value), ["[the returned value printed a VIEW: $.content and $.tool_calls (an array in the value, a number here) REPLACED by virtual $['chars','preview','abridged']; the value is unchanged, so print a path to see it]"]);
    // Places that are not direct siblings still get ONE correct path: a union at the index that differs.
    assert.deepEqual(describeSwaps((await inWorkerRealm(`console.log(ml.current.messages.map(m => ({ m })))`)).prints.console),
        ["[console.log printed a VIEW: $[0,3].m.content REPLACED by virtual $[0,3].m['chars','preview','abridged']; the value is unchanged, so print a path to see it]"]);
    // The formatter puts the notes AFTER the clip, so the cut cannot remove them.
    const { formatReadonlyExec } = await import("../src/agent/approval.ts");
    const all = await inWorkerRealm(`console.log(ml.current.messages)`);
    const shown = formatReadonlyExec(undefined, all.logs, all.prints).result;
    assert.match(shown, /… \[first \d+ of \d+ chars\]\n\[console\.log printed a VIEW: /);
    // Nothing substituted, nothing said.
    assert.deepEqual((await inWorkerRealm(`console.log(ml.current.messages[1])`)).prints.console, []);
});

test("A NOTE IS ABOUT WHAT ITS READER RECEIVED: the model is told only of substitutions before its cut, the panel of more", async () => {
    // Row 0 is large and prints as a summary inside the model's 500 characters; eleven small rows follow, so the second
    // large one (row 12) STARTS past the cut. A row the model saw the start of counts as seen: it read part of a view.
    const snap = snapshotCurrent({
        run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
        messages: Array.from({ length: 13 }, (_, i) => ({ role: "user", content: i === 0 || i === 12 ? "x".repeat(400) : "small" })),
        recorded: [], now: 1,
    });
    const { formatReadonlyExec } = await import("../src/agent/approval.ts");
    const all = await inWorkerRealm(`console.log(ml.current.messages)`, snap);
    assert.ok(all.logs[0].indexOf('"abridged":"print ml.current.messages[12]') > 500, "the setup: row 12 is past the model's cut");
    const out = formatReadonlyExec(undefined, all.logs, all.prints);
    const modelNotes = out.result.split("\n").filter((l) => l.startsWith("[console.log printed a VIEW"));
    assert.equal(modelNotes.length, 1);
    assert.match(modelNotes[0], /VIEW: \$\[0\]\.content/, "the model hears about row 0, which it saw");
    assert.doesNotMatch(modelNotes[0], /12/, "and nothing about row 12, which it was never sent");
    // The panel shows the whole print, so its notes name both.
    assert.match(out.render.stdoutNotes.join("\n"), /\$\[0,12\]\.content/);
});

test("A NOTE STAYS SHORT: runs become slices, and a long list names its first places and says how many there were", async () => {
    const many = (n, big) => snapshotCurrent({
        run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
        messages: Array.from({ length: n }, (_, i) => ({ role: "user", content: big(i) ? "x".repeat(400) : "small" })),
        recorded: [], now: 1,
    });
    const note = async (snap) => describeSwaps((await inWorkerRealm(`console.log(ml.current.messages)`, snap)).prints.console)[0];
    assert.match(await note(many(40, () => true)), /VIEW: \$\[0:40\]\.content/, "a run is a slice");
    assert.match(await note(many(40, (i) => i % 2 === 0)), /VIEW: \$\[0:39:2\]\.content/, "a regular stride is a stepped slice");
    const scattered = await note(many(200, (i) => [3, 7, 20, 41, 55, 89, 101, 140, 166, 199].includes(i)));
    assert.match(scattered, /\$\[3,7,20,41,55,89,101,140\] \(10 places; the first of them named\)/, "capped, and it says so");
    assert.ok(scattered.length < 400, `one line, not a flood (${scattered.length} chars)`);
});

test("EVERY SUBSTITUTION DOCUMENTS ITSELF: a print that differs from the value has a note whose paths find exactly what changed", async () => {
    // A tiny resolver for the JSONPath the notes use: `$`, `[n]`, `[n,m]`, `.key`, `['a','b']`. Returns every node a
    // path selects, so a union selects several.
    const resolve = (root, path) => {
        let nodes = [root];
        for (const step of path.slice(1).match(/\.[A-Za-z_$][\w$]*|\[[^\]]*\]/g) ?? []) {
            const keys = step.startsWith(".") ? [step.slice(1)] : step.slice(1, -1).split(",").map((k) => k.trim().replace(/^'|'$/g, ""));
            nodes = nodes.flatMap((n) => keys.map((k) => n?.[/^\d+$/.test(k) ? Number(k) : k]));
        }
        return nodes;
    };
    for (const expr of [
        "ml.current.messages", "ml.current.messages.slice(2)", "ml.current.messages.map(m => ({ m }))",
        "[ml.current.messages[3], 5, ml.current.messages[0]]", "({ first: ml.current.messages[0], rest: { last: ml.current.messages[3] } })",
    ]) {
        const { logs, prints } = await inWorkerRealm(`console.log(${expr})`);
        const notes = { console: describeSwaps(prints.console) };
        const printed = JSON.parse(logs[0]);
        const swapped = [];   // every object in the print that is a summary, found by walking it
        const walk = (v) => { if (v && typeof v === "object") { if ("abridged" in v) swapped.push(v); else Object.values(v).forEach(walk); } };
        walk(printed);
        assert.equal(notes.console.length > 0, swapped.length > 0, `${expr}: a substitution without a note, or a note without one`);
        // Read the targets off the note's own JSONPath: each `virtual <path>['…']` names fields of the summary objects,
        // so its parent path must select exactly those objects, union or list alike.
        const located = notes.console.flatMap((n) => [...n.matchAll(/(\$[^ ;]*?)\['chars','preview','abridged'\]/g)].flatMap((m) => resolve(printed, m[1])));
        assert.deepEqual(new Set(located), new Set(swapped), `${expr}: the note's paths must select exactly the summarised objects`);
    }
});

test("the log: an ordinary Array for filtering, and `.text` for ml.pipe", async () => {
    assert.deepEqual((await inWorkerRealm(`ml.current.log.filter(r => r.kind === "reloaded").map(r => r.reason)`)).value, ["gone"]);
    assert.equal((await inWorkerRealm(`ml.pipe(ml.current.log, "grep reloaded")`)).value, "1970-01-01T00:16:25Z info page reloaded gone {\"tab\":7}");
});

// --- the worker realm: run context and no page; the page: a DOM and no run context -------------------------------------

test("WORKER REALM: every route to the page defers the survey to the page — by name, by alias, by destructuring", async () => {
    for (const js of [
        `document.title`, `typeof document`, `getComputedStyle`, `ml.queryAll("p")`, `ml.a11y`,
        `ml.answer.add("x")`, `const { answer } = ml; answer`, `const m = ml; m.queryAll("p")`,
        `ml.fetch("https://example.test/")`, `ml.somethingAddedLater()`,
        `ml.current.messages.length; document.body`,
    ]) await assert.rejects(inWorkerRealm(js), (e) => e instanceof NeedsPage, js);
});

test("WORKER REALM: a script's try/catch cannot keep it in the worker after it reached for the page", async () => {
    await assert.rejects(inWorkerRealm(`let n = ml.current.messages.length; try { document.body } catch (e) { n = -1 } return n`), NeedsPage);
});

test("WORKER REALM: what the worker can answer for itself runs there", async () => {
    assert.equal((await inWorkerRealm(`(await ml.config()).model`)).value, "gemma4:31b");
    assert.deepEqual((await inWorkerRealm(`ml.range(3)`)).value, [0, 1, 2]);
    assert.equal((await inWorkerRealm(`ml.pipe("a\\nb", "grep b")`)).value, "b");
});

test("THE PAGE HAS NO RUN CONTEXT: ml.current there is a refusal, so a survey needing both reaches the human either way", async () => {
    await assert.rejects(evalReadonly(`ml.current.messages`, doc(), workerMl), (e) => outOfDialect(e) && !(e instanceof NeedsPage));
    // Not `undefined`: that would let a survey needing both evaluate to a plausible wrong answer with no one asked.
    await assert.rejects(evalReadonly(`document.title + ml.current.messages.length`, doc(), workerMl), (e) => outOfDialect(e) && !(e instanceof NeedsPage));
    await assert.rejects(evalReadonly(`const { current } = ml; current`, doc(), workerMl), outOfDialect);
    // Both orders. In the worker it trips on the page; on the page it is refused on the run. Neither runs it.
    for (const js of [`document.body; ml.current.messages`, `ml.current.messages; document.body`]) {
        await assert.rejects(inWorkerRealm(js), NeedsPage, `worker: ${js}`);
        await assert.rejects(evalReadonly(js, doc(), workerMl), (e) => outOfDialect(e) && !(e instanceof NeedsPage), `page: ${js}`);
    }
});

// --- evalReadonlyInWorker: what a host calls -------------------------------------------------------------------------

test("evalReadonlyInWorker answers, defers, refuses, and reports a script's own error with its line", async () => {
    let snaps = 0;
    const deps = { current: () => { snaps++; return sampleSnapshot(); }, ml: workerMl };
    const a = await evalReadonlyInWorker({ js: "return ml.current.meta.length" }, deps);
    assert.equal(a.kind, "answered"); assert.equal(a.result, "4");
    // The step's In is the same code view the page's `exec` draws, so a survey answered here looks like one answered there.
    const { execCodeIn } = await import("../src/pointers/pointer-macro.ts");
    assert.deepEqual(a.renderIn, execCodeIn("return ml.current.meta.length"));
    assert.equal((await evalReadonlyInWorker({ js: "document.title" }, deps)).kind, "needs-page");
    assert.equal((await evalReadonlyInWorker({ js: "window.location" }, deps)).kind, "refused");
    assert.equal((await evalReadonlyInWorker({ js: "return 1", maxChars: 6000 }, deps)).kind, "refused", "a raised cap is the human's to grant");
    const err = await evalReadonlyInWorker({ js: "const a = 1;\nJSON.parse(\"{\")" }, deps);
    assert.equal(err.kind, "answered"); assert.match(err.result, /^Error: .*\(line 2\)$/);
    // A survey that never says `current` copies nothing.
    snaps = 0;
    await evalReadonlyInWorker({ js: "return 1 + 1" }, deps);
    assert.equal(snaps, 0);
    // `@tool:` defers until the host gives the worker a `dereference` (the site-access slice 2's).
    assert.equal((await evalReadonlyInWorker({ js: "return @tool:abc1234.length" }, deps)).kind, "needs-page");
});

// --- the worker's own `ml` (worker-readonly-ml.ts): what a survey reads there, pointers included ----------------------

/** A pointer store of one capture, recording every read the survey makes of it. */
function oneCapture(value = '{"rows":[1,2,3]}') {
    const reads = [];
    const meta = { tool: "fetch_url", seq: 1 };
    return { reads, meta, deref: (ref, stages) => { reads.push([ref, stages]); return { value: stages?.length ? "piped:" + stages.join("|") : value, meta }; } };
}

test("WORKER ML: only reads; nothing that spends, mutates, egresses or reads the page", async () => {
    const { workerReadonlyMl } = await import("../src/sw/worker-readonly-ml.ts");
    const without = Object.keys(workerReadonlyMl("https://a.example/")).sort();
    assert.deepEqual(without, ["_fetchCached", "capabilities", "config", "getModel", "info", "jsonPath", "models", "pipe", "ps", "range", "schema", "serverTools"]);
    assert.deepEqual(Object.keys(workerReadonlyMl("https://a.example/", oneCapture().deref)).sort(), [...without, "dereference"].sort(),
        "dereference exists only when the host hands over the run's store");
});

test("WORKER ML: a pointer read is answered in the worker from the run's store, pipe stages included", async () => {
    const { workerReadonlyMl } = await import("../src/sw/worker-readonly-ml.ts");
    const c = oneCapture();
    const ml = workerReadonlyMl("https://a.example/", c.deref);
    const run = (js) => evalReadonlyInWorker({ js }, { ml });
    const a = await run("return @tool:abc1234.json.rows.length");
    assert.deepEqual([a.kind, a.result], ["answered", "3"]);
    assert.deepEqual(a.renderIn, execCodeIn("return @tool:abc1234.json.rows.length"), "drawn as the page draws it, macro marks included");
    assert.equal((await run(`return (await ml.dereference("abc1234", { pipe: "head 1" })).text`)).result, 'piped:head 1');
    assert.equal((await run(`const v = await ml.dereference("abc1234"); return v.pipe(["head 1"])`)).kind, "refused", "a value's own re-read is out of dialect here as on the page");
    assert.ok(c.reads.every(([ref]) => ref === "abc1234" || ref === "@tool:abc1234"), JSON.stringify(c.reads));
});

test("WORKER ML ADVERSARIAL: a pointer's value is data; no realm, no constructor, no write back into the store", async () => {
    const { workerReadonlyMl } = await import("../src/sw/worker-readonly-ml.ts");
    const c = oneCapture();
    const ml = workerReadonlyMl("https://a.example/", c.deref);
    for (const js of [
        `(await ml.dereference("x")).constructor`, `(await ml.dereference("x")).pipe.constructor("return this")()`,
        `ml.dereference.constructor("return this")()`, `(await ml.dereference("x"))["__proto__"]`,
        `ml.dereference.call(null, "x")`, `(await ml.dereference("x")).meta.constructor`,
    ]) assert.equal((await evalReadonlyInWorker({ js }, { ml })).kind, "refused", js);
    await evalReadonlyInWorker({ js: `const v = await ml.dereference("x"); v.meta.tool = "forged"; return 1` }, { ml });
    assert.equal(c.meta.tool, "fetch_url", "the store's meta is untouched");
});

test("WORKER ML ADVERSARIAL: what the worker does not carry defers to the page, where it is refused; a read then a page reach returns nothing", async () => {
    const { workerReadonlyMl } = await import("../src/sw/worker-readonly-ml.ts");
    const ml = workerReadonlyMl("https://a.example/", oneCapture().deref);
    for (const js of [`ml.chat("x")`, `ml.setModel("m")`, `ml.fetch("https://b.example/")`, `ml.agent("x")`, `ml.pythonExec("1")`, `ml._fetchCached("u")`, `ml.unload()`]) {
        assert.equal((await evalReadonlyInWorker({ js }, { ml })).kind, "needs-page", `worker: ${js}`);
        await assert.rejects(evalReadonly(js, doc(), ml), (e) => outOfDialect(e) && !(e instanceof NeedsPage), `page: ${js}`);
    }
    const both = await evalReadonlyInWorker({ js: `const v = await ml.dereference("x"); return v + document.title` }, { ml });
    assert.deepEqual(both, { kind: "needs-page" }, "the value read before the page reach goes nowhere");
});

test("WORKER ML HALTING: a survey that re-reads a pointer forever is stopped by the step budget", { timeout: 10_000 }, async () => {
    const { workerReadonlyMl } = await import("../src/sw/worker-readonly-ml.ts");
    const c = oneCapture();
    const ml = workerReadonlyMl("https://a.example/", c.deref);
    const r = await evalReadonlyInWorker({ js: `let n = 0; while (true) { await ml.dereference("x"); n++ } return n` }, { ml });
    assert.notEqual(r.kind, "needs-page");
    assert.ok(r.kind === "refused" || /^Error:/.test(r.result), JSON.stringify(r));
    assert.ok(c.reads.length < 100_000, `bounded (${c.reads.length} reads)`);
});

// --- ml.current.debug: what the person shared (sw-shared-watches.ts), read-only ---------------------------------------

const withShared = (snap = sampleSnapshot()) => ({ ...snap, debug: { userWatches: [
    { expression: "ml.current.run.step", value: 2, at: 5 },
    { expression: "$.ml.current.meta[*].tool", value: [null, null, null, "exec"], at: 5 },
    { expression: "inspector.grants", error: "reads inspector., which the model does not have", at: 5 },
] } });

test("ml.current.debug reads as plain data where the host added it, and is absent where it did not", async () => {
    assert.equal((await inWorkerRealm("ml.current.debug.userWatches.length", withShared())).value, 3);
    assert.deepEqual((await inWorkerRealm("ml.current.debug.userWatches.filter(w => !w.error).map(w => w.expression)", withShared())).value,
        ["ml.current.run.step", "$.ml.current.meta[*].tool"]);
    assert.equal((await inWorkerRealm("ml.current.debug.userWatches[1].value.at(-1)", withShared())).value, "exec");
    assert.equal((await inWorkerRealm("typeof ml.current.debug", sampleSnapshot())).value, "undefined");
});

test("ADVERSARIAL: ml.current.debug cannot be written, at any depth, by assignment, delete or a mutating method", async () => {
    const snap = withShared();
    const before = structuredClone(snap.debug);
    for (const src of [
        "ml.current.debug.userWatches.push({ expression: 'forged', value: 1 })", "ml.current.debug.userWatches.length = 0",
        "ml.current.debug.userWatches[0].value = 99", "ml.current.debug.userWatches[1].value.push('x')",
        "ml.current.debug.userWatches.sort()", "ml.current.debug.userWatches.reverse()", "ml.current.debug.userWatches.splice(0)",
        "ml.current.debug.userWatches.fill(null)", "delete ml.current.debug.userWatches[0].error", "const d = ml.current.debug; d.userWatches = []",
    ]) {
        let threw = null;
        try { await inWorkerRealm(src, snap); } catch (e) { threw = e; }
        assert.ok(threw instanceof TypeError || outOfDialect(threw), `${src}: got ${threw?.constructor?.name}: ${threw?.message}`);
        if (threw instanceof TypeError) assert.match(threw.message, /ml\.current\.debug is read-only/, src);
    }
    await assert.rejects(inWorkerRealm("ml.current.debug = {}", snap), outOfDialect, "the facade is the environment's");
    assert.deepEqual(snap.debug, before, "the host's copy is untouched");
    assert.deepEqual((await inWorkerRealm("const l = [...ml.current.debug.userWatches]; l.push(1); l.length", snap)).value, 4,
        "a copy the script makes is its own, as the error says");
});

test("ADVERSARIAL: no road from ml.current.debug to a constructor, a prototype or the realm", async () => {
    for (const src of [
        "ml.current.debug.constructor", "ml.current.debug.__proto__", `ml.current.debug["constr" + "uctor"]`,
        "ml.current.debug.userWatches.constructor", "ml.current.debug.userWatches.map.constructor",
        `ml.current.debug.userWatches[0].expression.constructor.constructor("return globalThis")()`,
        "Object.getPrototypeOf(ml.current.debug.userWatches[0])", "ml.current.debug.userWatches[0].value.constructor",
    ]) {
        let value, err;
        try { value = (await inWorkerRealm(src, withShared())).value; } catch (e) { err = e; }
        if (err) assert.ok(outOfDialect(err) || err instanceof TypeError, `${src}: refused, got ${err?.constructor?.name}: ${err?.message}`);
        else {
            assert.notEqual(typeof value, "function", `${src} handed back a function`);
            assert.notEqual(value, globalThis, `${src} reached the realm`);
        }
    }
});

test("FAILURE: a survey that reads ml.current.debug and then falls out of dialect leaves it as it was", async () => {
    const snap = withShared();
    await assert.rejects(inWorkerRealm("const n = ml.current.debug.userWatches.length; document.title", snap), (e) => e instanceof NeedsPage || outOfDialect(e));
    assert.equal(snap.debug.userWatches.length, 3);
    assert.equal(snap.debug.userWatches[0].value, 2);
});

// --- the worker's fetch cache: re-reads of what the run's fetch_url read in the worker (slice 2 part 2) ---

/** A worker `ml` whose cache holds one result for `url`, as the run's fetch_url would have left it. */
async function cachedWorkerMl(url = "https://other.example/doc", r = { url: "https://other.example/doc", ok: true, status: 200, type: "html", text: "<h1>X</h1>", markdown: "# X", json: { a: [1] } }) {
    const { cacheCopy } = await import("../src/ml/fetch-result.ts");
    const cache = new Map([[url, cacheCopy(r)]]);   // what the real caches hold
    return { r, ml: { _fetchCached: (u, mode) => (mode?.credentials || mode?.rendered || mode?.format === "html" ? undefined : cache.get(String(u))) } };
}

test("WORKER FETCH: a re-read of the run's own fetch is answered in the worker, from its cache, and never egresses", async () => {
    const { ml } = await cachedWorkerMl();
    const a = await evalReadonlyInWorker({ js: `return (await ml.fetch("https://other.example/doc")).markdown` }, { ml });
    assert.deepEqual([a.kind, a.result], ["answered", "# X"]);
});

test("WORKER FETCH ADVERSARIAL: a miss or another mode defers to the page; fresh is refused; nothing reaches a realm or writes back", async () => {
    const { ml, r } = await cachedWorkerMl();
    for (const js of [`ml.fetch("https://never.example/")`, `ml.fetch("https://other.example/doc", { credentials: true })`,
        `ml.fetch("https://other.example/doc", { rendered: true })`, `ml.fetch("https://other.example/doc", { format: "html" })`])
        assert.equal((await evalReadonlyInWorker({ js }, { ml })).kind, "needs-page", js);
    assert.equal((await evalReadonlyInWorker({ js: `ml.fetch("https://other.example/doc", { fresh: true })` }, { ml })).kind, "refused", "fresh is a live fetch");
    for (const js of [`(await ml.fetch("https://other.example/doc")).constructor`, `ml.fetch.constructor("return this")()`,
        `(await ml.fetch("https://other.example/doc")).__proto__`, `ml._fetchCached("https://other.example/doc")`])
        assert.notEqual((await evalReadonlyInWorker({ js }, { ml })).kind, "answered", js);
    for (const js of [`const v = await ml.fetch("https://other.example/doc"); v.markdown = "forged"; return 1`,
        `const v = await ml.fetch("https://other.example/doc"); v.json.a.push(2); return 1`]) {
        const w = await evalReadonlyInWorker({ js }, { ml });
        assert.ok(w.kind === "refused" || /^Error: .*(read.only|frozen|not extensible|Cannot assign)/i.test(w.result), `${js}: ${JSON.stringify(w)}`);
    }
    const again = await evalReadonlyInWorker({ js: `const v = await ml.fetch("https://other.example/doc"); return [v.markdown, v.json.a.length]` }, { ml });
    assert.equal(again.result, '["# X",1]', "a later re-read sees what was fetched");
    assert.equal(r.markdown, "# X", "and the fetch's own result is untouched");
    // A page-realm facade over the same member refuses a miss as before (it is the page's cache there).
    await assert.rejects(evalReadonly(`ml.fetch("https://never.example/")`, doc(), ml), (e) => e instanceof Denied && !(e instanceof NeedsPage));
});

test("WORKER FETCH HALTING: a survey re-reading the cache forever is stopped by the step budget", { timeout: 10_000 }, async () => {
    const { ml } = await cachedWorkerMl();
    const r = await evalReadonlyInWorker({ js: `let n = 0; while (true) { await ml.fetch("https://other.example/doc"); n++ } return n` }, { ml });
    assert.ok(r.kind === "refused" || /^Error:/.test(r.result), JSON.stringify(r));
});

// --- HALTING and FAILURE ----------------------------------------------------------------------------------------------
// The halting argument for a loop over `messages` is that the array cannot grow. That argument dies with the write half
// (`for (const m of ml.current.messages) ml.current.drop(m)` is the Set/Map mutator bug again), so it is tested NOW,
// against the read-only shape, in a worker with a timeout, so a regression fails instead of hanging the runner.

const RO_URL = new URL("../src/readonly-exec.ts", import.meta.url).href;
const CC_URL = new URL("../src/agent/current-context.ts", import.meta.url).href;
const TSX_API = import.meta.resolve("tsx/esm/api");
const TSX_CJS_API = import.meta.resolve("tsx/cjs/api");
let worker = null, nextId = 0;
const pending = new Map();
function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const ready = import(workerData.tsxCjs).then((cjs) => { cjs.register(); return import(workerData.tsx); })
            .then((tsx) => { tsx.register(); return Promise.all([import(workerData.ro), import(workerData.cc)]); });
        const big = Array.from({ length: 3000 }, (_, i) => ({ i }));
        parentPort.on("message", ({ id, src, n, bound, shared }) => ready
            .then(([ro, cc]) => ro.evalReadonly(src, null, {}, undefined, { realm: "worker", stepBudget: 200000,
                ...(bound ? { globals: { inspector: { big, n: 1 } } } : {}),
                current: Object.assign(cc.snapshotCurrent({ run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
                    messages: Array.from({ length: n }, (_, i) => ({ role: "user", content: "m" + i })), recorded: [], now: 1 }),
                    shared ? { debug: { userWatches: big.map((b) => ({ expression: "x", value: b, at: 1 })) } } : {}) }))
            .then((r) => parentPort.postMessage({ id, value: r.value }),
                  (e) => parentPort.postMessage({ id, threw: e.constructor.name, message: e.message })));`,
        { eval: true, workerData: { ro: RO_URL, cc: CC_URL, tsx: TSX_API, tsxCjs: TSX_CJS_API } });
    worker.on("message", ({ id, ...r }) => { pending.get(id)?.(r); pending.delete(id); });
    worker.on("error", (e) => { for (const done of pending.values()) done({ threw: "WorkerError", message: String(e) }); pending.clear(); worker = null; });
    return worker;
}
after(() => worker?.terminate());
function inThread(src, n = 3, ms = 5000, bound = false, shared = false) {
    return new Promise((resolve) => {
        const id = nextId++, w = ensureWorker();
        const timer = setTimeout(() => { pending.delete(id); w.terminate(); if (worker === w) worker = null; resolve({ hung: true }); }, ms);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        w.postMessage({ id, src, n, bound, shared });
    });
}

test("HALTING: a loop that tries to grow the messages it iterates ends at once, with the read-only error", async () => {
    for (const src of [
        `for (const m of ml.current.messages) ml.current.messages.push(m); 0`,
        `ml.current.messages.forEach(m => ml.current.messages.push(m)); 0`,
        `const all = ml.current.messages; for (const m of all) all[all.length] = m; 0`,
    ]) {
        const r = await inThread(src);
        assert.ok(!r.hung, `${src}: still running after 5 s`);
        assert.equal(r.threw, "TypeError", src);
    }
});

test("HALTING: a survey over a large context is bounded by the step budget, not by how big the context is", async () => {
    const r = await inThread(`ml.current.messages.map(a => ml.current.messages.map(b => a.content + b.content).length).length`, 2000);
    assert.ok(!r.hung, "still running after 5 s");
    assert.equal(r.threw, "NotInDialect", "4 million pairs: over budget, so it goes to the human");
    assert.match(r.message, /too much work/);
});

test("HALTING: a watch that loops, recurses or multiplies over caller-bound data (`globals`) is stopped by the step budget", async () => {
    for (const src of [
        "while (true) { inspector.n }",
        "inspector.big.map(a => inspector.big.map(b => a.i + b.i).length).length",
        "const f = () => f() + inspector.n; f()",
        "for (const x of inspector.big) inspector.big.push(x); 0",
    ]) {
        const r = await inThread(src, 3, 5000, true);
        assert.ok(!r.hung, `${src}: still running after 5 s`);
        assert.ok(r.threw, `${src}: should not complete`);
    }
    assert.equal((await inThread("inspector.big.length", 3, 5000, true)).value, 3000, "and a cheap read of the same data answers");
});

test("HALTING: a loop over ml.current.debug cannot grow it, and multiplying over it is stopped by the step budget", async () => {
    for (const [src, want] of [
        ["for (const w of ml.current.debug.userWatches) ml.current.debug.userWatches.push(w); 0", "TypeError"],
        ["ml.current.debug.userWatches.forEach(w => ml.current.debug.userWatches.push(w)); 0", "TypeError"],
        ["ml.current.debug.userWatches.map(a => ml.current.debug.userWatches.map(b => a.value.i + b.value.i).length).length", "NotInDialect"],
    ]) {
        const r = await inThread(src, 3, 5000, false, true);
        assert.ok(!r.hung, `${src}: still running after 5 s`);
        assert.equal(r.threw, want, src);
    }
    assert.equal((await inThread("ml.current.debug.userWatches.length", 3, 5000, false, true)).value, 3000);
});

test("FAILURE: a survey that reads ml.current and then falls out of dialect leaves the snapshot as it was", async () => {
    const snap = sampleSnapshot();
    await assert.rejects(inWorkerRealm(`const m = ml.current.meta; m[0].tokens = 0; m.length = 0; window.x`, snap), outOfDialect);
    assert.equal(snap.meta.length, 4);
    assert.notEqual(snap.meta[0].tokens, 0);
});

// --- the state inspector's view of the same snapshot ---

test("the inspector's message rows use ml.current's own field names and nothing else, so a copied path is real", async () => {
    const { messageRow } = await import("../src/agent/state-rows.ts");
    const long = "x".repeat(500);
    const msgs = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }] },
        { role: "tool", content: long, tool_call_id: "c1" },
    ];
    for (const m of msgs) for (const k of Object.keys(messageRow(m))) assert.ok(k in m, `${k} is a field of the message itself`);
    assert.deepEqual(messageRow(msgs[1]).tool_calls, [{ name: "exec" }]);
    const cut = messageRow(msgs[2]).content;
    assert.ok(cut.length < long.length && cut.endsWith("…"), "a long content is cut, and says so");
});

test("run.log in the inspector is the model's view of the log: no key, no tab, no origin", async () => {
    const { currentLogRecords } = await import("../src/agent/current-context.ts");
    const [r] = currentLogRecords([{ t: 5, run: "r", subsystem: "page", kind: "discarded", origin: "worker", tab: 3, key: "https://secret/", level: "warn", detail: { tab: 3 } }]);
    assert.deepEqual(r, { ts: 5, level: "warn", subsystem: "page", kind: "discarded", reason: null, detail: { tab: 3 } });
});
