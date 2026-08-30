// Pure dom.ts helpers.
import { test } from "node:test";
import assert from "node:assert";
import { elementReference, classifyOverlay, navTarget, typeFromHeader, typeFromContent, typeFromExtension, classifyContent, jsonShape, askReaderNumCtx } from "../dom.ts";

// --- ml.fetch content classification (header / content / extension → a HEURISTIC type for chaining) ---
test("typeFromHeader: specific content-types map; generic ones return null (defer to content/extension)", () => {
    assert.equal(typeFromHeader("application/json"), "json");
    assert.equal(typeFromHeader("application/vnd.api+json"), "json");
    assert.equal(typeFromHeader("text/csv; charset=utf-8"), "csv");
    assert.equal(typeFromHeader("text/html"), "html");
    assert.equal(typeFromHeader("application/xml"), "xml");
    assert.equal(typeFromHeader("image/svg+xml"), "xml");
    assert.equal(typeFromHeader("text/markdown"), "markdown");
    assert.equal(typeFromHeader("application/javascript"), "code");
    assert.equal(typeFromHeader("text/plain"), null);        // generic → sniff decides
    assert.equal(typeFromHeader(""), null);
    assert.equal(typeFromHeader("application/octet-stream"), null);
    assert.equal(typeFromHeader("text/rtf"), "text");         // declared-but-other text
});
test("typeFromContent: structural sniff (json/html/xml/csv); prose or code → text", () => {
    assert.equal(typeFromContent('{"a":1}'), "json");
    assert.equal(typeFromContent("[1, 2, 3]"), "json");
    assert.equal(typeFromContent("{not really json"), "text");   // fails JSON.parse → text
    assert.equal(typeFromContent("<!DOCTYPE html><html>"), "html");
    assert.equal(typeFromContent("<?xml version=\"1.0\"?><rss>"), "xml");
    assert.equal(typeFromContent("a,b,c\n1,2,3\n4,5,6"), "csv");
    assert.equal(typeFromContent("const x = 1;\nexport default x;"), "text");   // code has no structure → extension distinguishes
    assert.equal(typeFromContent("just some prose here."), "text");
});
test("typeFromExtension: code files get a language; data/markup get a kind; unknown → null", () => {
    assert.deepEqual(typeFromExtension("https://raw.example/foo/readonly-exec.ts"), { type: "code", language: "typescript" });
    assert.deepEqual(typeFromExtension("http://x/y/app.js?ref=main"), { type: "code", language: "javascript" });
    assert.deepEqual(typeFromExtension("http://x/data.csv"), { type: "csv" });
    assert.deepEqual(typeFromExtension("http://x/feed.xml"), { type: "xml" });
    assert.deepEqual(typeFromExtension("http://x/README.md"), { type: "markdown" });
    assert.equal(typeFromExtension("http://x/api/users"), null);   // no extension → null
    assert.equal(typeFromExtension("http://x/"), null);
});
test("classifyContent: header wins; else structured content; else extension (the raw-.ts-as-text/plain case)", () => {
    // A server MISLABELS a .ts file as text/plain: content has no structure, so the extension resolves it to code.
    const ts = classifyContent("text/plain; charset=utf-8", "const x = 1;\nconsole.log(x);", "https://raw.githubusercontent.com/o/r/main/readonly-exec.ts");
    assert.equal(ts.type, "code");
    assert.equal(ts.language, "typescript");
    assert.equal(ts.byHeader, null);          // header was generic
    assert.equal(ts.byContent, "text");
    assert.deepEqual(ts.byExtension, { type: "code", language: "typescript" });
    // JSON served as text/plain (raw.github) → structured content wins over the generic header.
    const j = classifyContent("text/plain", '{"ok":true}', "http://x/data.json");
    assert.equal(j.type, "json");
    // A specific header beats a misleading extension: served application/json at a .txt URL.
    assert.equal(classifyContent("application/json", '{"a":1}', "http://x/note.txt").type, "json");
    // No cues at all → text.
    assert.equal(classifyContent("", "hello world", "http://x/api").type, "text");
});

// jsonShape — the TS-like signature generator. The schema a model reads to write code against a payload.
test("jsonShape: primitives and a flat object", () => {
    assert.equal(jsonShape(7), "number");
    assert.equal(jsonShape("hi"), "string");
    assert.equal(jsonShape(true), "boolean");
    assert.equal(jsonShape(null), "null");
    assert.equal(jsonShape({ id: 7, name: "a", ok: true }), "{ id: number, name: string, ok: boolean }");
});

test("jsonShape: nested objects and arrays with an item count", () => {
    assert.equal(jsonShape({ version: 2, tags: ["a", "b"] }), "{ version: number, tags: string[] /* 2 items */ }");
    assert.equal(jsonShape({ user: { name: "a", age: 3 } }), "{ user: { name: string, age: number } }");
    assert.equal(jsonShape([1]), "number[] /* 1 item */");   // singular
});

test("jsonShape: an array of objects MERGES keys — optional (absent in some) + unioned leaf types", () => {
    const v = [{ name: "a", port: 1 }, { name: "b" }, { name: "c", port: "x" }];
    // `port` is absent from the 2nd → optional; its type unions number|string across the sample.
    assert.equal(jsonShape({ servers: v }), "{ servers: { name: string, port?: number | string }[] /* 3 items */ }");
});

test("jsonShape: empty array, mixed-primitive array, and empty object", () => {
    assert.equal(jsonShape([]), "unknown[]");
    assert.equal(jsonShape([1, "a", true]), "(number | string | boolean)[] /* 3 items */");
    assert.equal(jsonShape({}), "{  }");
});

