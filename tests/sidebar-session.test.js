// sidebar-session.test.js — the session LIST and one session's chat log: what groups into a single
// session, how its turns and follow-ups read, the composer and its usage gauge, and which model each
// reply is credited to.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { chatStart, chatResult, agentStart, agentStep, agentResult } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// --- the session list: what groups into one session, and what must not invent one ------------------------

test("sidebar mounts and shows the empty state", async () => {
    const w = await loadSidebarWorld();
    assert.ok(w.shadow, "shadow root mounted");
    assert.match(w.shadow.querySelector(".empty").textContent, /No ml calls yet/);
});

test("groups turns of one createChat into a single session (the item-1 fix)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("aaa", 0, "first"));
    await w.dispatch(chatResult("aaa", 0, "reply one"));
    await w.dispatch(chatStart("aaa", 1, "second"));       // same hash → same session, not a new block
    await w.dispatch(chatResult("aaa", 1, "reply two"));

    const rows = w.shadow.querySelectorAll(".row");
    assert.equal(rows.length, 1, "one session, not two blocks");

    rows[0].click();                                       // open the session
    await w.tick();
    const users = [...w.shadow.querySelectorAll(".msg.user .utext")].map(n => n.textContent);
    assert.deepEqual(users, ["first", "second"]);          // two turns, in order
    assert.equal(w.shadow.querySelectorAll(".msg.asst").length, 2);
});

test("status dot goes pending → ok, and a save:true call is tagged saved", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("ccc", 0, "hi", { save: true }));
    let row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".dot.pending"), "pending while in flight");
    assert.match(row.querySelector(".tag.saved").textContent, /saved/);

    await w.dispatch(chatResult("ccc", 0, "done", { save: true }));
    row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".dot.ok"), "ok after the result settles");
});

test("an error result marks the turn (and session) failed", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("ddd", 0, "boom"));
    await w.dispatch({ kind: "chat-error", id: "ddd-0", ts: Date.now(), save: false, session: { hash: "ddd", turn: 0 }, error: "HTTP 500" });
    assert.ok(w.shadow.querySelector(".row .dot.err"), "session shows error");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.err .errtext").textContent, /HTTP 500/);
});

// The empty state used to say only "run one in the console", which is half the truth — there is a keyboard
// shortcut. It must be the LIVE binding: it is user-rebindable, and naming a key that does nothing is worse
// than naming none.
test("empty state: offers the live HUD shortcut as key pills, or stays silent when unbound", async () => {
    const bound = await loadSidebarWorld({ invocation: { shortcut: "Alt+Space", defaultShortcut: "Alt+Space", isDefault: true, contextMenu: false } });
    await bound.flush();
    const txt = bound.shadow.querySelector(".empty").textContent;
    assert.match(txt, /Run one in the console/, "the console is still named");
    assert.match(txt, /or press/, "…and so is the shortcut");
    const keys = [...bound.shadow.querySelectorAll(".empty .key")].map((k) => k.textContent);
    assert.deepEqual(keys, ["Alt", "Space"], "rendered as separate keys, not the literal 'Alt+Space' string");

    // Cleared binding → mention nothing. Pointing at a dead key is worse than saying nothing.
    const unbound = await loadSidebarWorld({ invocation: { shortcut: "", defaultShortcut: "Alt+Space", isDefault: false, contextMenu: false } });
    await unbound.flush();
    assert.match(unbound.shadow.querySelector(".empty").textContent, /Run one in the console\./);
    assert.equal(unbound.shadow.querySelectorAll(".empty .key").length, 0, "no key offered when none is bound");
});

// A session may carry NO config — `ml.embed()` reports through the chat events and has none to speak of.
// Dereferencing it blanked the whole detail view: one absent field took the entire transcript with it, so
// clicking that session's bar in the event lane showed nothing at all.
test("a session with no config opens instead of blanking the view", async () => {
    const w = await loadSidebarWorld();
    const hash = "embedsess";
    await w.dispatch({ kind: "chat", id: "e1", ts: 1000, save: false, session: { hash, turn: 0 },
                       streaming: false, sessionKind: "embed", config: null,
                       request: { model: "nomic-embed-text", extend: null,
                                  messages: [{ role: "user", content: "embed 24 inputs" }],
                                  images: null, toolIds: null, schema: false, think: null, maxTokens: null } });
    await w.dispatch({ kind: "chat-result", id: "e1", ts: 1400, save: false, session: { hash, turn: 0 },
                       content: "24 vectors · 1024 dimensions", sources: null, structured: false,
                       model: "nomic-embed-text", extend: null, reasoning: null,
                       usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, genMs: 400 } });

    w.shadow.querySelector(".row").click();
    await w.tick();

    // The transcript is THERE — the failure was a blank view, not a missing options block.
    const body = w.shadow.body.innerHTML;
    assert.match(body, /24 vectors/, "the session's own content renders");

    // …and it renders as a list of CALLS, not a conversation: an embed reports through the chat events, but
    // drawing it as user/assistant bubbles presents a request for vectors as something somebody said.
    assert.equal(w.shadow.querySelectorAll(".embed-call").length, 1, "one row per embed call");
    assert.equal(w.shadow.querySelectorAll(".msg.user, .msg.asst").length, 0, "no chat bubbles");
    assert.match(w.shadow.querySelector(".embed-call").textContent, /embed 24 inputs/, "what went in");
    assert.match(w.shadow.querySelector(".embed-call").textContent, /24 vectors/, "…and what came back");
    assert.match(w.shadow.querySelector(".embed-call").textContent, /400ms/, "…and how long it took");
});

