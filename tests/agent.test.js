// Unit tests for the agent's DOM introspection helpers (ml._truncate,
// ml._elPath, ml._describeSkeleton). These do fiddly ancestor-walking and
// recursion with hard token budgets, so they're pinned down here against a
// REAL DOM (jsdom via loadDomWorld) — a hand-rolled fake would only encode our
// own assumptions about childNodes/children/classList and hide the bugs we care
// about.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadDomWorld, loadPageWorld } = require("./helpers");
const { AnswerSet } = require("../src/answer-set.ts");

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

test("__mlStartAgent (HUD composer relay) runs a REAL createAgent().run() in the page", () => {
    // The Spotlight composer → shell → page: injected must start a genuine session via createAgent().run()
    // (so it registers a HANDLE the composer can then steer), not a bare ml.agent(). Stub createAgent.
    const { ml, window } = loadDomWorld();
    let createdOpts = null, ranWith = null;
    ml.createAgent = (opts) => { createdOpts = opts; return { run: (task) => { ranWith = task; return Promise.resolve({ summary: "" }); } }; };
    window.dispatchEvent(new window.MessageEvent("message", { data: { __mlStartAgent: { task: "do a thing", maxSteps: 20 } }, source: window }));
    assert.equal(ranWith, "do a thing", "the page ran createAgent().run() with the composer's task");
    assert.equal(createdOpts?.maxSteps, 20, "the composer's step budget threads through");
    // A UI-started run gets a capable default kit (click/type/python) via extraTools — the model tried to
    // use `click` and got "no tool named click" when it was missing.
    const toolNames = (createdOpts?.extraTools || []).map(t => t.name);
    assert.ok(["click", "type", "python_exec", "chat_metadata"].every(n => toolNames.includes(n)), `composer run wires click/type/python/chat_metadata (got ${toolNames.join(",")})`);
    // Invocation provenance: SELF_CLAUSE tells the model the user CAN drive it from the console, which
    // would be the wrong answer to "how did you start?" for a HUD run. `hints` APPENDS (system would
    // replace the whole preamble), so the method survives.
    assert.match(createdOpts?.hints || "", /HUD/, "a UI-started run tells the model it came from the HUD");
    assert.equal(createdOpts?.system, undefined, "the HUD must not REPLACE the built-in system prompt");

    // A blank task is ignored (no empty run).
    ranWith = null;
    window.dispatchEvent(new window.MessageEvent("message", { data: { __mlStartAgent: { task: "   " } }, source: window }));
    assert.equal(ranWith, null, "a blank task starts nothing");
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
// Run a domTool and return its MODEL-FACING text. A tool may return a bare string or a ToolResult
// ({ content, render, … } — e.g. exec now carries a rendered Out alongside the same raw text), so
// unwrap `content` here; tests that care about the render read `.render` off the tool directly.
const run = (ml, name, args) => ml.domTools.find(t => t.name === name).run(args);
// `exec` returns a ToolResult (its model-facing `content` PLUS a rendered Out descriptor). These assertions
// want the text the model actually read, so unwrap it; tests about the render/elements read the object.
const execText = async (ml, args) => {
    const r = await run(ml, "exec", args);
    return (r && typeof r === "object" && typeof r.content === "string") ? r.content : r;
};

test("agent_api_docs ships the generated window.ml reference in the default registry", async () => {
    // The doc itself is covered by tests/api-docs.test.mjs; what matters here is that it
    // survives the bundle into ml.domTools — the tool is the agent's only self-knowledge
    // beyond SELF_CLAUSE, and an empty/undefined import would fail silently at runtime.
    // No content-script relay in this world, so the live-shortcut lookup must TIME OUT and
    // still return the reference (a docs call must never hang a step).
    const { ml } = loadDomWorld("<p>hi</p>");
    const docs = await run(ml, "agent_api_docs", {});
    assert.match(docs, /Opening the HUD/, "the runtime invocation section is appended");
    assert.match(docs, /shortcuts/, "the user is pointed at the rebinding page even without the relay");
    assert.ok(docs.length > 2000, `expected the full reference, got ${docs.length} chars`);
    assert.ok(docs.includes("devtools console"), "missing the console framing the tool exists for");
    assert.ok(docs.includes("agent(task"), "missing ml.agent's signature");
    assert.ok(!/\b_logStep\s*\(/.test(docs), "internal plumbing leaked into the shipped doc");
});

test("agent_api_docs reports the free read-only ml calls ONLY when autoApproveReadonly is on", async () => {
    // Runtime state, like the HUD shortcut — so it lives in the docs tool (paid only when the model
    // asks about itself), not the system prompt. With the flag off these calls DO hit the gate, and
    // saying otherwise would be a lie the model acts on.
    const docsWith = async (config) => {
        // Answer only the shortcut lookup (so it doesn't wait out its timeout); GET_CONFIG must fall
        // through to the harness's own probe reply, which is what carries `config`.
        const world = loadPageWorld({ config, onRuntimeMessage: (m) => m.type === "GET_INVOCATION" ? { data: null } : undefined });
        return world.ml.domTools.find(t => t.name === "agent_api_docs").run({});
    };
    const on = await docsWith({ model: "m", ocrModel: "", autoApproveReadonly: true });
    assert.match(on, /no approval needed/i);
    assert.ok(on.includes("ml.getModel()") && on.includes("ml.serverTools()"), "lists the free set");
    const off = await docsWith({ model: "m", ocrModel: "", autoApproveReadonly: false });
    assert.ok(!/no approval needed/i.test(off), "flag off → the section is omitted entirely");
});

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

test("shadow DOM: the DOM tools pierce OPEN shadow roots, and a shadow reference re-resolves via `>>>`", () => {
    const { ml, document } = loadDomWorld('<div id="host"></div><button>light-only</button>');
    const root = document.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = '<button class="save" aria-label="Save doc">Save</button>';

    // A plain selector with no light-DOM match falls back to piercing the shadow root.
    const d = run(ml, "describeElement", { selector: "button.save" });
    assert.match(String(d.content ?? d), /button/, "describeElement finds the shadow button");

    // interactives lists the shadow control by its accessible name, with a shadow-crossing `>>>` selector.
    const inter = run(ml, "interactives", {}).content;
    assert.match(inter, /Save doc/, "interactives lists the shadow control");
    assert.match(inter, /#host >>> button/, "its reference crosses the boundary with `>>>`");

    // That `>>>` reference re-resolves back to the same shadow element (click/describeElement can use it).
    const desc = (sel) => { const r = run(ml, "describeElement", { selector: sel }); return String(r.content ?? r); };
    assert.match(desc("#host >>> button"), /button/, "a `>>>` reference resolves into the shadow root");

    // describeElement on an OPEN host descends into the shadow tree (was "no child elements") and flags it.
    const openDesc = desc("#host");
    assert.match(openDesc, /#shadow-root \(OPEN\)/, "an open shadow host is flagged as OPEN");
    assert.match(openDesc, /button/, "and its shadow children are shown");

    // A CLOSED root (a Web Component with no light children): unreachable by selector; describeElement flags
    // it CLOSED and steers to locate/@pt with the host selector.
    const sealed = document.createElement("sealed-widget");
    document.body.append(sealed);
    sealed.attachShadow({ mode: "closed" }).innerHTML = '<button class="secret">x</button>';
    assert.match(desc("button.secret"), /No element/, "a CLOSED shadow root is NOT pierced by selector");
    const closedDesc = desc("sealed-widget");
    assert.match(closedDesc, /#shadow-root \(CLOSED\)/, "a closed-root Web Component is flagged CLOSED");
    assert.match(closedDesc, /locate\(\{.*selector: "sealed-widget"/, "steered to locate() scoped to the host selector");

    // ancestors climbs OUT of the shadow root to the host + light DOM (parentElement is null at the top).
    const anc = String(run(ml, "ancestors", { selector: "#host >>> button" }).content ?? "");
    assert.match(anc, /crossed a shadow boundary/, "ancestors crosses the shadow boundary up to the host");
    assert.match(anc, /host/, "and reaches the light-DOM host");
});

test("shadow DOM: scanning tools + describeElement tailor the CLOSED-root steer to whether `locate` is wired (ToolContext)", () => {
    const { ml, document } = loadDomWorld('<button>light</button>');
    const sealed = document.createElement("sealed-box");
    document.body.append(sealed);
    sealed.attachShadow({ mode: "closed" }).innerHTML = '<button>x</button>';
    const tool = (name) => ml.domTools.find(t => t.name === name);
    const withLocate = { tools: ["locate"], hasTool: (n) => n === "locate", model: null, capabilities: null };
    const noLocate = { tools: [], hasTool: () => false, model: null, capabilities: null };

    // A page-scanning tool appends a disclaimer naming the closed host — and the workaround is gated on ctx.
    const iL = tool("interactives").run({}, withLocate).content;
    assert.match(iL, /CLOSED shadow root.*sealed-box/s, "the disclaimer names the closed host");
    assert.match(iL, /locate\(/, "with locate advice when it's wired");
    assert.match(tool("interactives").run({}, noLocate).content, /no `locate` tool is available/, "without locate: says it can't reach them");
    assert.match(tool("interactives").run({}).content, /CLOSED shadow root/, "no ctx → still notes it (with pessimistic advice)");

    // findByText appends it too (a no-match is exactly when the model needs the nudge).
    assert.match(String(tool("findByText").run({ text: "zzz" }, withLocate)), /CLOSED shadow root/, "findByText appends the disclaimer");

    // describeElement on the closed host tailors the per-host steer.
    assert.match(String(tool("describeElement").run({ selector: "sealed-box" }, withLocate).content), /locate\(\{.*selector: "sealed-box"/, "with locate → a scoped locate() example");
    assert.match(String(tool("describeElement").run({ selector: "sealed-box" }, noLocate).content), /no `locate` tool/, "without locate → says it can't interact");

    // pageInfo (orientation) reports shadow roots so a scanning model knows they exist.
    assert.match(String(tool("pageInfo").run({})), /Shadow DOM.*(no light DOM|ml\.shadowRoots)/s, "pageInfo counts shadow roots up front + points at the diagnostic");
});

test("click: a `>>>` into a SEALED shadow root hands back a cdpShadowClick signal (the background reaches it via CDP, not a dead 'no match')", async () => {
    const { ml, document } = loadDomWorld('<sealed-box id="s"></sealed-box>');
    // A sealed host has NO reachable shadow root in jsdom; paint it so isSealedHost (firstHopSealed) promotes it.
    document.getElementById("s").getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 });
    const res = await ml.clickTool().run({ selector: "sealed-box >>> .go", verify: true });
    assert.ok(res && res.cdpShadowClick, "emits a cdpShadowClick signal instead of dead-ending at 'no match'");
    assert.equal(res.cdpShadowClick.selector, "sealed-box >>> .go", "carries the `>>>` selector for the background to CDP-resolve");
    assert.equal(res.cdpShadowClick.verify, true, "verify rides along so the background captures the result after the CDP click");
});

test("click: a `>>>` miss into a NON-sealed (open) host is a plain 'no match' — never a spurious CDP signal", async () => {
    const { ml, document } = loadDomWorld('<open-box id="o"></open-box>');
    const o = document.getElementById("o");
    o.getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 });
    o.attachShadow({ mode: "open" }).innerHTML = '<button class="here">x</button>';
    const res = await ml.clickTool().run({ selector: "open-box >>> .missing" });
    assert.equal(typeof res, "string", "a plain error string");
    assert.match(res, /No element matches/, "an open root the JS path already enters → ordinary no-match");
});

test("same-origin iframe: the DOM tools cross it via `>>>` (findByText / describeElement / interactives)", () => {
    const { ml, document } = loadDomWorld('<iframe id="f"></iframe><button>outside</button>');
    const frame = document.getElementById("f");
    if (!frame.contentDocument) { console.log("(skipped: jsdom has no iframe contentDocument)"); return; }
    frame.contentDocument.body.innerHTML = '<button class="reveal" aria-label="Reveal secret">Reveal secret</button>';

    // findByText crosses into the same-origin frame and returns a frame-crossing `>>>` reference.
    const found = run(ml, "findByText", { text: "Reveal secret" }).content;
    assert.match(found, /Reveal secret/, "findByText finds the button inside the same-origin iframe");
    assert.match(found, /#f >>> button/, "referenced with a frame-crossing `>>>`");

    // The `>>>` reference re-resolves back INTO the frame (describeElement/click/type can use it).
    const desc = (sel) => String(run(ml, "describeElement", { selector: sel }).content ?? "");
    assert.match(desc("iframe#f >>> button.reveal"), /button/, "a `>>>` reference resolves into the frame");

    // describeElement on the iframe descends + flags it SAME-ORIGIN.
    const iframeDesc = desc("iframe#f");
    assert.match(iframeDesc, /#document \(SAME-ORIGIN iframe\)/, "the iframe is flagged same-origin");
    assert.match(iframeDesc, /button/, "and its contents are shown");

    // interactives lists the in-frame control with the `>>>` reference.
    assert.match(run(ml, "interactives", {}).content, /Reveal secret/, "interactives lists the in-frame control");

    // ancestors climbs OUT of the frame to the host <iframe> in the parent document.
    const anc = String(run(ml, "ancestors", { selector: "iframe#f >>> button.reveal" }).content ?? "");
    assert.match(anc, /crossed a same-origin iframe boundary/, "ancestors crosses the frame boundary up to the host");
    assert.match(anc, /iframe/, "and reaches the host iframe in the parent document");
});

test("render descriptor: an iframe element renders its `>>>` selector, not the bare TAG (cross-realm instanceof)", () => {
    const { descriptorFor } = require("../src/render-descriptor.ts");
    const { document, window } = loadDomWorld('<iframe id="f"></iframe>');
    const frame = document.getElementById("f");
    if (!frame.contentDocument) { console.log("(skipped: jsdom has no iframe contentDocument)"); return; }
    frame.contentDocument.body.innerHTML = '<button id="b" aria-label="Reveal secret">Reveal secret</button>';
    const btn = frame.contentDocument.getElementById("b");
    // descriptorFor builds the rendered "elements" list. The node lives in the FRAME's realm, so a bare
    // `instanceof Element` was false → it fell back to `nodeName` ("BUTTON") + a broken (unhoverable) path.
    // (require() loads dom.ts in node's scope, so bind the jsdom globals it reads for the call.)
    const prevDoc = global.document, prevWin = global.window;
    global.document = document; global.window = window;
    try {
        const { out } = descriptorFor({ name: "findByText" }, { result: "", elements: [btn] }, {});
        assert.equal(out.type, "elements", "an elements descriptor is produced");
        assert.match(out.items[0].path, />>>\s*#b/, "the path is the frame-crossing `>>>` selector (into the iframe)");
        assert.notEqual(out.items[0].path, "BUTTON", "NOT the bare tag name");
        assert.match(out.items[0].text, /Reveal secret/, "and the accessible name shows");
    } finally { global.document = prevDoc; global.window = prevWin; }
});

// ---- click/type `verify`: fold the post-action look() into the call ----
// (jsdom has no real screenshot + returns 0×0 rects, so stub screenshot/chat + mock the element rect.)
const mockRect = (el, o) => { el.getBoundingClientRect = () => ({ left: o.x, top: o.y, width: o.w, height: o.h, right: o.x + o.w, bottom: o.y + o.h, x: o.x, y: o.y, toJSON() {} }); };
const visionCtx = (driverSees) => ({ driverSees, visionModel: "vlm", tools: [], hasTool: () => false, model: "m", capabilities: null });

test("click verify (vision driver): folds a CLEAN (no-overlay) post-action AREA crop in, target centred", async () => {
    const { ml, document } = loadDomWorld('<button id="b">Go</button>');
    mockRect(document.getElementById("b"), { x: 10, y: 20, w: 80, h: 30 });
    let shotOpts = null;
    ml.screenshot = async (_t, o) => { shotOpts = o; return "data:image/png;base64,CROP"; };   // stub the capture (no real tab in jsdom)
    const res = await ml.clickTool().run({ selector: "#b", verify: true }, visionCtx(true));
    assert.equal(typeof res, "object", "verify returns a ToolResult, not a bare string");
    assert.equal(res.image, "data:image/png;base64,CROP", "the area crop is injected as an inline image (native driver)");
    assert.equal(shotOpts && shotOpts.noOverlay, true, "the crop is CLEAN — no click-mark overlay (can't occlude the result → fewer hallucinations)");
    assert.equal(res.feedback.via, "image", "feedback provenance is image");
    assert.match(res.content, /CENTRE of this crop/i, "the note says the target is dead-centre (no drawn box)");
    assert.match(res.content, /look\(\{ selector: "@pt:/, "and offers a look() on the point for the exact click box");
    assert.match(res.content, /Clicked/, "the base click result is still there");
});

test("click verify (text-only driver): describes the CLEAN crop via the reader (target centred, no click-mark)", async () => {
    const { ml, document } = loadDomWorld('<button id="b">Go</button>');
    mockRect(document.getElementById("b"), { x: 10, y: 20, w: 80, h: 30 });
    ml.screenshot = async () => "data:image/png;base64,CROP";
    let asked = "";
    ml.chat = async (prompt) => { asked = prompt; return "a dropdown opened below the button"; };
    const res = await ml.clickTool().run({ selector: "#b", verify: true }, visionCtx(false));
    assert.equal(res.image, undefined, "no inline image for a text-only driver");
    assert.equal(res.feedback.via, "text", "feedback is a text description");
    assert.match(res.feedback.text, /dropdown opened/, "the reader's description rides along");
    assert.match(asked, /at the exact CENTRE/i, "the describe prompt frames the target as centred (no click-mark note — there's no mark)");
    assert.doesNotMatch(asked, /added to this image BY THE TOOL/i, "no click-mark annotation note (the crop is clean)");
    assert.match(res.content, /vlm's description/i, "the content frames the reply as the reader's description");
});

test("click verify: a self-removing element is flagged MUTATED (area centered on where it was)", async () => {
    const { ml, document } = loadDomWorld('<button id="rm">X</button>');
    const b = document.getElementById("rm");
    mockRect(b, { x: 100, y: 200, w: 40, h: 20 });
    b.addEventListener("click", () => b.remove());
    ml.screenshot = async () => "data:image/png;base64,CROP";
    const res = await ml.clickTool().run({ selector: "#rm", verify: true }, visionCtx(true));
    assert.match(res.content, /GONE|page changed/i, "the removed element is flagged as mutated");
    assert.match(res.feedback.reason, /changed/i, "and the feedback reason says the target changed");
});

test("type verify: captures the WHOLE field element after typing", async () => {
    const { ml, document } = loadDomWorld('<input id="q" type="text">');
    mockRect(document.getElementById("q"), { x: 5, y: 5, w: 200, h: 24 });
    ml.screenshot = async () => "data:image/png;base64,CROP";
    const res = await ml.typeTool().run({ selector: "#q", text: "hello", verify: true }, visionCtx(true));
    assert.equal(res.image, "data:image/png;base64,CROP", "a crop of the whole field is injected");
    assert.match(res.content, /after you typed it/i, "verify now shows the whole selector element, not a point crop");
    assert.match(res.content, /Value now: "hello"/, "the base type result is still there");
});

test("verify without a vision model → no capture, an honest note (never crashes)", async () => {
    const { ml, document } = loadDomWorld('<button id="b">Go</button>');
    mockRect(document.getElementById("b"), { x: 10, y: 20, w: 80, h: 30 });
    const res = await ml.clickTool().run({ selector: "#b", verify: true }, { driverSees: false, visionModel: null, hasTool: () => false });
    const s = typeof res === "string" ? res : res.content;
    assert.match(s, /no vision model/i, "notes that verify couldn't run — no image/describe attempted");
});

test("wait verify (vision driver): folds a settled-VIEWPORT screenshot in (area-first, not the waited element)", async () => {
    const { ml, document } = loadDomWorld('<div id="x">here</div>');
    ml.screenshot = async (target) => { assert.equal(target, null, "wait verify screenshots the whole VIEWPORT (null target), not a crop"); return "data:image/png;base64,VIEW"; };
    const wait = ml.domTools.find(t => t.name === "wait");
    const res = await wait.run({ selector: "#x", verify: true }, visionCtx(true));   // #x already present → appears immediately
    assert.equal(res.image, "data:image/png;base64,VIEW", "the viewport is injected as an inline image");
    assert.equal(res.feedback.via, "image");
    assert.match(res.content, /appeared/, "the base wait result is still there");
    assert.match(res.content, /viewport/i, "and the note frames it as the settled viewport");
});

test("wait verify (text-only): describes the settled viewport WITHOUT the click-mark note (no marked box)", async () => {
    const { ml } = loadDomWorld('<p>hi</p>');
    ml.screenshot = async () => "data:image/png;base64,VIEW";
    let asked = "";
    ml.chat = async (p) => { asked = p; return "the search results finished loading"; };
    const wait = ml.domTools.find(t => t.name === "wait");
    const res = await wait.run({ ms: 5, verify: true }, visionCtx(false));
    assert.equal(res.feedback.via, "text");
    assert.match(res.feedback.text, /results finished loading/);
    assert.match(res.content, /Waited 5ms/, "the base ms-wait result is still there");
    assert.doesNotMatch(asked, /click point|added to this image BY THE TOOL/i, "a viewport (unmarked) describe carries NO click-mark note");
});

test("shadow DOM: pierceClosedShadow lets the DOM tools reach a CLOSED root the document_start patch captured", () => {
    const { ml, document, window } = loadDomWorld('<button>light-only</button>');
    // Simulate shadow-patch.js (not loaded in the test harness): a CLOSED root, stashed as it's created.
    const host = document.createElement("sealed-widget");
    document.body.append(host);
    const closed = host.attachShadow({ mode: "closed" });
    closed.innerHTML = '<button class="secret" aria-label="Reveal code">x</button>';
    window.__mlClosedRoots = new WeakMap([[host, closed]]);   // what the patch's WeakMap would hold
    const desc = (sel) => { const r = run(ml, "describeElement", { selector: sel }); return String(r.content ?? r); };

    // Flag OFF (default): the closed root stays unreachable — behaviour is exactly as before the feature.
    window.__mlPierceClosed = false;
    assert.match(desc("button.secret"), /No element/, "flag off: a CLOSED root is not pierced by selector");
    assert.match(desc("sealed-widget"), /#shadow-root \(CLOSED\)/, "flag off: flagged CLOSED and steered to locate");
    assert.doesNotMatch(desc("sealed-widget"), /pierced/, "flag off: not reported as pierced");

    // Flag ON: the captured closed root becomes selector-reachable, like an open one.
    window.__mlPierceClosed = true;
    assert.match(desc("button.secret"), /button/, "flag on: a captured CLOSED root IS pierced by selector");
    const hostDesc = desc("sealed-widget");
    assert.match(hostDesc, /#shadow-root \(CLOSED, pierced\)/, "the host is flagged CLOSED, pierced");
    assert.match(hostDesc, /button/, "and its captured children are shown (not the closed-root steer)");
    assert.doesNotMatch(hostDesc, /selectors CANNOT reach/, "no unreachable steer for a pierced host");

    // interactives lists the sealed control with a `>>>` reference, and does NOT nag about a closed root.
    const inter = run(ml, "interactives", {}).content;
    assert.match(inter, /Reveal code/, "the sealed control is now listed");
    assert.match(inter, /sealed-widget >>> button/, "referenced with a shadow-crossing `>>>`");
    assert.doesNotMatch(inter, /CLOSED shadow root/, "no unreachable-closed-root disclaimer for a pierced root");

    // The `>>>` reference re-resolves back INTO the captured closed root (click/type/describeElement can use it).
    assert.match(desc("sealed-widget >>> button.secret"), /button/, "a `>>>` reference resolves into the captured closed root");

    // Orientation: pageInfo now counts it as reachable, not an unreachable closed/empty root.
    assert.doesNotMatch(String(run(ml, "pageInfo", {})), /closed\/empty root/, "pageInfo no longer reports it as unreachable-closed");
});

test("interactives: a control is findable by its PLACEHOLDER even when the accessible name differs (Gemini)", () => {
    // Gemini's box: aria-label "Enter a prompt for Gemini" (the accessible name) but data-placeholder
    // "Ask Gemini" (what's on screen). A search by what the model SEES must still match.
    const { ml } = loadDomWorld('<div contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini" data-placeholder="Ask Gemini"></div>');
    const byPlaceholder = run(ml, "interactives", { contains: "Ask Gemini" });
    assert.match(byPlaceholder.content, /Enter a prompt for Gemini/, "found via the placeholder");
    assert.match(byPlaceholder.content, /placeholder "Ask Gemini"/, "the placeholder is shown next to the accessible name");
    assert.match(run(ml, "interactives", { contains: "Enter a prompt" }).content, /Enter a prompt for Gemini/, "the aria-label still matches too");
});

test("interactives: a FILLED field is findable by its current typed content", () => {
    // Placeholder gone (there's text), aria-label present → find it by what's typed.
    const { ml } = loadDomWorld('<div contenteditable="true" role="textbox" aria-label="Message">Hello from the automation agent</div>');
    assert.match(run(ml, "interactives", { contains: "Hello from the automation" }).content, /\[textbox\] "Message"/, "matched by typed content despite the name being the aria-label");
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

test("findByText/interactives hint at exec composition ONLY when exec is wired (ctx.hasTool)", () => {
    const { ml } = loadDomWorld('<button aria-label="Delete">x</button><p>hello there</p>');
    const withExec = { hasTool: (n) => n === "exec", tools: ["exec"], model: null, capabilities: null };
    const noExec = { hasTool: () => false, tools: [], model: null, capabilities: null };
    const fbt = ml.domTools.find(t => t.name === "findByText");
    assert.match(String(fbt.run({ text: "hello" }, withExec).content), /compose it in a read-only exec survey[\s\S]*ml\.a11y/, "exec wired → the compose hint (smart models can act on it)");
    assert.doesNotMatch(String(fbt.run({ text: "hello" }, noExec).content), /read-only exec survey/, "no exec → no hint (weaker models just keep calling the tool)");
    const inter = ml.domTools.find(t => t.name === "interactives");
    assert.match(String(inter.run({}, withExec).content), /ml\.a11y\(el\)/, "interactives hints too when exec is wired");
});

test("describeElement describes the first match (+ node) and handles bad input", () => {
    const { ml } = loadDomWorld('<div class="card" data-id="7"><span>hi</span></div>');
    const res = run(ml, "describeElement", { selector: ".card", depth: 0 });
    assert.ok(res.content.startsWith('div.card [data-id="7"]'));
    assert.equal(res.elements[0].tagName, "DIV");
    assert.match(run(ml, "describeElement", { selector: "((" }), /Invalid selector/);
    assert.match(run(ml, "describeElement", { selector: ".nope" }), /No element matches/);
    // A single-element tool warns when the selector was ambiguous (used the first of N).
    const { ml: ml2 } = loadDomWorld('<div class="row">a</div><div class="row">b</div><div class="row">c</div>');
    assert.match(run(ml2, "describeElement", { selector: ".row" }).content, /matched 3 elements — using the FIRST/);
    assert.match(run(ml2, "ancestors", { selector: ".row" }).content, /matched 3 elements — using the FIRST/);
    assert.doesNotMatch(run(ml, "describeElement", { selector: ".card" }).content, /matched/); // unique → no note
});

test("selectorError hints at :contains ONLY when the error is actually about the pseudo", () => {
    // Pure function. The engine handles :contains/:has-text/:eq ANYWHERE now, so they're never the cause
    // of a queryAll throw — a thrown error is a genuine CSS problem. selectorError keys off the ERROR
    // MESSAGE, not the selector text.
    const { ml } = loadDomWorld("<button>8</button>");
    // Real cause is the unescaped Tailwind `/`, not the (now-supported) :contains → surface it raw.
    const cssErr = new Error("'button.border-gray-100/30' is not a valid selector");
    const trailing = ml._selectorError('button.border-gray-100/30:contains("8")', cssErr);
    assert.match(trailing, /is not a valid selector/);
    assert.ok(!/ml\.queryAll/.test(trailing), "a native CSS error must not be misblamed on the pseudo");
    // A raw document.querySelector that choked ON the pseudo (message mentions it) → the queryAll hint.
    const pseudoErr = new Error(`'div:contains("x")' is not a valid selector`);
    assert.match(ml._selectorError('div:contains("x") > span', pseudoErr), /ml\.queryAll/);
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

test("sampleText pipe: scans the sampled lines through the grep/sort pipeline", () => {
    const { ml } = loadDomWorld("<p>Apple</p><p>banana</p><p>apple pie</p><p>Cherry</p><p>banana split</p>");
    const tool = ml.domTools.find(t => t.name === "sampleText");
    const res = tool.run({ selector: "p", n: 10, pipe: "grep -i banana | wc -l" });
    assert.match(res.content, /^2/, "counts the sampled lines matching (case-insensitive)");
    assert.match(res.content, /piped through `grep -i banana \| wc -l`/, "notes the pipe");
    // A bad command → an actionable error; the exec suggestion is gated on exec being wired.
    const err = tool.run({ selector: "p", n: 10, pipe: "sed x" }, { hasTool: (n) => n === "exec" });
    assert.match(String(err), /Pipe error.*not a real shell.*use exec/is);
});

test("exec on a strict page (CSP / Trusted-Types block) → signals cdpExec with the SOURCE, not a plain error", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    // Main-world eval REFUSED by the page CSP (Chrome's real message). The tool must escalate: hand back a
    // cdpExec signal carrying the source so the background can re-run it via the debugger (CSP-exempt).
    const js = 'throw new Error("Refused to evaluate a string as JavaScript because unsafe-eval is not an allowed source")';
    const r = await exec.run({ js });
    assert.equal(typeof r, "object", "returns a ToolResult (with the signal), not a bare error string");
    assert.deepEqual(r.cdpExec, { source: js }, "carries the SOURCE for the background to re-run via CDP");
    assert.match(r.content, /blocks main-world eval|CSP|Trusted Types/i, "the base content explains the eval was blocked");
    // A GENUINE code error is NOT escalated to the debugger — no cdpExec.
    const g = await exec.run({ js: "nope()" });
    assert.ok(!(g && typeof g === "object" && g.cdpExec), "a normal error stays a normal error (never escalates)");
});

test("exec evaluates expressions, serializes objects, and catches errors", async () => {
    const { ml } = loadDomWorld("<li></li><li></li>");
    assert.equal(await execText(ml, { js: "1 + 2" }), "3");
    assert.equal(await execText(ml, { js: "document.querySelectorAll('li').length" }), "2");
    assert.equal(await execText(ml, { js: "({a:1})" }), '{"a":1}');
    assert.equal(await execText(ml, { js: "Promise.resolve(42)" }), "42"); // thenable awaited
    assert.match(await execText(ml, { js: "nope()" }), /^Error:/);
    // Top-level await + return (async-function fallback when eval rejects them).
    assert.equal(await execText(ml, { js: "return await Promise.resolve(7)" }), "7");
    assert.equal(await execText(ml, { js: "const x = await Promise.resolve(5); return x * 2" }), "10");
    // A bare top-level-await EXPRESSION keeps the REPL trailing-value convention (no
    // explicit `return`) — the async fallback used to drop it and answer undefined.
    assert.equal(await execText(ml, { js: "await Promise.resolve(9)" }), "9");
    assert.equal(await execText(ml, { js: "await Promise.all([Promise.resolve(1), Promise.resolve(2)]).then(([a, b]) => ({ a, b }))" }), '{"a":1,"b":2}');
    assert.equal(await execText(ml, { js: "await Promise.resolve(4);" }), "4"); // trailing ; tolerated
    assert.match(await execText(ml, { js: "return (" }), /^Error:/); // genuine syntax error still reported
    // Multi-line console output keeps its newlines — separate console.log calls
    // join with \n, and the length cap must NOT collapse whitespace (regression:
    // exec used dom.ts `truncate`, whose \s+→" " flattened every line into spaces).
    const multi = await execText(ml, { js: "for (let i = 1; i <= 3; i++) console.log('line ' + i);" });
    assert.match(multi, /^console:\nline 1\nline 2\nline 3\n\nvalue: /);
    // The #1 exec mistake: .map on a raw NodeList → steer to Array.from/spread.
    const nodelist = await execText(ml, { js: "document.querySelectorAll('li').map(x => x.tagName)" });
    assert.match(nodelist, /is not a function/);
    assert.match(nodelist, /NodeList\/HTMLCollection, not an Array/);
    // A non-DOM "not a function" must NOT get the NodeList hint (false-positive guard).
    assert.doesNotMatch(await execText(ml, { js: "(42).map(x => x)" }), /NodeList/);
    // A runaway result is capped so it can't flood context — with a "[+N chars truncated]"
    // count (the model knows it's a prefix). 600 'x' → 500 kept + 100 dropped.
    const big = await execText(ml, { js: "'x'.repeat(600)" });
    assert.match(big, /^x{500}… \[\+100 chars truncated\]$/);
});

test("exec: `maxChars` raises the per-call output cap (post-approval), clamped to the ceiling", async () => {
    const { ml } = loadDomWorld();
    // Default 500 → 600 'x' clips to 500. With a raise + reason, the same output survives to 4000.
    assert.match(await execText(ml, { js: "'x'.repeat(600)", maxChars: 4000, maxCharsReason: "need it all" }), /^x{600}$/);
    // A value past the 8000 ceiling is clamped, and the clamp is disclosed to the model.
    const clamped = await execText(ml, { js: "'x'.repeat(9000)", maxChars: 100000, maxCharsReason: "y" });
    assert.match(clamped, /x{8000}… \[\+1000 chars truncated\]/);
    assert.match(clamped, /clamped to 8000 chars/i, "the model is told its raise was clamped");
    // A SMALLER cap is honored too (no gate needed for that).
    assert.match(await execText(ml, { js: "'x'.repeat(600)", maxChars: 100 }), /^x{100}… \[\+500 chars truncated\]$/);
});

test("exec: `state` persists across calls (the page-kernel scratchpad) + ml.state is the same object", async () => {
    const { ml } = loadDomWorld();
    // Stash on the first call (fast path), read it back on the second — the Jupyter/kernel paradigm.
    await execText(ml, { js: "state.count = (state.count || 0) + 41" });
    assert.equal(await execText(ml, { js: "state.count + 1" }), "42", "state survives between exec calls");
    // The async path (top-level await → AsyncFunction) sees the SAME state.
    assert.equal(await execText(ml, { js: "await Promise.resolve(state.count)" }), "41", "the async path shares state too");
    // ml.state is the very same object (console/agent parity) and is a getter (can't be reassigned).
    assert.equal(ml.state.count, 41, "ml.state exposes the same scratchpad");
    assert.throws(() => { "use strict"; ml.state = {}; }, "ml.state is getter-only — can't be clobbered");
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

test("answer tool curates the answer set (add element/text, remove, clear)", async () => {
    // `answer` needs a ToolContext carrying the run's AnswerSet (the loop provides it). It screenshots each
    // element for the HUD card — best-effort, absent in jsdom, so only content/elements/set are asserted.
    const { AnswerSet } = require("../src/answer-set.ts");
    const { ml } = loadDomWorld('<div id="banner">Ad</div><p class="x">a</p><p class="x">b</p>');
    const set = new AnswerSet();
    const ctx = { answer: set, hasTool: () => false, tools: [], model: null, capabilities: null, driverSees: false, visionModel: null };
    const call = (args) => ml.domTools.find(t => t.name === "answer").run(args, ctx);

    const one = await call({ selector: "#banner", note: "the banner" });
    assert.match(one.content, /added 1 element.*the banner/i);
    assert.equal(one.elements[0].id, "banner");
    assert.equal(one.answerManaged, true, "the built-in answer tool self-manages the set");
    assert.equal((await call({ selector: "p.x" })).elements.length, 2);
    assert.match(await call({ selector: ".nope" }), /matched nothing/);      // a miss is noted, not fatal
    assert.equal((await call({ selector: "p.x", index: 1 })).elements[0].textContent, "b");
    assert.match(await call({ selector: "p.x", index: 9 }), /matched nothing/);

    // text + selector in ONE call adds BOTH (models send them together)
    set.clear();
    const both = await call({ text: "the total is 42", selector: "#banner" });
    assert.match(both.content, /added text; added 1 element/i);
    assert.deepEqual(set.items.map(i => i.kind), ["text", "element"]);

    // no-op echo shows the set; clear empties it
    assert.match(await call({}), /the total is 42/);
    await call({ clear: true });
    assert.equal(set.length, 0, "clear empties the set");
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
    const res = await execText(ml, { js: "console.log('hello', 42); 'done'" });
    assert.match(res, /console:\nhello 42/);
    assert.match(res, /value: done/);
});

test("exec returns console output even when the expression evaluates to undefined", async () => {
    // The pattern the model reached for: forEach + console.log (value is undefined).
    const { ml } = loadDomWorld("<li>a</li><li>b</li>");
    const res = await execText(ml, {
        js: "document.querySelectorAll('li').forEach((el,i) => console.log(i, el.textContent))"
    });
    assert.match(res, /0 a/);
    assert.match(res, /1 b/);
    assert.match(res, /value: \(undefined\)/);
});

test("exec: a STRING rejection (a failed ml.* call) surfaces the real message, not 'Error: undefined'", async () => {
    // makeBackgroundTaskPromise rejects with a STRING (the actionable message); exec used `.message` (undefined
    // for a string) → the useless "Error: undefined". errText handles both.
    const { ml } = loadDomWorld("");
    const r = await run(ml, "exec", { js: "throw 'Could not fetch — redirect loop at github.com'" });
    const out = typeof r === "string" ? r : (r?.content ?? String(r));
    assert.match(out, /redirect loop at github\.com/, "the thrown string IS the message");
    assert.doesNotMatch(out, /Error: undefined/, "not the useless placeholder");
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

// A model that runs `toolName` (opting into a token) then CITES the minted id in its reply — exactly what a real
// model does after reading the `@tool:<id>` line off the tool result. Used to exercise the cited → res.outputs
// path. There is NO auto-fallback, so an output reaches the answer ONLY when the model cites it like this.
const citeToolOutput = (toolName, id = "c1") => {
    let turn = 0;
    return (m) => {
        if (m.type === "GET_CONFIG" || m.type === "MODEL_CAPS") return undefined;
        if (++turn === 1) return { data: toolCall(toolName, { token: true }, id) };
        const tm = (m.payload?.messages || []).find((x) => x.tool_call_id === id);
        const tid = String(tm?.content || "").match(/@tool:([0-9a-f]{7})/)?.[1] || "000000";
        return { data: reply(`The result: ![out](@tool:${tid}:out).`) };
    };
};

test("createAgent: a 2nd run CONTINUES the session (agent-say, not a fresh `agent`) even when messages didn't sync — cancel-then-resume wipe fix", async () => {
    // Regression (DevTools/background path): a CANCELLED turn never syncs control.messages back, so the handle
    // keeps its hash but an EMPTY message list. The next run must still be a CONTINUATION (`agent-say`) —
    // keying firstTurn off control.messages re-announced `agent`, whose onDebug handler REPLACES the sidebar
    // session, wiping the whole history. We reproduce the not-synced state by clearing a.messages between runs.
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("turn one"), reply("turn two")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));

    const a = world.ml.createAgent({ tools: [], maxSteps: 3 });
    await a.run("first task");
    a.messages = [];                 // the cancel-not-synced condition: hash retained, history gone
    await a.run("second task");

    const starts = events.filter(e => e.kind === "agent");
    assert.equal(starts.length, 1, "only the FIRST run announces `agent` — a 2nd would WIPE the sidebar session");
    assert.ok(events.some(e => e.kind === "agent-say" && e.text === "second task"), "the 2nd run is a continuation `agent-say`");
    assert.equal(starts[0].session.hash, a.hash, "both turns share the one session hash");
});

test("agent runs a tool, feeds the result back, and stops on a plain reply", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([toolCall("ping", { x: 1 }, "c1"), reply("done: pinged once")])
    });
    const ping = world.ml.defineTool({ name: "ping", run: ({ x }) => `pong${x}` });
    const res = await world.ml.agent("do it", { tools: [ping], maxSteps: 5 });

    assert.equal(res.summary, "done: pinged once");
    assert.equal(res.steps, 1);
    assert.deepEqual(res.transcript, [{ tool: "ping", arguments: { x: 1 }, result: "pong1" }, { assistant: "done: pinged once" }]);
    // Second turn carried the assistant tool_calls and the tool result back.
    const sent = world.runtimeCalls[1].payload.messages;
    assert.equal(sent.at(-2).tool_calls[0].name, "ping");
    assert.deepEqual(sent.at(-1), { role: "tool", tool_call_id: "c1", content: "pong1" });
});

test("toolTokens: opt-in — a token is minted ONLY when the model sets token:true, and only when enabled", async () => {
    // OPT-IN: the loop mints a token for a call ONLY when the model passed `token:true` on it (so it isn't
    // spammed with tokens on every exec/inspection call). `wants` asks; `skip` doesn't; a token line appears
    // solely on `wants`.
    const script = () => scriptedModel([toolCall("wants", { token: true }, "c1"), toolCall("skip", {}, "c2"), reply("done")]);
    const tool = (name) => ({ name, run: () => "a computed result" });

    // ON: the opted-in call carries a copyable @tool:<id>:out; the one that didn't ask doesn't.
    let world = loadPageWorld({ onRuntimeMessage: script() });
    await world.ml.agent("t", { tools: [world.ml.defineTool(tool("wants")), world.ml.defineTool(tool("skip"))], toolTokens: true });
    let msgs = world.runtimeCalls.at(-1).payload.messages;
    assert.match(msgs.find(m => m.tool_call_id === "c1").content, /@tool:[0-9a-f]{7}:out/, "the opted-in call gets a token");
    assert.doesNotMatch(msgs.find(m => m.tool_call_id === "c2").content, /@tool:/, "a call that didn't ask gets none");

    // OFF (default): no token line even on the opted-in call — a normal run is byte-identical.
    world = loadPageWorld({ onRuntimeMessage: script() });
    await world.ml.agent("t", { tools: [world.ml.defineTool(tool("wants")), world.ml.defineTool(tool("skip"))] });
    msgs = world.runtimeCalls.at(-1).payload.messages;
    assert.doesNotMatch(msgs.find(m => m.tool_call_id === "c1").content, /@tool:/, "tokens off by default");
});

test("toolTokens: an ERROR result gets NO token, even when the model opted in (nothing to cite)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("boom", { token: true }, "c1"), reply("done")]) });
    // The model asked for a token, but the call FAILED — a failed call has nothing worth citing.
    const boom = world.ml.defineTool({ name: "boom", run: () => "Error: '\"table#sales\"' is not a valid selector." });
    await world.ml.agent("t", { tools: [boom], toolTokens: true });
    const msg = world.runtimeCalls.at(-1).payload.messages.find(m => m.tool_call_id === "c1");
    assert.match(msg.content, /not a valid selector/, "the error still reaches the model");
    assert.doesNotMatch(msg.content, /@tool:/, "but no token is minted for a failed call");
});

test("toolTokens: a DENIED opted-in call mints NO token (the tool never ran → nothing to cite, nothing auto-appended)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("danger", { token: true }, "c1"), reply("done")]) });
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => "did it" });
    const res = await world.ml.agent("t", { tools: [danger], toolTokens: true, approve: () => false });
    const msg = world.runtimeCalls.at(-1).payload.messages.find(m => m.tool_call_id === "c1");
    assert.match(msg.content, /Denied/, "the denial reaches the model");
    assert.doesNotMatch(msg.content, /@tool:/, "no token minted for a denied call");
    assert.ok(!res.answer || !/@tool:/.test(res.answer), "and nothing auto-appended to the answer");
});

test("toolTokens: a CANCELLED opted-in gate mints NO token, and nothing is auto-appended", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("danger", { token: true }, "c1"), reply("done")]) });
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => "did it" });
    const res = await world.ml.agent("t", { tools: [danger], toolTokens: true, approve: () => ({ cancelled: true }) });
    // Whether the gate routes as cancel or deny, the invariant is the same: the tool didn't run, so no token.
    const msg = world.runtimeCalls.at(-1).payload.messages.find(m => m.tool_call_id === "c1");
    assert.doesNotMatch(msg?.content || "", /@tool:/, "no token minted for a cancelled/denied gate");
    assert.ok(!res.answer || !/@tool:/.test(res.answer), "no token auto-appended either");
});

test("toolTokens: a logged-THEN-errored exec mints NO token — the Error is detected past the console prefix", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("exec", { token: true }, "c1"), reply("done")]) });
    // exec prepends captured console output, so a failed run is `console:\n…\n\nError: …` — NOT starting with "Error:".
    const ex = world.ml.defineTool({ name: "exec", run: () => "console:\nchecking rows\n\nError: rows is not defined" });
    const res = await world.ml.agent("t", { tools: [ex], toolTokens: true });
    const msg = world.runtimeCalls.at(-1).payload.messages.find(m => m.tool_call_id === "c1");
    assert.doesNotMatch(msg.content, /@tool:/, "no token — the Error after the console output is still detected");
    assert.ok(!res.answer || !/@tool:/.test(res.answer), "and nothing auto-appended");
});

test("toolTokens: an opted-in python_exec that ERRORS mints NO token — even when a note PREFIXES the error string", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("python_exec", { token: true }, "c1"), reply("done")]) });
    // The content has a table-note PREFIX, so it doesn't start with "Python error:"; the failure is detected via
    // the python render's own `error` flag instead (robust to any prefix). A failed step mints no token, so the
    // model never even sees a `@tool:` line to cite — an errored computation can't reach the answer.
    const py = world.ml.defineTool({ name: "python_exec", run: () => ({ content: "note: >1 table matched\n\nPython error: NameError: x", render: { type: "python-out", error: "NameError: x" } }) });
    const res = await world.ml.agent("t", { tools: [py], toolTokens: true });
    const msg = world.runtimeCalls.at(-1).payload.messages.find(m => m.tool_call_id === "c1");
    assert.doesNotMatch(msg.content, /@tool:/, "no token for a failed python run (caught by the render's error flag)");
    assert.ok(!res.answer || !/@tool:/.test(res.answer), "and no auto-append of the errored computation");
});

