// Unit tests for the agent's DOM introspection helpers (ml._truncate,
// ml._elPath, ml._describeSkeleton). These do fiddly ancestor-walking and
// recursion with hard token budgets, so they're pinned down here against a
// REAL DOM (jsdom via loadDomWorld) — a hand-rolled fake would only encode our
// own assumptions about childNodes/children/classList and hide the bugs we care
// about.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadDomWorld, loadPageWorld } = require("./helpers");

// ---- truncate ----

test("_truncate collapses whitespace and trims", () => {
    const { ml } = loadDomWorld();
    assert.equal(ml._truncate("  a\n\t b  ", 20), "a b");
});

test("_truncate adds an ellipsis past the limit, leaves short strings alone", () => {
    const { ml } = loadDomWorld();
    assert.equal(ml._truncate("abcdef", 3), "abc…");
    assert.equal(ml._truncate("abc", 3), "abc");       // exactly at limit: untouched
});

test("_truncate tolerates null/undefined", () => {
    const { ml } = loadDomWorld();
    assert.equal(ml._truncate(null, 5), "");
    assert.equal(ml._truncate(undefined, 5), "");
});

// ---- elPath ----

test("_elPath builds a root→leaf path with id and classes (stops at <html>)", () => {
    const { ml, document } = loadDomWorld(
        '<div id="main"><div class="card"><h2 class="title">Widget</h2></div></div>'
    );
    // Walk stops at documentElement (<html>), so <body> is the outermost segment.
    assert.equal(
        ml._elPath(document.querySelector(".title")),
        "body > div#main > div.card > h2.title"
    );
});

test("_elPath caps classes at 4 per element", () => {
    const { ml, document } = loadDomWorld('<div class="a b c d e f"></div>');
    assert.ok(ml._elPath(document.querySelector("div")).endsWith("div.a.b.c.d"));
});

test("_elPath caps the walk at 8 ancestors", () => {
    // 10-deep chain; only the 8 nearest the leaf survive (cap hits before body).
    let html = '<div id="d0"></div>';
    for (let i = 1; i < 10; i++) html = `<div id="d${i}">${html}</div>`;
    const { ml, document } = loadDomWorld(html);
    const path = ml._elPath(document.querySelector("#d0"));
    const segs = path.split(" > ");
    assert.equal(segs.length, 8);
    assert.equal(segs[0], "div#d7");                   // d9, d8, body, html all dropped
    assert.equal(segs.at(-1), "div#d0");
});

test("_elPath escapes selector-illegal Tailwind classes → a VALID, queryable path", () => {
    // The raw `/` (opacity), `[]` (arbitrary value) and `:` (variant) are illegal
    // unescaped in a selector — pre-fix, elPath emitted them verbatim and the model's
    // click threw. The escaped path must round-trip back through _queryAll to the node.
    const { ml, document } = loadDomWorld(
        '<button class="border-gray-100/30 text-[10px] hover:bg-black">8</button>'
    );
    const btn = document.querySelector("button");
    const path = ml._elPath(btn);
    assert.match(path, /border-gray-100\\\/30/);       // the `/` is backslash-escaped
    const hit = ml._queryAll(path);                     // and the whole path resolves
    assert.equal(hit.length, 1);
    assert.equal(hit[0], btn);
});

// ---- queryAll (:contains / :has-text shim) ----

test("_queryAll supports :contains and :has-text as a text filter on the base", () => {
    const { ml } = loadDomWorld(
        '<div class="card">Gesponsord Widget A</div>' +
        '<div class="card">Widget B</div>' +
        '<div class="other">Gesponsord elsewhere</div>'
    );
    // base `.card` filtered to those containing the text
    assert.equal(ml._queryAll('div.card:contains("Gesponsord")').length, 1);
    assert.equal(ml._queryAll('div.card:has-text("Widget")').length, 2);
    assert.equal(ml._queryAll('.card:contains("nope")').length, 0);
});

test("_queryAll is case-insensitive, unquoted-tolerant, and ANDs multiple predicates", () => {
    const { ml } = loadDomWorld('<p>Alpha Beta</p><p>Alpha</p><p>beta</p>');
    assert.equal(ml._queryAll('p:contains("ALPHA")').length, 2);   // case-insensitive
    assert.equal(ml._queryAll('p:contains(beta)').length, 2);      // unquoted (Beta + beta)
    assert.equal(ml._queryAll('p:contains("alpha"):contains("beta")').length, 1); // AND
});

test("_queryAll allows a bare text predicate (empty base → *) and plain selectors", () => {
    const { ml } = loadDomWorld('<a>keepsake</a><b>other</b>');
    // base defaults to * — so it matches the <a> (ancestors match too, since
    // textContent bubbles up; that's expected).
    assert.ok(ml._queryAll(':contains("keep")').some(e => e.tagName === "A"));
    assert.equal(ml._queryAll("a").length, 1);                     // no predicate: normal CSS
    // A mid-selector predicate is NOT peeled — left in the base for the engine
    // (real browsers throw; here we just confirm it isn't treated as end-position).
    assert.equal(ml._queryAll('a:contains("keep") > b').length, 0);
});

test("_queryAll supports Playwright text=Foo → the smallest element with that text", () => {
    const { ml } = loadDomWorld('<p>wrap <button id="b">Show hint</button></p><a>Show more</a>');
    // text=Show hint → the <button>, NOT the ancestor <p>/<body> that also contain the text.
    const r = ml._queryAll("text=Show hint");
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "b");
    // case-insensitive + quoted form both work
    assert.equal(ml._queryAll('text="show HINT"')[0].id, "b");
    // substring match against the leaf; "Show" alone matches both leaf carriers
    assert.deepEqual(ml._queryAll("text=Show").map(e => e.tagName).sort(), ["A", "BUTTON"]);
});

test("_queryAll supports :eq(n) as a 0-based positional pick", () => {
    const { ml } = loadDomWorld('<p class="x">a</p><p class="x">b</p><p class="x">c</p>');
    assert.equal(ml._queryAll(".x:eq(0)")[0].textContent, "a");
    assert.equal(ml._queryAll(".x:eq(2)")[0].textContent, "c");
    assert.equal(ml._queryAll(".x:eq(5)").length, 0);              // out of range → empty
});

test("_queryAll combines a text filter with an :eq positional pick", () => {
    const { ml } = loadDomWorld('<p class="x">keep me</p><p class="x">skip</p><p class="x">keep you</p>');
    // among .x containing "keep" → [keep me, keep you]; :eq(1) → keep you
    const r = ml._queryAll('.x:contains("keep"):eq(1)');
    assert.equal(r.length, 1);
    assert.equal(r[0].textContent, "keep you");
});

test("_queryAll reinterprets a dead :nth-of-type(n) as the nth match (model idiom)", () => {
    // Each .card is the 1st of its own tag, so native .card:nth-of-type(2) matches
    // NOTHING — the mistake the model keeps making. Fall back to "the 2nd .card".
    const { ml } = loadDomWorld('<div class="card">A</div><p class="card">B</p><span class="card">C</span>');
    const r = ml._queryAll(".card:nth-of-type(2)");
    assert.equal(r.length, 1);
    assert.equal(r[0].textContent, "B");
    assert.equal(ml._queryAll(".card:nth-of-type(9)").length, 0); // out of range → empty
});

test("_queryAll leaves a VALID native :nth-of-type alone (only falls back on 0 matches)", () => {
    const { ml } = loadDomWorld('<ul><li class="x">1</li><li class="x">2</li><li class="x">3</li></ul>');
    const r = ml._queryAll("li:nth-of-type(2)");   // native + correct → the 2nd li
    assert.equal(r.length, 1);
    assert.equal(r[0].textContent, "2");
});

// ---- suspiciousChars (prompt-injection scan) ----

test("_suspiciousChars flags bidi/zero-width/control chars, ignores clean code", () => {
    const { ml } = loadDomWorld();
    assert.deepEqual(ml._suspiciousChars("clean = 1 + 2;\n\ttabs and newlines ok"), []);
    const rlo = ml._suspiciousChars("a\u202Eb");           // RIGHT-TO-LEFT OVERRIDE
    assert.equal(rlo.length, 1);
    assert.equal(rlo[0].code, "U+202E");
    assert.match(rlo[0].name, /RIGHT-TO-LEFT OVERRIDE/);
    assert.equal(ml._suspiciousChars("x\u200By").length, 1);   // zero-width space
    assert.equal(ml._suspiciousChars("\uFEFFbom").length, 1);  // BOM
    assert.match(ml._suspiciousChars("nul\0").pop().name, /CONTROL/); // control char
});

// ---- defineTool ----

test("defineTool fills defaults and returns a well-formed tool", () => {
    const { ml } = loadDomWorld();
    const t = ml.defineTool({ name: "noop", run: () => "ok" });
    assert.equal(t.name, "noop");
    assert.equal(t.description, "");
    assert.deepEqual(t.parameters, { type: "object", properties: {} });
    assert.equal(t.run(), "ok");
});

