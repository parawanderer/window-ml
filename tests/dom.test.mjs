// Pure dom.ts helpers.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { elementReference, classifyOverlay, navTarget, typeFromHeader, typeFromContent, typeFromExtension, classifyContent, jsonShape, askReaderNumCtx, isCspEvalBlocked, markdownAlternateHref, resolveMarkdownAlternate, markdownAffordance, markdownTwin, externalSheetIds, markdownSiblingUrl, isMarkdownResponse } from "../src/dom.ts";

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

test("isCspEvalBlocked: recognizes a CSP / Trusted-Types eval BLOCK (→ escalate to CDP), not a normal error", () => {
    // Chrome's real messages for a missing 'unsafe-eval' and for require-trusted-types-for 'script'.
    assert.ok(isCspEvalBlocked("EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive"));
    assert.ok(isCspEvalBlocked("EvalError: call to Function() blocked by CSP"));
    assert.ok(isCspEvalBlocked("TypeError: Failed to execute 'Function' on 'Function': This document requires 'TrustedScript' assignment."));
    assert.ok(isCspEvalBlocked("This document requires 'TrustedType' assignment"));
    // A genuine code error is NOT a CSP block — it must NOT escalate to the debugger.
    assert.ok(!isCspEvalBlocked("TypeError: x.map is not a function"));
    assert.ok(!isCspEvalBlocked("ReferenceError: foo is not defined"));
    assert.ok(!isCspEvalBlocked(""));
});

// --- site-authored Markdown: the `<link rel="alternate" type="text/markdown">` a page declares ---
// Shapes taken verbatim from a probe of 12 docs platforms — attribute order, quoting and extra attributes all
// vary, so each attribute is matched by name rather than positionally.
test("markdownAlternateHref: finds the declaration across real-world tag shapes", () => {
    assert.equal(markdownAlternateHref('<link rel="alternate" type="text/markdown" href="https://nextjs.org/docs/x.md"/>'),
        "https://nextjs.org/docs/x.md");
    assert.equal(markdownAlternateHref('<link rel="alternate" type="text/markdown" href="/docs/installation.md" data-head=""/>'),
        "/docs/installation.md", "relative hrefs come back verbatim — resolving is a separate, guarded step");
    // GitHub Docs: href sits BEFORE other attributes, and the URL is an API endpoint no derivation would guess.
    assert.equal(markdownAlternateHref('<link rel="alternate" type="text/markdown" href="https://docs.github.com/api/article/body?pathname=/en/actions/quickstart" title="Markdown version" data-llm-hint="Hey agent!"/>'),
        "https://docs.github.com/api/article/body?pathname=/en/actions/quickstart");
    assert.equal(markdownAlternateHref("<link rel=alternate type=text/markdown href=/a.md>"), "/a.md", "unquoted attributes");
    assert.equal(markdownAlternateHref('<link rel="alternate" type="text/x-markdown" href="/b.md">'), "/b.md");
    assert.equal(markdownAlternateHref('<link rel="alternate" type="text/markdown" href="/a?x=1&amp;y=2">'), "/a?x=1&y=2", "entity-encoded query");
    // Picks the markdown one out of a head full of other alternates (hreflang, RSS) — every site had several.
    assert.equal(markdownAlternateHref('<link rel="alternate" type="application/rss+xml" href="/rss.xml"/><link rel="alternate" hrefLang="ja" href="/ja"/><link rel="alternate" type="text/markdown" href="/x.md"/>'),
        "/x.md");
    assert.equal(markdownAlternateHref('<link rel="alternate" type="application/rss+xml" href="/rss.xml"/>'), null);
    assert.equal(markdownAlternateHref('<link rel="stylesheet" type="text/markdown" href="/x.md"/>'), null, "rel must be alternate");
    assert.equal(markdownAlternateHref("<html><body>no head links</body></html>"), null);
});

// A declaration is PAGE-CONTROLLED content, unlike a derived `.md` sibling. Following a cross-origin one under
// the page's own grant would turn "read this page as Markdown" into "fetch whatever the page names".
test("resolveMarkdownAlternate: resolves relative, and refuses anything not same-origin http(s)", () => {
    const page = "https://bun.sh/docs/installation";
    assert.equal(resolveMarkdownAlternate("/docs/installation.md", page), "https://bun.sh/docs/installation.md");
    assert.equal(resolveMarkdownAlternate("installation.md", page), "https://bun.sh/docs/installation.md");
    assert.equal(resolveMarkdownAlternate("https://bun.sh/other.md", page), "https://bun.sh/other.md");
    // The attacks the origin guard exists for.
    assert.equal(resolveMarkdownAlternate("https://evil.test/x.md", page), null, "cross-origin declaration");
    assert.equal(resolveMarkdownAlternate("//evil.test/x.md", page), null, "protocol-relative to another host");
    assert.equal(resolveMarkdownAlternate("http://bun.sh/x.md", page), null, "scheme downgrade is a different origin");
    assert.equal(resolveMarkdownAlternate("https://bun.sh.evil.test/x.md", page), null, "suffix-confusable host");
    assert.equal(resolveMarkdownAlternate("javascript:alert(1)", page), null);
    assert.equal(resolveMarkdownAlternate("data:text/markdown,hi", page), null);
    assert.equal(resolveMarkdownAlternate(null, page), null);
    assert.equal(resolveMarkdownAlternate("/x.md", "not a url"), null);
});