test("toolTokens OFF (default): NO `token` param on any tool schema, and NO token guidance in the system prompt", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const py = world.ml.defineTool({ name: "python_exec", run: () => "x" });
    const ex = world.ml.defineTool({ name: "exec", run: () => "x" });
    await world.ml.agent("t", { tools: [py, ex] });   // toolTokens off (default)
    const payload = world.runtimeCalls.find(c => c.payload && c.payload.tools).payload;
    for (const t of payload.tools) assert.ok(!t.function.parameters?.properties?.token, `${t.function.name} must NOT expose a token param when tokens are off`);
    const sys = payload.messages.find(m => m.role === "system")?.content || "";
    assert.doesNotMatch(sys, /@tool:|SHOWING TOOL OUTPUTS/, "no token-feature text in the system prompt when off");
});

test("toolTokens ON: the CITABLE tools expose a `token` param + the system prompt carries the clause", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const py = world.ml.defineTool({ name: "python_exec", run: () => "x" });
    await world.ml.agent("t", { tools: [py], toolTokens: true });
    const payload = world.runtimeCalls.find(c => c.payload && c.payload.tools).payload;
    const pyTool = payload.tools.find(t => t.function.name === "python_exec");
    assert.ok(pyTool.function.parameters.properties.token, "python_exec exposes the token param when on");
    assert.match(payload.messages.find(m => m.role === "system").content, /SHOWING TOOL OUTPUTS/, "the clause is in the prompt when on");
});

