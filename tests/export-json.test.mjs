"use strict";
// The JSON export: the machine-readable run format. Unlike the markdown/PDF sinks this
// serializes the Session directly, so these tests are about FIDELITY (nothing invented,
// nothing silently dropped) rather than layout. Schema: export-schema.ts (root, beside contract.ts).
import { test } from "node:test";
import assert from "node:assert";
const { sessionToJson, serializeSessionJson } = await import("../src/sidebar/export-json.ts");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const usage = (p, c) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c });

const agentSession = (over = {}) => ({
    hash: "abc12345", kind: "agent", model: "gemma4:31b", tag: "session",
    createdTs: 1_700_000_000_000, lastTs: 1_700_000_009_000, status: "ok",
    config: {}, turns: [], task: "count the rows",
    maxSteps: 20,
    steps: [
        { step: 1, seq: 1, ts: 1_700_000_001_000, thought: "I should look", usage: usage(100, 20) },
        { step: 1, seq: 2, ts: 1_700_000_002_000, toolMs: 812, tool: "exec",
          arguments: { js: "document.querySelectorAll('tr').length" },
          result: "42", usage: usage(10, 5) },
        { step: 2, seq: 3, ts: 1_700_000_003_000, tool: "answer", arguments: { text: "42" }, result: "ok" },
    ],
    answers: [{ text: "42 rows", ts: 1_700_000_009_000, atStep: 3, status: "ok" }],
    summary: "42 rows",
    ...over,
});

test("agent run: every step survives, ordered by seq, with arguments verbatim", () => {
    const doc = sessionToJson(agentSession());

    assert.equal(doc.schema, 1);
    assert.equal(doc.session.kind, "agent");
    assert.deepEqual(doc.session.steps.map(s => s.seq), [1, 2, 3]);
    // the model's arguments are not normalised, re-keyed or stringified
    assert.deepEqual(doc.session.steps[1].arguments, { js: "document.querySelectorAll('tr').length" });
    assert.equal(doc.session.steps[1].tool, "exec");
    assert.equal(doc.session.steps[1].durationMs, 812, "toolMs surfaces as durationMs");
});

test("steps arrive sorted even when the session holds them out of order", () => {
    const s = agentSession();
    s.steps = [s.steps[2], s.steps[0], s.steps[1]];
    assert.deepEqual(sessionToJson(s).session.steps.map(x => x.seq), [1, 2, 3]);
});

test("transient view state is not exported: a pending step is absent, and so is an approval gate", () => {
    const s = agentSession();
    s.steps = [...s.steps,
        { step: 3, seq: 4, tool: "click", pending: true },
        { step: 3, seq: 5, tool: "python_exec", awaitingApproval: true }];

    const steps = sessionToJson(s).session.steps;
    assert.equal(steps.length, 3, "only completed steps are records of what happened");
    assert.ok(!steps.some(x => "pending" in x || "awaitingApproval" in x));
});

test("a step whose model-facing result differs keeps BOTH (the raw-view rule)", () => {
    const s = agentSession();
    s.steps[1].result = "42\n…lots more the UI kept…";
    s.steps[1].modelResult = "42";

    const st = sessionToJson(s).session.steps[1];
    assert.equal(st.result, "42\n…lots more the UI kept…");
    assert.equal(st.modelResult, "42", "what the model actually saw is recoverable");
});

test("an identical modelResult is omitted rather than duplicated", () => {
    const s = agentSession();
    s.steps[1].modelResult = s.steps[1].result;
    assert.ok(!("modelResult" in sessionToJson(s).session.steps[1]));
});

test("outcome gathers the run flags, and turnsRun counts distinct steps not records", () => {
    const doc = sessionToJson(agentSession({ hitCap: true }));
    const o = doc.session.outcome;

    // 3 step records across 2 loop turns — .length would over-count against maxSteps
    assert.equal(doc.session.steps.length, 3);
    assert.equal(o.turnsRun, 2);
    assert.equal(o.hitCap, true);
    // flags are always present, so a consumer needs no defaulting
    assert.equal(o.cancelled, false);
    assert.equal(o.resumed, false);
    assert.equal(o.error, null);
});

test("totals sum the parts, and attribute per model", () => {
    const t = sessionToJson(agentSession()).session.totals;
    assert.equal(t.steps, 3);
    assert.equal(t.tokensIn, 110);
    assert.equal(t.tokensOut, 25);
    assert.equal(t.wallMs, 9000);
    assert.deepEqual(t.byModel, [{ model: "gemma4:31b", calls: 2, tokensIn: 110, tokensOut: 25 }]);
});