// --- a session's chat log: turns, follow-ups, images and the multi-turn order ----------------------------

test("detail shows the options-first-message and renders assistant markdown with a raw toggle", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("bbb", 0, "q", { model: "qwen", system: "be terse" }));
    await w.dispatch(chatResult("bbb", 0, "# Title\n**bold** text"));
    w.shadow.querySelector(".row").click();
    await w.tick();

    w.shadow.querySelector(".block .block-head").click();  // options is collapsed by default
    await w.tick();
    const opts = w.shadow.querySelector(".block .opts");   // the "first message" = options
    assert.match(opts.textContent, /model: qwen/);
    assert.match(opts.textContent, /system: be terse/);

    const md = w.shadow.querySelector(".msg.asst .md");    // markdown rendered by default
    assert.match(md.innerHTML, /<h1>Title<\/h1>/);
    assert.match(md.innerHTML, /<strong>bold<\/strong>/);

    w.shadow.querySelector(".msg.asst .raw-btn").click();  // toggle → raw
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst .code").textContent, /\*\*bold\*\*/);
});

test("agent session: a pasted task image + a follow-up (say) image render as thumbnails in the chat log", async () => {
    const w = await loadSidebarWorld();
    const IMG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA";
    const IMG2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgBB";
    await w.dispatch({ ...agentStart("imgs", "look at this"), images: [IMG1] });
    await w.dispatch(agentResult("imgs", "seen it", 0));
    // a follow-up turn (agent-say) with its OWN pasted image
    await w.dispatch({ kind: "agent-say", id: "imgs", ts: Date.now() + 5, save: false, session: { hash: "imgs", turn: 0 }, text: "and this?", images: [IMG2] });
    await w.dispatch(agentResult("imgs", "seen that too", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    // As tiles UNDER the bubble (SentImages), each the image itself, not a copy.
    const srcs = [...w.shadow.querySelectorAll(".sent-tiles img")].map(i => i.getAttribute("src"));
    assert.equal(w.shadow.querySelectorAll(".msg.user img").length, 0, "the bubble holds only the text");
    assert.ok(srcs.includes(IMG1), "the pasted task image is shown in the conversation");
    assert.ok(srcs.includes(IMG2), "the follow-up (say) image is shown too");
});

test("a result arriving while the detail view is OPEN re-renders it live (no stale …thinking)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("eee", 0, "q"));
    w.shadow.querySelector(".row").click();                 // open detail while the turn is pending
    await w.tick();
    assert.ok(w.shadow.querySelector(".msg.asst .pending-note"), "shows …thinking while pending");

    await w.dispatch(chatResult("eee", 0, "the answer"));   // result lands WITHOUT re-navigating
    assert.ok(!w.shadow.querySelector(".pending-note"), "…thinking cleared live");
    assert.match(w.shadow.querySelector(".msg.asst .md").innerHTML, /the answer/);
});

test("agent runs render as their own session with steps + a final answer", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag1", "find the login button", "qwen3:14b"));
    await w.dispatch(agentStep("ag1", 1, { thought: "Let me look at the page" }));
    await w.dispatch(agentStep("ag1", 1, { tool: "look", arguments: { selector: "nav" }, result: "a top navigation bar", elements: 1 }));
    await w.dispatch(agentResult("ag1", "The login button is top-right.", 2));

    const row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".agent-badge"), "row shows the agent badge");
    assert.match(row.querySelector(".row-title").textContent, /find the login button/);

    row.click();
    await w.tick();
    // Both steps are turn 1 → grouped into one turn card (thought + the tool call).
    assert.equal(w.shadow.querySelectorAll(".aturn").length, 1, "one turn group");
    assert.match(w.shadow.querySelector(".step-pill").textContent, /step 1\/10/, "turn pill shows step/max");
    assert.ok(w.shadow.querySelector(".aturn-prose"), "the turn's prose (content) is shown");
    const toolStep = w.shadow.querySelector(".astep.tool");
    assert.match(toolStep.querySelector(".tool-name").textContent, /look/);
    assert.match(toolStep.querySelector(".el-count").textContent, /1 el/);
    // Collapsed by default → shows a one-line preview of the result.
    assert.match(toolStep.querySelector(".astep-preview").textContent, /top navigation/);

    // Expand → In: args + Out: result.
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    assert.match(toolStep.textContent, /selector/, "In: shows the args");
    assert.match(toolStep.textContent, /top navigation/, "Out: shows the result");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /login button is top-right/);
    // The merged reply bubble: a model chip + a raw⇄nice toggle, like a chat reply.
    assert.ok(w.shadow.querySelector(".msg.asst .model-name"), "answer shows the model chip");
    assert.ok(w.shadow.querySelector(".msg.asst .raw-btn"), "answer has a raw toggle");
});

