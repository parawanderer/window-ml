"use strict";
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied } from "../readonly-exec.ts";

function world() {
    const dom = new JSDOM(`<!doctype html><body>
      <input placeholder="Ask Gemini" id="a" class="x">
      <textarea aria-label="Ask Gemini please" id="b"></textarea>
      <div contenteditable="true" id="c">hello Ask Gemini world</div>
      <input placeholder="other" id="d">
    </body>`);
    // jsdom doesn't implement innerText — alias it to textContent so the canonical
    // survey (which reads el.innerText) runs verbatim.
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
        get() { return this.textContent; }, configurable: true,
    });
    return dom.window.document;
}

// A stand-in window.ml: the read-only slice the dialect may call, plus the gated half it must
// NOT be able to reach. The gated ones THROW A DISTINCT ERROR if invoked, so a test can tell
// "rejected at the gate" (NotInDialect/Denied) apart from "actually ran".
const ML = {
    getModel: async () => "gemma4:31b",
    config: async () => ({ model: "gemma4:31b", ocrModel: "", apiFormat: "openai" }),
    models: async () => ["gemma4:31b", "qwen2.5vl:7b"],
    capabilities: async (m) => (m === "qwen2.5vl:7b" ? ["completion", "vision"] : ["completion"]),
    ps: async () => [{ name: "gemma4:31b", size_vram: 21_000_000_000 }],
    serverTools: async () => [{ id: "searxng_search" }],
    setModel: async () => { throw new Error("RAN: setModel"); },
    unload: async () => { throw new Error("RAN: unload"); },
    chat: async () => { throw new Error("RAN: chat"); },
    agent: async () => { throw new Error("RAN: agent"); },
    read: async () => { throw new Error("RAN: read"); },
    screenshot: async () => { throw new Error("RAN: screenshot"); },
    pythonExec: async () => { throw new Error("RAN: pythonExec"); },
    // A pure, SYNC helper (the bounded counter loop) — on the read-only facade so `ml.range(n).map(…)` runs
    // without approval. Kept trivial here; util.mlRange is unit-tested separately.
    range: (a, b, step = 1) => { const start = b === undefined ? 0 : a, stop = b === undefined ? a : b; const out = []; for (let i = 0, v = start; i < Math.max(0, Math.ceil((stop - start) / step)); i++, v += step) out.push(v); return out; },
};
const run = (js, doc = world(), ml = ML) => evalReadonly(js, doc, ml);
const outOfDialect = e => e instanceof NotInDialect || e instanceof Denied;

test("canonical survey #1 (querySelectorAll → filter → map) returns the summary", async () => {
    const js = `Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
      .filter(el => el.placeholder === 'Ask Gemini'
                 || el.innerText.includes('Ask Gemini')
                 || el.getAttribute('aria-label')?.includes('Ask Gemini'))
      .map(el => ({ tagName: el.tagName, id: el.id, className: el.className, outerHTML: el.outerHTML.slice(0, 100) }))`;
    const { value } = await run(js);
    const ids = value.map(v => v.id).sort();
    // a: placeholder match · b: aria-label match · c: innerText contains "Ask Gemini"
    assert.deepEqual(ids, ["a", "b", "c"]);
    assert.equal(value.find(v => v.id === "a").tagName, "INPUT");
    assert.ok(value.find(v => v.id === "a").outerHTML.startsWith("<input"));
});

test("canonical survey #2 (contenteditable/textarea) returns the summary", async () => {
    const js = `Array.from(document.querySelectorAll("div, textarea"))
      .filter(el => el.getAttribute("contenteditable") === "true" || el.tagName === "TEXTAREA")
      .map(el => ({ selector: el.outerHTML.slice(0, 100), tag: el.tagName }))`;
    const tags = (await run(js)).value.map(v => v.tag).sort();
    assert.deepEqual(tags, ["DIV", "TEXTAREA"]);
});

test("method-existence guard idiom stays in-dialect (el.querySelector && el.querySelector(...))", async () => {
    const js = `Array.from(document.querySelectorAll("div, textarea, input"))
      .filter(el => el.placeholder === 'Ask Gemini'
                 || (el.querySelector && el.querySelector('div')?.textContent === 'x'))
      .map(el => el.tagName + ' ' + el.className)`;
    const { value } = await run(js);   // must NOT throw — the bare `el.querySelector` read is now an inert sentinel
    assert.ok(Array.isArray(value));
    assert.ok(value.includes("INPUT x"), "the placeholder-matched input is summarised");
});

test("the method sentinel is inert — it can't be invoked to smuggle a call", async () => {
    // Reading a method then invoking the reference must fall back (NotInDialect),
    // never actually run the method.
    await assert.rejects(run(`const f = document.body.getAttribute; f('x')`), outOfDialect);
    await assert.rejects(run(`[document.body].map(document.body.getAttribute)`), outOfDialect);
});

