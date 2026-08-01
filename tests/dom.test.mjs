// Pure dom.ts helpers.
import { test } from "node:test";
import assert from "node:assert";
import { elementReference } from "../dom.ts";

test("elementReference: a plain path → document.querySelector('…')", () => {
    assert.equal(elementReference("body > div#main > button.foo"),
        "document.querySelector('body > div#main > button.foo')");
});

test("elementReference: a non-zero index → querySelectorAll(...)[i]; index 0 → querySelector", () => {
    assert.equal(elementReference(".card", 2), "document.querySelectorAll('.card')[2]");
    assert.equal(elementReference(".card", 0), "document.querySelector('.card')");   // first match
    assert.equal(elementReference(".card"), "document.querySelector('.card')");
});

test("elementReference: single quotes + backslash CSS-escapes survive into a valid JS string literal", () => {
    // A Tailwind path with a CSS `\/` escape — the backslash must be doubled for the JS literal so the
    // pasted line's querySelector receives the original single backslash.
    assert.equal(elementReference("button.p-2\\/3"), "document.querySelector('button.p-2\\\\/3')");
    // A single quote in the path is backslash-escaped.
    assert.equal(elementReference("a[data-x='y']"), "document.querySelector('a[data-x=\\'y\\']')");
    // Sanity: the emitted string literal, when parsed as JS, round-trips to the original path.
    const out = elementReference("button.p-2\\/3");
    const literal = out.slice("document.querySelector(".length, -1);   // the '…' part
    assert.equal(eval(literal), "button.p-2\\/3");   // eslint-disable-line no-eval — trusted, our own output
});