test("agent session renders as a multi-turn CHAT LOG: user messages + BOTH answers, no overwrite; live cap", async () => {
    const w = await loadSidebarWorld();
    const H = "ag-multi";
    // Turn 1: task → a tool step → answer 1.
    await w.dispatch(agentStart(H, "Tell me about yourself?", "gemma4:31b", 10));
    await w.dispatch(agentStep(H, 1, { tool: "exec", arguments: { js: "1" }, result: "r1" }));
    await w.dispatch(agentResult(H, "I am an automation agent.", 1));
    // A follow-up user message (run() again) — emitted as agent-say, like a mid-run say.
    await w.dispatch({ kind: "agent-say", id: H, ts: Date.now() + 5, save: false, session: { hash: H, turn: 0 }, text: "Which model are you?" });
    // Turn 2: a step with a FRESH step number (2, the page offsets it) → answer 2. Raise the cap mid-run.
    await w.dispatch({ kind: "agent-cap", id: H, ts: Date.now() + 6, save: false, session: { hash: H, turn: 0 }, maxSteps: 40 });
    await w.dispatch(agentStep(H, 2, { tool: "exec", arguments: { js: "ml.getModel()" }, result: "gemma4:31b" }));
    await w.dispatch(agentResult(H, "I am running on gemma4:31b.", 2));

    w.shadow.querySelector(".row").click();
    await w.tick();
    // Two turn groups — turn 2's step did NOT merge into turn 1 (the "historical steps overwritten" bug).
    assert.equal(w.shadow.querySelectorAll(".aturn").length, 2, "each turn is its own group (no merge)");
    // Every user message is a plain "you" bubble (task + follow-up unified — nothing distinguishes them).
    const users = [...w.shadow.querySelectorAll(".msg.user")];
    assert.ok(users.every(u => u.querySelector(".who").textContent.trim() === "you"), "user messages are unified as 'you'");
    const userText = users.map(u => u.querySelector(".utext").textContent).join(" | ");
    assert.match(userText, /Tell me about yourself\?/);
    assert.match(userText, /Which model are you\?/, "the follow-up user message shows up");
    // BOTH answers render (appended to the chat log, not overwritten).
    const answers = [...w.shadow.querySelectorAll(".msg.asst")].map(a => a.textContent).join(" | ");
    assert.match(answers, /I am an automation agent\./, "turn 1's answer is kept");
    assert.match(answers, /I am running on gemma4:31b\./, "turn 2's answer is appended");
    // The live cap bump is reflected.
    assert.ok([...w.shadow.querySelectorAll(".step-pill")].some(p => /\/40/.test(p.textContent)), "the live maxSteps bump shows (step x/40)");
});