test("toolTokens OFF: passing token:true is a harmless NO-OP (no token minted, no outputs)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("python_exec", { token: true }, "c1"), reply("done")]) });
    const py = world.ml.defineTool({ name: "python_exec", run: () => ({ content: "df", render: { type: "python-out", df: { columns: ["x"], rows: [[1]] } } }) });
    const res = await world.ml.agent("t", { tools: [py] });   // OFF — token:true is just an unknown arg
    const msg = world.runtimeCalls.at(-1).payload.messages.find(m => m.tool_call_id === "c1");
    assert.doesNotMatch(msg.content, /@tool:/, "token:true is ignored when the feature is off — no @tool line");
    assert.ok(!res.outputs, "no structured outputs when off");
});

test("res.outputs: a CITED DataFrame comes back as a { kind:'table', columns, rows } 2D matrix (headless scripting)", async () => {
    // The model runs python_exec (opting in) then CITES the minted token in its reply — so finalizeAnswer keeps the
    // citation and res.outputs hands the CALLER the real 2D data, not a `[caption](@tool:…)` markdown string.
    const world = loadPageWorld({ onRuntimeMessage: citeToolOutput("python_exec") });
    const py = world.ml.defineTool({ name: "python_exec", run: () => ({ content: "a DataFrame", render: { type: "python-out", df: { columns: ["Rep", "Total"], rows: [["Gia", 850], ["Kim", 810]] } } }) });
    const res = await world.ml.agent("t", { tools: [py], toolTokens: true });
    assert.ok(res.outputs && res.outputs.length === 1, "one structured output on the result");
    assert.equal(res.outputs[0].kind, "table");
    assert.deepEqual(res.outputs[0].columns, ["Rep", "Total"]);
    assert.deepEqual(res.outputs[0].rows, [["Gia", 850], ["Kim", 810]], "the DataFrame is handed back as a 2D matrix");
});

test("res.outputs: an UNCITED computation is NOT surfaced — no auto-promotion into the answer or outputs", async () => {
    // The invariant the user asked for: a python_exec scratchpad calc the model NEVER cited must not be promoted to
    // a user-facing Result. The model just answers in prose → the bottom answer is empty AND res.outputs is absent,
    // even though a token was minted for the step (a real model would have to `![…](@tool:…)` it to surface it).
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("python_exec", {}, "c1"), reply("The top rep is Gia with 850.")]) });
    const py = world.ml.defineTool({ name: "python_exec", run: () => ({ content: "a DataFrame", render: { type: "python-out", df: { columns: ["Rep", "Total"], rows: [["Gia", 850], ["Kim", 810]] } } }) });
    const res = await world.ml.agent("t", { tools: [py], toolTokens: true });
    assert.ok(!res.answer || !/@tool:/.test(res.answer), "nothing auto-appended to the bottom answer");
    assert.ok(!res.outputs, "no structured outputs when the model cited nothing");
});

test("toolTokens: a MULTI-TURN run mints DISTINCT ids per turn (no cross-turn collision → a citation resolves to the RIGHT step)", async () => {
    // Regression: the loop restarts `seq` at 0 each turn, so turn 2's step-1 python_exec and turn 1's step-1
    // python_exec both minted toolToken(runHash, 1) — the SAME id. A citation of turn 2's id then resolved to
    // turn 1's (earlier) step. The fix seeds the id from the GLOBAL seq (control.seqBase + per-turn seq).
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([
        toolCall("python_exec", {}, "c1"), reply("turn one"),
        toolCall("python_exec", {}, "c2"), reply("turn two"),
    ]) });
    const win = world.context.window;
    const tokens = [];
    win.addEventListener("message", (e) => { const ev = e.data && e.data.__mlDebug; if (ev && ev.kind === "agent-step" && ev.token) tokens.push(ev.token); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const py = world.ml.defineTool({ name: "python_exec", run: () => ({ content: "df", render: { type: "python-out", df: { columns: ["x"], rows: [[1]] } } }) });
    const a = world.ml.createAgent({ maxSteps: 4, vision: false, tools: [py], toolTokens: true });
    await a.run("first");
    await a.run("second");
    await new Promise(r => setTimeout(r, 0));
    assert.equal(tokens.length, 2, "both citable python_exec steps minted a token");
    assert.equal(new Set(tokens).size, 2, "the two turns' tokens are DISTINCT (no cross-turn collision)");
});

test("res.outputs: OFF (no tokens) → no outputs; a plain run is unchanged", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("python_exec", {}, "c1"), reply("done")]) });
    const py = world.ml.defineTool({ name: "python_exec", run: () => ({ content: "df", render: { type: "python-out", df: { columns: ["x"], rows: [[1]] } } }) });
    const res = await world.ml.agent("t", { tools: [py] });   // toolTokens off (default)
    assert.ok(!res.outputs, "no structured outputs when the feature is off");
});

test("answer(selector) ≡ ml.queryAll(selector): the designated nodes are EXACTLY the selector's live matches", async () => {
    // The `answer` tool's `selector` path must hand the caller the same live nodes `ml.queryAll(selector)` returns
    // in exec — so res.elements is that node set. (It literally calls queryAll, so this pins the equivalence.)
    const { ml } = loadDomWorld(`<div class="card">A</div><div class="card">B</div><p>x</p>`);
    const set = new AnswerSet();
    const answer = ml.domTools.find(t => t.name === "answer");
    await answer.run({ selector: ".card" }, { answer: set });
    const expected = ml.queryAll(".card");
    assert.equal(expected.length, 2, "sanity: two .card nodes");
    assert.deepEqual(set.elements(), expected, "res.elements would be EXACTLY ml.queryAll('.card')");
});

test("autoApproveSelfSource: an uncredentialed read of the OWN repo source auto-approves; an issue / OFF gates", async () => {
    // The repo is BUILD_INFO.repoUrl (parawanderer/window-ml). A raw committed file auto-approves when the flag
    // is on; a user-prose endpoint (an issue) always gates; and the flag OFF gates even the source read.
    const SELF = "https://raw.githubusercontent.com/parawanderer/window-ml/main/injected.ts";
    const ISSUE = "https://api.github.com/repos/parawanderer/window-ml/issues/1";
    const gateCount = async (url, selfSource) => {
        const model = scriptedModel([toolCall("fetch_url", { url }, "c1"), reply("done")]);
        let gates = 0;
        const world = loadPageWorld({
            config: { autoApproveSelfSource: selfSource },
            onRuntimeMessage: (m) => m.type === "FETCH_URL"
                ? { data: { url: m.payload.url, ok: true, status: 200, type: "text", text: "…source…" } }
                : model(m),
        });
        await world.ml.agent("read my source", { tools: [world.ml.fetchTool()], approve: () => { gates++; return true; } });
        return gates;
    };
    assert.equal(await gateCount(SELF, true), 0, "a self-repo SOURCE read auto-approves (no gate) when the flag is on");
    assert.equal(await gateCount(ISSUE, true), 1, "a self-repo ISSUE (user prose) still GATES");
    assert.equal(await gateCount(SELF, false), 1, "the flag OFF gates even the source read");
});

