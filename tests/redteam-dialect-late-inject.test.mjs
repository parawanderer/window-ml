// redteam-dialect-late-inject.test.mjs — the token-list BRAND on a LATE injection (e3's row for #1767). `TOKEN_LIST_LENGTH`
// is captured when readonly-exec loads: the registered MAIN-world script at document_start, but `injectPageScripts`
// (sw-presence.ts:144 and :220, sw-page-restore.ts:43) loads it into a page that ALREADY RAN, so what it captures is
// whatever `DOMTokenList` the page left. That is accepted, not defended (docs/dev/readonly-exec.md, and the comments in
// policy.ts); this file is the row that pins it, and the two things a reader will want to know before accepting it:
// what the page gains, and what it can do with a callback the dialect hands it.
//
// MEASURED ON THIS BRANCH (44523a2d), in a realm with no `DOMTokenList` of its own — the Node + jsdom shape, which is
// where `tokenListBrand(view)` falls back to the document's:
//   * a forged `length` getter that answers 1 for every receiver makes EVERY object a `tokenlist`, `document` included,
//     so `document.querySelector` is refused ("not allowed on tokenlist") and the survey cannot run at all;
//   * a page object is one too, so its OWN `contains`/`forEach` runs (page code, at the dialect's call), and the value it
//     returns becomes the survey's value;
//   * the page's `forEach` is handed our arrow's wrapper and keeps it; called after the survey it still runs the arrow
//     body, and the page chooses the arguments. It cannot reach the run's context (`ml.current` throws), a coercing
//     object argument still throws, and the STEP BUDGET survives: a 40-step survey left the page 16 more calls of
//     `(x) => x`, then NotInDialect "over 40 steps". A page-driven re-entry INSIDE the survey stops the same way.
//   * what the page does NOT get by holding it: nothing the arrow body does not already do in the page's own world —
//     the wrapper's source is the evaluator's, not the script's, and an arrow returning `ml` hands the page a COPY of
//     the read-only facade (its `queryAll`, nothing else; `current` is not on it).
//   * a realm that HAS its own `DOMTokenList` ignores the forge entirely (measured in a scratch process with
//     `globalThis.DOMTokenList` set before the import: forge ran 0 times, the page's `contains` never ran, and
//     `document.querySelector` worked). That is the isolated-world shape, and objects cannot cross worlds anyway.
//
// MUTATION PER ROW (notes, not committed changes — apply one, watch its row go red, revert; measured at 44523a2d,
// clean 3/3 before and after):
//   B  evaluator.ts `converting`'s last `throw new NotInDialect(… did not build …)` → `if (false)` → B red (5.4 ms: the
//      coercing object argument runs its own toString).
//   B  evaluator.ts `tick`'s `if ((this.fuel -= n) < 0)` → `if (false)` → B red (9.6 ms: the page's calls run unbounded,
//      both after the survey and in the page-driven re-entry inside it).
//   C  evaluator.ts `memberValue`'s `Array.from(v as ArrayLike<unknown>)` → `v` → C red (4.5 ms: a shape-matched
//      collection is not materialised, so the page's own forEach is what a survey calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { evalReadonly, NotInDialect } = await import("../src/readonly-exec.ts");

const HTML = `<!doctype html><title>probe-title</title><body><button id="b1" class="btn">One</button></body>`;
const outOfDialect = (e) => e instanceof NotInDialect;

/** A document whose window's `DOMTokenList` the page replaced BEFORE our capture: every receiver is length 1. */
function forgedDoc() {
    const dom = new JSDOM(HTML);
    const ran = [];
    const real = dom.window.DOMTokenList;
    function Fake() {}
    Fake.prototype = Object.create(Object.getPrototypeOf(real.prototype));
    Object.defineProperty(Fake.prototype, "length", { get() { ran.push("forge"); return 1; } });
    dom.window.DOMTokenList = Fake;
    return { doc: dom.window.document, ran };
}
/** A page object with the interface's own shape, whose methods are the page's. */
const pageList = (ran) => ({
    length: 1,
    item: () => "item",
    contains: (x) => { ran.push("contains"); return `PAGE contains(${x})`; },
    forEach: (cb) => { ran.push("forEach"); return cb("kept"); },
});

// --- A. what a late injection accepts: the page decides what a token list is ---

