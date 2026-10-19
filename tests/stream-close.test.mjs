// stream-close.test.mjs — a streaming reply is drawn with its open Markdown closed and its undecidable tail held back
// (src/sidebar/transcript/stream-close.ts), so the text only ever grows: no asterisks that snap to bold, no fence that
// turns the rest of the reply into code and back.
import { test } from "node:test";
import assert from "node:assert/strict";

const { closeStreaming } = await import("../src/sidebar/transcript/stream-close.ts");

/** Each [text so far, what to draw]. */
const check = (cases) => { for (const [src, want] of cases) assert.equal(closeStreaming(src), want, JSON.stringify(src)); };

// --- inline Markdown left open is closed ---

test("emphasis and strikethrough are closed, innermost first", () => check([
    ["A **bol", "A **bol**"], ["A **bold** and *it", "A **bold** and *it*"], ["***both", "***both***"], ["a ~~gone", "a ~~gone~~"],
]));

test("an opener with nothing after it yet is dropped, not drawn as an empty span", () => check([["foo **", "foo"], ["foo *", "foo"]]));

test("an open code span is closed, and markers inside it stay literal", () => check([
    ["say `co", "say `co`"], ["say `code` and **x `y", "say `code` and **x `y`**"], ["a `**b", "a `**b`"],
]));

test("an escaped marker is text", () => check([["esc \\*not", "esc \\*not"]]));

test("a half-written link draws its text; a half-written image draws nothing yet", () => check([
    ["see [the docs](https://ex", "see the docs"], ["see [the do", "see the do"], ["img ![alt](http", "img "],
]));

// --- a fence open at the end ---

test("an open code fence is closed, and a fence still being typed is held back", () => check([
    ["```js\nconst a = 1", "```js\nconst a = 1\n```"], ["intro\n```py\nx = 1\n", "intro\n```py\nx = 1\n```"], ["``", ""], ["text\n`", "text"],
]));

test("prose markers inside an open fence are code, not emphasis", () => check([["```\na **b", "```\na **b\n```"]]));

// --- what cannot be guessed is held back ---

test("a lone list or heading marker waits for the next character", () => check([["- one\n-", "- one"], ["x\n*", "x"], ["x\n##", "x"], ["- one\n- ", "- one\n- "]]));

test("table rows wait for the header's separator line, then draw", () => check([
    ["| a | b |", ""], ["intro\n| a | b |\n| 1 |", "intro"], ["| a | b |\n|---|---|\n| 1 |", "| a | b |\n|---|---|\n| 1 |"],
]));

test("display math waits for its closing delimiter; a lone $ is left to draw as text", () => check([
    ["ok\n\n$$\\frac{1}", "ok\n\n"], ["ok \\[x^2", "ok "], ["price $5 and", "price $5 and"], ["$$x$$ done", "$$x$$ done"],
]));

// --- a ```mermaid fence still open is code, not a diagram ---

test("an open ```mermaid fence is closed as plain code (mermaid_open), so a half-written diagram is never drawn", () => check([
    ["See:\n```mermaid\ngraph TD\n  A -->", "See:\n```mermaid_open\ngraph TD\n  A -->\n```"],
    // Closed by the model: left alone, a diagram from here on.
    ["```mermaid\ngraph TD\n  A --> B\n```", "```mermaid\ngraph TD\n  A --> B\n```"],
    // Any other open fence keeps its language.
    ["```js\nlet x", "```js\nlet x\n```"],
]));