test("defineTool rejects a tool with no name or no run()", () => {
    const { ml } = loadDomWorld();
    assert.throws(() => ml.defineTool({ name: "bad" }), /run\(args\) function/);
    assert.throws(() => ml.defineTool({ run: () => {} }), /needs a name/);
    assert.throws(() => ml.defineTool(), /needs a name/);
});

test("defineTool carries capability tags (default empty)", () => {
    const { ml } = loadDomWorld();
    assert.deepEqual(ml.defineTool({ name: "a", run: () => "x" }).capabilities, []);
    assert.deepEqual(ml.defineTool({ name: "b", run: () => "x", capabilities: ["vision"] }).capabilities, ["vision"]);
});

// ---- domTools registry ----

// Run a named tool from the default registry (run may be async, e.g. exec).
const run = (ml, name, args) => ml.domTools.find(t => t.name === name).run(args);

test("findByText returns the DEEPEST matches as paths + real nodes, not containers", () => {
    const { ml } = loadDomWorld(
        '<div class="card"><h2 class="title">Widget A</h2></div>' +
        '<div class="card"><h2 class="title">Widget B</h2></div>'
    );
    const res = run(ml, "findByText", { text: "Widget" });
    const lines = res.content.split("\n");
    assert.equal(lines.length, 2, res.content);        // the two h2s, not the cards/body
    assert.ok(lines.every(l => l.endsWith("»") && l.includes("h2.title")), res.content);
    assert.ok(res.content.includes("Widget A") && res.content.includes("Widget B"), res.content);
    assert.equal(res.elements.length, 2);              // hoverable nodes for the human
    assert.equal(res.elements[0].tagName, "H2");
});

test("findByText honours the limit and reports no matches", () => {
    const { ml } = loadDomWorld("<p>alpha</p><p>alpha</p><p>alpha</p>");
    const limited = run(ml, "findByText", { text: "alpha", limit: 1 });
    assert.equal(limited.content.split("\n").length, 1);
    assert.equal(limited.elements.length, 1);
    assert.match(run(ml, "findByText", { text: "nope" }), /No elements contain "nope"/); // plain string
});

test("findByText normalizes typographic punctuation (ASCII query matches fancy page text)", () => {
    // The real bug: a model's own answer rendered "web‑browser" (U+2011 non-breaking
    // hyphen) but its later findByText used a plain "-", so the substring never matched.
    const { ml } = loadDomWorld("<p>I could perform as a web‑browser agent</p>");
    const res = run(ml, "findByText", { text: "web-browser agent" });   // ASCII hyphen
    assert.ok(res.elements && res.elements.length === 1, "matched across the non-breaking hyphen");

    // Curly apostrophe / NBSP in the DOM, straight ASCII + space in the query.
    const { ml: ml2 } = loadDomWorld("<p>Don’t Save</p>");
    assert.ok(run(ml2, "findByText", { text: "don't save" }).elements.length === 1);
});

test("queryAll :contains normalizes punctuation too (curly ↔ straight quotes)", () => {
    const { ml } = loadDomWorld('<button class="x">Don’t Save</button><button class="x">Keep</button>');
    assert.equal(ml._queryAll('button:contains("Don\'t Save")').length, 1);   // straight query, curly DOM
});

test("interactives lists controls by role + accessible name with a clickable selector", () => {
    const { ml } = loadDomWorld(
        '<nav><a href="/home">Home</a></nav>' +
        '<div class="toolbar">' +
          '<button aria-label="Good response"><svg></svg></button>' +
          '<button aria-label="Bad response"><svg></svg></button>' +
          '<button>Copy</button>' +
        '</div>' +
        '<input type="text" aria-label="Send a Message">'
    );
    const out = run(ml, "interactives", {});
    assert.match(out.content, /\[button\] "Good response"\s+→\s+button\[aria-label="Good response"\]/);
    assert.match(out.content, /\[textbox\] "Send a Message"/);
    assert.match(out.content, /\[button\] "Copy"/);            // visible text is the accessible name
    assert.ok(out.elements.length >= 4, "returns the real nodes too");
    // The <nav> Home link is skipped by default (landmark navigation), unless asked for.
    assert.ok(!/"Home"/.test(out.content), "navigation controls skipped by default");
    assert.match(run(ml, "interactives", { includeNav: true }).content, /\[link\] "Home"/);
});

test("interactives only notes the nav skip when the page actually HAS nav/sidebar landmarks", () => {
    // A page with a <nav> → the skip note appears.
    const { ml } = loadDomWorld('<nav><a href="/">Home</a></nav><button>Go</button>');
    assert.match(run(ml, "interactives", {}).content, /navigation\/sidebar controls skipped/);
    // A plain page with NO nav/aside/sidebar → nothing was skipped, so no misleading note.
    const { ml: ml2 } = loadDomWorld('<div><button>A</button><button>B</button></div>');
    assert.ok(!/navigation\/sidebar controls skipped/.test(run(ml2, "interactives", {}).content), "no note without nav/sidebar");
});

test("interactives skips the sidebar chrome and collapses flooded duplicates", () => {
    // The OpenWebUI failure: a sidebar with N chats, each a link + a 'Chat Menu'
    // button, drowning the message controls out of the list.
    let sidebar = '<div id="sidebar">';
    for (let i = 0; i < 8; i++) sidebar += `<a href="/c/${i}">Chat ${i}</a><button aria-label="Chat Menu"></button>`;
    sidebar += "</div>";
    const { ml } = loadDomWorld(sidebar + '<main><button aria-label="Good Response">Like</button></main>');
    const out = run(ml, "interactives", {}).content;
    assert.match(out, /Listing the main content region/);      // scoped to <main>
    assert.match(out, /\[button\] "Good Response"/);           // the real target surfaces
    assert.ok(!/Chat \d/.test(out), "sidebar chats not listed");

    // Without a <main>, the sidebar is skipped and its 8 'Chat Menu' buttons collapse.
    const { ml: ml2 } = loadDomWorld(sidebar + '<div><button aria-label="Good Response">Like</button></div>');
    const out2 = run(ml2, "interactives", { includeNav: true }).content;
    assert.match(out2, /"Chat Menu" ×8  →  button\[aria-label="Chat Menu"\] · index 0–7/);

    // OpenWebUI case: a broad role="main" wraps BOTH the sidebar and the content —
    // the sidebar must STILL be skipped (skipNav applies inside main too).
    const { ml: ml3 } = loadDomWorld(`<div role="main">${sidebar}<div class="content"><button aria-label="Good Response">Like</button></div></div>`);
    const out3 = run(ml3, "interactives", {}).content;
    assert.match(out3, /"Good Response"/, "the real control surfaces");
    assert.ok(!/Chat \d/.test(out3), "sidebar chats skipped even under role=main");
});

test("interactives finds the aria-labeled edit button and disambiguates duplicates by ordinal", () => {
    // The real failure case: an "Edit" icon button per message, hover-revealed.
    const { ml } = loadDomWorld(
        '<div class="msg"><button aria-label="Edit" style="visibility:hidden"><svg></svg></button></div>' +
        '<div class="msg"><button aria-label="Edit" style="visibility:hidden"><svg></svg></button></div>' +
        '<button aria-label="Save" disabled>Save</button>'
    );
    const out = run(ml, "interactives", { contains: "edit" });
    const lines = out.content.split("\n").filter(l => l.startsWith("#"));
    // visibility:hidden (hover-revealed) buttons must NOT be excluded — that's the fix.
    // (The "hidden until hover" label needs real layout; jsdom can't report it.)
    assert.equal(lines.length, 2, "both hover-hidden Edit buttons are listed");
    assert.match(lines[0], /"Edit".*→ +button\[aria-label="Edit"\] · index 0 of 2/);
    assert.match(lines[1], /· index 1 of 2/);
    assert.ok(!/Save/.test(out.content), "contains-filter excludes non-matches");
});