test("agent chat log orders answers + follow-ups by TIME when they share a step (no-tool turns)", async () => {
    // The DevTools/HUD ordering bug: a turn that runs NO tool steps (a plain chat-style reply, or a cancel)
    // keeps the prior step count, so its answer AND the next follow-up prompt land at the SAME atStep. The old
    // fixed "answer-before-say" fraction then shoved ALL answers ahead of ALL says regardless of when they
    // happened. Real chronology (ts) must win. Timeline: answer1(+100) → say(+150) → answer2(+200), all @ step 1.
    const w = await loadSidebarWorld();
    const H = "chatorder";
    await w.dispatch(agentStart(H, "read the code", "m", 20));
    await w.dispatch(agentStep(H, 1, { tool: "sampleText", arguments: {}, result: "SHDW-7788" }));
    await w.dispatch({ kind: "agent-result", id: H, ts: Date.now() + 100, save: false, session: { hash: H, turn: 1 }, summary: "The code is SHDW-7788.", steps: 1 });
    await w.dispatch({ kind: "agent-say", id: H, ts: Date.now() + 150, save: false, session: { hash: H, turn: 1 }, text: "thanks, what about cats?" });
    // Turn 2 answers with NO tool step (chat-style) → its atStep stays 1, same as answer1 + the say.
    await w.dispatch({ kind: "agent-result", id: H, ts: Date.now() + 200, save: false, session: { hash: H, turn: 1 }, summary: "Cats are great." });
    w.shadow.querySelector(".row").click();
    await w.tick();
    // The rendered order must be answer1 → say → answer2 (by ts), NOT answer1 → answer2 → say.
    const html = [...w.shadow.querySelectorAll(".msg")].map(m => m.textContent).join(" ||| ");
    const iA1 = html.indexOf("The code is SHDW-7788");
    const iSay = html.indexOf("what about cats");
    const iA2 = html.indexOf("Cats are great");
    assert.ok(iA1 >= 0 && iSay >= 0 && iA2 >= 0, "all three messages render");
    assert.ok(iA1 < iSay, "the first answer precedes the follow-up prompt (by time)");
    assert.ok(iSay < iA2, "the follow-up prompt precedes the second answer (not shoved below both answers)");
});

test("detail: an assistant reply collapses to its first line and expands again", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("col", 0, "q"));
    await w.dispatch(chatResult("col", 0, "First line here\n\nSecond paragraph with more detail."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".msg.asst .md"), "expanded by default");

    w.shadow.querySelector(".who-toggle").click();              // collapse
    await w.tick();
    assert.ok(!w.shadow.querySelector(".msg.asst .md"), "markdown hidden when collapsed");
    const c = w.shadow.querySelector(".asst-collapsed");
    assert.match(c.textContent, /First line here/);
    assert.ok(!/Second paragraph/.test(c.textContent), "only the first line shows");
    assert.ok(c.querySelector(".more"), "trailing … since content is hidden");

    w.shadow.querySelector(".who-toggle").click();              // expand again
    await w.tick();
    assert.ok(w.shadow.querySelector(".msg.asst .md"), "markdown back after expand");
});

// --- assistant prose: markdown, GFM tables and KaTeX math ------------------------------------------------

test("assistant markdown renders a GFM table (aligned, XSS-safe); a lone pipe stays a paragraph", async () => {
    const w = await loadSidebarWorld();
    const md = [
        "| Name | Score |",
        "| :--- | ---: |",
        "| <script>alert(1)</script> | 10 |",
        "| **Ada** | 20 |",
        "",
        "Just a | pipe in a paragraph.",
    ].join("\n");
    await w.dispatch(chatStart("ttt", 0, "q"));
    await w.dispatch(chatResult("ttt", 0, md));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const body = w.shadow.querySelector(".msg.asst .md");
    const table = body.querySelector("table.md-table");
    assert.ok(table, "GFM table rendered as a real <table>");
    const th = [...table.querySelectorAll("thead th")];
    assert.deepEqual(th.map(n => n.textContent), ["Name", "Score"], "header cells → <th>");
    assert.equal(th[0].style.textAlign, "left", "separator :--- → left align");
    assert.equal(th[1].style.textAlign, "right", "separator ---: → right align");

    const rows = table.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2, "two body rows → <td>");
    assert.ok(rows[1].querySelector("strong"), "inline() runs on cells (**Ada** → <strong>)");

    // XSS: a <script> in a cell is escaped text, never live HTML.
    assert.ok(!body.querySelector("script"), "no live <script> from a cell");
    assert.match(body.innerHTML, /&lt;script&gt;/, "script tag escaped, not rendered");

    // A pipe outside a table header/separator pair stays an ordinary paragraph.
    const ps = [...body.querySelectorAll("p")].map(n => n.textContent);
    assert.ok(ps.includes("Just a | pipe in a paragraph."), "lone pipe line → <p>, not a table");
});

test("assistant markdown renders LaTeX math via KaTeX ($…$ inline, $$…$$ display); currency/prose isn't math", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("math", 0, "q"));
    await w.dispatch(chatResult("math", 0, "Inline $6 \\times 7 = 42$ and display:\n$$E = mc^2$$\nIt costs $5 or $10."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const body = w.shadow.querySelector(".msg.asst .md");
    const kx = body.querySelectorAll(".katex");
    assert.ok(kx.length >= 2, "both the inline (has \\times) and display math rendered as KaTeX");
    assert.ok(body.querySelector(".katex-display"), "the $$…$$ block is display mode");
    // Currency ("$5 or $10") is NOT treated as math (the space-inside guard).
    assert.match(body.textContent, /It costs \$5 or \$10\./, "currency stays literal, not math");
});