test("agent: a pre-aborted signal cancels before any model call (resolves, doesn't reject)", async () => {
    const ac = new AbortController();
    ac.abort();
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("should-not-run")]) });
    const res = await world.ml.agent("x", { vision: false, signal: ac.signal });
    assert.equal(res.cancelled, true);
    assert.equal(res.steps, 0);
    assert.match(res.summary, /Cancelled/);
    assert.equal(world.runtimeCalls.filter(c => c.payload && c.payload.messages).length, 0, "no model call was made");
});

test("agent: aborting mid-run stops at the next step boundary with the partial transcript + a cancelled event", async () => {
    const ac = new AbortController();
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("cut", {}, "c1"), reply("should-not-reach")]) });
    const cut = world.ml.defineTool({ name: "cut", run: () => { ac.abort(); return "snip"; } });   // abort DURING step 1
    const events = [], win = world.context.window;
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const res = await world.ml.agent("x", { tools: [cut], vision: false, signal: ac.signal });
    assert.equal(res.cancelled, true);
    assert.equal(res.steps, 1, "step 1 (the cut tool) completed; aborted before step 2's model call");
    assert.equal(res.transcript.length, 1);
    assert.equal(res.transcript[0].result, "snip");
    assert.notEqual(res.summary, "should-not-reach", "the loop never reached the model's next turn");
    assert.equal(events.find(e => e.kind === "agent-result").cancelled, true, "the agent-result debug event is marked cancelled");
});

test("agent: aborting DURING the model call rejects the fetch and resolves as cancelled (ABORT relayed)", async () => {
    const ac = new AbortController();
    let abortRelayed = false;
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_LLM") { ac.abort(); return undefined; }        // abort mid-request (before any response)
            if (m.type === "ABORT_TASK") { abortRelayed = true; return undefined; }
            return undefined;
        },
    });
    const res = await world.ml.agent("x", { vision: false, signal: ac.signal });
    await new Promise(r => setTimeout(r, 0));   // let the ABORT_REQUEST relay flush
    assert.equal(res.cancelled, true);
    assert.equal(res.steps, 0, "aborted during step 1's model call → 0 completed steps");
    assert.equal(abortRelayed, true, "an ABORT_TASK was relayed to the background to kill the in-flight fetch");
});

// ---- agent append/resume (createAgent / { resume }) ----

test("agent: result carries a session hash, and { resume } appends a follow-up turn to the SAME run", async () => {
    // Turn 1: ping → reply. Turn 2 (resumed): pong → reply. One scripted model serves both.
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([
            toolCall("ping", { x: 1 }, "c1"), reply("first answer"),
            toolCall("pong", { y: 2 }, "c2"), reply("second answer"),
        ]),
    });
    const ping = world.ml.defineTool({ name: "ping", run: () => "pinged" });
    const pong = world.ml.defineTool({ name: "pong", run: () => "ponged" });

    const first = await world.ml.agent("do the first thing", { tools: [ping, pong], maxSteps: 5, vision: false });
    assert.match(first.hash, /^[0-9a-f]{8}$/, "the result carries a git-like session hash");
    assert.equal(first.summary, "first answer");

    const second = await world.ml.agent("now the second thing", { resume: first.hash });
    assert.equal(second.hash, first.hash, "resuming keeps the SAME session hash");
    assert.equal(second.summary, "second answer");

    // The resumed turn's FIRST model call saw the FULL accumulated history: system, the first task, the
    // first tool round-trip, the first ANSWER (pushed so context survives), then the new user turn last.
    const modelCalls = world.runtimeCalls.filter(c => c.payload && c.payload.messages);
    const resumedFirst = modelCalls.find(c => c.payload.messages.at(-1).content === "now the second thing");
    assert.ok(resumedFirst, "a resumed model call has the follow-up task as its last user turn");
    const resumedMsgs = resumedFirst.payload.messages;
    assert.equal(resumedMsgs[0].role, "system");
    assert.equal(resumedMsgs[1].content, "do the first thing");
    assert.ok(resumedMsgs.some(m => m.role === "assistant" && m.content === "first answer"), "the prior answer is in the resumed context");
    // The resumed turn reused the ORIGINAL toolset (no tools passed on the resume call).
    assert.deepEqual(second.transcript, [{ tool: "pong", arguments: { y: 2 }, result: "ponged" }, { assistant: "second answer" }]);
});

test("agent: { silent } rides the run's debug config so the HUD card can stay hidden", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const events = [], win = world.context.window;
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));

    await world.ml.agent("quietly", { silent: true, vision: false });
    const start = events.find(e => e.kind === "agent");
    assert.equal(start.config.silent, true, "a silent run flags its debug config so the card suppresses itself");

    // A normal run does NOT set it (so the card behaves as usual).
    events.length = 0;
    await world.ml.agent("loudly", { vision: false });
    assert.ok(!events.find(e => e.kind === "agent").config.silent, "a normal run leaves silent unset");
});

test("agent: { unattended } refuses an approval-gated call (never prompts) and steers to read-only", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("danger", {}, "c1"), reply("ok, read-only only")]) });
    let ran = 0;
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => { ran++; return "did it"; } });
    const res = await world.ml.agent("go", { tools: [danger], unattended: true, vision: false, maxSteps: 3 });
    assert.equal(ran, 0, "the gated tool never RAN in an unattended run (refused, not executed)");
    assert.match(res.transcript[0].result, /Refused: this run is UNATTENDED/);
    // The refusal is fed back and the run continues to a read-only answer.
    assert.equal(res.summary, "ok, read-only only");
});

test("agent: { unattended } drops exec/python when their auto-approve is off, keeps non-gated tools + adds the clause", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const exec = world.ml.defineTool({ name: "exec", requiresApproval: true, run: () => "x" });
    const py = world.ml.defineTool({ name: "python_exec", requiresApproval: true, run: () => "y" });
    const safe = world.ml.defineTool({ name: "safe", run: () => "z" });   // non-gated read tool
    await world.ml.agent("go", { tools: [exec, py, safe], unattended: true, vision: false });
    const call = world.runtimeCalls.find(c => c.payload && c.payload.tools);
    const toolsSent = call.payload.tools.map(t => t.function.name);
    assert.ok(!toolsSent.includes("exec"), "exec is dropped when autoApproveReadonly is off (every call would need approval)");
    assert.ok(!toolsSent.includes("python_exec"), "python_exec is dropped when autoApprovePython is off");
    assert.ok(toolsSent.includes("safe"), "non-gated tools stay wired");
    // The system prompt tells the model upfront it's unattended.
    assert.match(call.payload.messages[0].content, /UNATTENDED/);
});

test("agent: resuming an unknown hash throws (never silently starts a fresh run)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("nope")]) });
    await assert.rejects(
        () => world.ml.agent("go", { resume: "deadbeef" }),
        /no resumable run "deadbeef"/,
    );
    assert.equal(world.runtimeCalls.filter(c => c.payload && c.payload.messages).length, 0, "no model call was made for a bad resume");
});

test("agent: step seq stays session-unique across a resume (the sidebar patches by hash+seq)", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([
            toolCall("t1", {}, "c1"), reply("a1"),
            toolCall("t2", {}, "c2"), reply("a2"),
        ]),
    });
    const t1 = world.ml.defineTool({ name: "t1", run: () => "r1" });
    const t2 = world.ml.defineTool({ name: "t2", run: () => "r2" });
    const events = [], win = world.context.window;
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));

    const first = await world.ml.agent("go", { tools: [t1, t2], vision: false, maxSteps: 5 });
    await world.ml.agent("again", { resume: first.hash });
    // The unified page loop runs runAgentLoop, whose per-step seq restarts at 0 each turn — so the page
    // must offset a resumed turn's seqs past the first turn's, or a resume would patch the wrong sidebar
    // row (both turns' seq=1 collide under the same hash). Every DONE tool-step's seq must be unique.
    const doneSeqs = events.filter(e => e.kind === "agent-step" && e.tool && !e.pending && e.seq != null).map(e => e.seq);
    assert.ok(doneSeqs.length >= 2, "both turns emitted a tool step");
    assert.equal(new Set(doneSeqs).size, doneSeqs.length, `step seqs are unique across the resume (got ${doneSeqs.join(",")})`);
});

test("createAgent: run() twice = two turns in one session; say() idle appends to history", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("hello"), reply("goodbye")]) });
    const a = world.ml.createAgent({ maxSteps: 4, vision: false });
    assert.equal(a.hash, null, "no hash until run() starts it");
    a.say("preamble");   // idle → appended straight to history (with a console note)
    assert.equal(a.messages.at(-1).content, "preamble", "say() while idle appends a user message to history");

    const r1 = await a.run("start");
    assert.match(a.hash, /^[0-9a-f]{8}$/, "run() mints the session hash");
    assert.equal(r1.summary, "hello");

    const r2 = await a.run("more");   // ANOTHER end-to-end turn, same session
    assert.equal(r2.hash, a.hash, "run() again stays in the same session");
    assert.equal(r2.summary, "goodbye");
    const last = world.runtimeCalls.filter(c => c.payload && c.payload.messages).at(-1).payload.messages;
    assert.equal(last[0].role, "system", "the system prompt heads the continued history");
    assert.ok(last.some(m => m.content === "preamble"), "the idle say() message is in the continued context");
    assert.equal(last.at(-1).content, "more", "the new turn's task is the last user message");
});

test("follow-up run: the answer set is CLEARED between turns — a 2nd turn that designates nothing carries no stale answer", async () => {
    // The purge invariant (page loop): turn 1 designates a text answer via the `answer` tool → res.answer is
    // non-empty. Turn 2 designates NOTHING; the loop clears the answer set at the turn boundary (answerSet.clear()),
    // so res.answer is empty and res.outputs absent — the prior turn's answer never bleeds into the follow-up.
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([
        toolCall("answer", { text: "the grand total is 6260" }, "a1"),
        reply("done turn one"),
        reply("just chatting now"),
    ]) });
    const a = world.ml.createAgent({ maxSteps: 4, vision: false });
    const r1 = await a.run("compute it");
    assert.match(r1.answer || "", /grand total is 6260/, "turn 1 surfaces the designated answer");
    const r2 = await a.run("thanks");
    assert.ok(!r2.answer, "turn 2 designates nothing → the prior turn's answer is cleared, not carried over");
});

test("resumeAgent: re-acquires a run's handle by hash → read messages + continue it", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("hi"), reply("again")]) });
    const a = world.ml.createAgent({ maxSteps: 4, vision: false });
    await a.run("first");   // mints the hash + registers the handle
    const hash = a.hash;

    // Re-acquire WITHOUT the original reference — the SAME live handle comes back.
    const b = world.ml.resumeAgent(hash);
    assert.equal(b.hash, hash, "resumeAgent returns the handle for that hash");
    assert.ok(b.messages.some(m => m.role === "assistant" && m.content === "hi"), "its message history is readable");

    const r = await b.run("second");   // and it can continue the SAME session
    assert.equal(r.hash, hash, "continuing via the resumed handle stays in the same session");
    assert.equal(r.summary, "again");

    assert.throws(() => world.ml.resumeAgent("deadbeef"), /No resumable agent handle/, "unknown hash throws a clear error");
});

test("createAgent: a run in flight rejects a second run(); say() mid-run STEERS (injected at the next step boundary)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("poke", {}, "c1"), reply("done")]) });
    let a, nestedErr;
    const poke = world.ml.defineTool({ name: "poke", run: () => {
        a.say("actually, also do Y");                                  // mid-run → steer (running === true)
        nestedErr = a.run("nope").then(() => null, e => e.message);    // run() while in flight → rejects
        return "poked";
    } });
    a = world.ml.createAgent({ tools: [poke], vision: false, maxSteps: 5 });
    await a.run("do X");
    assert.match(await nestedErr, /already in flight/, "run() while a loop is in flight rejects");
    // The steer must appear as a user turn BEFORE the model's next (final) call — injected at the boundary.
    const finalCall = world.runtimeCalls.filter(c => c.payload && c.payload.messages).at(-1).payload.messages;
    assert.ok(finalCall.some(m => m.role === "user" && m.content === "actually, also do Y"), "the mid-run say() was injected before the next model call");
    assert.equal(a.running, false, "running is false once the loop settles");
});

test("createAgent: cancel() mid-run, then say() + run() again works (fresh controller per run, consistent history)", async () => {
    // The bug this guards: cancel() aborts the handle's controller. If run() reused it, the NEXT run would
    // see an already-aborted signal and insta-cancel. A fresh controller per run() fixes it.
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([toolCall("stop", {}, "c1"), reply("second answer")]) });
    let a;
    const stop = world.ml.defineTool({ name: "stop", run: () => { a.cancel(); return "stopping"; } });   // cancel FROM inside the run
    a = world.ml.createAgent({ tools: [stop], vision: false, maxSteps: 5 });

    const r1 = await a.run("do X");
    assert.equal(r1.cancelled, true, "the first run cancelled mid-loop");
    assert.equal(a.running, false, "running clears after the cancel");

    a.say("actually do Z");                         // idle → appended to the (consistent) partial history
    const r2 = await a.run("continue");
    assert.notEqual(r2.cancelled, true, "the SECOND run is not stuck-cancelled by the prior abort");
    assert.equal(r2.summary, "second answer");
    // The second run continued the partial history: the cancelled turn's tool round-trip is intact (no
    // dangling tool_call), plus the post-cancel say() and the new task.
    const last = world.runtimeCalls.filter(c => c.payload && c.payload.messages).at(-1).payload.messages;
    assert.ok(last.some(m => m.role === "assistant" && m.tool_calls), "the cancelled turn's assistant tool_call survived");
    assert.ok(last.some(m => m.role === "tool" && m.content === "stopping"), "…and its tool result (history stays consistent)");
    assert.ok(last.some(m => m.content === "actually do Z"), "the post-cancel say() is in context");
    assert.equal(last.at(-1).content, "continue", "the new task is the last user turn");
});

test("createAgent: transcript ACCUMULATES across turns (whole-session actions, not just the last turn)", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: scriptedModel([
            toolCall("t1", {}, "c1"), reply("a1"),
            toolCall("t2", {}, "c2"), reply("a2"),
        ]),
    });
    const t1 = world.ml.defineTool({ name: "t1", run: () => "r1" });
    const t2 = world.ml.defineTool({ name: "t2", run: () => "r2" });
    const a = world.ml.createAgent({ tools: [t1, t2], vision: false, maxSteps: 5 });

    const tools = t => t.transcript.filter(e => e.tool).map(e => e.tool);
    const answers = t => t.transcript.filter(e => e.assistant).map(e => e.assistant);
    const r1 = await a.run("first");
    assert.deepEqual(tools(r1), ["t1"], "turn 1 reports its own action");
    assert.deepEqual(answers(r1), ["a1"], "…and its assistant answer");

    const r2 = await a.run("second");
    // The handle's transcript is the WHOLE conversation's actions AND replies — turn 2's result carries both.
    assert.deepEqual(tools(r2), ["t1", "t2"], "the tool calls accumulate across turns");
    assert.deepEqual(answers(r2), ["a1", "a2"], "the assistant answers accumulate across turns");
    // Turn 1's result object is unchanged (it was per-turn at the time) — accumulation is forward-only.
    assert.deepEqual(tools(r1), ["t1"], "an earlier turn's returned transcript isn't retroactively grown");
});

test("createAgent: run() flushes a leftover inbox steer into the history (never lost)", async () => {
    // A mid-run say() a BACKGROUND loop couldn't drain live sits in the inbox. The next run() must flush it
    // into the history so it's processed — otherwise the steer vanishes (the reported bug).
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("ok")]) });
    const a = world.ml.createAgent({ vision: false });
    a.inbox.push({ id: "sy_stuck", text: "a steer that got stuck" });   // simulate a bg mid-run say() that arrived too late to drain
    await a.run("proceed");
    assert.equal(a.inbox.length, 0, "run() drained the leftover inbox");
    const msgs = world.runtimeCalls.filter(c => c.payload && c.payload.messages).at(-1).payload.messages;
    assert.ok(msgs.some(m => m.content === "a steer that got stuck"), "the stuck steer was flushed into the run's history");
    assert.ok(msgs.some(m => m.content === "proceed"), "…alongside the run's task");
});

test("createAgent: fork() copies the history into a FRESH session, independent of the original", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("a1")]) });
    const a = world.ml.createAgent({ vision: false });
    await a.run("first");
    const b = a.fork();
    assert.equal(b.hash, null, "the fork is a NEW session (no hash until it runs)");
    assert.notEqual(b.messages, a.messages, "the fork's history is a separate array");
    assert.deepEqual(b.messages.map(m => m.content), a.messages.map(m => m.content), "the fork copies the history");
    b.messages.push({ role: "user", content: "only in b" });
    assert.ok(!a.messages.some(m => m.content === "only in b"), "mutating the fork doesn't touch the original");
});

test("createAgent: maxSteps setter updates the live cap + emits an agent-cap event for the UI", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("x")]) });
    const events = [], win = world.context.window;
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const a = world.ml.createAgent({ maxSteps: 10, vision: false });
    assert.equal(a.maxSteps, 10);
    await a.run("go");   // mints the hash so the cap event can be attributed
    a.maxSteps = 40;
    assert.equal(a.maxSteps, 40, "the setter updates the value");
    await new Promise(r => setTimeout(r, 0));   // let the posted debug event flush
    const cap = events.find(e => e.kind === "agent-cap");
    assert.ok(cap && cap.maxSteps === 40, "an agent-cap event carries the new cap for the sidebar/HUD");
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