test("interactives selectors are short + valid: unique id anchor, else nth-of-type (no Tailwind spam)", () => {
    const { ml } = loadDomWorld('<main><div class="wrap"><span><button id="menu-btn"><svg></svg></button></span></div></main>');
    assert.match(run(ml, "interactives", {}).content, /→ {2}#menu-btn$/m, "unique id → one-segment selector");

    // No id/aria → tag:nth-of-type, NOT a giant ancestor class chain.
    const { ml: ml2 } = loadDomWorld('<main><div class="a b c d e"><button>A</button><button>B</button></div></main>');
    const out = run(ml2, "interactives", {}).content;
    assert.match(out, /→ {2}(main > )?button:nth-of-type\(1\)/);
    assert.ok(!/> div\.a\.b/.test(out), "no class-chain ancestor path");
});

test("interactives auto-broadens past an empty phantom modal (never dead-ends the model)", () => {
    // OpenWebUI mounts a persistent, currently-empty dialog container. It must NOT
    // capture the scope and return "nothing" while real controls exist elsewhere —
    // that empty result is what sent one run into a 40-step exec meltdown.
    const { ml } = loadDomWorld(
        '<div role="dialog"></div>' +                                   // phantom modal, no controls
        '<main><button aria-label="Good Response">Like</button></main>'
    );
    const out = run(ml, "interactives", {}).content;
    assert.match(out, /"Good Response"/, "broadened past the empty dialog to the real control");
    assert.ok(!/modal dialog is open/.test(out), "did not scope into the empty phantom modal");
});

test("interactives scopes to an open modal dialog (the rating popup case)", () => {
    const { ml } = loadDomWorld(
        '<button aria-label="Like">Like</button>' +
        '<div role="dialog" aria-modal="true">' +
          '<button aria-label="Rate 10">10</button>' +
          '<button>Save</button>' +
        '</div>'
    );
    const out = run(ml, "interactives", {});
    assert.match(out.content, /A modal dialog is open/);
    assert.match(out.content, /"Rate 10"/);
    assert.match(out.content, /\[button\] "Save"/);
    assert.ok(!/"Like"/.test(out.content), "controls outside the modal are not listed");
});

test("describeElement describes the first match (+ node) and handles bad input", () => {
    const { ml } = loadDomWorld('<div class="card" data-id="7"><span>hi</span></div>');
    const res = run(ml, "describeElement", { selector: ".card", depth: 0 });
    assert.ok(res.content.startsWith('div.card [data-id="7"]'));
    assert.equal(res.elements[0].tagName, "DIV");
    assert.match(run(ml, "describeElement", { selector: "((" }), /Invalid selector/);
    assert.match(run(ml, "describeElement", { selector: ".nope" }), /No element matches/);
});

test("selectorError blames :contains placement only when it truly survives mid-selector", () => {
    // Pure function (jsdom's nwsapi swallows `:contains` instead of throwing, so we
    // can't reach it through a tool here) — call it directly with a synthetic throw.
    const { ml } = loadDomWorld("<button>8</button>");
    const err = new Error("'x' is not a valid selector");
    // Trailing :contains peels off cleanly; the throw is really the unescaped Tailwind
    // `/`, NOT placement — surface the raw error, don't misdiagnose it (the run.md bug).
    const trailing = ml._selectorError('button.border-gray-100/30:contains("8")', err);
    assert.match(trailing, /is not a valid selector/);
    assert.ok(!/only supported at/.test(trailing), "must not misblame :contains placement");
    // A genuine mid-selector text predicate DOES earn the placement message.
    assert.match(ml._selectorError('div:contains("x") > span', err), /only supported at the END/);
});

test("ancestors walks UP from a match, listing each ancestor by hop", () => {
    const { ml } = loadDomWorld(
        '<div data-component-type="s-search-result"><div class="title"><a><span class="label">Gesponsord</span></a></div></div>'
    );
    const res = run(ml, "ancestors", { selector: "span.label" });
    const lines = res.content.split("\n");
    assert.match(lines[0], /^\[0\] span\.label "Gesponsord"/);   // the element itself
    assert.ok(res.content.includes('[data-component-type="s-search-result"]'), res.content);
    assert.equal(res.elements[0].tagName, "SPAN");
    assert.match(run(ml, "ancestors", { selector: ".nope" }), /No element matches/);
});

test("countMatches counts, returns the nodes, and flags invalid selectors", () => {
    const { ml } = loadDomWorld("<li></li><li></li><li></li>");
    const res = run(ml, "countMatches", { selector: "li" });
    assert.equal(res.content, "3");
    assert.equal(res.elements.length, 3);
    assert.equal(run(ml, "countMatches", { selector: "div" }).content, "0");
    assert.match(run(ml, "countMatches", { selector: "((" }), /Invalid selector/);
});

test("sampleText samples N, truncates, marks overflow, and returns those nodes", () => {
    const items = Array.from({ length: 3 }, (_, i) => `<p>${"w".repeat(200)}${i}</p>`).join("");
    const { ml } = loadDomWorld(items);
    const res = run(ml, "sampleText", { selector: "p", n: 2 });
    const lines = res.content.split("\n");
    assert.equal(lines.length, 3);                     // 2 samples + overflow line
    assert.ok(lines[0].endsWith("…"), lines[0]);       // truncated at 120
    assert.equal(lines.at(-1), "…(2 of 3 shown)");
    assert.equal(res.elements.length, 2);
    assert.match(run(ml, "sampleText", { selector: ".nope" }), /No element matches/);
});

test("exec evaluates expressions, serializes objects, and catches errors", async () => {
    const { ml } = loadDomWorld("<li></li><li></li>");
    assert.equal(await run(ml, "exec", { js: "1 + 2" }), "3");
    assert.equal(await run(ml, "exec", { js: "document.querySelectorAll('li').length" }), "2");
    assert.equal(await run(ml, "exec", { js: "({a:1})" }), '{"a":1}');
    assert.equal(await run(ml, "exec", { js: "Promise.resolve(42)" }), "42"); // thenable awaited
    assert.match(await run(ml, "exec", { js: "nope()" }), /^Error:/);
    // Top-level await + return (async-function fallback when eval rejects them).
    assert.equal(await run(ml, "exec", { js: "return await Promise.resolve(7)" }), "7");
    assert.equal(await run(ml, "exec", { js: "const x = await Promise.resolve(5); return x * 2" }), "10");
    assert.match(await run(ml, "exec", { js: "return (" }), /^Error:/); // genuine syntax error still reported
    // Multi-line console output keeps its newlines — separate console.log calls
    // join with \n, and the length cap must NOT collapse whitespace (regression:
    // exec used dom.ts `truncate`, whose \s+→" " flattened every line into spaces).
    const multi = await run(ml, "exec", { js: "for (let i = 1; i <= 3; i++) console.log('line ' + i);" });
    assert.match(multi, /^console:\nline 1\nline 2\nline 3\n\nvalue: /);
});

test("selector tools accept end-position :contains/:has-text and explain mid-selector", () => {
    const { ml } = loadDomWorld('<div class="card">x</div><div class="card">y</div>');
    // end-position text predicate now just works (via queryAll)
    assert.equal(run(ml, "countMatches", { selector: '.card:contains("x")' }).content, "1");
    assert.match(run(ml, "sampleText", { selector: '.card:has-text("y")' }).content, /y/);
    assert.equal(run(ml, "describeElement", { selector: '.card:contains("y")' }).elements[0].textContent, "y");
    // a genuinely malformed selector still reports the raw error
    assert.match(run(ml, "countMatches", { selector: "((" }), /Invalid selector: /);
});

test("answer tool returns the designated element(s) as the result", () => {
    const { ml } = loadDomWorld('<div id="banner">Ad</div><p class="x">a</p><p class="x">b</p>');
    const one = run(ml, "answer", { selector: "#banner", note: "the banner" });
    assert.match(one.content, /Answer: 1 element.*the banner/);
    assert.equal(one.elements[0].id, "banner");
    assert.equal(run(ml, "answer", { selector: "p.x" }).elements.length, 2);
    assert.match(run(ml, "answer", { selector: ".nope" }), /No element matches/);
    // index designates one specific match (call repeatedly to collect several)
    assert.equal(run(ml, "answer", { selector: "p.x", index: 1 }).elements[0].textContent, "b");
    assert.match(run(ml, "answer", { selector: "p.x", index: 9 }), /No element at index 9/);
});

test("pageInfo grounds time/locale for time-relative tasks", () => {
    const { ml } = loadDomWorld();
    const info = run(ml, "pageInfo", {});
    assert.match(info, /Now:/);
    assert.match(info, /ISO \d{4}-\d{2}-\d{2}T/);      // the model can reason about "today"
});

test("scroll tool is in the default set and scrolls to bottom by default", async () => {
    const { ml, window } = loadDomWorld("<div>content</div>");
    const calls = [];
    window.scrollTo = (x, y) => calls.push(["to", x, y]);
    const out = await run(ml, "scroll", {});
    assert.equal(calls[0][0], "to");
    assert.match(out, /Scrolled to bottom/);
    assert.match(out, /Re-run look\/countMatches\/findByText/);   // nudges the follow-up
});

test("scroll tool handles to:top, by:N, and scrolling an element into view", async () => {
    const { ml, window, document } = loadDomWorld('<div id="target">x</div>');
    const calls = [];
    window.scrollTo = (x, y) => calls.push(["to", x, y]);
    window.scrollBy = (x, y) => calls.push(["by", x, y]);
    document.querySelector("#target").scrollIntoView = () => calls.push(["intoView"]);

    assert.match(await run(ml, "scroll", { to: "top" }), /Scrolled to top/);
    assert.match(await run(ml, "scroll", { by: -200 }), /Scrolled by -200px/);
    assert.match(await run(ml, "scroll", { to: "element", selector: "#target" }), /into view/);
    assert.deepEqual(calls, [["to", 0, 0], ["by", 0, -200], ["intoView"]]);
});

test("scroll tool errors clearly for a missing element target", async () => {
    const { ml } = loadDomWorld("");
    assert.match(await run(ml, "scroll", { to: "element", selector: "#nope" }), /No element matches/);
    assert.match(await run(ml, "scroll", { to: "element" }), /Provide `selector`/);
});

test("exec captures console output and returns it with the value", async () => {
    const { ml } = loadDomWorld();
    const res = await run(ml, "exec", { js: "console.log('hello', 42); 'done'" });
    assert.match(res, /console:\nhello 42/);
    assert.match(res, /value: done/);
});

test("exec returns console output even when the expression evaluates to undefined", async () => {
    // The pattern the model reached for: forEach + console.log (value is undefined).
    const { ml } = loadDomWorld("<li>a</li><li>b</li>");
    const res = await run(ml, "exec", {
        js: "document.querySelectorAll('li').forEach((el,i) => console.log(i, el.textContent))"
    });
    assert.match(res, /0 a/);
    assert.match(res, /1 b/);
    assert.match(res, /value: \(undefined\)/);
});

test("exec hands back DOM nodes as hoverable elements", async () => {
    const { ml } = loadDomWorld("<li></li><li></li>");
    const one = await run(ml, "exec", { js: "document.querySelector('li')" });
    assert.equal(one.content, "body > li");            // elPath of the node
    assert.equal(one.elements[0].tagName, "LI");
    const many = await run(ml, "exec", { js: "document.querySelectorAll('li')" });
    assert.equal(many.content, "2 element(s)");
    assert.equal(many.elements.length, 2);
});

// ---- agent loop ----
// These ride the real ml.step relay (loadPageWorld) with a scripted "model",
// and use fake tools so the loop mechanics are isolated from the DOM.

// A scripted model: `turns` is an array of assistant replies, one per ml.step.
const scriptedModel = (turns) => {
    let i = 0;
    return (m) => {
        // Let the harness auto-answer the agent's #8 config/capability probes so
        // they don't consume a scripted model turn.
        if (m.type === "GET_CONFIG" || m.type === "MODEL_CAPS") return undefined;
        return { data: turns[Math.min(i++, turns.length - 1)] };
    };
};
const toolCall = (name, args = {}, id = "c") => ({ content: "", tool_calls: [{ id, name, arguments: args }] });
const reply = (content) => ({ content, tool_calls: [] });

test("agent runs a tool, feeds the result back, and stops on a plain reply", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("ping", { x: 1 }, "c1"), reply("done: pinged once")])
    });
    const ping = world.ml.defineTool({ name: "ping", run: ({ x }) => `pong${x}` });
    const res = await world.ml.agent("do it", { tools: [ping], maxSteps: 5 });

    assert.equal(res.summary, "done: pinged once");
    assert.equal(res.steps, 1);
    assert.deepEqual(res.transcript, [{ tool: "ping", arguments: { x: 1 }, result: "pong1" }]);
    // Second turn carried the assistant tool_calls and the tool result back.
    const sent = world.runtimeCalls[1].payload.messages;
    assert.equal(sent.at(-2).tool_calls[0].name, "ping");
    assert.deepEqual(sent.at(-1), { role: "tool", tool_call_id: "c1", content: "pong1" });
});

