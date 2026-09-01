// The pure answer-set core (answer-set.ts): the ordered, curatable user-facing result of a run.
import { test } from "node:test";
import assert from "node:assert";
import { AnswerSet, answerItemFromString, TOOL_TOKEN_PREFIX, makeAnswerFacade, finalizeAnswer, resolveOutputs } from "../answer-set.ts";

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

// --- finalizeAnswer: the bottom-of-answer render (DESIGNATED outputs only, dedup vs inline) -------------
test("finalizeAnswer: a DESIGNATED token renders at the bottom (with the model's caption)", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "per-region totals"));
    // No inline citation in the prose → the designated output stays.
    const md = finalizeAnswer(set, "Here are the numbers.");
    assert.equal(md, "![per-region totals](@tool:aaaaaa:out)");
});

test("finalizeAnswer: DEDUP — a token cited INLINE in the prose is dropped from the bottom", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "totals"));
    // The model already expanded @tool:aaaaaa inline → don't ALSO append it (redundant).
    const md = finalizeAnswer(set, "The totals are [totals](@tool:aaaaaa:out).");
    assert.equal(md, "", "the inline-cited output is not repeated at the bottom");
});

test("finalizeAnswer: a DESIGNATED token NOT cited inline still renders (only the cited one dedupes)", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "A"));
    set.add(answerItemFromString("@tool:bbbbbb:out", "B"));
    const md = finalizeAnswer(set, "See [A](@tool:aaaaaa:out).");
    assert.equal(md, "![B](@tool:bbbbbb:out)", "A dedupes (inline), B stays (bottom)");
});

test("finalizeAnswer: NO auto-promotion — an uncited output is NEVER surfaced under the answer", () => {
    // The invariant: we don't promote something the model didn't designate to a user-facing Result. A run
    // that computed a table but only wrote prose (designating nothing, citing nothing) → an EMPTY bottom,
    // even though a `@tool:` id was minted for that step. If the model wanted it shown it had to cite it.
    assert.equal(finalizeAnswer(new AnswerSet(), "The top rep is Gia with 850."), "", "no scratchpad calc leaks into the answer");
});

test("finalizeAnswer: pure-prose answer → empty (nothing hidden, nothing invented)", () => {
    assert.equal(finalizeAnswer(new AnswerSet(), "It's a login page."), "");
});

test("finalizeAnswer: MULTIPLE designated outputs all render, stacked, each deduped vs inline", () => {
    const set = new AnswerSet();
    set.add(answerItemFromString("@tool:aaaaaa:out", "sales"));
    set.add(answerItemFromString("@tool:bbbbbb:out", "regions"));
    set.add({ kind: "text", text: "Summary: two tables." });
    // bbbbbb is inline-cited → only aaaaaa + the text stay at the bottom.
    const md = finalizeAnswer(set, "Regions here [r](@tool:bbbbbb:out).");
    assert.equal(md, "![sales](@tool:aaaaaa:out)\n\nSummary: two tables.");
});

test("answerItemFromString: a note becomes the token caption; plain text ignores note", () => {
    assert.deepEqual(answerItemFromString("@tool:aaaaaa:out", "cap"), { kind: "token", ref: "@tool:aaaaaa:out", preview: "cap" });
    assert.deepEqual(answerItemFromString("hello", "cap"), { kind: "text", text: "hello" });
});

// --- resolveOutputs: the structured JS payload (res.outputs) for HEADLESS scripting ---------------------
test("resolveOutputs: a designated DataFrame → a { kind:'table', columns, rows } 2D matrix", () => {
    const renders = [{ id: "aaaaaa", tool: "python_exec", render: { type: "python-out", df: { columns: ["Rep", "Total"], rows: [["Gia", 850], ["Kim", 810]] } } }];
    const outs = resolveOutputs("[top reps](@tool:aaaaaa:out)", "The top rep is Gia.", renders);
    assert.deepEqual(outs, [{ id: "aaaaaa", tool: "python_exec", kind: "table", columns: ["Rep", "Total"], rows: [["Gia", 850], ["Kim", 810]] }]);
});

test("resolveOutputs: a python dict/list value is PARSED to the real JS object (not a stringified blob)", () => {
    const renders = [{ id: "bbbbbb", tool: "python_exec", render: { type: "python-out", value: '{"grand": 6260, "regions": ["East", "West"]}' } }];
    const outs = resolveOutputs("[stats](@tool:bbbbbb:out)", "done", renders);
    assert.deepEqual(outs[0], { id: "bbbbbb", tool: "python_exec", kind: "value", value: { grand: 6260, regions: ["East", "West"] } });
    // a NON-json value stays a string
    assert.equal(resolveOutputs("[v](@tool:cccccc:out)", "", [{ id: "cccccc", tool: "exec", result: "just text" }])[0].value, "just text");
});

test("resolveOutputs: INLINE cites + BOTTOM designations both resolve, in appearance order, deduped", () => {
    const renders = [
        { id: "aaaaaa", tool: "exec", result: "42" },
        { id: "bbbbbb", tool: "python_exec", render: { type: "python-out", df: { columns: ["x"], rows: [[1]] } } },
    ];
    // inline cite of aaaaaa in the prose; bbbbbb designated at the bottom.
    const outs = resolveOutputs("[table](@tool:bbbbbb:out)", "The count is [n](@tool:aaaaaa:out).", renders);
    assert.deepEqual(outs.map(o => o.id), ["aaaaaa", "bbbbbb"], "prose (inline) first, then the bottom; deduped by id");
    assert.equal(outs[0].kind, "value"); assert.equal(outs[0].value, "42");
    assert.equal(outs[1].kind, "table");
});

test("resolveOutputs: an ELEMENTS output → serialized item previews (live nodes stay in res.elements)", () => {
    const renders = [{ id: "cccccc", tool: "exec", render: { type: "elements", items: [{ path: "div#a", text: "A" }, { path: "div#b" }] } }];
    assert.deepEqual(resolveOutputs("[els](@tool:cccccc:out)", "found", renders)[0],
        { id: "cccccc", tool: "exec", kind: "elements", items: [{ path: "div#a", text: "A" }, { path: "div#b" }] });
});

test("resolveOutputs: an image → a data URL; code → its text; a hallucinated id is skipped", () => {
    const renders = [
        { id: "dddddd", tool: "look", render: { type: "look", image: "data:image/png;base64,AAAA" } },
        { id: "eeeeee", tool: "exec", render: { type: "code", text: "1 + 1", lang: "javascript" } },
    ];
    assert.deepEqual(resolveOutputs("[shot](@tool:dddddd:out)", "", renders)[0], { id: "dddddd", tool: "look", kind: "image", dataUrl: "data:image/png;base64,AAAA" });
    assert.deepEqual(resolveOutputs("[src](@tool:eeeeee:in)", "", renders)[0], { id: "eeeeee", tool: "exec", kind: "code", text: "1 + 1", lang: "javascript" });
    assert.deepEqual(resolveOutputs("[gone](@tool:zzzzzz:out)", "", []), [], "a hallucinated token → nothing, no crash");
});
