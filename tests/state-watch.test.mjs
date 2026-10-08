// Watches over a run's state (src/state-watch.ts): the expression a panel copies is a valid watch, the tree it reads puts
// each member where its name says, and a watch is held to the bounds the read-only dialect holds a model's JSONPath to.
import { test } from "node:test";
import assert from "node:assert/strict";

const W = await import("../src/state-watch.ts");

const m = (id, over = {}) => ({ id, realm: "worker", scope: "run", audience: "model", lostOn: [], describe: id, ...over });
const e = (member, value, over = {}) => ({ ...member, value, ...over });
const MEMBERS = [m("run.init"), m("run.messages", { exposedAs: "ml.current.messages" }), m("grants.turn", { audience: "human" }), m("run.broken"), m("run.empty")];
const ENTRIES = [
    e(MEMBERS[0], { task: "count the widgets", think: undefined, tools: ["exec", "look"] }),
    e(MEMBERS[1], [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]),
    e(MEMBERS[2], { origins: ["https://a.test"] }),
    e(MEMBERS[3], undefined, { error: "gone" }),
];
const tree = W.stateTree(MEMBERS, ENTRIES);
const values = (expr) => { const r = W.evalWatch(tree, expr); assert.equal(r.error, undefined, `${expr}: ${r.error}`); return r.nodes.map((n) => n.value); };

// --- the tree: each member where its name says ---

test("a member sits at its expression: `inspector.<id>` nested by its dots, or its ml.current path; failed and empty ones are absent", () => {
    assert.deepEqual(Object.keys(tree), ["ml", "inspector"]);
    assert.equal(tree.inspector.run.init.task, "count the widgets");
    assert.ok(!("think" in tree.inspector.run.init), "undefined is not JSON, so it is left out");
    assert.equal(tree.ml.current.messages.length, 2);
    assert.equal(tree.inspector.run.messages, undefined, "not also under inspector");
    assert.deepEqual(tree.inspector.grants.turn.origins, ["https://a.test"]);
    assert.ok(!("broken" in tree.inspector.run) && !("empty" in tree.inspector.run));
});

// --- the expression: what the panel names and copies, or JSONPath ---

test("a copied path is a watch as it is, and so is any JSONPath", () => {
    assert.deepEqual(values("inspector.run.init.task"), ["count the widgets"]);
    assert.deepEqual(values("ml.current.messages[1].text"), ["hello"]);
    assert.deepEqual(values('inspector.run.init["tools"][0]'), ["exec"]);
    assert.deepEqual(values("$.ml.current.messages[?@.role == 'user'].text"), ["hi"]);
    assert.deepEqual(values("$..origins[0]"), ["https://a.test"]);
    assert.deepEqual(values("  inspector.run.init.task  "), ["count the widgets"], "surrounding space is not part of it");
});

test("a match says where it is, so its rows can be copied and watched in turn", () => {
    const { nodes } = W.evalWatch(tree, "$.ml.current.messages[*].text");
    assert.deepEqual(nodes.map((n) => n.path), ["$['ml']['current']['messages'][0]['text']", "$['ml']['current']['messages'][1]['text']"]);
});

test("a path to nothing is no match, not an error: a member can empty and fill again", () => {
    assert.deepEqual(values("inspector.run.mailbox"), []);
    assert.deepEqual(values("inspector.run.init.nope"), []);
});

test("an expression that is not a watch says why, rather than matching nothing", () => {
    const why = (expr) => W.evalWatch(tree, expr).error;
    assert.match(why(""), /empty/);
    assert.match(why("run.init.task"), /starts at inspector\. or ml\.current\./, "a bare id is a typo, said as one");
    assert.match(why("window.document"), /starts at/);
    assert.match(why("ml.config"), /starts at/, "ml itself is not a root: only ml.current");
    assert.match(why("$.inspector[?"), /./, "a malformed JSONPath is an error");
    assert.match(why("x".repeat(W.MAX_WATCH_CHARS + 1)), /longer than/);
});

// --- bounds: the dialect's, so a watch cannot hang the panel ---

test("a watch that visits too much is stopped, with a sentence, and a backtracking regex is refused before it runs", () => {
    const wide = W.stateTree([m("run.big")], [e(m("run.big"), Array.from({ length: 3000 }, (_, i) => ({ i, kids: Array.from({ length: 50 }, (_, j) => ({ j })) })))]);
    assert.match(W.evalWatch(wide, "$..[?@..j]").error, /stopped after visiting/);
    assert.ok(W.evalWatch(wide, "inspector.run.big[0].i").nodes, "a path through the same data is cheap");
    assert.match(W.evalWatch(tree, "$..[?match(@.text, '(a+)+$')]").error, /can run for hours/);
});

test("the list a panel sends: strings only, no duplicates, at most the cap", () => {
    assert.deepEqual(W.watchList(["a", 3, "a", null, "b"]), ["a", "b"]);
    assert.deepEqual(W.watchList("inspector.x"), []);
    assert.equal(W.watchList(Array.from({ length: 100 }, (_, i) => `w${i}`)).length, W.MAX_WATCHES);
});

test("a match's normalized path reads back as a panel path, and that path is a watch for the same value", () => {
    assert.equal(W.panelPath("$['ml']['current']['messages'][0]['text']"), "ml.current.messages[0].text");
    assert.equal(W.panelPath("$['inspector']['run']['init']['a.b']"), 'inspector.run.init["a.b"]');
    assert.equal(W.panelPath("$['inspector']['it\\'s']"), `inspector["it's"]`);
    for (const n of W.evalWatch(tree, "$..text").nodes) assert.deepEqual(values(W.panelPath(n.path)), [n.value], n.path);
});