test("a tool call missing a required arg short-circuits with the schema error (tool NOT run)", async () => {
    let ran = 0;
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("needsIt", { y: 1 }, "c1"), reply("ok")]) });
    const t = world.ml.defineTool({ name: "needsIt", parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] }, run: () => { ran++; return "ran"; } });
    const res = await world.ml.agent("x", { tools: [t], maxSteps: 3 });
    assert.equal(ran, 0, "the tool never ran with a missing required arg");
    // The MODEL sees the actual diagnosis, not a downstream symptom — and the
    // "Error:" prefix makes the sidebar mark the step failed (red dot), not green.
    assert.match(res.transcript[0].result, /^Error: invalid arguments for "needsIt" — missing required "x"; unknown property "y"/);
});

test("a soft schema issue (unknown extra prop) prepends a note but still runs the tool", async () => {
    let ran = 0;
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("t", { x: "a", extra: 1 }, "c1"), reply("ok")]) });
    const t = world.ml.defineTool({ name: "t", parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] }, run: () => { ran++; return "ran"; } });
    const res = await world.ml.agent("x", { tools: [t], maxSteps: 3 });
    assert.equal(ran, 1, "the tool still ran (a lenient validator must not block a legit call)");
    // Note APPENDS, so a real Error:/Denied prefix would stay at position 0.
    assert.match(res.transcript[0].result, /^ran\n\n⚠ Argument schema issue\(s\): unknown property "extra"$/);
});

test("a schema-less tool (no declared properties) is never flagged for its args", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("bare", { anything: 1, more: "x" }, "c1"), reply("ok")]) });
    const t = world.ml.defineTool({ name: "bare", run: () => "ran" });   // no parameters → default empty properties
    const res = await world.ml.agent("x", { tools: [t], maxSteps: 3 });
    assert.equal(res.transcript[0].result, "ran", "no false 'unknown property' note for an undeclared schema");
});

test("agent defaults to ml.domTools and lets you override the system prompt", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    await world.ml.agent("task", { system: "CUSTOM STRATEGY" });

    const { messages, tools } = world.runtimeCalls[0].payload;
    assert.ok(messages[0].content.startsWith("CUSTOM STRATEGY"), messages[0].content);
    assert.equal(messages[1].content, "task");
    const names = tools.map(t => t.function.name);
    assert.ok(names.includes("findByText") && names.includes("exec"), names.join());
});

test("agent injects page/date context into the system prompt by default", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    await world.ml.agent("task", { system: "S" });
    const sys = world.runtimeCalls[0].payload.messages[0].content;
    assert.match(sys, /Current page context:/);
    assert.match(sys, /Now:.*ISO/s);                  // knows what "today" is
});

test("agent env:false skips the context injection", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    await world.ml.agent("task", { system: "S", env: false });
    assert.equal(world.runtimeCalls[0].payload.messages[0].content, "S");
});

test("extraTools append to the default registry", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const mine = world.ml.defineTool({ name: "myTool", run: () => "x" });
    await world.ml.agent("t", { extraTools: [mine] });
    const names = world.runtimeCalls[0].payload.tools.map(t => t.function.name);
    assert.ok(names.includes("myTool") && names.includes("findByText"), names.join());
});

test("agent reports an error for a tool not in the registry", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("ghost"), reply("gave up")])
    });
    const res = await world.ml.agent("x", { tools: [] });
    assert.match(res.transcript[0].result, /no tool named "ghost"/);
});

test("agent stops at maxSteps and flags hitCap", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("ping")]) });
    const ping = world.ml.defineTool({ name: "ping", run: () => "pong" });
    const res = await world.ml.agent("loop forever", { tools: [ping], maxSteps: 3 });
    assert.equal(res.hitCap, true);
    assert.equal(res.steps, 3);
    assert.equal(res.transcript.length, 3);
});

test("agent runs a requiresApproval tool only when the gate allows it", async () => {
    const script = [toolCall("danger", { cmd: "rm" }, "c1"), reply("stopped")];
    const make = () => {
        const world = loadPageWorld({ onRuntimeMessage: scriptedModel(script) });
        let ran = false;
        const danger = world.ml.defineTool({
            name: "danger", requiresApproval: true, run: () => { ran = true; return "did it"; }
        });
        return { world, danger, ran: () => ran };
    };

    const granted = make();
    const okRes = await granted.world.ml.agent("go", { tools: [granted.danger], approve: () => true });
    assert.equal(granted.ran(), true);
    assert.equal(okRes.transcript[0].result, "did it");

    const refused = make();
    const noRes = await refused.world.ml.agent("go", { tools: [refused.danger], approve: () => false });
    assert.equal(refused.ran(), false, "denied tool must not run");
    assert.match(noRes.transcript[0].result, /Denied by the user/);
});

test("approve contract: a rejection's feedback string is fed back to the model", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("danger", { js: "drop()" }, "c1"), reply("ok")])
    });
    let ran = false;
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => { ran = true; } });
    const res = await world.ml.agent("go", {
        tools: [danger],
        approve: () => ({ approved: false, feedback: "use a read-only query instead" })
    });
    assert.equal(ran, false);
    assert.match(res.transcript[0].result, /Denied by the user: use a read-only query instead/);
    // the comment reaches the model as the tool result
    assert.match(world.runtimeCalls.at(-1).payload.messages.at(-1).content, /use a read-only query instead/);
});

test("approve contract: approved-with-edited-arguments runs the edited args", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "original()" }, "c1"), reply("done")])
    });
    let sawArgs;
    const exec = world.ml.defineTool({
        name: "exec", requiresApproval: true, run: (a) => { sawArgs = a; return "ran"; }
    });
    const res = await world.ml.agent("go", {
        tools: [exec],
        approve: () => ({ approved: true, arguments: { js: "edited()" } })
    });
    assert.deepEqual(sawArgs, { js: "edited()" });              // ran the edited script
    assert.equal(res.transcript[0].result, "ran");
    assert.deepEqual(res.transcript[0].arguments, { js: "edited()" }); // transcript reflects what ran
});