test("pure computation: arrows, ternary, optional chaining, template-free literals", async () => {
    assert.equal((await run("[1,2,3,4].map(x => x*2).filter(x => x > 4).reduce((a,b) => a+b, 0)")).value, 14);
    assert.equal((await run("const n = 5; n > 3 ? 'big' : 'small'")).value, "big");
    assert.deepEqual((await run("({ a: 1, b: [2, 3], c: 'x'.toUpperCase() })")).value, { a: 1, b: [2, 3], c: "X" });
    assert.equal((await run("null?.foo")).value, undefined);
});

// Optional-chained COMPUTED member `?.[…]` must not double-consume the '[' (a review flagged
// a possible double-eat — but `is()` is a pure peek, so `parseComputed` does the only eat).
// The last case also exercises binary '-' next to the '[' (the other flagged edge case).
test("optional-chained computed member ?.[…] parses (no spurious double-eat)", async () => {
    assert.equal((await run("[10,20,30]?.[1]")).value, 20);
    assert.equal((await run("const a = [1,2,3]; a?.[0]")).value, 1);
    assert.equal((await run("({ x: { y: 5 } })?.['x']?.['y']")).value, 5);
    assert.equal((await run("const arr = [7,8,9]; arr?.[arr.length - 1]")).value, 9);
});

test("captures console output alongside the value", async () => {
    const { value, logs } = await run("console.log('n:', [1,2].length); [1,2].length");
    assert.equal(value, 2);
    assert.deepEqual(logs, ["n: 2"]);
});

// --- the security surface: every one of these must throw (→ caller falls back) ---
const ESCAPES = {
    "node → window → fetch": `document.querySelectorAll("input")[0].ownerDocument.defaultView.fetch("/x")`,
    "constructor → Function": `({}).constructor.constructor("return fetch")()`,
    "computed owner-document": `document.querySelectorAll("input")[0]["owner" + "Document"]`,
    "__proto__ access": `({}).__proto__`,
    "bare fetch": `fetch("/x")`,
    "window global": `window.location`,
    "self global": `self.fetch`,
    "setAttribute (mutation)": `document.body.setAttribute("x", "y")`,
    "innerHTML assign": `document.body.innerHTML = "x"`,
    "click (effect)": `document.querySelector("input").click()`,
    "method as value": `const g = document.body.getAttribute; g("x")`,
};
for (const [name, js] of Object.entries(ESCAPES)) {
    test(`blocked: ${name}`, async () => {
        await assert.rejects(run(js), outOfDialect, `"${name}" must be rejected, not executed`);
    });
}

// The spread + IIFE forms the models actually write for DOM surveys — these must
// run in-dialect (before, they fell back to approval, which is the whole friction).
test("spread over a NodeList runs in-dialect (the [...querySelectorAll(...)] form)", async () => {
    const doc = world();
    const { value } = await evalReadonly(`[...document.querySelectorAll("input")].filter(el => el.placeholder === 'Ask Gemini').map(el => el.id)`, doc);
    assert.deepEqual(value, ["a"]);
});

test("function-expression IIFE runs in-dialect (the (function(){…})() form)", async () => {
    const doc = world();
    const js = `(function(){
        const items = [...document.querySelectorAll("input, textarea")];
        return items.filter(el => el.id).map(el => ({ id: el.id, tag: el.tagName }));
    })()`;
    const out = (await evalReadonly(js, doc)).value;
    assert.ok(out.some(x => x.id === "a" && x.tag === "INPUT"));
});

test("spread in call args works (Math.max(...nums))", async () => {
    assert.equal((await run("Math.max(...[3, 7, 2])")).value, 7);
});

test("if-statement guard clauses run in-dialect (a very common survey shape)", async () => {
    const doc = new JSDOM('<div id="message-1"><button aria-label="A">x</button></div>' +
        '<div id="message-2"><button aria-label="B">y</button><button aria-label="C">z</button></div>').window.document;
    const js = `
        const messages = document.querySelectorAll('[id^="message-"]');
        const lastMessage = messages[messages.length - 1];
        if (lastMessage) {
          const buttons = [...lastMessage.querySelectorAll('button')];
          return buttons.map(b => b.getAttribute('aria-label'));
        }
        return "No messages found";`;
    assert.deepEqual((await evalReadonly(js, doc)).value, ["B", "C"]);
    // else branch + single-statement guard return
    assert.equal((await run("const x = 3; if (x > 5) { return 'big' } else { return 'small' }")).value, "small");
    assert.equal((await run("const a = [1, 2]; if (a.length === 0) return 'empty'; return a.length")).value, 2);
});