test("jsonShape: weird keys are quoted", () => {
    assert.equal(jsonShape({ "a-b": 1, ok: 2 }), '{ "a-b": number, ok: number }');
});

test("jsonShape is BOUNDED — depth, key count, and array sample are capped", () => {
    // Depth cap: beyond maxDepth the shape collapses to `object` rather than recursing forever.
    const deep = { a: { b: { c: { d: 1 } } } };
    assert.equal(jsonShape(deep, { maxDepth: 2 }), "{ a: { b: object } }");
    // Key cap: only maxKeys keys are shown, with a "+N" remainder.
    const wide = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, i]));
    assert.match(jsonShape(wide, { maxKeys: 2 }), /^\{ k0: number, k1: number, …\+3 \}$/);
    // Sample cap: a huge array is summarised from a sample but still reports the TRUE length.
    assert.match(jsonShape(Array.from({ length: 10000 }, () => ({ x: 1 })), { sample: 3 }), /\/\* 10000 items \*\/$/);
});

test("navTarget: a same-origin relative URL resolves to an absolute destination", () => {
    assert.deepEqual(navTarget("/step2", "https://site.example/step1"), { dest: "https://site.example/step2", crossOrigin: false });
    assert.deepEqual(navTarget("page?q=1#h", "https://site.example/a/b"), { dest: "https://site.example/a/page?q=1#h", crossOrigin: false });
    assert.deepEqual(navTarget("https://site.example/x", "https://site.example/y"), { dest: "https://site.example/x", crossOrigin: false });
});

test("navTarget: a cross-origin URL is refused by default (opt-in only)", () => {
    const r = navTarget("https://evil.example/x", "https://site.example/step1");
    assert.ok("error" in r, "cross-origin is an error, not a destination");
    assert.match(r.error, /Cross-origin/, "the message says why");
    // a different PORT is a different origin too
    assert.ok("error" in navTarget("http://site.example:8081/", "http://site.example:8080/"));
});

test("navTarget: cross-origin is ALLOWED with { allowCrossOrigin: true } and flagged crossOrigin:true", () => {
    assert.deepEqual(navTarget("https://other.example/x", "https://site.example/", { allowCrossOrigin: true }),
        { dest: "https://other.example/x", crossOrigin: true });
    // same-origin still reports crossOrigin:false even with the flag on
    assert.deepEqual(navTarget("/y", "https://site.example/", { allowCrossOrigin: true }),
        { dest: "https://site.example/y", crossOrigin: false });
    // a non-http scheme is still refused regardless of the flag
    assert.ok("error" in navTarget("javascript:alert(1)", "https://site.example/", { allowCrossOrigin: true }));
});

test("navTarget: non-http(s) schemes and empty/invalid input are refused", () => {
    assert.match(navTarget("javascript:alert(1)", "https://site.example/").error, /http\(s\)/);
    assert.match(navTarget("mailto:a@b.com", "https://site.example/").error, /http\(s\)/);
    assert.match(navTarget("", "https://site.example/").error, /non-empty/);
    assert.match(navTarget("   ", "https://site.example/").error, /non-empty/);
});

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

test("classifyOverlay: a rect whose top is invariant across a scroll is PINNED (fixed / stuck sticky)", () => {
    const vh = 800;
    // Fixed header: top stays 0 as we scroll from 0 → vh; centre (0+30) is in the top half → header.
    assert.deepEqual(classifyOverlay({ top: 0, height: 60 }, { top: 0 }, vh), { pinned: true, anchor: "top" });
    // Fixed footer: top pinned near the viewport bottom; centre (760+20) is in the bottom half → footer.
    assert.deepEqual(classifyOverlay({ top: 760, height: 40 }, { top: 760 }, vh), { pinned: true, anchor: "bottom" });
    // A ≤2px jitter still counts as pinned (sub-pixel rounding between two paints).
    assert.equal(classifyOverlay({ top: 0, height: 50 }, { top: 1.4 }, vh).pinned, true);
});

test("classifyOverlay: an element that MOVES with the scroll is NOT pinned (in-flow / unstuck sticky)", () => {
    const vh = 800;
    // Its viewport top dropped by ~vh as the page scrolled up under it → it scrolls with content.
    assert.equal(classifyOverlay({ top: 500, height: 40 }, { top: -300 }, vh).pinned, false);
    // Exactly on the 2px threshold boundary is NOT pinned (strict <2).
    assert.equal(classifyOverlay({ top: 100, height: 20 }, { top: 102 }, vh).pinned, false);
});

test("askReaderNumCtx: a small page → the 8K summariser floor (bigger than the utility default)", () => {
    assert.equal(askReaderNumCtx(1247), 8192, "a 1.2K-char page still gets the summariser minimum");
    assert.equal(askReaderNumCtx(0), 8192);
});

test("askReaderNumCtx: a large page grows the window to fit the content (2K-rounded)", () => {
    // 24000 chars ≈ 8000 tokens + 1024 headroom = 9024 → rounds up to 10240.
    assert.equal(askReaderNumCtx(24000), 10240);
    // Monotonic and always a multiple of 2048.
    for (const n of [5000, 12000, 18000, 24000]) {
        const c = askReaderNumCtx(n);
        assert.equal(c % 2048, 0, `${n} → a 2K-aligned window`);
        assert.ok(c >= 8192, "never below the floor");
    }
});