test("inline $…$ follows the delimiter rule: currency stays literal; a rare paired-prose span is the accepted edge case", async () => {
    // We render inline `$…$` by the standard Pandoc/KaTeX DELIMITER rule (space-adjacency), not a content
    // sniff — so spaced math like `$r = 2$` typesets (see tests/format.test.mjs). The accepted cost is that a
    // rare prose span pairing two `$` around spaced text (`($k)". … ($k)`) renders as math. CURRENCY still
    // stays literal, because the closing `$` is preceded by a space / has no valid close.
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("cur", 0, "q"));
    await w.dispatch(chatResult("cur", 0, "The item costs $5 or $10 depending."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const body = w.shadow.querySelector(".msg.asst .md");
    assert.equal(body.querySelector(".katex"), null, "currency is not math (space-adjacency guard)");
    assert.match(body.textContent, /costs \$5 or \$10 depending/, "currency prose stays literal");
});

test("thinking: a reply with reasoning shows a collapsed thinking block; without it, none", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("th", 0, "q"));
    await w.dispatch(chatResult("th", 0, "the answer", { reasoning: "let me consider the options carefully" }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const think = w.shadow.querySelector(".msg.asst details.thinking");
    assert.ok(think, "thinking disclosure present");
    assert.ok(!think.open, "collapsed by default");
    assert.match(think.textContent, /consider the options/);

    // A reply with no reasoning has no thinking block.
    await w.dispatch(chatStart("th2", 0, "q2"));
    await w.dispatch(chatResult("th2", 0, "plain answer"));
    w.shadow.querySelector(".nav").click();                     // back to list
    await w.tick();
    [...w.shadow.querySelectorAll(".row")].find(r => /q2/.test(r.textContent))?.click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".msg.asst details.thinking"), null, "no thinking block without reasoning");
});

// --- the composer and its usage gauge --------------------------------------------------------------------

test("composer usage gauge: fills against the loaded model's context window (occupancy = latest turn, not a sum)", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 1000, expiresAt: null }],
    });
    // Two turns on the same resident model. Each turn's promptTokens already includes
    // the prior turn (the whole history is re-sent), so occupancy is the LAST turn's
    // prompt+completion (250+50=300 → 30% of 1000), NOT 100+250 summed.
    await w.dispatch(chatStart("uuu", 0, "hi", { model: "gemma4:31b" }));
    await w.dispatch(chatResult("uuu", 0, "a", { model: "gemma4:31b", usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 } }));
    await w.dispatch(chatStart("uuu", 1, "more", { model: "gemma4:31b" }));
    await w.dispatch(chatResult("uuu", 1, "b", { model: "gemma4:31b", usage: { promptTokens: 250, completionTokens: 50, totalTokens: 300 } }));
    await w.raw({ __mlSidebarOpen: true });   // shell open → pollPs allowed to fetch the ps set (denominator)
    w.shadow.querySelector(".row").click();   // open the session (a detail view triggers a poll)
    await w.tick(); await w.flush();          // let the ps poll populate loadedModels

    const gauge = w.shadow.querySelector(".usage-gauge");
    assert.ok(gauge, "gauge renders in the composer");
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /30%/, "occupancy is the latest turn (300/1000), not the sum");
    assert.ok(w.shadow.querySelector(".usage-fill"), "has a fill bar");
});

test("composer usage gauge: a DEFAULT session (no requested model) uses the RESOLVED model's window", async () => {
    // Regression: a plain ml.chat() has request.model === null (s.model null), but the
    // reply resolved to a resident model. The gauge must look up the RESOLVED model
    // (like the header), not s.model — else it wrongly falls back to cumulative spend.
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 1000, expiresAt: null }],
    });
    await w.dispatch(chatStart("dfl", 0, "hi", { model: null }));                       // caller named no model
    await w.dispatch(chatResult("dfl", 0, "a", { model: "gemma4:31b", usage: { promptTokens: 250, completionTokens: 50, totalTokens: 300 } }));  // resolved server-side
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    assert.ok(w.shadow.querySelector(".usage-pct"), "a % gauge (not the cumulative fallback)");
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /30%/, "measured against the resolved model's 1000-token window");
});

