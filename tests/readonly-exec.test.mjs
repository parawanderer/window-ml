"use strict";
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";

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
const ML_CALLS = [];
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
    // A pure read of THIS run's already-captured outputs — free in the dialect for the same reason the other
    // read-only members are. Records what it was asked for, so the adversarial tests can prove nothing effectful
    // slipped through it.
    dereference: async (ref, opts) => { ML_CALLS.push(["dereference", ref, opts && opts.pipe]); return `VALUE(${ref})`; },
    // Machine CAPACITY — a read of the hardware that spends nothing and changes nothing.
    info: async () => { ML_CALLS.push(["info"]); return { compute: { system_compute: { total_memory: 130142785536 },
        supported_gpus: [{ gpu_id: "0", name: "CUDA0", total_memory: 101972967424, free_memory: 101386813440, runner: "CUDA" }] } }; },
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
    // Member assignment on an object YOU built is now IN-dialect; a bare-VARIABLE assignment is not (it could
    // rebind the environment) — it escalates.
    "bare-variable assignment": `const x = 1; x = 2; x`,
    "compound assignment": `const o = {}; o.n = 0; o.n += 1; o.n`,   // only plain `=`, no `+=`
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
test("for…of CAN now accumulate into an array YOU built (push) — but not via variable reassignment", async () => {
    // Building a local accumulator is in-dialect: `.push()` onto a script-created array mutates only that
    // local container (never the page — see the adversarial block). Variable reassignment (`s += x`) stays out.
    assert.deepEqual((await run(`const r = []; for (const x of [1, 2, 3]) r.push(x * 2); return r;`)).value, [2, 4, 6]);
    assert.deepEqual((await run(`const g = {}; for (const n of ['a:1','b:2','a:3']) { const k = n.split(':')[0]; (g[k] = g[k] || []).push(n); } return g;`)).value,
        { a: ["a:1", "a:3"], b: ["b:2"] });
    // A string accumulator via `s += x` needs a bare-variable reassignment → still out of dialect.
    await assert.rejects(run(`let s = ''; for (const x of ['a', 'b']) s += x; s`), outOfDialect);
});
test("for…of over a non-iterable throws a catchable TypeError (not a guard escalation)", async () => {
    await assert.rejects(run(`for (const x of 5) console.log(x)`), e => e instanceof TypeError);
});

// --- the model-family grouping surveys Shane actually ran — assignment-accumulator, .reduce, and
//     new Set + spread + sort. All pure LOCAL computation, now in-dialect (they used to escalate). ---
const MODELS_ML = { models: async () => ["gemma4:31b", "qwen3.8:27b", "litellm.gpt-4o", "gemma4:e2b", "qwen2.5vl:7b"] };
test("survey: group local models by family via (o[k] = o[k] || []).push(n) — runs", async () => {
    const { value } = await run(`const m = await ml.models();
const local = m.filter(x => !x.startsWith('litellm.'));
const families = {};
for (const n of local) { const key = n.split(/[:.]/)[0].toLowerCase(); (families[key] = families[key] || []).push(n); }
const order = Object.entries(families).map(([k, v]) => v.length ? \`\${k} (\${v.length})\` : k);
return { totalLocal: local.length, byFamily: order, allLocal: local };`, world(), MODELS_ML);
    assert.equal(value.totalLocal, 4);
    assert.deepEqual(value.byFamily.slice().sort(), ["gemma4 (2)", "qwen2 (1)", "qwen3 (1)"]);
});
test("survey: the SAME grouping via .reduce + Object.entries + a destructured ([k,v]) arrow — runs", async () => {
    const { value } = await run(`const m = await ml.models();
const local = m.filter(x => !x.startsWith('litellm.'));
const families = local.reduce((acc, n) => { const key = n.split(/[:.]/)[0].toLowerCase(); (acc[key] = acc[key] || []).push(n); return acc; }, {});
return { totalLocal: local.length, byFamily: Object.entries(families).map(([k, v]) => \`\${k} (\${v.length})\`) };`, world(), MODELS_ML);
    assert.equal(value.totalLocal, 4);
    assert.deepEqual(value.byFamily.slice().sort(), ["gemma4 (2)", "qwen2 (1)", "qwen3 (1)"]);
});
test("survey: families via [...new Set(...)].sort() (spread + new Set + in-place sort on an owned array) — runs", async () => {
    const { value } = await run(`const m = await ml.models();
const local = m.filter(x => !x.startsWith('litellm.'));
const byFamily = [...new Set(local.map(n => n.split(/[:.]/)[0].toLowerCase()))].sort();
return { families: byFamily, cloud: m.filter(x => x.startsWith('litellm.')) };`, world(), MODELS_ML);
    assert.deepEqual(value.families, ["gemma4", "qwen2", "qwen3"]);
    assert.deepEqual(value.cloud, ["litellm.gpt-4o"]);
});

