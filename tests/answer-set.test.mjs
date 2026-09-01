// The pure answer-set core (answer-set.ts): the ordered, curatable user-facing result of a run.
import { test } from "node:test";
import assert from "node:assert";
import { AnswerSet, answerItemFromString, TOOL_TOKEN_PREFIX, makeAnswerFacade } from "../answer-set.ts";

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