// --- out-of-dialect syntax must throw NotInDialect (fail closed, not crash) ---
const OUT = {
    // `for…of` is now IN-dialect (see below); a C-style `for(;;)` and `for…in` stay OUT.
    "C-style for": `for (let i = 0; i < 3; i++) { i }`,
    "for...in": `for (const k in {a: 1}) { k }`,
    "assignment": `let x = 1; x = 2; x`,
    "new": `new Object()`,
    "tagged template": "tag`hi ${1}`",   // a plain template is supported; a TAGGED one (a call) is not
};
for (const [name, js] of Object.entries(OUT)) {
    test(`falls back (NotInDialect): ${name}`, async () => {
        await assert.rejects(run(js), outOfDialect);
    });
}

// --- Accommodate: DOM collections read as real Arrays (NodeList/HTMLCollection have no .map) ---

test("querySelectorAll(...).map works WITHOUT spreading — the NodeList is coerced to an Array", async () => {
    // Models often forget Array.from/[...]; the read-only dialect just hands back a real list.
    assert.deepEqual((await run(`document.querySelectorAll('input').map(el => el.id)`)).value, ["a", "d"]);
});

test("a collection PROPERTY (.children) reads as an Array too — uniform with querySelectorAll", async () => {
    assert.deepEqual((await run(`document.body.children.map(c => c.id)`)).value, ["a", "b", "c", "d"]);
});

test("the coerced Array chains filter → map (all allowed) like a normal array", async () => {
    assert.deepEqual((await run(`document.querySelectorAll('input').filter(el => el.id === 'd').map(el => el.placeholder)`)).value, ["other"]);
});

// --- regex literals: pure matching, in-dialect (a whitespace-collapse survey shouldn't need approval) ---

test("regex literal + String.replace runs in-dialect (the common whitespace-normalize survey)", async () => {
    assert.equal((await run(`'a   b\\tc'.replace(/\\s+/g, ' ')`)).value, "a b c");
});
test("regex methods run: match / split / test / a RegExp.exec", async () => {
    assert.deepEqual((await run(`'a1 b2 c3'.match(/\\d/g)`)).value, ["1", "2", "3"]);
    assert.deepEqual((await run(`'a,b;c'.split(/[,;]/)`)).value, ["a", "b", "c"]);
    assert.equal((await run(`/^\\d+$/.test('12345')`)).value, true);
    assert.equal((await run(`/(\\w)(\\d)/.exec('x9')[2]`)).value, "9");
});
test("division still lexes as division (not a regex) after a value token", async () => {
    assert.equal((await run(`12 / 2 / 3`)).value, 2);
    assert.equal((await run(`[1,2,3,4].length / 2`)).value, 2);
});

// --- bounded counter loops: ml.range() (facade) + the [...Array(n).keys()] idiom, no for/while needed ---

test("ml.range() is a bounded counter loop on the read-only facade (range(n) / start,stop / step)", async () => {
    assert.deepEqual((await run(`ml.range(5).map(i => i * 10)`)).value, [0, 10, 20, 30, 40]);
    assert.deepEqual((await run(`ml.range(2, 6)`)).value, [2, 3, 4, 5]);
    assert.deepEqual((await run(`ml.range(10, 0, -2)`)).value, [10, 8, 6, 4, 2]);
});
test("[...Array(n).keys()] resolves — Array(n) is a callable root now", async () => {
    assert.deepEqual((await run(`[...Array(4).keys()]`)).value, [0, 1, 2, 3]);
    assert.deepEqual((await run(`[...Array(3).keys()].map(i => i + 1)`)).value, [1, 2, 3]);
});

// --- for…of: LLMs write it constantly; it's as safe/terminating as spread (no infinite iterable reachable) ---

test("for…of iterates + reads + logs (block and single-statement bodies)", async () => {
    assert.deepEqual((await run(`for (const x of [10, 20, 30]) console.log(x)`)).logs, ["10", "20", "30"]);
    assert.deepEqual((await run(`for (const el of document.querySelectorAll('input')) console.log(el.id)`)).logs, ["a", "d"]);
    assert.deepEqual((await run(`for (const n of [1, 2]) { const sq = n * n; console.log(sq) }`)).logs, ["1", "4"]);
});
test("for…of supports early return and iterating Object.entries (the for…in replacement) by index", async () => {
    assert.equal((await run(`for (const x of ['a', 'b', 'c']) { if (x === 'b') return x + '!' }`)).value, "b!");
    assert.deepEqual((await run(`for (const e of Object.entries({ a: 1, b: 2 })) console.log(e[0] + '=' + e[1])`)).logs, ["a=1", "b=2"]);
    // A destructuring loop var falls back — the dialect has no destructuring anywhere; index the pair instead.
    await assert.rejects(run(`for (const [k, v] of Object.entries({ a: 1 })) console.log(k)`), outOfDialect);
});
test("for…of still can't ACCUMULATE — push/reassignment stay out, so it never mutates", async () => {
    // The safety line holds: iterate + read + log, but not build-by-mutation. Use .map/.reduce for a result.
    await assert.rejects(run(`const r = []; for (const x of [1, 2]) r.push(x); r`), outOfDialect);
    await assert.rejects(run(`let s = ''; for (const x of ['a', 'b']) s += x; s`), outOfDialect);
});
test("for…of over a non-iterable throws a catchable TypeError (not a guard escalation)", async () => {
    await assert.rejects(run(`for (const x of 5) console.log(x)`), e => e instanceof TypeError);
});

