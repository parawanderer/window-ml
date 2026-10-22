// prompt-pin.test.mjs — which message the panel's prompt pin names (`pinnedPrompt`), and the list it picks from
// (`promptsOf`): every message of a session in transcript order, by the key its bubble carries. The DOM half (the
// sticky row, a click through `reveal`) is tests/e2e/prompt-pin.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedPrompt, promptsOf } from "../src/sidebar/transcript/prompt-pin.tsx";

const box = (top, h = 40) => ({ top, bottom: top + h });

// --- which message is pinned ---

test("the last message that started above the top edge, once it has scrolled fully out", () => {
    const drawn = new Map([["a", box(-900)], ["b", box(-300)], ["c", box(400)]]);
    assert.equal(pinnedPrompt(["a", "b", "c"], drawn, 0), "b");
});

test("nothing while that message is still partly on screen: you can see it already", () => {
    const drawn = new Map([["a", box(-900)], ["b", box(-20, 60)]]);
    assert.equal(pinnedPrompt(["a", "b"], drawn, 0), null);
});

test("nothing above the top edge: the first message is on screen, or below it, and nothing is held back", () => {
    assert.equal(pinnedPrompt(["a", "b"], new Map([["a", box(10)], ["b", box(500)]]), 0), null);
});

test("the one before the first drawn message, when the window holds it back", () => {
    // `a` is older than what the window draws; `b` is drawn below the top edge.
    assert.equal(pinnedPrompt(["a", "b", "c"], new Map([["b", box(200)], ["c", box(900)]]), 0), "a");
});

test("with no message drawn at all, every message is above, so the last one", () => {
    assert.equal(pinnedPrompt(["a", "b", "c"], new Map(), 0), "c");
});

test("no messages, no pin", () => {
    assert.equal(pinnedPrompt([], new Map(), 0), null);
});

test("the edge is the scroller's, not the window's: the same boxes against a scroller lower down the page", () => {
    const drawn = new Map([["a", box(100)], ["b", box(300)]]);
    assert.equal(pinnedPrompt(["a", "b"], drawn, 200), "a");
    assert.equal(pinnedPrompt(["a", "b"], drawn, 120), null, "a is still partly in view under a scroller at 120");
});

// --- the messages of a session, in order ---

const agent = (over = {}) => ({ kind: "agent", hash: "h", task: "count the rows", steps: [], turns: [], ...over });

test("an agent run: its task, then each later message by where it landed, keyed as the bubbles are", () => {
    const s = agent({ says: [
        { text: "second follow-up", ts: 30, atStep: 9 },
        { text: "steer mid-run", ts: 10, atStep: 2 },
        { text: "first follow-up", ts: 20, atStep: 5 },
    ] });
    assert.deepEqual(promptsOf(s).map((p) => [p.key, p.text]), [
        ["task", "count the rows"], ["s1", "steer mid-run"], ["s2", "first follow-up"], ["s0", "second follow-up"],
    ]);
});

test("two messages at the same step keep the order they arrived in", () => {
    const s = agent({ says: [{ text: "later", ts: 9, atStep: 3 }, { text: "sooner", ts: 4, atStep: 3 }] });
    assert.deepEqual(promptsOf(s).map((p) => p.text), ["count the rows", "sooner", "later"]);
});

test("what was TYPED is shown, not the text the model got with an element folded in", () => {
    const s = agent({ task: "count the rows\n\n[element: table#rows …]", taskDisplay: { typed: "count the rows", context: [] } });
    assert.equal(promptsOf(s)[0].text, "count the rows");
});

test("a message a site sent is labelled with the site, yours with `you`", () => {
    const s = agent({ site: "https://flights.example", says: [{ text: "more", ts: 1, atStep: 1 }] });
    assert.deepEqual(promptsOf(s).map((p) => p.who), ["flights.example", "you"]);
});

test("a message of only images is named as one, and an empty one is skipped", () => {
    const s = agent({ task: "", taskImages: ["data:image/png;base64,AAAA"], says: [{ text: "  ", ts: 1, atStep: 1 }] });
    assert.deepEqual(promptsOf(s).map((p) => [p.key, p.text]), [["task", "(an image)"]]);
});

test("a chat: each turn's message, keyed by its id; an embed has none", () => {
    const s = { kind: "chat", hash: "c", turns: [{ id: "1", ts: 1, user: "hi", images: null }, { id: "2", ts: 2, user: "", images: null }, { id: "3", ts: 3, user: "again", images: null }] };
    assert.deepEqual(promptsOf(s).map((p) => p.key), ["t1", "t3"]);
    assert.deepEqual(promptsOf({ kind: "embed", hash: "e", turns: [{ id: "1", ts: 1, user: "x", images: null }] }), []);
});