// ─── ADVERSARIAL / red-team: the approval gate is only as trustworthy as the WORLD it runs in ───
// The agent loop + gate currently run in the page's MAIN WORLD, which a hostile page owns. These
// two tests DEMONSTRATE the resulting holes by making the undesirable thing happen (green today).
// They are the executable spec for the "background-hosted agent loop" (design A) migration: once the
// loop + gate move to the background, a page-set confirm / page-supplied approve must NOT be able to
// approve a requiresApproval tool — at that point these get INVERTED to assert `ran === false` and
// that a live sidebar decision was required. See README "Security & trust model".

// design A (SHIPPED): on a NON-whitelisted origin (pageApprovalAllowed: false) a privileged run routes
// to the unforgeable BACKGROUND gate — the page's own confirm/approve is bypassed, so the gated tool
// does NOT run off page-controlled consent. In these page-world tests the background loop isn't present,
// so START_RUN goes unanswered and the page tool is never delegated: `ran` stays false, and we can see
// the run routed by the START_RUN message. (A whitelisted origin — pageApprovalAllowed: true, the
// harness default — keeps the in-page loop the other approval tests exercise.)
test("[HOLE→design-A] a page-controlled window.confirm can NOT approve a requiresApproval tool", async () => {
    const world = loadPageWorld({ config: { pageApprovalAllowed: false }, onRuntimeMessage: scriptedModel([toolCall("danger", { js: "exfiltrate()" }, "c1"), reply("done")]) });
    world.context.window.confirm = () => true;   // a hostile page overrides the "un-disableable" native dialog
    let ran = false;
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => { ran = true; return "ran"; } });
    await world.ml.agent("x", { tools: [danger], vision: false });   // no in-page gate honours the page's confirm
    assert.equal(ran, false, "design A: a page-set confirm can't approve — the run routes to the background gate");
    assert.ok(world.runtimeCalls.some(c => c.type === "START_RUN"), "the privileged run routed to the unforgeable background gate");
});

test("[HOLE→design-A] a hostile CALLER's approve:()=>true can NOT self-approve", async () => {
    const world = loadPageWorld({ config: { pageApprovalAllowed: false }, onRuntimeMessage: scriptedModel([toolCall("danger", { js: "exfiltrate()" }, "c1"), reply("done")]) });
    let ran = false;
    const danger = world.ml.defineTool({ name: "danger", requiresApproval: true, run: () => { ran = true; return "ran"; } });
    // On a hostile page the page IS the caller of ml.agent — but a caller-supplied approve is IGNORED on a
    // non-whitelisted origin; approval requires a live, origin-authed decision at the trusted surface.
    await world.ml.agent("x", { tools: [danger], vision: false, approve: () => true });
    assert.equal(ran, false, "design A: a page-supplied approve is ignored off-whitelist — no self-approval");
    assert.ok(world.runtimeCalls.some(c => c.type === "START_RUN"), "the privileged run routed to the unforgeable background gate");
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
    const toolStep = steps.find(e => e.tool === "ping" && !e.pending);
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

test("vision override: a cloud default model declared 'yes' auto-wires look (probe can't, the setting can)", async () => {
    // caps() → null everywhere (an unprobeable cloud model). Without the override, look/locate can't wire
    // (unknown ≠ vision). The config's defaultModelVision:"yes" fills that gap for the DEFAULT model, so the
    // agent gets NATIVE eyes — the whole point: enabling a cloud model's own vision in the HUD.
    const withOverride = await agentToolNames({ config: { model: "gpt-4o", ocrModel: "", defaultModelVision: "yes" }, caps: () => null });
    assert.ok(withOverride.includes("look"), "declared-yes cloud model auto-wires look");
    const noOverride = await agentToolNames({ config: { model: "gpt-4o", ocrModel: "", defaultModelVision: "" }, caps: () => null });
    assert.ok(!noOverride.includes("look"), "without the override an unprobeable model gets no look (unknown ≠ yes)");
});

test("vision override: detection WINS for a probeable (Ollama) model — a 'yes' override can't force a text model", async () => {
    // The model IS probeable and reports NO vision → detection is authoritative, so a stray "yes" override is
    // ignored (it's flagged moot in Settings). look must NOT wire onto a text-only model.
    const names = await agentToolNames({ config: { model: "text-only", ocrModel: "", defaultModelVision: "yes" }, caps: () => ["completion"] });
    assert.ok(!names.includes("look"), "a known text-only model stays text-only despite the override");
});

test("click: an @pt point token is decoded (not treated as a CSS selector), unknown → clear error", async () => {
    const { ml } = loadDomWorld('<button>x</button>');
    // A stale/unknown token: recognised as a point (not run through queryAll), rejected clearly.
    const out = await ml.clickTool().run({ selector: "@pt:deadbeef" });
    assert.match(String(out), /Unknown point token/);
    assert.ok(!/No element matches/.test(String(out)), "not mistaken for a CSS selector");
});

test("click: an @box container token is refused (a region isn't clickable) and steers inside it", async () => {
    const { ml } = loadDomWorld('<button>x</button>');
    const out = await ml.clickTool().run({ selector: "@box:deadbeef" });
    assert.match(String(out), /container region, not a clickable point/);
    assert.match(String(out), /locate\(\{ selector: "@box:deadbeef"/);   // steers to locate INSIDE it
    assert.ok(!/No element matches/.test(String(out)), "not mistaken for a CSS selector");
});

test("locate: @box scope with an unknown token → clear 'container' error (not a CSS selector)", async () => {
    const { ml } = loadDomWorld('<div>hi</div>');
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "the toggle", selector: "@box:deadbeef" });
    assert.match(String(out), /Unknown container token/);
});

test("locate: container:true without a grounding model is refused with guidance", async () => {
    const { ml } = loadDomWorld('<div>hi</div>');
    const out = await ml.locateTool({ model: "vlm" }).run({ description: "the settings panel", container: true });
    assert.match(String(out), /container mode.*needs a grounding model/);
});

test("locate: COORDINATES in the description are caught → steer to reuse an @pt / region+grid (no vision call)", async () => {
    const { ml } = loadDomWorld('<div>hi</div>');
    const lt = ml.locateTool({ model: "vlm", groundingModel: "qwen2.5vl" });
    // The exact shape from the observed run: appearance + a baked-in "(x, y)".
    for (const desc of [
        "the red guy with a red cap. He is located around (664, 280).",
        "the star icon at 664, 280",
        "the toggle, x=664, y=280",
    ]) {
        const out = String(await lt.run({ description: desc, selector: "canvas#stage", strategy: "grounding" }));
        assert.match(out, /contains COORDINATES/, `caught for: ${desc}`);
        assert.match(out, /selector: "@pt:…", strategy: "grounding", margin: 100/, "steers to reuse an @pt with margin");
        assert.match(out, /region: "center", strategy: "grid"/, "offers the region+grid fallback");
    }
});

test("locate: coordinate-steer does NOT fire when already scoped to an @pt (that's the right call)", async () => {
    const { ml } = loadDomWorld('<div>hi</div>');
    // Scoped to an @pt already → the coords are just noise; don't block. (Unknown token errors instead.)
    const out = String(await ml.locateTool({ model: "vlm", groundingModel: "qwen2.5vl" })
        .run({ description: "the red guy around (664, 280)", selector: "@pt:deadbeef", strategy: "grounding" }));
    assert.doesNotMatch(out, /contains COORDINATES/, "already @pt-scoped → no coordinate steer");
});

test("locate: a legit description with a thousands-separated number is NOT mistaken for coordinates", async () => {
    const { ml } = loadDomWorld('<button>Buy</button>');
    // "12,345" (no space after comma) is a quantity, not a coordinate pair — must not trip the guard.
    // A missing container selector then short-circuits, proving we passed the coord check without firing it.
    const out = String(await ml.locateTool({ model: "vlm" }).run({ description: 'the "12,345 items" button', selector: "#nope" }));
    assert.doesNotMatch(out, /contains COORDINATES/, "a thousands separator isn't a coordinate");
    assert.match(out, /No element matches "#nope"/, "fell through to the normal selector path");
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
    const res = await world.ml.agent("x", { tools: [t], vision: false, navigate: false });
    return { events, res, step: events.find(e => e.kind === "agent-step" && e.tool === tool.name && !e.pending) };
}

test("a custom tool's render() emits a serializable descriptor on its step", async () => {
    const { step } = await agentDebugEvents({
        name: "stats", run: () => "3 items",
        render: () => ({ type: "table", columns: ["k", "v"], rows: [["a", 1]] })
    });
    // A tool's render() METHOD fills the In slot (a visualization of the call).
    assert.deepEqual(step.renderIn, { type: "table", columns: ["k", "v"], rows: [["a", 1]] });
    assert.ok(!step.renderOut, "the method feeds In, not Out");
});

test("a throwing/absent render() falls back to the default (never breaks the run)", async () => {
    const { res, step } = await agentDebugEvents({ name: "boom", run: () => "ok", render: () => { throw new Error("nope"); } });
    assert.equal(res.summary, "done", "run completed despite the throwing render");
    assert.ok(!step.renderIn && !step.renderOut, "no descriptor → sidebar uses the default In:/Out:");
});

test("agent auto-derives an image descriptor from a tool that returns a screenshot", async () => {
    const { step } = await agentDebugEvents({ name: "shoot", run: () => ({ content: "shot", image: "data:image/png;base64,AAA", imageLabel: "viewport" }) });
    // An auto-derived image describes the RESULT → the Out slot.
    assert.deepEqual(step.renderOut, { type: "image", src: "data:image/png;base64,AAA", label: "viewport" });
});

test("agent-start carries the resolved config (system prompt, tools, maxSteps)", async () => {
    const { events } = await agentDebugEvents({ name: "ping", run: () => "pong" });
    const start = events.find(e => e.kind === "agent");
    assert.ok(start.config, "config emitted");
    assert.match(start.config.system, /automation agent/, "the resolved system prompt");
    assert.equal(start.config.customSystem, false);
    // The config carries the FULL tool defs (name/approval/vision + description + parameter schema)
    // so the sidebar can render an expandable JSON tree of each tool.
    assert.equal(start.config.tools.length, 1);
    const [t] = start.config.tools;
    assert.equal(t.name, "ping");
    assert.equal(t.requiresApproval, false);
    assert.equal(t.vision, false);
    assert.equal(t.description, "");
    assert.deepEqual(t.parameters, { type: "object", properties: {} });
    assert.equal(start.config.maxSteps, 10);
    assert.ok(!/python_exec/.test(start.config.system), "no python_exec tool → no computation clause");
});

test("python_exec in the toolset adds the computation-delegation clause to the system prompt", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.agent("x", { tools: [world.ml.pythonTool()], vision: false });
    const sys = events.find(e => e.kind === "agent").config.system;
    assert.match(sys, /python_exec/, "the clause names the tool");
    assert.match(sys, /do NOT calculate|NEVER|deterministic/i, "and tells the model to delegate computation");
    assert.ok(!/tool \(JavaScript\)/.test(sys), "python takes precedence — not doubled with the JS-compute clause");
});

test("navigate is auto-wired by default: the tool is in the toolset + config logs navigation ON, no nav-off clause", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.agent("x", { vision: false });   // default toolset, navigation defaults ON
    const cfg = events.find(e => e.kind === "agent").config;
    assert.ok(cfg.tools.some(t => t.name === "navigate"), "the navigate tool is auto-wired into the default toolset");
    assert.equal(cfg.navigate, true, "the agent-options log records navigation ON");
    assert.ok(!/CANNOT navigate/.test(cfg.system), "no nav-off clause when navigation is enabled");
});

test("navigate: false strips the navigate tool AND appends the nav-off clause to the system prompt", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.agent("x", { vision: false, navigate: false });
    const cfg = events.find(e => e.kind === "agent").config;
    assert.ok(!cfg.tools.some(t => t.name === "navigate"), "no navigate tool when navigation is off");
    assert.equal(cfg.navigate, false, "the agent-options log records navigation OFF");
    assert.match(cfg.system, /CANNOT navigate to other pages/, "the nav-off clause tells the model it can't navigate");
});

test("_rebuildToolset reconstructs the builtin toolset from names (cross-page re-adoption)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const ml = world.ml;
    // A HUD-shaped kit: read-only DOM base + click + navigate + delegated look/locate (driverSees:false).
    const rebuild = {
        toolNames: ["findByText", "exec", "click", "navigate", "look", "locate"],
        model: "m", driverSees: false, visionModel: "vm", groundingModel: null, groundingRange: 1000, pierceClosed: false,
    };
    const names = ml._rebuildToolset(rebuild).map(t => t.name).sort();
    assert.deepEqual(names, ["click", "exec", "findByText", "locate", "look", "navigate"].sort(),
        "every named builtin is rebuilt (and nothing else)");
    // A name NOT in the run is not conjured; a native-vision run rebuilds the capture-only look.
    const nativeLook = ml._rebuildToolset({ ...rebuild, toolNames: ["look"], driverSees: true });
    assert.equal(nativeLook.length, 1);
    assert.ok(nativeLook[0].capabilities && nativeLook[0].capabilities.includes("vision"), "native look keeps the vision capability");
});

test("navigate is approval-gated and its render shows the DESTINATION url (a consent card must show WHERE)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const nav = world.ml.navigateTool({ crossOrigin: true });
    assert.equal(nav.requiresApproval, true, "navigate gates (so a cross-origin nav prompts)");
    const d = nav.render(null, { url: "https://www.google.com/search?q=cats" });
    assert.equal(d.type, "action", "an action render → the sidebar's intent sentence");
    assert.equal(d.target, "https://www.google.com/search?q=cats", "the card shows the absolute destination URL");
    // a relative URL resolves to absolute so the ORIGIN is always visible in the consent card
    assert.equal(world.ml.navigateTool().render(null, { url: "/dashboard" }).target, "https://test.example/dashboard");
});

test("exec without python_exec adds the JS-compute fallback clause", async () => {
    const world = loadPageWorld({ onRuntimeMessage: scriptedModel([reply("done")]) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    await world.ml.agent("x", { tools: [exec], vision: false });
    const sys = events.find(e => e.kind === "agent").config.system;
    assert.match(sys, /tool \(JavaScript\)/, "falls back to exec/JS as the deterministic calculator");
    assert.ok(!/python_exec/.test(sys), "no python clause when the tool isn't present");
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
    const step = events.find(e => e.kind === "agent-step" && e.tool === "grab" && !e.pending);
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
    const step = events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending);
    assert.deepEqual(step.renderIn, { type: "code", text: "1 + 1", lang: "javascript", format: true });
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
    const step = events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending);
    assert.match(step.result, /\[20,30\]/, "the interpreter actually ran it");
    assert.equal(step.approval, "readonly", "step tagged as auto-approved");
});

test("autoApproveReadonly: the agent reads its OWN setup (ml.config) with NO approval prompt", async () => {
    // "Which model am I?" is a pure read — it shouldn't cost the user an approval. The interpreter
    // hands the dialect a facade of ML_READONLY_METHODS only (see readonly-exec.test.mjs for the gate).
    const world = loadPageWorld({
        config: { model: "gemma4:31b", ocrModel: "", autoApproveReadonly: true },
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "(await ml.config()).model" }, "c1"), reply("done")]),
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => { approvals++; return true; } });
    assert.equal(approvals, 0, "a read-only ml call was auto-approved (gate never called)");
    const step = events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending);
    assert.match(step.result, /gemma4:31b/, "the await actually resolved — not a pending Promise");
    assert.equal(step.approval, "readonly", "step tagged as auto-approved");
});

test("cached ml.fetch: fetch_url prompts + caches once, then a readonly exec re-reading it AUTO-APPROVES", async () => {
    // The whole loop through the REAL code: turn 1 fetches via the `fetch_url` tool (approval → the result is
    // CACHED); turn 2's `ml.fetch(url)…` in `exec` re-reads that cached result, which the read-only dialect
    // binds to (cache-only, no egress) → it auto-approves with no prompt. The payoff Shane asked for: approve a
    // source once, then re-read/process it freely — and only ONE network fetch happens.
    const url = "https://x.test/servers.json";
    const fetchResult = { url, status: 200, ok: true, type: "json", text: '{"n":7}', json: { n: 7 } };
    const script = scriptedModel([
        toolCall("fetch_url", { url }, "c1"),
        toolCall("exec", { js: `ml.fetch(${JSON.stringify(url)}).json.n` }, "c2"),
        reply("done"),
    ]);
    const world = loadPageWorld({
        config: { model: "m", ocrModel: "", autoApproveReadonly: true },
        onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? { data: fetchResult } : script(m)),
    });
    const events = [];
    const win = world.context.window;
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    await world.ml.agent("x", { tools: [exec, world.ml.fetchTool()], vision: false, approve: () => { approvals++; return true; } });

    assert.equal(approvals, 1, "only the fetch_url prompted; the cached exec re-read was FREE (read-only)");
    assert.equal(world.runtimeCalls.filter(c => c.type === "FETCH_URL").length, 1, "fetched over the wire exactly once — the re-read hit the cache");
    const execStep = events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending);
    assert.equal(execStep.approval, "readonly", "the exec re-read auto-approved — a cached fetch is a read-only op");
    assert.match(execStep.result, /7/, "the cached JSON was actually read (.json.n === 7)");
    // TRANSPARENCY: the step reports WHICH prior grant it reused (why it didn't prompt).
    assert.deepEqual(execStep.reused, [{ kind: "fetch-url", detail: url }], "the reused cached URL is reported on the step");
});