// The live-document read behind pageInfo's "Markdown:" line. The declaration is authoritative; the
// copy-as-Markdown control is the weaker fallback for the sites that serve a twin without declaring one.
const doc = (html, url = "https://docs.test/guide") => new JSDOM(html, { url }).window.document;

test("markdownTwin: a declared same-origin twin wins; a hostile declaration is dropped", () => {
    assert.deepEqual(
        markdownTwin(doc('<head><link rel="alternate" type="text/markdown" href="/guide.md"></head><body></body>')),
        { url: "https://docs.test/guide.md", affordance: false });
    // Cross-origin declaration → no URL. It does NOT fall back to the affordance hint being suppressed:
    // there is no control here either, so the page simply reports nothing.
    assert.deepEqual(
        markdownTwin(doc('<head><link rel="alternate" type="text/markdown" href="https://evil.test/x.md"></head><body></body>')),
        { url: null, affordance: false });
    assert.deepEqual(markdownTwin(doc("<head></head><body></body>")), { url: null, affordance: false });
});

test("markdownAffordance: a copy/view CONTROL counts, a page merely about Markdown does not", () => {
    assert.equal(markdownAffordance(doc('<body><button>Copy Page as Markdown</button></body>')), true);
    assert.equal(markdownAffordance(doc('<body><button aria-label="View as Markdown"></button></body>')), true);
    assert.equal(markdownAffordance(doc('<body><a role="button">Copy markdown</a></body>')), true);
    // The false positive the verb requirement exists to prevent: a docs nav linking to a Markdown article.
    assert.equal(markdownAffordance(doc('<body><a href="/markdown">Markdown</a><a href="/x">Markdown syntax guide</a></body>')), false);
    assert.equal(markdownAffordance(doc("<body><button>Copy</button></body>")), false);
    // A declaration outranks the control, so the two signals are never reported together.
    assert.deepEqual(
        markdownTwin(doc('<head><link rel="alternate" type="text/markdown" href="/g.md"></head><body><button>Copy as Markdown</button></body>')),
        { url: "https://docs.test/g.md", affordance: false });
});

// The external-Google-Sheet approval escalation scans python_exec's `tables` arg. python_exec accepts a
// ONE-element array (models write `tables: ["current"]`), so this scan must see into an array too — it does,
// because Object.values() on an array yields its elements. Pinned, since a hole here would let a privileged
// credentialed sheet read skip its consent prompt by being wrapped in a list.
test("externalSheetIds: finds sheets in a string, a map, AND an array", () => {
    const A = "https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0";
    const B = "https://docs.google.com/spreadsheets/d/XYZ789/edit";
    assert.deepEqual(externalSheetIds({ tables: A }), ["ABC123"]);
    assert.deepEqual(externalSheetIds({ tables: { a: A, b: B } }), ["ABC123", "XYZ789"]);
    assert.deepEqual(externalSheetIds({ tables: [A] }), ["ABC123"], "a wrapped source must not escape the gate");
    assert.deepEqual(externalSheetIds({ tables: [A, B] }), ["ABC123", "XYZ789"]);
    assert.deepEqual(externalSheetIds({ tables: ["current"] }), [], "'current' is the page you are on, not external");
    assert.deepEqual(externalSheetIds({ tables: "#sales" }), []);
    assert.deepEqual(externalSheetIds({}), []);
});

