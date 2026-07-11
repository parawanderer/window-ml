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

test("describeElement describes the first match (+ node) and handles bad input", () => {
    const { ml } = loadDomWorld('<div class="card" data-id="7"><span>hi</span></div>');
    const res = run(ml, "describeElement", { selector: ".card", depth: 0 });
    assert.ok(res.content.startsWith('div.card [data-id="7"]'));
    assert.equal(res.elements[0].tagName, "DIV");
    assert.match(run(ml, "describeElement", { selector: "((" }), /Invalid selector/);
    assert.match(run(ml, "describeElement", { selector: ".nope" }), /No element matches/);
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
    world.ml.screenshot = async () => { throw new Error("element has zero size (hidden?)."); };
    const out = await world.ml.lookTool().run({ selector: ".gone" });
    assert.match(out, /^Error: element has zero size/);
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