test("a SYNC ml read (queryAll/range) runs INSIDE a .map/.filter callback; an ASYNC one still can't", async () => {
    const doc = world();
    const ml = { queryAll: (s) => [...doc.querySelectorAll(s)], range: (n) => Array.from({ length: n }, (_, i) => i), getModel: async () => "m" };
    // The reported case: counting several selectors with ml.queryAll INSIDE a map. Sync ml reads no longer
    // auto-await, so this runs instead of falling out of dialect ("await not supported inside a callback").
    assert.deepEqual((await run(`['input', 'textarea'].map(s => s + '=' + ml.queryAll(s).length)`, doc, ml)).value, ["input=2", "textarea=1"]);
    assert.deepEqual((await run(`[2, 3].map(n => ml.range(n).length)`, doc, ml)).value, [2, 3]);
    // An ASYNC ml read (a background round-trip) inside a callback STILL falls back — the sync driver can't await.
    await assert.rejects(run(`[1].map(x => ml.getModel())`, doc, ml), outOfDialect);
    // …but at the top level it still auto-awaits (a forgotten `await` still reads the value).
    assert.equal((await run(`ml.getModel()`, doc, ml)).value, "m");
});
test("a regex literal is DENIED nothing extra — it can't reach an effectful method", async () => {
    // The regex is pure; the escape battery elsewhere still holds. A malformed regex just falls back.
    await assert.rejects(run(`/[/`), outOfDialect);   // invalid pattern → NotInDialect (approval), never a crash
});

// --- optional chaining short-circuits the WHOLE chain (a?.b.c() with null a → undefined, not a throw) ---

test("optional chaining short-circuits the rest of the chain when the head is null", async () => {
    // The motivating YouTube-style survey uses `el?.textContent.trim()` defensively — a missing element must
    // yield undefined, not throw "undefined has no callable 'trim'".
    assert.equal((await run(`document.querySelector('#nope')?.textContent.trim()`)).value, undefined);
    assert.equal((await run(`document.querySelector('#nope')?.a.b.c()`)).value, undefined);
    // …but when the head EXISTS the chain runs to completion.
    assert.equal((await run(`document.querySelector('#a')?.getAttribute('id').toUpperCase()`)).value, "A");
});

test("the full defensive survey (spread + regex + optional-chain + block arrow) auto-runs", async () => {
    const dom = world();
    dom.body.innerHTML = `<article><h3 class="t">  Hello   World </h3><span class="m">10   pts</span></article>
                          <article><h3 class="t">Bare</h3></article>`;
    const js = `[...document.querySelectorAll('article')].slice(0, 8).map(a => {
        const t = a.querySelector('.t')?.textContent.replace(/\\s+/g, ' ').trim();
        const m = a.querySelector('.m')?.textContent.trim();
        return (t || '') + ' | ' + (m || '')
    }).join('\\n')`;
    assert.equal((await run(js, dom)).value, "Hello World | 10   pts\nBare | ");
});

// --- the read-only `ml` slice: self-introspection with NO approval prompt ---

test("the free ml reads run in-dialect (getModel / config / models / capabilities / ps / serverTools)", async () => {
    assert.equal((await run(`await ml.getModel()`)).value, "gemma4:31b");
    assert.equal((await run(`(await ml.config()).model`)).value, "gemma4:31b");
    assert.deepEqual((await run(`await ml.models()`)).value, ["gemma4:31b", "qwen2.5vl:7b"]);
    assert.deepEqual((await run(`await ml.capabilities('qwen2.5vl:7b')`)).value, ["completion", "vision"]);
    assert.equal((await run(`(await ml.ps()).length`)).value, 1);
    assert.deepEqual((await run(`(await ml.serverTools()).map(t => t.id)`)).value, ["searxng_search"]);
});