test("approve contract: a boolean return still works (backward compatible)", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("danger", { x: 1 }, "c1"), reply("ok")])
    });
    let ran = false;
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => { ran = true; return "did it"; } });
    const res = await world.ml.agent("go", { tools: [danger], approve: () => true });
    assert.equal(ran, true);
    assert.equal(res.transcript[0].result, "did it");
});

test("the default approval gate fails safe to deny without a confirm()", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("danger"), reply("stopped")]) });
    let ran = false;
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => { ran = true; } });
    // loadPageWorld's window has no confirm → defaultApprove denies.
    const res = await world.ml.agent("go", { tools: [danger] });
    assert.equal(ran, false);
    assert.match(res.transcript[0].result, /Denied by the user/);
});

test("agent surfaces the model's reasoning as thought events and transcript entries", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([
            { content: "First I'll check how many results there are.", tool_calls: [{ id: "c1", name: "ping", arguments: {} }] },
            reply("done")
        ])
    });
    const ping = world.ml.defineTool({ name: "ping", run: () => "pong" });
    const events = [];
    const res = await world.ml.agent("x", { tools: [ping], onStep: (e) => events.push(e) });

    assert.ok(res.transcript.some(t => t.thought === "First I'll check how many results there are."));
    assert.ok(events.some(e => e.thought === "First I'll check how many results there are."));
    assert.ok(events.some(e => e.tool === "ping"));           // both kinds of events fire
});

test("agent emits debug events (start → steps → result) after the sidebar handshakes", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([
            { content: "Looking around.", tool_calls: [{ id: "c1", name: "ping", arguments: { x: 1 } }] },
            reply("all done")
        ])
    });
    const ping = world.ml.defineTool({ name: "ping", run: () => "pong" });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));

    await world.ml.agent("find x", { tools: [ping], model: "qwen3:14b", vision: false });

    const start = events.find(e => e.kind === "agent");
    assert.ok(start, "agent start emitted");
    assert.equal(start.task, "find x");
    assert.equal(start.model, "qwen3:14b");
    const steps = events.filter(e => e.kind === "agent-step");
    assert.ok(steps.some(e => e.thought === "Looking around."), "thought step emitted");
    const toolStep = steps.find(e => e.tool === "ping");
    assert.deepEqual(toolStep.arguments, { x: 1 });
    assert.equal(toolStep.result, "pong");
    assert.ok(events.every(e => e.session.hash === start.session.hash), "all events share the run hash");
    const done = events.find(e => e.kind === "agent-result");
    assert.equal(done.summary, "all done");
    assert.equal(done.hitCap, false);
});

test("agent suppresses orphan chat sessions from a tool's internal ml.chat", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([
            toolCall("askvision", {}, "c1"),   // agent step 1 → call the tool
            reply("a description"),            // the tool's OWN internal ml.chat
            reply("final answer")              // agent step 2 → done
        ])
    });
    // A tool that itself calls ml.chat, like the auto-wired `look` vision tool.
    const askvision = world.ml.defineTool({ name: "askvision", run: async () => world.ml.chat("describe") });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));

    await world.ml.agent("x", { tools: [askvision], vision: false });

    assert.ok(!events.some(e => e.kind === "chat" || e.kind === "chat-result"), "internal chat did not spawn its own session");
    assert.ok(events.some(e => e.kind === "agent"), "agent events still emit");
    // The description still surfaces — as the tool step's result.
    assert.ok(events.some(e => e.kind === "agent-step" && e.result === "a description"), "vision result shows as the tool step");
});

// The `agent` debug event carries the resolved toolset (config.tools) after the
// vision auto-wire, so we can assert what got wired without a real screenshot.
async function agentStartEvent(opts, agentOpts = { tools: [] }) {
    const world = loadPageWorld({ ...opts, onRuntimeMessage: scriptedModel([reply("done")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.agent("find the like button", agentOpts);
    return events.find(e => e.kind === "agent");
}
async function agentToolNames(opts) {
    const agentEv = await agentStartEvent(opts);
    return (agentEv.config.tools || []).map(t => t.name);
}

test("agent event resolves the driver model to the config default when none is passed", async () => {
    // No explicit model → the run still reports the concrete default (gemma-vision),
    // NOT null/'default', so the sidebar can tell a vision sub-call reused the driver's
    // model (its render.model === this) vs. ran on a different one.
    const ev = await agentStartEvent({ config: { model: "gemma-vision", ocrModel: "" }, caps: () => ["completion", "vision"] });
    assert.equal(ev.model, "gemma-vision", "unspecified model resolves to the config default (not null/'default')");
});

test("agent event keeps an explicitly-passed model over the config default", async () => {
    const ev = await agentStartEvent({ config: { model: "gemma-vision", ocrModel: "" }, caps: () => ["completion", "vision"] }, { tools: [], model: "qwen3:14b" });
    assert.equal(ev.model, "qwen3:14b");
});

test("agent auto-wires the delegated locate tool when a vision model resolves", async () => {
    const names = await agentToolNames({
        config: { model: "qwen2.5vl", ocrModel: "" },
        caps: (m) => m === "qwen2.5vl" ? ["completion", "vision"] : [],
    });
    assert.ok(names.includes("locate"), "locate auto-wired alongside look");
    assert.ok(names.includes("look"), "look still auto-wired");
});

test("locate is NOT wired when no vision model can be resolved", async () => {
    const names = await agentToolNames({
        config: { model: "text-only", ocrModel: "" },
        caps: () => ["completion"],   // no vision capability anywhere
    });
    assert.ok(!names.includes("locate"), "no locate without a vision reader");
    assert.ok(!names.includes("look"), "no look either");
});

test("click: an @pt point token is decoded (not treated as a CSS selector), unknown → clear error", async () => {
    const { ml } = loadDomWorld('<button>x</button>');
    // A stale/unknown token: recognised as a point (not run through queryAll), rejected clearly.
    const out = await ml.clickTool().run({ selector: "@pt:deadbeef" });
    assert.match(String(out), /Unknown point token/);
    assert.ok(!/No element matches/.test(String(out)), "not mistaken for a CSS selector");
});

test("locate scoping: a missing container selector short-circuits (no screenshot attempt)", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "the star", selector: "#nope" });
    assert.match(String(out), /No element matches "#nope"/);
});

test("locate scoping: a zero/sliver-size container is rejected with an actionable message", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // jsdom reports 0×0 rects, so the too-small guard fires — same path a collapsed
    // container takes in the browser — before any capture/canvas work.
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "the star", selector: "#box" });
    assert.match(String(out), /too small to search within/);
});

test("locate strategy 'grid-grounding' needs a grounding model — short-circuits without one", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // No groundingModel configured → the two-stage strategy can't run; it says so
    // (rather than silently degrading) before any capture.
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "a red icon", strategy: "grid-grounding" });
    assert.match(String(out), /grid-grounding' needs a grounding model/);
});

test("locate grid-grounding + cells needs a grounding model too (reuse path can't fall through to marks)", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // The cells-reuse shortcut runs before the grid block, so the grounding-model
    // guard must fire for it as well — not silently degrade to Set-of-Marks.
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "x", strategy: "grid-grounding", cells: [1] });
    assert.match(String(out), /grid-grounding' needs a grounding model/);
});

test("locate grid-grounding + invalid cells is rejected with the gridSize caveat", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // With a grounder configured, the reuse path validates `cells` against the grid.
    // A wild out-of-range cell is refused, and the message names the gridSize mapping.
    const out = await ml.locateTool({ model: "vlm", groundingModel: "qwen2.5vl" }).run({ description: "x", strategy: "grid-grounding", cells: [9999] });
    assert.match(String(out), /Invalid `cells`/);
    assert.match(String(out), /gridSize/, "explains cells map to a specific gridSize");
});

test("locate region on a sliver container is rejected before any capture", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // jsdom reports 0×0 rects, so scoping to #box then cropping to a region is a
    // non-starter — it's caught with an actionable message, not a broken capture.
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "x", selector: "#box", region: "left" });
    assert.match(String(out), /too small to search/);
});

test("locate rejects an invalid region name (e.g. the model's guessed 'center-left') with the valid list", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // regionBox would throw on an unlisted name; the guard returns an actionable message.
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "x", region: "center-left" });
    assert.match(String(out), /Invalid region "center-left"/);
    assert.match(String(out), /left, right, top, bottom, center/, "lists the valid names");
});

test("locate selector '@pt:…' ('snap around point') rejects an unknown token, not as a CSS selector", async () => {
    const { ml } = loadDomWorld('<div id="box">hi</div>');
    // An @pt selector scopes to the point's neighborhood — a stale/unknown token is
    // caught cleanly (told to re-run locate), never fed to queryAll as a CSS selector.
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "x", selector: "@pt:deadbeef" });
    assert.match(String(out), /Unknown point token/);
    assert.ok(!/No element matches/.test(String(out)), "not mistaken for a CSS selector");
});

