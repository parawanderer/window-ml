"use strict";
// output-clip.test.mjs — the panel's copy of long streamed output (src/agent/output-clip.ts): past the cap it keeps
// the start the model read and the LATEST output, like a terminal, with the gap counted where it is. The live stream
// fan (agent-loop.ts) builds the same text a chunk at a time, so a step's output keeps its shape when it lands.
import { test } from "node:test";
import assert from "node:assert";
import { clipHeadTail, gapNote, panelHead, tailStart } from "../src/agent/output-clip.ts";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { UI_OUT_CAP } from "../src/contract/contract-chat.ts";
import { OUTPUT_CAP } from "../src/contract/contract-pointers.ts";

const lines = (n, width = 50) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(width - 10)}`);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the clip: the start, the latest, and the gap between them ------------------------------------------------------

test("output under the cap is untouched", () => {
    const t = lines(10).join("\n");
    assert.equal(clipHeadTail(t, 1000, 100), t);
});

test("past the cap: the head is kept exactly, the tail is the LATEST from a line start, and the gap counts what is gone", () => {
    const all = lines(400);
    const t = all.join("\n");
    const out = clipHeadTail(t, UI_OUT_CAP, 500);
    assert.equal(out.slice(0, 500), t.slice(0, 500), "the first 500 characters, the part the model read");
    assert.ok(out.endsWith(all.at(-1)), "the newest line is the last thing shown");
    const m = /\n… \[(\d+) chars dropped here\] …\n/.exec(out);
    assert.ok(m, "one gap note, on a line of its own");
    const tail = out.slice(m.index + m[0].length);
    assert.ok(all.includes(tail.split("\n")[0]), "the tail opens on a whole line, never half of one");
    assert.equal(500 + Number(m[1]) + tail.length, t.length, "kept + dropped is the whole");
    assert.ok(500 + tail.length <= UI_OUT_CAP, "and no more than the cap is kept");
});

test("one giant line has no line start to snap to: its tail is the last characters", () => {
    const t = "a".repeat(100) + "b".repeat(100);
    assert.equal(clipHeadTail(t, 50, 10), "a".repeat(10) + gapNote(150) + "b".repeat(40));
});

test("a head of 0 is a pure terminal tail", () => {
    const all = lines(100);
    const out = clipHeadTail(all.join("\n"), 1000, 0);
    assert.ok(out.startsWith("\n… ["), "the note opens the copy");
    assert.ok(out.endsWith(all.at(-1)));
});

test("the head is the model's cut, but never more than half the cap", () => {
    assert.equal(panelHead(OUTPUT_CAP.exec.default), 500);
    assert.equal(panelHead(OUTPUT_CAP.python_exec.ceiling), UI_OUT_CAP / 2, "a raised python cut still leaves half for the latest");
    assert.equal(panelHead(undefined), 0, "a tool without a model cut keeps no head");
});

test("tailStart: a window that already starts a line is kept whole; otherwise from the first line start in it", () => {
    assert.equal(tailStart("abc\ndef", true), 0);
    assert.equal(tailStart("abc\ndef", false), 4);
    assert.equal(tailStart("abcdef", false), 0, "no line start: from the first character");
    assert.equal(tailStart("abcdef\n", false), 0, "a newline as the LAST character starts no line inside the window");
});

// --- the live fan builds the same copy the settled view clips -------------------------------------------------------

/** One exec call whose tool pushes `chunks`, then waits past the fan's throttle so the last emit lands. */
async function streamThroughLoop(chunks, { tool = "exec", args = {} } = {}) {
    const emits = [];
    let i = 0;
    const turns = [{ content: "", tool_calls: [{ id: "c1", name: tool, arguments: args }] }, { content: "done", tool_calls: [] }];
    await runAgentLoop("x", { tools: [{ name: tool }], stream: true }, {
        callModel: async () => turns[i++],
        runTool: async (_n, _a, onStream) => { chunks.forEach((c, k) => onStream(c, 1000 + k)); await tick(150); return { result: "ok" }; },
        approve: async () => true,
        buildMessages: (t) => [{ role: "user", content: t }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        emit: (ev) => emits.push(ev),
    });
    return emits.filter((e) => e.streamOutput != null && e.tool == null).at(-1);
}

test("LIVE = SETTLED: an exec streaming past the cap shows exactly the text its finished view will clip to", async () => {
    const all = lines(400);
    const live = await streamThroughLoop(all.map((l) => l + "\n"));
    const settled = clipHeadTail(all.join("\n"), UI_OUT_CAP, panelHead(OUTPUT_CAP.exec.default));
    // The stream ends each line with a newline and the settled copy does not; everything else is the same text.
    assert.equal(live.streamOutput, settled + "\n");
    assert.ok(live.streamOutput.trimEnd().endsWith(all.at(-1)), "the latest line is visible while it runs");
});

test("a RAISED exec cut moves the head with it, live and settled alike", async () => {
    const all = lines(400);
    const args = { maxChars: 4000, maxCharsReason: "need it" };
    const live = await streamThroughLoop(all.map((l) => l + "\n"), { args });
    assert.equal(live.streamOutput, clipHeadTail(all.join("\n"), UI_OUT_CAP, 4000) + "\n");
});

test("stamps survive the gap: every mark sits on a line start, the head's keep their offsets, the newest line keeps its own", async () => {
    const all = lines(400);
    const live = await streamThroughLoop(all.map((l) => l + "\n"));
    const text = live.streamOutput, marks = live.streamMarks;
    for (const [o] of marks) assert.ok(o === 0 || text[o - 1] === "\n", `mark at ${o} is on a line start`);
    assert.deepEqual(marks[0], [0, 1000], "the first line keeps its stamp");
    const lastLineAt = text.lastIndexOf(all.at(-1));
    assert.deepEqual(marks.find(([o]) => o === lastLineAt), [lastLineAt, 1000 + all.length - 1], "the newest line is stamped with its own time");
    const note = text.indexOf("\n… [");
    const firstTail = text.indexOf("\n", note + 1) + 1;
    assert.ok(marks.some(([o]) => o === firstTail), "the tail's first line has a stamp");
    assert.ok(marks.length < 300, `bounded: the dropped lines' stamps are gone (${marks.length})`);
});

test("a tool with no model cut streams a pure terminal tail", async () => {
    const all = lines(400);
    const live = await streamThroughLoop(all.map((l) => l + "\n"), { tool: "srv__long_job" });
    assert.ok(live.streamOutput.startsWith("\n… ["));
    assert.ok(live.streamOutput.trimEnd().endsWith(all.at(-1)));
});

test("under the cap, streaming is unchanged: the whole output, one stamp per chunk", async () => {
    const live = await streamThroughLoop(["one\n", "two\n"]);
    assert.equal(live.streamOutput, "one\ntwo\n");
    assert.deepEqual(live.streamMarks, [[0, 1000], [4, 1001]]);
});

test("a read-only survey's settled console keeps the latest lines too", async () => {
    const { formatReadonlyExec } = await import("../src/agent/approval.ts");
    const all = lines(400);
    const { render } = formatReadonlyExec(1, all);
    assert.equal(render.stdout, clipHeadTail(all.join("\n"), UI_OUT_CAP, 500));
    assert.ok(render.stdout.endsWith(all.at(-1)));
});