test("ml.fetch is CACHE-ONLY in the dialect: a cached URL reads free, a new URL falls to approval (never egresses)", async () => {
    const cached = { url: "https://x.test/data.json", status: 200, ok: true, type: "json", text: '{"n":7}', json: { n: 7 } };
    const ml = {
        getModel: async () => "m",
        // The real (egress) fetch must NEVER be reached from the dialect — the facade binds _fetchCached instead.
        fetch: async () => { throw new Error("RAN: real fetch (egress) — must not happen in read-only"); },
        _fetchCached: (url) => (url === cached.url ? cached : undefined),
    };
    // A cached URL: returns the stored result, no egress, no approval.
    assert.deepEqual((await run(`ml.fetch("https://x.test/data.json")`, world(), ml)).value, cached);
    // …and its fields are usable (the payoff: re-read + process a source without re-approval).
    assert.equal((await run(`ml.fetch("https://x.test/data.json").json.n`, world(), ml)).value, 7);
    assert.equal((await run(`ml.fetch("https://x.test/data.json").text.length`, world(), ml)).value, cached.text.length);
    // A NEW (uncached) URL: throws Denied → the exec falls to normal approval + the real fetch.
    await assert.rejects(run(`ml.fetch("https://x.test/other.json")`, world(), ml), outOfDialect);
    // Absent _fetchCached (no fetch ever made) → ml.fetch simply isn't on the facade → NotInDialect.
    await assert.rejects(run(`ml.fetch("https://x.test/data.json")`, world(), { getModel: async () => "m" }), outOfDialect);
});

test("awaits compose anywhere in the expression, not just at a statement seam", async () => {
    const js = `return { model: await ml.getModel(), count: (await ml.models()).length }`;
    assert.deepEqual((await run(js)).value, { model: "gemma4:31b", count: 2 });
    // and an await feeding another call's arguments
    assert.deepEqual((await run(`await ml.capabilities(await ml.getModel())`)).value, ["completion"]);
});

test("Promise.all over the ml reads works — the idiom models actually write", async () => {
    // Array destructuring of the batch is now in-dialect (the shape models really write).
    const js = `const [models, current] = await Promise.all([ml.models(), ml.getModel()]);
                return { count: models.length, current }`;
    assert.deepEqual((await run(`await Promise.all([ml.models(), ml.getModel()])`)).value,
        [["gemma4:31b", "qwen2.5vl:7b"], "gemma4:31b"]);
    assert.deepEqual((await run(js)).value, { count: 2, current: "gemma4:31b" });
    assert.equal((await run(`(await Promise.all([ml.models(), ml.getModel()]))[1]`)).value, "gemma4:31b");
});

test("destructuring binding: array (with holes + rest) and object shorthand, over the ml reads", async () => {
    // The exact snippet models write: batch → destructure → JSON.stringify + console.log.
    const { logs } = await run(`const [model, models, ps] = await Promise.all([ml.getModel(), ml.models(), ml.ps()]);
        console.log("model:", model); console.log("models:", JSON.stringify(models)); console.log("ps:", JSON.stringify(ps));`);
    assert.deepEqual(logs, ['model: gemma4:31b', 'models: ["gemma4:31b","qwen2.5vl:7b"]', 'ps: [{"name":"gemma4:31b","size_vram":21000000000}]']);
    // Object shorthand destructuring of an ml read.
    assert.equal((await run(`const { model } = await ml.config(); return model`)).value, "gemma4:31b");
    // Array holes + rest.
    assert.deepEqual((await run(`const [, b, ...rest] = [1, 2, 3, 4, 5]; return [b, rest]`)).value, [2, [3, 4, 5]]);
    // Destructuring a DOM read (querySelectorAll → Array) binds the elements.
    const doc = world();
    assert.equal((await evalReadonly(`const [first] = document.querySelectorAll("input"); return first.getAttribute("id")`, doc)).value, "a");
});

// ADVERSARIAL (per AGENTS.md): the new binding form must not become an escape hatch — it can't
// extract a live effectful method, reach a denied prop, or walk to the realm.
test("destructuring ESCAPES are rejected/inert (can't extract an effectful method or reach the realm)", async () => {
    const doc = world();
    // Object-destructuring a denied prop (the window walk) throws — `defaultView` is denylisted at the read.
    await assert.rejects(evalReadonly(`const { fetch } = document.defaultView; return fetch`, doc), outOfDialect);
    // Even a reachable object: destructuring a METHOD binds the INERT sentinel, not the real function — so it
    // can't be pulled off and called past the gate.
    await assert.rejects(evalReadonly(`const { querySelector } = document; return querySelector("a")`, doc), outOfDialect);
    // A denied prop by object destructuring (prototype walk).
    await assert.rejects(evalReadonly(`const { constructor } = {}; return 1`, doc), outOfDialect);
    // Array-destructuring a value that carries the realm can't invoke its methods either (methods → inert / gate).
    await assert.rejects(evalReadonly(`const [w] = [document.defaultView]; return w.fetch("https://evil")`, doc), outOfDialect);
    // The real fetch is never even reachable to bind (ml facade is cache-only; window fetch is off-limits).
    await assert.rejects(evalReadonly(`const { fetch } = window; return fetch`, doc), outOfDialect);
});