// Capture the __mlDebug events emitted by an agent run over one tool.
async function agentDebugEvents(tool) {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall(tool.name, {}, "c1"), reply("done")]) });
    const t = world.ml.defineTool(tool);
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const res = await world.ml.agent("x", { tools: [t], vision: false });
    return { events, res, step: events.find(e => e.kind === "agent-step" && e.tool === tool.name) };
}

test("a custom tool's render() emits a serializable descriptor on its step", async () => {
    const { step } = await agentDebugEvents({
        name: "stats", run: () => "3 items",
        render: () => ({ type: "table", columns: ["k", "v"], rows: [["a", 1]] })
    });
    assert.deepEqual(step.render, { type: "table", columns: ["k", "v"], rows: [["a", 1]] });
});

test("a throwing/absent render() falls back to the default (never breaks the run)", async () => {
    const { res, step } = await agentDebugEvents({ name: "boom", run: () => "ok", render: () => { throw new Error("nope"); } });
    assert.equal(res.summary, "done", "run completed despite the throwing render");
    assert.ok(!step.render, "no descriptor → sidebar uses the default In:/Out:");
});

test("agent auto-derives an image descriptor from a tool that returns a screenshot", async () => {
    const { step } = await agentDebugEvents({ name: "shoot", run: () => ({ content: "shot", image: "data:image/png;base64,AAA", imageLabel: "viewport" }) });
    assert.deepEqual(step.render, { type: "image", src: "data:image/png;base64,AAA", label: "viewport" });
});

test("agent-start carries the resolved config (system prompt, tools, maxSteps)", async () => {
    const { events } = await agentDebugEvents({ name: "ping", run: () => "pong" });
    const start = events.find(e => e.kind === "agent");
    assert.ok(start.config, "config emitted");
    assert.match(start.config.system, /automation agent/, "the resolved system prompt");
    assert.equal(start.config.customSystem, false);
    assert.deepEqual(start.config.tools, [{ name: "ping", requiresApproval: false, vision: false }]);
    assert.equal(start.config.maxSteps, 10);
});

test("agent flags a tool call whose args don't match its parameter schema", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("grab", { index: 2 }, "c1"), reply("done")]) });
    const grab = world.ml.defineTool({
        name: "grab",
        parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
        run: () => "ok"
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.agent("x", { tools: [grab], vision: false });
    const step = events.find(e => e.kind === "agent-step" && e.tool === "grab");
    assert.ok(step.argIssues.some(s => /missing required "selector"/.test(s)));
    assert.ok(step.argIssues.some(s => /unknown property "index"/.test(s)));
});

test("a valid tool call carries no argIssues", async () => {
    const { step } = await agentDebugEvents({
        name: "ok", parameters: { type: "object", properties: {} }, run: () => "fine"
    });
    assert.ok(!step.argIssues, "no issues → field omitted");
});

test("built-in exec renders the run JS as a javascript code descriptor", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("exec", { js: "1 + 1" }, "c1"), reply("done")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => true });
    const step = events.find(e => e.kind === "agent-step" && e.tool === "exec");
    assert.deepEqual(step.render, { type: "code", text: "1 + 1", lang: "javascript", target: "in", format: true });
});

test("autoApproveReadonly: a read-only exec survey runs with NO approval prompt", async () => {
    const world = loadPageWorld({
        config: { model: "", ocrModel: "", autoApproveReadonly: true },
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "[1,2,3].filter(x => x > 1).map(x => x * 10)" }, "c1"), reply("done")]),
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => { approvals++; return true; } });
    assert.equal(approvals, 0, "read-only survey was auto-approved (gate never called)");
    const step = events.find(e => e.kind === "agent-step" && e.tool === "exec");
    assert.match(step.result, /\[20,30\]/, "the interpreter actually ran it");
    assert.equal(step.approval, "readonly", "step tagged as auto-approved");
});

test("autoApproveReadonly: an out-of-dialect exec still goes through the approval gate", async () => {
    const world = loadPageWorld({
        config: { model: "", ocrModel: "", autoApproveReadonly: true },
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "for (const x of [1]) { x }" }, "c1"), reply("done")]),
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => { approvals++; return true; } });
    assert.equal(approvals, 1, "the IIFE isn't in the read-only dialect → normal approval");
    assert.equal(events.find(e => e.kind === "agent-step" && e.tool === "exec").approval, "user", "tagged approved-by-user");
});

test("a denied exec call is tagged 'denied' in its step", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "document.title" }, "c1"), reply("ok, stopped")]),
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => false });
    assert.equal(events.find(e => e.kind === "agent-step" && e.tool === "exec").approval, "denied");
});

test("autoApproveReadonly OFF: read-only exec still prompts (the flag gates it)", async () => {
    const world = loadPageWorld({
        config: { model: "", ocrModel: "", autoApproveReadonly: false },
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "[1,2,3].filter(x => x > 1)" }, "c1"), reply("done")]),
    });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => { approvals++; return true; } });
    assert.equal(approvals, 1, "with the flag off, every exec is gated as before");
});

test("agent routes a tool's DOM nodes to onStep/transcript but never to the model", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("grab", {}, "c1"), reply("done")])
    });
    const node = { tagName: "DIV" };                               // stand-in DOM node
    const grab = world.ml.defineTool({
        name: "grab",
        run: () => ({ content: "found 1", elements: [node] })
    });
    const events = [];
    const res = await world.ml.agent("x", { tools: [grab], onStep: (e) => events.push(e) });

    // The model message carries only the string — no nodes.
    const toolMsg = world.runtimeCalls[1].payload.messages.at(-1);
    assert.equal(toolMsg.content, "found 1");
    assert.ok(!("elements" in toolMsg));
    // The human-facing channels get the real node.
    assert.deepEqual(events.find(e => e.tool === "grab").elements, [node]);
    assert.deepEqual(res.transcript.find(t => t.tool === "grab").elements, [node]);
});

test("agent surfaces answer-capable tool elements on result.elements", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("pick", { selector: "#x" }, "c1"), reply("found it")])
    });
    const node = { tagName: "DIV" };
    const pick = world.ml.defineTool({
        name: "pick", capabilities: ["answer"], run: () => ({ content: "here", elements: [node] })
    });
    const res = await world.ml.agent("find it", { tools: [pick] });

    assert.deepEqual(res.elements, [node]);                    // handed back to the caller
    const toolMsg = world.runtimeCalls[1].payload.messages.at(-1);
    assert.ok(!("elements" in toolMsg));                       // never leaked to the model
});

test("agent surfaces string rejections cleanly (not 'Error: undefined')", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("boom", {}, "c1"), reply("done")])
    });
    // Background tasks reject with a plain string, not an Error.
    const boom = world.ml.defineTool({ name: "boom", run: () => Promise.reject("capture failed") });
    const res = await world.ml.agent("x", { tools: [boom] });
    assert.equal(res.transcript.find(t => t.tool === "boom").result, "Error: capture failed");
});

test("result.elements is empty for a plain action task", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("ping", {}, "c1"), reply("done")])
    });
    const ping = world.ml.defineTool({ name: "ping", run: () => "pong" });
    const res = await world.ml.agent("act", { tools: [ping] });
    assert.deepEqual(res.elements, []);
});

test("agent adds tool-aware clauses to the DEFAULT prompt (vision/answer), not a custom one", async () => {
    const seen = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG" || m.type === "MODEL_CAPS") return undefined;
            seen.push(m.payload.messages[0].content); return { data: reply("done") };
        }
    });
    const look = world.ml.defineTool({ name: "look", capabilities: ["vision"], run: () => "" });
    const answer = world.ml.defineTool({ name: "answer", capabilities: ["answer"], run: () => "" });
    const plain = world.ml.defineTool({ name: "plain", run: () => "" });

    await world.ml.agent("t", { tools: [look, answer] });       // default system → clauses added
    assert.match(seen[0], /VISION tool/);
    assert.match(seen[0], /answer tool/);

    await world.ml.agent("t", { tools: [plain] });              // no vision/answer capability
    assert.doesNotMatch(seen[1], /VISION tool/);
    assert.doesNotMatch(seen[1], /designate it with the answer tool/);

    await world.ml.agent("t", { tools: [look, answer], system: "MINE" }); // custom system → no clauses
    assert.ok(seen[2].startsWith("MINE"));
    assert.doesNotMatch(seen[2], /VISION tool/);
});

test("agent adds the async/wait clause when a wait tool is present", async () => {
    const seen = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG" || m.type === "MODEL_CAPS") return undefined;
            seen.push(m.payload.messages[0].content); return { data: reply("done") };
        }
    });
    const wait = world.ml.domTools.find(t => t.name === "wait");
    const plain = world.ml.defineTool({ name: "plain", run: () => "" });

    await world.ml.agent("t", { tools: [wait], vision: false });
    assert.match(seen[0], /updates ASYNCHRONOUSLY/);
    assert.match(seen[0], /`wait`/);

    await world.ml.agent("t", { tools: [plain], vision: false });   // no wait tool → no clause
    assert.doesNotMatch(seen[1], /updates ASYNCHRONOUSLY/);
});

