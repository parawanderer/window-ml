// The pure answer-set core (answer-set.ts): the ordered, curatable user-facing result of a run.
import { test } from "node:test";
import assert from "node:assert";
import { AnswerSet, answerItemFromString, TOOL_TOKEN_PREFIX, makeAnswerFacade, finalizeAnswer } from "../answer-set.ts";

const el = (nodes, preview, extra = {}) => ({ kind: "element", nodes, preview, ...extra });
const txt = (text) => ({ kind: "text", text });
const tok = (ref, preview) => ({ kind: "token", ref, preview });

test("add appends and returns the index; length tracks", () => {
    const a = new AnswerSet();
    assert.equal(a.length, 0);
    assert.equal(a.add(txt("one")), 0);
    assert.equal(a.add(txt("two")), 1);
    assert.equal(a.length, 2);
});

test("remove by index returns 1 and drops that item; out-of-range returns 0", () => {
    const a = new AnswerSet();
    a.add(txt("a")); a.add(txt("b")); a.add(txt("c"));
    assert.equal(a.remove(1), 1);
    assert.deepEqual(a.items.map(i => i.text), ["a", "c"]);
    assert.equal(a.remove(9), 0, "an out-of-range index removes nothing");
    assert.equal(a.remove(-1), 0);
});

test("remove by string matches a token ref or exact text", () => {
    const a = new AnswerSet();
    a.add(tok("@tool:35bf1f:out", "table")); a.add(txt("keep me")); a.add(txt("drop me"));
    assert.equal(a.remove("@tool:35bf1f:out"), 1, "token removed by ref");
    assert.equal(a.remove("drop me"), 1, "text removed by exact match");
    assert.deepEqual(a.items.map(i => i.text), ["keep me"]);
});

test("remove by predicate can drop several, and indices stay valid (high→low splice)", () => {
    const a = new AnswerSet();
    a.add(txt("x")); a.add(el([{}], "a")); a.add(txt("y")); a.add(el([{}], "b"));
    assert.equal(a.remove(it => it.kind === "element"), 2, "both element items removed");
    assert.deepEqual(a.items.map(i => i.text), ["x", "y"]);
});

test("clear empties the set", () => {
    const a = new AnswerSet();
    a.add(txt("a")); a.add(txt("b"));
    a.clear();
    assert.equal(a.length, 0);
});

test("dump gives indexed views with a truncated preview", () => {
    const a = new AnswerSet();
    a.add(txt("short"));
    a.add(txt("x".repeat(100)));
    a.add(tok("@tool:ab12:out", "DataFrame 40×12"));
    const d = a.dump();
    assert.deepEqual(d[0], { i: 0, kind: "text", preview: "short" });
    assert.ok(d[1].preview.endsWith("…") && d[1].preview.length <= 80, "long text is truncated");
    assert.match(d[2].preview, /@tool:ab12:out — DataFrame 40×12/);
});

test("elements() flattens element nodes in order; media() flattens media", () => {
    const a = new AnswerSet();
    a.add(el(["n1", "n2"], "two", { media: [{ image: "d1" }] }));
    a.add(txt("ignored for nodes"));
    a.add(el(["n3"], "one", { media: [{ image: "d2" }] }));
    assert.deepEqual(a.elements(), ["n1", "n2", "n3"]);
    assert.deepEqual(a.media().map(m => m.image), ["d1", "d2"]);
});

test("answerItemFromString: @tool: → token, anything else → text", () => {
    assert.deepEqual(answerItemFromString("@tool:35bf1f:out"), { kind: "token", ref: "@tool:35bf1f:out" });
    assert.deepEqual(answerItemFromString("Total: 42"), { kind: "text", text: "Total: 42" });
    // A CSS-selector-looking string is treated as literal text (selectors reach the tool's `selector`
    // param, not ml.answer.add — which takes live Elements in exec), so no @tool: collision to worry about.
    assert.deepEqual(answerItemFromString("table#sales"), { kind: "text", text: "table#sales" });
    assert.equal(TOOL_TOKEN_PREFIX, "@tool:");
});