test("a survey loaded into a page that already ran takes the page's DOMTokenList, so the page's objects are token lists", async () => {
    const { doc, ran } = forgedDoc();
    const list = pageList(ran);
    const run = (js) => evalReadonly(js, doc, { queryAll: () => [list] });
    // The page object is the kind the page says it is, and the method that runs is the page's own.
    assert.deepEqual((await run(`return ml.queryAll('x')[0].contains('a')`)).value, "PAGE contains(a)");
    assert.ok(ran.includes("contains"), "the page's contains did not run");
    // The forge is page code, and it runs on values the page never supplied: `document` is a token list too.
    const n = ran.filter((x) => x === "forge").length;
    assert.ok(n > 0, "the page's length getter never ran");
    await assert.rejects(run(`return document.querySelector('button').id`), /not allowed on tokenlist/,
        "document was not branded a token list, so the availability half is not the one this row pins");
    // A bare object is one as well: the brand answers for ANY receiver, so the token list's allowlist is what decides
    // for an object with no shape — its own `contains` is allowed, and one without a `contains` gets the kind's message.
    assert.equal((await run(`const o = { contains: () => "BARE" }; return o.contains('a')`)).value, "BARE");
    const bare = await run(`const o = {}; return o.contains('a')`).catch((e) => e);
    assert.ok(!outOfDialect(bare), `an empty object was refused as though it were not a token list: ${bare}`);
    assert.match(String(bare), /has no callable 'contains'/, `an empty object did not reach the token list's own lookup: ${bare}`);
});

// --- B. a callback the page keeps: it runs the arrow again, and stays inside the survey's budget ---

test("a page's forEach keeps our callback: it still runs the arrow after the survey, bounded and unable to reach the run", async () => {
    const { doc } = forgedDoc();
    let kept;
    const list = { length: 1, item: () => "i", forEach: (cb) => { kept = cb; } };
    const run = (js, opts) => evalReadonly(js, doc, { queryAll: () => [list] }, undefined, opts);
    await run(`ml.queryAll('x')[0].forEach((x) => 'seen:' + String(x))`);
    assert.equal(typeof kept, "function", "the page was not handed a callback, so nothing below is measured");
    // After the survey: the arrow's body runs, with the page's argument.
    assert.equal(kept("post"), "seen:post");
    // What it refuses: a coercing object, and the run's own context.
    assert.throws(() => kept({ toString() { return "COERCED"; } }), (e) => outOfDialect(e) && /did not build/.test(e.message),
        "an object the page built was converted by running its own toString");
    let gotCurrent;
    list.forEach = (cb) => { gotCurrent = cb; };
    await run(`ml.queryAll('x')[0].forEach((x) => ml.current)`);
    assert.throws(() => gotCurrent("after"), (e) => outOfDialect(e) && /ml\.current is the run's context/.test(e.message),
        "the page read the run's context through a kept callback");
    // The budget is the survey's, and it is spent across the page's own calls: 40 steps left 16 calls of `(x) => x`.
    let gotCheap;
    list.forEach = (cb) => { gotCheap = cb; };
    await run(`ml.queryAll('x')[0].forEach((x) => x)`, { stepBudget: 40 });
    let calls = 0;
    let refused = null;
    try { for (; calls < 10000; calls++) gotCheap(calls); } catch (e) { refused = e; }
    assert.ok(refused !== null, `the page ran ${calls} calls with no budget left: the survey's halt did not bind after it`);
    assert.match(refused.message, /over 40 steps/);
    assert.ok(calls > 0, "the callback never ran at all, so the budget above was not what stopped it");
    // And a page-driven re-entry INSIDE the survey stops at the same budget.
    list.forEach = (cb) => { for (let i = 0; i < 10000; i++) cb(i); };
    await assert.rejects(run(`ml.queryAll('x')[0].forEach((x) => x)`, { stepBudget: 40 }), /over 40 steps/);
});

// --- C. the control: with a pristine brand the same object is COPIED on the read, so no page method runs ---

test("without the forge the same shape is materialised into an Array, so the page's own forEach is never what a survey calls", async () => {
    const doc = new JSDOM(HTML).window.document;
    const ran = [];
    const list = pageList(ran);
    const run = (js) => evalReadonly(js, doc, { queryAll: () => [list] });
    assert.deepEqual((await run(`const c = ml.queryAll('x')[0]; return [Array.isArray(c), String(c.length)]`)).value, [true, "1"]);
    // The page's methods were never called: the Array the read built has no such members.
    assert.deepEqual(await run(`return ml.queryAll('x')[0].map((x) => String(x))`).then((r) => r.value), ["undefined"]);
    assert.deepEqual(ran, [], `a page method ran without the forge: ${ran.join(", ")}`);
    // And a real token list still answers, so the copy above is the collection path and not a dead reader.
    assert.equal((await run(`return document.getElementById('b1').classList.contains('btn')`)).value, true);
});
