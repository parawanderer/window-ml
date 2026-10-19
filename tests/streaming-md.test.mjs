// streaming-md.test.mjs — a streaming reply's words fade in (src/sidebar/transcript/streaming-md.tsx): which words are
// wrapped, how a burst is paced, and that a redraw continues each fade instead of restarting it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { document } = new JSDOM("<body></body>").window;
const { fadeWords, FADE_STEP_MS, FADE_LAG_MS, setAsideTokens, noteLiveAnswer, continuesLiveAnswer } = await import("../src/sidebar/transcript/streaming-md.tsx");

/** Draw `html`, mark it at `now`, and list each fading word with its delay. */
function mark(html, starts, now, live = true) {
    const root = document.createElement("div");
    root.innerHTML = html;
    fadeWords(root, starts, now, 380, live);
    return { root, fading: [...root.querySelectorAll(".w-in")].map((s) => [s.textContent.trim(), parseInt(s.style.animationDelay, 10)]) };
}

// --- which words fade, and when each starts ---

test("a burst is paced: each new word starts a step after the last, never more than the lag behind", () => {
    const starts = [];
    const { fading } = mark("<p>one two three four five six seven eight</p>", starts, 1000);
    assert.deepEqual(fading.slice(0, 3), [["one", 0], ["two", FADE_STEP_MS], ["three", 2 * FADE_STEP_MS]]);
    assert.ok(fading.every(([, d]) => d <= FADE_LAG_MS), "no word is held back past the lag");
});

test("a redraw continues each fade from where it is, and words past their fade are plain text", () => {
    const starts = [];
    mark("<p>alpha beta</p>", starts, 1000);
    const later = mark("<p>alpha <b>beta</b> gamma</p>", starts, 1200);
    assert.deepEqual(later.fading.map(([w]) => w), ["alpha", "beta", "gamma"]);
    assert.equal(later.fading[0][1], -200, "alpha is 200ms into its fade, not starting again");
    const done = mark("<p>alpha <b>beta</b> gamma</p>", starts, 5000);
    assert.deepEqual(done.fading, []);
    assert.equal(done.root.textContent, "alpha beta gamma", "the text itself is untouched");
});

test("text that was already there when drawn (a settled reply redrawn) does not fade", () => {
    const { fading } = mark("<p>already here</p>", [], 1000, false);
    assert.deepEqual(fading, []);
});

test("whitespace is never wrapped, and words inside markup keep their markup", () => {
    const { root } = mark("<p>a <code>b c</code></p>", [], 1000);
    assert.equal(root.querySelector("code").textContent, "b c");
    assert.ok([...root.querySelectorAll(".w-in")].every((s) => /\S/.test(s.textContent)));
});

// --- an agent's answer while it streams ---

/** What the streaming renderer would draw for `md`, with `markdown()` stood in by a paragraph wrapper. */
const drawnWithTokens = (md) => { const { md: text, restore } = setAsideTokens(md); return restore(text.split(/\n\n+/).filter(Boolean).map((p) => `<p>${p}</p>`).join("")); };

test("a finished embed holds its place as its label, inline where a short value will settle, and a link draws as its label, until the answer settles", () => {
    assert.equal(drawnWithTokens("See ![the models](@tool:3f9a0c2) here"), '<p>See <span class="tok-streaming">the models</span> here</p>');
    assert.equal(drawnWithTokens("Per [the count](@tool:3f9a0c2), five."), '<p>Per <span class="tok-streaming-link">the count</span>, five.</p>');
});

test("a citation inside code is being mentioned, and a label is escaped", () => {
    assert.equal(drawnWithTokens("Write `![x](@tool:3f9a0c2)` to embed"), "<p>Write `![x](@tool:3f9a0c2)` to embed</p>");
    assert.match(drawnWithTokens("![<b>hi</b>](@tool:3f9a0c2)"), /&lt;b&gt;hi&lt;\/b&gt;/);
});

test("a run's finished answer continues its live one only if that was drawn a moment ago", () => {
    noteLiveAnswer("abc", 10_000);
    assert.equal(continuesLiveAnswer("abc", 11_000), true);
    assert.equal(continuesLiveAnswer("abc", 13_000), false, "an answer long after the stream is an arrival");
    assert.equal(continuesLiveAnswer("other", 11_000), false);
    assert.equal(continuesLiveAnswer(undefined, 11_000), false);
});