// The third rung of the Markdown ladder: the DERIVED sibling, tried only when negotiation missed and the page
// declared nothing. It rides the base URL's own consent, so what it can express IS the security boundary.
test("markdownSiblingUrl: the trailing slash picks the sibling, and only ONE is ever derived", () => {
    // Measured against real docs platforms — Cloudflare 404s on `guide.md` and serves `guide/index.md`.
    assert.equal(markdownSiblingUrl("https://bun.sh/docs/installation"), "https://bun.sh/docs/installation.md");
    assert.equal(markdownSiblingUrl("https://developers.cloudflare.com/workers/get-started/guide/"),
        "https://developers.cloudflare.com/workers/get-started/guide/index.md");
    // `.md` IN PLACE of an explicit .html — "page.html.md" is nobody's convention.
    assert.equal(markdownSiblingUrl("https://x.test/a/page.html"), "https://x.test/a/page.md");
    assert.equal(markdownSiblingUrl("https://x.test/a/page.htm"), "https://x.test/a/page.md");
    // Query and fragment addressed the HTML resource; carrying them to another path is a guess.
    assert.equal(markdownSiblingUrl("https://x.test/docs?tab=cli#frag"), "https://x.test/docs.md");
    // Nothing to derive.
    assert.equal(markdownSiblingUrl("https://x.test/page.md"), null, "already the markdown resource");
    assert.equal(markdownSiblingUrl("https://x.test/page.mdx"), null);
    assert.equal(markdownSiblingUrl("https://x.test/data.json"), null, "a data file has no prose twin");
    assert.equal(markdownSiblingUrl("https://x.test/logo.png"), null);
    assert.equal(markdownSiblingUrl("https://x.test/"), null, "a site root has no page twin (that is llms.txt's job)");
    assert.equal(markdownSiblingUrl("javascript:alert(1)"), null);
    assert.equal(markdownSiblingUrl("data:text/html,x"), null);
    assert.equal(markdownSiblingUrl("not a url"), null);
    assert.equal(markdownSiblingUrl(""), null);
});

// ADVERSARIAL. This URL is fetched under the consent given for the BASE url, so if a caller could steer it to
// another origin it would become "approve one page, read anywhere". Unlike a declared alternate it takes no
// page-supplied string — but assert the invariant directly rather than trusting the construction.
test("markdownSiblingUrl: the result is ALWAYS same-origin, whatever the input tries", () => {
    const hostile = [
        "https://good.test/a/../../evil.test/x",
        "https://good.test/a/%2e%2e/%2e%2e/x",
        "https://good.test/x?next=https://evil.test/y",
        "https://good.test/x#https://evil.test/y",
        "https://good.test/x/..;/y",
        "https://user:pass@good.test/x",
        "https://good.test:443/x",
        "https://good.test/\\evil.test/x",
        "https://good.test/x%00.md",
        "https://good.test/..%2f..%2fevil",
    ];
    for (const h of hostile) {
        const out = markdownSiblingUrl(h);
        if (out === null) continue;                       // refusing is always an acceptable answer
        assert.equal(new URL(out).origin, new URL(h).origin, `escaped the origin: ${h} -> ${out}`);
        assert.ok(out.endsWith(".md"), `not a markdown sibling: ${out}`);
        // …and the path is the base path plus the suffix — never a new path the input smuggled in.
        const basePath = new URL(h).pathname.replace(/\.html?$/i, "");
        const expected = basePath.endsWith("/") ? `${basePath}index.md` : `${basePath}.md`;
        assert.equal(new URL(out).pathname, expected, `path was steered: ${h} -> ${out}`);
    }
});

// How every rung of the ladder is judged. Both of these are measured behaviours, not hypotheticals.
test("isMarkdownResponse: the header is not trusted in EITHER direction", () => {
    // react.dev serves genuine Markdown as text/plain — requiring the header would reject a real twin.
    assert.equal(isMarkdownResponse(true, "text/plain; charset=utf-8", "# Thinking in React\n\nText."), true);
    assert.equal(isMarkdownResponse(true, "text/markdown; charset=utf-8", "# GLM-5.3-Flash\n\nText."), true);
    assert.equal(isMarkdownResponse(true, "text/x-markdown", "# Title"), true);
    // …and the common failure is not a 404 but a 200 text/html SPA catch-all (docs.github.com answers
    // `…/index.md` with 359KB of HTML), which a status check alone would happily accept.
    assert.equal(isMarkdownResponse(true, "text/html; charset=utf-8", "<!DOCTYPE html><html><head>"), false);
    assert.equal(isMarkdownResponse(true, "text/plain", "<html><body>still html</body></html>"), false, "sniffed, not just headered");
    // Structured data is never the prose twin.
    assert.equal(isMarkdownResponse(true, "application/json", '{"a":1}'), false);
    assert.equal(isMarkdownResponse(true, "text/csv", "a,b\n1,2"), false);
    assert.equal(isMarkdownResponse(true, "application/xml", "<?xml version=\"1.0\"?><r/>"), false);
    // Non-2xx and empty bodies are misses — an error page is prose too.
    assert.equal(isMarkdownResponse(false, "text/markdown", "# Not found"), false);
    assert.equal(isMarkdownResponse(true, "text/markdown", "   "), false);
});