// --- ADVERSARIAL: the new constructs (member assignment · `new` · destructuring · in-place mutators) must
//     never become an escape or a page-mutation vector. Every bypass attempt is REJECTED or rendered inert. ---
test("adversarial (assignment): cannot mutate the PAGE — a DOM node or its properties", async () => {
    const doc = world();
    await assert.rejects(run(`document.body.textContent = 'hacked'; 1`, doc), outOfDialect);
    await assert.rejects(run(`document.querySelector('#a').value = 'x'; 1`, doc), outOfDialect);
    await assert.rejects(run(`document.title = 'x'; 1`, doc), outOfDialect);
    await assert.rejects(run(`document.querySelector('#a').onclick = 1; 1`, doc), outOfDialect);
    assert.equal(doc.title, "");                       // the page is untouched
    assert.equal(doc.querySelector("#a").value, "");
});
test("adversarial (assignment): cannot rebind a bare variable (window/document/globals) — no env corruption", async () => {
    await assert.rejects(run(`window = new Map(); 1`), outOfDialect);                       // the user's exact worry
    await assert.rejects(run(`document = new Map(); document.querySelectorAll('x')`), outOfDialect);
    await assert.rejects(run(`Object = { entries: () => [] }; Object.entries({})`), outOfDialect);
    await assert.rejects(run(`const x = 1; x = 2; x`), outOfDialect);
});
test("adversarial (assignment): cannot poison the prototype or reach the realm via a WRITE", async () => {
    await assert.rejects(run(`const o = {}; o.__proto__ = { pwned: 1 }; o`), outOfDialect);
    await assert.rejects(run(`const o = {}; o['__proto__'] = {}; o`), outOfDialect);
    await assert.rejects(run(`const o = {}; o.constructor = 1; o`), outOfDialect);
    await assert.rejects(run(`const a = []; a['constructor'] = 1; a`), outOfDialect);
    assert.equal(({}).pwned, undefined);               // Object.prototype stayed clean
});
test("adversarial (assignment): cannot LAUNDER a live method by storing it under an allowlisted name", async () => {
    const doc = world();
    // Reading a method as a value gives the inert METHOD_REF; stored under 'map' and called, it still throws.
    await assert.rejects(run(`const o = {}; o.map = document.querySelector; o.map('#a')`, doc), outOfDialect);
    await assert.rejects(run(`const o = {}; o.c = [].constructor; o.c`, doc), outOfDialect);   // .constructor read is denied
});
test("adversarial (mutators): push/sort/… only touch an array YOU built — never one reached off the page", async () => {
    const doc = world();
    doc.appData = [3, 1, 2];   // a live array on a page object → reached via a property read → NOT owned
    await assert.rejects(run(`document.appData.push(9); document.appData`, doc), outOfDialect);
    await assert.rejects(run(`document.appData.sort(); document.appData`, doc), outOfDialect);
    await assert.rejects(run(`document.appData.reverse(); 1`, doc), outOfDialect);
    assert.deepEqual(doc.appData, [3, 1, 2]);           // untouched
    // A fresh COPY (spread / slice) is owned → mutable.
    assert.deepEqual((await run(`[...document.appData].sort()`, doc)).value, [1, 2, 3]);
    assert.deepEqual((await run(`document.appData.slice().reverse()`, doc)).value, [2, 1, 3]);
    assert.deepEqual(doc.appData, [3, 1, 2]);           // still untouched
});
test("adversarial (new): only pure builtins — code gen / network / host constructors are Denied", async () => {
    await assert.rejects(run(`new Function('return 1')()`), outOfDialect);
    await assert.rejects(run(`new Function('return this')().constructor`), outOfDialect);
    await assert.rejects(run(`new Image()`), outOfDialect);
    await assert.rejects(run(`new XMLHttpRequest()`), outOfDialect);
    await assert.rejects(run(`new WebSocket('ws://x')`), outOfDialect);
    await assert.rejects(run(`new (document.defaultView.Function)('code')`), outOfDialect);   // defaultView denied + `new (expr)` unsupported
    // The pure ones build fine.
    assert.deepEqual((await run(`[...new Set([1, 1, 2, 3])]`)).value, [1, 2, 3]);
    assert.equal((await run(`new Set([1, 2, 2]).size`)).value, 2);
    assert.equal((await run(`new Array(3).length`)).value, 3);
    assert.equal((await run(`new Map([['a', 1], ['b', 2]]).size`)).value, 2);
});
test("Set/Map: the reported grouping survey (new Set + has/add + spread + console.log) auto-runs, with logs", async () => {
    const js = `const s = new Set(['apple', 'banana', 'cherry', 'date', 'apple', 'fig']);
        const has = s.has('banana');
        const size = s.size;
        const hasApple = s.has('apple');
        s.add('grape');
        const after = [...s];
        console.log('before:', size, 'has banana:', has, 'has apple (dup):', hasApple);
        console.log('after add:', after);
        return { size, has, hasApple, after };`;
    const { value, logs } = await run(js);
    assert.deepEqual(value, { size: 5, has: true, hasApple: true, after: ["apple", "banana", "cherry", "date", "fig", "grape"] });
    assert.ok(logs.some(l => /before: 5/.test(l)), "console.log output is captured");
    assert.ok(logs.some(l => /after add:/.test(l)), "the second log line is captured too");
});
test("Set/Map: reads + mutators (has/get/add/set/delete/clear) work on a container YOU built", async () => {
    assert.deepEqual((await run(`const m = new Map(); m.set('a', 1); m.set('b', 2); return [m.get('a'), m.has('b'), m.size];`)).value, [1, true, 2]);
    assert.equal((await run(`const m = new Map([['a', 1], ['b', 2]]); m.delete('a'); return m.size;`)).value, 1);
    assert.equal((await run(`const s = new Set([1, 2, 3]); s.clear(); return s.size;`)).value, 0);
    // A Map-of-arrays accumulator (the family-grouping idiom) built without reassignment or `if`.
    assert.deepEqual((await run(`['ab', 'ac', 'bd'].reduce((m, n) => { const k = n[0]; (m.get(k) || m.set(k, []).get(k)).push(n); return m; }, new Map()).size`)).value, 2);
});
test("adversarial (Set/Map mutators): add/set/delete/clear only touch a container YOU built — never off the page", async () => {
    const doc = world();
    doc.body.className = "a b";
    // classList is a live DOMTokenList reached off a page node → NOT owned → its mutators are refused.
    await assert.rejects(run(`document.body.classList.add('evil'); 1`, doc), outOfDialect);
    await assert.rejects(run(`document.body.classList.remove('a'); 1`, doc), outOfDialect);   // not even allowlisted
    assert.equal(doc.body.className, "a b");   // untouched
    // A Set/Map hung on a page object is reached via a property read → NOT owned → mutators Denied.
    doc.appSet = new Set([1, 2]);
    doc.appMap = new Map([["a", 1]]);
    await assert.rejects(run(`document.appSet.add(9); 1`, doc), outOfDialect);
    await assert.rejects(run(`document.appMap.set('b', 2); 1`, doc), outOfDialect);
    await assert.rejects(run(`document.appSet.clear(); 1`, doc), outOfDialect);
    await assert.rejects(run(`document.appMap.delete('a'); 1`, doc), outOfDialect);
    assert.equal(doc.appSet.size, 2); assert.equal(doc.appMap.size, 1);   // untouched
    // READING a page Set/Map is fine (has/get/size are pure) — only the mutators are gated.
    assert.equal((await run(`document.appSet.has(1)`, doc)).value, true);
    assert.equal((await run(`document.appMap.get('a')`, doc)).value, 1);
});
test("adversarial (Set/Map): a script-created Set/Map is owned for its METHODS but is still not an o[k]=v target, and can't reach the realm", async () => {
    // Marking `new Set()` owned (so .add works) must NOT open property assignment on it.
    await assert.rejects(run(`const s = new Set(); s.foo = 1; s`), outOfDialect);
    await assert.rejects(run(`const m = new Map(); m['x'] = 1; m`), outOfDialect);
    // …and the realm stays unreachable through it (constructor read denied).
    await assert.rejects(run(`const s = new Set(); s.constructor`), outOfDialect);
    await assert.rejects(run(`new Map().constructor`), outOfDialect);
    // A mutator can't be LAUNDERED onto a page container by copying it into an owned one, either — the copy
    // is a different (owned) object; the page Set is untouched.
    const doc = world();
    doc.appSet = new Set([1]);
    await assert.rejects(run(`const s = document.appSet; s.add(2); 1`, doc), outOfDialect);
    assert.equal(doc.appSet.size, 1);
});
test("adversarial (destructuring): you can GET a data property but not a DENIED one or a usable live method", async () => {
    const doc = world();
    await assert.rejects(run(`const { constructor } = {}; constructor('return 1')`), outOfDialect);
    await assert.rejects(run(`document.querySelectorAll('input').map(({ constructor }) => constructor)`, doc), outOfDialect);
    // A destructured METHOD is the inert sentinel — calling it throws.
    await assert.rejects(run(`const [f] = [document.querySelector]; f('#a')`, doc), outOfDialect);
    await assert.rejects(run(`document.querySelectorAll('input').map(el => { const { getAttribute } = el; return getAttribute('id'); })`, doc), outOfDialect);
    // Benign DATA destructuring works (params + declarations).
    assert.deepEqual((await run(`const { a, b } = { a: 1, b: 2 }; return [a, b];`)).value, [1, 2]);
    assert.deepEqual((await run(`const [x, y] = [10, 20]; return x + y;`)).value, 30);
    assert.deepEqual((await run(`[{ a: 1 }, { a: 2 }].map(({ a }) => a * 10)`)).value, [10, 20]);
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
    // `{ fresh: true }` explicitly SKIPS the cache → forces a real fetch → falls to approval, even for a cached url.
    await assert.rejects(run(`ml.fetch("https://x.test/data.json", { fresh: true })`, world(), ml), outOfDialect);
    // `{ credentials: true }` fetches AS THE USER (egress) → never in the read-only dialect, even for a cached url.
    await assert.rejects(run(`ml.fetch("https://x.test/data.json", { credentials: true })`, world(), ml), outOfDialect);
    // A falsy/absent fresh flag still reads the cache (free).
    assert.deepEqual((await run(`ml.fetch("https://x.test/data.json", { fresh: false })`, world(), ml)).value, cached);
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

// --- blessed DOM primitive: ml.a11y(el) (compose the interactives/findByText job) ---
// It takes a LIVE element (from queryAll) and returns a fresh plain OBJECT of strings — { role, name, state,
// selector } — the a11y + `>>>`-reference expertise, so exec can compose a custom finder as a read-only survey.
// Per the AGENTS.md RULE, adversarial-tested: the element-arg pattern can't become an escape, the object can't
// reach a realm (its constructor/proto stay denied), and it adds no capability.
const withPrims = (doc) => ({
    ...ML,
    queryAll: (s) => [...doc.querySelectorAll(s)],
    a11y: (el) => ({
        role: (el && el.tagName) ? el.tagName.toLowerCase() : "",
        name: (!el || !el.getAttribute) ? "" : (el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.textContent || "")),
        state: "",
        selector: (el && el.id) ? "#" + el.id : "",
    }),
});

test("blessed primitive: ml.a11y COMPOSES the finder in a read-only survey (auto-approves, no gate)", async () => {
    const doc = world();
    const ml = withPrims(doc);
    // The interactives/findByText job, composed: map each element to its a11y view, filter by name, take selectors.
    const js = `ml.queryAll("input, textarea, [contenteditable]")
        .map(el => ml.a11y(el))
        .filter(a => a.name.includes("Gemini"))
        .map(a => a.selector)`;
    assert.deepEqual((await run(js, doc, ml)).value, ["#a", "#b", "#c"], "one object per element, filtered + mapped in-dialect");
    // Reading its fields inside a .map callback (sync ml read), like queryAll.
    assert.deepEqual((await run(`ml.queryAll("#a").map(el => ({ name: ml.a11y(el).name, sel: ml.a11y(el).selector }))`, doc, ml)).value,
        [{ name: "Ask Gemini", sel: "#a" }]);
});

test("blessed primitive: ml.a11y ADVERSARIAL — object can't reach a realm, facade-only name, harmless args, no new effect", async () => {
    const doc = world();
    const ml = withPrims(doc);
    // (1) the returned OBJECT can't be walked to a constructor / prototype / realm.
    await assert.rejects(run(`ml.a11y(ml.queryAll("input")[0]).constructor`, doc, ml), outOfDialect);
    await assert.rejects(run(`ml.a11y(ml.queryAll("input")[0])["__proto__"]`, doc, ml), outOfDialect);
    // (2) the name lives ONLY on the ml facade — calling it on a page object is out-of-dialect (not a global method).
    await assert.rejects(run(`document.body.a11y()`, doc, ml), outOfDialect);
    await assert.rejects(run(`ml.queryAll("input")[0].a11y()`, doc, ml), outOfDialect);
    // (3) an odd/hostile ARG is harmless — a non-element still yields the string-valued object, no throw/leak.
    assert.equal(typeof (await run(`ml.a11y(document).name`, doc, ml)).value, "string");
    assert.equal((await run(`ml.a11y(null).selector`, doc, ml)).value, "");
    // (4) it adds NO new reach to the gated half — the effectful ml methods are still unreachable.
    await assert.rejects(run(`ml.setModel("x")`, doc, ml), outOfDialect);
    await assert.rejects(run(`ml.screenshot("@pt:0")`, doc, ml), outOfDialect);
});

/* ---------------------- ml.answer (the curate-only facade) ---------------------- */
// The FIRST mutating facade member. Per the repo RULE, extending the dialect requires ADVERSARIAL tests:
// prove the new surface can only curate the run's own answer and can't be abused to reach a node/the realm.
import { AnswerSet, makeAnswerFacade } from "../src/answer-set.ts";
const runAns = (js, set = new AnswerSet(), doc = world()) =>
    evalReadonly(js, doc, ML, makeAnswerFacade(set, el => el.id || el.tagName));

test("ml.answer: add text / @tool token, remove, clear run FREE in the dialect (no approval)", async () => {
    const set = new AnswerSet();
    await runAns(`ml.answer.add("Total: 42")`, set);
    await runAns(`ml.answer.add("@tool:35bf1f0:out")`, set);
    assert.deepEqual(set.items.map(i => i.kind), ["text", "token"], "text vs @tool: classified");
    assert.equal((await runAns(`ml.answer.length`, set)).value, 2);
    await runAns(`ml.answer.remove(0)`, set);
    assert.equal(set.length, 1, "removed by index");
    await runAns(`ml.answer.clear()`, set);
    assert.equal(set.length, 0, "cleared");
});

test("ml.answer.dump() is compact — indexed previews, NEVER nodes/media/content", async () => {
    const set = new AnswerSet();
    await runAns(`ml.answer.add(document.getElementById("a"))`, set);
    assert.equal(set.items[0].kind, "element", "a live element was designated");
    const { value } = await runAns(`ml.answer.dump()`, set);
    assert.deepEqual(value, [{ i: 0, kind: "element", preview: "a" }]);
    assert.ok(!JSON.stringify(value).includes("nodeType"), "the live node never appears in a dump");
});

test("ml.answer.add(element) returns an INDEX, not the node — no node handed back to the survey", async () => {
    const set = new AnswerSet();
    const { value } = await runAns(`ml.answer.add(document.getElementById("a"))`, set);
    assert.equal(value, 0, "add returns the item index (a number), never the element");
});

test("ml.answer: no elements()/media()/items surface — the stored nodes can't be walked back to the realm", async () => {
    const set = new AnswerSet();
    set.add({ kind: "element", nodes: [{ nodeType: 1 }], preview: "x" });
    // None of the node-bearing accessors exist on the facade → undefined, so there's no path to a node → window.
    assert.equal((await runAns(`ml.answer.items`, set)).value, undefined);
    assert.equal((await runAns(`ml.answer.elements`, set)).value, undefined);
    assert.equal((await runAns(`ml.answer.media`, set)).value, undefined);
    assert.equal((await runAns(`ml.answer.toMarkdown`, set)).value?.name ?? undefined, undefined, "toMarkdown isn't exposed");
});

test("ml.answer: a method can't be EXTRACTED and called indirectly (METHOD_REF sentinel)", async () => {
    const set = new AnswerSet();
    await assert.rejects(runAns(`const f = ml.answer.add; f("sneaky")`, set), outOfDialect);
    assert.equal(set.length, 0, "the indirect call never mutated the set");
});

test("ml.answer: constructor / __proto__ are denied (no prototype-walk off the facade)", async () => {
    const set = new AnswerSet();
    await assert.rejects(runAns(`ml.answer.constructor`, set), outOfDialect);
    await assert.rejects(runAns(`ml.answer.__proto__`, set), outOfDialect);
    await assert.rejects(runAns(`ml.answer.constructor("return this")()`, set), outOfDialect);
});

test("the answer methods did NOT leak globally — remove()/dump() on any other object stay out of dialect", async () => {
    await assert.rejects(runAns(`[1,2,3].remove(0)`), outOfDialect, "remove is not a global allowed method");
    await assert.rejects(runAns(`[1,2,3].dump()`), outOfDialect, "dump is not a global allowed method");
});

test("the owned-mutation guard is INTACT — add/clear on a page object stay Denied (only the answer facade is exempt)", async () => {
    // classList.add is reached off a page node, not the answer facade → still refused. Proves `!onAnswer` only
    // exempted the answer facade, not `add`/`clear` everywhere.
    await assert.rejects(runAns(`document.body.classList.add("x")`), outOfDialect);
});

// --- ADVERSARIAL: ml.dereference as a dialect member -------------------------------------------------------
// Required by the AGENTS rule: a new facade member must be probed for whether it can be abused to reach
// something it shouldn't. `dereference` is a pure read of this run's own captured outputs, so the question is
// whether it can be turned into a lever — extracted, re-bound, walked through, or used to smuggle a call.

test("ml.dereference: the plain read works (that is the point of it being free)", async () => {
    ML_CALLS.length = 0;
    assert.equal((await run(`return ml.dereference("@tool:a1b2c3f")`)).value, "VALUE(@tool:a1b2c3f)");
    assert.equal((await run(`return ml.dereference("@tool:a1b2c3f", { pipe: ".rows | head 5" })`)).value, "VALUE(@tool:a1b2c3f)");
    assert.deepEqual(ML_CALLS.at(-1), ["dereference", "@tool:a1b2c3f", ".rows | head 5"], "the options object reaches it intact");
    // Auto-await means a forgotten await still yields the value, and .then applies inline (the shapes models write).
    assert.equal((await run(`return ml.dereference("@tool:x").then(v => v.length)`)).value, "VALUE(@tool:x)".length);
    const all = (await run(`return Promise.all([ml.dereference("@tool:a"), ml.dereference("@tool:b")])`)).value;
    assert.deepEqual(all, ["VALUE(@tool:a)", "VALUE(@tool:b)"]);
});

test("ADVERSARIAL: dereference can't be extracted, re-bound, or re-targeted at an effectful method", async () => {
    ML_CALLS.length = 0;
    // Reading it as a value yields the inert METHOD_REF sentinel, like every other facade method.
    await assert.rejects(run(`const f = ml.dereference; return f("@tool:a")`), outOfDialect);
    await assert.rejects(run(`const o = { d: ml.dereference }; return o.d("@tool:a")`), outOfDialect);
    // call/apply/bind must not re-target it (the classic escape: borrow a permitted function, aim it elsewhere).
    await assert.rejects(run(`return ml.dereference.call(ml, "@tool:a")`), outOfDialect);
    await assert.rejects(run(`return ml.dereference.apply(ml, ["@tool:a"])`), outOfDialect);
    await assert.rejects(run(`return ml.dereference.bind(ml)("@tool:a")`), outOfDialect);
    assert.deepEqual(ML_CALLS, [], "not one of those reached the real method");
});

test("ADVERSARIAL: dereference is no route to the realm, or to the methods it sits beside", async () => {
    // Walking off the function to a constructor / Function is the standard sandbox break.
    await assert.rejects(run(`return ml.dereference.constructor("return 1")()`), outOfDialect);
    await assert.rejects(run(`return ml.dereference.constructor.constructor("return globalThis")()`), outOfDialect);
    await assert.rejects(run(`return ml.dereference.__proto__`), outOfDialect);
    await assert.rejects(run(`return ml.dereference.prototype`), outOfDialect);
    // The facade holds ONLY the read-only set, so the token-spending / mutating / privileged halves aren't
    // present to reach — with or without dereference in scope.
    for (const js of [`ml.chat("hi")`, `ml.agent("x")`, `ml.pythonExec("1")`, `ml.setModel("m")`, `ml.screenshot()`]) {
        await assert.rejects(run(`return ${js}`), outOfDialect, js);
    }
    // And its RESULT is a plain string — no property walk off it reaches anything.
    await assert.rejects(run(`return ml.dereference("@tool:a").constructor`), outOfDialect);
    await assert.rejects(run(`return ml.dereference("@tool:a").constructor("return 1")()`), outOfDialect);
});

test("ADVERSARIAL: the pipe argument is data, not a second execution channel", async () => {
    ML_CALLS.length = 0;
    // Whatever the model puts in `pipe` is a STRING handed to a closed, pure dialect — it can't smuggle a call
    // out of the interpreter, and the fixture records exactly what was passed.
    await run(`return ml.dereference("@tool:a", { pipe: "exec rm -rf /" })`);
    assert.deepEqual(ML_CALLS.at(-1), ["dereference", "@tool:a", "exec rm -rf /"], "passed through as inert text");
    // An arrow IS legal in the dialect (that is how .map callbacks work), so writing one here doesn't throw —
    // the guarantee is that it is never INVOKED: it crosses as an inert interpreter closure, and `pipe` is
    // normalised to "" for anything that isn't a string or an array of stages (normalizePipe, unit-tested).
    ML_CALLS.length = 0;
    await run(`return ml.dereference("@tool:a", { pipe: () => ml.chat("x") })`);
    assert.ok(!ML_CALLS.some(c => c[0] === "chat"), "the callback was never called — no smuggled execution");
    // A method that isn't ON the facade reads as undefined, so it travels as an inert value, not a callable —
    // the guarantee here is "nothing effectful is carried in", not that the expression throws.
    ML_CALLS.length = 0;
    await run(`return ml.dereference("@tool:a", { pipe: ml.chat })`);
    assert.equal(ML_CALLS.at(-1)[2], undefined, "ml.chat isn't on the facade, so nothing live was passed");
    // A facade method placed in an object literal DOES cross as the live bound function (the METHOD_REF
    // sentinel covers extraction-then-call, not this path). That is inert in practice, and this asserts WHY:
    // the facade holds only read-only members, so the effectful half cannot be leaked this way at all.
    await run(`return ml.dereference("@tool:a", { pipe: ml.getModel })`);
    assert.equal((await run(`const o = { c: ml.chat, s: ml.setModel, p: ml.pythonExec }; return [typeof o.c, typeof o.s, typeof o.p].join()`)).value,
        "undefined,undefined,undefined", "no effectful method exists on the facade to smuggle out this way");
    // And extracting a read-only one still can't be INVOKED — the identity check is what stops the lever.
    await assert.rejects(run(`const p = ml.getModel; return ml.dereference("@tool:a", { pipe: p() })`), outOfDialect,
        "an extracted method can't be invoked to build the argument");
    // Nor can a spread launder a live method out of the facade: the effectful half isn't THERE to copy, and
    // the copied read-only method is rejected on call (the facade is checked by IDENTITY, not by name).
    assert.equal((await run(`const o = { ...ml }; return typeof o.chat`)).value, "undefined",
        "the token-spending half was never on the facade to be spread");
    await assert.rejects(run(`const o = { ...ml }; return o.dereference("@tool:a")`), outOfDialect,
        "and a spread copy of dereference can't be invoked");
});

test("ADVERSARIAL: dereference can't be looped unboundedly to burn the page down", async () => {
    // The dialect has no unbounded loop construct; a while/for is out of dialect, so a deref storm isn't
    // expressible (and each call is a pure read anyway).
    await assert.rejects(run(`while (true) { ml.dereference("@tool:a"); }`), outOfDialect);
    await assert.rejects(run(`for (;;) ml.dereference("@tool:a");`), outOfDialect);
});

// --- ADVERSARIAL: ml.info as a dialect member --------------------------------------------------------------
// Required by the AGENTS rule. `info` is machine capacity — VRAM totals, system RAM — so a survey asking
// "will this fit" shouldn't cost a prompt. The question is whether reading hardware opens any other door.

test("ml.info: the plain read works, and its nested shape is walkable", async () => {
    ML_CALLS.length = 0;
    const gpus = (await run(`return ml.info().compute.supported_gpus.map(g => g.name)`)).value;
    assert.deepEqual(gpus, ["CUDA0"], "auto-await, then an ordinary property walk into the response");
    const total = (await run(`return ml.info().compute.supported_gpus[0].total_memory`)).value;
    assert.equal(total, 101972967424, "raw BYTES — the dialect never sees a pre-formatted figure");
    assert.deepEqual(ML_CALLS, [["info"], ["info"]]);
});

test("ADVERSARIAL: info can't be extracted, re-bound, or walked to the realm", async () => {
    ML_CALLS.length = 0;
    await assert.rejects(run(`const f = ml.info; return f()`), outOfDialect);
    await assert.rejects(run(`return ml.info.call(ml)`), outOfDialect);
    await assert.rejects(run(`return ml.info.apply(ml, [])`), outOfDialect);
    await assert.rejects(run(`return ml.info.bind(ml)()`), outOfDialect);
    await assert.rejects(run(`return ml.info.constructor("return globalThis")()`), outOfDialect);
    assert.deepEqual(ML_CALLS, [], "none of those reached the real method");
});

test("ADVERSARIAL: the info RESPONSE is inert data, not a route to anything", async () => {
    // The response is plain JSON from the worker — walking off it must reach nothing.
    await assert.rejects(run(`return ml.info().constructor`), outOfDialect);
    await assert.rejects(run(`return ml.info().constructor.constructor("return 1")()`), outOfDialect);
    await assert.rejects(run(`return ml.info().__proto__`), outOfDialect);
    await assert.rejects(run(`return ml.info().compute.__proto__`), outOfDialect);
    // And it is no lever onto the effectful half, which isn't on the facade at all.
    assert.equal((await run(`return typeof ml.unload`)).value, "undefined");
    assert.equal((await run(`return typeof ml.pythonExec`)).value, "undefined");
});

// --- ADVERSARIAL: ml.schema, and the OBJECT ml.dereference now returns -------------------------------------
// Two changes to probe, per the AGENTS rule. `schema` is a new facade member; and `dereference` now resolves
// to a String SUBCLASS carrying metadata and methods, which is new surface inside the dialect — an object
// where there used to be a primitive is exactly the shape an escape hides in.

const SCHEMA_ML = {
    ...ML,
    schema: async (...vs) => { ML_CALLS.push(["schema", vs.length]); const { joinShapes, jsonValue } = await import("../src/dom.ts"); return joinShapes(vs.map((v, i) => jsonValue(v, `argument ${i + 1}`))); },
    dereference: async (ref) => {
        const { DerefText } = await import("../src/ml-agent.ts");
        return new DerefText('{"id":1,"name":"a"}', { id: "a1b2c3f", tool: "fetch_url", kind: "json", step: 2 },
            async () => { throw new Error("repipe reached"); });
    },
};
const runS = (js) => evalReadonly(js, world(), SCHEMA_ML);

test("ml.schema: the intended use works — the joined type of two pointer reads", async () => {
    ML_CALLS.length = 0;
    const { value } = await runS(`return ml.schema(ml.dereference("@tool:a"), ml.dereference("@tool:b"))`);
    assert.equal(value, "{ id: number, name: string }", "both reads shaped and joined, no approval needed");
});

test("ml.schema: a plain value works, and prose is refused rather than shaped", async () => {
    assert.equal((await runS(`return ml.schema({ a: 1 })`)).value, "{ a: number }");
    await assert.rejects(runS(`return ml.schema("just prose")`), /not JSON/);
});

test("ADVERSARIAL: ml.schema can't be extracted, re-bound, or aimed at the realm", async () => {
    ML_CALLS.length = 0;
    // Same guarantees as every other facade member: reading it yields the inert sentinel.
    await assert.rejects(runS(`const f = ml.schema; return f({a:1})`), outOfDialect);
    await assert.rejects(runS(`return ml.schema.call(ml, {a:1})`), outOfDialect);
    await assert.rejects(runS(`return ml.schema.bind(ml)({a:1})`), outOfDialect);
    assert.deepEqual(ML_CALLS, [], "none of those reached the real method");
});

test("ADVERSARIAL: ml.schema refuses a host object, and can only ever hand back a string", async () => {
    // A DOM node walked as data would print its property names as though they were a schema, so a host
    // object is refused outright.
    await assert.rejects(runS(`return ml.schema(document)`), /not JSON|out of dialect|Denied/i);
    await assert.rejects(runS(`return ml.schema(document.body)`), /not JSON|out of dialect|Denied/i);

    // An ARRAY of nodes is not refused — an array IS a JSON shape, and the guard is top-level. That is
    // safe for the reason that matters: the return is a STRING, so no reference escapes whatever it walked.
    // (It is also useless, which is the honest outcome: DOM nodes have no own enumerable data.)
    const out = (await runS(`return ml.schema(document.querySelectorAll("input"))`)).value;
    assert.equal(typeof out, "string", "only text comes back, never a live object");
    assert.doesNotMatch(out, /function|=>/, "and nothing callable is described");
});

test("the dereference RESULT is usable as the string it is, with its metadata readable", async () => {
    // String methods still work on it (it is a String subclass), which is what keeps every prior spelling alive.
    assert.equal((await runS(`return ml.dereference("@tool:a").length`)).value, 19);
    assert.equal((await runS(`return ml.dereference("@tool:a").startsWith("{")`)).value, true);
    assert.equal((await runS(`return ml.dereference("@tool:a").split(",")[0]`)).value, '{"id":1');
    // the metadata reads are plain data
    assert.equal((await runS(`return ml.dereference("@tool:a").type`)).value, "json");
    assert.equal((await runS(`return ml.dereference("@tool:a").id`)).value, "a1b2c3f");
    assert.deepEqual((await runS(`return ml.dereference("@tool:a").json`)).value, { id: 1, name: "a" });
});

test("ADVERSARIAL: the dereference result can't be walked to the realm", async () => {
    // The String subclass is the new worry: constructor → String → Function is the classic route out.
    await assert.rejects(runS(`return ml.dereference("@tool:a").constructor`), outOfDialect);
    await assert.rejects(runS(`return ml.dereference("@tool:a").constructor("return 1")`), outOfDialect);
    await assert.rejects(runS(`return ml.dereference("@tool:a").__proto__`), outOfDialect);
    await assert.rejects(runS(`return ml.dereference("@tool:a").text.constructor`), outOfDialect);
});

test("ADVERSARIAL: the result's own METHODS stay out of dialect (a name grant would be too wide)", async () => {
    // `.pipe()` and `.schema()` are real methods on the wrapper, but ALLOWED_METHODS is keyed by NAME across
    // every object — allowing either would grant it on anything the dialect can reach. So they refuse here
    // and fall through to approval; `ml.schema(…)` is the free path, granted on the facade by identity.
    await assert.rejects(runS(`return ml.dereference("@tool:a").pipe("head 1")`), outOfDialect);
    await assert.rejects(runS(`return ml.dereference("@tool:a").schema()`), outOfDialect);
    // `toString` IS allowed (a pure string/number method the dialect already permits), and on this object
    // it does the harmless thing — hands back the same text. Worth pinning: it is the one method of the
    // wrapper reachable here, and it must stay a plain read.
    assert.equal((await runS(`return ml.dereference("@tool:a").toString()`)).value, '{"id":1,"name":"a"}');
});

// ---- the @tool: macro is FREE in the dialect, because a pointer read already is ----

test("a pointer read stays in-dialect once the macro is expanded", async () => {
    // The failure this guards: `@tool:abc` is not JavaScript, so the tokenizer rejects it and the whole
    // survey falls through to the approval gate — while `ml.dereference("@tool:abc")` is free, since
    // `dereference` is in ML_READONLY_METHODS. Expanding first is what stops the macro teaching the model
    // the more expensive spelling of a read it may do for nothing.
    const { expandPointers } = await import("../src/pointer-macro.ts");
    const { code } = expandPointers("return @tool:a1b2c3f.length");
    assert.equal(code, 'return ml.dereference("@tool:a1b2c3f").length');
    // The dialect auto-awaits a facade call, so the pointer is a VALUE here too — the same semantics exec
    // reaches by pre-resolving, arrived at a different way.
    assert.equal((await run(code)).value, "VALUE(@tool:a1b2c3f)".length);
});

test("the macro cannot smuggle a non-readonly method past the dialect", async () => {
    // The expansion is a fixed template naming ONE method; nothing in a payload chooses which.
    const { expandPointers } = await import("../src/pointer-macro.ts");
    const { code } = expandPointers(String.raw`return @tool:"x\") ; ml.pythonExec(\"1\") ; ("`);
    // Either it is refused, or it resolves to the harmless read — never the smuggled call.
    let value = null;
    try { value = (await run(code)).value; } catch { value = "refused"; }
    assert.ok(value === "refused" || String(value).startsWith("VALUE("), `unexpected: ${value}`);
    assert.ok(!ML_CALLS.some(([m]) => m === "pythonExec"), "pythonExec was never reached");
});