test("object spread `{ ...expr }` — including the conditional-field shape models write", async () => {
    assert.deepEqual((await run(`const a = { x: 1 }; return { ...a, y: 2 }`)).value, { x: 1, y: 2 });
    // A later key overrides an earlier spread (JS semantics).
    assert.deepEqual((await run(`const a = { x: 1 }; return { ...a, x: 9 }`)).value, { x: 9 });
    // Conditional spread — `...(cond && { … })`: truthy spreads the object, falsy spreads nothing.
    assert.deepEqual((await run(`return { a: 1, ...(true && { b: 2 }) }`)).value, { a: 1, b: 2 });
    assert.deepEqual((await run(`return { a: 1, ...(false && { b: 2 }) }`)).value, { a: 1 });
    // null / undefined / primitives spread nothing (no throw).
    assert.deepEqual((await run(`return { ...null, ...undefined, a: 1 }`)).value, { a: 1 });
    // The exact shape from the report: map with a conditional-key spread.
    const doc = world();
    const ml = { getModel: async () => "m", fetch: async () => { throw new Error("egress"); },
        _fetchCached: (u) => u.includes("srv") ? { url: u, status: 200, ok: true, type: "json", json: { servers: [{ name: "A", address: "x", public_key: "k" }, { name: "B", address: "y" }] } } : undefined };
    const code = `const r = await ml.fetch("https://x/srv.json"); const servers = r.json?.servers ?? r.json;
        return { count: servers.length, servers: servers.map(s => ({ name: s.name, address: s.address, ...(s.public_key && { hasPublicKey: true }) })) };`;
    assert.deepEqual((await evalReadonly(code, doc, ml)).value,
        { count: 2, servers: [{ name: "A", address: "x", hasPublicKey: true }, { name: "B", address: "y" }] },
        "the reported fetch+spread survey now runs in-dialect (no approval)");
});

// ADVERSARIAL (per AGENTS.md): the spread must not become an escape hatch — it can't copy a live method or
// reach the realm; each own-enumerable value is read through the SAME guard as a member read.
test("object-spread ESCAPES are rejected/inert (can't launder a method or reach the realm)", async () => {
    const doc = world();
    // Spreading the window walk throws — `defaultView` is denied at the read.
    await assert.rejects(evalReadonly(`return { ...document.defaultView }`, doc), outOfDialect);
    // Spreading a realm object (document) hits a denied own-enumerable prop → Denied (never yields its methods).
    await assert.rejects(evalReadonly(`const o = { ...document }; return o.querySelector("a")`, doc), outOfDialect);
    // A function VALUE carried through a spread is the inert sentinel, and calling an arbitrary method name is
    // gated anyway → can't be invoked.
    await assert.rejects(evalReadonly(`const o = { ...{ f: () => 1 } }; return o.f()`, doc), outOfDialect);
    // A denied prop can't be smuggled as a spread key.
    await assert.rejects(evalReadonly(`return { ...{ get constructor() { return fetch } } }`, doc), outOfDialect);
});

test(".then() chains over the ml reads (auto-await left a value, so the callback is applied to it)", async () => {
    assert.equal((await run(`await ml.getModel().then(m => m.toUpperCase())`)).value, "GEMMA4:31B");
    // the whole shape a model actually wrote: batched + chained + logging
    const { logs } = await run(`await Promise.all([
        ml.getModel().then(m => console.log("Model:", m)),
        ml.config().then(c => console.log("Config:", JSON.stringify(c)))
    ])`);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^Model: gemma4:31b$/);
    assert.match(logs[1], /^Config: \{.*"model":"gemma4:31b".*\}$/);
    // a bare (non-inline) callback is still refused — no smuggling a method reference through then()
    await assert.rejects(run(`ml.getModel().then(document.body.getAttribute)`), outOfDialect);
});

test("Promise is a namespace for the combinators only — it can't be called or constructed", async () => {
    await assert.rejects(run(`Promise('x')`), outOfDialect);
    await assert.rejects(run(`new Promise(r => r(1))`), outOfDialect);
    await assert.rejects(run(`Promise.resolve(1)`), outOfDialect);   // not on the allowlist
    await assert.rejects(run(`Promise.constructor('return fetch')()`), outOfDialect);
});

test("a FORGOTTEN await still reads the value (every ml method is auto-awaited)", async () => {
    // Otherwise the model gets a Promise it can't do anything with, and burns a step finding out.
    assert.equal((await run(`ml.getModel()`)).value, "gemma4:31b");
    assert.equal((await run(`ml.config().model`)).value, "gemma4:31b");
});

test("console.log of an ml read is captured like any other value", async () => {
    const { logs } = await run(`console.log('model:', await ml.getModel())`);
    assert.deepEqual(logs, ["model: gemma4:31b"]);
});