test("wait tool: fixed ms pause and wait-for-selector resolve", async () => {
    const { ml, document } = loadDomWorld('<div id="present"></div>');
    const wait = ml.domTools.find(t => t.name === "wait");
    assert.ok(wait, "wait is a default domTool");

    assert.match(await wait.run({ ms: 5 }), /Waited 5ms/);
    assert.match(await wait.run({ selector: "#present" }), /appeared/);   // already there → resolves at once

    // A selector that appears shortly after → the observer resolves it.
    setTimeout(() => { const d = document.createElement("div"); d.id = "later"; document.body.appendChild(d); }, 5);
    assert.match(await wait.run({ selector: "#later", timeout: 500 }), /appeared/);
});

test("hints append task facts while keeping the built-in workflow", async () => {
    const seen = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG" || m.type === "MODEL_CAPS") return undefined;
            seen.push(m.payload.messages[0].content); return { data: reply("done") };
        }
    });
    const plain = world.ml.defineTool({ name: "plain", run: () => "" });
    await world.ml.agent("t", { tools: [plain], hints: "On amazon.nl sponsored = Gesponsord." });

    assert.match(seen[0], /General method:/);                  // workflow still present
    assert.match(seen[0], /Task-specific notes:\nOn amazon\.nl sponsored/);  // hints appended
});

test("logDebug installs a built-in console tracer and still forwards to onStep", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("ping", { x: 1 }, "c1"), reply("done")])
    });
    const ping = world.ml.defineTool({ name: "ping", run: () => "pong" });
    const seen = [];
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a);
    try {
        await world.ml.agent("t", { tools: [ping], logDebug: true, onStep: (e) => seen.push(e) });
    } finally { console.log = orig; }

    // Built-in tracer logged the tool line: "#1 ping", { x: 1 }, "→", "pong".
    assert.ok(logs.some(a => a[0] === "#1 ping" && a[2] === "→" && a[3] === "pong"), JSON.stringify(logs));
    // onStep still fired (composes, not overrides).
    assert.ok(seen.some(e => e.tool === "ping"));
});

// ---- #8: auto-registered vision tool (no wiring needed) ----
// The default toolset (ml.domTools) has no vision tool. ml.agent probes the
// model's capabilities and, when it (or the OCR model) can see, wires up `look`.

const agentTools = (world) => world.runtimeCalls[0].payload.tools.map(t => t.function.name);

test("agent auto-registers a look tool when its model is vision-capable", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([reply("done")]),
        config: { model: "qwen-vl", ocrModel: "" },
        caps: (m) => (m === "qwen-vl" ? ["completion", "vision"] : null)
    });
    await world.ml.agent("t");
    assert.ok(agentTools(world).includes("look"), agentTools(world).join());
    // adding a vision tool also switches on the default prompt's VISION clause
    assert.match(world.runtimeCalls[0].payload.messages[0].content, /VISION tool/);
});

test("agent falls back to the OCR model for eyes when its own model is text-only", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([reply("done")]),
        config: { model: "text-only", ocrModel: "ocr-vl" },
        caps: (m) => (m === "ocr-vl" ? ["vision"] : ["completion"])
    });
    await world.ml.agent("t");
    assert.ok(agentTools(world).includes("look"), agentTools(world).join());
});

test("agent does NOT auto-add a look tool when vision capability is unknown (cloud/non-Ollama)", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([reply("done")]),
        config: { model: "gpt-4o", ocrModel: "" },
        caps: () => null                       // undeterminable → must NOT qualify
    });
    await world.ml.agent("t");
    assert.ok(!agentTools(world).includes("look"), agentTools(world).join());
    assert.doesNotMatch(world.runtimeCalls[0].payload.messages[0].content, /VISION tool/);
});

test("vision:false disables auto-registration", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([reply("done")]),
        config: { model: "qwen-vl", ocrModel: "" },
        caps: () => ["vision"]
    });
    await world.ml.agent("t", { vision: false });
    assert.ok(!agentTools(world).includes("look"), agentTools(world).join());
});

test("vision:'<model>' forces a look tool without probing", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([reply("done")]),
        caps: () => { throw new Error("must not probe when a model is forced"); }
    });
    await world.ml.agent("t", { vision: "my-vl" });
    assert.ok(agentTools(world).includes("look"), agentTools(world).join());
});

test("agent skips auto-vision when the toolset already has a vision tool", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([reply("done")]),
        config: { model: "qwen-vl", ocrModel: "" },
        caps: () => ["vision"]
    });
    const eyes = world.ml.defineTool({ name: "look", capabilities: ["vision"], run: () => "" });
    await world.ml.agent("t", { extraTools: [eyes] });
    const looks = world.runtimeCalls[0].payload.tools.filter(t => t.function.name === "look");
    assert.equal(looks.length, 1, "must not add a second look tool");
});

// ---- #3: inline vision (agent's own model sees the pixels) ----

test("_nativeLookTool captures a screenshot as an image envelope + the live element", async () => {
    const { ml } = loadDomWorld('<div id="card">hi</div>');
    ml.screenshot = async (sel) => `data:image/png;base64,SHOT_${sel || "viewport"}`;
    const look = ml._nativeLookTool();
    assert.deepEqual(look.capabilities, ["vision"]);

    const out = await look.run({ selector: "#card" });
    assert.equal(out.image, "data:image/png;base64,SHOT_#card");     // raw image handed back
    assert.match(out.content, /Screenshot of the element "#card"/);  // text result for the tool msg
    assert.match(out.content, /shown to you/);
    // the screenshotted node rides the side-channel (hoverable in logDebug/onStep)
    assert.equal(out.elements[0].id, "card");

    // no selector (viewport) → no element
    const view = await look.run({});
    assert.equal(view.elements, undefined);
});

test("inline vision (#3): a vision-capable agent model gets the screenshot in its OWN history", async () => {
    const steps = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG") return { data: { model: "qwen-vl", ocrModel: "" } };
            if (m.type === "MODEL_CAPS") return { data: ["completion", "vision"] };
            steps.push(m.payload.messages);
            return { data: steps.length === 1
                ? { content: "", tool_calls: [{ id: "c1", name: "look", arguments: {} }] }
                : { content: "I can see a search box at the top.", tool_calls: [] } };
        }
    });
    world.ml.screenshot = async () => "data:image/png;base64,SHOT";

    const res = await world.ml.agent("what's on this page?");

    // The screenshot was injected into the agent's own conversation as a user turn
    // carrying the actual image bytes — not delegated to a second model.
    const injected = steps.some(msgs => msgs.some(m =>
        m.role === "user" && Array.isArray(m.images) && m.images.includes("data:image/png;base64,SHOT")));
    assert.ok(injected, "screenshot injected into the agent's own history");
    const imgTurn = steps.flat().find(m => m.role === "user" && Array.isArray(m.images));
    assert.match(imgTurn.content, /Describe what you see/);
    assert.equal(res.summary, "I can see a search box at the top.");
});

test("approveOnce dedups by (tool, args): identical repeats free, new scripts re-ask", () => {
    const { ml, window } = loadDomWorld();
    let asked = 0;
    window.confirm = () => { asked++; return true; };
    const gate = ml.approveOnce();

    // Identical exec call: asked once, the repeat is free.
    assert.equal(gate({ tool: "exec", arguments: { js: "hideAds()" } }), true);
    assert.equal(gate({ tool: "exec", arguments: { js: "hideAds()" } }), true);
    assert.equal(asked, 1, "identical exec not re-asked");

    // A DIFFERENT exec script must be approved on its own — the whole point.
    assert.equal(gate({ tool: "exec", arguments: { js: "wipeEverything()" } }), true);
    assert.equal(asked, 2, "a new exec script re-asks");

    // Denials are remembered per exact call too.
    window.confirm = () => { asked++; return false; };
    assert.equal(gate({ tool: "danger", arguments: { x: 1 } }), false);
    assert.equal(gate({ tool: "danger", arguments: { x: 1 } }), false);
    assert.equal(asked, 3, "danger asked once, denial remembered");
});

test("the approval prompt warns about hidden characters in the args", () => {
    const { ml, window } = loadDomWorld();
    let msg = "";
    window.confirm = (m) => { msg = m; return true; };
    const gate = ml.approveOnce();

    gate({ tool: "exec", arguments: { js: "doThing()\u202E // hidden" } });   // bidi override
    assert.match(msg, /WARNING.*hidden\/suspicious/);
    msg = "";
    gate({ tool: "exec", arguments: { js: "cleanThing()" } });               // clean → no warning
    assert.doesNotMatch(msg, /WARNING/);
});

// ---- lookTool (vision) ----
// ml.screenshot's crop needs a real canvas (browser only), so it's stubbed;
// the vision reply flows through the real ml.chat relay.