test("composer usage gauge: a utility-profile session measures against the UTILITY model's (small) window", async () => {
    // extend:"utility" also sends request.model === null, but resolves server-side to
    // the utility model — often loaded with a small utilityNumCtx. The gauge must use
    // that resolved model's window (here 4096), same shownModel path as the header.
    const w = await loadSidebarWorld({
        sync: { model: "gemma4:31b", utilityModel: "gemma4:e2b" },
        vram: [
            { model: "gemma4:31b", vramGB: 21, contextLength: 262144, expiresAt: null },
            { model: "gemma4:e2b", vramGB: 0, sizeGB: 6.8, contextLength: 4096, expiresAt: null },   // utility, small ctx, on CPU
        ],
    });
    await w.dispatch(chatStart("utl", 0, "summarise", { model: null, extend: "utility" }));
    await w.dispatch(chatResult("utl", 0, "sum", { model: "gemma4:e2b", extend: "utility", usage: { promptTokens: 1948, completionTokens: 100, totalTokens: 2048 } }));
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    // 2048 / 4096 = 50% — measured against the UTILITY window, NOT the 262K main model.
    assert.ok(w.shadow.querySelector(".usage-pct"), "a % gauge against the utility window");
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /50%/, "utility model's 4096 window, not the main model's 262K");
});

test("composer usage gauge: an unknown-window model shows RAW OCCUPANCY (last turn), not a cumulative sum", async () => {
    const w = await loadSidebarWorld({ vram: [] });   // never resident → no contextLength denominator, ever
    await w.dispatch(chatStart("ccl", 0, "hi", { model: "gpt-cloud" }));
    await w.dispatch(chatResult("ccl", 0, "a", { model: "gpt-cloud", usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 } }));
    await w.dispatch(chatStart("ccl", 1, "more", { model: "gpt-cloud" }));
    await w.dispatch(chatResult("ccl", 1, "b", { model: "gpt-cloud", usage: { promptTokens: 250, completionTokens: 50, totalTokens: 300 } }));
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    assert.ok(!w.shadow.querySelector(".usage-pct"), "no percentage without a known window");
    // Occupancy = the LAST turn's prompt+completion = 250+50 = 300 — NOT the 400 sum
    // (summing double-counts the re-sent history). Same numerator as the % branch.
    const total = w.shadow.querySelector(".usage-total").textContent;
    assert.match(total, /300/, "raw occupancy = latest turn");
    assert.ok(!/400/.test(total), "not the cumulative sum");
});

test("composer usage gauge: an EVICTED model keeps its % (remembers the window it was seen at)", async () => {
    // First poll sees gemma4:31b resident at 262144; a later poll finds it gone. The
    // gauge must keep showing occupancy% against the remembered window, not flip to a
    // raw count — a model's window is a property of the model, not of residency.
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 262144, expiresAt: null }] });
    await w.dispatch(chatStart("evi", 0, "hi", { model: "gemma4:31b" }));
    await w.dispatch(chatResult("evi", 0, "a", { model: "gemma4:31b", usage: { promptTokens: 5000, completionTokens: 240, totalTokens: 5240 } }));
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();
    assert.ok(w.shadow.querySelector(".usage-pct"), "shows a % while resident");

    // Model evicted → ps now empty. Re-poll and re-render.
    w.setVram([]);
    await w.flush(); await w.tick();
    assert.ok(w.shadow.querySelector(".usage-pct"), "STILL a % after eviction (window remembered)");
    assert.ok(!w.shadow.querySelector(".usage-total"), "did not flip to a raw-count fallback");
});

test("composer usage gauge: absent until the server reports token counts", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("non", 0, "hi"));
    await w.dispatch(chatResult("non", 0, "a"));   // no usage on the result
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".composer"), "the composer still renders");
    assert.ok(!w.shadow.querySelector(".usage-gauge"), "but no gauge without any usage data");
    assert.ok(!w.shadow.querySelector(".cinput").disabled, "the input is live (you can continue any session)");
    assert.ok(w.shadow.querySelector(".csend").disabled, "the send button is disabled while the box is empty");
});

test("composer: typing enables Send and posts sessionSend; an empty box on a running session is the Stop button", async () => {
    const w = await loadSidebarWorld();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);   // capture what the app posts to its parent (shell/panel)

    // A finished chat session — the common case: continue the conversation with another turn.
    await w.dispatch(chatStart("cmp", 0, "hi"));
    await w.dispatch(chatResult("cmp", 0, "hello"));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const input = w.shadow.querySelector(".cinput");
    const btn = w.shadow.querySelector(".cbtn.csend, .cbtn.cstop");
    assert.ok(btn.classList.contains("csend") && btn.disabled, "idle + empty → a disabled Send");

    input.value = "and another thing";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    assert.ok(!w.shadow.querySelector(".csend").disabled, "typing enables Send");
    w.shadow.querySelector(".csend").click();
    await w.tick();
    const sent = posted.find(m => m.__mlSidebarApp === "sessionSend");
    assert.ok(sent && sent.hash === "cmp" && sent.text === "and another thing", "Send posts sessionSend {hash,text}");
    assert.equal(w.shadow.querySelector(".cinput").value, "", "the box clears after sending");

    // A RUNNING session with an empty box → the button becomes Stop and posts sessionCancel.
    await w.dispatch(chatStart("cmp", 1, "next"));   // in-flight (no result yet) → status pending
    await w.tick();
    const stop = w.shadow.querySelector(".cbtn.cstop");
    assert.ok(stop, "running + empty box → the Send button becomes Stop");
    stop.click();
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarApp === "sessionCancel" && m.hash === "cmp"), "Stop posts sessionCancel");
});