test("toMarkdown: text verbatim, element as a bullet, token as a link; empty → ''", () => {
    assert.equal(new AnswerSet().toMarkdown(), "");
    const a = new AnswerSet();
    a.add(txt("The total is 42."));
    a.add(el([{}], "table#sales", { note: "the sales table" }));
    a.add(tok("@tool:35bf1f:out", "DataFrame"));
    const md = a.toMarkdown();
    assert.match(md, /The total is 42\./);
    assert.match(md, /- the sales table: table#sales/);
    assert.match(md, /\[DataFrame\]\(@tool:35bf1f:out\)/);
});

test("makeAnswerFacade: classifies element vs @tool vs text; dump/toJSON are compact; length reflects", () => {
    const set = new AnswerSet();
    const el = { nodeType: 1, id: "banner" };
    const f = makeAnswerFacade(set, e => e.id || "el");
    assert.equal(f.add(el), 0);                       // an Element → element item
    assert.equal(f.add("@tool:ab12:out"), 1);         // @tool: string → token
    assert.equal(f.add("plain text"), 2);             // other string → text
    assert.equal(f.add(42), 3);                       // non-string/element → coerced to text
    assert.equal(f.length, 4);
    assert.deepEqual(set.items.map(i => i.kind), ["element", "token", "text", "text"]);
    // toJSON (returning `ml.answer` bare) === dump; both compact, no nodes/media
    assert.deepEqual(f.dump(), f.toJSON());
    assert.equal(f.dump()[0].preview, "banner");
    assert.ok(!JSON.stringify(f).includes("nodeType"), "serializing the facade never leaks the node");
    // curation
    assert.equal(f.remove(0), 1); assert.equal(f.length, 3);
    f.clear(); assert.equal(f.length, 0);
});

test("makeAnswerFacade: an array of elements becomes ONE element item", () => {
    const set = new AnswerSet();
    const f = makeAnswerFacade(set);
    f.add([{ nodeType: 1 }, { nodeType: 1 }]);
    assert.equal(set.length, 1);
    assert.equal(set.items[0].kind, "element");
    assert.equal(set.items[0].nodes.length, 2);
});

// --- finalizeAnswer: the bottom-of-answer render (designate + auto-fallback, dedup vs inline) -----------
test("finalizeAnswer: a DESIGNATED token renders at the bottom (with the model's caption)", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "per-region totals"));
    // No inline citation in the prose → the designated output stays.
    const md = finalizeAnswer(set, "Here are the numbers.", []);
    assert.equal(md, "[per-region totals](@tool:aaaaaa:out)");
});

test("finalizeAnswer: DEDUP — a token cited INLINE in the prose is dropped from the bottom", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "totals"));
    // The model already expanded @tool:aaaaaa inline → don't ALSO append it (redundant).
    const md = finalizeAnswer(set, "The totals are [totals](@tool:aaaaaa:out).", []);
    assert.equal(md, "", "the inline-cited output is not repeated at the bottom");
});

test("finalizeAnswer: a DESIGNATED token NOT cited inline still renders (only the cited one dedupes)", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "A"));
    set.add(answerItemFromString("@tool:bbbbbb:out", "B"));
    const md = finalizeAnswer(set, "See [A](@tool:aaaaaa:out).", []);
    assert.equal(md, "[B](@tool:bbbbbb:out)", "A dedupes (inline), B stays (bottom)");
});

test("finalizeAnswer: AUTO-FALLBACK — no designation + no inline cite + a candidate → the primary output is appended", () => {
    const set = new AnswerSet();
    const cands = [{ token: "cccccc", tool: "python_exec", seq: 1 }, { token: "dddddd", tool: "python_exec", seq: 3, label: "top 5 reps" }];
    // The model wrote a prose answer and cited nothing → surface its LAST computed output.
    const md = finalizeAnswer(set, "The top rep is Gia with 850.", cands);
    assert.equal(md, "[top 5 reps](@tool:dddddd:out)", "the LAST candidate is the run's answer");
});

test("finalizeAnswer: NO auto-fallback when the model cited inline (it already surfaced its output)", () => {
    const set = new AnswerSet();
    const cands = [{ token: "cccccc", tool: "python_exec", seq: 1 }];
    const md = finalizeAnswer(set, "Result: [it](@tool:cccccc:out).", cands);
    assert.equal(md, "", "an inline cite suppresses the auto-fallback");
});

test("finalizeAnswer: NO auto-fallback when the model DESIGNATED an output (its choice wins)", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "the table"));
    const cands = [{ token: "cccccc", tool: "python_exec", seq: 9 }];
    const md = finalizeAnswer(set, "Done.", cands);
    assert.equal(md, "[the table](@tool:aaaaaa:out)", "designation wins; the fallback candidate is not also appended");
});

test("finalizeAnswer: pure-prose answer with NO candidates → empty (nothing hidden, nothing invented)", () => {
    assert.equal(finalizeAnswer(new AnswerSet(), "It's a login page.", []), "");
});

test("finalizeAnswer: MULTIPLE designated outputs all render, stacked, each deduped vs inline", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "sales"));
    set.add(answerItemFromString("@tool:bbbbbb:out", "regions"));
    set.add({ kind: "text", text: "Summary: two tables." });
    // bbbbbb is inline-cited → only aaaaaa + the text stay at the bottom.
    const md = finalizeAnswer(set, "Regions here [r](@tool:bbbbbb:out).", []);
    assert.equal(md, "[sales](@tool:aaaaaa:out)\n\nSummary: two tables.");
});

test("answerItemFromString: a note becomes the token caption; plain text ignores note", () => {
    assert.deepEqual(answerItemFromString("@tool:aaaaaa:out", "cap"), { kind: "token", ref: "@tool:aaaaaa:out", preview: "cap" });
    assert.deepEqual(answerItemFromString("hello", "cap"), { kind: "text", text: "hello" });
});