test("fetch_url: an HTML page is auto-converted to Markdown (+ a note); format:\"html\" returns the original HTML", async () => {
    const url = "https://x.test/page.html";
    let fetchResult;
    const world = loadPageWorld({
        config: { model: "m", ocrModel: "" },
        onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? { data: fetchResult } : undefined),
    });
    await new Promise(r => setTimeout(r, 0));
    const tool = world.ml.fetchTool();
    const html = `<!doctype html><html><head><title>PAGETITLE</title><script>track()</script></head><body><nav>Menu Home</nav><h1>Hello</h1><p>World <a href="https://x.test">link</a>.</p><footer>JUNKFOOTER</footer></body></html>`;

    // Default: converted to Markdown, chrome/scripts stripped, with the "converted" note.
    fetchResult = { url, status: 200, ok: true, type: "html", contentType: "text/html", text: html };
    const out = await tool.run({ url });
    const md = typeof out === "string" ? out : out.content;
    assert.match(md, /# Hello/, "converted to a Markdown heading");
    assert.match(md, /\[link\]\(https:\/\/x\.test\)/, "link preserved");
    assert.doesNotMatch(md, /<h1>|track\(\)|JUNKFOOTER|Menu Home|PAGETITLE/, "tags + script + chrome stripped");
    assert.match(md, /converted it to Markdown/, "the conversion note is present");

    // format:"html" → the ORIGINAL markup, no conversion, no note. (Replaced `raw`, which straddled "what do
    // we fetch" and "what does the model receive"; `format` is the fetch-level half and is shared with ml.fetch.)
    const rawOut = await tool.run({ url, format: "html" });
    const rawMd = typeof rawOut === "string" ? rawOut : rawOut.content;
    assert.match(rawMd, /<h1>Hello<\/h1>/, "raw HTML preserved verbatim");
    assert.doesNotMatch(rawMd, /converted it to Markdown/, "no conversion note on an html fetch");

    // The distillation is exposed on ml.fetch's OWN result too — any caller (exec, a read-only survey) can
    // read r.markdown without re-converting; r.text still holds the raw HTML.
    const fr = await world.ml.fetch(url);
    assert.match(fr.markdown, /# Hello/, "ml.fetch attaches .markdown for HTML");
    assert.match(fr.text, /<h1>Hello<\/h1>/, ".text keeps the raw HTML");
});

test("fetch_url pipe: filters the returned text through the grep/head pipeline (+ a line-count note); a bad pipe points at exec", async () => {
    const url = "https://x.test/data.txt";
    let fetchResult;
    const world = loadPageWorld({
        config: { model: "m", ocrModel: "" },
        onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? { data: fetchResult } : undefined),
    });
    await new Promise(r => setTimeout(r, 0));
    const tool = world.ml.fetchTool();
    const body = ["price: 10", "note: hi", "price: 25", "misc", "PRICE: 5"].join("\n");
    fetchResult = { url, status: 200, ok: true, type: "text", contentType: "text/plain", text: body };

    const out = await tool.run({ url, pipe: "grep -i price | head -2" });
    const md = typeof out === "string" ? out : out.content;
    assert.match(md, /price: 10\nprice: 25/, "only the matching lines, capped by head");
    assert.doesNotMatch(md, /note: hi|misc/, "non-matching lines dropped before it reaches the model");
    assert.match(md, /piped through `grep -i price \| head -2`: 2 lines.*filtered from 5 source lines/, "the size/line footer, at the end");

    // A command outside the dialect → an actionable error. The exec escape hatch is GATED on exec being wired.
    const withExec = { hasTool: (n) => n === "exec", tools: ["exec"], model: null, capabilities: null };
    const err = await tool.run({ url, pipe: "sed 's/a/b/'" }, withExec);
    assert.match(String(err), /Pipe error/, "surfaces the interpreter error");
    assert.match(String(err), /const \{ markdown \} = await ml\.fetch/, "with exec wired → points at the exec escape hatch");
    // Without exec wired, the hint is omitted (no misleading suggestion to use a tool it doesn't have).
    const errNoExec = await tool.run({ url, pipe: "sed 's/a/b/'" }, { hasTool: () => false, tools: [], model: null, capabilities: null });
    assert.match(String(errNoExec), /not a real shell/i, "still explains the dialect");
    assert.doesNotMatch(String(errNoExec), /use exec/, "no exec suggestion when exec isn't available");

    // Grepping RAW HTML is ALLOWED — but a MINIFIED (one-line) page can't be split by line tools, so nudge.
    const minifiedHtml = "<html><body>" + "<p>x</p>".repeat(300) + "</body></html>";   // one long line, no newlines
    fetchResult = { url, status: 200, ok: true, type: "html", contentType: "text/html", text: minifiedHtml };
    const rawOut = await tool.run({ url, format: "html", pipe: "grep -c x" }, withExec);
    const rawMd = typeof rawOut === "string" ? rawOut : rawOut.content;
    assert.match(rawMd, /the source is 1 line \(minified\?\)/, "warns the raw HTML was one line");
    assert.match(rawMd, /drop "format": "html" to pipe the clean Markdown/, "nudges toward the Markdown path");
});

test("fetch_url: non-HTML content (JSON) is never converted or note-tagged", async () => {
    const url = "https://x.test/data.json";
    const world = loadPageWorld({
        config: { model: "m", ocrModel: "" },
        onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? { data: { url, status: 200, ok: true, type: "json", text: '{"n":7}', json: { n: 7 } } } : undefined),
    });
    await new Promise(r => setTimeout(r, 0));
    const out = await world.ml.fetchTool().run({ url });
    const s = typeof out === "string" ? out : out.content;
    assert.doesNotMatch(s, /converted it to Markdown/, "JSON isn't HTML → no conversion");
    assert.match(s, /"n": 7/, "the JSON body is returned as-is");
});

test("autoApproveReadonly: a MUTATING ml call (setModel) still goes through the approval gate", async () => {
    const world = loadPageWorld({
        config: { model: "gemma4:31b", ocrModel: "", autoApproveReadonly: true },
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "await ml.setModel('other')" }, "c1"), reply("ok, stopped")]),
    });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    // Denied, so the eval path never runs it either — the point is that it REACHED the human.
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => { approvals++; return false; } });
    assert.equal(approvals, 1, "setModel isn't on the read-only facade → normal approval");
});

test("autoApproveReadonly: an out-of-dialect exec still goes through the approval gate", async () => {
    const world = loadPageWorld({
        config: { model: "", ocrModel: "", autoApproveReadonly: true },
        // A C-style for loop is NOT in the read-only dialect (only for…of is) → it must still gate.
        onRuntimeMessage: scriptedModel([toolCall("exec", { js: "for (let i = 0; i < 1; i++) { i }" }, "c1"), reply("done")]),
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const exec = world.ml.domTools.find(t => t.name === "exec");
    let approvals = 0;
    await world.ml.agent("x", { tools: [exec], vision: false, approve: () => { approvals++; return true; } });
    assert.equal(approvals, 1, "the C-style for loop isn't in the read-only dialect → normal approval");
    assert.equal(events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending).approval, "user", "tagged approved-by-user");
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
    assert.equal(events.find(e => e.kind === "agent-step" && e.tool === "exec" && !e.pending).approval, "denied");
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

// Combined backend: the scripted model turns + a stubbed PYTHON_EXEC that records the
// payload (so tests can assert the `hardened` flag) and returns a fixed result.
const pyBackend = (turns, onPy) => {
    const model = scriptedModel(turns);
    return (m) => {
        if (m.type === "PYTHON_EXEC") { if (onPy) onPy(m.payload); return { data: { ok: true, value: [5, 6], stdout: "hi\n" } }; }
        if (m.type === "FETCH_SHEET") return { data: { csv: "a,b\n1,2\n", name: null } };
        return model(m);
    };
};
const runPyAgent = async ({ config, code, args = {}, approve }) => {
    let pyPayload = null;
    const world = loadPageWorld({
        config: { model: "", ocrModel: "", ...config },
        onRuntimeMessage: pyBackend([toolCall("python_exec", { code, ...args }, "c1"), reply("done")], p => (pyPayload = p)),
    });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    let approvals = 0;
    await world.ml.agent("x", { tools: [world.ml.pythonTool()], vision: false, approve: () => { approvals++; return approve ? approve() : true; } });
    return { approvals, pyPayload, step: events.find(e => e.kind === "agent-step" && e.tool === "python_exec" && !e.pending) };
};

test("autoApprovePython: a readonly python_exec runs with NO approval prompt (sandbox provenance, hardened)", async () => {
    const { approvals, pyPayload, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return [5, 6]" });
    assert.equal(approvals, 0, "readonly python was auto-approved (gate never called)");
    assert.equal(step.approval, "sandbox", "step tagged auto-approved (sandbox)");
    assert.equal(pyPayload.hardened, true, "readonly mode → the offscreen run is hardened");
});

test("autoApprovePython: a full-mode python_exec still prompts (network needs approval, not hardened)", async () => {
    const { approvals, pyPayload, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return 1", args: { mode: "full" } });
    assert.equal(approvals, 1, "full mode always asks, even with the flag on");
    assert.equal(step.approval, "user");
    assert.equal(pyPayload.hardened, false, "full mode → the offscreen run is NOT hardened");
});

test("autoApprovePython: code with hidden/bidi characters still prompts", async () => {
    const { approvals, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return 1  # ​hidden" });
    assert.equal(approvals, 1, "a zero-width space forces the manual prompt (the suspicious-char check)");
    assert.equal(step.approval, "user");
});

test("autoApprovePython OFF: a readonly python_exec still prompts (the flag gates it)", async () => {
    const { approvals, pyPayload } = await runPyAgent({ config: { autoApprovePython: false }, code: "return [5, 6]" });
    assert.equal(approvals, 1, "with the flag off, every python_exec is gated");
    assert.equal(pyPayload.hardened, true, "still hardened — readonly mode is the default regardless of approval");
});

test("autoApprovePython: an EXTERNAL `sheet` still prompts (a privileged cross-origin fetch)", async () => {
    const { approvals, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return df.sum()", args: { tables: "https://docs.google.com/spreadsheets/d/ABC/edit" } });
    assert.equal(approvals, 1, "pulling an arbitrary sheet from a URL always asks, even readonly");
    assert.equal(step.approval, "user");
});

test("autoApprovePython: tables:'current' is auto-approved (you're already on the page)", async () => {
    const { approvals, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return df.sum()", args: { tables: "current" } });
    assert.equal(approvals, 0, "the sheet you're looking at is as safe as a readonly DOM survey");
    assert.equal(step.approval, "sandbox");
});

test("an EXTERNAL sheet inside a `tables` MAP escalates to approval (not just a top-level source)", async () => {
    // The escalation must scan every value in the map, not only a bare `tables` string.
    const { approvals, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return df_t.sum()", args: { tables: { df_t: "https://docs.google.com/spreadsheets/d/MAP1/edit" } } });
    assert.equal(approvals, 1, "an external sheet in the map still prompts");
    assert.equal(step.approval, "user");
});

// REGRESSION (observed in a real run). The model sent `tables: ["current"]` — an ARRAY, which is neither
// documented form. `tables`'s schema is a `oneOf`, which validateArgs used to skip entirely, so nothing
// flagged it; the tool then did Object.keys(["current"]) === ["0"] and reported `"0" isn't a valid Python
// variable name`. The model had never written "0", so it could not act on that and retried the same call,
// burning its step budget. A one-element array is unambiguous — take it.
test("tables: a ONE-element array is the single source (models wrap a lone value in a list)", async () => {
    const wrapped = await runPyAgent({ config: { autoApprovePython: true }, code: "return df.sum()", args: { tables: ["current"] } });
    const bare = await runPyAgent({ config: { autoApprovePython: true }, code: "return df.sum()", args: { tables: "current" } });
    // Equivalence is the claim, so compare against the documented form rather than pinning this page's outcome.
    // The wrapped call additionally carries the schema warning — both halves of the fix in one result: the tool
    // does the right thing, AND the model is told the shape it should have sent so it corrects next time.
    assert.ok(String(wrapped.step.result).startsWith(String(bare.step.result)), "['current'] does what 'current' does");
    assert.match(String(wrapped.step.result), /Argument schema issue.*"tables" should be string or object \(got array\)/, "and the union is now validated");
    assert.equal(wrapped.approvals, bare.approvals, "same approval path");
    assert.equal(wrapped.step.approval, bare.step.approval);
    assert.doesNotMatch(String(wrapped.step.result), /valid Python variable name/, "never reports a name the model didn't write");
});

// The security invariant must survive that accommodation: wrapping a sheet URL in a list cannot skip consent.
test("tables: an external sheet wrapped in an array still escalates to approval", async () => {
    const { approvals, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return df.sum()", args: { tables: ["https://docs.google.com/spreadsheets/d/WRAP1/edit"] } });
    assert.equal(approvals, 1, "a wrapped external sheet is still an external sheet");
    assert.equal(step.approval, "user");
});

test("tables: a MULTI-element array names the real problem (no names) instead of failing on \"0\"", async () => {
    const { step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return 1", args: { tables: ["#a", "#b"] } });
    assert.doesNotMatch(String(step.result), /"0" isn't a valid Python variable name/, "the old message pointed at an index");
    assert.match(String(step.result), /carries no variable NAMES/, "says WHY a list can't work");
    assert.match(String(step.result), /"sales": "#a"/, "and shows the map form built from what was actually passed");
});

test("a `tables` map of only DOM selectors / 'current' is auto-approved (no external escalation)", async () => {
    const { approvals, step } = await runPyAgent({ config: { autoApprovePython: true }, code: "return 1", args: { tables: { a: "#t", b: "current" } } });
    assert.equal(approvals, 0, "no external sheet → the readonly sandbox path (no prompt)");
    assert.equal(step.approval, "sandbox");
});

// Run an agent with a scripted sequence of python_exec calls (autoApprovePython ON), counting
// approval prompts + capturing the per-step approval provenance. For the sheet-cache tests.
const runPySeq = async (calls) => {
    const world = loadPageWorld({
        config: { model: "", ocrModel: "", autoApprovePython: true },
        onRuntimeMessage: pyBackend([...calls.map((a, i) => toolCall("python_exec", a, "c" + i)), reply("done")]),
    });
    const win = world.context.window, events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    let approvals = 0;
    await world.ml.agent("x", { tools: [world.ml.pythonTool()], vision: false, approve: () => { approvals++; return true; } });
    return { approvals, steps: events.filter(e => e.kind === "agent-step" && e.tool === "python_exec" && !e.pending) };
};

test("external-sheet approval is CACHED per page session — a repeat call to the same sheet doesn't re-prompt", async () => {
    // Two calls to the same spreadsheet (different gid on the 2nd → same id).
    const { approvals, steps } = await runPySeq([
        { code: "return df.shape", tables: "https://docs.google.com/spreadsheets/d/ABC/edit#gid=0" },
        { code: "return df.sum()", tables: "https://docs.google.com/spreadsheets/d/ABC/edit#gid=7" },
    ]);
    assert.equal(approvals, 1, "only the FIRST call to the spreadsheet prompts");
    assert.equal(steps[0].approval, "user", "first call: user-approved");
    assert.equal(steps[1].approval, "sandbox", "second call to the same spreadsheet: auto (cached)");
});

test("the sheet cache is per-spreadsheet — a DIFFERENT sheet still prompts", async () => {
    const { approvals } = await runPySeq([
        { code: "return df.shape", tables: "https://docs.google.com/spreadsheets/d/AAA/edit" },
        { code: "return df.shape", tables: "https://docs.google.com/spreadsheets/d/BBB/edit" },
    ]);
    assert.equal(approvals, 2, "each distinct spreadsheet is approved on its own");
});

test("_renderArgs hoists the data source (sheet/table) above the code blob for the approval prompt", () => {
    const { ml } = loadDomWorld(`<div></div>`);
    const out = ml._renderArgs({ code: "return df.sum()", tables: "https://docs.google.com/spreadsheets/d/X/edit" });
    assert.ok(out.indexOf("tables:") < out.indexOf("code:"), "the data source is shown before the code");
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
    assert.deepEqual(events.find(e => e.tool === "grab" && !e.pending).elements, [node]);
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
    assert.match(seen[0], /`answer` tool curates/);

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
    // logDebug's tracer logs to the SANDBOX console (world.context.console), which is a quiet no-op by default
    // — spy on THAT, not the outer process console (they're deliberately decoupled so boot chatter can't
    // corrupt the node:test IPC; see mkConsole in helpers.js).
    const orig = world.context.console.log;
    world.context.console.log = (...a) => logs.push(a);
    try {
        await world.ml.agent("t", { tools: [ping], logDebug: true, onStep: (e) => seen.push(e) });
    } finally { world.context.console.log = orig; }

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
            if (m.type === "GET_CONFIG") return { data: { model: "qwen-vl", ocrModel: "", pageApprovalAllowed: true } };
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
    // The carrier turn is MINIMAL — just a labelled marker (no forced "describe what you see" paragraph).
    assert.match(imgTurn.content, /^\[Screenshot: .+\]$/);
    assert.equal(res.summary, "I can see a search box at the top.");
});

test("composer image: a VISION-capable agent gets the pasted image in its first user turn", async () => {
    const steps = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG") return { data: { model: "qwen-vl", ocrModel: "", pageApprovalAllowed: true } };
            if (m.type === "MODEL_CAPS") return { data: ["completion", "vision"] };   // agent model sees natively
            steps.push(m.payload.messages);
            return { data: { content: "done", tool_calls: [] } };
        }
    });
    await world.ml.agent("what's this?", { images: ["data:image/png;base64,PASTED"] });
    const firstUser = steps[0].find(m => m.role === "user");
    assert.ok(Array.isArray(firstUser.images) && firstUser.images.includes("data:image/png;base64,PASTED"), "pasted image attached to the first user turn");
    assert.match(firstUser.content, /what's this\?/);
});

test("composer image: a TEXT-ONLY agent gets the pasted image transcribed (OCR fallback)", async () => {
    const steps = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG") return { data: { model: "text-llm", ocrModel: "reader-vl", pageApprovalAllowed: true } };
            if (m.type === "MODEL_CAPS") return { data: m.payload?.model === "reader-vl" ? ["completion", "vision"] : ["completion"] };
            if (m.type === "FETCH_LLM" && m.payload?.ocr) return { data: "SECRET-1234" };   // ml.read transcription (data = content string)
            steps.push(m.payload.messages);
            return { data: { content: "done", tool_calls: [] } };
        }
    });
    await world.ml.agent("read it", { images: ["data:image/png;base64,PASTED"] });
    const firstUser = steps[0].find(m => m.role === "user");
    assert.ok(!firstUser.images, "no image attached — the driver can't see");
    assert.match(firstUser.content, /read it/);
    assert.match(firstUser.content, /SECRET-1234/, "OCR transcription folded into the task text");
    assert.match(firstUser.content, /can't see images/);
});

test("vision:true forces NATIVE look on the agent's own model, bypassing the caps probe", async () => {
    const steps = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "GET_CONFIG") return { data: { model: "minimax-m3", ocrModel: "", pageApprovalAllowed: true } };
            if (m.type === "MODEL_CAPS") return { data: null };   // unknown → auto-probe would REFUSE native
            steps.push(m.payload.messages);
            return { data: steps.length === 1
                ? { content: "", tool_calls: [{ id: "c1", name: "look", arguments: {} }] }
                : { content: "It's a settings page.", tool_calls: [] } };
        }
    });
    world.ml.screenshot = async () => "data:image/png;base64,SHOT";

    const res = await world.ml.agent("what's here?", { vision: true });

    // Native despite the probe returning unknown — the image is injected into the agent's
    // OWN history (a delegated look would instead call a second model to describe it).
    const injected = steps.some(msgs => msgs.some(m =>
        m.role === "user" && Array.isArray(m.images) && m.images.includes("data:image/png;base64,SHOT")));
    assert.ok(injected, "vision:true → native look injects the screenshot (probe bypassed)");
    assert.equal(res.summary, "It's a settings page.");
});

// ---- python_exec `table` → df extraction (_resolveTable over a real DOM) ----

test("_resolveTable: numeric columns are auto-cast to numbers (strings would string-concat)", () => {
    const { ml } = loadDomWorld(`<table id="t">
        <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Apple</td><td>3</td><td>1.50</td></tr>
          <tr><td>Pear</td><td>2</td><td>2.00</td></tr>
        </tbody></table>`);
    // JSON round-trip brings the sandbox arrays into this realm AND preserves number-vs-
    // string types (deepStrictEqual can't compare across VM realms; deepEqual is too loose).
    const realm = (x) => JSON.parse(JSON.stringify(x));
    const t = ml._resolveTable("#t");
    assert.equal(t.kind, "rows");
    assert.deepEqual(t.columns, ["Item", "Qty", "Price"]);
    assert.deepStrictEqual(realm(t.rows), [["Apple", 3, 1.5], ["Pear", 2, 2]]);
});

const realmRows = (t) => JSON.parse(JSON.stringify(t.rows));

test("_resolveTable raw:true keeps every cell a string (no auto-cast)", () => {
    const { ml } = loadDomWorld(`<table id="t"><thead><tr><th>Zip</th></tr></thead><tbody><tr><td>01234</td></tr><tr><td>00500</td></tr></tbody></table>`);
    // Default would cast → drop the leading zeros (01234 → 1234). raw preserves them.
    assert.deepStrictEqual(realmRows(ml._resolveTable("#t")), [[1234], [500]]);
    assert.deepStrictEqual(realmRows(ml._resolveTable("#t", true)), [["01234"], ["00500"]]);
});

test("_resolveTable: strips corporate formatting + coerces the sub-10% outlier to null", () => {
    const cells = ["$1,250.50", "(150)", "15%", "100", "200", "300", "400", "500", "600", "N/A"];
    const { ml } = loadDomWorld(`<table id="t"><thead><tr><th>Amount</th></tr></thead><tbody>${cells.map(c => `<tr><td>${c}</td></tr>`).join("")}</tbody></table>`);
    // currency+commas → 1250.5; accounting parens → -150; percent → 15. 9/10 numeric ≥ 90% →
    // cast; the lone non-numeric "N/A" (< 10%) → null (pandas NaN).
    assert.deepStrictEqual(realmRows(ml._resolveTable("#t")), [[1250.5], [-150], [15], [100], [200], [300], [400], [500], [600], [null]]);
});

test("_resolveTable: a mostly-text column stays strings (below the 90% numeric threshold)", () => {
    const { ml } = loadDomWorld(`<table id="t"><thead><tr><th>Code</th></tr></thead><tbody>
        <tr><td>A1</td></tr><tr><td>B2</td></tr><tr><td>C3</td></tr><tr><td>4</td></tr>
      </tbody></table>`);
    assert.deepStrictEqual(realmRows(ml._resolveTable("#t")), [["A1"], ["B2"], ["C3"], ["4"]]);
});

test("_resolveTable: a first-row <th> (no thead) becomes the header", () => {
    const { ml } = loadDomWorld(`<table id="t"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`);
    const t = ml._resolveTable("#t");
    assert.deepEqual(t.columns, ["A", "B"]);
    assert.deepEqual(t.rows, [["1", "2"]]);
});

test("_resolveTable: an ARIA grid (role=table/row/columnheader/cell)", () => {
    const { ml } = loadDomWorld(`<div id="g" role="table">
        <div role="row"><span role="columnheader">Name</span><span role="columnheader">Age</span></div>
        <div role="row"><span role="cell">Ada</span><span role="cell">36</span></div>
      </div>`);
    const t = ml._resolveTable("#g");
    assert.equal(t.kind, "rows");
    assert.deepEqual(t.columns, ["Name", "Age"]);
    assert.deepEqual(t.rows, [["Ada", "36"]]);
});

test("_resolveTable: a table with colspan falls back to read_html (kind: html)", () => {
    const { ml } = loadDomWorld(`<table id="t"><tr><th colspan="2">Merged</th></tr><tr><td>1</td><td>2</td></tr></table>`);
    const t = ml._resolveTable("#t");
    assert.equal(t.kind, "html", "spans misalign a flat walk → let pandas.read_html handle it");
    assert.match(t.html, /colspan/);
});

test("_resolveTable: a wrapper element AROUND a table falls back to its outerHTML (read_html finds the inner table)", () => {
    const { ml } = loadDomWorld(`<div id="d"><table><tr><th colspan="2">M</th></tr><tr><td>1</td><td>2</td></tr></table></div>`);
    const t = ml._resolveTable("#d");
    assert.equal(t.kind, "html");
    assert.match(t.html, /<table>/);
});

// The `#bigsales` demo trigger: a table that exists in the DOM but is EMPTY (lazily built on a
// toggle) → extractTable returns null → read_html over `<table></table>` would die with the
// obscure "No tables found matching pattern '.+'". Guard it page-side with an actionable message.
test("_resolveTable: an EMPTY table (0 rows) throws a clear, actionable error (not an obscure read_html ValueError)", () => {
    const { ml } = loadDomWorld(`<table id="t"></table>`);
    assert.throws(() => ml._resolveTable("#t"), /matched an EMPTY table.*collapsed or lazily rendered/is);
});

test("_resolveTable: a whitespace-only table (no rows) also throws the empty-table error", () => {
    const { ml } = loadDomWorld(`<table id="t">   </table>`);
    assert.throws(() => ml._resolveTable("#t"), /EMPTY table/);
});

test("_resolveTable: an element with no <table> inside throws (python_exec needs a table)", () => {
    const { ml } = loadDomWorld(`<div id="d"><p>not a table</p></div>`);
    assert.throws(() => ml._resolveTable("#d"), /no <table> inside/);
});

test("_resolveTable: an empty/malformed ARIA grid throws an ARIA-specific message", () => {
    const { ml } = loadDomWorld(`<div id="g" role="grid"></div>`);   // role=grid but no rows → unparseable
    assert.throws(() => ml._resolveTable("#g"), /ARIA grid python_exec couldn't parse/);
});

test("python_exec tool: an ambiguous `table` selector warns it loaded the FIRST", async () => {
    const { ml } = loadDomWorld(`<table class="t"><tr><td>1</td></tr></table><table class="t"><tr><td>2</td></tr></table>`);
    ml.pythonExec = async () => ({ ok: true, value: "ok", stdout: "", inputTables: [{ name: "df", source: { kind: "dom", label: ".t" }, columns: [], rows: [[1]] }] });
    const out = await ml.pythonTool().run({ code: "return 1", tables: ".t" });
    assert.match(out.content, /matched 2 elements — loaded the FIRST/);
    // A unique selector → no warning.
    const { ml: ml2 } = loadDomWorld(`<table id="only"><tr><td>1</td></tr></table>`);
    ml2.pythonExec = async () => ({ ok: true, value: "ok", stdout: "" });
    assert.doesNotMatch((await ml2.pythonTool().run({ code: "return 1", tables: "#only" })).content, /matched/);
});

test("python_exec tool: `maxChars` raises the stdout/value cap (post-approval), clamped to the ceiling", async () => {
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: "x".repeat(30000), stdout: "" });
    // Default 2000 clips.
    assert.match((await ml.pythonTool().run({ code: "x" })).content, /x{2000}… \[\+28000 chars truncated\]/);
    // Raised (+ reason) → up to the 20000 ceiling, with a clamp note (30000 requested > 20000 ceiling).
    const raised = await ml.pythonTool().run({ code: "x", maxChars: 100000, maxCharsReason: "dumping a full frame" });
    assert.match(raised.content, /x{20000}… \[\+10000 chars truncated\]/);
    assert.match(raised.content, /clamped to 20000 chars/i);
});

test("python_exec tool: prepends a synthetic 'loaded' log so models know what's pre-loaded", async () => {
    const { ml } = loadDomWorld(`<table id="t"><tr><td>1</td></tr></table>`);
    ml.pythonExec = async () => ({ ok: true, value: "42", stdout: "", inputImage: "data:image/png;base64,X",
        inputTables: [{ name: "sales", source: { kind: "dom", label: "#t" }, columns: ["A", "B"], rows: [[1, 2], [3, 4]] }] });
    const out = await ml.pythonTool().run({ code: "return 1", tables: "#t", image: "#t" });
    assert.match(out.content, /loaded, reference directly/);
    assert.match(out.content, /2×2 DataFrame → `sales`/, "names the df + its shape");
    assert.match(out.content, /screenshot → `img`/, "notes the pre-loaded image");
});

test("python_exec tool: an image return keeps base64 OUT of the model's context — it's only in the UI descriptor", async () => {
    // The model returns a PIL image (python-runtime hands back a data: URL); the base64 must NOT pollute the
    // model-facing `content` (context/history) — only the render descriptor (UI) carries it.
    const { ml } = loadDomWorld();
    const b64 = "data:image/png;base64," + "A".repeat(5000);
    ml.pythonExec = async () => ({ ok: true, value: b64, stdout: "" });
    const out = await ml.pythonTool().run({ code: "return img" });
    assert.match(out.content, /Returned an image\./, "the model-facing content is a short note");
    assert.ok(!out.content.includes("AAAAA"), "the base64 is NOT in the content the model sees");
    assert.equal(out.render.image, b64, "the base64 lives only in the UI descriptor");
});

test("python_exec tool: a render:'latex' return flags the descriptor so the surfaces typeset it (no cast)", async () => {
    // python-runtime detected a sympy return and set render:'latex'; the tool flags the python-out descriptor
    // latex:true so a plain `:out` citation typesets with no `| latex`. (The LaTeX string is small — unlike a
    // base64 image — so it's fine for it to be in `content` too.)
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: "2 x e^{3 x}", stdout: "", render: "latex" });
    const out = await ml.pythonTool().run({ code: "return sympy.diff(expr, x)" });
    assert.equal(out.render.latex, true, "the python-out descriptor is flagged latex");
    assert.equal(out.render.value, "2 x e^{3 x}", "…carrying the LaTeX value");
});

test("python_exec tool: a LaTeX-STRING value auto-flags latex (a sympy.latex() return typesets with no cast)", async () => {
    // A model that returns `sympy.latex(expr)` hands back a STRING (no sympy type for python-runtime to catch);
    // the tool detects it looks like LaTeX and flags the descriptor so `:out` typesets without `| latex`.
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: "3 x^{2} + 4 x - 5", stdout: "" });
    assert.equal((await ml.pythonTool().run({ code: "return sympy.latex(df)" })).render.latex, true, "a LaTeX-looking string auto-flags latex");
    // An ordinary string is NOT treated as latex.
    ml.pythonExec = async () => ({ ok: true, value: "the grand total is 42", stdout: "" });
    const out = await ml.pythonTool().run({ code: "return summary" });
    assert.ok(!out.render || !out.render.latex, "an ordinary string is NOT auto-latex");
});