test("composer: Enter NEVER cancels a run — only the Stop button does (empty Enter is a no-op)", async () => {
    const w = await loadSidebarWorld();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.dispatch(chatStart("cmp", 0, "hi"));
    await w.dispatch(chatResult("cmp", 0, "hello"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    // In-flight + empty box → the button is Stop (the state where Enter used to wrongly cancel).
    await w.dispatch(chatStart("cmp", 1, "next"));
    await w.tick();
    const input = w.shadow.querySelector(".cinput");
    assert.ok(w.shadow.querySelector(".cbtn.cstop"), "running + empty → Stop button");
    const enter = () => input.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    posted.length = 0;
    enter();
    await w.tick();
    assert.ok(!posted.some(m => m.__mlSidebarApp === "sessionCancel"), "Enter on an empty running box does NOT cancel the run");
    assert.ok(!posted.some(m => m.__mlSidebarApp === "sessionSend"), "and sends nothing (the box is empty)");

    // Enter WITH text sends — and still never cancels.
    input.value = "steer left";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    enter();
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarApp === "sessionSend" && m.text === "steer left"), "Enter with text posts sessionSend");
    assert.ok(!posted.some(m => m.__mlSidebarApp === "sessionCancel"), "and never cancels");
});

// --- whose model answered: provenance tags and auto-titles -----------------------------------------------

test("provenance: a utility-profile call shows the resolved model in the row, header, and per-reply chip", async () => {
    const w = await loadSidebarWorld();
    // extend:"utility" → the client-side request.model is null, but the server
    // resolves + reports the real model on the result.
    await w.dispatch(chatStart("prov", 0, "summarise this", { model: null }));
    await w.dispatch(chatResult("prov", 0, "a title", { model: "qwen3:0.5b", extend: "utility" }));

    const row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".profile"), "row shows the utility badge");
    assert.equal(row.querySelector(".model"), null, "the model name is not shown in the list row");

    row.click();
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /qwen3:0\.5b/, "header shows the model that responds next");
    assert.match(w.shadow.querySelector(".head .profile").textContent, /utility/, "header carries the (utility) tag too");
    // The reply carries a click-to-copy model chip + a (utility) tag.
    const chip = w.shadow.querySelector(".msg.asst .model-name");
    assert.equal(chip.textContent, "qwen3:0.5b", "per-reply chip shows the resolved model");
    assert.match(w.shadow.querySelector(".msg.asst .profile-inline").textContent, /utility/, "per-reply (utility) tag");
});

test("provenance: a pending turn resolves its model from the config (not 'default')", async () => {
    const w = await loadSidebarWorld({ sync: { model: "gemma4:31b", utilityModel: "qwen3:0.5b" } });
    // Two just-created (still pending) turns — no results yet.
    await w.dispatch(chatStart("pend", 0, "hi", { model: null }));                    // default profile
    await w.dispatch(chatStart("pendu", 0, "hi", { model: null, extend: "utility" })); // utility profile

    // Rows are newest-first: pendu (utility) then pend (default). The header resolves
    // a still-pending turn's model from config (not "default") — the list row no
    // longer shows a model at all.
    const rows = [...w.shadow.querySelectorAll(".row")];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(".model"), null, "no model in the row");

    rows[1].click();   // pend (default), older → second
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /gemma4:31b/, "pending default resolves to the configured model");
    assert.match(w.shadow.querySelector(".head .profile").textContent, /default/);

    w.shadow.querySelector('[aria-label="Back to sessions"]').click();
    await w.tick();
    [...w.shadow.querySelectorAll(".row")][0].click();   // pendu (utility), newest → first
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /qwen3:0\.5b/, "pending utility resolves to the utility model");
    assert.match(w.shadow.querySelector(".head .profile").textContent, /utility/);
});

