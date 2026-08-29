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
    "for loop": `for (const x of []) { x }`,
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

test("awaits compose anywhere in the expression, not just at a statement seam", async () => {
    const js = `return { model: await ml.getModel(), count: (await ml.models()).length }`;
    assert.deepEqual((await run(js)).value, { model: "gemma4:31b", count: 2 });
    // and an await feeding another call's arguments
    assert.deepEqual((await run(`await ml.capabilities(await ml.getModel())`)).value, ["completion"]);
});

test("Promise.all over the ml reads works — the idiom models actually write", async () => {
    const js = `const [models, current] = await Promise.all([ml.models(), ml.getModel()]);
                return { count: models.length, current }`;
    // (destructuring isn't in the dialect, so the shape models really produce is the indexed one)
    assert.deepEqual((await run(`await Promise.all([ml.models(), ml.getModel()])`)).value,
        [["gemma4:31b", "qwen2.5vl:7b"], "gemma4:31b"]);
    await assert.rejects(run(js), outOfDialect);   // …and the destructuring form still falls back cleanly
    assert.equal((await run(`(await Promise.all([ml.models(), ml.getModel()]))[1]`)).value, "gemma4:31b");
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