test("delegated sub-call tokens are counted apart from the run's own", () => {
    const s = agentSession();
    s.steps[1].subUsage = { prompt: 700, completion: 30, calls: 1 };

    const t = sessionToJson(s).session.totals;
    assert.equal(t.subcallTokens, 730);
    assert.equal(t.tokensIn, 110, "a sub-call does not inflate the driver's own prompt tokens");
});

test("agent messages interleave the task, follow-ups and answers in the order they happened", () => {
    const s = agentSession({
        says: [{ text: "now sort it", ts: 1_700_000_005_000, atStep: 3 }],
        answers: [
            { text: "42 rows", ts: 1_700_000_004_000, atStep: 3, status: "ok" },
            { text: "sorted", ts: 1_700_000_008_000, atStep: 6, status: "ok" },
        ],
    });

    const m = sessionToJson(s).session.messages;
    assert.deepEqual(m.map(x => x.role), ["assistant", "user", "assistant"]);
    assert.deepEqual(m.map(x => x.text), ["42 rows", "now sort it", "sorted"]);
});

test("a run with no recorded per-turn answers still exports its task and final answer", () => {
    const s = agentSession({ says: undefined, answers: undefined });
    const m = sessionToJson(s).session.messages;
    assert.deepEqual(m.map(x => x.role), ["user", "assistant"]);
    assert.equal(m[0].text, "count the rows");
    assert.equal(m[1].text, "42 rows");
});

test("chat session: turns become user/assistant pairs with model provenance and usage", () => {
    const doc = sessionToJson({
        hash: "def", kind: undefined, model: "m", tag: "session",
        createdTs: 1000, lastTs: 3000, status: "ok", config: { save: true },
        turns: [{ id: "t1", ts: 2000, user: "hi", images: null, assistant: "hello",
                  model: "qwen3:32b", extend: "utility", usage: usage(7, 3), status: "ok" }],
    });

    assert.equal(doc.session.kind, "chat");
    assert.ok(!("steps" in doc.session), "a chat has no steps key at all");
    assert.deepEqual(doc.session.messages.map(m => m.role), ["user", "assistant"]);
    assert.equal(doc.session.messages[1].model, "qwen3:32b");
    assert.equal(doc.session.messages[1].extend, "utility");
    assert.equal(doc.session.totals.tokensIn, 7);
    assert.deepEqual(doc.session.totals.byModel, [{ model: "qwen3:32b", calls: 1, tokensIn: 7, tokensOut: 3 }]);
});

test("a turn still awaiting its reply exports only the user half", () => {
    const doc = sessionToJson({
        hash: "def", model: "m", tag: "session", createdTs: 1000, lastTs: 2000,
        status: "pending", config: {},
        turns: [{ id: "t1", ts: 2000, user: "hi", images: null, status: "pending" }],
    });
    assert.deepEqual(doc.session.messages.map(m => m.role), ["user"],
        "an empty assistant message would read as 'it said nothing'");
});

test("images ride inline as data URLs, so the export is one file", () => {
    const s = agentSession({ taskImages: [PNG] });
    s.steps[1].renderOut = { type: "image", src: PNG };

    const doc = sessionToJson(s);
    assert.deepEqual(doc.session.taskImages, [PNG]);
    assert.equal(doc.session.steps[1].renderOut.src, PNG);
});

test("absent means absent: optional fields are omitted, never null", () => {
    const doc = sessionToJson(agentSession());
    const thought = doc.session.steps[0];

    assert.ok(!("tool" in thought), "a thought-only step has no tool key");
    assert.ok(!("result" in thought));
    assert.ok(!("title" in doc.session), "no AI title was generated");
    // the one deliberate exception, so consumers need no defaulting
    assert.equal(doc.session.outcome.error, null);
});

test("serializing twice produces byte-identical output apart from exportedAt", () => {
    const s = agentSession();
    const strip = (t) => t.replace(/"exportedAt": "[^"]+"/, '"exportedAt": "X"');
    assert.equal(strip(serializeSessionJson(s)), strip(serializeSessionJson(s)),
        "stable key order is what makes two exports diffable");
});

test("the file body is valid JSON and ends with a newline", () => {
    const text = serializeSessionJson(agentSession());
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(text.endsWith("\n"));
});

// Real runs emit several records per loop turn (a thought, then the tool it chose) sharing
// one `seq`, so sorting must not reorder them relative to each other.
test("records sharing a seq keep their original order", () => {
    const s = agentSession();
    s.steps = [
        { step: 1, seq: 1, thought: "first" },
        { step: 1, seq: 1, tool: "exec", result: "second" },
        { step: 2, seq: 2, thought: "third" },
    ];
    const steps = sessionToJson(s).session.steps;
    assert.deepEqual(steps.map(x => x.thought ?? x.result), ["first", "second", "third"]);
});