test("_resolveTable: throws for a selector that matches nothing", () => {
    const { ml } = loadDomWorld(`<div></div>`);
    assert.throws(() => ml._resolveTable("#nope"), /no table element matches/);
});

// ---- python_exec `tables` → Google Sheets CSV (googleSheetCsvUrl + parseCsv + the FETCH_SHEET relay) ----

test("pythonExec tables: a Sheets URL derives the CSV export URL, fetches it, and parses + casts to a df", async () => {
    let sheetUrl = null, pyTable = null;
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_SHEET") { sheetUrl = m.payload.url; return { data: { csv: "Rep,Q1\nAda,120\nBen,90\n", name: "FY Sales" } }; }
            if (m.type === "PYTHON_EXEC") { pyTable = m.payload.tables; return { data: { ok: true, value: "210", stdout: "" } }; }
            return undefined;
        },
    });
    await world.ml.pythonExec("return df['Q1'].sum()", { tables: "https://docs.google.com/spreadsheets/d/ABC123/edit#gid=42" });
    assert.equal(sheetUrl, "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=42", "id + gid → the CSV export endpoint");
    // A single-source `tables` string normalizes to a one-entry array named `df`.
    assert.equal(pyTable.length, 1);
    assert.equal(pyTable[0].name, "df");
    assert.deepEqual(pyTable[0].data.columns, ["Rep", "Q1"]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(pyTable[0].data.rows)), [["Ada", 120], ["Ben", 90]], "Q1 auto-cast to numbers, so pandas sums instead of concatenating");
});

test("pythonExec tables map: two named sources → two ordered df entries carrying their names", async () => {
    let sheetFetches = 0, pyTables = null;
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_SHEET") { sheetFetches++; return { data: { csv: "Rep,Q1\nAda,120\n", name: null } }; }
            if (m.type === "PYTHON_EXEC") { pyTables = m.payload.tables; return { data: { ok: true, value: "ok", stdout: "" } }; }
            return undefined;
        },
    });
    await world.ml.pythonExec("return pd.merge(sales, targets, on='Rep')", { tables: { sales: "https://docs.google.com/spreadsheets/d/AA/edit", targets: "https://docs.google.com/spreadsheets/d/BB/edit" } });
    assert.equal(sheetFetches, 2, "each sheet source fetches its own CSV");
    assert.deepEqual(pyTables.map(t => t.name), ["sales", "targets"], "each source keeps its variable name, in order");
});

test("pythonExec tables: a URL with no gid defaults to the first tab (gid=0)", async () => {
    let sheetUrl = null;
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_SHEET") { sheetUrl = m.payload.url; return { data: { csv: "a\n1\n", name: null } }; }
            return { data: { ok: true, value: "1", stdout: "" } };
        },
    });
    await world.ml.pythonExec("return 1", { tables: "https://docs.google.com/spreadsheets/d/XYZ/edit" });
    assert.match(sheetUrl, /export\?format=csv&gid=0$/);
});

test("pythonExec tables:'current' off a Google Sheet (with no table) errors before any fetch", async () => {
    let fetched = false;
    const world = loadPageWorld({
        onRuntimeMessage: (m) => { if (m.type === "FETCH_SHEET") fetched = true; return { data: { ok: true, value: 1, stdout: "" } }; },
    });
    await assert.rejects(world.ml.pythonExec("return 1", { tables: "current" }), /neither a Google Sheet nor has a table with data/);
    assert.equal(fetched, false, "no privileged fetch when the page isn't a sheet");
});

test("pythonExec tables: an invalid variable name in the map is rejected", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: { ok: true, value: 1, stdout: "" } }) });
    await assert.rejects(world.ml.pythonExec("return 1", { tables: { "2bad": "#t" } }), /valid Python variable name/);
    await assert.rejects(world.ml.pythonExec("return 1", { tables: { pd: "#t" } }), /reserved/);
    await assert.rejects(world.ml.pythonExec("return 1", { tables: { tables: "#t" } }), /reserved/, "the `tables` dict name itself is reserved");
});

test("parseCsv (via sheet): quoted fields with embedded commas, newlines, and doubled quotes", async () => {
    let cols = null, rows = null;
    const csv = 'Name,Note\n"Ada, L.","said ""hi""\nthere"\nBen,plain\n';
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_SHEET") return { data: { csv, name: null } };
            if (m.type === "PYTHON_EXEC") { cols = m.payload.tables[0].data.columns; rows = m.payload.tables[0].data.rows; return { data: { ok: true, value: 1, stdout: "" } }; }
            return undefined;
        },
    });
    // tableRaw so the quoted text survives verbatim (no numeric cast).
    await world.ml.pythonExec("return 1", { tables: "https://docs.google.com/spreadsheets/d/Q/edit", tableRaw: true });
    assert.deepEqual(cols, ["Name", "Note"]);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), [["Ada, L.", 'said "hi"\nthere'], ["Ben", "plain"]]);
});

