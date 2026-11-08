// redteam-call-target.test.mjs — what a page FUNCTION must not get from a read-only survey: being CALLED by name.
//
// The dialect's call path admits a callee by NAME — `CALLABLE_ROOTS.has(callee.name)` (src/readonly-exec/evaluator.ts)
// — and the value it then calls is read from `scope`, which is the script's frame over the host's root. A script may
// shadow any root name (`const document = …` writes to the frame, which readonly-exec.ts calls "possible and
// harmless"), so binding one of those names to a function the PAGE handed back as data (`ml.models()` can) buys the
// admission: measured on main, `const Number = o; Number(1)` runs the page's function inside the mediated
// interpreter, whose whole promise is that page code does not run (docs/dev/readonly-exec.md).
//
// Every row has a plain control beside it, so a fixture that cannot call a root at all fails rather than passing by
// refusing nothing. The defence that DOES exist — a callee that is neither a root name nor an arrow the script wrote
// is `call target not allowed` — is the first adversarial row, and it is what says the hole is the name.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly } from "../src/readonly-exec.ts";

const doc = () => new JSDOM("<!doctype html><body><p>hi</p></body>").window.document;

/** Run `js` against an `ml` whose one member hands back `value`; returns what the cell produced. */
const run = (js, value) => evalReadonly(js, doc(), { models: async () => value }, undefined, {});

/** A page's own function: it records that it ran, whatever it was called with, and returns a number. */
function pageFunction(ran) {
    return function (...args) { ran.push(args.length); return 1; };
}

/** Every free name the dialect lets a script CALL (`policy.ts` `CALLABLE_ROOTS`). */
const ROOTS = ["String", "Number", "Boolean", "Array", "parseInt", "parseFloat", "isNaN", "isFinite", "getComputedStyle"];

// --- the control: every root is callable, so a fixture that cannot call one fails the rows below ---

test("CONTROL: every callable root still answers for its own value", async () => {
    const v = async (js) => (await run(js)).value;
    assert.equal(await v(`return Number("3") + 1`), 4, "Number");
    assert.equal(await v(`return String(3)`), "3", "String");
    assert.equal(await v(`return Boolean(0)`), false, "Boolean");
    assert.equal(await v(`return Array(2).length`), 2, "Array");
    assert.equal(await v(`return parseInt("3")`), 3, "parseInt");
    assert.equal(await v(`return parseFloat("3.5")`), 3.5, "parseFloat");
    assert.equal(await v(`return isNaN(NaN)`), true, "isNaN");
    assert.equal(await v(`return isFinite(3)`), true, "isFinite");
    assert.equal(await v(`return getComputedStyle(document.querySelector("p")).display`), "block", "getComputedStyle");
});

// --- what already holds: a callee that is neither a root name nor one of our arrows is refused ---

test("RED TEAM: calling a page function under a name of the script's own is refused and it never runs", async () => {
    // The defence that exists, so the hole below is the NAME and not the absence of any check on the call path.
    const ran = [];
    const r = await run(`const o = await ml.models(); const f = o; return f(1)`, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
    assert.deepEqual(ran, [], `the page's function ran: ${JSON.stringify(ran)}`);
    assert.ok(r.refused, `the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
    assert.match(String(r.refused), /call target not allowed/, String(r.refused));
});

// --- the hole: a root NAME admits whatever the script bound to it ---

test("RED TEAM: a page function bound to a callable root's name is refused and never runs", { todo: "open: the call path admits a callee by NAME (`CALLABLE_ROOTS.has(callee.name)`) and then calls whatever `scope[name]` holds, which is the script's frame, so `const Number = <page fn>; Number(1)` runs the page's function (evaluator.ts:1144-1150)" }, async () => {
    // Measured on main: every one of the nine runs the page's function and answers with its result, under `const`,
    // `let` and `var` alike. A fix must keep the roots callable (the CONTROL row), so it cannot be "no call by name":
    // the callee has to be judged by what it IS — the root's own value, or an arrow written in the script.
    for (const decl of ["const", "let", "var"]) {
        for (const name of ROOTS) {
            const ran = [];
            const r = await run(`const o = await ml.models(); ${decl} ${name} = o; return ${name}(1)`, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
            assert.deepEqual(ran, [], `${decl} ${name}: the page's function ran: ${JSON.stringify(ran)}`);
            assert.ok(r.refused, `${decl} ${name}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
        }
    }
});

test("RED TEAM: the same admission is reached from an inner block and from a parameter name", { todo: "open: a shadow is a shadow wherever it is written, and the call path reads the same `scope[name]` for a block binding or a parameter (evaluator.ts:1144-1150)" }, async () => {
    // A shadow is a shadow wherever it is written: refusing only the top-level `const` would leave both of these.
    for (const [why, js] of [
        ["an inner block", `const o = await ml.models(); { const Number = o; return Number(1) }`],
        ["an arrow parameter", `const o = await ml.models(); return ((Number) => Number(1))(o)`],
    ]) {
        const ran = [];
        const r = await run(js, pageFunction(ran)).catch((e) => ({ refused: String(e) }));
        assert.deepEqual(ran, [], `${why}: the page's function ran: ${JSON.stringify(ran)}`);
        assert.ok(r.refused, `${why}: the survey answered instead of refusing: ${JSON.stringify(r.value)}`);
    }
});

// --- the control a fix must not break: the script's OWN arrow under a root name ---

test("CONTROL: an arrow the script wrote, bound to a root's name, is still callable", async () => {
    // Elsewhere the dialect calls the script's arrows (`(() => 1)()`), and a shadowed root name holding one is no
    // different: a fix that refused every call of a root-named binding would pass the rows above and fail here.
    const v = async (js) => (await run(js)).value;
    assert.equal(await v(`const Number = (x) => x + 6; return Number(1)`), 7, "Number");
    assert.equal(await v(`const getComputedStyle = (el) => "ours"; return getComputedStyle(1)`), "ours", "getComputedStyle");
});