// The gated half of the API must be unreachable — and, critically, must not RUN. Each stub throws
// "RAN: <name>", so a rejection that isn't NotInDialect/Denied means the call got through.
const ML_GATED = {
    "setModel (mutates the run's own model)": `await ml.setModel('other')`,
    "unload (mutates VRAM)": `await ml.unload()`,
    "chat (tokens)": `await ml.chat('hi')`,
    "agent (recurses)": `await ml.agent('do a thing')`,
    "read (tokens)": `await ml.read('#a')`,
    "screenshot (privileged capture)": `await ml.screenshot()`,
    "pythonExec (privileged sandbox)": `await ml.pythonExec('1+1')`,
    "computed name dodge": `await ml['set' + 'Model']('other')`,
};
for (const [name, js] of Object.entries(ML_GATED)) {
    test(`ml gate: ${name} is not reachable`, async () => {
        await assert.rejects(run(js), outOfDialect, `"${name}" must be rejected at the gate, never invoked`);
    });
}

test("the ml facade is not a path back to the realm", async () => {
    await assert.rejects(run(`ml.constructor`), outOfDialect);
    await assert.rejects(run(`ml.constructor.constructor('return fetch')()`), outOfDialect);
    await assert.rejects(run(`ml.__proto__`), outOfDialect);
    // reading a facade method as a VALUE yields the inert sentinel — invoking it throws
    await assert.rejects(run(`const f = ml.getModel; f()`), outOfDialect);
    // …and the config it does return is plain data with no realm reference
    assert.deepEqual(Object.keys((await run(`await ml.config()`)).value).sort(), ["apiFormat", "model", "ocrModel"]);
});

test("no ml passed → `ml` isn't in scope at all", async () => {
    await assert.rejects(evalReadonly(`await ml.getModel()`, world()), e => e instanceof Denied);
});

test("await inside a host callback fails closed (the sync driver can't honour it)", async () => {
    // .map/.filter invoke their callback synchronously, so there's nowhere to await — this must
    // fall back to the approval path, never silently produce a wrong (Promise-valued) answer.
    await assert.rejects(run(`[1,2].map(x => await ml.getModel())`), outOfDialect);
    await assert.rejects(run(`document.querySelectorAll('input').filter(el => await ml.getModel())`), outOfDialect);
});

test("an ml call that REJECTS propagates (→ the caller falls back to approval)", async () => {
    const down = { ...ML, models: async () => { throw new Error("server unreachable"); } };
    await assert.rejects(run(`await ml.models()`, world(), down), /server unreachable/);
});

// -------------------------------------------------------------- ml.queryAll (public facade) ---
// queryAll joined ML_READONLY_METHODS: a shadow/iframe-piercing querySelectorAll the dialect may call
// with NO approval. It returns live Elements (not plain data), but they flow through the same read
// mediation as document.querySelectorAll's — no new capability.

test("ml.queryAll is reachable in-dialect and returns mediated elements", async () => {
    const doc = world();
    const ml = { ...ML, queryAll: (sel) => [...doc.querySelectorAll(sel)] };
    const { value } = await run(`(async () => { const els = await ml.queryAll('input'); return els.map(e => e.id); })()`, doc, ml);
    assert.deepEqual(value, ["a", "d"]);
});

test("ml.queryAll auto-awaits (a forgotten await still reads the value)", async () => {
    const doc = world();
    const ml = { ...ML, queryAll: (sel) => [...doc.querySelectorAll(sel)] };
    assert.equal((await run(`ml.queryAll('#a').length`, doc, ml)).value, 1);
});

test("ml.queryAll's returned element can't walk back to the realm", async () => {
    const doc = world();
    const ml = { ...ML, queryAll: (sel) => [...doc.querySelectorAll(sel)] };
    await assert.rejects(run(`(await ml.queryAll('#a'))[0].ownerDocument`, doc, ml), e => e instanceof Denied);
    await assert.rejects(run(`(await ml.queryAll('#a'))[0].constructor`, doc, ml), e => e instanceof Denied);
});

// ------------------------------------------------------------------------- getComputedStyle ---
// A pure same-origin read, bound to the view so it never hands back `window`; its CSSStyleDeclaration's
// walk-back to window is denied. (The classic :visited history leak is dead in all modern browsers.)

function styleWorld() {
    const dom = new JSDOM(`<!doctype html><body><div id="x" style="color: rgb(1, 2, 3); font-weight: 700"></div></body>`);
    return dom.window.document;
}

test("getComputedStyle(el).<prop> reads in-dialect", async () => {
    const { value } = await run(
        `(() => { const s = getComputedStyle(document.querySelector('#x')); return { c: s.color, w: s.fontWeight }; })()`,
        styleWorld(), null);
    assert.equal(value.c, "rgb(1, 2, 3)");
    assert.equal(value.w, "700");
});

test("getComputedStyle(el).getPropertyValue(...) reads in-dialect", async () => {
    const { value } = await run(`getComputedStyle(document.querySelector('#x')).getPropertyValue('color')`, styleWorld(), null);
    assert.equal(value, "rgb(1, 2, 3)");
});

test("getComputedStyle result CANNOT walk back to window (CSS-object hops denied)", async () => {
    for (const prop of ["parentRule", "parentStyleSheet", "ownerNode"]) {
        await assert.rejects(run(`getComputedStyle(document.querySelector('#x')).${prop}`, styleWorld(), null),
            e => e instanceof Denied, `${prop} must be denied`);
    }
});