test("examples/spreadsheet.html ridiculous table: dirty cells coerce to null, the rest sum to 116153", () => {
    // Rebuild the demo's giant table the same deterministic way (seed 1337) and confirm the
    // auto-cast turns the formatted/junk cells into number|null so the sum matches the key.
    const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const REGIONS = ["North", "South", "East", "West", "Central"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const rand = mulberry32(1337), N = 40, data = [];
    for (let i = 0; i < N; i++) { const mv = []; for (let m = 0; m < 12; m++) mv.push(Math.floor(rand() * 400) + 50); data.push({ id: String(i + 1).padStart(5, "0"), rep: "Rep " + (i + 1), region: REGIONS[i % 5], mv }); }
    const display = data.map(d => d.mv.map(v => String(v)));
    for (const [r, m, s] of [[3, 2, ""], [8, 6, "N/A"], [13, 1, "1,250"], [18, 8, "$300"], [23, 4, "(180)"], [28, 10, "12O0"], [33, 7, "  "]]) display[r][m] = s;
    const cols = ["ID", "Rep", "Region", ...MONTHS];
    const body = data.map((d, i) => `<tr><td>${d.id}</td><td>${d.rep}</td><td>${d.region}</td>${display[i].map(s => `<td>${s}</td>`).join("")}</tr>`).join("");
    const html = `<table id="bigsales"><thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;

    const { ml } = loadDomWorld(html);
    const rows = JSON.parse(JSON.stringify(ml._resolveTable("#bigsales").rows));
    // month columns are indices 3..14; sum the numbers (nulls skipped, like pandas NaN).
    const total = rows.reduce((s, r) => s + r.slice(3).reduce((a, c) => a + (typeof c === "number" ? c : 0), 0), 0);
    assert.equal(total, 116153, "matches the demo's documented grand total");
    // The formatted cells cast; the junk (typo, blank, N/A) → null.
    assert.equal(rows[13][1 + 3], 1250, "1,250 → 1250");           // Feb col
    assert.equal(rows[23][4 + 3], -180, "(180) → -180");           // May col
    assert.equal(rows[28][10 + 3], null, "12O0 typo → null");      // Nov col
    // ID column has leading zeros → default cast drops them; tableRaw preserves.
    assert.equal(typeof rows[0][0], "number");
    assert.equal(JSON.parse(JSON.stringify(ml._resolveTable("#bigsales", true).rows))[0][0], "00001");
});

test("examples/spreadsheet.html: the #sales table extracts to rows that sum to the documented answer", () => {
    const fs = require("node:fs"), path = require("node:path");
    const html = fs.readFileSync(path.join(__dirname, "../examples/spreadsheet.html"), "utf8");
    const table = html.match(/<table id="sales"[\s\S]*?<\/table>/)[0];
    const { ml } = loadDomWorld(table);
    const t = ml._resolveTable("#sales");
    assert.deepEqual(t.columns, ["Rep", "Region", "Q1", "Q2", "Q3", "Q4"]);
    assert.equal(t.rows.length, 12);
    // Grand total of Q1–Q4 across all reps — the value the demo documents (6260). Proves the
    // extracted cells carry the right numbers that pandas' df.sum() would add up to.
    const total = t.rows.reduce((s, r) => s + r.slice(2).reduce((a, c) => a + Number(c), 0), 0);
    assert.equal(total, 6260, "extraction matches the demo's expected answer");
});

// ---- python_exec tables:'current' shorthand (non-sheet page) ----

test("tables:'current' loads the page's SINGLE non-empty table (not just a Google Sheet)", async () => {
    const { ml } = loadDomWorld('<table id="sales"><tr><th>A</th></tr><tr><td>1</td></tr></table><table id="empty"></table>');
    const loaded = await ml._loadTable("df", "current");
    assert.equal(loaded.source.kind, "dom");
    assert.deepEqual(loaded.data.columns, ["A"]);
    assert.deepEqual(loaded.data.rows, [[1]]);   // the empty table is ignored; numeric cast applied
});

test("tables:'current' is ambiguous with >1 non-empty table → an actionable error steers to a selector", async () => {
    const { ml } = loadDomWorld('<table><tr><td>1</td></tr></table><table><tr><td>2</td></tr></table>');
    await assert.rejects(ml._loadTable("df", "current"), /has 2 tables \(ambiguous\)\. Pass a CSS selector/);
});

test("tables:'current' with no data table (and not a Sheet) → a clear error", async () => {
    const { ml } = loadDomWorld('<table id="empty"></table><p>no data</p>');
    await assert.rejects(ml._loadTable("df", "current"), /neither a Google Sheet nor has a table with data/);
});

test("click render() → an action intent; look render() → a hoverable element ref; no selector → null", () => {
    const { ml } = loadDomWorld();
    const click = ml.clickTool(), look = ml.lookTool();
    // click provides a tool INTENT (verb + the selector to highlight); no DOM match here → no human label.
    let r = click.render({}, { selector: "#go" });
    assert.equal(r.type, "action"); assert.equal(r.verb, "Click"); assert.equal(r.selector, "#go");
    // A canvas @pt is a valid target — kind "point" (nothing to name).
    r = click.render({}, { selector: "@pt:abc123" });
    assert.equal(r.type, "action"); assert.equal(r.kind, "point"); assert.equal(r.selector, "@pt:abc123");
    assert.equal(click.render({}, {}), null);   // no selector → nothing to describe
    // look shares targetRender → a hoverable elements descriptor (the sidebar outlines it on hover).
    assert.deepEqual(look.render({}, { selector: "#go" }), { type: "elements", items: [{ path: "#go" }] });
    assert.deepEqual(look.render({}, { selector: ".x", index: 2 }), { type: "elements", items: [{ path: ".x", index: 2 }] });
    assert.equal(look.render({}, {}), null);
});

// ---- python_exec cast:'pt'/'box' projects image-pixel coords → viewport (dpr + element offset) ----

test("cast:'pt' projects the image-pixel point through the crop transform before minting", async () => {
    const { ml } = loadDomWorld();
    // Stub pythonExec: the sandbox returned an IMAGE-pixel point, plus the crop transform.
    ml.pythonExec = async () => ({ ok: true, value: [100, 50], stdout: "", imageBox: { left: 10, top: 20, dpr: 2 } });
    const res = await ml.pythonTool().run({ cast: "pt", code: "return [100,50]", image: "#stage" });
    // viewport = (10 + 100/2, 20 + 50/2) = (60, 45) — NOT the raw (100, 50).
    assert.match(res.content, /at \(60, 45\)/);
    // With an image, the result SPELLS OUT that image-px were projected to viewport (models kept
    // reading the projection as a "displaced" bug).
    assert.match(res.content, /projected to VIEWPORT space/);
});

test("cast:'pt' with NO image mints the point as-is (already viewport coords) — no projection note", async () => {
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: [300, 200], stdout: "" });   // no imageBox
    const res = await ml.pythonTool().run({ cast: "pt", code: "return [300,200]" });
    assert.match(res.content, /at \(300, 200\)/);
    assert.doesNotMatch(res.content, /projected to VIEWPORT/, "no image → coords were already viewport, no note");
});

test("cast:'box' projects both corners; the reported size is the VIEWPORT (dpr-shrunk) box", async () => {
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: [0, 0, 200, 100], stdout: "", imageBox: { left: 10, top: 20, dpr: 2 } });
    const res = await ml.pythonTool().run({ cast: "box", code: "return [0,0,200,100]", image: "#stage" });
    assert.match(res.content, /100×50px region/);   // 200/2 × 100/2, not 200×100
});

test("no-cast return that LOOKS like a point (with an image) → hints to re-run with cast:'pt'", async () => {
    const { ml } = loadDomWorld();
    // The observed dumb move: the script computed {x,y} but omitted `cast`, so it's dead text.
    ml.pythonExec = async () => ({ ok: true, value: { x: 421, y: 32 }, stdout: "" });
    const res = await ml.pythonTool().run({ code: "return {'x': int(x), 'y': int(y)}", image: "#stage" });
    assert.match(res.content, /looks like a POINT/);
    assert.match(res.content, /cast:"pt"/, "names the exact cast to add");
    assert.match(res.content, /421/, "still shows the computed value");
});

test("no-cast return that LOOKS like a box (with an image) → hints to re-run with cast:'box'", async () => {
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: [10, 20, 110, 80], stdout: "" });
    const res = await ml.pythonTool().run({ code: "return [10,20,110,80]", image: "#stage" });
    assert.match(res.content, /looks like a BOX/);
    assert.match(res.content, /cast:"box"/);
});

test("no-cast return that is a LIST of candidate points (with an image) → hints to pick one + cast:'pt'", async () => {
    const { ml } = loadDomWorld();
    // The newest way the model snuck coordinates out: [[666,529],[697,529]].
    ml.pythonExec = async () => ({ ok: true, value: [[666, 529], [697, 529]], stdout: "" });
    const res = await ml.pythonTool().run({ code: "return final_candidates", image: "#stage" });
    assert.match(res.content, /LIST of 2 candidate POINTS/);
    assert.match(res.content, /cast:"pt"/);
});

test("cast:'pt' on a LIST of points is rejected with a 'return ONE' message (not the generic mismatch)", async () => {
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: [[666, 529], [697, 529]], stdout: "" });
    const res = await ml.pythonTool().run({ code: "return final_candidates", cast: "pt", image: "#stage" });
    assert.match(res.content, /LIST of 2 points — return the SINGLE best one/);
});

test("the coordinate nudge is GATED on an image — a point-shaped return with NO image gets no hint", async () => {
    const { ml } = loadDomWorld();
    // No image was loaded → two numbers are almost certainly data, not a click target.
    ml.pythonExec = async () => ({ ok: true, value: { x: 421, y: 32 }, stdout: "" });
    const res = await ml.pythonTool().run({ code: "return {'x': 421, 'y': 32}" });
    assert.doesNotMatch(res.content, /looks like a POINT|cast:"pt"/, "no nudge without an image");
    assert.match(res.content, /421/, "still returns the value as text");
});

test("no-cast return that is plain data (not a coordinate) gets NO cast hint", async () => {
    const { ml } = loadDomWorld();
    ml.pythonExec = async () => ({ ok: true, value: 42, stdout: "" });
    const res = await ml.pythonTool().run({ code: "return 6*7", image: "#stage" });
    assert.doesNotMatch(res.content, /looks like a POINT|looks like a BOX|LIST of/);
    assert.match(res.content, /42/);
});

test("the tool description only advertises 'current' when it resolves — one table → yes, none → no", () => {
    const one = loadDomWorld('<table><tr><td>1</td></tr></table>').ml.pythonTool();
    assert.match(one.description, /THIS PAGE HAS ONE TABLE/);
    assert.match(one.parameters.properties.tables.description, /one table on this page/);
    const none = loadDomWorld('<p>no tables</p>').ml.pythonTool();
    assert.doesNotMatch(none.description, /current/);
    assert.doesNotMatch(none.parameters.properties.tables.description, /'current'/);
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
    assert.equal(out.content, "yes, it looks sponsored");
    // A `look` Out render: the image the reader saw + which model + its output.
    assert.equal(out.render.type, "look");
    assert.equal(out.render.image, "data:image/png;base64,SHOT", "the exact image the reader saw");
    assert.match(out.render.output, /sponsored/, "the model's output");
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
    const out = await look.run({ selector: "#x" });
    assert.equal(out.content, "a product card");
    assert.equal(out.render.model, "qwen2.5vl", "the render names WHICH model read the image");
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
    assert.equal(out.content, "an Amazon search results page");
});

test("lookTool scope:'page' stitches and frames it as a downscaled overview", async () => {
    const prompts = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => { prompts.push(m.payload.messages.at(-1).content); return { data: "desc" }; }
    });
    const seen = [];
    world.ml.screenshot = async (t, o) => { seen.push([t, o]); return "data:image/png;base64,VIEW"; };

    await world.ml.lookTool().run({ scope: "page" });
    assert.deepEqual(seen[0], [null, { fullPage: true, index: 0, margin: 0 }]); // whole page, stitched
    assert.match(prompts[0], /downscaled|overview/i);          // framed as orientation
    assert.doesNotMatch(prompts[0], /list a few EXACT/i);      // does NOT ask to extract anchors

    await world.ml.lookTool().run({});                         // default: viewport only
    assert.equal(seen[1][1].fullPage, false);
    assert.match(prompts[1], /list a few EXACT.*findByText/s); // sharp enough to quote anchors

    // classifying a grid: look at the Nth match (index passed through to screenshot)
    await world.ml.lookTool().run({ selector: ".post", index: 2 });
    assert.deepEqual(seen[2], [".post", { fullPage: false, index: 2, margin: 0 }]);
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

test("click/type precheck: a doomed target returns the error side-effect-free (for the gate skip)", () => {
    const { ml } = loadDomWorld('<button id="go">Go</button><input id="f">');
    const click = ml.clickTool(), type = ml.typeTool();
    assert.equal(click.precheck({ selector: "#go" }), null, "a match → null (proceed to the gate)");
    assert.match(click.precheck({ selector: "#nope" }), /No element matches/, "no match → the error, no click");
    assert.match(click.precheck({ selector: "@box:deadbeef" }), /container region/, "an @box → the steer, no click");
    assert.match(click.precheck({ selector: "@pt:deadbeef" }), /Unknown point token|stale/, "a stale @pt → the error");
    assert.equal(type.precheck({ selector: "#f" }), null);
    assert.match(type.precheck({ selector: "#nope" }), /No element matches/);
});

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

test("_describeSkeleton flags an empty ROOT '(no child elements)' — but not expanded leaves", () => {
    // An empty container (e.g. a collapsed/lazily-rendered #bigsales table) would otherwise be a
    // bare, useless single line. Root only, so a leaf inside an expanded tree stays clean.
    const empty = loadDomWorld('<div id="bigsales"></div>');
    assert.equal(empty.ml._describeSkeleton(empty.document.querySelector("#bigsales"), 2),
        "div#bigsales (no child elements)");
    // A LEAF within an expanded tree must NOT get the note (only the root does).
    const tree = loadDomWorld("<ul><li>a</li></ul>");
    const out = tree.ml._describeSkeleton(tree.document.querySelector("ul"), 2);
    assert.match(out, /ul\n {2}li "a"$/);
    assert.ok(!/no child elements/.test(out), "leaves in an expanded tree don't each get the note");
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

// Generic tool-output streaming (ctx.stream): `exec` is the first builtin consumer — its console patch must
// push each line to ctx.stream as it runs, while still returning the full captured output at the end. With no
// ctx.stream (streaming off) it behaves exactly as before.
test("exec streams each console.log line via ctx.stream, and still returns the full output", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    assert.ok(exec, "the exec tool is wired");
    const chunks = [];
    const out = await exec.run({ js: "console.log('one'); console.log('two'); 42" }, { stream: (t) => chunks.push(t) });
    const streamed = chunks.join("");
    assert.match(streamed, /one/, "the first console line streamed live");
    assert.match(streamed, /two/, "the second console line streamed live");
    const text = typeof out === "string" ? out : out.result || out.content || "";
    assert.match(text, /one[\s\S]*two/, "the full captured console output still comes back at the end");
});

test("exec with NO ctx.stream (streaming off) runs unchanged — nothing to stream to", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const out = await exec.run({ js: "console.log('quiet'); 1" }, {});   // ctx without `stream`
    const text = typeof out === "string" ? out : out.result || out.content || "";
    assert.match(text, /quiet/, "output still captured and returned");
});

// exec's Out now has a RENDERED mode (console / value sections), matching python_exec's cell instead of one
// raw blob. Two invariants: the RAW model-facing string is byte-identical to before (the raw-view rule — the
// log must always show exactly what the model read), and the RENDERED descriptor splits it correctly.
test("exec Out (raw): the model-facing result still carries the full console output + value", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const out = await exec.run({ js: "console.log('a'); console.log('b'); 7" }, {});
    assert.match(out.content, /^console:\n/, "the console block leads");
    assert.match(out.content, /a\nb/, "every logged line is present");
    assert.match(out.content, /\n\nvalue: 7$/, "then the returned value — the exact text the model reads");
});

test("exec Out (rendered): the descriptor splits console vs value (parity with python_exec)", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const out = await exec.run({ js: "console.log('a'); console.log('b'); 7" }, {});
    assert.equal(out.render.type, "exec-out");
    assert.equal(out.render.stdout, "a\nb", "console section = the logged lines only (no 'console:' prefix, no value)");
    assert.equal(out.render.value, "7", "value section = the return, on its own");
    assert.equal(out.render.error, undefined, "a successful run has no error section");
});

test("exec Out: a THROWN error fills the error section and stays in the raw text", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const out = await exec.run({ js: "console.log('before'); throw new Error('boom')" }, {});
    assert.match(out.content, /before/, "raw keeps the console output produced before the throw");
    assert.match(out.content, /boom/, "raw keeps the error text");
    assert.equal(out.render.type, "exec-out");
    assert.equal(out.render.stdout, "before");
    assert.match(out.render.error, /boom/, "the error rides its own section");
    assert.equal(out.render.value, undefined, "an errored run has no value section");
});

test("exec Out: nothing logged → no console section, value only (both views)", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const out = await exec.run({ js: "1 + 1" }, {});
    assert.equal(out.content, "2", "raw is just the value when nothing was logged");
    assert.equal(out.render.stdout, undefined, "no empty console section");
    assert.equal(out.render.value, "2");
});

// Streaming vs truncation: the model's result is clipped to its context budget, but the UI keeps far more —
// otherwise output you watched stream in would SHRINK when the step lands. The render records where the
// model's view ended (`seen`) so the surplus can be marked rather than passing as "what the model read".
test("exec Out: the UI keeps MORE than the model got, and records where the model's view ended", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const out = await exec.run({ js: "for (let i=0;i<60;i++) console.log('x'.repeat(19)); 1" }, {});
    assert.match(out.content, /truncated/, "the MODEL's copy is clipped at its output cap");
    assert.equal(out.render.seen, 500, "the render records exactly how many chars the model received");
    assert.ok(out.render.stdout.length > 500, "while the UI keeps far more than the model got");
    assert.doesNotMatch(out.render.stdout, /truncated/, "the UI copy isn't clipped at the model's cap");
});

// Custom cutoffs: a model may ask the human for a LARGER per-call output cap (maxChars + maxCharsReason,
// only granted post-approval). The "what the model saw" boundary must move with it — otherwise the UI would
// mark text as unseen that the model actually read.
test("exec Out: a raised (approved) output cap moves where the model's view ends", async () => {
    const { ml } = loadDomWorld();
    const exec = ml.domTools.find(t => t.name === "exec");
    const js = "for (let i=0;i<200;i++) console.log('y'.repeat(9)); 1";   // ~2000 chars of console
    const dflt = await exec.run({ js }, {});
    assert.equal(dflt.render.seen, 500, "the default cap bounds the model's view");
    const raised = await exec.run({ js, maxChars: 1200, maxCharsReason: "need the whole dump" }, {});
    assert.equal(raised.render.seen, 1200, "a raised cap moves the boundary with it");
    assert.ok(raised.render.stdout.length > 1200, "the UI still keeps more than the model got");
    // A TIGHTER cap is always allowed (no approval needed) and must also be honoured.
    const tighter = await exec.run({ js, maxChars: 100 }, {});
    assert.equal(tighter.render.seen, 100, "a smaller cap is honoured too");
});