test("provenance: an explicitly-requested model gets no (default)/(utility) tag", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("exp", 0, "hello", { model: "llama3:70b" }));
    await w.dispatch(chatResult("exp", 0, "hi", { model: "llama3:70b", extend: null }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".msg.asst .model-name").textContent, "llama3:70b");
    assert.equal(w.shadow.querySelector(".msg.asst .profile-inline"), null, "no profile tag when the model was explicit");
});

test("provenance: a default-resolved reply is tagged (default)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("def", 0, "hello", { model: null }));
    await w.dispatch(chatResult("def", 0, "hi", { model: "default-model", extend: null }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst .profile-inline").textContent, /default/);
});

test("agent run: its session auto-titles via the utility model, from the task (parity with chat)", async () => {
    const w = await loadSidebarWorld({
        sync: { utilityModel: "u", autoTitles: true },
        fetchLlm: (payload) => ({ data: payload && payload.extend === "utility" ? "Find Login Button" : "OK" }),
    });
    await w.raw({ __mlSidebarOpen: true });     // titles only generate while the panel is open (like chat)
    await w.dispatch(agentStart("agt", "find the login button somewhere on this page", "m"));
    await w.dispatch(agentResult("agt", "top-right", 1));
    await w.flush();
    assert.match(w.shadow.querySelector(".row .row-title").textContent, /Find Login Button/, "the agent session got a utility-model title, not the raw task");
});

test("agent run: no utility model → the session keeps the raw task as its title (no phantom call)", async () => {
    let called = false;
    const w = await loadSidebarWorld({ sync: { utilityModel: "", autoTitles: true }, fetchLlm: () => { called = true; return { data: "X" }; } });
    await w.raw({ __mlSidebarOpen: true });
    await w.dispatch(agentStart("agt2", "read the invoice total", "m"));
    await w.dispatch(agentResult("agt2", "$42", 1));
    await w.flush();
    assert.match(w.shadow.querySelector(".row .row-title").textContent, /read the invoice total/, "falls back to the task");
    assert.equal(called, false, "no utility model → no title request fired");
});

test("session titles: summarises the first prompt via the utility model when the panel is open", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ sync: { utilityModel: "qwen3:0.5b" }, fetchLlm: (p) => { calls.push(p); return { data: '"Reverse a linked list."' }; } });
    await w.raw({ __mlSidebarOpen: true });                          // panel slid open → titles allowed
    await w.dispatch(chatStart("t1", 0, "how do I reverse a linked list in rust"));
    await w.dispatch(chatResult("t1", 0, "Here's how…"));
    await w.flush();

    const titleCall = calls.find(c => c.extend === "utility");
    assert.ok(titleCall, "title generated through extend:'utility'");
    // cleanTitle strips the wrapping quotes + trailing period the model returned.
    assert.equal(w.shadow.querySelector(".row-title").textContent, "Reverse a linked list");
});

test("session titles: no summary while the panel is slid closed (falls back to the prompt)", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ sync: { utilityModel: "qwen3:0.5b" }, fetchLlm: (p) => { calls.push(p); return { data: "Should not be used" }; } });
    // no __mlSidebarOpen received → closed → titles must not generate
    await w.dispatch(chatStart("t2", 0, "some request text here"));
    await w.dispatch(chatResult("t2", 0, "reply"));
    await w.flush();

    assert.ok(!calls.some(c => c.extend === "utility"), "no title call while closed");
    assert.match(w.shadow.querySelector(".row-title").textContent, /some request text here/);
});

test("session titles: skipped when autoTitles is turned off in settings", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ sync: { utilityModel: "qwen3:0.5b", autoTitles: false }, fetchLlm: (p) => { calls.push(p); return { data: "nope" }; } });
    await w.raw({ __mlSidebarOpen: true });
    await w.dispatch(chatStart("noauto", 0, "some request text here"));
    await w.dispatch(chatResult("noauto", 0, "reply"));
    await w.flush();

    assert.ok(!calls.some(c => c.extend === "utility"), "no title call when autoTitles is off");
    assert.match(w.shadow.querySelector(".row-title").textContent, /some request text here/);
});

test("session titles: skipped entirely when no utility model is configured (opt-in)", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ fetchLlm: (p) => { calls.push(p); return { data: "unwanted" }; } });  // no utilityModel
    await w.raw({ __mlSidebarOpen: true });                          // open, but still opt-out
    await w.dispatch(chatStart("t3", 0, "some request text here"));
    await w.dispatch(chatResult("t3", 0, "reply"));
    await w.flush();

    assert.ok(!calls.some(c => c.extend === "utility"), "no title call without a utility model");
    assert.match(w.shadow.querySelector(".row-title").textContent, /some request text here/);
});