test("getComputedStyle result: setProperty/removeProperty (mutation) are NOT callable", async () => {
    await assert.rejects(run(`getComputedStyle(document.querySelector('#x')).setProperty('color','red')`, styleWorld(), null), outOfDialect);
    await assert.rejects(run(`getComputedStyle(document.querySelector('#x')).removeProperty('color')`, styleWorld(), null), outOfDialect);
});

// ---------------------------------------------------------------------------------- try/catch ---
// Pure control flow. The safety property: a catch/finally may NEVER swallow a Denied/NotInDialect —
// those keep escalating to the human gate. A genuine runtime error (missing element) IS catchable.

test("try/catch catches a RUNTIME error (method on a missing element) — handled in-dialect", async () => {
    const { value } = await run(`
        try { return document.querySelector('#nope').getAttribute('x'); }
        catch (e) { return "handled"; }
    `);
    assert.equal(value, "handled");
});

test("try/catch catches an incidental throw (JSON.parse of junk)", async () => {
    const { value } = await run(`try { return JSON.parse('{bad'); } catch (e) { return "caught"; }`);
    assert.equal(value, "caught");
});

test("ESCAPE: try/catch must NOT swallow a Denied — it still escalates", async () => {
    // reading a denied prop inside try must reject the whole survey, NOT return "swallowed".
    await assert.rejects(run(`try { return document.querySelector('#a').constructor; } catch (e) { return "swallowed"; }`),
        e => e instanceof Denied);
});

test("ESCAPE: try/catch must NOT swallow a NotInDialect (disallowed method)", async () => {
    // a method the allowlist rejects is a dialect violation, not a program error — uncatchable.
    await assert.rejects(run(`try { return document.querySelector('#a').click(); } catch (e) { return "swallowed"; }`),
        e => e instanceof NotInDialect);
});

test("ESCAPE: an unavailable identifier inside try still escalates (window)", async () => {
    await assert.rejects(run(`try { return window; } catch (e) { return "swallowed"; }`), e => e instanceof Denied);
});

test("ESCAPE: a gated ml method inside try still escalates (chat)", async () => {
    await assert.rejects(run(`try { return await ml.chat("hi"); } catch (e) { return "swallowed"; }`), outOfDialect);
});

test("ESCAPE: a return in finally CANNOT paper over a guard denial", async () => {
    // a normal `return 1` in finally overrides — but a Denied must win, so the survey still escalates.
    await assert.rejects(run(`try { return window; } finally { return "swallowed"; }`), e => e instanceof Denied);
});

test("finally: a return in finally overrides a NORMAL result (JS semantics)", async () => {
    assert.equal((await run(`try { return 1; } finally { return 2; }`)).value, 2);
});

test("try/catch around a REJECTED await catches it (driver throws back into the generator)", async () => {
    const down = { ...ML, models: async () => { throw new Error("boom"); } };
    const { value } = await run(`try { await ml.models(); return "no"; } catch (e) { return "rejected: " + e.message; }`, world(), down);
    assert.equal(value, "rejected: boom");
});

// ------------------------------------------------------------------------- template literals ---

test("template literal: basic interpolation + concatenation", async () => {
    assert.equal((await run("`a${1+2}b${'c'}`")).value, "a3bc");
});

test("template literal: the user's iframe survey line runs in-dialect", async () => {
    const dom = new JSDOM(`<!doctype html><body><iframe src="http://a.test/1"></iframe><iframe src="http://a.test/2"></iframe></body>`);
    const { value } = await run(
        "return [...document.querySelectorAll('iframe')].map((f, i) => `Frame ${i+1}: src=${f.src}`).join('\\n')",
        dom.window.document, null);
    assert.equal(value, "Frame 1: src=http://a.test/1\nFrame 2: src=http://a.test/2");
});

test("template literal: nested braces / object member inside ${}", async () => {
    assert.equal((await run("`x${ {a: 5}.a }y`")).value, "x5y");
});

test("template literal: nested template inside an interpolation", async () => {
    assert.equal((await run("`a${ `b${1+1}c` }d`")).value, "ab2cd");
});

test("template literal: escapes (\\n, \\`, \\$)", async () => {
    assert.equal((await run("`line\\n\\`tick\\` end`")).value, "line\n`tick` end");
});

test("ESCAPE: a denied op inside ${} still escalates (can't be laundered through a template)", async () => {
    await assert.rejects(run("`v=${window}`"), e => e instanceof Denied);
    await assert.rejects(run("`v=${document.querySelector('#a').constructor}`"), e => e instanceof Denied);
});

test("ESCAPE: a statement smuggled into ${} fails closed", async () => {
    await assert.rejects(run("`${1; 2}`"), outOfDialect);
});
