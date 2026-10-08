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
const CURRENT = { run: { id: "r1", step: 2 }, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] };
const tree = W.stateTree(MEMBERS, ENTRIES, CURRENT);
const values = async (expr) => { const r = await W.evalWatch(tree, expr); assert.equal(r.error, undefined, `${expr}: ${r.error}`); return r.nodes.map((n) => n.value); };

// --- the tree: each member where its name says ---

test("a member the model does not read sits at `inspector.<id>`; ml.current is the live snapshot itself, absent between turns", () => {
    assert.deepEqual(Object.keys(tree), ["ml", "inspector"]);
    assert.equal(tree.inspector.run.init.task, "count the widgets");
    assert.ok(!("think" in tree.inspector.run.init), "undefined is not JSON, so it is left out");
    assert.deepEqual(tree.ml.current, CURRENT, "the snapshot the model reads, not the panel's previews of it");
    assert.equal(tree.inspector.run.messages, undefined, "a member the model reads is not also under inspector");
    assert.deepEqual(Object.keys(W.stateTree(MEMBERS, ENTRIES)), ["inspector"], "no turn running: no ml.current");
    assert.deepEqual(tree.inspector.grants.turn.origins, ["https://a.test"]);
    assert.ok(!("broken" in tree.inspector.run) && !("empty" in tree.inspector.run));
});

// --- the expression: what the panel names and copies, or JSONPath ---

test("a copied path is a watch as it is, and so is any JSONPath", async () => {
    assert.deepEqual(await values("inspector.run.init.task"), ["count the widgets"]);
    assert.deepEqual(await values("ml.current.messages[1].content"), ["hello"]);
    assert.deepEqual(await values('inspector.run.init["tools"][0]'), ["exec"]);
    assert.deepEqual(await values("$.ml.current.messages[?@.role == 'user'].content"), ["hi"]);
    assert.deepEqual(await values("$..origins[0]"), ["https://a.test"]);
    assert.deepEqual(await values("  inspector.run.init.task  "), ["count the widgets"], "surrounding space is not part of it");
});

test("a match says where it is, so its rows can be copied and watched in turn", async () => {
    const { nodes } = await W.evalWatch(tree, "$.ml.current.messages[*].content");
    assert.deepEqual(nodes.map((n) => n.path), ["$['ml']['current']['messages'][0]['content']", "$['ml']['current']['messages'][1]['content']"]);
});

test("a path to nothing is no match, not an error: a member can empty and fill again", async () => {
    assert.deepEqual(await values("inspector.run.mailbox"), []);
    assert.deepEqual(await values("inspector.run.init.nope"), []);
});

test("an expression that is not a watch says why, rather than matching nothing", async () => {
    const why = async (expr) => (await W.evalWatch(tree, expr)).error;
    assert.match(await why(""), /empty/);
    assert.match(await why("run.init.task"), /starts at inspector\. or ml\.current\./, "a bare id is a typo, said as one");
    assert.match(await why("window.document"), /starts at/);
    assert.match(await why("ml.config"), /starts at/, "ml itself is not a root: only ml.current");
    assert.match(await why("$.inspector[?"), /./, "a malformed JSONPath is an error");
    assert.match(await why("x".repeat(W.MAX_WATCH_CHARS + 1)), /longer than/);
});

// --- bounds: the dialect's, so a watch cannot hang the panel ---

test("a watch that visits too much is stopped, with a sentence, and a backtracking regex is refused before it runs", async () => {
    const wide = W.stateTree([m("run.big")], [e(m("run.big"), Array.from({ length: 3000 }, (_, i) => ({ i, kids: Array.from({ length: 50 }, (_, j) => ({ j })) })))]);
    assert.match((await W.evalWatch(wide, "$..[?@..j]")).error, /stopped after visiting/);
    assert.ok((await W.evalWatch(wide, "inspector.run.big[0].i")).nodes, "a path through the same data is cheap");
    assert.match((await W.evalWatch(tree, "$..[?match(@.content, '(a+)+$')]")).error, /can run for hours/);
});

test("the list a panel sends: strings only, no duplicates, at most the cap", () => {
    assert.deepEqual(W.watchList(["a", 3, "a", null, "b"]), ["a", "b"]);
    assert.deepEqual(W.watchList("inspector.x"), []);
    assert.equal(W.watchList(Array.from({ length: 100 }, (_, i) => `w${i}`)).length, W.MAX_WATCHES);
});

test("a match's normalized path reads back as a panel path, and that path is a watch for the same value", async () => {
    assert.equal(W.panelPath("$['ml']['current']['messages'][0]['text']"), "ml.current.messages[0].text");
    assert.equal(W.panelPath("$['inspector']['run']['init']['a.b']"), 'inspector.run.init["a.b"]');
    assert.equal(W.panelPath("$['inspector']['it\\'s']"), `inspector["it's"]`);
    for (const n of (await W.evalWatch(tree, "$..content")).nodes) assert.deepEqual(await values(W.panelPath(n.path)), [n.value], n.path);
});

// --- JS watches: the read-only dialect, with `inspector` bound and ml.current the live snapshot ---

test("a JS watch is any dialect expression; a plain path keeps its path, a computed one has none", async () => {
    const { evalReadonly } = await import("../src/readonly-exec.ts");
    const { snapshotCurrent } = await import("../src/agent/current-context.ts");
    const current = snapshotCurrent({ run: { id: "r1", model: "m", step: 2, maxSteps: 5, startedTs: 0 }, messages: [{ role: "user", content: "hi" }], recorded: [], now: 1 });
    const js = async (code, inspector) => (await evalReadonly(code, null, {}, undefined, { realm: "worker", current, globals: { inspector }, stepBudget: 20_000 })).value;
    const t = W.stateTree(MEMBERS, ENTRIES, JSON.parse(JSON.stringify(current)));
    const ask = (expr) => W.evalWatch(t, expr, js);
    assert.deepEqual(await ask("inspector.run.init.task"), { expr: "inspector.run.init.task", value: "count the widgets", at: "inspector.run.init.task" });
    assert.deepEqual(await ask("inspector.run.init.tools.filter(t => t !== 'look')"), { expr: "inspector.run.init.tools.filter(t => t !== 'look')", value: ["exec"] });
    assert.equal((await ask("ml.current.messages.length")).value, 1, "ml.current is the model's own snapshot");
    assert.equal((await ask("ml.current.run.step")).value, 2);
    assert.equal((await ask('inspector.run["init"].task')).at, 'inspector.run["init"].task', "a quoted key is still a plain path");
    assert.match((await ask("run.init")).error, /run/, "a bare name is JavaScript's own error, not a silent nothing");
    assert.match((await ask("inspector.n = 1")).error, /assign/, "a watch cannot write");
    assert.ok((await ask("$.inspector.run.init.task")).nodes, "$ is still JSONPath");
});