test("lookTool screenshots the element and asks the vision model about it", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            const last = msg.payload.messages.at(-1);
            assert.deepEqual(last.images, ["data:image/png;base64,SHOT"]);
            assert.match(last.content, /sponsored/);
            return { data: "yes, it looks sponsored" };
        }
    });
    world.ml.screenshot = async (sel) => { assert.equal(sel, "#card"); return "data:image/png;base64,SHOT"; };

    const look = world.ml.lookTool();
    assert.equal(look.name, "look");
    const out = await look.run({ selector: "#card", question: "is it sponsored?" });
    assert.equal(out, "yes, it looks sponsored");
});

test("lookTool falls back to a default prompt and forwards a vision model", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.match(msg.payload.messages.at(-1).content, /Describe the element "#x" concisely/);
            assert.equal(msg.payload.model, "qwen2.5vl");
            return { data: "a product card" };
        }
    });
    world.ml.screenshot = async () => "data:image/png;base64,SHOT";
    const look = world.ml.lookTool({ model: "qwen2.5vl" });
    assert.equal(await look.run({ selector: "#x" }), "a product card");
});

test("lookTool caps the vision generation by default (roadmap #11 wedge guard)", async () => {
    const seen = [];
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => { seen.push(msg.payload.maxTokens); return { data: "desc" }; }
    });
    world.ml.screenshot = async () => "data:image/png;base64,SHOT";

    await world.ml.lookTool().run({ selector: "#x" });                 // default cap
    assert.equal(seen[0], 512);
    await world.ml.lookTool({ maxTokens: 128 }).run({ selector: "#x" }); // override
    assert.equal(seen[1], 128);
});

test("lookTool with no selector screenshots the whole page to orient", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            const content = msg.payload.messages.at(-1).content;
            assert.match(content, /current page/);
            assert.match(content, /findByText/);      // always asks for searchable anchors
            return { data: "an Amazon search results page" };
        }
    });
    let target = "unset";
    world.ml.screenshot = async (t = null) => { target = t; return "data:image/png;base64,VIEW"; };

    const out = await world.ml.lookTool().run({});          // no selector
    assert.equal(target, null, "whole-page screenshot (no element target)");
    assert.equal(out, "an Amazon search results page");
});

test("lookTool scope:'page' stitches and frames it as a downscaled overview", async () => {
    const prompts = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => { prompts.push(m.payload.messages.at(-1).content); return { data: "desc" }; }
    });
    const seen = [];
    world.ml.screenshot = async (t, o) => { seen.push([t, o]); return "data:image/png;base64,VIEW"; };

    await world.ml.lookTool().run({ scope: "page" });
    assert.deepEqual(seen[0], [null, { fullPage: true, index: 0 }]); // whole page, stitched
    assert.match(prompts[0], /downscaled|overview/i);          // framed as orientation
    assert.doesNotMatch(prompts[0], /list a few EXACT/i);      // does NOT ask to extract anchors

    await world.ml.lookTool().run({});                         // default: viewport only
    assert.equal(seen[1][1].fullPage, false);
    assert.match(prompts[1], /list a few EXACT.*findByText/s); // sharp enough to quote anchors

    // classifying a grid: look at the Nth match (index passed through to screenshot)
    await world.ml.lookTool().run({ selector: ".post", index: 2 });
    assert.deepEqual(seen[2], [".post", { fullPage: false, index: 2 }]);
    assert.match(prompts[2], /match #2/);
});

test("lookTool surfaces a screenshot failure as an error string", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "unused" }) });
    world.ml.screenshot = async () => { throw new Error("element is 320×1px — too small to screenshot."); };
    const out = await world.ml.lookTool().run({ selector: ".gone" });
    assert.match(out, /^Error: element is 320×1px/);
});

test("screenshot rejects a degenerate 1px-sliver element (roadmap #10)", async () => {
    const { ml, document } = loadDomWorld('<div id="sliver"></div><div id="ok"></div>');
    const el = document.querySelector("#sliver");
    el.getBoundingClientRect = () => ({ width: 320, height: 1, left: 0, top: 0, right: 320, bottom: 1 });
    // scroll:false skips the requestAnimationFrame path (not in the jsdom sandbox),
    // so we exercise just the size guard.
    await assert.rejects(ml.screenshot("#sliver", { scroll: false }), /320×1px — too small/);

    // A zero-sized (hidden) element is caught by the same guard.
    const hidden = document.querySelector("#ok");
    hidden.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 });
    await assert.rejects(ml.screenshot("#ok", { scroll: false }), /0×0px — too small/);
});

// ---- interaction tools (opt-in, gated): click / type (#7) ----

test("clickTool is gated, opt-in, and clicks the selected match", async () => {
    const { ml, document } = loadDomWorld('<button id="b">Go</button><a class="x">1</a><a class="x">2</a>');
    const click = ml.clickTool();
    assert.equal(click.requiresApproval, true);                 // side effects → gated
    assert.ok(!ml.domTools.some(t => t.name === "click"), "not in the default read-only set");

    let clicked = 0;
    document.querySelector("#b").click = () => { clicked++; };
    assert.match(await click.run({ selector: "#b" }), /Clicked/);
    assert.equal(clicked, 1);

    let hit = null;
    document.querySelectorAll("a.x")[1].click = () => { hit = "2"; };
    await click.run({ selector: "a.x", index: 1 });             // Nth match
    assert.equal(hit, "2");

    assert.match(await click.run({ selector: "#nope" }), /No element matches/);
});

test("typeTool sets a field's value, fires input/change, and can append", async () => {
    const { ml, document } = loadDomWorld('<input id="q" value="old">');
    const type = ml.typeTool();
    assert.equal(type.requiresApproval, true);

    const events = [];
    const input = document.querySelector("#q");
    for (const t of ["input", "change"]) input.addEventListener(t, () => events.push(t));

    const out = await type.run({ selector: "#q", text: "hello" });   // replaces by default
    assert.equal(input.value, "hello");
    assert.deepEqual(events, ["input", "change"]);
    assert.match(out, /Value now: "hello"/);

    await type.run({ selector: "#q", text: "!", append: true });     // append
    assert.equal(input.value, "hello!");
});

test("typeTool errors clearly for a missing field", async () => {
    const { ml } = loadDomWorld('<input id="q">');
    assert.match(await ml.typeTool().run({ selector: "#nope", text: "x" }), /No element matches/);
});

// ---- describeSkeleton ----

test("_describeSkeleton shows tag/id/classes/data-attrs and OWN text only", () => {
    const { ml, document } = loadDomWorld(
        '<div id="card" class="a b" data-sku="123" data-asin="XYZ" role="listitem">' +
        'Hello<span>child text</span></div>'
    );
    const out = ml._describeSkeleton(document.querySelector("#card"), 0); // depth 0
    // depth exhausted → children aren't expanded, but their COUNT is flagged so
    // the model knows to drill deeper rather than treat this as a leaf.
    assert.equal(out, 'div#card.a.b [data-sku="123" data-asin="XYZ"] "Hello" › 1 child');
    assert.ok(!out.includes("child text"), "own text only, not descendant text");
    assert.ok(!out.includes("role"), "non-data attributes are dropped");
});

test("_describeSkeleton flags hidden children with a count at the depth cutoff", () => {
    const { ml, document } = loadDomWorld("<ul><li>a</li><li>b</li><li>c</li></ul>");
    // depth 1 shows the li's, but each li's own subtree is cut off — li 'a' has none,
    // so no marker; a nested case shows the count.
    const nested = loadDomWorld("<div class='card'><div class='inner'><span>x</span></div></div>");
    const out = nested.ml._describeSkeleton(nested.document.querySelector(".card"), 1);
    assert.match(out, /div\.inner › 1 child$/);       // inner's <span> is beyond depth
    assert.ok(ml._describeSkeleton(document.querySelector("ul"), 1).split("\n").length >= 4);
});

test("_describeSkeleton recurses to depth and indents children", () => {
    const { ml, document } = loadDomWorld("<ul><li>one</li><li>two</li></ul>");
    assert.equal(ml._describeSkeleton(document.querySelector("ul"), 1), 'ul\n  li "one"\n  li "two"');
});

test("_describeSkeleton truncates own text at 60 chars and data values at 20", () => {
    const { ml, document } = loadDomWorld(
        `<p data-x="${"y".repeat(40)}">${"z".repeat(80)}</p>`
    );
    const out = ml._describeSkeleton(document.querySelector("p"), 0);
    assert.ok(out.includes('data-x="' + "y".repeat(20) + '…"'), out);
    assert.ok(out.includes('"' + "z".repeat(60) + '…"'), out);
});

test("_describeSkeleton caps children at 12 with an overflow marker", () => {
    const items = Array.from({ length: 14 }, (_, i) => `<li>i${i}</li>`).join("");
    const { ml, document } = loadDomWorld(`<ul>${items}</ul>`);
    const lines = ml._describeSkeleton(document.querySelector("ul"), 1).split("\n");
    assert.equal(lines.length, 1 + 12 + 1);            // ul + 12 li + overflow
    assert.equal(lines.at(-1), "  …(2 more)");
});
