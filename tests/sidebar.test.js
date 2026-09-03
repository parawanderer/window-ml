const { test, after } = require("node:test");
const assert = require("node:assert");
const { loadSidebarWorld, closeSidebarWorlds } = require("./helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// Build __mlDebug events like injected.js emits them (see contract.ts).
const chatStart = (hash, turn, user, opts = {}) => ({
    kind: "chat", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, streaming: false,
    request: {
        // Explicit null passes through (caller didn't name a model → default/utility).
        model: "model" in opts ? opts.model : "m",
        extend: opts.extend ?? null,
        messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: user }],
        images: opts.images || null, toolIds: null, schema: false, think: null, maxTokens: null
    },
    config: {
        system: opts.system || null, model: opts.model || "m", think: opts.think ?? null,
        schema: false, toolIds: null, maxTokens: null, save: !!opts.save
    }
});
const chatResult = (hash, turn, content, opts = {}) => ({
    kind: "chat-result", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, content, sources: opts.sources || null, structured: !!opts.structured,
    model: opts.model ?? null, extend: opts.extend ?? null, reasoning: opts.reasoning ?? null,
    usage: opts.usage ?? null
});
// ml.agent run events (see contract.ts DebugAgent*).
const agentStart = (hash, task, model = "m", maxSteps = 10, config = null) => ({ kind: "agent", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, task, model, maxSteps, config });
const agentStep = (hash, step, fields) => ({ kind: "agent-step", id: hash, ts: Date.now() + step, save: false, session: { hash, turn: step }, step, ...fields });
const agentResult = (hash, summary, steps, hitCap = false) => ({ kind: "agent-result", id: hash, ts: Date.now() + 100, save: false, session: { hash, turn: steps }, summary, steps, hitCap });

// Open the settings panel and optionally switch to a category tab (Connection /
// Models / Appearance / Advanced). Controls are grouped under tabs, so a test that
// touches e.g. the model fields must select the "Models" tab first.
const openSettings = async (w, tab) => {
    w.shadow.querySelector('[aria-label="Settings"]').click();
    await w.tick();
    if (tab) {
        [...w.shadow.querySelectorAll(".set-tab")].find(b => b.textContent.trim() === tab).click();
        await w.tick();
    }
};

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
    const srcs = [...w.shadow.querySelectorAll(".msg.user img")].map(i => i.getAttribute("src"));
    assert.ok(srcs.includes(IMG1), "the pasted task image is shown in the conversation");
    assert.ok(srcs.includes(IMG2), "the follow-up (say) image is shown too");
});

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

test("agent run: a straggler pending step (late in-flight START after the result) can't re-show a finished run as running", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bg1", "do the thing"));
    await w.dispatch(agentStep("bg1", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "found: x" }));
    await w.dispatch(agentResult("bg1", "All done — found x.", 1));   // seals the turn → status ok

    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "finished run: no running footer");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /All done/, "the final answer shows");

    // A background-hosted run's in-flight tool fans a LATE pending START for the NEXT step AFTER the result —
    // the cross-page / cancel straggler. Its DONE never comes (the run already ended). It must NOT flip the
    // finished run back to "running" (the "task's done but the sidebar still says running" bug).
    await w.dispatch(agentStep("bg1", 2, { seq: 2, pending: true, tool: "look", arguments: {} }));
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "a straggler pending START does NOT re-open the finished run");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /All done/, "the final answer still shows");
});

// Cross-page re-adoption REPLAYS the run's start + steps while the live agent-result fans separately, with no
// ordering guarantee. onDebug must converge to the SAME finished state for every interleaving — otherwise a
// completed cross-domain run shows "running" with no answer (the exact bug). These pin the two nasty orders.
test("agent run: an ORPHAN step/result (no `agent` start) does NOT manufacture a phantom '(no prompt)' session", async () => {
    const w = await loadSidebarWorld();
    // A stray step for a hash we never saw a start for (a DevTools ring-buffer that evicted the start, or a
    // mis-tagged event). It must NOT create a headless "(no prompt)" session stuck "In flight" (the multi-run
    // ghost-session bug). The event is HELD, not dropped.
    await w.dispatch(agentStep("orphan", 1, { seq: 1, tool: "look", arguments: {}, result: "saw the page" }));
    await w.dispatch(agentResult("orphan", "some answer", 1));
    await w.tick();
    assert.ok(w.shadow.querySelector(".empty"), "no phantom session — the list is still empty");
    assert.equal(w.shadow.querySelectorAll(".row").length, 0);
    // …but if the START later arrives (the cross-page replay race), the queued events are applied in order.
    await w.dispatch(agentStart("orphan", "look at the page and answer"));
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".row").length, 1, "the start materialises the real session");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /some answer/, "the queued result was applied");
    assert.ok(!w.shadow.querySelector(".pending-note"), "and it reads DONE (the queued result sealed it)");
});

// --- button #3: "Approve + remember" — clickability in BOTH surfaces (sidebar step + HUD card) ---

const grantStep = (hash) => agentStep(hash, 1, {
    seq: 1, pending: true, awaitingApproval: true, tool: "exec",
    arguments: { js: 'await ml.fetch("https://x.test/a.json"); await ml.fetch("https://x.test/b.json")' },
    grants: [{ kind: "fetch-url", urls: ["https://x.test/a.json", "https://x.test/b.json"] }],
});

test("button #3 (sidebar step): 'Approve + remember' renders, unfurls its URLs, and posts persist:true", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("b3s", "fetch stuff"));
    await w.dispatch(grantStep("b3s"));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const remember = w.shadow.querySelector(".astep-approve .appr-btn.remember");
    assert.ok(remember, "the short 'Keep' button rendered on the awaiting step");
    assert.match(remember.textContent, /keep/i);
    // The collapsed grant card summarises deterministically and lists EXACTLY the URLs that persist.
    const grant = w.shadow.querySelector(".astep-approve .appr-grant");
    assert.ok(grant, "the grant card rendered");
    assert.match(grant.querySelector(".appr-grant-sum").textContent, /fetch 2 URLs.*without approval/i, "explains the grant in plain terms");
    const urls = [...grant.querySelectorAll(".grant-url-list code")].map(n => n.textContent);
    assert.deepEqual(urls, ["https://x.test/a.json", "https://x.test/b.json"], "the exact two literals");

    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    remember.click();
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(msg, "clicking posts an approval message");
    assert.equal(msg.decision, true, "it approves");
    assert.equal(msg.persist, true, "…and asks to persist (button #3)");
    assert.equal(msg.hash, "b3s");
    assert.equal(msg.seq, 1);
});

test("button #3 (sidebar step): plain Approve posts persist:false (one-off)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("b3s2", "fetch stuff"));
    await w.dispatch(grantStep("b3s2"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    // The plain Approve is the .yes button that is NOT .remember.
    const approve = [...w.shadow.querySelectorAll(".astep-approve .appr-btn.yes")].find(b => !b.classList.contains("remember"));
    approve.click();
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.equal(msg.decision, true);
    assert.equal(msg.persist, false, "plain Approve does NOT persist");
});

test("host access (fetch_url): a first-time origin shows the note; approving requests that host in the same gesture", async () => {
    const w = await loadSidebarWorld();
    const reqCalls = [];
    w.window.chrome.permissions = {
        contains: async () => false,   // host not yet granted (Chrome withholds <all_urls> under "On click")
        request: async ({ origins }) => { reqCalls.push(origins); return true; },
    };
    await w.dispatch(agentStart("ha", "fetch it"));
    await w.dispatch(agentStep("ha", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://raw.githubusercontent.com/o/r/main/x.json" },
        renderIn: { type: "action", verb: "fetch", target: "https://raw.githubusercontent.com/o/r/main/x.json" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const note = w.shadow.querySelector(".action-host");
    assert.ok(note, "the first-time host-access note rendered");
    assert.match(note.textContent, /raw\.githubusercontent\.com/, "names the site being granted");
    // Approving requests that exact host pattern (gesture-preserved), then posts the decision.
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.flush();
    assert.deepEqual(reqCalls[0], ["https://raw.githubusercontent.com/*"], "requested the target's host pattern");
    assert.ok(posted.find(m => m.__mlSidebarApp === "approval" && m.decision === true), "and the approval was still posted");
});

test("host access (fetch_url): an ALREADY-granted origin shows no note", async () => {
    const w = await loadSidebarWorld();
    w.window.chrome.permissions = { contains: async () => true, request: async () => true };
    await w.dispatch(agentStart("ha2", "fetch it"));
    await w.dispatch(agentStep("ha2", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://x.test/a.json" },
        renderIn: { type: "action", verb: "fetch", target: "https://x.test/a.json" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    assert.equal(w.shadow.querySelector(".action-host"), null, "no note when the host is already granted");
});

test("host access (fetch_url): the user clicks NO on Chrome's host prompt → the approval still posts (fetch runs, then fails gracefully)", async () => {
    const w = await loadSidebarWorld();
    const reqCalls = [];
    // Chrome's native grant prompt is DENIED: request resolves false (not a throw).
    w.window.chrome.permissions = {
        contains: async () => false,
        request: async ({ origins }) => { reqCalls.push(origins); return false; },
    };
    await w.dispatch(agentStart("hn", "fetch it"));
    await w.dispatch(agentStep("hn", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url",
        arguments: { url: "https://raw.githubusercontent.com/o/r/main/x.json" },
        renderIn: { type: "action", verb: "fetch", target: "https://raw.githubusercontent.com/o/r/main/x.json" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.flush();
    // The host grant was attempted (in-gesture) but DENIED — yet the approval is still sent: the tool
    // runs and the background fetch returns its actionable "grant host access" error for the model to see.
    assert.deepEqual(reqCalls[0], ["https://raw.githubusercontent.com/*"], "still requested the host in-gesture");
    assert.ok(posted.find(m => m.__mlSidebarApp === "approval" && m.decision === true), "approval posted despite the denied host grant");
});

test("host access (navigate): approving a CROSS-SITE navigate grants the destination host in the same gesture", async () => {
    const w = await loadSidebarWorld();
    const reqCalls = [];
    w.window.chrome.permissions = {
        contains: async () => false,   // destination host not yet granted (needed to re-inject the content script there)
        request: async ({ origins }) => { reqCalls.push(origins); return true; },
    };
    await w.dispatch(agentStart("nv", "go to the docs"));
    await w.dispatch(agentStep("nv", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "navigate",
        arguments: { url: "https://docs.other.dev/guide" },
        renderIn: { type: "action", verb: "navigate", target: "https://docs.other.dev/guide", crossOrigin: "docs.other.dev" },
    }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    const note = w.shadow.querySelector(".action-host");
    assert.ok(note, "the first-time host-access note renders for a cross-site navigate too");
    assert.match(note.textContent, /docs\.other\.dev/, "names the destination site");
    assert.match(note.textContent, /after navigating/, "the reason is navigate-specific, not the fetch wording");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.flush();
    assert.deepEqual(reqCalls[0], ["https://docs.other.dev/*"], "requested the destination's host pattern in-gesture");
    assert.ok(posted.find(m => m.__mlSidebarApp === "approval" && m.decision === true), "and the approval was posted");
});

test("Settings → Site access: a long granted list is filterable (it gets spammed fast)", async () => {
    const w = await loadSidebarWorld();
    const many = ["ani.sidestore.io", "ani.sidestore.app", "ani.npeg.us", "api.github.com", "github.com", "raw.githubusercontent.com", "www.youtube.com"].map(h => `https://${h}/*`);
    w.window.chrome.permissions = {
        getAll: (cb) => cb({ origins: many }),
        remove: (_o, cb) => cb(true), request: (_o, cb) => cb(true),
        onAdded: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} },
    };
    await openSettings(w, "Permissions");
    await w.flush();
    const sect = () => [...w.shadow.querySelectorAll(".set-section")].find(s => /Site access/.test(s.querySelector(".set-group")?.textContent || ""));
    const hosts = () => [...sect().querySelectorAll(".perm-host")].map(e => e.textContent);
    assert.equal(hosts().length, 7, "all granted hosts show initially");
    // ONE box: typing a partial word filters the granted list (no separate search field).
    const filter = sect().querySelector(".perm-add .perm-input");
    assert.ok(filter, "the add/filter input is present");
    filter.value = "github";
    filter.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    const shown = hosts();
    assert.deepEqual(shown.sort(), ["api.github.com", "github.com", "raw.githubusercontent.com"], "only matching sites remain");
    // A partial word isn't a valid hostname → Add stays disabled (it's a filter, not an add).
    assert.equal(sect().querySelector(".perm-add .test-btn").disabled, true, "Add is disabled for a partial filter");
});

test("Settings → Site access: granted hosts list, revoke, and add (mirrors the popup)", async () => {
    const w = await loadSidebarWorld();
    const removed = [], requested = [];
    let origins = ["https://raw.githubusercontent.com/*", "https://api.example.com/*"];
    w.window.chrome.permissions = {
        getAll: (cb) => cb({ origins }),
        remove: ({ origins: o }, cb) => { removed.push(o); origins = origins.filter(x => !o.includes(x)); cb(true); },
        request: ({ origins: o }, cb) => { requested.push(o); origins = [...origins, ...o]; cb(true); },
        onAdded: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
    };
    await openSettings(w, "Permissions");
    await w.flush();
    // Scope to the "Site access" section — the self-approval whitelist above it also uses .perm-* classes.
    const sect = () => [...w.shadow.querySelectorAll(".set-section")].find(s => /Site access/.test(s.querySelector(".set-group")?.textContent || ""));
    const hosts = () => [...sect().querySelectorAll(".perm-host")].map(e => e.textContent);
    assert.ok(hosts().includes("raw.githubusercontent.com"), "lists a granted host (label stripped of scheme/glob)");
    assert.ok(hosts().includes("api.example.com"), "lists all granted hosts");
    // Revoke one → chrome.permissions.remove with its origin pattern, and it drops from the list.
    const chip = [...sect().querySelectorAll(".perm-chip")].find(c => c.textContent.includes("api.example.com"));
    chip.querySelector(".perm-x").click();
    await w.flush();
    assert.deepEqual(removed[0], ["https://api.example.com/*"], "revoke requests removal of that exact origin");
    assert.ok(!hosts().includes("api.example.com"), "revoked host disappears from the list");
    // Add a new one via the input → chrome.permissions.request with the derived pattern.
    const input = sect().querySelector(".perm-add .perm-input");
    input.value = "docs.example.org";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    [...sect().querySelectorAll(".perm-add .test-btn")].find(b => b.textContent.trim() === "Add").click();
    await w.flush();
    assert.deepEqual(requested[requested.length - 1], ["https://docs.example.org/*"], "add requests the typed host's pattern");
    assert.ok(hosts().includes("docs.example.org"), "the newly granted host appears");
});

test("Settings → Site access: 'On all sites' (<all_urls>) shows the note instead of an add form", async () => {
    const w = await loadSidebarWorld();
    w.window.chrome.permissions = {
        getAll: (cb) => cb({ origins: ["<all_urls>"] }),
        remove: (_o, cb) => cb(true), request: (_o, cb) => cb(true),
        onAdded: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} },
    };
    await openSettings(w, "Permissions");
    await w.flush();
    const sect = [...w.shadow.querySelectorAll(".set-section")].find(s => /Site access/.test(s.querySelector(".set-group")?.textContent || ""));
    assert.ok(sect, "the Site access section rendered");
    assert.match(sect.textContent, /all sites/i, "explains that all-sites access is granted");
    assert.equal(sect.querySelector(".perm-add"), null, "no add form when everything is already allowed");
});

// The CDP master toggle (Settings → Advanced). `debugger` is an INSTALL-time permission; the toggle just
// gates USAGE (runtime-requesting `debugger` from the embedded settings iframe returns denied — unreliable).
const cdpToggle = (w) => [...w.shadow.querySelectorAll(".set-check")].find(l => /debugger-based actions/i.test(l.textContent))?.querySelector('input[type=checkbox]');
test("Settings CDP toggle: enabling just flips the `cdp` flag (no fragile runtime permission request)", async () => {
    const w = await loadSidebarWorld();
    let requested = false;
    w.window.chrome.permissions = { contains: (_q, cb) => cb(true), request: () => { requested = true; } };   // install-time → granted
    await openSettings(w, "Advanced");
    const cb = cdpToggle(w);
    assert.ok(cb, "the CDP toggle renders under Advanced");
    assert.equal(cb.checked, false, "off by default");
    cb.checked = true; cb.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.equal(w.syncStore.cdp, true, "enabling persists the flag ON");
    assert.equal(requested, false, "it does NOT call the unreliable runtime permission request");
    assert.match([...w.shadow.querySelectorAll(".set-hint")].map(e => e.textContent).join(" "), /Ready/i, "shows the granted/ready note");
});

test("Settings CDP toggle: flag ON but the debugger permission is INACTIVE → an actionable reload note", async () => {
    const w = await loadSidebarWorld({ sync: { cdp: true } });
    w.window.chrome.permissions = { contains: (_q, cb) => cb(false) };   // e.g. an update pending re-approval
    await openSettings(w, "Advanced");
    await w.flush();
    const hint = [...w.shadow.querySelectorAll(".set-hint")].map(e => e.textContent).join(" ");
    assert.match(hint, /isn't active|reload the extension/i, "guides the user to reload + accept, not a dead end");
});

test("output-cap raise: the approval card calls out the raised limit + the model's justification", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("orc", "big dump"));
    await w.dispatch(agentStep("orc", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "exec",
        arguments: { js: "return bigThing()", maxChars: 8000, maxCharsReason: "need the whole config file" },
        renderIn: { type: "code", text: "return bigThing()", lang: "javascript", format: true },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const raise = w.shadow.querySelector(".action-raise");
    assert.ok(raise, "the raise note rendered on the approval card");
    assert.match(raise.textContent, /8,?000 chars/, "shows the raised cap");
    assert.match(raise.textContent, /default 500/, "and the default it's exceeding");
    assert.match(raise.textContent, /need the whole config file/, "shows the model's justification");
});

test("output-cap raise (HUD card): the raised limit + justification appear on the corner card too (parity)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    await w.dispatch(agentStart("orcC", "big dump"));
    await w.dispatch(agentStep("orcC", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "df.to_string()", maxChars: 15000, maxCharsReason: "the whole frame" },
        renderIn: { type: "python-in", mode: "script", code: "df.to_string()" },
    }));
    await w.tick();
    const raise = w.shadow.querySelector(".action-raise");
    assert.ok(raise, "the raise note rendered on the HUD card");
    assert.match(raise.textContent, /15,?000 chars/);
    assert.match(raise.textContent, /the whole frame/);
});

test("output-cap raise: an UNRAISED exec approval shows no raise note", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("orc2", "survey"));
    await w.dispatch(agentStep("orc2", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "exec",
        arguments: { js: "return x" }, renderIn: { type: "code", text: "return x", lang: "javascript", format: true },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".action-raise"), null, "no note when the cap isn't raised");
});

test("button #3 (sidebar step): a gate with NO grants shows no remember button", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("b3s3", "click something"));
    await w.dispatch(agentStep("b3s3", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#go" } }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".astep-approve"), "the approval bar rendered");
    assert.equal(w.shadow.querySelector(".astep-approve .appr-btn.remember"), null, "no Keep button without grants");
    assert.equal(w.shadow.querySelector(".astep-approve .appr-grant"), null, "and no grant card");
});

test("turn prose: a SHORT one-line thought has NO misleading collapse chevron; a LONG one keeps it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tp", "do it"));
    await w.dispatch(agentStep("tp", 1, { seq: 1, thought: "Let me try the fetch tool instead:" }));   // short → nothing to collapse
    await w.dispatch(agentStep("tp", 2, { seq: 2, thought: "x ".repeat(120) }));   // long (>100 chars) → truncates
    w.shadow.querySelector(".row").click();
    await w.tick();
    const proses = [...w.shadow.querySelectorAll(".aturn-prose")];
    assert.equal(proses.length, 2, "both thoughts render as prose");
    const short = proses.find(p => /fetch tool instead/.test(p.textContent));
    assert.ok(short.classList.contains("no-toggle"), "short thought is flagged no-toggle");
    assert.equal(short.querySelector(".prose-tri"), null, "…and has NO chevron (nothing to expand)");
    const long = proses.find(p => !/fetch tool instead/.test(p.textContent));
    assert.ok(long.querySelector(".prose-tri"), "the long thought keeps its collapse chevron");
});

test("reused-grant step: a readonly exec that re-read a cached URL shows a collapsed 'reused a grant' note", async () => {
    const w = await loadSidebarWorld();
    const url = "https://x.test/servers.json";
    await w.dispatch(agentStart("ru", "reuse a fetch"));
    await w.dispatch(agentStep("ru", 1, { seq: 1, tool: "exec", arguments: { js: `ml.fetch("${url}").json` }, result: "[…]", approval: "readonly", reused: [{ kind: "fetch-url", detail: url }] }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /exec/.test(h.textContent));
    head.click();
    await w.tick();
    const reused = w.shadow.querySelector(".astep-reused");
    assert.ok(reused, "the reused-grant disclosure renders on the step");
    assert.match(reused.textContent, /Reused a grant you approved/i);
    assert.match(reused.querySelector(".reused-why").textContent, /1 URL/, "deterministic summary of what was reused");
    // Collapsed by default; the exact URL is in the (expandable) list.
    assert.match(reused.querySelector(".reused-list code").textContent, /servers\.json/);
});

test("reused-grant step: a python_exec that reused an approved Sheet renders it as a smart chip", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rs", "reuse a sheet"));
    await w.dispatch(agentStep("rs", 1, { seq: 1, tool: "python_exec", arguments: { code: "df.sum()" }, result: "42", approval: "sandbox", reused: [{ kind: "sheet", detail: "1AbCdEfGh" }] }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /python_exec/.test(h.textContent));
    head.click();
    await w.tick();
    const reused = w.shadow.querySelector(".astep-reused");
    assert.ok(reused, "the reused-grant disclosure renders");
    assert.match(reused.querySelector(".reused-why").textContent, /1 sheet/, "summarised as a sheet, not a URL");
    assert.ok(reused.querySelector(".reused-list .sheet-chip"), "the sheet renders as a smart chip (resolves its name)");
});

test("fetch_url step: the rendered In shows a clean verb + URL line, NOT a raw JSON dump of the descriptor", async () => {
    const w = await loadSidebarWorld();
    const url = "https://raw.githubusercontent.com/SideStore/anisette-servers/main/servers.json";
    await w.dispatch(agentStart("fu2", "why no https"));
    await w.dispatch(agentStep("fu2", 1, { seq: 1, tool: "fetch_url", arguments: { url }, result: "Fetched …", renderIn: { type: "action", verb: "fetch", target: url } }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    // Expand the fetch_url step to reveal the In block.
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /fetch_url/.test(h.textContent));
    head.click();
    await w.tick();

    const action = w.shadow.querySelector(".r-action");
    assert.ok(action, "the action renders as a clean line (not JSON)");
    assert.match(action.textContent, /fetch/i, "shows the verb");
    const target = w.shadow.querySelector(".r-action-target");
    assert.ok(target, "the URL is styled as a target");
    assert.match(target.textContent, /servers\.json/, "and is the fetched URL");
    // The rendered view must NOT be the raw descriptor JSON.
    assert.doesNotMatch(w.shadow.querySelector(".astep-body").textContent, /"type":\s*"action"/, "no raw {type:action} JSON dump");

    // Right-click the URL → a context menu offering "Open in new tab" + "Copy URL".
    let opened = null;
    w.window.open = (u) => { opened = u; return null; };
    target.dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    await w.tick();
    const items = [...w.shadow.querySelectorAll(".ctx-menu .ctx-item")].map(b => b.textContent);
    assert.ok(items.includes("Open in new tab"), "the menu offers open-in-new-tab");
    assert.ok(items.includes("Copy URL"), "and copy");
    [...w.shadow.querySelectorAll(".ctx-menu .ctx-item")].find(b => b.textContent === "Open in new tab").click();
    assert.equal(opened, url, "clicking it opens the URL in a new tab");
});

test("fetch_url `ask` step: the In shows the FULL question on its own line + who answered it and the tokens", async () => {
    const w = await loadSidebarWorld();
    const url = "https://api.github.com/repos/o/r/git/trees/abc?recursive=1";
    const ask = "List only the file paths (type: blob) that plausibly hold a system prompt";
    await w.dispatch(agentStart("ask1", "find the prompt file"));
    await w.dispatch(agentStep("ask1", 1, {
        seq: 1, tool: "fetch_url", arguments: { url, ask }, result: "Fetched …\n\nAnswer:\nREADME.md",
        renderIn: { type: "action", verb: "fetch", target: url, ask, answeredBy: "qwen3:4b", tokens: 5231 },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /fetch_url/.test(h.textContent));
    head.click();
    await w.tick();

    const askLine = w.shadow.querySelector(".r-action-ask");
    assert.ok(askLine, "the question renders on its own line");
    assert.match(askLine.textContent, /Asked:/, "with a bold Asked: label");
    assert.ok(askLine.textContent.includes(ask), "the FULL question is shown (not truncated)");
    const meta = w.shadow.querySelector(".r-action-meta");
    assert.ok(meta, "the answered-by/tokens meta line renders");
    assert.match(meta.textContent, /Answered by:/);
    assert.match(meta.textContent, /qwen3:4b/, "names the reader model");
    assert.match(meta.textContent, /5,231 tokens/, "and the tokens the answer used");
});

test("approval card: a fetch_url gate styles the URL like navigate/submit (action-link: warm + dotted), not 'the element'", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://x" }, listModels: () => ({ data: ["m"] }) });
    await w.raw({ __mlSidebarSurface: "card" });
    const url = "https://raw.githubusercontent.com/SideStore/anisette-servers/main/servers.json";
    await w.dispatch(agentStart("fu", "Fetch and list servers"));
    await w.dispatch(agentStep("fu", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "fetch_url", arguments: { url }, renderIn: { type: "action", verb: "fetch", target: url } }));
    await w.tick();
    const link = w.shadow.querySelector(".action-link");
    assert.ok(link, "the fetch URL renders in an action-link (the warm + dotted 'significant detail' style, like navigate)");
    assert.equal(link.textContent, url, "it's the exact URL");
    const sentence = w.shadow.querySelector(".action-sentence").textContent;
    assert.match(sentence, /wants to\s+fetch/i, "the verb is 'fetch'");
    assert.doesNotMatch(sentence, /the element/i, "NOT the generic 'the element' wording");
});

test("button #3 (HUD card): 'Approve + remember' renders in the card foot and posts persist:true", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // become the off-mode corner card
    await w.dispatch(agentStart("b3c", "fetch stuff"));
    await w.dispatch(grantStep("b3c"));
    await w.tick();

    const remember = w.shadow.querySelector(".card-foot .appr-btn.remember");
    assert.ok(remember, "the 'Approve + remember' button rendered in the card footer");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    remember.click();
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(msg && msg.decision === true && msg.persist === true, "card posts approval with persist:true");
    assert.equal(msg.hash, "b3c");
    // The Keep button carries the deliberate two-key hint (⌘K / Ctrl K), not an Enter-adjacent combo.
    assert.match(remember.textContent, /(⌘K|Ctrl K)/);
});

test("button #3 (HUD card): ⌘K/Ctrl+K is a deliberate Approve+Keep combo; plain Enter is Approve-only", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("kbk", "fetch stuff"));
    await w.dispatch(grantStep("kbk"));
    await w.flush();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    // The two-key combo (Ctrl/⌘ + K) approves AND remembers.
    w.window.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const keep = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(keep, "⌘/Ctrl+K resolves the gate");
    assert.equal(keep.decision, true);
    assert.equal(keep.persist, true, "…and persists (it's Keep, not plain Approve)");
});

test("button #3 (HUD card): plain Enter approves WITHOUT persisting (Keep is only the two-key combo)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("kbe", "fetch stuff"));
    await w.dispatch(grantStep("kbe"));
    await w.flush();
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    w.window.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const msg = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(msg && msg.decision === true, "Enter approves");
    assert.equal(msg.persist, false, "…but does NOT persist — Keep requires the deliberate combo");
});

test("agent run: agent-result arriving BEFORE the (replayed) start is not dropped — the answer survives", async () => {
    const w = await loadSidebarWorld();
    // The result wins the race onto the fresh page (no `agent` start yet). It must create a stub, not vanish.
    await w.dispatch(agentResult("race1", "The code is XDOMAIN-2025.", 2));
    await w.dispatch(agentStart("race1", "go read the code"));                    // replayed start lands AFTER
    await w.dispatch(agentStep("race1", 1, { seq: 1, tool: "navigate", arguments: { url: "/x" }, result: "ok" }));
    await w.dispatch(agentStep("race1", 2, { seq: 2, tool: "findByText", arguments: { text: "X" }, result: "found" }));
    await w.tick();
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /XDOMAIN-2025/, "the answer survived the result-first race");
    assert.ok(!w.shadow.querySelector(".pending-note"), "and the run reads DONE, not running");
});

test("agent run: a REPLAYED start event does not wipe steps/answer already applied from live events", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("race2", "do it"));
    await w.dispatch(agentStep("race2", 1, { seq: 1, tool: "navigate", arguments: { url: "/x" }, result: "ok" }));
    await w.dispatch(agentResult("race2", "All finished.", 1));                   // completes
    // The re-adopt replay re-sends the SAME start event. It must NOT recreate the session (wiping the answer).
    await w.dispatch(agentStart("race2", "do it"));
    await w.tick();
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /All finished/, "the answer wasn't wiped by the replayed start");
    assert.ok(!w.shadow.querySelector(".pending-note"), "and the run stays DONE");
});

// A GENUINE resumed off-mode turn (no agent-say bridge) still unseals: its first NON-pending step re-opens
// "running". Guards the fix above from over-blocking (only a bare pending START is inert on a sealed run).
test("agent run: a real resumed turn (a non-pending step past the sealed turn) DOES re-show running", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bg2", "do it"));
    await w.dispatch(agentStep("bg2", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult("bg2", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "sealed after the result");
    // A follow-up turn resumes; off-mode has no agent-say, so its first real step is the signal it's working.
    await w.dispatch(agentStep("bg2", 2, { thought: "let me continue" }));
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "a resumed turn's real step re-opens running");
});

// The "seen" indicator: a mid-run steer is LETTERBOXED (queued, delivered only at the agent's next step
// boundary), so a bubble alone doesn't tell you whether the agent got it. agent-say shows it QUEUED;
// agent-say-seen (fanned when the loop drains it) flips it to SEEN. Cross-UI + order-independent.
const agentSay = (hash, text, sayId, ts = Date.now()) => ({ kind: "agent-say", id: hash, ts, save: false, session: { hash, turn: 0 }, text, sayId });
const agentSaySeen = (hash, sayId, ts = Date.now()) => ({ kind: "agent-say-seen", id: hash, ts, save: false, session: { hash, turn: 0 }, sayId });

test("agent run: a mid-run steer shows QUEUED, then flips to SEEN when the agent drains it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("steer1", "do a thing"));
    await w.dispatch(agentStep("steer1", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentSay("steer1", "actually focus on the header", "sy_1"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let badge = w.shadow.querySelector(".steer-seen");
    assert.ok(badge, "the steer bubble carries a delivery indicator");
    assert.ok(badge.classList.contains("wait"), "it starts QUEUED (not yet picked up)");
    // The loop drains it at the next boundary → seen.
    await w.dispatch(agentSaySeen("steer1", "sy_1"));
    await w.tick();
    badge = w.shadow.querySelector(".steer-seen");
    assert.ok(badge.classList.contains("on"), "after the drain it flips to SEEN");
    // The initial task bubble is NOT a steer → no indicator on it.
    assert.equal(w.shadow.querySelectorAll(".steer-seen").length, 1, "only the steer carries the indicator, not the task");
});

test("agent run: an agent-say-seen that races AHEAD of its bubble still marks it seen (order-independent)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("steer2", "do a thing"));
    // The SEEN event wins the race onto the fresh page (cross-page replay reorder) — arriving before the bubble.
    await w.dispatch(agentSaySeen("steer2", "sy_9"));
    await w.dispatch(agentSay("steer2", "steer arriving late", "sy_9"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const badge = w.shadow.querySelector(".steer-seen");
    assert.ok(badge && badge.classList.contains("on"), "the bubble renders already SEEN (the earlier seen was remembered)");
});

// REGRESSION: `agent-say` is overloaded — it also carries a follow-up run()'s TASK (a continuation), which
// has NO sayId and is processed immediately, NOT letterboxed. That must NOT get the queued/seen badge (it was
// showing a permanent amber "queued" dot that never flipped — the DevTools-panel status bug). Reducer-level,
// so this guards BOTH surfaces (the panel is the same app, per the parity rule).
test("devtools/panel: a follow-up run() task (continuation agent-say, no sayId) shows NO steer indicator", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cont1", "first question"));
    await w.dispatch(agentStep("cont1", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult("cont1", "first answer", 1));
    // The follow-up: an agent-say WITHOUT a sayId (a new turn's task, not a mid-run steer).
    await w.dispatch({ kind: "agent-say", id: "cont1", ts: Date.now() + 5, save: false, session: { hash: "cont1", turn: 0 }, text: "and what else?" });
    await w.dispatch(agentResult("cont1", "second answer", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const userTexts = [...w.shadow.querySelectorAll(".msg.user .utext")].map(e => e.textContent);
    assert.ok(userTexts.includes("and what else?"), "the follow-up still renders as a you bubble");
    assert.equal(w.shadow.querySelectorAll(".steer-seen").length, 0, "no steer badge on the task or a continuation — only genuine mid-run steers get it");
});

test("step-cap stop (sidebar): the answer offers 'Continue (+N steps)' → posts continueRun for that run", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cap1", "big task", "m", 20));
    await w.dispatch(agentResult("cap1", "Stopped at the 20-step cap without finishing.", 20, true));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const btn = w.shadow.querySelector(".continue-run");
    assert.ok(btn, "the Continue button renders on a step-capped answer");
    assert.match(btn.textContent, /Continue/);
    assert.match(btn.textContent, /\+20 steps/, "shows the fresh step budget");
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    btn.click();
    const msg = posted.find(m => m.__mlSidebarApp === "continueRun");
    assert.ok(msg, "clicking posts a continueRun message");
    assert.equal(msg.hash, "cap1");
});

test("step-cap stop (sidebar): a normal (non-capped) or CANCELLED answer shows NO Continue button", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ok1", "task", "m", 20));
    await w.dispatch(agentResult("ok1", "All done.", 3, false));   // clean finish
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".continue-run"), null, "a completed run has nothing to continue");
    // A cancelled run is capped-styled but must NOT offer continue (the user stopped it deliberately).
    const w2 = await loadSidebarWorld();
    await w2.dispatch(agentStart("cx", "task", "m", 20));
    await w2.dispatch({ ...agentResult("cx", "Cancelled by the caller.", 2, false), cancelled: true });
    w2.shadow.querySelector(".row").click();
    await w2.tick();
    assert.equal(w2.shadow.querySelector(".continue-run"), null, "a cancelled run offers no Continue");
});

test("step-cap stop (HUD card): the corner card offers 'Continue (+N steps)' → posts continueRun (parity)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("capC", "big task", "m", 50));
    await w.dispatch(agentStep("capC", 1, { seq: 1, tool: "fetch_url", arguments: { url: "https://x.test" }, result: "…", approval: "user" }));
    await w.dispatch(agentResult("capC", "Stopped at the 50-step cap without finishing.", 50, true));
    await w.tick();
    const btn = w.shadow.querySelector(".continue-run");
    assert.ok(btn, "the Continue button renders on the HUD card too");
    assert.match(btn.textContent, /\+50 steps/);
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    btn.click();
    const msg = posted.find(m => m.__mlSidebarApp === "continueRun");
    assert.ok(msg && msg.hash === "capC", "the card posts continueRun for its run");
});

const streamConfig = (over = {}) => ({ system: "s", customSystem: false, tools: [], maxSteps: 20, think: null, env: true, vision: null, hints: null, ...over });

test("HUD card: a streaming answer renders as CLEAN text — no DevTools activity line or model chip", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    await w.dispatch(agentStart("cs", "how many servers?", "m", 20, streamConfig({ stream: true })));
    // The answer streams in (liveStream.content) → the card expands to show it live.
    await w.dispatch({ kind: "agent-stream", id: "cs", ts: Date.now(), save: false, session: { hash: "cs", turn: 1 }, step: 1, localStep: 1, content: "Fourteen servers, one on http." });
    await w.flush();
    const body = w.shadow.querySelector(".card-body");
    const answer = body.querySelector(".card-answer.md");
    assert.ok(answer, "the streaming answer is a clean markdown block (like the finished answer)");
    assert.match(answer.textContent, /Fourteen servers/, "the streamed content shows");
    assert.equal(body.querySelector(".card-working"), null, "no 'Running JavaScript…' activity line in the HUD");
    assert.equal(body.querySelector(".model-name"), null, "no model chip (that's DevTools/sidebar chrome)");
});

test("HUD card: a streaming follow-up collapses an open 'Show work' and keeps it ABOVE the answer (no reflow spam)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    // A finished run WITH work, and its answer.
    await w.dispatch(agentStart("fu", "read the config", "m", 20, streamConfig({ stream: true })));
    await w.dispatch(agentStep("fu", 1, { seq: 1, tool: "exec", arguments: { js: "1" }, result: "1", approval: "readonly" }));
    await w.dispatch(agentResult("fu", "It lists 14 servers.", 1));
    await w.tick();
    // Expand "Show work" on the finished answer (the state the user leaves it in).
    const toggle = w.shadow.querySelector(".card-work-toggle");
    assert.ok(toggle, "the finished card shows a Show-work toggle");
    toggle.click(); await w.tick();
    assert.match(w.shadow.querySelector(".card-work-toggle").textContent, /Hide work/, "it's expanded before the follow-up");
    // Now a follow-up streams in (say → the answer streams via agent-stream content).
    await w.dispatch(agentSay("fu", "and which use http?", undefined, Date.now() + 5));
    await w.dispatch({ kind: "agent-stream", id: "fu", ts: Date.now() + 6, save: false, session: { hash: "fu", turn: 2 }, step: 2, localStep: 2, content: "Only one uses http." });
    await w.flush();
    // The open trace is COLLAPSED so it doesn't loom over / reflow with the streaming answer.
    assert.match(w.shadow.querySelector(".card-work-toggle").textContent, /Show work/, "Show work collapses when the follow-up starts streaming");
    // The streaming answer renders as CLEAN markdown text — like the finished answer. NO "Running JavaScript…"
    // activity line and NO DevTools model-chip / reply-bubble chrome (those don't belong in the HUD).
    const body = w.shadow.querySelector(".card-body");
    const answer = body.querySelector(".card-answer.md");
    assert.ok(answer, "the streaming answer renders as a clean markdown block");
    assert.match(answer.textContent, /Only one uses http/, "the streamed content is shown");
    assert.equal(body.querySelector(".card-working"), null, "no 'Running JavaScript…' activity line during answer streaming");
    assert.equal(body.querySelector(".model-name"), null, "no DevTools model chip (CopyModel) in the HUD");
    // And the trace stays ABOVE the streaming answer (same order as the done state) — no bottom↔top jump.
    const work = body.querySelector(".card-work");
    assert.ok(work && (work.compareDocumentPosition(answer) & w.window.Node.DOCUMENT_POSITION_FOLLOWING), "Show work stays ABOVE the streaming answer");
});

test("stream:true: live reasoning fills a live thinking block (ticking count); a real step then clears it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("st1", "read the diff", "m", 20, streamConfig({ stream: true })));
    await w.dispatch({ kind: "agent-stream", id: "st1", ts: Date.now(), save: false, session: { hash: "st1", turn: 1 }, step: 1, localStep: 1, reasoning: "Let me look at the routes file section…" });
    w.shadow.querySelector(".row").click();
    await w.tick();
    // Streams into a LIVE thinking block inside the SAME .aturn shell (StepPill) a finished step uses — so it
    // doesn't jump when it settles.
    const turn = w.shadow.querySelector(".aturn:has(.athinking.live)");
    assert.ok(turn, "the live thinking sits in an .aturn group");
    assert.match(turn.querySelector(".step-pill").textContent, /step 1\/20/, "with the SAME StepPill the settled step shows");
    const think = turn.querySelector(".athinking.live");
    assert.match(think.textContent, /~\d+ tokens/, "the ticking token estimate shows");
    think.querySelector(".astep-head").click(); await w.tick();   // expand to watch the text
    assert.match(w.shadow.querySelector(".athinking.live .astep-body").textContent, /routes file section/, "the accumulated thinking text is there");
    // A real step landing supersedes the live preview.
    await w.dispatch(agentStep("st1", 1, { seq: 1, tool: "exec", arguments: { js: "1" }, result: "1", approval: "readonly" }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".athinking.live"), null, "the live thinking clears when the step's real events land");
});

test("stream:true: live reply CONTENT streams into the SAME reply bubble shape (model chip, no copy/raw yet)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("st2", "answer me", "m", 20, streamConfig({ stream: true })));
    await w.dispatch({ kind: "agent-stream", id: "st2", ts: Date.now(), save: false, session: { hash: "st2", turn: 1 }, step: 1, localStep: 1, content: "The file loads fine and lists 14 servers." });
    w.shadow.querySelector(".row").click(); await w.tick();
    const reply = w.shadow.querySelector(".msg.asst.streaming");
    assert.ok(reply, "the streaming reply uses the same .msg.asst bubble (streaming variant)");
    assert.match(reply.textContent, /14 servers/, "the streaming answer text shows");
    assert.ok(reply.querySelector(".live-dot"), "with a live pulse (in place of the chevron/dot)");
    assert.equal(reply.querySelector(".raw-btn"), null, "and no raw toggle yet (lands when it settles)");
});

test("agent options: shows 'streaming: on' when the run streamed, 'off' otherwise", async () => {
    const on = await loadSidebarWorld();
    await on.dispatch(agentStart("so1", "t", "m", 20, streamConfig({ stream: true })));
    await on.dispatch(agentResult("so1", "done", 1));
    on.shadow.querySelector(".row").click(); await on.tick();
    on.shadow.querySelector(".agent-opts .block-head").click(); await on.tick();
    assert.match(on.shadow.querySelector(".agent-opts .opts").textContent, /streaming: on/);

    const off = await loadSidebarWorld();
    await off.dispatch(agentStart("so2", "t", "m", 20, streamConfig()));   // no stream flag
    await off.dispatch(agentResult("so2", "done", 1));
    off.shadow.querySelector(".row").click(); await off.tick();
    off.shadow.querySelector(".agent-opts .block-head").click(); await off.tick();
    assert.match(off.shadow.querySelector(".agent-opts .opts").textContent, /streaming: off/);
});

test("agent run: a successful navigate step renders a page-transition divider in the log", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nav1", "go to example and read it"));
    await w.dispatch(agentStep("nav1", 1, { seq: 1, tool: "navigate", arguments: { url: "https://example.com/page" }, result: "Navigating to https://example.com/page …" }));
    await w.dispatch(agentStep("nav1", 2, { seq: 2, tool: "findByText", arguments: { text: "hi" }, result: "found" }));
    await w.dispatch(agentResult("nav1", "Done.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const div = w.shadow.querySelector(".nav-divider");
    assert.ok(div, "a page-transition divider renders after the navigate step");
    assert.match(div.textContent, /navigated to/);
    assert.match(div.querySelector(".nav-url").textContent, /example\.com\/page/);
});

test("agent run: a DENIED navigate does NOT render a transition divider (the page didn't change)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nav2", "try to leave"));
    await w.dispatch(agentStep("nav2", 1, { seq: 1, tool: "navigate", approval: "denied", arguments: { url: "https://evil.example/" }, result: "Denied by the user." }));
    await w.dispatch(agentResult("nav2", "Stayed put.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".nav-divider"), "no divider for a nav that didn't happen");
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

test("settings: the font-size stepper scales --fs and persists it", async () => {
    const w = await loadSidebarWorld();
    const html = w.window.document.documentElement;
    await openSettings(w, "Appearance");                                  // font size lives under Appearance
    assert.ok(w.shadow.querySelector(".settings"), "settings panel opens");

    w.shadow.querySelectorAll(".stepper button")[1].click();   // the "+" button
    await w.tick();
    assert.equal(html.style.getPropertyValue("--fs"), "13.20px", "12 × 1.1");
    assert.equal(w.localStore.ml_debug_fontscale, 1.1, "persisted");
    assert.match(w.shadow.querySelector(".set-val").textContent, /110%/);
});

test("settings: a saved font scale is applied on mount", async () => {
    const w = await loadSidebarWorld({ local: { ml_debug_fontscale: 1.3 } });
    const html = w.window.document.documentElement;
    assert.equal(html.style.getPropertyValue("--fs"), "15.60px", "12 × 1.3 applied from storage");
});

test("settings view: loads config, populates the model datalist, gates + persists utility fields", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://host/api" }, models: ["qwen3:14b", "qwen3.5:0.8b"] });
    await openSettings(w, "Connection");

    assert.equal(w.shadow.querySelector('input[type="text"]').value, "http://host/api", "chatUrl loaded from storage.sync");

    [...w.shadow.querySelectorAll(".set-tab")].find(b => b.textContent.trim() === "Models").click();   // model pickers + utility live under Models
    await w.tick();
    // The model picker drops the full server list on its caret (not a native datalist that hides non-matches).
    w.shadow.querySelector(".model-pick .model-pick-caret").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".model-pick-menu .model-pick-opt").length, 2, "picker menu populated from LIST_MODELS");
    assert.ok(w.shadow.querySelector('input[type="number"]').disabled, "utility context disabled until a utility model is set");

    const util = w.shadow.querySelector('input[placeholder="blank = use main model"]');
    util.value = "qwen3.5:0.8b";
    util.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    util.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(w.syncStore.utilityModel, "qwen3.5:0.8b", "utility model persisted to storage.sync");
    assert.ok(!w.shadow.querySelector('input[type="number"]').disabled, "utility context enabled once a model is set");
});

test("settings: the 'vision capable?' override is DISABLED (locked to Auto) for an Ollama default model", async () => {
    // caps non-null (an array) ⇒ the model is Ollama-probeable ⇒ detection wins ⇒ the manual override is moot.
    const w = await loadSidebarWorld({ sync: { model: "llava", defaultModelVision: "yes" }, models: ["llava"], caps: ["completion", "vision"] });
    await openSettings(w, "Models");
    const sel = [...w.shadow.querySelectorAll("select")].find(s => [...s.options].some(o => /Auto-detect/.test(o.textContent)));
    assert.ok(sel, "the vision-capable select is present");
    await new Promise(r => w.window.setTimeout(r, 450));   // the vision probe is debounced 400ms
    await w.tick();
    assert.ok(sel.disabled, "an Ollama model locks the override (auto-detected)");
    assert.equal(sel.value, "", "and it visually reads as Auto-detect, not the stored 'yes'");
    assert.ok([...w.shadow.querySelectorAll(".set-moot")].some(m => /auto-detected/i.test(m.textContent)), "a note explains the lock");
});

test("settings: the 'vision capable?' override stays ENABLED for a cloud (unprobeable) default model", async () => {
    const w = await loadSidebarWorld({ sync: { model: "gpt-4o", defaultModelVision: "yes" }, models: ["gpt-4o"], caps: null });   // caps null ⇒ can't probe ⇒ cloud
    await openSettings(w, "Models");
    const sel = [...w.shadow.querySelectorAll("select")].find(s => [...s.options].some(o => /Auto-detect/.test(o.textContent)));
    await new Promise(r => w.window.setTimeout(r, 450));
    await w.tick();
    assert.ok(!sel.disabled, "a cloud model keeps the manual override selectable");
    assert.equal(sel.value, "yes", "and shows the stored override value");
});

test("settings: Test models runs a per-model liveness check (set models pass, unset stays '—')", async () => {
    const w = await loadSidebarWorld({ sync: { model: "qwen3:14b", utilityModel: "gemma:2b" }, models: ["qwen3:14b"] });
    await openSettings(w, "Models");
    assert.equal(w.shadow.querySelectorAll(".test-row").length, 4, "one row per model role");

    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".test-ic.ok").length, 2, "the two set models pass");
    assert.equal(w.shadow.querySelectorAll(".test-ic.unset").length, 2, "the unset OCR + grounding stay not-set");
});

test("settings: Test models unloads only the models it freshly loaded (leaves already-warm ones)", async () => {
    const w = await loadSidebarWorld({
        sync: { model: "gemma4:31b", ocrModel: "qwen2.5vl:7b" },
        models: ["gemma4:31b", "qwen2.5vl:7b"],
        vram: [{ model: "gemma4:31b", vramGB: 20, sizeGB: 20, expiresAt: null }],   // default already resident
        caps: () => ["completion", "vision"],
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick(); await w.tick();
    const unloaded = w.unloadCalls.map(c => c.model);
    assert.ok(unloaded.includes("qwen2.5vl:7b"), "the freshly-loaded OCR model was unloaded");
    assert.ok(!unloaded.includes("gemma4:31b"), "the already-warm default model was left resident");
});

test("settings: a failing model test shows the error", async () => {
    const w = await loadSidebarWorld({ sync: { model: "badmodel" }, fetchLlm: () => ({ error: "model not found" }) });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".test-ic.err"), "error icon shown");
    // The error is prefixed with the role label so you can tell which model failed.
    assert.match(w.shadow.querySelector(".test-err").textContent, /Default:.*model not found/);
});

test("settings: grounding checkbox + model field persist, and the field is gated on the checkbox", async () => {
    const w = await loadSidebarWorld({ models: ["qwen2.5vl:7b"] });
    await openSettings(w, "Models");
    const field = () => w.shadow.querySelector('.model-pick input[placeholder*="qwen2.5vl:7b"]');
    // Placeholder auto-detects the qwen on the server; field disabled until enabled.
    assert.ok(field(), "grounding field shows the auto-detected qwen as its placeholder");
    assert.ok(field().disabled, "grounding model field disabled while grounding is off");

    const check = [...w.shadow.querySelectorAll(".set-check")].find(l => /grounding model/i.test(l.textContent)).querySelector("input");
    check.click();
    await w.tick();
    assert.equal(w.syncStore.groundingEnabled, true, "enable persisted");
    assert.ok(!field().disabled, "field enabled once grounding is on");

    field().value = "qwen2.5vl:3b";
    field().dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(w.syncStore.groundingModel, "qwen2.5vl:3b", "grounding model persisted");
});

test("settings: grounding enabled + blank field tests the auto-detected model (not skipped)", async () => {
    const w = await loadSidebarWorld({
        sync: { groundingEnabled: true }, models: ["qwen2.5vl:7b"],
        caps: () => ["completion", "vision"], fetchLlm: () => ({ data: "250,750" }),
    });
    await openSettings(w, "Models");
    const gRow = () => [...w.shadow.querySelectorAll(".test-row")].find(r => /Grounding/.test(r.textContent));
    assert.match(gRow().textContent, /qwen2.5vl:7b/, "status row shows the auto-detected effective model");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    assert.ok(gRow().querySelector(".test-ic.ok"), "the auto-detected grounding model got tested, not left unset");
});

test("settings: editing a model invalidates its stale test result", async () => {
    const w = await loadSidebarWorld({ sync: { model: "qwen3:14b" }, models: ["qwen3:14b", "llama3:8b"] });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    const defRow = () => [...w.shadow.querySelectorAll(".test-row")].find(r => /Default/.test(r.textContent));
    assert.ok(defRow().querySelector(".test-ic.ok"), "default model passes after Test");

    const field = w.shadow.querySelector('input[placeholder="e.g. qwen3:14b"]');
    field.value = "llama3:8b";
    field.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    assert.ok(!defRow().querySelector(".test-ic.ok"), "editing the model clears the stale pass");
    assert.match(defRow().textContent, /llama3:8b/, "row shows the new model");
});

test("settings: the default-model vision probe is DEBOUNCED — no per-keystroke MODEL_CAPS (keeps the datalist alive)", async () => {
    // Regression: probing on every keystroke fired an async setState mid-typing that dismissed the native
    // <datalist> autocomplete popup ("the dropdown broke"). The probe must debounce until typing settles.
    const probes = [];
    const w = await loadSidebarWorld({ sync: { model: "" }, models: ["gemma3", "gemma4:31b"], caps: (m) => { probes.push(m); return ["completion", "vision"]; } });
    await openSettings(w, "Models");
    const field = w.shadow.querySelector('input[placeholder="e.g. qwen3:14b"]');
    for (const v of ["g", "ge", "gem", "gemm", "gemma3"]) {
        field.value = v;
        field.dispatchEvent(new w.window.Event("input", { bubbles: true }));
        await w.tick();
    }
    assert.equal(probes.length, 0, "no MODEL_CAPS probe fires WHILE typing (debounced) — the datalist stays open");
    // Once typing settles, exactly ONE probe fires — for the final value only.
    await new Promise(r => w.window.setTimeout(r, 500));
    await w.flush();
    assert.deepEqual(probes, ["gemma3"], "one probe after settling, for the final model");
});

test("settings: the model picker shows the FULL list on its caret even when the typed text matches nothing", async () => {
    // Regression: the native <datalist> hid every option when the typed text matched none, so a non-matching
    // entry looked like a broken/empty dropdown. The picker always lets you browse the whole server list.
    const w = await loadSidebarWorld({ sync: { model: "this matches nothing" }, models: ["gemma3", "qwen3:14b"] });
    await openSettings(w, "Models");
    const pick = w.shadow.querySelector(".model-pick");
    pick.querySelector(".model-pick-caret").click();
    await w.tick();
    assert.ok(pick.querySelector(".model-pick-none"), "a non-matching entry shows the 'used as typed' note, not an empty popup");
    // Clear the field → the whole server list is browsable.
    const input = pick.querySelector("input");
    input.value = "";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    assert.equal(pick.querySelectorAll(".model-pick-opt").length, 2, "cleared → the full list shows");
    // Picking an option fills + persists the field.
    pick.querySelectorAll(".model-pick-opt")[1].click();
    await w.tick();
    assert.equal(w.syncStore.model, "qwen3:14b", "picking an option persists it");
    assert.ok(!w.shadow.querySelector(".model-pick-menu"), "the menu closes after picking");
});

test("settings: a vision-required role (OCR) fails RED when the model lacks vision capability", async () => {
    const w = await loadSidebarWorld({
        sync: { ocrModel: "text-only" },
        caps: (m) => m === "text-only" ? ["completion"] : null,   // no "vision"
        fetchLlm: () => ({ data: "OK" }),   // functional test would pass — but the cap gate stops it first
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    assert.ok(w.shadow.querySelector(".test-ic.err"), "OCR flagged failed");
    assert.match(w.shadow.querySelector(".test-err").textContent, /doesn't report vision capability/);
});

test("settings: the vision (OCR) field reds INLINE when a KNOWN local model lacks vision — and NOT for unknown caps", async () => {
    // Known local text-only model → the field itself flags red (debounced probe, no Test click).
    const bad = await loadSidebarWorld({ sync: { ocrModel: "text-only" }, caps: (m) => m === "text-only" ? ["completion"] : null });
    await openSettings(bad, "Models");
    await new Promise(r => bad.window.setTimeout(r, 500)); await bad.flush();
    const badInput = bad.shadow.querySelector('.model-pick input[placeholder="e.g. qwen2.5vl"]');
    assert.ok(badInput && badInput.classList.contains("err"), "a known non-vision model reds the field");
    assert.ok([...bad.shadow.querySelectorAll(".set-err")].some(e => /doesn't report vision capability/.test(e.textContent)), "with an inline explanation");

    // Cloud / undeterminable caps → NOT flagged (unknown ≠ no).
    const cloud = await loadSidebarWorld({ sync: { ocrModel: "gpt-4o" }, caps: () => null });
    await openSettings(cloud, "Models");
    await new Promise(r => cloud.window.setTimeout(r, 500)); await cloud.flush();
    const cloudInput = cloud.shadow.querySelector('.model-pick input[placeholder="e.g. qwen2.5vl"]');
    assert.ok(cloudInput && !cloudInput.classList.contains("err"), "unknown caps are not flagged");
});

test("settings: a configured model the model-filter excludes is flagged RED up front (no test needed)", async () => {
    const w = await loadSidebarWorld({
        sync: { model: "qwen3:14b", ocrModel: "gpt-4o-cloud", modelFilter: "^qwen" },
        models: ["qwen3:14b", "gpt-4o-cloud"],
    });
    await openSettings(w, "Models");
    await w.tick();
    const rows = [...w.shadow.querySelectorAll(".test-row")];
    const ocrRow = rows.find(r => r.querySelector(".role").textContent === "OCR");
    const defRow = rows.find(r => r.querySelector(".role").textContent === "Default");
    // gpt-4o-cloud fails /^qwen/ → RED with the filter reason, statically (no Test click).
    assert.ok(ocrRow.querySelector(".test-ic.err"), "excluded OCR model flagged RED");
    assert.match(ocrRow.querySelector(".tt-pop").textContent, /Excluded by the model access filter/);
    // qwen3:14b matches → not flagged.
    assert.ok(!defRow.querySelector(".test-ic.err"), "a matching model is not flagged");
    // The input FIELD holding the excluded model is red-bordered where you're looking,
    // not only the status row far below.
    // Match by the stable placeholder, not the label text (which the UI copy may rename).
    const ocrInput = w.shadow.querySelector('.model-pick input[placeholder="e.g. qwen2.5vl"]');
    assert.ok(ocrInput && ocrInput.classList.contains("err"), "excluded OCR/vision input red-bordered");
    const defInput = [...w.shadow.querySelectorAll(".set-field")]
        .find(f => /Default model/.test(f.textContent))?.querySelector("input");
    assert.ok(defInput && !defInput.classList.contains("err"), "matching Default input not flagged");
    // The picker menu hides the excluded ids so the dropdown matches ml.models().
    const defPick = [...w.shadow.querySelectorAll(".set-field")].find(f => /Default model/.test(f.textContent))?.querySelector(".model-pick");
    defPick.querySelector(".model-pick-caret").click();
    await w.tick();
    const opts = [...defPick.querySelectorAll(".model-pick-opt")].map(o => o.textContent);
    assert.ok(opts.includes("qwen3:14b"), "picker keeps a matching model");
    assert.ok(!opts.includes("gpt-4o-cloud"), "picker hides an excluded model");
});

test("settings: unknown caps (cloud/non-Ollama) do NOT red a vision role — fall through to the functional test", async () => {
    const w = await loadSidebarWorld({
        sync: { ocrModel: "cloud-vlm" },
        caps: () => null,   // unknown → must not block
        fetchLlm: (p) => ({ data: p.messages[0].content.match(/[A-Z0-9]{4}/) ? "n/a" : "OK" }),
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    // It got PAST the cap gate to the OCR image test (which fails on our stub reply),
    // proving unknown caps didn't short-circuit to a capability error.
    assert.doesNotMatch(w.shadow.querySelector(".test-err")?.textContent || "", /vision capability/);
});

test("settings view live-syncs a config change made elsewhere (e.g. the popup)", async () => {
    const w = await loadSidebarWorld();
    await openSettings(w, "Models");
    w.window.chrome.storage.sync.set({ model: "llama3:70b" });   // popup edit → storage.onChanged
    await w.tick();
    assert.equal(w.shadow.querySelector('input[placeholder="e.g. qwen3:14b"]').value, "llama3:70b");
});

test("VRAM monitor lists loaded models with a total, and evicts one + all", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, vramBytes: 8 * 1024 ** 3, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, vramBytes: 2 * 1024 ** 3, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });                     // shell reports slid-open → polling allowed
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click                                            // let the poll effect run

    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 2, "one row per loaded model");
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.00 GiB/, "total VRAM summed, in BINARY units");
    // Rows are sorted by name (stable order, no reshuffle on load/evict).
    assert.deepEqual([...w.shadow.querySelectorAll(".vram-name")].map(n => n.textContent), ["glm-ocr", "qwen3:14b"]);

    w.shadow.querySelector(".vram-row .vram-x").click();        // evict the first (glm-ocr, sorted)
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), { model: "glm-ocr" });

    w.shadow.querySelector(".vram-free").click();               // free all
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), {});
});

test("VRAM monitor shows the context a model was LOADED with (Ollama preallocates the KV cache)", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "gemma4:31b", vramGB: 21.4, vramBytes: 8 * 1024 ** 3, contextLength: 262144, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, vramBytes: 2 * 1024 ** 3, contextLength: 8192, expiresAt: null },
        { model: "old-server", vramGB: 1.0, contextLength: null, expiresAt: null },   // pre-0.11 Ollama: not reported
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    // Rows sort by name: gemma4:31b, glm-ocr, old-server. A missing context renders
    // NOTHING (rather than a misleading "0" / "?"), so only two chips exist.
    const chips = [...w.shadow.querySelectorAll(".vram-ctx")].map(n => n.textContent.trim().split("Loaded")[0]);
    assert.deepEqual(chips, ["256K", "8K"], "compact context chip per reporting model, none for the old server");
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 3, "the non-reporting model still gets a row");
    // The tooltip explains WHY it matters (preallocation), not just what it is.
    assert.match(w.shadow.querySelector(".vram-ctx .tt-pop").textContent, /preallocates/i);
});

test("VRAM monitor: clicking a colour dot hides that model from the total", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, vramBytes: 8 * 1024 ** 3, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, vramBytes: 2 * 1024 ** 3, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.00 GiB/);

    // Hide the first row (glm-ocr, 2.1) → total drops, row is marked off.
    w.shadow.querySelector(".vram-row .vram-dot").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /8\.00 GiB/, "hidden model excluded from total");
    assert.ok(w.shadow.querySelector(".vram-row.off"), "hidden row is dimmed");

    // Click again → back in.
    w.shadow.querySelector(".vram-row .vram-dot").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.00 GiB/, "unhidden → back in total");
});

test("VRAM monitor pauses polling while the sidebar is slid closed", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "x", vramGB: 1, expiresAt: null }] });
    // sidebarOpen defaults false (no __mlSidebarOpen received) → poll is skipped
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 0, "no poll while closed");
});

test("VRAM monitor shows unavailable with no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.match(w.shadow.querySelector(".vram-empty").textContent, /unavailable/);
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

// The header status dot reflects the "responds-next" model's load state. It
// polls OLLAMA_PS only in detail view + slid-open, so each test opens the row.
async function openDetail(w, hash, model, opts = {}) {
    await w.raw({ __mlSidebarOpen: true });                 // slid open → polling allowed
    await w.dispatch(chatStart(hash, 0, "q", { model: opts.pending ? null : model, ...opts.startExtend }));
    if (!opts.pending) await w.dispatch(chatResult(hash, 0, "a", { model, extend: opts.extend ?? null }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    return w.shadow.querySelector(".head .dot");
}

test("status dot: loaded (green) when the model is resident in VRAM", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "qwen3:14b", vramGB: 8, expiresAt: null }] });
    const dot = await openDetail(w, "s1", "qwen3:14b");
    assert.ok(dot.classList.contains("loaded"), `expected loaded, got "${dot.className}"`);
});

test("status dot: cold (blue) when installed but not resident", async () => {
    const w = await loadSidebarWorld({ models: ["qwen3:14b"], vram: [] });   // in the list, not in /api/ps
    const dot = await openDetail(w, "s2", "qwen3:14b");
    assert.ok(dot.classList.contains("cold"), `expected cold, got "${dot.className}"`);
});

test("status dot: unavailable (red) when the server doesn't list the model", async () => {
    const w = await loadSidebarWorld({ models: ["other:1b"], vram: [] });
    const dot = await openDetail(w, "s3", "ghost:70b");
    assert.ok(dot.classList.contains("unavailable"), `expected unavailable, got "${dot.className}"`);
});

test("status dot: in-flight (pulsing) while a turn is pending", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "qwen3:14b", vramGB: 8, expiresAt: null }] });
    const dot = await openDetail(w, "s4", "qwen3:14b", { pending: true });
    assert.ok(dot.classList.contains("inflight"), `expected inflight, got "${dot.className}"`);
});

test("status dot: tooltip shows the RIGHT variant's VRAM when a family shares a base name", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "gemma4:e2b", vramGB: null, expiresAt: null },   // CPU-resident, listed first
        { model: "gemma4:31b", vramGB: 47.4, expiresAt: null },
    ] });
    const dot = await openDetail(w, "sv", "gemma4:31b");
    assert.ok(dot.classList.contains("loaded"));
    const tip = dot.parentElement.querySelector(".tt-pop").textContent;
    assert.match(tip, /47\.4 GB VRAM/, `tooltip should show the 31b's VRAM, got "${tip}"`);
});

test("status dot: a CPU-resident model's tooltip says CPU, not a fake VRAM number", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:e2b", vramGB: null, sizeGB: 7.7, expiresAt: null }] });
    const dot = await openDetail(w, "scpu", "gemma4:e2b");
    const tip = dot.parentElement.querySelector(".tt-pop").textContent;
    assert.match(tip, /on CPU \(7\.7 GB RAM\)/, `expected CPU RAM detail, got "${tip}"`);
});

test("status dot: tooltip flags partial CPU offload when size_vram < size", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "big:70b", vramGB: 30, sizeGB: 45, expiresAt: null }] });
    const dot = await openDetail(w, "spart", "big:70b");
    assert.ok(dot.classList.contains("loaded"));
    assert.match(dot.parentElement.querySelector(".tt-pop").textContent, /partial CPU offload/);
});

test("status dot: cloud (violet) for a listed-but-not-Ollama model", async () => {
    const w = await loadSidebarWorld({ models: ["gpt-4o", "local:8b"], ollamaModels: ["local:8b"], vram: [] });
    const dot = await openDetail(w, "scloud", "gpt-4o");
    assert.ok(dot.classList.contains("cloud"), `expected cloud, got "${dot.className}"`);
    assert.match(dot.parentElement.querySelector(".tt-pop").textContent, /External API/);
});

test("status dot: no cloud guess when provenance is unknown (ollamaModels null)", async () => {
    const w = await loadSidebarWorld({ models: ["gpt-4o"], ollamaModels: null, vram: [] });
    const dot = await openDetail(w, "sunk", "gpt-4o");
    // Can't confirm it's external → falls back to cold, never mislabels as cloud.
    assert.ok(dot.classList.contains("cold"), `expected cold, got "${dot.className}"`);
});

test("VRAM panel shows a CPU-resident model's RAM size, not '?'", async () => {
    // vramBytes 0 / no gpus[] is the server's "on the CPU" — the row shows its RAM footprint, never "?".
    const w = await loadSidebarWorld({ vram: [{ model: "util:2b", vramGB: null, vramBytes: 0, sizeGB: 7.7, sizeBytes: 8 * 1024 ** 3, expiresAt: null }] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.match(w.shadow.querySelector(".vram-gb").textContent, /8\.00 GiB \(CPU\)/);
});

test("status dot: unknown (grey) when there's no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    const dot = await openDetail(w, "s5", "qwen3:14b");
    assert.ok(dot.classList.contains("unknown"), `expected unknown, got "${dot.className}"`);
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

// --- backend unreachable: a dead box reads at a glance in BOTH surfaces (panel banner + HUD card) ---

const agentFail = (hash, error, steps = 0) => ({ kind: "agent-result", id: hash, ts: Date.now() + 100, save: false, session: { hash, turn: steps }, summary: "", steps, hitCap: false, error });
const UNREACHABLE = "Couldn't reach the server at http://gpubox:11434 (Failed to fetch). Is OpenWebUI / Ollama running there?";

test("backend offline (panel): an unreachable run failure shows a top banner; a later success clears it", async () => {
    // The proactive health probe (LIST_MODELS) independently sets/clears backendError, so make it AGREE with
    // each phase (down, then up) — else it races the run-driven banner (a flaky CI red). `flush` lets it settle.
    let reachable = false;
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => reachable ? { data: ["m"] } : { error: "Failed to fetch" } });
    await w.dispatch(agentStart("bo1", "do a thing"));
    await w.dispatch(agentFail("bo1", UNREACHABLE));
    await w.flush();
    const banner = w.shadow.querySelector(".backend-offline");
    assert.ok(banner, "the offline banner appears in the panel");
    assert.match(banner.textContent, /Backend unreachable/);
    assert.match(banner.textContent, /gpubox/, "shows the configured server URL");
    // A subsequent successful run means the box answered → clear it (the probe now agrees it's reachable).
    reachable = true;
    await w.dispatch(agentStart("bo2", "another"));
    await w.dispatch(agentResult("bo2", "done", 1));
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null, "a successful run clears the banner");
});

test("backend offline (panel): an HTTP-status failure does NOT show the banner (the box answered)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bo3", "x"));
    await w.dispatch(agentFail("bo3", "HTTP 500 from http://x: boom"));
    await w.tick();
    assert.equal(w.shadow.querySelector(".backend-offline"), null, "an HTTP error is not 'unreachable'");
});

test("backend offline (HUD card): an unreachable failure shows a distinct 'Backend unreachable' card", async () => {
    // The box is down, so the health probe must AGREE (error), else it clears the run-set backendError → flake.
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("boc", "do a thing"));
    await w.dispatch(agentFail("boc", UNREACHABLE));
    await w.flush();
    assert.ok(w.shadow.querySelector(".card-error-offline"), "the HUD card uses the offline error variant");
    assert.match(w.shadow.querySelector(".card-app, .card-body, body").textContent, /Backend unreachable/, "the card headline says the box is unreachable");
});

// The PROACTIVE path: the health probe (LIST_MODELS) flags a dead box even when NO run runs (or a run hangs
// silently with no error event — the reported "stuck on Starting…" bug). This is what makes the offline state
// appear without drilling into a failed run.
test("backend offline (proactive): the health probe flags an unreachable backend with NO run at all", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "/api/models: Failed to fetch" }) });
    await w.flush();   // let the on-mount health probe run
    const banner = w.shadow.querySelector(".backend-offline");
    assert.ok(banner, "the banner appears from the probe — no run needed");
    assert.match(banner.textContent, /Backend unreachable/);
    assert.match(banner.textContent, /gpubox/);
});

test("backend offline (proactive): an HTTP / 'no models installed' probe error is NOT flagged (the box answered)", async () => {
    const w = await loadSidebarWorld({ listModels: () => ({ error: "The server is reachable but has no models installed." }) });
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null, "a reachable-but-empty server is not 'offline'");
});

test("backend offline (proactive): a healthy probe leaves no banner", async () => {
    const w = await loadSidebarWorld({ listModels: () => ({ data: ["m1", "m2"] }) });
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null);
});

test("backend offline (HUD card, proactive): a dead box shows an offline card even with no run event", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.flush();
    assert.match(w.shadow.querySelector("body").textContent, /Backend (unreachable|down)/i, "the HUD reflects the dead box instead of a silent/stuck card");
});

test("backend offline (mid-run): a server that dies MID-run flags offline AND keeps the completed steps", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.dispatch(agentStart("mid", "a multi-step task"));
    await w.dispatch(agentStep("mid", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "found: x" }));
    // …the box dies on the NEXT model call → the loop errors with an unreachable message.
    await w.dispatch(agentFail("mid", UNREACHABLE, 1));
    await w.tick();
    assert.ok(w.shadow.querySelector(".backend-offline"), "a mid-run death raises the offline banner");
    // The progress so far is NOT lost — the completed step is still in the run's detail.
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".view").textContent, /found: x/, "the step that completed before the death survives");
});

test("backend offline (mid-run, HUD card): a mid-run death shows the offline card, not a stuck 'Working…'", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("midc", "a multi-step task"));
    await w.dispatch(agentStep("midc", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "found: x" }));
    await w.dispatch(agentFail("midc", UNREACHABLE, 1));
    await w.tick();
    assert.ok(w.shadow.querySelector(".card-error-offline"), "the HUD card flags the mid-run death as unreachable");
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

test("HUD 'Show work' blocks: a mid-run STEER doesn't shift a follow-up message into the previous block", async () => {
    // `run.says` is overloaded — a new-turn follow-up (a continuation, NO sayId) AND a mid-run steer (HAS a
    // sayId). buildRunBlocks used to index says[i-1] by answer, so a steer shifted every later message: the
    // steer became a block's prompt and the real follow-up (the LATEST message) vanished. Continuations must
    // index the prompts; steers render inline in the block they were sent in.
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    const H = "steerblk";
    let t = Date.now();
    await w.dispatch(agentStart(H, "task one", "m", 20));
    await w.dispatch(agentStep(H, 1, { tool: "exec", arguments: { js: "1" }, result: "r1" }));
    await w.dispatch(agentResult(H, "answer one", 1));
    await w.dispatch(agentSay(H, "question two", undefined, ++t));       // continuation (new turn), no sayId
    await w.dispatch(agentStep(H, 2, { tool: "exec", arguments: { js: "2" }, result: "r2" }));
    await w.dispatch(agentSay(H, "STEERED note", "steer1", ++t));        // MID-RUN steer, has a sayId
    await w.dispatch(agentStep(H, 3, { tool: "exec", arguments: { js: "3" }, result: "r3" }));
    await w.dispatch(agentResult(H, "answer two", 3));
    await w.dispatch(agentSay(H, "question three", undefined, ++t));     // the LATEST follow-up (was getting lost)
    await w.dispatch(agentStep(H, 4, { tool: "exec", arguments: { js: "4" }, result: "r4" }));
    await w.dispatch(agentResult(H, "answer three", 4));
    await w.tick();
    w.shadow.querySelector(".card-work-toggle").click(); await w.tick();   // open Show work
    const heads = [...w.shadow.querySelectorAll(".run-block-sum")].map(s => s.textContent);
    assert.equal(heads.length, 3, "three blocks (task + two follow-ups)");
    // No utility model in the test → the block header falls back to the prompt text.
    assert.match(heads[1], /question two/, "block 2's prompt is the continuation Q2");
    assert.match(heads[2], /question three/, "block 3's prompt is Q3 — the latest message is NOT lost / shifted");
    assert.ok(!heads.some(h => /STEERED note/.test(h)), "the steer is NOT promoted to a block prompt");
    // Expand block 2 (Q2's turn) — the steer sent during it renders INLINE there, and Q3 is NOT swallowed in.
    const blocks = [...w.shadow.querySelectorAll(".run-block")];
    blocks[1].querySelector(".run-block-head").click(); await w.tick();
    const b1 = blocks[1].textContent;
    assert.match(b1, /STEERED note/, "the mid-run steer renders inline in the block it was sent in");
    assert.doesNotMatch(b1, /question three/, "the latest follow-up did NOT get injected into the previous block");
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

test("a straggler step arriving AFTER a cancel does not re-show 'running' (background-run seal)", async () => {
    // Design-A/DevTools bug: a background-hosted run keeps fanning the in-flight tool's late DONE after the
    // user cancels; it lands AFTER the page's cancelled result and used to flip the session back to
    // "running" (footer + composer stuck), with no further result to clear it. The terminal result SEALS
    // the turn so a straggler (step ≤ the sealed step) can't resurrect it.
    const w = await loadSidebarWorld();
    const H = "cxl";
    await w.dispatch(agentStart(H, "click the button", "m", 20));
    await w.dispatch(agentStep(H, 6, { seq: 5, pending: true, tool: "locate", arguments: { description: "a button" } }));  // START (in-flight)
    await w.dispatch({ kind: "agent-result", id: H, ts: Date.now() + 100, save: false, session: { hash: H, turn: 6 }, summary: "Cancelled by the caller.", steps: 0, cancelled: true });
    // The straggler: the in-flight locate's DONE, same seq/step, arriving after the cancel.
    await w.dispatch(agentStep(H, 6, { seq: 5, tool: "locate", arguments: { description: "a button" }, result: "(Grounding missed.) No candidates." }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".pending-note"), "no live 'running' footer after cancel + straggler");
    assert.ok(w.shadow.querySelector(".msg.asst"), "the cancelled answer still renders");
    // A genuine NEW turn (a step PAST the sealed step) still unseals → 'running' returns.
    await w.dispatch(agentStep(H, 7, { seq: 6, thought: "New turn." }));
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "a new-turn step past the sealed step re-shows running");
});

test("debug In render of a click step is a hoverable element reference, not the card's intent sentence", async () => {
    // Regression: click/type emit an `action` intent descriptor (for the off-mode CARD). The DEBUG log
    // (overlay/devtools) must still render it as a hoverable/selectable element reference — the selector
    // + human label, hover-to-outline, right-click-to-copy — NOT the user-facing "Agent wants to…" sentence.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("act1", "click the toggle", "m"));
    await w.dispatch(agentStep("act1", 1, {
        seq: 0, tool: "click", arguments: { selector: "#bigToggle" }, result: "Clicked #bigToggle",
        renderIn: { type: "action", verb: "Click", kind: "button", target: "Show the giant scrolling table", selector: "#bigToggle" },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();   // expand → In/Out
    await w.tick();

    const elRef = toolStep.querySelector(".r-el");
    assert.ok(elRef, "In renders a hoverable element reference");
    assert.match(elRef.querySelector(".r-el-path").textContent, /#bigToggle/, "shows the selector (copyable/hoverable)");
    assert.match(elRef.textContent, /Show the giant scrolling table/, "shows the human label too");
    assert.ok(!toolStep.querySelector(".action-sentence"), "the user-facing intent sentence stays OUT of the debug log");
});

test("a tool step shows the tool's short summary as a hover tooltip on its name", async () => {
    const w = await loadSidebarWorld();
    const cfg = { system: "", customSystem: false, maxSteps: 10, think: null, env: true, vision: null, hints: null,
        tools: [{ name: "look", requiresApproval: false, summary: "Screenshots the page so the agent can see it." }] };
    await w.dispatch(agentStart("tsum", "look at it", "m", 10, cfg));
    await w.dispatch(agentStep("tsum", 1, { tool: "look", arguments: {}, result: "a screenshot" }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    const wrap = toolStep.querySelector(".tool-name-wrap");
    assert.ok(wrap, "the tool name has a tooltip wrapper (a summary was provided)");
    assert.match(wrap.querySelector(".tt-pop").textContent, /Screenshots the page/, "the summary is the tooltip");
});

test("a FINAL-answer turn with only reasoning (no thought/tool) still renders its thinking block", async () => {
    // The model thinks in reasoning_content and puts its answer in content → the content becomes the
    // summary (answer bubble), the reasoning is a reasoning-only step. It must NOT be filtered out.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("fin", "what is 6*7"));
    await w.dispatch(agentStep("fin", 1, { reasoning: "6 times 7 is 42." }));   // reasoning-only, no thought/tool
    await w.dispatch(agentResult("fin", "It's 42.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".athought.athinking"), "the final turn's thinking block renders (not filtered out)");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /It's 42/, "the content shows as the answer");
});

test("a delegated look's Out renders the reader's image + which model + its output (not element text)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lk", "look at the card"));
    await w.dispatch(agentStep("lk", 1, { tool: "look", arguments: { selector: "#card" }, result: "a sponsored product card",
        renderOut: { type: "look", image: "data:image/png;base64,SHOT", model: "qwen2.5vl", output: "a sponsored product card", label: 'the element "#card"' } }));
    await w.dispatch(agentResult("lk", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const look = w.shadow.querySelector(".r-look");
    assert.ok(look, "the look Out renders");
    assert.equal(look.querySelector("img").getAttribute("src"), "data:image/png;base64,SHOT", "the exact image the reader saw");
    assert.match(look.querySelector(".r-image-label").textContent, /viewed by.*qwen2\.5vl/, "names which model read it");
    assert.match(look.querySelector(".r-look-out").textContent, /sponsored product card/, "the model's output");
});

test("agent step: reasoning_content renders as a distinct 'thinking' block, separate from the prose thought", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rsn", "click the red guy"));
    // A turn where the model thinks in reasoning_content AND says something in content.
    await w.dispatch(agentStep("rsn", 1, { thought: "I'll click it.", reasoning: "The red guy has a red cap and blue overalls." }));
    await w.dispatch(agentStep("rsn", 1, { tool: "click", arguments: { selector: "b" }, result: "clicked" }));
    await w.dispatch(agentResult("rsn", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const thinking = w.shadow.querySelector(".athought.athinking");
    assert.ok(thinking, "a distinct thinking block renders");
    assert.match(thinking.querySelector(".who").textContent, /thinking/);
    // Collapsed: no status dot (thinking can't fail), and the preview is an ~token estimate, NOT the text.
    assert.equal(thinking.querySelector(".dot"), null, "no status dot on a thinking block");
    assert.match(thinking.querySelector(".astep-preview").textContent, /~\d+ tokens/, "collapsed shows a token estimate");
    assert.doesNotMatch(thinking.querySelector(".astep-preview").textContent, /red cap/, "collapsed does NOT spam the reasoning text");
    // Expand it → the reasoning text.
    thinking.querySelector(".astep-head").click();
    await w.tick();
    assert.match(thinking.textContent, /red cap and blue overalls/, "reasoning shown");
    // The content is rendered as PROSE (like the answer) — no 'thought' label or status dot, expanded.
    const prose = w.shadow.querySelector(".aturn-prose");
    assert.ok(prose, "content renders as its own prose block");
    assert.equal(prose.querySelector(".who"), null, "no 'thought' label on the prose");
    assert.equal(prose.querySelector(".dot"), null, "no status dot on the prose");
    assert.match(prose.querySelector(".md").textContent, /I'll click it/, "the content prose is shown, expanded");
});

test("agent step renders IN-FLIGHT, then the DONE patches it in place (same seq → no duplicate row)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ifl", "compute a thing"));
    // In-flight START: a pending tool call, no result yet.
    await w.dispatch(agentStep("ifl", 1, { seq: 1, pending: true, tool: "python_exec", arguments: { code: "return 6*7" } }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let steps = w.shadow.querySelectorAll(".astep.tool");
    assert.equal(steps.length, 1, "the pending tool call renders while still running");
    assert.ok(steps[0].classList.contains("pending"), "step marked pending");
    assert.match(steps[0].querySelector(".astep-preview").textContent, /running/i, "shows a running indicator, not a result");

    // DONE for the same seq → patches the row in place (one step, now with the result).
    await w.dispatch(agentStep("ifl", 1, { seq: 1, tool: "python_exec", arguments: { code: "return 6*7" }, result: "42" }));
    await w.tick();
    steps = w.shadow.querySelectorAll(".astep.tool");
    assert.equal(steps.length, 1, "no duplicate row — the pending step was PATCHED, not appended");
    assert.ok(!steps[0].classList.contains("pending"), "no longer pending");
    assert.match(steps[0].querySelector(".astep-preview").textContent, /42/, "the result filled in");
});

test("agent view: a usage-only step (no thought/tool) does not render an empty step box", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("aus", "answer directly"));
    // The model answers on step 1 with no tools — the loop emits a usage-only step
    // (for the gauge). It must NOT render as a bare "STEP 1/10" box.
    await w.dispatch(agentStep("aus", 1, { usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } }));
    await w.dispatch(agentResult("aus", "done, no tools needed.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".aturn").length, 0, "no empty step group rendered");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /no tools needed/, "the answer still renders");
});

test("agent tool steps render descriptors (image / elements / table)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agr", "look at stuff"));
    await w.dispatch(agentStep("agr", 1, { tool: "look", arguments: {}, renderOut: { type: "image", src: "data:image/png;base64,AAA", label: "viewport" } }));
    await w.dispatch(agentStep("agr", 2, { tool: "findByText", arguments: { text: "cat" }, elements: 2, renderOut: { type: "elements", items: [{ path: "div.card", text: "Black cat", index: 0 }, { path: "div.card", text: "White cat", index: 1 }] } }));
    await w.dispatch(agentStep("agr", 3, { tool: "stats", arguments: {}, renderIn: { type: "table", columns: ["k", "v"], rows: [["a", 1], ["b", 2]] } }));
    await w.dispatch(agentResult("agr", "done", 3));

    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();   // expand all
    await w.tick();

    assert.equal(w.shadow.querySelector(".r-image img").getAttribute("src"), "data:image/png;base64,AAA");
    assert.match(w.shadow.querySelector(".r-image-label").textContent, /viewport/);
    assert.equal(w.shadow.querySelectorAll(".r-el").length, 2, "elements list rendered");
    assert.match(w.shadow.querySelector(".r-el-text").textContent, /Black cat/);
    assert.equal(w.shadow.querySelectorAll(".r-el-idx").length, 2, "multiple elements → each shows its #N badge");
    assert.equal(w.shadow.querySelector(".r-table td") ? w.shadow.querySelectorAll(".r-table td").length : 0, 4, "table cells rendered");
});

test("a SINGLE-element render hides the #0 badge (it's just the one element)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("one", "find the button"));
    await w.dispatch(agentStep("one", 1, { tool: "locate", arguments: {}, renderOut: { type: "elements", items: [{ path: "#go", text: "Go" }] } }));
    await w.dispatch(agentResult("one", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".r-el").length, 1, "one element rendered");
    assert.equal(w.shadow.querySelector(".r-el-idx"), null, "no #0 badge for a single element");
    assert.match(w.shadow.querySelector(".r-el-path").textContent, /#go/, "the element still shows");
});

// Helper: build a locate render descriptor from an array of substeps + the final pick.
const locateRender = (mode, model, substeps, extra = {}) => ({ type: "locate", mode, model, substeps, ...extra });

test("locate render: grounding is a box substep + a DOM-snap substep, with the pick", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lgr", "find it"));
    await w.dispatch(agentStep("lgr", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("grounding", "qwen2.5vl:7b", [
            { label: "Grounding · box (250, 250) → (300, 300)", prompt: "Locate \"star\" …", output: "250,250,300,300", rawImage: "data:image/png;base64,GGGraw", image: "data:image/png;base64,GGG" },
            { label: "DOM snap · +40px search margin", image: "data:image/png;base64,RRR" },
        ], { picked: "[button] \"Star\" → #bar > div:nth-of-type(1)", pickedBy: "snap" }) }));
    await w.dispatch(agentResult("lgr", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();

    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-head").textContent, /Grounding · qwen2.5vl:7b/);
    assert.equal(loc.querySelectorAll(".r-loc-sub").length, 2, "two substeps");
    assert.ok(loc.querySelector(".r-loc-io"), "In(prompt) disclosure present");
    assert.match(loc.textContent, /box \(250, 250\) → \(300, 300\)/);      // box coords in substep 1's head
    assert.match(loc.textContent, /\+40px search margin/);                  // margin in substep 2's head
    assert.match(loc.textContent, /Out:.*250,250,300,300/);   // Out is a collapsible like In
    // Default view is "visualise" → the overlay images.
    const imgs = [...loc.querySelectorAll(".r-loc-stage img")].map(i => i.getAttribute("src"));
    assert.deepEqual(imgs, ["data:image/png;base64,GGG", "data:image/png;base64,RRR"]);
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Snapped to[\s\S]*Star[\s\S]*nth-of-type\(1\)/);
});

test("locate render: the raw⇄visualise toggle swaps to the exact image sent to the model", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lrv", "find it"));
    await w.dispatch(agentStep("lrv", 1, { tool: "locate", arguments: { description: "x" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Set-of-Marks · 3 candidates · model chose #2", prompt: "which badge…", output: "2", rawImage: "data:image/png;base64,SENT", image: "data:image/png;base64,OVERLAY" },
        ], { picked: "#2 [button] → #b", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lrv", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.equal(loc.querySelector(".r-loc-stage img").getAttribute("src"), "data:image/png;base64,OVERLAY", "visualise by default");
    const toggle = loc.querySelector(".r-loc-viz");
    [...toggle.querySelectorAll("button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".r-locate .r-loc-stage img").getAttribute("src"), "data:image/png;base64,SENT", "raw = the image sent to the model");
});

test("locate render: no-box grounding is a single box substep (no snap)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lnb", "find it"));
    await w.dispatch(agentStep("lnb", 1, { tool: "locate", arguments: { description: "ghost" }, renderOut:
        locateRender("grounding", "qwen2.5vl:3b", [
            { label: "Grounding · no box returned", prompt: "Locate …", output: "NONE", image: "data:image/png;base64,PLAIN" },
        ]) }));
    await w.dispatch(agentResult("lnb", "not found", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.equal(loc.querySelectorAll(".r-loc-sub").length, 1, "one substep, no snap");
    assert.match(loc.querySelector(".r-loc-subhead").textContent, /no box returned/);
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Snapped to[\s\S]*\(none\)/);
});

test("locate render: marks is one Set-of-Marks substep with the pick", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lmk", "find it"));
    await w.dispatch(agentStep("lmk", 1, { tool: "locate", arguments: { description: "trash" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Set-of-Marks · 4 candidates · model chose #2", prompt: "which badge…", output: "2", rawImage: "data:image/png;base64,RAW", image: "data:image/png;base64,MARKS" },
        ], { picked: "#2 [button] → #bar > div:nth-of-type(2)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lmk", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-head").textContent, /Set-of-Marks · gemma4:31b/);
    assert.equal(loc.querySelector(".r-loc-stage img").getAttribute("src"), "data:image/png;base64,MARKS");
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Model picked[\s\S]*nth-of-type\(2\)/);
});

test("locate render: auto-fallback shows the grounding attempt substep above the Set-of-Marks one", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lfb", "find it"));
    await w.dispatch(agentStep("lfb", 1, { tool: "locate", arguments: { description: "trash" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Grounding · no box returned", prompt: "Locate…", output: "NONE", image: "data:image/png;base64,GROUND" },
            { label: "Set-of-Marks · 5 candidates · model chose #2", note: "Grounding returned no box — fell back to Set-of-Marks.", prompt: "which badge…", output: "2", rawImage: "data:image/png;base64,RAW", image: "data:image/png;base64,MARKS" },
        ], { picked: "#2 [button] → #bar > div:nth-of-type(2)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lfb", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-note").textContent, /Grounding returned no box.*fell back to Set-of-Marks/);
    const imgs = [...loc.querySelectorAll(".r-loc-stage img")].map(i => i.getAttribute("src"));
    assert.deepEqual(imgs, ["data:image/png;base64,GROUND", "data:image/png;base64,MARKS"], "grounding attempt first, then marks");
});

test("locate render: grid single-element — cell-pick substep + DOM snap, 'Snapped to'", async () => {
    const w = await loadSidebarWorld();
    // Driver model == the sub-call model → the "standalone sub-call" note should show.
    await w.dispatch(agentStart("lgs", "find it", "gemma4:31b", 10));
    await w.dispatch(agentStep("lgs", 1, { tool: "locate", arguments: { description: "star", strategy: "grid" }, elements: 1, renderOut:
        locateRender("grid", "gemma4:31b", [
            { label: "Cell pick · grid 4×4 · model chose cells 2,3", prompt: "This image is divided into a 4×4 …", output: "2,3", rawImage: "data:image/png;base64,GRIDraw", image: "data:image/png;base64,GRID" },
            { label: "DOM snap · single element in the cell", image: "data:image/png;base64,SNAP" },
        ], { picked: "[button] → #bar > div:nth-of-type(3)", pickedBy: "snap" }) }));
    await w.dispatch(agentResult("lgs", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-head").textContent, /Grid · gemma4:31b/);
    assert.match(loc.querySelector(".r-loc-delegated").textContent, /standalone sub-call/);
    assert.match([...loc.querySelectorAll(".r-loc-subhead")].map(c => c.textContent).join(" "), /grid 4×4 · model chose cells 2,3/);
    const imgs = [...loc.querySelectorAll(".r-loc-stage img")].map(i => i.getAttribute("src"));
    assert.deepEqual(imgs, ["data:image/png;base64,GRID", "data:image/png;base64,SNAP"], "grid image then the snap");
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Snapped to[\s\S]*nth-of-type\(3\)/);
    assert.equal(loc.querySelector(".r-loc-note"), null, "no hand-off note when a single element");
});

test("locate render: grid hand-off is two substeps (cell pick → Set-of-Marks pick), 'Model picked'", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lgh", "find it", "gemma4:31b", 10));
    await w.dispatch(agentStep("lgh", 1, { tool: "locate", arguments: { description: "star", strategy: "grid" }, elements: 1, renderOut:
        locateRender("grid", "gemma4:31b", [
            { label: "Cell pick · grid 5×3 · model chose cell 11", prompt: "grid…", output: "11", rawImage: "data:image/png;base64,GRIDraw", image: "data:image/png;base64,GRID" },
            { label: "Set-of-Marks · 15 candidates · model chose #12", note: "The cell held 15 elements, so they were re-badged and a second vision call picked one (Set-of-Marks).", prompt: "which badge…", output: "12", rawImage: "data:image/png;base64,RAW", image: "data:image/png;base64,MARKS" },
        ], { picked: "#12 [div] → #grid > div:nth-of-type(92)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lgh", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.equal(loc.querySelectorAll(".r-loc-sub").length, 2, "two substeps");
    assert.match(loc.querySelector(".r-loc-note").textContent, /held 15 elements.*second vision call picked one/i);
    assert.match([...loc.querySelectorAll(".r-loc-subhead")].map(c => c.textContent).join(" "), /Set-of-Marks · 15 candidates · model chose #12/);
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Model picked[\s\S]*#12[\s\S]*nth-of-type\(92\)/);
});

test("locate render: no delegated note when the sub-call model differs from the driver", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lgd", "find it", "qwen3:14b", 10));   // driver ≠ reader
    await w.dispatch(agentStep("lgd", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [{ label: "Set-of-Marks · 2 candidates", image: "data:image/png;base64,MARKS" }], { picked: "#1 [button] → #b", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lgd", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".r-loc-delegated"), null, "different model → no standalone-note");
});

test("agent tool step: descriptor renders its target block; the other stays raw (per-block)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agt", "run js"));
    // exec-style: the descriptor targets "in" (pretty JS); Out stays raw (the error/result).
    await w.dispatch(agentStep("agt", 1, { tool: "exec", arguments: { js: "1 + 1" }, result: "2", renderIn: { type: "code", text: "1 + 1", lang: "javascript" } }));
    await w.dispatch(agentResult("agt", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();   // expand
    await w.tick();

    const blocks = [...toolStep.querySelectorAll("details.io")];
    assert.equal(blocks.length, 2, "In + Out blocks");
    const [inB, outB] = blocks;
    assert.ok(inB.querySelector(".rr-toggle"), "In (descriptor target) has the rendered/raw toggle");
    assert.ok(inB.querySelector(".code"), "In renders the JS by default");
    assert.equal(outB.querySelector(".rr-toggle"), null, "Out has no toggle — raw only");
    assert.match(outB.textContent, /2/, "Out shows the raw result");

    // Toggle In → raw → the JSON args.
    [...inB.querySelectorAll(".rr-toggle button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.match(inB.textContent, /"js"/, "In raw shows the JSON args");
});

test("python-in: an external-sheet source renders a smart chip with the real title (not the raw id)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pysh", "sum the sheet"));
    await w.dispatch(agentStep("pysh", 1, { tool: "python_exec", arguments: { code: "return df.sum()" }, result: "ok",
        renderIn: { type: "python-in", mode: "script", code: "return df.sum()",
            tables: [{ name: "df", source: { kind: "sheet-external", label: "SHEETID44CHARS", name: "Quarterly Sales" }, columns: ["A"], rows: [[1]] }] } }));
    await w.dispatch(agentResult("pysh", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const chip = w.shadow.querySelector(".r-py-in .sheet-chip");
    assert.ok(chip, "the sheet source is a smart chip");
    assert.match(chip.querySelector(".sheet-chip-name").textContent, /Quarterly Sales/, "shows the real title, not the id");
    assert.match(chip.getAttribute("href"), /spreadsheets\/d\/SHEETID44CHARS/, "links to the sheet by id");
});

test("python_exec render: In is a notebook cell (mode + input image + source); Out is stdout + token", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pyc", "click the star"));
    await w.dispatch(agentStep("pyc", 1, {
        tool: "python_exec", arguments: { code: "return [10, 20]", cast: "pt" },
        result: "stdout:\nfound\n\n→ @pt:abcd1234 at (10, 20).",
        renderIn: { type: "python-in", mode: "pt", code: "return [10, 20]", image: "data:image/png;base64,INIMG" },
        renderOut: { type: "python-out", stdout: "found\n", token: "@pt:abcd1234" },
    }));
    await w.dispatch(agentResult("pyc", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();

    // In slot = the python-in cell header.
    const inCell = toolStep.querySelector(".r-py-in");
    assert.ok(inCell, "In renders the python-in cell");
    assert.match(inCell.querySelector(".r-py-mode").textContent, /cast: pt/, "mode line reflects the cast");
    assert.equal(inCell.querySelector(".r-py-img img").getAttribute("src"), "data:image/png;base64,INIMG", "input image shown");
    assert.match(inCell.querySelector(".code").textContent, /return \[10, 20\]/, "source highlighted");

    // Out slot = the python-out block: stdout + the minted token.
    const outCell = toolStep.querySelector(".r-py-out");
    assert.ok(outCell, "Out renders the python-out block");
    assert.match(outCell.querySelector(".r-py-stdout").textContent, /found/, "stdout shown byte-exact");
    assert.match(outCell.querySelector(".r-py-token").textContent, /@pt:abcd1234/, "minted token shown");

    // The Out raw toggle falls back to the exact result string the model received.
    const outBlock = [...toolStep.querySelectorAll("details.io")].find(b => b.querySelector(".r-py-out"));
    [...outBlock.querySelectorAll(".rr-toggle button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.match(outBlock.textContent, /→ @pt:abcd1234 at \(10, 20\)/, "Out raw = the model-facing result");
});

test("python_exec render: a Python error surfaces the traceback in the Out block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pye", "compute"));
    await w.dispatch(agentStep("pye", 1, {
        tool: "python_exec", arguments: { code: "return 1/0" },
        result: "Python error: ZeroDivisionError: division by zero",
        renderIn: { type: "python-in", mode: "script", code: "return 1/0" },
        renderOut: { type: "python-out", error: "Traceback (most recent call last):\nZeroDivisionError: division by zero" },
    }));
    await w.dispatch(agentResult("pye", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();

    assert.match(toolStep.querySelector(".r-py-mode").textContent, /script/, "no cast → script mode");
    assert.equal(toolStep.querySelector(".r-py-in .r-py-img"), null, "no input image row for an image-less run");
    assert.match(toolStep.querySelector(".r-py-err").textContent, /ZeroDivisionError/, "traceback shown");
});

test("awaiting approval of a python_exec that loads an EXTERNAL sheet warns it's a session-scoped grant", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("shg", "sum the sheet"));
    // A pending, approval-gated python_exec loading an external Google Sheet. The In is the PRE-RUN
    // preview (code-only, no tables loaded yet) — the note MUST come from the ARGS (`tables`), which is
    // the real approval-time scenario (the earlier renderIn-based detection silently showed nothing).
    await w.dispatch(agentStep("shg", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "return df['A'].sum()", tables: "https://docs.google.com/spreadsheets/d/SHEETID/edit" },
        renderIn: { type: "python-in", mode: "script", code: "return df['A'].sum()" },   // code-only, no tables
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const note = w.shadow.querySelector(".astep-approve .appr-note");
    assert.ok(note, "the approval bar shows a session-grant note (from the args, pre-run)");
    assert.match(note.textContent, /rest of this session/i, "explains the grant is session-scoped");
    // A smart chip (not the raw 44-char id): a link to the sheet, the id in its tooltip.
    const chip = note.querySelector(".sheet-chip");
    assert.ok(chip, "the sheet is a smart chip, not a raw id");
    assert.match(chip.getAttribute("href"), /spreadsheets\/d\/SHEETID/, "chip links to the sheet");
    assert.match(chip.querySelector(".tt-pop").textContent, /SHEETID/, "the full id is on hover");
    // A page-table run (a selector, not a Sheets URL) must NOT show the grant note.
    await w.dispatch(agentStep("shg", 2, {
        seq: 2, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "return df.sum()", tables: "#t" },
        renderIn: { type: "python-in", mode: "script", code: "return df.sum()" },
    }));
    await w.tick();
    const notes = [...w.shadow.querySelectorAll(".astep-approve .appr-note")];
    assert.equal(notes.length, 1, "only the external-sheet step warns — a page-table step doesn't");
});

test("agent options: the tool definitions viewer renders a JSON tree of each tool's parameter schema", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tdv", "do stuff", "m", 10, {
        system: "you are an automation agent", customSystem: false, maxSteps: 10,
        think: null, env: true, vision: null, hints: null,
        tools: [{
            name: "click", requiresApproval: true, vision: false,
            description: "Click an element by selector.",
            parameters: { type: "object", properties: { selector: { type: "string", description: "a CSS selector" } }, required: ["selector"] },
        }],
    }));
    await w.dispatch(agentResult("tdv", "done", 0));
    w.shadow.querySelector(".row").click();
    await w.tick();

    // Open the "agent options" block, then reveal the tool definitions.
    w.shadow.querySelector(".block .block-head").click();
    await w.tick();
    const toolsBtn = [...w.shadow.querySelectorAll(".raw-btn")].find(b => /tool definitions/.test(b.textContent));
    assert.ok(toolsBtn, "a 'tool definitions' toggle appears when the config carries full defs");
    toolsBtn.click();
    await w.tick();

    const def = w.shadow.querySelector(".tooldef");
    // Collapsed by default: the name + badges show, the description/params don't.
    assert.match(def.querySelector(".tooldef-name").textContent, /click/, "the tool name");
    assert.ok(def.querySelector(".tooldef-warn"), "requiresApproval shows a warn marker (even collapsed)");
    assert.equal(def.querySelector(".tooldef-desc"), null, "description hidden until expanded");
    // Expand the card → description + params appear.
    def.querySelector(".tooldef-head.clickable").click();
    await w.tick();
    assert.match(def.querySelector(".tooldef-desc").textContent, /Click an element/, "the description");
    // The JSON tree: a foldable `parameters` root; expanding it reveals the schema keys.
    const root = def.querySelector(".tooldef-params .jt-branch");
    assert.match(root.textContent, /parameters/, "the tree roots at `parameters`");
    root.click();   // expand
    await w.tick();
    assert.match(def.querySelector(".tooldef-params").textContent, /selector/, "expanded tree shows a nested property");
});

test("agent tool steps carry an approval provenance badge (auto/user green, denied red)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("apv", "run"));
    await w.dispatch(agentStep("apv", 1, { tool: "exec", arguments: { js: "1" }, result: "1", approval: "readonly", renderIn: { type: "code", text: "1", lang: "javascript" } }));
    await w.dispatch(agentStep("apv", 2, { tool: "click", arguments: { selector: "b" }, result: "clicked", approval: "user" }));
    await w.dispatch(agentStep("apv", 3, { tool: "exec", arguments: { js: "2" }, result: "Denied by the user.", approval: "denied" }));
    await w.dispatch(agentStep("apv", 4, { tool: "click", arguments: { selector: "#gone" }, result: 'No element matches "#gone".', approval: "skipped" }));
    await w.dispatch(agentResult("apv", "done", 4));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const steps = [...w.shadow.querySelectorAll(".astep.tool")];
    assert.equal(steps.length, 4, "four tool steps");
    assert.match(steps[0].querySelector(".appr.yes").textContent, /auto-approved/);
    assert.ok(steps[0].classList.contains("appr-yes"), "auto-approved step marks provenance (badge-only: the BADGE is the cue, the bar stays neutral)");
    assert.match(steps[1].querySelector(".appr.yes").textContent, /approved/);
    assert.match(steps[2].querySelector(".appr.no").textContent, /denied/);
    assert.ok(steps[2].classList.contains("appr-no"), "denied step marks provenance (visual status is the red DENIED badge, not the bar)");
    // A doomed (precheck-skipped) action gets a neutral grey "skipped" badge — not yes/no.
    assert.match(steps[3].querySelector(".appr.skip").textContent, /skipped/);
    assert.ok(steps[3].classList.contains("appr-skip"), "skipped step marks provenance (badge carries it)");
    assert.equal(steps[3].querySelector(".appr.yes, .appr.no"), null, "skipped is neither approved nor denied");
});

test("denying a gated step KEEPS its In render (the DONE's blank renderIn doesn't clobber the START's)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dng", "click something"));
    // The awaiting-approval START carries the In preview (e.g. click's targeted @pt).
    await w.dispatch(agentStep("dng", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "@pt:ce6c8a40" },
        renderIn: { type: "elements", items: [{ path: "@pt:ce6c8a40" }] },
    }));
    // The DONE after DENIAL: result + approval, but NO renderIn/renderOut — the tool never ran.
    await w.dispatch(agentStep("dng", 1, {
        seq: 1, tool: "click", arguments: { selector: "@pt:ce6c8a40" },
        result: "Denied by the user. Do not retry this exact call; try another approach.", approval: "denied",
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    // The In still renders the elements descriptor (not raw JSON) despite the blank DONE.
    assert.ok(toolStep.querySelector(".r-el"), "the In render persists after denial");
    assert.match(toolStep.querySelector(".r-el-path").textContent, /@pt:ce6c8a40/);
    assert.match(toolStep.textContent, /Denied by the user/, "the denial result still shows");
});

test("python bench: opens from the header, runs a script, and renders the sandbox result", async () => {
    const w = await loadSidebarWorld({ pythonExec: (p) => ({ ok: true, value: p.hardened ? 1 : 2, stdout: "hi\n" }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code");
    assert.ok(ta, "the code editor renders");
    ta.value = "print('hi')\nreturn 1";
    ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-run").click();
    await w.tick();
    // The PYTHON_EXEC payload carried the code; default mode readonly → hardened.
    assert.equal(w.pyCalls.length, 1);
    assert.match(w.pyCalls[0].code, /print\('hi'\)/);
    assert.equal(w.pyCalls[0].hardened, true, "readonly mode → hardened");
    // The result renders through the python-out panel (stdout).
    const out = w.shadow.querySelector(".bench-out .r-py-out");
    assert.ok(out, "result renders in the python-out panel");
    assert.match(out.textContent, /hi/, "stdout shown");
    // stdout is a collapsible section (a <details>), like the other blocks.
    assert.equal(out.querySelector(".r-py-stdout").tagName, "DETAILS", "stdout is a collapsible section");
    // The info note is a tooltip now, not always-shown prose.
    assert.equal(w.shadow.querySelector(".bench-note"), null, "no always-shown note");
    assert.ok(w.shadow.querySelector(".bench-info .tt-pop"), "the note is a hover tooltip");
});

test("python bench: a returned DataFrame renders as a real table (PyDfTable), not a text repr", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "  foo  bar\n0  1  4", stdout: "", table: { columns: ["foo", "bar"], rows: [[1, 4], [2, 5]] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code");
    ta.value = "return df"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-run").click();
    await w.tick();
    const df = w.shadow.querySelector(".bench-out .r-df-scroll, .bench-out table.dftable, .bench-out .r-py-val table");
    assert.ok(df || w.shadow.querySelector(".bench-out .r-py-val"), "the value section renders");
    // The DataFrame table (PyDfTable) shows the column headers.
    assert.match(w.shadow.querySelector(".bench-out .r-py-val").textContent, /foo/);
    assert.match(w.shadow.querySelector(".bench-out .r-py-val").textContent, /bar/);
});

test("python bench: full mode sends hardened:false", async () => {
    const w = await loadSidebarWorld();
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const sel = w.shadow.querySelector(".bench-mode select");
    sel.value = "full";
    sel.dispatchEvent(new w.window.Event("change"));
    const ta = w.shadow.querySelector(".bench-code");
    ta.value = "return 1";
    ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-run").click();
    await w.tick();
    assert.equal(w.pyCalls[0].hardened, false, "full mode → not hardened");
});

test("exec code is beautified for display when the descriptor sets format", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bty", "run js"));
    const ugly = "[...document.querySelectorAll('a')].map(x=>{const y=x.href;return {y}})";
    await w.dispatch(agentStep("bty", 1, { tool: "exec", arguments: { js: ugly }, result: "ok", renderIn: { type: "code", text: ugly, lang: "javascript", format: true } }));
    await w.dispatch(agentResult("bty", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();

    const code = w.shadow.querySelector("details.io .code").textContent;
    assert.match(code, /=> \{/, "arrow body spaced out by the beautifier");
    assert.ok(code.split("\n").length >= 3, "reflowed onto multiple lines (source was one line)");
});

test("code line-number gutter: off by default, toggled on via settings, applied from storage", async () => {
    // Applied from storage on mount.
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    const html = w.window.document.documentElement;
    assert.equal(html.getAttribute("data-codelines"), "on", "gutter attr set from storage.local");
    await w.dispatch(agentStart("ln", "x"));
    await w.dispatch(agentStep("ln", 1, { tool: "exec", arguments: { js: "a;\nb;\nc;" }, result: "ok", renderIn: { type: "code", text: "a;\nb;\nc;", lang: "javascript" } }));
    await w.dispatch(agentResult("ln", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");   // the In block (the JS)
    const nos = [...inB.querySelectorAll(".code.numbered .cline .lno")].map(n => n.textContent);
    assert.deepEqual(nos, ["1", "2", "3"], "one right-aligned number per source line");
});

test("numbered gutter preserves line content — no spurious span-reopen prefix", async () => {
    // Regression: a text token starting with " s" was misread as a <span> open and
    // re-emitted on every following line (e.g. "searchResults = " leaking downward).
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    const js = "const searchResults = 1;\nconsole.log('n:', searchResults);\nreturn searchResults;";
    await w.dispatch(agentStart("lnp", "x"));
    await w.dispatch(agentStep("lnp", 1, { tool: "exec", arguments: { js }, result: "1", renderIn: { type: "code", text: js, lang: "javascript" } }));
    await w.dispatch(agentResult("lnp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");
    const lines = [...inB.querySelectorAll(".code.numbered .cline .lcode")].map(n => n.textContent);
    assert.deepEqual(lines, js.split("\n"), "each rendered line matches its source line exactly");
});

test("code display prefs: wrap⇄scroll + line-number toggles flip root attrs and persist", async () => {
    const w = await loadSidebarWorld();
    const html = w.window.document.documentElement;
    assert.equal(html.getAttribute("data-codewrap"), "on", "wrap on by default");
    assert.equal(html.getAttribute("data-codelines"), "off", "gutter off by default");

    await openSettings(w, "Appearance");

    const sel = [...w.shadow.querySelectorAll(".settings select")].find(s => [...s.options].some(o => o.value === "scroll"));
    sel.value = "scroll";
    sel.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(html.getAttribute("data-codewrap"), "off", "wrap → scroll");
    assert.equal(w.localStore.ml_debug_codewrap, false, "scroll persisted");

    const chk = [...w.shadow.querySelectorAll(".settings .set-check")]
        .find(l => /line numbers/i.test(l.textContent)).querySelector("input");
    chk.click();
    await w.tick();
    assert.equal(html.getAttribute("data-codelines"), "on", "line numbers toggled on");
    assert.equal(w.localStore.ml_debug_codelines, true, "line numbers persisted");
});

// Open the export menu and click one of its format items ("Markdown" / "PDF").
async function openExportMenu(w, label) {
    w.shadow.querySelector('[aria-label="Export log"]').click();
    await w.tick();
    const item = [...w.shadow.querySelectorAll(".menu-item")].find(b => b.textContent.startsWith(label));
    assert.ok(item, `export menu offers "${label}"`);
    return item;
}

// Capture what the export menu's "Markdown" item downloads: stub the object-URL +
// anchor click (jsdom has neither URL.createObjectURL nor real navigation) and
// read back the Blob it built. Returns { name, blob }.
async function captureExport(w) {
    let blob = null, name = null;
    w.window.URL.createObjectURL = (b) => { blob = b; return "blob:mock"; };
    w.window.URL.revokeObjectURL = () => {};
    w.window.HTMLAnchorElement.prototype.click = function () { name = this.download; };
    (await openExportMenu(w, "Markdown")).click();
    await w.tick();
    return { name, blob };
}

// The text a browser would show for some markup: drop the tags (hljs wraps every
// token in a span), then undo the entity escaping. Lets a test assert on the
// source that reaches the page without hard-coding the highlighter's output.
const plainText = (html) => html.replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Capture the printable document the "PDF" item builds. printSession routes the rendered doc to the
// background (PRINT_SESSION), which prints it from a real tab — window.print() is suppressed for a frame
// inside docked DevTools. The mock records the PRINT_SESSION payload, so read the HTML back from there.
async function capturePrint(w) {
    (await openExportMenu(w, "PDF")).click();
    await w.tick();
    const last = w.printCalls[w.printCalls.length - 1];
    return { html: last ? last.html : null };
}

test("export: an image-free agent run downloads a plain markdown log", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expa", "hide slow items", "gemma4:31b", 60));
    await w.dispatch(agentStep("expa", 2, { tool: "exec", arguments: { js: "items.forEach(i=>i.remove())" }, result: "Hidden 38 items.", renderIn: { type: "code", text: "items.forEach(i=>i.remove())", lang: "javascript", format: true } }));
    await w.dispatch(agentResult("expa", "I hid all slow items.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    const text = await blob.text();
    assert.equal(name, "ml-agent-expa.md", "no images → a bare .md, named by kind + hash");
    assert.match(text, /# Agent run · gemma4:31b · expa/);
    assert.match(text, /\*\*Task:\*\* hide slow items/);
    assert.match(text, /items\.forEach\(i => i\.remove\(\)\)/, "exec JS is beautified in the log");
    assert.match(text, /Hidden 38 items\./, "tool result captured");
    assert.match(text, /## Answer\n\nI hid all slow items\./);
});

test("export: a navigate step writes a page-transition divider into the markdown log", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expn", "go read the other site", "m", 60));
    await w.dispatch(agentStep("expn", 1, { seq: 1, tool: "navigate", arguments: { url: "https://example.com/page" }, result: "Navigating to https://example.com/page …", renderIn: { type: "action", verb: "go to", target: "https://example.com/page" } }));
    await w.dispatch(agentStep("expn", 2, { seq: 2, tool: "findByText", arguments: { text: "hi" }, result: "found" }));
    await w.dispatch(agentResult("expn", "Read it.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.match(text, /→ navigated to https:\/\/example\.com\/page · session resumed/, "the transition divider is in the export, mirroring the sidebar");
});

test("export: Steps counts TURNS, not events (a turn emits a thought + one event per tool)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("stp", "do stuff", "m", 10));
    // ONE turn (step 1): a thought + two tool calls → 3 events but 1 turn.
    await w.dispatch(agentStep("stp", 1, { thought: "planning" }));
    await w.dispatch(agentStep("stp", 1, { tool: "exec", arguments: { js: "1" }, result: "1", renderIn: { type: "code", text: "1", lang: "javascript" } }));
    await w.dispatch(agentStep("stp", 1, { tool: "pageInfo", arguments: {}, result: "a page" }));
    await w.dispatch(agentResult("stp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.match(text, /\*\*Steps:\*\* 1 \/ 10/, "Steps = distinct turns (1), not the 3 emitted events");
});

test("export: keeps the raw args alongside a rendered In (both, since there's no toggle)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pyx", "compute", "gemma4:31b", 10));
    await w.dispatch(agentStep("pyx", 1, {
        tool: "python_exec", arguments: { code: "return 6 * 7", cast: "pt", mode: "readonly" },
        result: "→ @pt:dead", renderIn: { type: "python-in", mode: "pt", code: "return 6 * 7" },
        renderOut: { type: "python-out", value: "[42]" },
    }));
    await w.dispatch(agentResult("pyx", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.match(text, /return 6 \* 7/, "the rendered python source is shown");
    assert.match(text, /In · raw args/, "and the raw args disclosure is present");
    assert.match(text, /"cast": "pt"/, "the raw args carry the full tool call the model emitted (not just the code)");
});

test("export: a python_exec df renders as a real <table> (PDF) and a GFM table (markdown)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pytab", "compute", "m", 10));
    await w.dispatch(agentStep("pytab", 1, {
        tool: "python_exec", arguments: { code: "return df['Q1'].sum()", table: "#sales" }, result: "210",
        renderIn: { type: "python-in", mode: "script", code: "return df['Q1'].sum()", tables: [{ name: "df", source: { kind: "dom", label: "#sales" }, columns: ["Rep", "Q1"], rows: [["Ada", 120], ["Ben", 90]] }] },
        renderOut: { type: "python-out", value: "210" },
    }));
    await w.dispatch(agentResult("pytab", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const md = await (await captureExport(w)).blob.text();
    assert.match(md, /<details><summary>input table → df \(2 × 2\)/, "markdown → the df is collapsed into a disclosure (doesn't flood the .md)");
    assert.match(md, /\| Rep \| Q1 \|/, "markdown → GFM table header (inside the disclosure)");
    assert.match(md, /\| Ada \| 120 \|/, "markdown → GFM row (all rows, uncapped)");

    const { html } = await capturePrint(w);
    assert.match(html, /<details open><summary>input table → df/, "PDF → the disclosure is OPEN so the table still prints");
    assert.match(html, /<table class="dftable">/, "PDF → a real table, not markdown pipes");
    assert.match(html, /<td class="num">120<\/td>/, "numeric cell tagged for right-align");
    assert.match(html, /<td class="">Ada<\/td>/, "string cell");
});

test("export: skips a usage-only step (no bare 'Step N · ?' header)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expu", "answer directly", "gemma4:31b"));
    // A thinking-model step: reasoning went to the thinking channel, so the emit
    // carries only a token sample (no thought/tool). It must not serialise a header.
    await w.dispatch(agentStep("expu", 1, { usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } }));
    await w.dispatch(agentResult("expu", "Done.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.ok(!/Step 1 · \?/.test(text), "no phantom empty-step header");
    assert.match(text, /## Answer\n\nDone\./);
});

test("export: a multi-turn agent run interleaves the follow-up prompts + per-turn answers", async () => {
    const w = await loadSidebarWorld();
    const H = "multi";
    await w.dispatch(agentStart(H, "type something", "m", 20));
    await w.dispatch(agentStep(H, 1, { tool: "type", arguments: { selector: "input", text: "hi" }, result: "Typed." }));
    await w.dispatch(agentResult(H, "Typed hi into the box.", 1));                 // turn 1 answer @ step 1 (ts +100)
    // The follow-up prompt lands AFTER turn 1's answer (realistic ts): ordering is by real time, not a
    // fixed answer-before-say rule — a chat-style turn that runs no tool steps keeps the same atStep, so ts
    // is what interleaves them (the DevTools/HUD ordering bug this guards against).
    await w.dispatch({ kind: "agent-say", id: H, ts: Date.now() + 150, save: false, session: { hash: H, turn: 1 }, text: "would you be able to submit too?" });
    await w.dispatch(agentStep(H, 2, { thought: "They're asking about submitting." }));
    await w.dispatch(agentResult(H, "Yes, via submit:true.", 2));                  // turn 2 answer (final)
    w.shadow.querySelector(".row").click();
    await w.tick();

    const md = await (await captureExport(w)).blob.text();
    assert.match(md, /## User Asked[\s\S]*would you be able to submit too\?/, "the follow-up prompt is exported");
    assert.match(md, /## Answered[\s\S]*Typed hi into the box\./, "turn 1's answer is exported as 'Answered'");
    assert.match(md, /## Answer\b[\s\S]*Yes, via submit:true\./, "the final answer is the last one, headed 'Answer'");
    // Order: turn-1 answer BEFORE the follow-up prompt BEFORE the final answer.
    assert.ok(md.indexOf("Typed hi into the box") < md.indexOf("would you be able to submit"), "answer precedes the next prompt");
    assert.ok(md.indexOf("would you be able to submit") < md.indexOf("Yes, via submit:true"), "prompt precedes the final answer");
});

test("export: a run with screenshots downloads a zip (run.md + png sidecars)", async () => {
    // A real 1×1 PNG, so the decoded sidecar is genuine image bytes.
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expz", "look around", "gemma4:31b", 60));
    await w.dispatch(agentStep("expz", 1, { tool: "look", renderOut: { type: "image", src: "data:image/png;base64," + PNG, label: "viewport" }, result: "a page" }));
    await w.dispatch(agentResult("expz", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    assert.equal(name, "ml-agent-expz.zip", "images present → a .zip bundle");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "starts with the PK local-file signature");
    // store method (no compression) → filenames + run.md text live verbatim in the bytes.
    const latin1 = String.fromCharCode(...bytes);
    assert.ok(latin1.includes("run.md"), "contains run.md");
    assert.ok(latin1.includes("images/step-1.png"), "contains the png sidecar");
    assert.match(latin1, /!\[step 1[^\]]*\]\(images\/step-1\.png\)/, "run.md references the sidecar, not a placeholder");
    assert.ok(latin1.includes(String.fromCharCode(0x89) + "PNG"), "the real PNG bytes are embedded");
});

test("export: a grounding locate step serialises its substeps (box + DOM snap, prompt/out/pick)", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const url = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expl", "find the star", "gemma4:31b", 10));
    await w.dispatch(agentStep("expl", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("grounding", "qwen2.5vl:7b", [
            { label: "Grounding · box (28, 242) → (45, 264)", prompt: "Locate \"star\" …", output: "28,242,45,264", rawImage: url + "#raw", image: url },
            { label: "DOM snap · +40px search margin", image: url },
        ], { picked: "[button] \"Star\" → #bar > div:nth-of-type(1)", pickedBy: "snap" }) }));
    await w.dispatch(agentResult("expl", "clicked star", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    assert.equal(name, "ml-agent-expl.zip");
    const latin1 = String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));
    assert.ok(latin1.includes("images/step-1-sub1.png"), "substep 1 image sidecar");
    assert.ok(latin1.includes("images/step-1-sub2.png"), "substep 2 image sidecar");
    assert.match(latin1, /Grounding.{1,4}qwen2\.5vl:7b/, "model + mode (· is multibyte in latin1)");
    assert.match(latin1, /box \(28, 242\)/, "box coords as a pair");
    assert.match(latin1, /\+40px search margin/, "margin");
    assert.match(latin1, /Out:.*28,242,45,264/, "the raw model output");
    assert.match(latin1, /Snapped to:.*nth-of-type\(1\)/, "picked element (grounding → snapped)");
    assert.match(latin1, /In \(prompt\)/, "the VLM prompt is included");
});

test("export: an auto-fallback locate step serialises the grounding-attempt substep + the marks one", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const url = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expf", "find the star", "gemma4:31b", 10));
    await w.dispatch(agentStep("expf", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Grounding · no box returned", prompt: "Locate…", output: "NONE", image: url },
            { label: "Set-of-Marks · 5 candidates · model chose #2", note: "Grounding returned no box — fell back to Set-of-Marks.", prompt: "which badge…", output: "2", rawImage: url + "#raw", image: url },
        ], { picked: "#2 [button] → #bar > div:nth-of-type(2)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("expf", "clicked star", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const latin1 = String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));
    assert.ok(latin1.includes("images/step-1-sub1.png"), "grounding-attempt sidecar");
    assert.ok(latin1.includes("images/step-1-sub2.png"), "the marks-pass sidecar");
    assert.match(latin1, /Grounding returned no box .{1,4} fell back to Set-of-Marks/, "the fallback note");
    assert.match(latin1, /Model picked[\s\S]*nth-of-type\(2\)/, "marks pick");
});

test("export: a grid hand-off locate step serialises both substeps + the raw image sent", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const url = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expg", "find the star", "gemma4:31b", 10));
    const raw = "data:image/png;base64,QUJDRA==";   // a DIFFERENT but valid data-URL (so the raw sidecar is written)
    await w.dispatch(agentStep("expg", 1, { tool: "locate", arguments: { description: "star", strategy: "grid" }, elements: 1, renderOut:
        locateRender("grid", "gemma4:31b", [
            { label: "Cell pick · grid 4×4 · model chose cells 2,3", prompt: "This image is divided into a 4×4 …", output: "2,3", rawImage: raw, image: url },
            { label: "Set-of-Marks · 6 candidates · model chose #4", note: "The cell held 6 elements, so they were re-badged and a second vision call picked one (Set-of-Marks).", prompt: "which badge…", output: "4", rawImage: raw, image: url },
        ], { picked: "#4 [button] → #bar > div:nth-of-type(3)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("expg", "clicked star", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const latin1 = String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));
    assert.ok(latin1.includes("images/step-1-sub1.png"), "cell-pick image sidecar");
    assert.ok(latin1.includes("images/step-1-sub2.png"), "SoM-pick image sidecar");
    assert.ok(latin1.includes("images/step-1-sub1-raw.png"), "the raw image sent to the model (differs from overlay)");
    assert.match(latin1, /Grid.{1,4}gemma4:31b/, "mode + model");
    assert.match(latin1, /standalone sub-call/, "delegated note (same model as driver)");
    assert.match(latin1, /model chose cells 2,3/, "selected cells");
    assert.match(latin1, /held 6 elements.{1,40}second/i, "hand-off note");
    assert.match(latin1, /Set-of-Marks.{1,4}6 candidates.{1,4}model chose #4/, "SoM-pick substep label (· is multibyte in latin1)");
    assert.match(latin1, /Model picked:.*nth-of-type\(3\)/, "the model picked the badge");
});

test("export: a chat session downloads a markdown log (options, turns, reply)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("expc", 0, "what is 2+2", { model: "qwen3:14b" }));
    await w.dispatch(chatResult("expc", 0, "It is **4**.", { model: "qwen3:14b" }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    const text = await blob.text();
    assert.equal(name, "ml-chat-expc.md");
    assert.match(text, /# Chat · qwen3:14b · expc/);
    assert.match(text, /## Options/);
    assert.match(text, /## Turn 1 ·/);
    assert.match(text, /\*\*User:\*\*\n\nwhat is 2\+2/);
    assert.match(text, /\*\*Assistant\*\* \(qwen3:14b\):\n\nIt is \*\*4\*\*\./);
});

test("export menu: offers both formats, and closes once one is picked", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expm", "look around", "gemma4:31b"));
    await w.dispatch(agentResult("expm", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const trigger = w.shadow.querySelector('[aria-label="Export log"]');
    assert.ok(!w.shadow.querySelector(".menu"), "menu is closed until asked for");
    trigger.click();
    await w.tick();
    assert.deepEqual([...w.shadow.querySelectorAll(".menu-item")].map(b => b.firstChild.textContent),
        ["Markdown", "PDF"], "both export formats offered");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");

    w.window.URL.createObjectURL = () => "blob:mock";
    w.window.URL.revokeObjectURL = () => {};
    w.window.HTMLAnchorElement.prototype.click = function () {};
    w.shadow.querySelector(".menu-item").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".menu"), "picking a format closes the menu");
});

test("export menu: Escape closes it without exporting", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expe", "look around", "gemma4:31b"));
    await w.dispatch(agentResult("expe", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector('[aria-label="Export log"]').click();
    await w.flush();   // the key listener is registered in an effect (post-rAF)
    assert.ok(w.shadow.querySelector(".menu"));
    w.window.document.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Escape" }));
    await w.tick();
    assert.ok(!w.shadow.querySelector(".menu"), "Escape dismisses the menu");
});

test("export → PDF: builds a self-contained printable document routed to the background print tab", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const src = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expp", "hide slow items", "gemma4:31b", 60));
    await w.dispatch(agentStep("expp", 1, { tool: "look", renderOut: { type: "image", src, label: "viewport" }, result: "a page" }));
    await w.dispatch(agentStep("expp", 2, { tool: "exec", arguments: { js: "items.forEach(i=>i.remove())" }, result: "Hidden 38 items." }));
    await w.dispatch(agentResult("expp", "I hid all **slow** items.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { html } = await capturePrint(w);
    assert.ok(html, "the rendered doc is posted to the background (PRINT_SESSION)");
    assert.match(html, /^<!doctype html>/);
    // Chrome seeds the "Save as PDF" filename from the title.
    assert.match(html, /<title>ml-agent-expp<\/title>/, "titled like the .md export, for the PDF filename");
    assert.match(html, /@page\s*\{[^}]*margin/, "print margins");
    assert.match(html, /white-space: pre-wrap/, "code wraps instead of clipping off the page");
    assert.match(html, /<h1>Agent run · gemma4:31b · expp<\/h1>/);
    assert.match(html, /<h2>Step 1 · look<\/h2>/);
    assert.ok(html.includes(`<img src="${src}"`), "screenshots are inlined (a print doc has no sidecars)");
    // Code is syntax-highlighted, so read the source back through the tokens.
    assert.match(plainText(html), /items\.forEach\(i => i\.remove\(\)\)/, "exec JS is beautified");
    assert.ok(!/i=>i\.remove/.test(html), "the cramped original was reflowed");
    assert.match(html, /Hidden 38 items\./);
    assert.match(html, /<strong>slow<\/strong>/, "the answer's markdown is rendered, not shown raw");
});

test("export → PDF: a chat run renders turns, and hostile content can't inject markup", async () => {
    const w = await loadSidebarWorld();
    // The printable doc renders at the extension's origin, so every dynamic string
    // (a model reply here) must be escaped, never passed through as markup.
    await w.dispatch(chatStart("expx", 0, "hi", { model: "qwen3:14b" }));
    await w.dispatch(chatResult("expx", 0, "<script>alert(1)</script><img src=x onerror=alert(2)>", { model: "qwen3:14b" }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { html } = await capturePrint(w);
    assert.match(html, /<h1>Chat · qwen3:14b · expx<\/h1>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "script tag escaped");
    assert.ok(!/<script/.test(html), "no live script element");
    assert.ok(!/<img[^>]*onerror/.test(html), "no injected event handler — only the escaped text");
    assert.match(plainText(html), /<img src=x onerror=alert\(2\)>/, "…and the reply still reads verbatim");
});

test("clicking a debug image opens the full-window lightbox (posts src to the shell)", async () => {
    const w = await loadSidebarWorld();
    let posted = null;
    w.window.addEventListener("message", (e) => { if (e.data && e.data.__mlLightbox) posted = e.data.__mlLightbox; });
    await w.dispatch(agentStart("img", "x"));
    await w.dispatch(agentStep("img", 1, { tool: "look", renderOut: { type: "image", src: "data:image/png;base64,ZZZ", label: "shot" } }));
    await w.dispatch(agentResult("img", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();   // expand → Out renders the image
    await w.tick();

    const img = w.shadow.querySelector(".r-image img.zoomable");
    assert.ok(img, "the descriptor image is a click-to-zoom image");
    img.click();
    await w.tick();
    assert.equal(posted, "data:image/png;base64,ZZZ", "posts the src up to the shell for a full-window overlay");
});

test("agent tool In/Out carry a grey inline preview (minified args / newline-collapsed output)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agp", "x"));
    await w.dispatch(agentStep("agp", 1, { tool: "click", arguments: { selector: "button.like", index: 2 }, result: "Clicked the button.\nPage title: Foo." }));
    await w.dispatch(agentResult("agp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    const [inB, outB] = [...toolStep.querySelectorAll("details.io")];
    assert.match(inB.querySelector(".io-preview").textContent, /"selector": "button\.like"/, "In preview = minified args");
    assert.match(outB.querySelector(".io-preview").textContent, /Clicked the button\. Page title: Foo\./, "Out preview collapses newlines");
});

test("agent content is plain prose (no status dot); a failed tool call shows an err dot", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agd", "thing"));
    await w.dispatch(agentStep("agd", 1, { thought: "hmm" }));
    await w.dispatch(agentStep("agd", 1, { tool: "click", arguments: {}, result: "Error: no element matches" }));
    await w.dispatch(agentResult("agd", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".aturn-prose"), "content renders as prose");
    assert.equal(w.shadow.querySelector(".aturn-prose .dot"), null, "the content prose has no status dot");
    assert.ok(w.shadow.querySelector(".astep.tool .dot.err"), "failed tool call flagged err");
});

test("agent options block renders the config + reveals the system prompt", async () => {
    const cfg = {
        system: "You are an automation agent operating on the page.", customSystem: false,
        tools: [{ name: "look", requiresApproval: false }, { name: "click", requiresApproval: true }],
        maxSteps: 8, think: null, env: true, vision: null, hints: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ao", "task", "gemma", 8, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".block .block-label").textContent, /agent options/);

    w.shadow.querySelector(".block .block-head").click();   // expand
    await w.tick();
    assert.match(w.shadow.querySelector(".opts").textContent, /maxSteps: 8/);
    assert.match(w.shadow.querySelector(".opts").textContent, /tools \(2\): look, click ⚠/);

    w.shadow.querySelector(".sys-block .raw-btn").click();   // reveal the system prompt
    await w.tick();
    assert.match(w.shadow.querySelector(".sys-block .code").textContent, /automation agent/);
});

test("agent options: warns when no vision model resolved (look/locate unavailable)", async () => {
    const cfg = {
        system: "s", customSystem: false,
        tools: [{ name: "findByText", requiresApproval: false }],   // no vision tool
        maxSteps: 10, think: null, env: true, vision: null, hints: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nv", "task", "text-model", 10, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".block-head .arg-warn").textContent, /no vision/);
    w.shadow.querySelector(".block .block-head").click();   // expand
    await w.tick();
    assert.match(w.shadow.querySelector(".arg-issues").textContent, /visual tools unavailable/);
});

test("agent options: no vision warning when a vision tool IS wired", async () => {
    const cfg = {
        system: "s", customSystem: false,
        tools: [{ name: "look", requiresApproval: false, vision: true }],
        maxSteps: 10, think: null, env: true, vision: null, hints: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("hv", "task", "qwen2.5vl", 10, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".block-head .arg-warn"), null, "no warning when look is present");
});

test("agent tool step flags args that don't match the schema", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ai", "x"));
    await w.dispatch(agentStep("ai", 1, { tool: "grab", arguments: { index: 2 }, argIssues: ['missing required "selector"', 'unknown property "index"'] }));
    await w.dispatch(agentResult("ai", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    assert.ok(toolStep.querySelector(".arg-warn"), "warning badge in the collapsed header");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    assert.match(toolStep.querySelector(".arg-issues").textContent, /missing required "selector"/);
    assert.match(toolStep.querySelector(".arg-issues").textContent, /unknown property "index"/);
});

test("a running agent shows …running, then the answer arrives live", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag2", "do a thing"));
    assert.ok(w.shadow.querySelector(".row .dot.pending"), "row pending while running");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "…running while in flight");

    await w.dispatch(agentResult("ag2", "all done", 1));   // lands while detail is open
    assert.ok(!w.shadow.querySelector(".pending-note"), "…running cleared live");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /all done/);
});

test("running footer swaps to 'waiting for your approval' when blocked, and back the instant you decide", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agB", "do a thing"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let note = w.shadow.querySelector(".pending-note");
    assert.ok(note && !note.classList.contains("blocked"), "actively running: not blocked");
    assert.match(note.textContent, /running/);

    // A step lands awaiting the gate → the footer goes amber/blocked with the approval copy.
    await w.dispatch(agentStep("agB", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#go" } }));
    note = w.shadow.querySelector(".pending-note");
    assert.ok(note.classList.contains("blocked"), "blocked while awaiting approval");
    assert.match(note.textContent, /waiting for your approval/i);

    // Click Approve → the footer must drop 'blocked' immediately, WITHOUT waiting for the tool's DONE.
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.tick();
    note = w.shadow.querySelector(".pending-note");
    assert.ok(note && !note.classList.contains("blocked"), "no longer blocked the instant you approve (before DONE)");
});

test("an agent that hits the step cap is flagged as stopped/error", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag3", "endless task"));
    await w.dispatch(agentResult("ag3", "Stopped at the 10-step cap without finishing.", 10, true));
    assert.ok(w.shadow.querySelector(".row .dot.err"), "capped run marked error");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.capped").textContent, /step cap/);
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

// ─── off-mode approval CARD (the "card" surface) ───
// The shell hosts the SAME app iframe as a corner card and tells it `__mlSidebarSurface: "card"`. The
// app then renders a curated view of the one background-hosted run, drives its own reveal via
// `__mlSidebarCard`, and gates approval through the same unforgeable `__mlSidebarApp: "approval"` path.

test("card surface: a pending approval shows the action directly + Approve posts the unforgeable decision", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);   // capture what the app posts to its parent (the shell)

    await w.raw({ __mlSidebarSurface: "card" });
    assert.equal(w.window.document.documentElement.dataset.surface, "card", "switched to the card surface");

    const hash = "cardrun1";
    await w.dispatch(agentStart(hash, "delete the account", "m"));
    // The tool provides an `action` intent descriptor (verb + human target + highlight selector).
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "#danger" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "Delete account", selector: "#danger" } }));
    await w.flush();

    // A pending approval reveals the card EXPANDED (urgent — you act on it), showing the intent sentence.
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "pending approval shows expanded directly");
    const doc = w.window.document;
    assert.match(doc.querySelector(".card-head-txt").textContent, /Approval needed/);
    const sentence = doc.querySelector(".action-sentence").textContent;
    assert.match(sentence, /click the button/, "plain-English intent");
    assert.match(sentence, /Delete account/, "human target, not the selector");
    // The card highlighted the real element on the page as a pulsing-green approval spotlight.
    assert.ok(posted.some(m => m.__mlHighlight && m.__mlHighlight.selector === "#danger" && m.__mlHighlight.kind === "approve"), "pulsing highlight on the target");

    // The Deny/Approve controls live in the fixed footer (outside the scroll area), with key hints.
    const approve = doc.querySelector(".card-foot .appr-btn.yes");
    assert.ok(approve && approve.textContent.includes("Approve"), "Approve control rendered in the footer");
    approve.click(); await w.flush();

    const decision = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(decision, "posted an approval decision to the shell (→ SET_APPROVAL)");
    assert.equal(decision.hash, hash);
    assert.equal(decision.seq, 0);
    assert.equal(decision.decision, true);
});

test("card surface: the final answer shows; debug steps/thinking don't leak", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardrun2";
    await w.dispatch(agentStart(hash, "survey the page", "m"));
    await w.dispatch(agentStep(hash, 1, { reasoning: "thinking about it…" }));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "exec", arguments: { js: "x" }, result: "ok", approval: "readonly" }));
    await w.dispatch(agentResult(hash, "The page has three sections.", 1));
    await w.flush();

    // A finished run shows its ANSWER directly (expanded) — no click needed; only the answer, no rows.
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "finished run reveals the answer directly");
    const body = w.window.document.querySelector(".card-body");
    assert.ok(body, "answer body rendered");
    assert.doesNotMatch(body.textContent, /thinking about it/, "thinking is hidden in the card");
    assert.ok(!body.querySelector(".astep"), "no debug step rows leak into the card");
    assert.ok(body.querySelector(".card-answer"), "answer rendered as plain markdown");
    assert.match(body.textContent, /three sections/, "the final answer shows");
});

test("card surface: answer element visuals render in the HUD card (user-facing deliverable)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "ansmedia";
    const media = [{ image: "data:image/png;base64,CATPIC", label: "the best cat", selector: "img.cat" }];
    await w.dispatch(agentStart(hash, "find the best cat", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "answer", arguments: { selector: "img.cat" }, result: "Answer: 1 element(s)" }));
    await w.dispatch({ ...agentResult(hash, "Here's the best cat.", 1), answerMedia: media });
    await w.flush();

    const body = w.window.document.querySelector(".card-body");
    const gallery = body.querySelector(".card-answer-media");
    assert.ok(gallery, "the HUD card renders the answer-media gallery");
    assert.equal(gallery.querySelectorAll("img").length, 1, "one answer image");
    assert.match(gallery.querySelector("img").getAttribute("src"), /CATPIC/, "the captured crop is the src");
    // "Show work" moved ABOVE the answer.
    const work = body.querySelector(".card-work-toggle, [class*=card-work]");
    const answer = body.querySelector(".card-answer");
    if (work && answer) assert.ok(body.innerHTML.indexOf("card-work") < body.innerHTML.indexOf("card-answer"), "Show work is above the answer");
});

test("card surface: answer media renders inline vs highlight-chip, and hover-highlights the page element", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "ansmode";
    const media = [
        { image: "data:image/png;base64,IMG", label: "the cat", selector: "img.cat", kind: "image", mode: "inline" },
        { image: "", label: "the buy button", selector: "button.buy", kind: "element", mode: "highlight" },
    ];
    await w.dispatch(agentStart(hash, "find things", "m"));
    await w.dispatch({ ...agentResult(hash, "found them", 1), answerMedia: media });
    await w.flush();
    const gallery = w.window.document.querySelector(".card-answer-media");
    assert.ok(gallery.querySelector(".am-inline img"), "inline mode shows the image");
    assert.ok(gallery.querySelector(".am-chip"), "highlight mode shows a compact chip");
    assert.match(gallery.querySelector(".am-chip").textContent, /buy button|locate on page/, "the chip labels the element");

    // Hovering the inline item highlights the corresponding element on the page (the debug highlighter).
    posted.length = 0;
    gallery.querySelector(".am-inline").dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    assert.ok(posted.some(m => m.__mlHighlight && m.__mlHighlight.selector === "img.cat"), "hover posts a highlight for the element");
    gallery.querySelector(".am-inline").dispatchEvent(new w.window.MouseEvent("pointerleave", { bubbles: true }));
    assert.ok(posted.some(m => m.__mlHighlight === null), "leaving clears the highlight");
});

test("card surface: a steer's SEEN indicator renders in the HUD Show-work too (surface parity)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "cardsteer";
    // The live QUEUED→SEEN transition is proven by the DevTools reducer tests (same reducer + SteerSeen
    // component); here we just confirm the indicator ALSO renders on the HUD surface. The compact card only
    // exposes the trace once revealed (after completion), so drive a full run: one steer SEEN, one left QUEUED.
    await w.dispatch(agentStart(hash, "do the task", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentSay(hash, "focus on the header", "sy_c1"));
    await w.dispatch(agentSaySeen(hash, "sy_c1"));                      // the agent drained this one
    await w.dispatch(agentSay(hash, "and the footer", "sy_c2"));        // this one never got picked up
    await w.dispatch(agentResult(hash, "done", 2));
    await w.flush();
    // Open "Show work" — the trace (and its steer bubbles) live there in the card.
    const toggle = w.window.document.querySelector(".card-work-toggle");
    assert.ok(toggle, "the completed card exposes a Show-work toggle");
    toggle.click();
    await w.tick();
    const badges = [...w.window.document.querySelectorAll(".card-body .steer-seen")];
    assert.ok(badges.some(b => b.classList.contains("on")), "the drained steer shows SEEN in the card");
    assert.ok(badges.some(b => b.classList.contains("wait")), "the undrained steer stays QUEUED in the card");
});

test("card surface: orb-steer opens an inline steer box on a LIVE run and sends via say()", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "orbsteer";
    // A LIVE run (started + one tool step, no result) → the compact card is just the working orb, no input.
    await w.dispatch(agentStart(hash, "keep working", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-steer-in"), "no steer box until you ask for it");

    // The shell's orb corner-menu "Steer this run…" posts this into the app.
    await w.raw({ __mlSteerRun: { hash } });
    await w.flush();
    const input = w.window.document.querySelector(".card-steer-in");
    assert.ok(input, "the steer box opens on the live card");

    // Type + Enter → a sessionSend for THIS run (the page routes it to say() while the run is live).
    input.value = "focus on the pricing table";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();   // let Preact re-render so the keydown handler closes over the new text
    w.window.document.querySelector(".card-steer-in").dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarApp === "sessionSend" && m.hash === hash && m.text === "focus on the pricing table"), "Enter sends the steer via sessionSend");
    // Stays OPEN after a send (you may steer again), and the field cleared.
    assert.ok(w.window.document.querySelector(".card-steer-in"), "the steer box stays open after sending");
    assert.equal(w.window.document.querySelector(".card-steer-in").value, "", "the field cleared for the next nudge");

    // × closes it → back to the working orb (no steer box).
    w.window.document.querySelector(".card-steer-x").click();
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-steer-in"), "closing returns to the orb");
});

test("card surface: the steer box auto-closes when the run finishes", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "steerclose";
    await w.dispatch(agentStart(hash, "work", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.raw({ __mlSteerRun: { hash } });
    await w.flush();
    assert.ok(w.window.document.querySelector(".card-steer-in"), "steer box is open mid-run");
    await w.dispatch(agentResult(hash, "all done", 1));   // run completes
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-steer-in"), "the steer box is gone once the run finished");
    assert.ok(w.window.document.querySelector(".card-reply, .card-answer"), "the finished card shows its answer/reply instead");
});

test("card surface: 'Add to current run' opens the composer in APPEND mode and sends to the open session", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "addrun";
    // A live run is open in the HUD.
    await w.dispatch(agentStart(hash, "work on the page", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.flush();

    // Right-click "Add this to the current run" → the shell resolves the element and posts this in.
    const ctx = { selector: "div#price", role: "region", anchorText: "Pricing", text: "Pro plan $20/mo" };
    await w.raw({ __mlAddToCurrentRun: { ctx } });
    await w.flush();
    // The composer opens in APPEND mode: the element pill shows, and the head names the target (not "New task").
    assert.ok(w.window.document.querySelector(".card-cmp-input"), "the composer opened");
    assert.ok(w.window.document.querySelector(".el-pill"), "the element context rides along as a pill");
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Steer|Add to run/, "the head shows it's appending, not a new task");

    // Type + send → routes to sessionSend for the OPEN run (with the element context), NOT a fresh startRun.
    const ta = w.window.document.querySelector(".card-cmp-input");
    ta.value = "what does this cost?";
    ta.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    w.window.document.querySelector(".appr-btn.yes").click();
    await w.tick();
    const sent = posted.find(m => m.__mlSidebarApp === "sessionSend");
    assert.ok(sent, "it posts a sessionSend, not a startRun");
    assert.ok(!posted.some(m => m.__mlSidebarApp === "startRun"), "no fresh run was started");
    assert.equal(sent.hash, hash, "targets the open run's hash");
    assert.equal(sent.text, "what does this cost?", "carries the typed text");
    assert.equal(sent.elementContext.selector, "div#price", "carries the element context to fold in page-side");
});

test("card surface: 'Add to current run' with NO open run falls back to a fresh composer (never a dead entry)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "m" } });   // a model is set so the new-run path isn't blocked by the preflight
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    // Nothing running/open.
    await w.raw({ __mlAddToCurrentRun: { ctx: { selector: "p#x", role: "paragraph", text: "hi" } } });
    await w.flush();
    assert.ok(w.window.document.querySelector(".card-cmp-input"), "the composer still opens");
    const ta = w.window.document.querySelector(".card-cmp-input");
    ta.value = "summarise this";
    ta.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    w.window.document.querySelector(".appr-btn.yes").click();
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarApp === "startRun"), "with no open run it starts a FRESH run");
    assert.ok(!posted.some(m => m.__mlSidebarApp === "sessionSend"), "…not an append");
});

test("card surface: a NEW round with no answer CLEARS the prior answer media (reset to 0)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "ansreset";
    await w.dispatch(agentStart(hash, "find the cat", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "answer", arguments: { selector: "img.cat" }, result: "Answer: 1 element(s)" }));
    await w.dispatch({ ...agentResult(hash, "here it is", 1), answerMedia: [{ image: "data:image/png;base64,CATPIC", label: "cat" }] });
    await w.flush();
    assert.ok(w.window.document.querySelector(".card-answer-media"), "media shows after the answer");

    // A NEW round (a follow-up turn) that designates NOTHING → the prior answer media clears.
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "and now?" });
    await w.dispatch(agentStep(hash, 2, { thought: "nothing to return" }));
    await w.dispatch(agentResult(hash, "nothing to return this time", 2));   // no answerMedia on this turn
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-answer-media"), "the prior answer media is cleared on the new round");
});

test("the DEBUG DETAIL does NOT render answer media (that's HUD-only, the sidebar is a trace)", async () => {
    const w = await loadSidebarWorld();
    const hash = "ansmedia2";
    await w.dispatch(agentStart(hash, "find it", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "answer", arguments: { selector: "img.cat" }, result: "Answer: 1 element(s)" }));
    await w.dispatch({ ...agentResult(hash, "done", 1), answerMedia: [{ image: "data:image/png;base64,CATPIC", label: "x", selector: "img.cat" }] });
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".card-answer-media"), "no answer-media gallery in the debug detail");
    assert.doesNotMatch(w.shadow.querySelector(".msg.asst").innerHTML, /CATPIC/, "the crop isn't leaked into the debug detail");
});

// Dispatch a 2-TASK run (task → answer, then a follow-up say → answer) so Show-work has >1 block to segment.
async function twoTaskRun(w, hash) {
    await w.dispatch(agentStart(hash, "find cats", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "cat" }, result: "found cats" }));
    await w.dispatch(agentResult(hash, "Found the cats.", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "now find dogs" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "findByText", arguments: { text: "dog" }, result: "found dogs" }));
    await w.dispatch(agentResult(hash, "Found the dogs.", 2));
    await w.flush();
}

test("card Show-work: a multi-TASK run segments into collapsible blocks (priors collapsed, latest expanded)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // no utilityModel → prompt fallback
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await twoTaskRun(w, "multitask");
    w.window.document.querySelector(".card-work-toggle").click();   // open Show work
    await w.tick();
    const blocks = w.window.document.querySelectorAll(".run-block");
    assert.equal(blocks.length, 2, "two task blocks");
    assert.ok(!blocks[0].querySelector(".run-block-body"), "the prior block is collapsed");
    assert.ok(blocks[1].querySelector(".run-block-body"), "the latest block is expanded");
    assert.match(blocks[0].querySelector(".run-block-sum").textContent, /find cats/, "prompt fallback in the collapsed header");
    assert.match(blocks[0].querySelector(".run-block-n").textContent, /1 step/, "step-count chip");
});

test("card Show-work: a single-task run is NOT segmented (flat trace, no blocks)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("single", "find cats", "m"));
    await w.dispatch(agentStep("single", 1, { seq: 1, tool: "findByText", arguments: { text: "cat" }, result: "found" }));
    await w.dispatch(agentResult("single", "Found them.", 1));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click();
    await w.tick();
    assert.equal(w.window.document.querySelectorAll(".run-block").length, 0, "no per-task blocks for a single task");
    assert.ok(w.window.document.querySelector(".card-work-trace"), "the flat trace still renders");
});

test("card Show-work: a block header renders inline `$…$` math (summaries/prompts carry latex)", async () => {
    // The block header is utility-model / prompt prose that often carries inline `$…$` (e.g. "derivative of
    // $\sin^2(x)$"); it must typeset via markdown+math, not show literal `$…$`. (No utilityModel here → the
    // header is the prompt fallback, which is enough to exercise the render.)
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "blkmath";
    await w.dispatch(agentStart(hash, "Find the derivative of $\\sin^2(x)$", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult(hash, "done", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "findByText", arguments: { text: "y" }, result: "ok" }));
    await w.dispatch(agentResult(hash, "done2", 2));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click(); await w.tick();
    const sum = w.window.document.querySelectorAll(".run-block-sum")[0];
    assert.ok(sum, "block 0 has a header");
    assert.ok(sum.querySelector(".katex"), "inline $…$ in the block header typesets via KaTeX");
    assert.ok(!sum.textContent.includes("$"), "no literal $ delimiters remain in the header");
});

test("card Show-work: the utility model summarises each block (lazy on open, replaces the prompt, cached)", async () => {
    let calls = 0;
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", utilityModel: "gemma4:e2b" },
        // Count only BLOCK-summary calls (payload starts "Request:") — genTitle also fires a utility call.
        fetchLlm: (payload) => {
            const isBlock = payload.extend === "utility" && (payload.messages || []).some(m => typeof m.content === "string" && m.content.startsWith("Request:"));
            // Prefix "Summary:" the way a real model does despite the "no preamble" instruction — the app must strip it.
            if (isBlock) { calls++; return { data: `Summary: Block summary ${calls}` }; }
            return { data: "a title" };
        },
    });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await twoTaskRun(w, "sum");
    assert.equal(calls, 0, "not fired until Show work is opened (lazy)");
    w.window.document.querySelector(".card-work-toggle").click();
    await w.flush(); await w.tick();
    const blocks = w.window.document.querySelectorAll(".run-block");
    const sum0 = blocks[0].querySelector(".run-block-sum");
    assert.match(sum0.textContent, /Block summary/, "the utility summary replaces the prompt");
    assert.ok(!/^summary:/i.test(sum0.textContent.trim()), "the model's 'Summary:' preamble is stripped");
    assert.ok(blocks[0].querySelector(".run-block-sum.ml-reveal"), "the summary fades in");
    // The tooltip UPDATES to reflect the summary now shown (was stale, pinned to the prompt), and still keeps
    // the original request for reference.
    const tip = sum0.getAttribute("title");
    assert.match(tip, /Block summary/, "the tooltip shows the (untruncated) summary now displayed");
    assert.match(tip, /Request:/, "…and still carries the original request");
    assert.equal(calls, 2, "the utility model fired once per block");
    // Re-open → cached, no refire.
    w.window.document.querySelector(".card-work-toggle").click();   // close
    await w.tick();
    w.window.document.querySelector(".card-work-toggle").click();   // reopen
    await w.tick();
    assert.equal(calls, 2, "cached — no refire on reopen");
});

test("card surface: a finished run has an inline reply that continues the SAME session", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardreply1";
    await w.dispatch(agentStart(hash, "do a thing", "m"));
    await w.dispatch(agentResult(hash, "Done.", 1));
    await w.flush();

    // Collapsed by default — a slim ghost affordance (icon + label), NOT a filled input. Click to open it.
    const opener = w.window.document.querySelector(".card-reply.collapsed .card-reply-open");
    assert.ok(opener, "the finished card shows the collapsed reply affordance");
    assert.ok(!w.window.document.querySelector(".card-reply-in"), "the input is hidden until opened");
    opener.click(); await w.flush();

    // Open state: the input + a nested send that's hidden (+ disabled) until you type.
    const input = w.window.document.querySelector(".card-reply .card-reply-in");
    const send = w.window.document.querySelector(".card-reply .card-reply-send");
    assert.ok(input && send, "clicking reveals the inline reply input + nested send");
    assert.ok(send.disabled && !send.classList.contains("show"), "send is hidden + disabled while the box is empty");

    input.value = "and now the next thing";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.flush();
    assert.ok(!send.disabled && send.classList.contains("show"), "typing reveals + enables the send button");
    send.click();
    await w.flush();

    const sent = posted.find(m => m.__mlSidebarApp === "sessionSend");
    assert.ok(sent && sent.hash === hash && sent.text === "and now the next thing",
        "the reply posts sessionSend {hash,text} — the same channel the panel composer uses");
});

test("card surface: a between-step thought expands the orb into a live prose CAPTION (Progress)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // default agentHud = progress
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "prose1";
    await w.dispatch(agentStart(hash, "sum up the table", "m"));
    await w.dispatch(agentStep(hash, 1, { thought: "Reading the quarterly sales table…" }));
    await w.flush();
    assert.ok(posted.some(m => m.__mlSidebarCard === "orbprose"), "the orb widens to the caption (orbprose) state");
    const label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label && /Reading the quarterly sales table/.test(label.textContent), "the caption shows the model's between-step prose");
});

test("card surface: the live caption STRIPS markdown/HTML the model emits (plain pill, no literal syntax)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "mdcap";
    await w.dispatch(agentStart(hash, "task", "m"));
    await w.dispatch(agentStep(hash, 1, { thought: "**Scanning** the `settings` <b>panel</b> — see [docs](http://x)" }));
    await w.flush();
    const label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    const text = label ? label.textContent : "";
    assert.match(text, /Scanning the settings panel — see docs/, "formatting removed, words kept");
    assert.ok(!/[*`<>]|\]\(/.test(text), "no literal markdown/HTML syntax leaks into the pill");
});

test("card surface: live prose is SUPPRESSED in Quiet mode (no caption, no orb)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", agentHud: "quiet" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "prose2";
    await w.dispatch(agentStart(hash, "task", "m"));
    await w.dispatch(agentStep(hash, 1, { thought: "Working on it…" }));
    await w.flush();
    assert.ok(!posted.some(m => m.__mlSidebarCard === "orbprose"), "no live caption in quiet mode");
    assert.ok(!w.window.document.querySelector(".card-orb"), "no orb rendered at all");
});

test("card surface: the live caption updates to the current step — it doesn't STICK to a prior step's prose", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // progress HUD
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "stick";
    await w.dispatch(agentStart(hash, "read then click", "m"));
    // Step 1: the model NARRATES (thought), then runs a tool.
    await w.dispatch(agentStep(hash, 1, { thought: "Scanning the settings panel…" }));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "describeElement", arguments: { selector: "pref-panel" }, result: "…" }));
    await w.flush();
    let label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label && /Scanning the settings panel/.test(label.textContent), "the narrated step shows its prose caption");
    // Step 2: a NEW tool step with NO narration (empty thought, usage only). The caption must NOT stay stuck.
    await w.dispatch(agentStep(hash, 2, { thought: "", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }));
    await w.dispatch(agentStep(hash, 2, { seq: 1, tool: "click", arguments: { selector: "@pt:ab" }, result: "Clicked." }));
    await w.flush();
    label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(!label || !/Scanning the settings panel/.test(label.textContent), "the stale narration is gone once a new tool runs without prose");
    // The orb still renders (working) — it just shows the current tool's activity instead of the stale text.
    assert.ok(w.window.document.querySelector(".card-orb"), "the working orb is still shown");
});

test("card surface: a type approval calls out type-AND-SUBMIT (dotted underline), plain type doesn't", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // submit:true — the approval must emphasise that it will SEND, not just type.
    await w.dispatch(agentStart("subT", "search cats", "m"));
    await w.dispatch(agentStep("subT", 1, { seq: 0, pending: true, awaitingApproval: true, tool: "type", arguments: { selector: "input", text: "cats", submit: true } }));
    await w.flush();
    let sentence = w.window.document.querySelector(".action-sentence");
    assert.ok(sentence && sentence.querySelector(".action-submit"), "type+submit is emphasised with .action-submit");
    assert.match(sentence.textContent, /and submit it/i, "the sentence spells out the submit");

    // A plain type (no submit) — no emphasis.
    const w2 = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w2.window.postMessage = () => {};
    await w2.raw({ __mlSidebarSurface: "card" });
    await w2.dispatch(agentStart("plainT", "type a draft", "m"));
    await w2.dispatch(agentStep("plainT", 1, { seq: 0, pending: true, awaitingApproval: true, tool: "type", arguments: { selector: "input", text: "cats" } }));
    await w2.flush();
    sentence = w2.window.document.querySelector(".action-sentence");
    assert.ok(sentence && !sentence.querySelector(".action-submit"), "a plain type has no submit emphasis");
});

test("HUD activity: a pending fetch_url shows the fetch activity (globe), not the ⚙️ generic default", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("fua", "get the servers list"));
    await w.dispatch(agentStep("fua", 1, { seq: 1, pending: true, tool: "fetch_url", arguments: { url: "https://x.test/a.json" } }));
    await w.flush();
    const txt = w.shadow.querySelector("body").textContent;
    assert.ok(txt.includes("🌐"), "the fetch (globe) activity icon shows in the HUD");
    assert.ok(!txt.includes("⚙️"), "and NOT the generic ⚙️ 'Running fetch_url' fallback");
});

test("card surface: quiet HUD suppresses the working pill, but an approval still surfaces the card", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", agentHud: "quiet" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "quiet1";
    await w.dispatch(agentStart(hash, "read the page", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));   // running (no gate)
    await w.flush();
    assert.ok(!posted.some(m => m.__mlSidebarCard === "orb"), "no idle orb in quiet mode");
    assert.ok(!w.window.document.querySelector(".card-orb"), "orb is not rendered");

    // An actual approval must STILL surface the card (quiet only drops the idle pill, never the gate).
    await w.dispatch(agentStep(hash, 2, { seq: 1, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "#x" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "X", selector: "#x" } }));
    await w.flush();
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "the approval still shows the card");
});

test("card surface: a fatal run error surfaces (Run failed + the message), even in quiet mode", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", agentHud: "quiet" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardErr";
    await w.dispatch(agentStart(hash, "do the thing", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));   // running (quiet → no pill)
    await w.dispatch({ kind: "agent-result", id: hash, ts: Date.now(), save: false, session: { hash, turn: 1 }, summary: "", steps: 1, hitCap: false, error: "model call failed: HTTP 500" });
    await w.flush();

    // A terminal error reveals the card even in quiet mode (you need to know the run died).
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "the error reveals the card");
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Run failed/);
    assert.match(w.window.document.querySelector(".card-error").textContent, /HTTP 500/);
});

test("agent run: a fatal error marks the session failed and shows the message in the debug view", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("errS", "do the thing", "m"));
    await w.dispatch(agentStep("errS", 1, { tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch({ kind: "agent-result", id: "errS", ts: Date.now(), save: false, session: { hash: "errS", turn: 1 }, summary: "", steps: 1, hitCap: false, error: "connection refused" });

    const row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".dot.err"), "the session dot goes red");
    row.click(); await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.err .errtext").textContent, /connection refused/, "the run's error is shown");
});

test("agent step pill shows the PER-TURN step (localStep), not the cumulative one — maxSteps is a per-turn budget", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("mt", "turn one", "m", 20));
    await w.dispatch(agentStep("mt", 1, { localStep: 1, tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch(agentStep("mt", 2, { localStep: 2, tool: "exec", arguments: { js: "x" }, result: "ok" }));
    await w.dispatch(agentResult("mt", "done one", 2));
    // A follow-up run() continues the SESSION: its cumulative step is offset (3, 4…) so groups don't merge,
    // but the pill must reset to the per-turn count (1/20, 2/20) — the run got a fresh 20-step budget.
    await w.dispatch({ kind: "agent-say", id: "mt", ts: Date.now(), save: false, session: { hash: "mt", turn: 0 }, text: "turn two" });
    await w.dispatch(agentStep("mt", 3, { localStep: 1, tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch(agentStep("mt", 4, { localStep: 2, tool: "exec", arguments: { js: "y" }, result: "ok" }));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const pills = [...w.shadow.querySelectorAll(".step-pill")].map(p => p.textContent.replace(/\s+/g, " ").trim());
    // Two turns, each counting 1/20, 2/20 — NOT 3/20, 4/20 on the second turn.
    assert.deepEqual(pills, ["step 1/20", "step 2/20", "step 1/20", "step 2/20"],
        "the pill resets per turn (localStep), never showing the cumulative 3/20 · 4/20");
});

test("card surface: a running run shows the liquid orb + right-click asks for the corner menu", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardrun3";
    await w.dispatch(agentStart(hash, "read the page", "m"));
    // A running tool step (pending, but NOT awaiting approval) → the liquid tool orb.
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));
    await w.flush();

    assert.ok(posted.some(m => m.__mlSidebarCard === "orb"), "reveals the working orb while running");
    const orb = w.window.document.querySelector(".card-orb");
    assert.ok(orb, "orb rendered");
    assert.match(orb.querySelector(".card-orb-ic")?.textContent || "", /👁/, "shows the look tool emoji");
    // Hover → the blob RESHAPES into a labelled capsule spelling out the current tool.
    orb.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.ok(posted.some(m => m.__mlSidebarCard === "orblabel"), "hover stretches the orb into the labelled capsule");
    assert.match(w.window.document.querySelector(".card-orb-label")?.textContent || "", /screen/i, "the capsule names the current tool (look → viewing the screen)");

    // Right-clicking the orb asks the shell to draw the corner menu (shell-side, unclipped).
    orb.dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarCornerMenu), "right-click requests the corner menu");
});

test("card Show-work: on-demand Explain fetches a plain-English gloss for a code step (card only)", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", utilityModel: "util" },
        fetchLlm: () => ({ data: "Sums every column and returns the grand total." }),
    });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "workE";
    await w.dispatch(agentStart(hash, "sum it", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "python_exec", arguments: { code: "df.sum()" }, result: "42", approval: "sandbox" }));
    await w.dispatch(agentResult(hash, "The total is 42.", 1));
    await w.flush();

    const doc = w.window.document;
    doc.querySelector(".card-work-toggle").click(); await w.tick();          // expand Show work
    const step = doc.querySelector(".card-work-trace .astep.tool");
    // The Explain affordance lives UNDER the collapsed step (not nested in its expand) — no head click.
    assert.ok(!step.querySelector(".astep-body"), "the step is still collapsed");
    const btn = [...step.querySelectorAll("button")].find(b => /Explain this Python/.test(b.textContent));
    assert.ok(btn, "an Explain affordance shows on the collapsed code step in the card trace");

    btn.click(); await w.flush();
    assert.match(step.querySelector(".step-explain").textContent, /grand total/, "the gloss lands inline");

    // Right-click the toggle → an export menu (Markdown / PDF), reusing the debug-bar export logic.
    doc.querySelector(".card-work-toggle").dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await w.tick();
    const menu = doc.querySelector(".card-export-menu");
    assert.ok(menu, "right-click opens the export menu");
    const labels = [...menu.querySelectorAll(".menu-item")].map(b => b.textContent);
    assert.ok(labels.some(t => /Markdown/.test(t)) && labels.some(t => /PDF/.test(t)), "offers Markdown + PDF export");
});

test("card corner menu: the request carries the run hash + live flag (for Copy id / Cancel)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cancelme";
    await w.dispatch(agentStart(hash, "do a thing", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));
    await w.flush();

    // While RUNNING → live:true (Cancel is offered), and the hash rides along for Copy run id.
    w.window.document.querySelector(".card-orb").dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    const live = posted.filter(m => m.__mlSidebarCornerMenu).pop();
    assert.equal(live.__mlSidebarCornerMenu.hash, hash, "carries the run hash");
    assert.equal(live.__mlSidebarCornerMenu.live, true, "a running run is cancellable");

    // Once it finishes → live:false (nothing to cancel), hash still present.
    await w.dispatch(agentResult(hash, "done", 1));
    await w.flush();
    w.window.document.querySelector(".card-head").dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    const done = posted.filter(m => m.__mlSidebarCornerMenu).pop();
    assert.equal(done.__mlSidebarCornerMenu.live, false, "a finished run is not cancellable");
    assert.equal(done.__mlSidebarCornerMenu.hash, hash, "still carries the hash (Copy run id)");

    // With the menu open, the NEXT pointerdown inside the card asks the shell to dismiss it — the shell's
    // own outside-click handler can't see an in-iframe click (and the page window is already blurred).
    posted.length = 0;
    w.window.dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarCornerMenuDismiss), "an in-card click dismisses the open menu");
});

test("card composer (Spotlight): opens as a task input, Send posts a real startRun + closes", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    // The shell relays the Alt+Space command as __mlSidebarComposer: "open".
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    assert.ok(posted.some(m => m.__mlSidebarCard === "composer"), "the HUD morphs into the centered composer state");
    const input = doc.querySelector(".card-cmp-input");
    assert.ok(input, "the composer input renders");
    assert.match(doc.querySelector(".card-head-txt").textContent, /New task/);

    // Empty → Send disabled.
    const sendBtn = [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent));
    assert.ok(sendBtn.disabled, "Send is disabled with no text");

    // Pretty step-budget segmented control, default preset selected.
    const on = doc.querySelector(".seg .seg-opt.on");
    assert.ok(on && on.textContent === "20", "the default step budget (20) is the selected preset");

    // Type + Send → posts a real startRun with the task, and the composer closes.
    input.value = "summarise this page";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();
    const start = posted.find(m => m.__mlSidebarApp === "startRun");
    assert.ok(start, "Send posts a startRun to the shell");
    assert.equal(start.task, "summarise this page", "carries the typed task");
    assert.equal(start.maxSteps, 20, "carries the default step budget");
    assert.ok(!doc.querySelector(".card-cmp-input"), "the composer closes after sending");
    // The HUD acknowledges immediately (no dead gap before the run's first event): a "Starting…" bridge orb.
    assert.ok(posted.some(m => m.__mlSidebarCard === "orb"), "the HUD balls up into a working orb on send");
    assert.match(doc.querySelector(".card-orb-ic")?.textContent || "", /💭/, "the bridge orb shows the thinking emoji");
});

test("card composer: no model configured → an inline nudge, NOT a run (pre-flight)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "" } });   // fresh install, no model picked
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;

    doc.querySelector(".card-cmp-input").value = "do something";
    doc.querySelector(".card-cmp-input").dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();

    assert.ok(!posted.some(m => m.__mlSidebarApp === "startRun"), "no run is started with no model");
    const err = doc.querySelector(".card-cmp-err");
    assert.ok(err && /model/i.test(err.textContent), "an inline 'set a model' nudge shows instead");
    assert.ok(doc.querySelector(".card-cmp-input"), "the composer stays open (not closed) so you can fix it");
});

test("card composer: backend unreachable → a NEW run is BLOCKED with an inline notice (only new runs paused)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3", chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();   // the on-mount health probe flags the dead box
    const doc = w.window.document;
    // Proactively (before even typing) the composer shows the backend is down.
    assert.match(doc.querySelector(".card-cmp-err")?.textContent || "", /Backend unreachable/i, "a proactive offline notice shows");

    doc.querySelector(".card-cmp-input").value = "do something";
    doc.querySelector(".card-cmp-input").dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();

    assert.ok(!posted.some(m => m.__mlSidebarApp === "startRun"), "no NEW run is started while the box is down");
    assert.match(doc.querySelector(".card-cmp-err").textContent, /Backend unreachable/i, "the block reason is shown");
    assert.ok(doc.querySelector(".card-cmp-input"), "the composer stays open so it can send once the box is back");
});

test("card composer: the model picker overrides the run's model, and a cloud pick adds a per-call vision toggle", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", model: "llama3" },
        models: ["llama3", "gpt-4o"], ollamaModels: ["llama3"],   // gpt-4o is non-Ollama (cloud) → offers native vision
    });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;

    // The chip shows the configured default; an Ollama default has NO native-vision toggle (auto-detected).
    assert.match(doc.querySelector(".cmp-model-name").textContent, /llama3/, "the chip shows the default model");
    assert.ok(!doc.querySelector(".cmp-vis"), "an Ollama default gets no vision toggle");

    // Open the dropdown → both allowed models listed, the default row starred.
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    const rows = [...doc.querySelectorAll(".cmp-model-row")];
    assert.equal(rows.length, 2, "the dropdown lists the allowed models (LIST_MODELS)");
    const starOn = doc.querySelector(".cmp-model-row .cmp-model-star.on");
    assert.ok(starOn && /llama3/.test(starOn.closest(".cmp-model-row").textContent), "the default model row is starred");

    // Pick the cloud model → it becomes the run's model, and the eye (native vision) appears.
    rows.find(r => /gpt-4o/.test(r.textContent)).click();
    await w.tick();
    assert.match(doc.querySelector(".cmp-model-name").textContent, /gpt-4o/, "the chip updates to the picked model");
    const eye = doc.querySelector(".cmp-vis");
    assert.ok(eye, "a non-Ollama pick surfaces the per-call vision toggle");
    eye.click();   // enable native vision for THIS run
    await w.tick();
    assert.ok(doc.querySelector(".cmp-vis.on"), "the vision toggle reads as on");

    // Type + Send → the startRun carries the per-call model AND vision:true.
    const input = doc.querySelector(".card-cmp-input");
    input.value = "read the chart";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();
    const start = posted.find(m => m.__mlSidebarApp === "startRun");
    assert.equal(start.model, "gpt-4o", "the per-call model rides the startRun payload");
    assert.equal(start.vision, true, "the per-call native-vision override rides along");
});

test("card composer: the default Ollama model sends NO per-call model/vision override", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3" }, models: ["llama3", "gpt-4o"], ollamaModels: ["llama3"] });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    const input = doc.querySelector(".card-cmp-input");
    input.value = "click login";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    posted.length = 0;
    [...doc.querySelectorAll(".card-foot button")].find(b => /Send/.test(b.textContent)).click();
    await w.flush();
    const start = posted.find(m => m.__mlSidebarApp === "startRun");
    assert.equal(start.model, undefined, "no per-call model when the default is used — createAgent falls back to config");
    assert.equal(start.vision, undefined, "no vision override for an auto-detected Ollama model");
});

test("card composer: the ★ persists the picked model as the default (SET_MODEL)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off", model: "llama3" }, models: ["llama3", "gpt-4o"], ollamaModels: ["llama3"] });
    w.window.postMessage = () => {};
    const sent = [];
    w.window.chrome.runtime.sendMessage = (msg, cb) => { sent.push(msg); if (cb) cb({ data: msg && msg.payload ? msg.payload.model : null }); };
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    const cloudRow = [...doc.querySelectorAll(".cmp-model-row")].find(r => /gpt-4o/.test(r.textContent));
    cloudRow.querySelector(".cmp-model-star").click();
    await w.tick();
    const setMsg = sent.find(m => m.type === "SET_MODEL");
    assert.ok(setMsg, "clicking the ★ sends a SET_MODEL");
    assert.equal(setMsg.payload.model, "gpt-4o", "SET_MODEL targets the row's model");
});

test("card composer: the dropdown ALWAYS includes the configured default (even a cloud one not in the server list) and sorts A→Z", async () => {
    const w = await loadSidebarWorld({
        sync: { debugMode: "off", model: "deepseek-v4-pro" },   // a cloud default NOT present in the server model list
        models: ["gemma4:e4b", "alpha:2b"], ollamaModels: ["gemma4:e4b", "alpha:2b"],
    });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.raw({ __mlSidebarComposer: "open" });
    await w.flush();
    const doc = w.window.document;
    doc.querySelector(".cmp-model-btn").click();
    await w.tick();
    const names = [...doc.querySelectorAll(".cmp-model-row .cmp-model-row-name")].map(n => n.textContent);
    assert.deepEqual(names, ["alpha:2b", "deepseek-v4-pro", "gemma4:e4b"], "the default is present and the list is alphabetical");
    const starred = doc.querySelector(".cmp-model-row .cmp-model-star.on").closest(".cmp-model-row");
    assert.match(starred.textContent, /deepseek-v4-pro/, "the default (not in the server list) is the starred row");
});

test("card surface: a cancelled run reads as 'Cancelled'", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cxld";
    await w.dispatch(agentStart(hash, "long task", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "look", arguments: {}, result: "ok" }));
    await w.dispatch({ kind: "agent-result", id: hash, ts: Date.now(), save: false, session: { hash, turn: 1 }, summary: "", steps: 1, hitCap: false, cancelled: true });
    await w.flush();

    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Cancelled/, "the headline shows Cancelled");
});

// --- HUD concurrency: multiple live agent runs share the corner card via a tab strip ----------------
// Events with EXPLICIT ts so createdTs (tab order) + lastTs (latest-active) are deterministic.
const cStart = (hash, task, ts, config = null) => ({ kind: "agent", id: hash, ts, save: false, session: { hash, turn: 0 }, task, model: "m", maxSteps: 10, config });
const cStep = (hash, step, ts, fields) => ({ kind: "agent-step", id: hash, ts, save: false, session: { hash, turn: step }, step, ...fields });
const cResult = (hash, summary, ts, steps = 1, extra = {}) => ({ kind: "agent-result", id: hash, ts, save: false, session: { hash, turn: steps }, summary, steps, hitCap: false, ...extra });
const APPROVAL_STEP = { seq: 0, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#danger" },
    renderIn: { type: "action", verb: "Click", kind: "button", target: "Delete account", selector: "#danger" } };
const pointerDown = (win, el) => el.dispatchEvent(new win.Event("pointerdown", { bubbles: true, cancelable: true }));

test("card concurrency: a second run does NOT steal the card from a run awaiting approval (badge-don't-steal)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // Run A hits an approval gate → it becomes the selected, expanded card.
    await w.dispatch(cStart("A", "delete the account", 1000));
    await w.dispatch(cStep("A", 1, 1010, APPROVAL_STEP));
    await w.flush();
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "A's approval is shown");

    // Run B starts LATER and streams steps (higher lastTs than A). It must NOT hijack the visible approval.
    await w.dispatch(cStart("B", "summarise the page", 2000));
    await w.dispatch(cStep("B", 1, 2010, { thought: "reading…" }));
    await w.dispatch(cStep("B", 1, 2020, { seq: 0, tool: "look", arguments: {}, result: "ok" }));
    await w.flush();

    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "still A's approval — B added a tab, it didn't steal the view");
    assert.match(w.window.document.querySelector(".action-sentence").textContent, /Delete account/, "the shown approval is still A's target");
});

test("card concurrency: the selected run stays put even after the OTHER run finishes", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "delete the account", 1000));
    await w.dispatch(cStep("A", 1, 1010, APPROVAL_STEP));      // A pending → selected
    await w.dispatch(cStart("B", "quick lookup", 2000));
    await w.dispatch(cResult("B", "The answer is 42.", 2100)); // B finishes with an answer
    await w.flush();

    // Selection is sticky on A's approval; B's completion does not yank the card over to B's answer.
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "A's approval still holds the card");
    assert.doesNotMatch(w.window.document.body.textContent, /The answer is 42/, "B's answer did not steal the view");
});

test("card concurrency: dismissing the shown run falls back to the OTHER run, not a blank card", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "task B", 1200));
    await w.dispatch(cResult("B", "Answer B.", 1300));
    await w.flush();
    // No pending run → auto-pick the most recently active (B, lastTs 1300).
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer B/, "the most-recent finished run shows first");

    // × on the finished card dismisses THIS run only (pointerdown, as the real handler binds).
    pointerDown(w.window, w.window.document.querySelector(".card-head .card-x"));
    await w.flush();
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer A/, "dismiss revealed the other run, not an empty/hidden card");

    // Dismiss the last one too → the card goes away entirely.
    pointerDown(w.window, w.window.document.querySelector(".card-head .card-x"));
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-answer"), "dismissing the last run hides the card");
});

test("card concurrency: a single run behaves exactly as before (no tab strip)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(cStart("solo", "one task", 1000));
    await w.dispatch(cResult("solo", "All done.", 1100));
    await w.flush();
    assert.match(w.window.document.querySelector(".card-answer").textContent, /All done/, "the single finished run shows its answer");
    assert.ok(!w.window.document.querySelector(".card-tabs"), "no tab strip for a single run");
});

test("card concurrency: >1 run shows a tab strip; clicking a tab switches the shown run", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "task B", 1200));
    await w.dispatch(cResult("B", "Answer B.", 1300));
    await w.flush();

    const tabs = w.window.document.querySelectorAll(".card-tabs .card-tab");
    assert.equal(tabs.length, 2, "two tabs for two runs");
    // Stable order by createdTs: A then B. B (latest) is the shown/active one by default.
    assert.match(tabs[0].querySelector(".card-tab-label").textContent, /task A/);
    assert.match(tabs[1].querySelector(".card-tab-label").textContent, /task B/);
    assert.ok(tabs[1].classList.contains("on"), "the latest run's tab is active by default");
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer B/, "B's answer shows");

    // Click A's tab → the card switches to A (manual selection sticks).
    tabs[0].click(); await w.flush();
    assert.match(w.window.document.querySelector(".card-answer").textContent, /Answer A/, "clicking A's tab shows A");
    assert.ok(w.window.document.querySelectorAll(".card-tabs .card-tab")[0].classList.contains("on"), "A's tab is now active");
});

test("card concurrency: a run awaiting approval shows an amber pulse dot on its tab (badge)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // A is a finished run the user is viewing; B (later) hits an approval gate.
    await w.dispatch(cStart("A", "finished task", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "risky task", 1200));
    await w.dispatch(cStep("B", 1, 1210, APPROVAL_STEP));
    await w.flush();

    // selectedRun prefers the PENDING run → B's approval is shown, with tabs.
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /Approval needed/, "the pending run surfaces");
    const bTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /risky task/.test(t.textContent));
    assert.ok(bTab.querySelector(".card-tab-dot.pend"), "the pending run's tab carries the amber pulse dot");
    assert.ok(bTab.classList.contains("pend"), "…and the tab is flagged pending");
    // A's tab shows the done ✓, not a pulse.
    const aTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /finished task/.test(t.textContent));
    assert.ok(aTab.querySelector(".card-tab-fin"), "the finished run's tab shows a done glyph");
    assert.ok(!aTab.querySelector(".card-tab-dot"), "…and no pending dot");
});

test("card concurrency: a running run's tab shows a spinner; the × on a tab dismisses THAT run", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    await w.dispatch(cStart("A", "done task", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "working task", 1200));
    await w.dispatch(cStep("B", 1, 1210, { thought: "still going…" }));
    await w.flush();

    // Two runs → tabs; B is working (higher lastTs) so it's shown as a compact toast with a spinner tab.
    const bTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /working task/.test(t.textContent));
    assert.ok(bTab.querySelector(".card-tab-spin"), "the running run's tab shows a spinner");

    // × on A's tab dismisses A only → one tab left, no strip (single run), B still shown.
    const aTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /done task/.test(t.textContent));
    pointerDown(w.window, aTab.querySelector(".card-tab-x"));
    await w.flush();
    assert.ok(!w.window.document.querySelector(".card-tabs"), "dismissing down to one run drops the tab strip");
    // With only one run left, B (working) reverts to the bare orb (single-run look) — still shown, not hidden.
    assert.ok(w.window.document.querySelector(".card-orb"), "the remaining working run shows as an orb");
});

test("card concurrency: the expanded head NAMES the selected run (its title), not a generic 'Task complete'", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(cStart("A", "count the sales rows", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));
    await w.dispatch(cStart("B", "summarise the reviews", 1200));
    await w.dispatch(cResult("B", "Answer B.", 1300));
    await w.flush();

    // Multi-run detail: the head is the SELECTED run's title (B, latest), not "Task complete".
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /summarise the reviews/);
    assert.doesNotMatch(w.window.document.querySelector(".card-head-txt").textContent, /Task complete/);
    // The tab carries the full title as a hover tooltip (native title=), so a shrunk tab is still identifiable.
    const aTab = [...w.window.document.querySelectorAll(".card-tab")].find(t => /count the sales/.test(t.textContent));
    assert.match(aTab.getAttribute("title") || "", /count the sales rows/, "the tab's full title is the hover tooltip");
    // Switch to A → the head renames to A's title.
    aTab.click(); await w.flush();
    assert.match(w.window.document.querySelector(".card-head-txt").textContent, /count the sales rows/);
});

test("card concurrency: collapsing a multi-run card shows a calm SUMMARY (count badge, no tabs, no per-run title)", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    for (const [h, t, a] of [["A", "task A", 1000], ["B", "task B", 1200], ["C", "task C", 1400]]) {
        await w.dispatch(cStart(h, t, a));
        await w.dispatch(cResult(h, `Answer ${h}.`, a + 100));
    }
    await w.flush();

    // Collapse via the ▾ header button → the calm summary.
    w.window.document.querySelector(".card-head .card-icon").click(); await w.flush();
    assert.ok(w.window.document.querySelector(".card-toast.summary"), "collapsed to the summary toast");
    assert.match(w.window.document.querySelector(".card-toast-head").textContent, /All tasks complete/, "generic status, all done");
    assert.equal(w.window.document.querySelector(".card-count").textContent, "3", "count badge = number of runs");
    assert.ok(!w.window.document.querySelector(".card-tabs"), "the summary has NO tab strip");
    assert.ok(!w.window.document.querySelector(".card-toast-sub"), "no per-run title subtitle in the summary");
    assert.ok(!w.window.document.querySelector(".card-answer"), "no per-run answer in the summary");

    // Clicking the summary re-expands to the tabbed detail with the selected run's answer.
    w.window.document.querySelector(".card-toast.summary").click(); await w.flush();
    assert.ok(w.window.document.querySelector(".card-tabs"), "clicking the summary reopens the tabbed detail");
    assert.ok(w.window.document.querySelector(".card-answer"), "…with the selected run's answer");
});

test("card concurrency: the summary reads 'Some tasks complete' while one run is still working", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cResult("A", "Answer A.", 1100));   // done
    await w.dispatch(cStart("B", "task B", 1200));
    await w.dispatch(cStep("B", 1, 1210, { thought: "still working…" }));   // running
    await w.flush();

    // B (working) is the selected detail; collapse to the summary.
    w.window.document.querySelector(".card-head .card-icon").click(); await w.flush();
    assert.match(w.window.document.querySelector(".card-toast-head").textContent, /Some tasks complete/, "1 of 2 done → 'Some tasks complete'");
    assert.equal(w.window.document.querySelector(".card-count").textContent, "2");
});

test("card concurrency: several runs merely WORKING stay a single orb — it narrates the last op across runs", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });   // progress HUD → live caption
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });

    // Two runs, both only working (no approval, no answer) → no card content to reach → keep the bare orb.
    await w.dispatch(cStart("A", "task A", 1000));
    await w.dispatch(cStep("A", 1, 1010, { thought: "run A: reading the header…" }));
    await w.dispatch(cStart("B", "task B", 1100));
    await w.dispatch(cStep("B", 1, 1110, { thought: "run B: scanning the table…" }));
    await w.flush();

    assert.ok(!w.window.document.querySelector(".card-tabs"), "no tab strip while every run is merely working");
    const label = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label && /run B: scanning the table/.test(label.textContent), "the orb narrates the most recent op (run B)");

    // Run A then does the newer op → the SAME single orb now narrates A (last op across runs).
    await w.dispatch(cStep("A", 2, 1200, { thought: "run A: clicking submit…" }));
    await w.flush();
    const label2 = w.window.document.querySelector(".card-orb.prose .card-orb-label");
    assert.ok(label2 && /run A: clicking submit/.test(label2.textContent), "the orb follows the latest op across runs");
    assert.ok(!w.window.document.querySelector(".card-tabs"), "still one orb, no tabs");
});

// --- Raw In args: schema-annotated JSON tree (hover a key for its description) -----------------------
const agentCfg = (tools) => ({ system: "sys", customSystem: false, tools, maxSteps: 10, think: null, env: true, vision: null, hints: null, unattended: false, silent: false, driverSees: false, visionModel: null });
const clickTool = { name: "click", requiresApproval: true, vision: false, description: "Click an element.", summary: "Clicks.",
    parameters: { type: "object", required: ["selector"], properties: {
        selector: { type: "string", description: "CSS selector or @pt token from locate." },
        verify: { type: "boolean", description: "Look at the result after clicking." } } } };

test("raw In args: a key documented in the tool schema gets a hover tooltip; an undefined arg gets a red-squiggle warning", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("r1", "task", "m", 10, agentCfg([clickTool])));
    await w.dispatch(agentStep("r1", 1, { seq: 1, tool: "click", arguments: { selector: "#b", verify: true, bogus: 1 } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();

    const docKeys = [...w.shadow.querySelectorAll(".astep.tool .jt-key-doc")].map(n => n.textContent);
    assert.ok(docKeys.some(t => /selector/.test(t)) && docKeys.some(t => /verify/.test(t)), `documented keys are underlined (${docKeys})`);
    const bogus = [...w.shadow.querySelectorAll(".astep.tool .jt-key")].find(n => /bogus/.test(n.textContent));
    assert.ok(bogus && bogus.classList.contains("jt-key-unknown"), "an arg NOT in the schema gets the red-squiggle 'unknown' style");
    assert.match(bogus.querySelector(".tt-pop").textContent, /Not in this tool's parameter schema/, "…with a hallucinated-arg warning");
    const tips = [...w.shadow.querySelectorAll(".astep.tool .jt-key-doc .tt-pop")].map(n => n.textContent).join(" | ");
    assert.match(tips, /CSS selector or @pt/, "tooltip text is the schema description");
    assert.ok(w.shadow.querySelector(".astep.tool .jt-args-copy"), "the tree carries a copy-JSON button (a tree isn't drag-selectable)");
});

test("raw In args: malformed schema / non-object args never crash the panel (falls back safely)", async () => {
    const w = await loadSidebarWorld();
    const badProps = { name: "x", parameters: { type: "object", properties: "not-an-object" } };
    const badNode = { name: "y", parameters: { type: "object", properties: { a: "should-be-a-schema", b: 5 } } };
    await w.dispatch(agentStart("r2", "t", "m", 10, agentCfg([badProps, badNode])));
    await w.dispatch(agentStep("r2", 1, { seq: 1, tool: "x", arguments: { a: 1, b: 2 } }));
    await w.dispatch(agentStep("r2", 2, { seq: 2, tool: "y", arguments: { a: { nested: true }, b: [1, 2] } }));
    await w.dispatch(agentStep("r2", 3, { seq: 3, tool: "z", arguments: "a bare string, not an object" }));
    w.shadow.querySelector(".row").click(); await w.tick();
    for (const head of w.shadow.querySelectorAll(".astep.tool .astep-head")) { head.click(); await w.tick(); }

    assert.ok(w.shadow.querySelectorAll(".astep.tool").length >= 3, "every step rendered — nothing threw");
    assert.equal(w.shadow.querySelectorAll(".jt-key-doc").length, 0, "a malformed schema yields NO descriptions (never a crash)");
    assert.ok(w.shadow.querySelector(".astep.tool .code"), "non-object args fall back to the copyable code renderer");
});

// --- JsonNode renderer, focused ---------------------------------------------------------------------
const nestedTool = { name: "cfg", summary: "Configures.", parameters: { type: "object", properties: {
    opts: { type: "object", description: "Options bag.", properties: { retries: { type: "number", description: "How many times to retry." } } } } } };

test("raw In args: a NESTED arg key gets its schema description (schema walk recurses)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rn", "t", "m", 10, agentCfg([nestedTool])));
    await w.dispatch(agentStep("rn", 1, { seq: 1, tool: "cfg", arguments: { opts: { retries: 3 } } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const retries = [...w.shadow.querySelectorAll(".astep.tool .jt-key-doc")].find(n => /retries/.test(n.textContent));
    assert.ok(retries, "the nested key is documented");
    assert.match(retries.querySelector(".tt-pop").textContent, /How many times to retry/, "nested tooltip is the nested schema description");
});

test("raw In args: the always-expanded tree has NO collapse chevrons and shows nested values", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("re", "t", "m", 10, agentCfg([nestedTool])));
    await w.dispatch(agentStep("re", 1, { seq: 1, tool: "cfg", arguments: { opts: { retries: 3 } } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    assert.equal(w.shadow.querySelectorAll(".astep.tool .jt-args .tri").length, 0, "no chevrons in the raw In tree (allOpen)");
    assert.ok([...w.shadow.querySelectorAll(".astep.tool .jt-key")].some(n => /retries/.test(n.textContent)), "the nested value is expanded, not collapsed behind a preview");
});

// --- Agent-step render: gotchas NOT already covered above ("in-flight patch" + "approval provenance
// badge" already have tests near line 1104/1511 — these fill the remaining gaps). ------------------------
test("agent-step: an arg-schema mismatch shows the warning count + the red strip", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("i1", "t"));
    await w.dispatch(agentStep("i1", 1, { seq: 1, tool: "click", arguments: { selector: 1 }, result: "ok", argIssues: ["selector should be string"] }));
    w.shadow.querySelector(".row").click(); await w.tick();
    assert.ok(w.shadow.querySelector(".astep.tool .arg-warn"), "the head shows an arg-warn count");
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    assert.match(w.shadow.querySelector(".astep.tool .arg-issues").textContent, /selector should be string/, "the red strip lists the issue");
});

test("agent-step: a tool's feedback renders the 'Sent to the model' block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("f1", "t"));
    await w.dispatch(agentStep("f1", 1, { seq: 1, tool: "locate", arguments: { description: "x" }, result: "ok",
        feedback: { reason: "point located — fed back automatically", via: "image", image: "data:image/png;base64,AAAA" } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const fb = w.shadow.querySelector(".astep.tool .astep-feedback");
    assert.ok(fb, "the feedback disclosure is present");
    assert.match(fb.querySelector(".feedback-title").textContent, /Sent to the model/);
    assert.match(fb.querySelector(".feedback-why").textContent, /point located/);
});

test("agent-step: a step's delegated sub-call tokens surface as the '+N sub' usage chip", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("s1", "t"));
    await w.dispatch(agentStep("s1", 1, { seq: 1, tool: "locate", arguments: { description: "x" }, result: "ok",
        usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 }, subUsage: { prompt: 2800, completion: 60, calls: 2 } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    const sub = w.shadow.querySelector(".usage-sub");
    assert.ok(sub, "the usage bar shows the delegated sub-call chip");
    assert.match(sub.textContent, /sub/, "labelled as sub-call spend");
    assert.match(sub.querySelector(".tt-pop").textContent, /2,860 tokens over 2 delegated/, "tooltip has the total + call count");
});

// --- Tool-token ANSWER render: the bottom "Result" block + inline citations (see docs/spec/TOOL_TOKENS.md).
// Two ways an output reaches the answer, BOTH explicit (no auto-fallback): (1) inline @tool cite (expands in the
// reply), (2) designated into the answer set (ml.answer / the answer tool). The reducer stores ev.answer (the
// finalized bottom markdown) + the step's minted `token`; the render resolves it.
const OUT = "abcdef";
const compStep = (hash) => agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "COMPUTED_TABLE",
    renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } });
const openRun = async (w) => { w.shadow.querySelector(".row").click(); await w.tick(); };

test("answer render (sidebar): a bottom-of-answer output shows in a RESULT block under the prose", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("af", "compute it"));
    await w.dispatch(compStep("af"));
    // prose summary (no inline cite) + a designated bottom token (what finalizeAnswer emits for ml.answer.add)
    await w.dispatch({ ...agentResult("af", "The total is 42.", 1), answer: `![computed result](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb, "a Result block renders under the answer");
    assert.match(rb.querySelector(".result-label").textContent, /result/i, "the label is the muted 'Result'");
    assert.match(rb.textContent, /COMPUTED_TABLE/, "the cited step's output is inlined into the block");
});

test("answer render (sidebar): a TOOL-NAME alias (@tool:python_exec) resolves to that tool's last step", async () => {
    // The real hallucination case: the model never set token:true (so it never saw the hex id) and cited the tool
    // by NAME — `![results](@tool:python_exec:out)`. compStep is a python_exec step with a minted token, so the
    // alias must resolve to it and the Result block must expand its output (proves aliasOf is threaded to the render).
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("al", "compute it"));
    await w.dispatch(compStep("al"));   // tool: python_exec, token: OUT
    await w.dispatch({ ...agentResult("al", "Here are the results.", 1), answer: "![results](@tool:python_exec:out)" });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb && /COMPUTED_TABLE/.test(rb.textContent), "the tool-name alias resolves to the python_exec step's output");
});

test("answer render (HUD card): a PRIOR Show-work block's answer resolves its @tool citation, not raw markdown", async () => {
    // Regression: the multi-task HUD trace rendered a prior block's answer via plain markdown, so a
    // `![Calculations](@tool:…)` citation showed as literal text (bug). It must resolve like the card body /
    // sidebar reply — via AnswerBody — so the cited output renders instead.
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    const hash = "blkcite";
    await w.dispatch(agentStart(hash, "compute totals", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "aa11bb", result: "COMPUTED_TABLE",
        renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } }));
    // The FIRST task's answer cites that step inline (the summary carries the ![…](@tool:…)).
    await w.dispatch(agentResult(hash, "The total is 42. ![Calculations](@tool:aa11bb:out)", 1));
    // A follow-up task → a second block, so the run SEGMENTS and block 0 becomes a PRIOR (CardTraceMsg-rendered).
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult(hash, "Done.", 2));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click(); await w.tick();   // open Show work
    const block0 = w.window.document.querySelectorAll(".run-block")[0];
    block0.querySelector(".run-block-head").click(); await w.tick();                 // expand the prior block
    const answered = block0.querySelector(".acard-ans");
    answered.querySelector(".astep-head").click(); await w.tick();                   // expand its "answered" disclosure
    assert.ok(answered.querySelector(".tok-ref"), "the @tool citation resolves to a token render");
    assert.match(answered.textContent, /COMPUTED_TABLE/, "the cited step's output is inlined");
    assert.doesNotMatch(answered.innerHTML, /@tool:aa11bb/, "the raw @tool markdown is NOT shown");
});

test("answer render (HUD card): a TOOL-NAME alias in a PRIOR block resolves to THAT block's tool call, not a later turn's", async () => {
    // The alias `@tool:python_exec` means "that tool's latest call" — unambiguous within a turn, but a PRIOR
    // turn's answer must NOT drift to a LATER turn's call once it runs. Turn 1 and turn 2 each run python_exec
    // (CODE_ONE / CODE_TWO) and each answer cites `@tool:python_exec:in`; block 0's answer must still show
    // CODE_ONE after turn 2's CODE_TWO exists. (The hex id is anchored per-step; this guards the alias.)
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "aliasdrift";
    await w.dispatch(agentStart(hash, "compute", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "aaa111",
        renderIn: { type: "python-in", code: "CODE_ONE", mode: "script" }, result: "out1" }));
    await w.dispatch(agentResult(hash, "First: ![the code](@tool:python_exec:in)", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "python_exec", token: "bbb222",
        renderIn: { type: "python-in", code: "CODE_TWO", mode: "script" }, result: "out2" }));
    await w.dispatch(agentResult(hash, "Second: ![the code](@tool:python_exec:in)", 2));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click(); await w.tick();
    const block0 = w.window.document.querySelectorAll(".run-block")[0];
    block0.querySelector(".run-block-head").click(); await w.tick();
    const answered = block0.querySelector(".acard-ans");
    answered.querySelector(".astep-head").click(); await w.tick();
    assert.match(answered.textContent, /CODE_ONE/, "block 0's alias resolves to ITS OWN python_exec (CODE_ONE)");
    assert.doesNotMatch(answered.textContent, /CODE_TWO/, "it did NOT drift to turn 2's later python_exec");
});

test("answer render (sidebar): a PRIOR turn's tool-name alias resolves to ITS turn's call, not a later turn's", async () => {
    // The DevTools/overlay chat log (AgentRunView) renders each turn's answer via ReplyBubble; a prior turn's
    // `@tool:python_exec` alias must stay pinned to that turn's call as later turns run the same tool.
    const w = await loadSidebarWorld();
    const hash = "sbalias";
    await w.dispatch(agentStart(hash, "compute", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "aaa111",
        renderIn: { type: "python-in", code: "CODE_ONE", mode: "script" }, result: "out1" }));
    await w.dispatch(agentResult(hash, "First: ![the code](@tool:python_exec:in)", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "python_exec", token: "bbb222",
        renderIn: { type: "python-in", code: "CODE_TWO", mode: "script" }, result: "out2" }));
    await w.dispatch(agentResult(hash, "Second: ![the code](@tool:python_exec:in)", 2));
    await w.flush();
    w.shadow.querySelector(".row").click(); await w.tick();
    const replies = [...w.shadow.querySelectorAll(".msg.asst .answer-rendered")];
    assert.ok(replies.length >= 2, "both answers render as token-resolved bodies");
    assert.match(replies[0].textContent, /CODE_ONE/, "turn 1's answer alias → CODE_ONE (its own call)");
    assert.doesNotMatch(replies[0].textContent, /CODE_TWO/, "…and does NOT drift to turn 2's later call");
    assert.match(replies[1].textContent, /CODE_TWO/, "turn 2's answer alias → CODE_TWO");
});

test("answer render (sidebar): a sympy-AUTO `latex` python-out typesets with NO cast; `| raw` overrides", async () => {
    // python-runtime detects a sympy return and flags the descriptor `latex:true`, so a plain `:out` citation
    // typesets WITHOUT the model writing `| latex`. `| raw` still forces the literal string.
    const autoStep = (hash) => w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "2 x e^{3 x}",
        renderOut: { type: "python-out", value: "2 x e^{3 x} \\cos\\left(x^{2}\\right)", latex: true } }));
    let w = await loadSidebarWorld();
    await w.dispatch(agentStart("auto", "differentiate"));
    await autoStep("auto");
    await w.dispatch({ ...agentResult("auto", "The derivative is ![d](@tool:" + OUT + ":out).", 1), answer: "" });   // NO | latex
    await openRun(w);
    let tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.querySelector(".katex"), "an auto-latex python-out typesets with NO | latex cast");

    w = await loadSidebarWorld();
    await w.dispatch(agentStart("auto2", "x"));
    await autoStep("auto2");
    await w.dispatch({ ...agentResult("auto2", "Literal: ![d](@tool:" + OUT + ":out | raw)", 1), answer: "" });
    await openRun(w);
    tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    // Mid-sentence `| raw` → inline <code> literal (not a katex render, not a boxed block).
    assert.ok(tok && !tok.querySelector(".katex") && tok.querySelector("code.tok-val") && !tok.querySelector("pre.code"),
        "| raw overrides the auto-latex → inline literal text");
});

// Reproduces run 200d7599: turn 1 mints @tool:239987 on a python_exec; a FOLLOW-UP turn cites that SAME hex
// token INLINE, mid-sentence, with `| latex`. It must (a) RESOLVE (a hex anchors any turn — the per-turn scope
// broke it → "unresolved" in the DevTools reply) and (b) render INLINE, not a display block. Both surfaces
// must agree (parity).
async function inlineHexLatexRun(w) {
    const hash = "xt";
    await w.dispatch(agentStart(hash, "differentiate", "gemma4:31b"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "239987", result: "e^{x} + 2",
        renderOut: { type: "python-out", value: "e^{x} + 2 \\sin{\\left(x \\right)} \\cos{\\left(x \\right)}", latex: true } }));
    await w.dispatch(agentResult(hash, "On its own line:\n\n![deriv](@tool:239987:out | latex)", 1));   // turn 1: standalone
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "inline please" });
    // turn 2: cite the SAME token INLINE, mid-sentence — NO python_exec step in this turn.
    await w.dispatch(agentResult(hash, "The derivative of $x$ is ![deriv](@tool:239987:out | latex), which renders inline.", 2));
    await w.flush();
    return hash;
}
// The rendered LATEST answer's citation must be resolved + inline in whichever surface's container is passed.
function assertInlineResolved(root) {
    const answers = [...root.querySelectorAll(".answer-rendered")];
    const latest = answers[answers.length - 1];
    const tok = latest.querySelector(".tok-ref");
    assert.ok(tok, "the latest answer's citation renders");
    assert.ok(!tok.classList.contains("tok-unresolved"), "a hex citation to a PRIOR turn RESOLVES (not unresolved)");
    assert.ok(tok.classList.contains("tok-inline") && !tok.classList.contains("tok-block"), "a mid-sentence citation is INLINE (green tok-inline), not a display block");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "…inline-mode KaTeX");
}

test("answer render: a comma-inline `| latex` cite (no newlines) is INLINE, not a display block — run 918874", async () => {
    // The EXACT text the model wrote: the citation is mid-sentence (comma right after, no blank line), so it
    // must render INLINE. (A stale `!`-embed build rendered every `![…]` as a display block — this guards it.)
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ex", "differentiate"));
    await w.dispatch(agentStep("ex", 1, { seq: 1, tool: "python_exec", token: "918874", result: "3x^2",
        renderOut: { type: "python-out", value: "3x^{2} + 4x - 5", latex: true } }));
    await w.dispatch(agentResult("ex", "The derivative is ![result](@tool:918874:out | latex), which is typeset inline.", 1));
    w.shadow.querySelector(".row").click(); await w.tick();
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-inline") && !tok.classList.contains("tok-block"), "a comma-inline citation is INLINE");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "inline-mode KaTeX (not a display block)");
});

test("answer render: an inline latex citation has NO wrapping <p> (KaTeX flows inline, not on its own line)", async () => {
    // The real "inline is broken" bug: markdown() wraps the inline `\(…\)` KaTeX in a block-level <p>, which
    // forced the formula onto its own line even though it was mid-sentence. inlineMarkdown strips that <p>.
    // Uses AUTO-latex (a python-out flagged latex, NO pipe) — the exact observe repro (run cbb2b8).
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nop", "diff"));
    await w.dispatch(agentStep("nop", 1, { seq: 1, tool: "python_exec", token: OUT, result: "x",
        renderOut: { type: "python-out", value: "x^{2} \\cos{\\left(x \\right)} + 2 x \\sin{\\left(x \\right)}", latex: true } }));
    await w.dispatch(agentResult("nop", "The derivative is ![result](@tool:" + OUT + ":out), as computed.", 1));
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-inline"), "a mid-sentence auto-latex cite is inline");
    assert.equal(tok.querySelector("p"), null, "NO block <p> wrapper — the KaTeX flows in the sentence");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "inline-mode KaTeX (not display)");
});

test("answer render: a citation ALONE on its own line is a DISPLAY block; SAME-line prose keeps it INLINE", async () => {
    const step = (w2, h) => w2.dispatch(agentStep(h, 1, { seq: 1, tool: "python_exec", token: OUT, result: "x",
        renderOut: { type: "python-out", value: "x^{2}", latex: true } }));
    // ALONE on its own line (single newlines each side, no blank) → DISPLAY block. The model's line placement IS
    // the intent ("on its own line → block"); the line-based markdown makes it the sole child of its own <p>.
    let w = await loadSidebarWorld();
    await w.dispatch(agentStart("sn", "diff")); await step(w, "sn");
    await w.dispatch(agentResult("sn", "The derivative:\n![d](@tool:" + OUT + ":out)\nDone.", 1));
    await openRun(w);
    let tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector(".katex-display"), "alone on its own line → DISPLAY block");
    // SAME line as prose (mid-sentence) → INLINE.
    w = await loadSidebarWorld();
    await w.dispatch(agentStart("bl", "diff")); await step(w, "bl");
    await w.dispatch(agentResult("bl", "The derivative is ![d](@tool:" + OUT + ":out) exactly.", 1));
    await openRun(w);
    tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok && !tok.classList.contains("tok-block") && !tok.querySelector(".katex-display"), "prose on the same line → INLINE");
});

// The "why do I need a newline top AND bottom" surprise (gemma4 rendering-variation runs): the model writes a
// labelled block as `No pipe:\n![cite]\n\nWith…` — the citation is ALONE on its own line. The line-based
// markdown() makes it the sole child of its own <p> → a DISPLAY block, no blank line needed on both sides.
const oneSidedBlockText = "No pipe:\n![no pipe](@tool:" + OUT + ":out)\n\nDone.";
async function oneSidedBlockRun(w, hash, text) {
    await w.dispatch(agentStart(hash, "diff"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "x",
        renderOut: { type: "python-out", value: "x^{2} + 2x", latex: true } }));
    await w.dispatch(agentResult(hash, text, 1));
    await w.flush();
}
function lastAnswer(root) {
    const answers = [...root.querySelectorAll(".answer-rendered")];
    return answers[answers.length - 1];
}
function firstTok(root) { return lastAnswer(root)?.querySelector(".tok-ref"); }
test("answer render (DevTools): a citation on its own line (`label:\\n![cite]`) is a DISPLAY block", async () => {
    const w = await loadSidebarWorld();
    await oneSidedBlockRun(w, "osb", oneSidedBlockText);
    await openRun(w);
    const tok = firstTok(w.shadow);
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector(".katex-display"),
        "alone on its own line → DISPLAY block (no double-blank needed)");
});
test("answer render (HUD card): the SAME own-line citation is a DISPLAY block — parity", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await oneSidedBlockRun(w, "osb", oneSidedBlockText);
    const tok = firstTok(w.window.document);
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector(".katex-display"),
        "HUD card renders the own-line citation as a DISPLAY block too");
});

// The list-item regression: a citation INSIDE a `- ` list item must stay INSIDE the <li>, with the trailing
// text on the SAME line as part of the same item. The old split-per-fragment renderer ran each prose run as its
// OWN markdown block, so `- No pipe: the result is ` became a CLOSED <ul>, the token landed AFTER it, and the
// trailing `.` orphaned into its own paragraph. The single-pass renderer keeps the list intact.
const listItemText = [
    "Results:",
    "- No pipe: the result is ![no pipe](@tool:" + OUT + ":out).",
    "- With raw: the value is ![v](@tool:" + OUT + ":out|raw).",
].join("\n");
function assertListIntact(root) {
    const ans = lastAnswer(root);
    assert.ok(ans, "the answer renders");
    const items = [...ans.querySelectorAll("ul > li")];
    assert.equal(items.length, 2, "both citations stay as list items (the <ul> isn't split apart)");
    // The token lives INSIDE its <li> and the trailing period is in the SAME item (not orphaned after the list).
    assert.ok(items[0].querySelector(".tok-ref"), "the citation is INSIDE the list item, not a sibling after the <ul>");
    assert.match(items[0].textContent.replace(/\s+/g, " ").trim(), /No pipe: the result is .*\.$/, "the item keeps its lead-in AND its trailing period");
    assert.ok(!ans.querySelector(".tok-ref")?.classList.contains("tok-block"), "an in-sentence list citation renders INLINE, not a display block");
    // No stray lone-period paragraph orphaned out of the list.
    assert.ok(![...ans.children].some((c) => c.tagName === "P" && c.textContent.trim() === "."), "no orphaned `.` paragraph");
}
test("answer render (DevTools): an inline citation inside a `- ` list item keeps the list intact", async () => {
    const w = await loadSidebarWorld();
    await oneSidedBlockRun(w, "li1", listItemText);
    await openRun(w);
    assertListIntact(w.shadow);
});
test("answer render (HUD card): the SAME list-item citation keeps the list intact — parity", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await oneSidedBlockRun(w, "li1", listItemText);
    assertListIntact(w.window.document);
});

test("answer render (DevTools): an inline `| latex` cite of a PRIOR turn's hex token resolves + renders inline", async () => {
    const w = await loadSidebarWorld();
    await inlineHexLatexRun(w);
    w.shadow.querySelector(".row").click(); await w.tick();
    assertInlineResolved(w.shadow.querySelector(".view") || w.shadow);
});

test("answer render (HUD card): the SAME inline cite resolves + renders inline — parity with DevTools", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await inlineHexLatexRun(w);
    assertInlineResolved(w.window.document);
});

test("answer render (sidebar): a citation CAPTION renders inline `$…$` math (models write latex in labels)", async () => {
    // Regression: the .tok-anno caption showed the model's label as raw text, so an inline `$\sin^2(x)$` in a
    // caption displayed the literal `$…$`. The caption is model prose → render it markdown+math.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cap", "compute"));
    await w.dispatch(compStep("cap"));   // a block citation (renderOut code) → the label becomes a caption
    await w.dispatch({ ...agentResult("cap", "See:\n\n![Derivative of $\\sin^2(x) + e^x$](@tool:" + OUT + ":out)", 1), answer: "" });
    await openRun(w);
    const anno = w.shadow.querySelector(".msg.asst .answer-rendered .tok-anno");
    assert.ok(anno, "the block citation shows its caption");
    assert.ok(anno.querySelector(".katex"), "inline $…$ in the caption typesets via KaTeX");
    assert.ok(!anno.textContent.includes("$"), "no literal $ delimiters remain in the caption");
});

test("answer render (sidebar): an INLINE citation expands in the reply, with NO separate Result block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("inl", "compute it"));
    await w.dispatch(compStep("inl"));
    // cited inline → finalizeAnswer dedups it out of the bottom (answer = "")
    await w.dispatch({ ...agentResult("inl", `The total is ![it](@tool:${OUT}:out).`, 1), answer: "" });
    await openRun(w);
    assert.ok(!w.shadow.querySelector(".card-result"), "no bottom Result block when the output is cited inline");
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply && /COMPUTED_TABLE/.test(reply.textContent), "the output expands inline in the reply body");
});

test("answer render (sidebar): a DESIGNATED output shows in the Result block, with the model's caption", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dsg", "compute it"));
    await w.dispatch(compStep("dsg"));
    await w.dispatch({ ...agentResult("dsg", "Done.", 1), answer: `![the sales table](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb && /COMPUTED_TABLE/.test(rb.textContent), "the designated output renders at the bottom");
    assert.match([...rb.querySelectorAll(".tok-anno")].map(n => n.textContent).join(" "), /the sales table/, "the model's caption shows under the block");
});

test("answer render (sidebar): the Result block ONLY renders on the run's LATEST answer (single-valued s.answer)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("mt", "compute it"));
    await w.dispatch(compStep("mt"));
    await w.dispatch({ ...agentResult("mt", "First.", 1), answer: `![a](@tool:${OUT}:out)` });
    // a follow-up turn (a new answer) — s.answer now reflects the LATEST turn only
    await w.dispatch({ kind: "agent-say", id: "mt", ts: Date.now() + 50, save: false, session: { hash: "mt", turn: 1 }, text: "again" });
    await w.dispatch({ ...agentResult("mt", "Second.", 1), answer: `![b](@tool:${OUT}:out)` });
    await openRun(w);
    const results = w.shadow.querySelectorAll(".card-result");
    assert.equal(results.length, 1, "exactly one Result block — on the latest answer, not every turn");
});

test("answer render (sidebar): a follow-up that designates NOTHING clears the prior Result block (no stale answer)", async () => {
    // The purge invariant: turn 1 surfaces a Result; a follow-up turn that designates/cites nothing arrives with NO
    // `answer` field, and the reducer REPLACES (s.answer = ev.answer || undefined) — so the stale block disappears.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("clr", "compute it"));
    await w.dispatch(compStep("clr"));
    await w.dispatch({ ...agentResult("clr", "The total is 42.", 1), answer: `![computed result](@tool:${OUT}:out)` });
    await openRun(w);
    assert.ok(w.shadow.querySelector(".card-result"), "turn 1's Result block renders");
    // Follow-up turn: a plain prose reply, no `answer` field (nothing designated).
    await w.dispatch({ kind: "agent-say", id: "clr", ts: Date.now() + 50, save: false, session: { hash: "clr", turn: 1 }, text: "thanks" });
    await w.dispatch(agentResult("clr", "You're welcome.", 2));   // NO answer field
    assert.ok(!w.shadow.querySelector(".card-result"), "the stale Result block is cleared after a designation-free follow-up");
});

test("HUD card: clicking a bottom-answer citation OPENS the collapsed block holding its source step (the group-reveal fix)", async () => {
    const w = await loadSidebarWorld();
    w.window.Element.prototype.scrollIntoView = function () {};       // jsdom has no scroll
    w.window.requestAnimationFrame = () => 0;                         // no-op: the block opens via the reveal EFFECT, not the scroll retry (and this avoids a post-teardown timer)
    await w.raw({ __mlSidebarSurface: "card" });                      // the HUD card surface
    // Turn 1: a computation (seq 1, token OUT). Turn 2 (a follow-up) cites that earlier output at the bottom —
    // so its SOURCE step lives in the PRIOR, collapsed block. This is the multi-task shape that segments into
    // collapsible blocks (the bug: the citation opened Show-work but not the collapsed GROUP).
    await w.dispatch(agentStart("blk", "compute the totals"));
    await w.dispatch(agentStep("blk", 1, { seq: 1, tool: "python_exec", token: OUT, result: "COMPUTED_TABLE", renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } }));
    await w.dispatch({ ...agentResult("blk", "The total is 42.", 1), answer: "" });
    await w.dispatch({ kind: "agent-say", id: "blk", ts: Date.now() + 50, save: false, session: { hash: "blk", turn: 1 }, text: "show me that table again" });
    await w.dispatch({ kind: "agent-step", id: "blk", ts: Date.now() + 60, save: false, session: { hash: "blk", turn: 2 }, step: 2, seq: 2, thought: "reusing the earlier result" });
    await w.dispatch({ ...agentResult("blk", "Here it is.", 2), answer: `![the table](@tool:${OUT}:out)` });
    await w.tick();
    // Open "Show work" → the run is multi-task, so it segments into blocks: the PRIOR one collapsed.
    w.shadow.querySelector(".card-work-toggle").click(); await w.tick();
    assert.ok(!w.shadow.querySelector('[data-astep-seq="1"]'), "the prior block is collapsed → the source step row isn't rendered yet");
    // Click the bottom Result citation (source = seq 1, in the collapsed prior block).
    const tok = w.shadow.querySelector(".card-result .tok-ref");
    assert.ok(tok, "the bottom Result citation is present in the card");
    tok.click(); await w.tick(); await w.tick(); await w.tick();
    assert.ok(w.shadow.querySelector('[data-astep-seq="1"]'), "clicking the citation force-opened the collapsed block → the source step is now shown");
});

test("answer render (sidebar): a cited exec output that returned ELEMENTS renders as an element list", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("els", "find the cards"));
    // exec that returned nodes → an `elements` renderOut (serialized path/text previews; live nodes can't cross the bus).
    await w.dispatch(agentStep("els", 1, { seq: 1, tool: "exec", token: OUT, result: "3 element(s)",
        renderOut: { type: "elements", items: [{ path: "div.card#a", text: "Card A" }, { path: "div.card#b", text: "Card B" }] } }));
    await w.dispatch({ ...agentResult("els", "Found 3 cards.", 1), answer: `![the cards](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb, "the Result block renders");
    assert.match(rb.textContent, /div\.card#a|Card A/, "the returned elements render as a list of previews");
});

test("answer render (sidebar): a result cited with `| latex` renders as a KaTeX equation — a REAL number", async () => {
    const w = await loadSidebarWorld();
    // python_exec evaluated an equation to a real number; the model cites it with the latex format so it
    // typesets as math, not plain text. `| latex` renders the step's RESULT (rawText) via KaTeX.
    await w.dispatch(agentStart("lxr", "evaluate the discriminant"));
    await w.dispatch(agentStep("lxr", 1, { seq: 1, tool: "python_exec", token: OUT, result: "5", renderOut: { type: "python-out", value: "5" } }));
    await w.dispatch({ ...agentResult("lxr", `Solving b^2-4ac gives ![discriminant](@tool:${OUT}:out | latex).`, 1), answer: "" });
    await openRun(w);
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply, "the answer renders with the citation");
    assert.ok(reply.querySelector(".katex"), "the `| latex` result typesets via KaTeX");
    assert.match(reply.textContent, /5/, "the computed value is present");
    // A latex citation is STILL a provenance ref: the KaTeX sits inside a clickable .tok-ref with a tooltip
    // that names the source step (clicking jumps to the compute step that produced the value).
    const tok = reply.querySelector(".tok-ref");
    assert.ok(tok && tok.querySelector(".katex"), "the typeset value is INSIDE the clickable citation");
    assert.match(tok.querySelector(".tok-tip")?.textContent || "", /step 1 · python_exec/, "the hover tooltip names the source compute step");
});

test("answer render (sidebar): a STANDALONE `| latex` citation → a green DISPLAY block; an INLINE one → inline", async () => {
    const latexStep = (hash) => w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "\\frac{1}{2}",
        renderOut: { type: "python-out", value: "\\frac{1}{2}" } }));
    // STANDALONE — the citation sits alone in its own paragraph (blank lines around it) → display block + outline.
    let w = await loadSidebarWorld();
    await w.dispatch(agentStart("lxd", "differentiate"));
    await latexStep("lxd");
    await w.dispatch({ ...agentResult("lxd", "The derivative is:\n\n![Derivative](@tool:" + OUT + ":out | latex)\n\nDone.", 1), answer: "" });
    await openRun(w);
    let tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-block"), "a standalone latex citation is a tok-block (green outline)");
    assert.ok(tok.querySelector(".katex-display"), "…in DISPLAY mode (centered, full-size)");
    assert.match(tok.querySelector(".tok-anno")?.textContent || "", /Derivative/, "the label shows as the block caption");

    // INLINE — the same citation written MID-SENTENCE → inline, no block outline, inline-mode KaTeX.
    w = await loadSidebarWorld();
    await w.dispatch(agentStart("lxi2", "differentiate"));
    await latexStep("lxi2");
    await w.dispatch({ ...agentResult("lxi2", "The derivative is ![d](@tool:" + OUT + ":out | latex) exactly.", 1), answer: "" });
    await openRun(w);
    tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok && !tok.classList.contains("tok-block"), "a mid-sentence latex citation stays inline (no block outline)");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "…inline-mode KaTeX, not display");
});

test("answer render (sidebar): `| raw` forces the literal value (no table/latex/image derivation)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rw", "compute"));
    // renderOut is a python-out df — WITHOUT | raw it'd render a table; | raw shows the literal value string.
    await w.dispatch(agentStep("rw", 1, { seq: 1, tool: "python_exec", token: OUT, result: "the-literal-value",
        renderOut: { type: "python-out", value: "the-literal-value" } }));
    await w.dispatch({ ...agentResult("rw", "Raw: ![v](@tool:" + OUT + ":out | raw)", 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    // Mid-sentence, short value → inline <code> (not a boxed block); still a literal (no table derivation).
    assert.ok(tok?.querySelector("code.tok-val") && !tok.querySelector("pre.code"), "| raw renders the value as inline literal code");
    assert.match(tok.textContent, /the-literal-value/, "the literal value is shown verbatim");
    assert.ok(!tok.querySelector(".katex"), "no latex typesetting for a | raw citation");
});

// Clicking a citation IMAGE must open the lightbox and NOT also fire the citation's jump-to-step (which
// scrolls the panel away — the DevTools "click the image and it scrolls to the python function" bug). The img
// stops propagation; the surrounding tok-ref padding still jumps. Parity across the sidebar/DevTools + HUD card.
async function imageCiteRun(w, hash) {
    w.window.HTMLElement.prototype.scrollIntoView = function () {};   // jsdom stub; make the jump path clean
    await w.dispatch(agentStart(hash, "draw a fractal"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "Returned an image.",
        renderOut: { type: "python-out", image: "data:image/png;base64,PIC" } }));
    await w.dispatch(agentResult(hash, "Here is the fractal:\n\n![Mandelbrot](@tool:" + OUT + ":out)", 1));
}
test("answer render (sidebar): clicking a citation IMAGE opens the lightbox and does NOT jump to the step", async () => {
    const posted = [];
    const w = await loadSidebarWorld();
    w.window.postMessage = (d) => posted.push(d);   // window.parent === window in jsdom → captures openLightbox
    await imageCiteRun(w, "imgc");
    await openRun(w);
    const img = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref img.zoomable");
    const step = w.shadow.querySelector('[data-astep-seq="1"]');
    assert.ok(img && step, "the citation renders a zoomable image and the source step row exists");
    img.click(); await w.tick();
    assert.ok(posted.some(d => d.__mlLightbox === "data:image/png;base64,PIC"), "the image click posts __mlLightbox (opens the lightbox)");
    assert.ok(!step.classList.contains("astep-pulse"), "the image click did NOT bubble to the citation jump (no scroll/pulse)");
    // Positive control: clicking the citation BACKGROUND (not the image) still jumps to the source step.
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    tok.click(); await w.tick();
    assert.ok(step.classList.contains("astep-pulse"), "clicking the citation background still jumps to the step");
});
test("answer render (HUD card): the SAME image click opens the lightbox without jumping — parity", async () => {
    const posted = [];
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await imageCiteRun(w, "imgc");
    const img = w.window.document.querySelector(".answer-rendered .tok-ref img.zoomable");
    assert.ok(img, "the HUD card renders the zoomable citation image");
    img.click(); await w.tick();
    assert.ok(posted.some(d => d.__mlLightbox === "data:image/png;base64,PIC"), "the HUD image click posts __mlLightbox too");
});

test("answer render (sidebar): a STANDALONE (own-line) `| raw` citation is a code BLOCK", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rwb", "compute"));
    await w.dispatch(agentStep("rwb", 1, { seq: 1, tool: "python_exec", token: OUT, result: "x^{2} e^{x}",
        renderOut: { type: "python-out", value: "x^{2} e^{x}" } }));
    // Alone on its own line → a boxed code block (contrast with the mid-sentence inline <code> above).
    await w.dispatch({ ...agentResult("rwb", "Raw:\n\n![v](@tool:" + OUT + ":out | raw)\n\ndone.", 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector("pre.code") && !tok.querySelector("code.tok-val"),
        "standalone | raw → a code BLOCK, not inline <code>");
});

test("answer render (sidebar): `| img` renders a base64 value as an image; an external URL stays non-image (beacon-safe)", async () => {
    const w = await loadSidebarWorld();
    const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await w.dispatch(agentStart("im", "make a chart"));
    await w.dispatch(agentStep("im", 1, { seq: 1, tool: "python_exec", token: OUT, result: B64,
        renderOut: { type: "python-out", value: B64 } }));
    await w.dispatch({ ...agentResult("im", "Chart: ![chart](@tool:" + OUT + ":out | img)", 1), answer: "" });
    await openRun(w);
    const img = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref img.zoomable");
    assert.ok(img, "| img renders the base64 value as an <img>");
    assert.match(img.getAttribute("src") || "", /^data:image\/png;base64,iVBOR/, "bare base64 is wrapped as a data: URL");

    // An external URL cited `| img` must NOT become an <img> (that would beacon the viewer) — it falls back.
    const w2 = await loadSidebarWorld();
    await w2.dispatch(agentStart("im2", "x"));
    await w2.dispatch(agentStep("im2", 1, { seq: 1, tool: "python_exec", token: OUT, result: "https://evil.example/x.png",
        renderOut: { type: "python-out", value: "https://evil.example/x.png" } }));
    await w2.dispatch({ ...agentResult("im2", "Look: ![x](@tool:" + OUT + ":out | img)", 1), answer: "" });
    await w2.dispatch({ __mlDebug: undefined });
    w2.shadow.querySelector(".row").click(); await w2.tick();
    const tok2 = w2.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok2 && !tok2.querySelector("img"), "an external URL is NOT rendered as an <img> (no beacon)");
});

test("answer render (sidebar): `| img` is HARDENED against abuse (external/js/html/svg/attr-breakout)", async () => {
    // `| img` renders a MODEL-controlled value, so it must never become a beacon or a script surface. Each
    // hostile value must render as text (no <img>, no <script>). dataImageFrom accepts only raster data:image
    // + clean base64.
    const citeImg = async (val) => {
        const w = await loadSidebarWorld();
        await w.dispatch(agentStart("adv", "x"));
        await w.dispatch(agentStep("adv", 1, { seq: 1, tool: "python_exec", token: OUT, result: val,
            renderOut: { type: "python-out", value: val } }));
        await w.dispatch({ ...agentResult("adv", "Look: ![x](@tool:" + OUT + ":out | img)", 1), answer: "" });
        w.shadow.querySelector(".row").click(); await w.tick();
        return w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    };
    const hostile = [
        "https://evil.example/beacon.png",                             // external URL → IP beacon
        "http://evil.example/x",                                       // external http
        "//evil.example/x.png",                                       // protocol-relative
        "javascript:alert(1)",                                        // js scheme
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", // data:text/html carrying a <script>
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",     // svg (onload) — rejected as a surface
        'data:image/png;base64,AAAA" onerror="alert(1)',              // attribute-breakout attempt
        "data:image/png;base64,AA<script>alert(1)</script>",          // markup in the "base64"
        "not base64 at all !!! $$$",                                  // junk
    ];
    for (const v of hostile) {
        const tok = await citeImg(v);
        assert.ok(tok, `citation still renders (as text) for: ${v.slice(0, 28)}`);
        assert.equal(tok.querySelector("img"), null, `NO <img> for hostile value: ${v.slice(0, 28)}`);
        assert.equal(tok.querySelector("script"), null, "never a <script> element");
    }
    // Positive control: a clean raster data URL DOES render as an image.
    const ok = await citeImg("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    assert.ok(ok.querySelector("img.zoomable"), "a clean data:image/png;base64 DOES render as an <img>");
});

test("answer render (sidebar): a `| latex` citation renders an IMAGINARY / complex result too", async () => {
    const w = await loadSidebarWorld();
    // sqrt(-9) → a complex root the python step computed; the model formats it for math (2 + 3i).
    await w.dispatch(agentStart("lxi", "solve x^2 + 9 = 0"));
    await w.dispatch(agentStep("lxi", 1, { seq: 1, tool: "python_exec", token: OUT, result: "2 + 3i", renderOut: { type: "python-out", value: "2 + 3i" } }));
    await w.dispatch({ ...agentResult("lxi", `The complex root is ![root](@tool:${OUT}:out | latex).`, 1), answer: "" });
    await openRun(w);
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply.querySelector(".katex"), "the complex result typesets via KaTeX (no throw on `i`)");
    assert.match(reply.textContent, /3/, "the imaginary component is present");
});

test("answer render (sidebar): a :out citation of a python SCALAR shows the CLEAN value, not the model-facing prelude", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pys", "compute the total"));
    // result carries the model-facing prelude; renderOut.value is the clean "6260" (the citation must use the latter).
    await w.dispatch(agentStep("pys", 1, { seq: 1, tool: "python_exec", token: OUT,
        result: "[loaded, reference directly] a 12×6 DataFrame → `df`.\n\n6260", renderOut: { type: "python-out", value: "6260" } }));
    await w.dispatch({ ...agentResult("pys", `The grand total is ![total](@tool:${OUT}:out).`, 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok, "the citation renders");
    assert.match(tok.textContent, /6260/, "the clean value shows");
    assert.doesNotMatch(tok.textContent, /loaded, reference directly/, "the model-facing prelude is NOT in the citation");
});

test("answer render (sidebar): LINK form `[label](@tool:…)` renders a clickable link, NOT an inline expansion", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lnk", "compute"));
    await w.dispatch(agentStep("lnk", 1, { seq: 1, tool: "python_exec", token: OUT, result: "COMPUTED_TABLE", renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } }));
    // LINK form (no `!`) → a jump-to-output link, not the expanded output.
    await w.dispatch({ ...agentResult("lnk", `See the [full table](@tool:${OUT}:out) for details.`, 1), answer: "" });
    await openRun(w);
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    const link = reply.querySelector(".tok-link");
    assert.ok(link, "renders a .tok-link (not an embed)");
    assert.match(link.textContent, /full table/, "the label is the link text");
    assert.doesNotMatch(reply.textContent, /COMPUTED_TABLE/, "the output is NOT expanded inline — a link references it, an embed shows it");
    assert.ok(!reply.querySelector(".tok-ref"), "no embed citation present");
});

test("answer render (sidebar): a sympy.latex() output cited `| latex` typesets via KaTeX (commands render; no prelude)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("sym", "solve x^2+2x+5=0 symbolically"));
    // What a real `python_exec` returning `sympy.latex(root)` looks like: the model-facing result carries the
    // prelude, but the descriptor `value` is the clean LaTeX string (with real commands: \frac, \sqrt).
    await w.dispatch(agentStep("sym", 1, { seq: 1, tool: "python_exec", token: OUT,
        result: "[loaded, reference directly] a DataFrame → `df`.\n\n- 1 + 2 i",
        renderOut: { type: "python-out", value: "- \\frac{1}{2} + \\frac{\\sqrt{19} i}{2}" } }));
    await w.dispatch({ ...agentResult("sym", `The root is ![root](@tool:${OUT}:out | latex).`, 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok, "the citation renders");
    assert.ok(tok.querySelector(".katex"), "the sympy.latex output (with \\frac/\\sqrt) typesets via KaTeX");
    assert.doesNotMatch(tok.textContent, /loaded, reference directly/, "the model-facing prelude is NOT fed to KaTeX");
});

// A follow-up turn's answer citing a tool it ran in an EARLIER turn — "show me how you computed this" → the
// prior python_exec. A tool-NAME alias (@tool:python_exec) means "that tool's LATEST call", so the LATEST
// answer must resolve it against the WHOLE run, not just its own (python_exec-less) turn. Regression: the
// DevTools panel scoped the latest answer per-turn → "(unresolved @tool:python_exec)", while the HUD (no
// scope on the final answer) resolved it — a surface parity break. Both surfaces must resolve it now.
const xTurnCitedRun = async (w, hash) => {
    await w.dispatch(agentStart(hash, "compute the totals"));
    await w.dispatch(compStep(hash));                                          // TURN 1: a tokened python_exec
    await w.dispatch({ ...agentResult(hash, "Grand total: 6260.", 1), ts: Date.now() + 1 });
    // FOLLOW-UP turn (a continuation — no sayId), whose answer cites the turn-1 python_exec BY NAME.
    await w.dispatch(agentSay(hash, "Can you show me how you computed this?", undefined, Date.now() + 2));
    await w.dispatch({ ...agentResult(hash,
        "Here's the exact code that ran:\n\n![computation code](@tool:python_exec:out)\n\nDone.", 2),
        ts: Date.now() + 3 });
};

test("DevTools panel: a follow-up answer's tool-NAME @tool alias resolves whole-run, not per-turn", async () => {
    const w = await loadSidebarWorld();
    await xTurnCitedRun(w, "xturn");
    await openRun(w);
    assert.equal(w.shadow.querySelector(".tok-unresolved"), null,
        "the latest answer's @tool:python_exec resolves (its own turn ran no python_exec — was 'unresolved')");
    assert.ok(w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref"),
        "the cross-turn citation renders as a resolved tool-output block in the panel");
});

test("HUD card: the SAME cross-turn tool-name citation resolves (parity with the DevTools panel)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    await xTurnCitedRun(w, "xturnC");
    await w.tick();
    assert.equal(w.shadow.querySelector(".tok-unresolved"), null,
        "the HUD resolves the same cross-turn tool-name citation");
    assert.ok(w.shadow.querySelector(".answer-rendered .tok-ref"),
        "the citation renders as a resolved block on the corner card");
});

// The HUD orb's live liveness readout (sidebar/orb-status.ts, wired into hud-card). STREAMING gets the rich
// detail (a ticking token count); NON-STREAMING can't know tokens mid-generation, so it degrades to the
// humanized phase + a stall heartbeat. Both must reach the rendered orb caption. (Pure-fn coverage lives in
// tests/orb-status.test.mjs; these prove the wiring renders.)
test("HUD orb (streaming): the thinking phase carries a LIVE token count in the orb caption", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("orbtok", "compute stats", "m", 20, streamConfig({ stream: true })));
    // A long reasoning stream (no reply content yet) → the calm thinking orb, decorated with a ticking count.
    await w.dispatch({ kind: "agent-stream", id: "orbtok", ts: Date.now(), save: false, session: { hash: "orbtok", turn: 1 }, step: 1, localStep: 1, reasoning: "z".repeat(4800) });
    await w.flush();
    const label = w.shadow.querySelector(".card-orb-label");
    assert.ok(label, "the streaming orb auto-expands to a caption (there's live detail to show)");
    assert.match(label.textContent, /~1\.2k tok/, "the live token count rides the thinking phase");
});

test("HUD orb (non-streaming): a STALLED run shows an elapsed heartbeat + phase, and NO token count", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("orbstall", "survey", "m", 20, streamConfig()));   // stream OFF
    // A pending tool whose last activity was 8s ago, with nothing streaming — the "did the glue break?" case.
    await w.dispatch({ ...agentStep("orbstall", 1, { seq: 1, pending: true, tool: "look", arguments: {} }), ts: Date.now() - 8000 });
    await w.flush();
    const label = w.shadow.querySelector(".card-orb-label");
    assert.ok(label, "the stalled orb auto-expands so the liveness readout is visible");
    assert.match(label.textContent, /Viewing the screen… · \d+s/, "the elapsed heartbeat proves the pipe is alive");
    assert.doesNotMatch(label.textContent, /tok/, "non-streaming has no live token count (can't know mid-generation)");
});

// The DevTools run-stats bar (RunStatsBar) — cumulative token SPEND + generation rate below the detail
// composer, each figure independently toggled (chrome.storage.local prefs), with a provenance tooltip. Usage
// rides the per-STEP emits (one per model call), so the bar sums across calls. Panel chrome only.
test("DevTools run-stats bar: cumulative in/out tokens summed across calls (default on)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rstat", "compute"));
    await w.dispatch(agentStep("rstat", 1, { seq: 1, tool: "python_exec", arguments: { code: "1" }, result: "1", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, genMs: 500 } }));
    await w.dispatch(agentStep("rstat", 2, { seq: 2, thought: "final", usage: { promptTokens: 140, completionTokens: 30, totalTokens: 170, genMs: 600 } }));
    await w.dispatch(agentResult("rstat", "done", 2));
    await openRun(w);
    const bar = w.shadow.querySelector(".run-stats");
    assert.ok(bar, "the run-stats bar renders");
    assert.match(bar.textContent, /240 in · 50 out/, "cumulative in/out summed across both calls");
    assert.doesNotMatch(bar.textContent, /tok\/s/, "tok/s is OFF by default");
});

test("DevTools run-stats bar: tok/s shows when enabled + a provenance tooltip records how it was measured", async () => {
    const w = await loadSidebarWorld({ local: { ml_debug_stats_tps: true } });   // enable the tok/s figure
    await w.dispatch(agentStart("rstat2", "compute"));
    // 60 completion tokens over 2s of Ollama eval time = 30 tok/s (generation-only basis).
    await w.dispatch(agentStep("rstat2", 1, { seq: 1, thought: "t", usage: { promptTokens: 100, completionTokens: 60, totalTokens: 160, evalMs: 2000 } }));
    await w.dispatch(agentResult("rstat2", "done", 1));
    await openRun(w);
    const bar = w.shadow.querySelector(".run-stats");
    assert.match(bar.textContent, /30\.0 tok\/s/, "60 tokens ÷ 2s eval = 30 tok/s");
    assert.match(bar.querySelector(".tt-pop").textContent, /Ollama generation time/, "the tooltip records the rate's provenance");
});

test("DevTools run-stats bar: renders nothing before any usage is reported", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rstat3", "compute"));
    await w.dispatch(agentStep("rstat3", 1, { seq: 1, pending: true, tool: "look", arguments: {} }));   // no usage yet
    await openRun(w);
    assert.equal(w.shadow.querySelector(".run-stats"), null, "no bar until the model reports token counts");
});

// Live tool output (ctx.stream): a stream delta patches the running step's Out ADDITIVELY (Jupyter-style),
// and the DONE (with a result) supersedes it. The delta carries no `tool`, so it must not rebuild the row.
test("live tool output (sidebar): a stream delta fills the running step's Out; the DONE supersedes it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("liveout", "run code"));
    await w.dispatch(agentStep("liveout", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "loop()" } }));
    await w.dispatch(agentStep("liveout", 1, { seq: 1, streamOutput: "tick 1\ntick 2\n" }));   // a delta — NO tool
    await openRun(w);
    assert.match(w.shadow.querySelector(".astep-preview").textContent, /tick/, "the live output shows in the collapsed step preview (not 'running…')");
    w.shadow.querySelector(".astep-head").click(); await w.tick();
    const live = w.shadow.querySelector(".astep-streaming");
    assert.ok(live, "the live output renders in the Out block while the step runs");
    assert.match(live.textContent, /tick 1[\s\S]*tick 2/, "the streamed console output fills in");
    // A late delta keeps the pending row intact (tool/args preserved — the additive patch).
    assert.match(w.shadow.querySelector(".astep-head").textContent, /exec/, "the tool identity survived the additive delta");
    // DONE: the real result supersedes the live block.
    await w.dispatch(agentStep("liveout", 1, { seq: 1, tool: "exec", arguments: { js: "loop()" }, result: "console:\ntick 1\ntick 2\n\nvalue: 2" }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".astep-streaming"), null, "the live block clears once the result lands");
});

// The shared tool OUTPUT CELL: python_exec and exec BOTH render their Out into it, so it caps + scrolls +
// offers a resize grip identically — and any future code-ish tool (a bash_exec, say) inherits that by
// wrapping its own sections in the same component. Also pins the per-tool section labels (stdout vs console).
test("tool output cell: python_exec AND exec both render into the shared capped/scrollable cell", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("outcell", "run both"));
    await w.dispatch(agentStep("outcell", 1, {
        seq: 1, tool: "python_exec", arguments: { code: "print(1)" }, result: "stdout:\n1\n",
        renderOut: { type: "python-out", stdout: "1", value: "None" },
    }));
    await w.dispatch(agentStep("outcell", 2, {
        seq: 2, tool: "exec", arguments: { js: "console.log('a'); 7" }, result: "console:\na\n\nvalue: 7",
        renderOut: { type: "exec-out", stdout: "a", value: "7" },
    }));
    // A tool with NO renderer at all — its plain Out (a fetch_url page, a sampleText dump) must reuse the
    // SAME cell, which is the whole point of putting it on the generic path.
    await w.dispatch(agentStep("outcell", 3, { seq: 3, tool: "fetch_url", arguments: { url: "http://x/" }, result: "Fetched http://x/ — HTTP 200.\n\nsome page text" }));
    await w.dispatch(agentResult("outcell", "done", 3));
    await openRun(w);
    for (const head of [...w.shadow.querySelectorAll(".astep.tool .astep-head")]) { head.click(); await w.tick(); }
    // Each code tool's OUT renders its captured output through the shared cell…
    const outCells = w.shadow.querySelectorAll(".r-py-out .r-outcell");
    assert.equal(outCells.length, 2, "BOTH tools' Out use the shared cell (not one bespoke each)");
    // …and the SAME component wraps a descriptor-less tool's plain OUT, so a big fetch_url page is
    // scrollable + findable too. (The IN block is the call — short, already a code block — so it gets no cell.)
    assert.equal(w.shadow.querySelectorAll(".r-outcell").length, outCells.length + 1,
        "the descriptor-less tool's Out reuses the same cell — and nothing wraps the In");
    for (const cell of outCells) {
        const scroll = cell.querySelector(".r-outscroll");
        assert.ok(scroll, "the cell scrolls its overflow");
        assert.match(scroll.getAttribute("style") || "", /max-height:\s*260px/, "capped at the configured height");
    }
    const labels = [...w.shadow.querySelectorAll(".r-py-lbl")].map(e => e.textContent);
    assert.ok(labels.includes("stdout"), "python's captured output is labelled stdout");
    assert.ok(labels.includes("console"), "exec's is labelled console (it captured console.log, not a stdout stream)");
});

// The captured-but-unseen tail: output past `seen` was clipped out of the model-facing result, so it renders
// MARKED (dimmed, under an explicit label) instead of silently reading as "what the model saw".
test("tool output: the part the model never received renders marked, not as plain output", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("unseen", "run it"));
    await w.dispatch(agentStep("unseen", 1, {
        seq: 1, tool: "exec", arguments: { js: "…" }, result: "console:\nSEEN… [+4 chars truncated]",
        renderOut: { type: "exec-out", stdout: "SEENUNSEEN", seen: 4, value: "1" },
    }));
    await w.dispatch(agentResult("unseen", "done", 1));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const marked = w.shadow.querySelector(".r-unseen");
    assert.ok(marked, "the surplus renders in its own marked block");
    assert.match(marked.textContent, /UNSEEN/, "…and it holds the text past the model's cut");
    assert.doesNotMatch(marked.textContent, /^SEEN[^U]/, "the part the model DID read stays in the normal block");
    assert.match(w.shadow.querySelector(".r-unseen-lbl").textContent, /NOT sent to the model/i, "labelled explicitly");
});

// While a step is STILL RUNNING we already know where the model's cut will fall, so the doomed tail is greyed
// as it streams (with a "?" explainer) rather than springing the truncation on you at the end. The boundary
// comes from the call's own args, so a model-requested (approved) larger cap is respected live.
test("live output: the doomed tail is marked AS IT STREAMS, at the call's own raised cap", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("livecut", "run it"));
    await w.dispatch(agentStep("livecut", 1, { seq: 1, pending: true, tool: "exec",
        arguments: { js: "loop()", maxChars: 600, maxCharsReason: "need the whole dump" } }));
    await w.dispatch(agentStep("livecut", 1, { seq: 1, streamOutput: "A".repeat(700) }));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const lbl = w.shadow.querySelector(".r-unseen-lbl.live");
    assert.ok(lbl, "the streaming view marks where the model's cut will fall");
    assert.match(lbl.textContent, /cutoff/i, "…labelled as the model's cutoff, not a past-tense 'was clipped'");
    assert.match(lbl.getAttribute("title") || "", /NOT be part of the result sent to the model/i, "with a hover explainer");
    const tail = w.shadow.querySelector(".r-unseen");
    assert.ok(tail && tail.textContent.trim().length >= 100, "exactly the text past the RAISED 600-char cap is marked");
});

// The executor's per-line timestamps must SURVIVE the step settling: the finished Out renders the same
// captured text the stream produced, so the gutter shouldn't vanish the moment the tool returns.
test("streamed timestamps survive the DONE and time the settled output", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tsdone", "run it"));
    await w.dispatch(agentStep("tsdone", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "…" } }));
    await w.dispatch(agentStep("tsdone", 1, { seq: 1, streamOutput: "one\ntwo\n", streamMarks: [[0, 1731000000000], [4, 1731000002000]] }));
    // The DONE carries the real result + render, and NO marks — they must be kept, not wiped.
    await w.dispatch(agentStep("tsdone", 1, { seq: 1, tool: "exec", arguments: { js: "…" }, result: "console:\none\ntwo\n\nvalue: 1",
        renderOut: { type: "exec-out", stdout: "one\ntwo\n", value: "1" } }));
    await w.dispatch(agentResult("tsdone", "done", 1));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const stamps = [...w.shadow.querySelectorAll(".r-ts")].map(e => e.textContent).filter(Boolean);
    assert.ok(stamps.length >= 2, "the settled output still shows the executor's timestamps");
    assert.notEqual(stamps[0], stamps[1], "and a later line shows its own (changed) time");
    assert.match(w.shadow.querySelector(".r-ts[title]").getAttribute("title"), /\d\d:\d\d:\d\d\.\d\d\d/, "hover carries millisecond precision");
});

// Settings copy must stay attached to the control it describes: inserting a new toggle between a select and
// its explanatory note orphans the note under the wrong control (which is exactly what happened once).
test("settings (Appearance): each explanatory note stays under its own control", async () => {
    const w = await loadSidebarWorld();
    await openSettings(w, "Appearance");
    const texts = [...w.shadow.querySelectorAll(".set-field > span, .set-check span, .set-note")].map(e => e.textContent || "");
    const at = (re) => texts.findIndex(t => re.test(t));
    const heightCtl = at(/Tool output height/);
    const heightNote = at(/How tall ANY tool/);
    const stampsCtl = at(/Timestamp streamed output lines/);
    const stampsNote = at(/gutter beside it/);
    assert.ok(heightCtl >= 0 && heightNote >= 0 && stampsCtl >= 0 && stampsNote >= 0, "all four are rendered");
    assert.ok(heightCtl < heightNote, "the height note follows the height control");
    assert.ok(heightNote < stampsCtl, "…and comes BEFORE the next control (not orphaned under it)");
    assert.ok(stampsCtl < stampsNote, "the timestamp note follows the timestamp toggle");
});

// The rendered/raw toggle only exists once a descriptor lands (i.e. when the step settles), so it used to
// APPEAR on completion and push the whole block down. It's now reserved — present but inert — while output
// is still streaming, so the settled layout matches the live one.
test("rendered/raw toggle: reserved (disabled) while streaming, live once the step settles", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rrtog", "run it"));
    await w.dispatch(agentStep("rrtog", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "loop()" } }));
    await w.dispatch(agentStep("rrtog", 1, { seq: 1, streamOutput: "line 1\n" }));
    await openRun(w);
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const outToggle = () => [...w.shadow.querySelectorAll(".io")].find(io => /^Out/.test(io.querySelector(".io-label").textContent))?.querySelector(".rr-toggle");
    const live = outToggle();
    assert.ok(live, "the toggle's space is held while output streams");
    assert.match(live.className, /reserved/);
    assert.ok([...live.querySelectorAll("button")].every(b => b.disabled), "…but neither button is usable yet");
    // The DONE brings the descriptor → the same row becomes usable, no new row appearing.
    await w.dispatch(agentStep("rrtog", 1, { seq: 1, tool: "exec", arguments: { js: "loop()" }, result: "console:\nline 1\n\nvalue: 1",
        renderOut: { type: "exec-out", stdout: "line 1\n", value: "1" } }));
    await w.tick();
    const settled = outToggle();
    assert.ok(settled, "the toggle is still there");
    assert.doesNotMatch(settled.className, /reserved/);
    assert.ok([...settled.querySelectorAll("button")].every(b => !b.disabled), "both buttons work once it settles");
});

// NON-streaming runs must keep working exactly as before: no live output, the step just says "running…" and
// then shows the full result when it lands. (Streaming is opt-in; this is the path most runs take.)
test("non-streaming run: the step waits with 'running…' and then shows the full result", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nostream", "run it"));
    await w.dispatch(agentStep("nostream", 1, { seq: 1, pending: true, tool: "exec", arguments: { js: "work()" } }));
    await openRun(w);
    // Collapsed preview says running…; no live block, and no reserved toggle (nothing is streaming).
    assert.match(w.shadow.querySelector(".astep-preview").textContent, /running…/);
    assert.equal(w.shadow.querySelector(".astep-streaming"), null, "no live output block without streaming");
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    assert.equal(w.shadow.querySelector(".rr-toggle.reserved"), null, "nothing reserved — no descriptor is pending");
    const outBlock = () => [...w.shadow.querySelectorAll(".io")].find(io => /^Out/.test(io.querySelector(".io-label").textContent));
    assert.match(outBlock().textContent, /running…/, "the Out waits");
    // The DONE brings everything at once.
    await w.dispatch(agentStep("nostream", 1, { seq: 1, tool: "exec", arguments: { js: "work()" }, result: "console:\nall of it\n\nvalue: 42",
        renderOut: { type: "exec-out", stdout: "all of it", value: "42" } }));
    await w.dispatch(agentResult("nostream", "done", 1));
    await w.tick();
    const out = outBlock();
    assert.match(out.textContent, /all of it/, "the full captured output appears on completion");
    assert.match(out.textContent, /42/, "…and the returned value");
    assert.equal(w.shadow.querySelector(".r-ts"), null, "no timestamp gutter — nothing streamed, so there are no marks");
});

// The resource tracks: a real ceiling, per-model stacking, and gaps left as gaps. The arithmetic is unit
// tested in resource-model.test.mjs; these cover what only the rendering does.
// The stacked per-pool view. The DEFAULT is now Overview (one compact overlaid track), so a test about
// per-model BANDS must choose the view that has them — seeded through storage, which also exercises restore.
const STACKED_LAYOUT = { local: { ml_res_layout: { presetId: "memory", tracks: [
    { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 },
    { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 96 },
    { id: "ram", series: ["ram"], mode: "stack", heightPx: 96 },
] } } };
const INFO_2CARD = { compute: {
    system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12330946560 },
    supported_gpus: [
        { gpu_id: "0", name: "CUDA0", total_memory: 101972967424, physical_memory: 102641958912, free_memory: 80 * 1024 ** 3, runner: "CUDA" },
        { gpu_id: "1", name: "CUDA1", total_memory: 101972967424, physical_memory: 102641958912, free_memory: 94 * 1024 ** 3, runner: "CUDA" },
    ],
} };

test("resource tracks: one per card plus host RAM, each against a real ceiling", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 14, vramBytes: 14 * 1024 ** 3, sizeBytes: 14 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 14 * 1024 ** 3 }], contextLength: 262144, expiresAt: null }],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    const names = [...w.shadow.querySelectorAll(".rc-name")].map((n) => n.textContent);
    assert.deepEqual(names, ["CUDA0", "CUDA1", "System RAM"], "small multiples — a model uses ONE card's capacity");
    assert.equal(w.shadow.querySelectorAll(".rc-track").length, 3, "one track each, never a shared axis");
    // The figure lives alongside a tooltip inside .rc-total, so match the pair rather than the whole node.
    const totals = [...w.shadow.querySelectorAll(".rc-total")].map((n) => n.textContent);
    // The DISPLAY ceiling is the driver framebuffer total (95.59 GiB), not ollama's 94.97 — it must agree
    // with what nvidia-smi shows the user everywhere else.
    // The numerator is what is IN USE on the card — the 14 GiB model plus ~1 GiB of driver context — because
    // that is the figure that reconciles with free. The legend breaks it into model vs overhead.
    assert.match(totals[0], /14\.97 GiB \/ 95\.59 GiB/, "in use on card 0, against the DRIVER total");
    assert.match(totals[1], /993\.0 MiB \/ 95\.59 GiB/, "the IDLE card shows only its driver context");
    assert.match(totals[2], /GiB \/ 121\.2 GiB/, "and system RAM against its own total");
    const figures = totals.join(" ").match(/[\d.]+ [KMGT]?i?B/g) || [];
    assert.ok(figures.every((f) => /( B|iB)$/.test(f)), `binary units only, saw ${figures.join()}`);
});

test("resource tracks: the residual is named driver overhead on an idle card, not a phantom process", async () => {
    const w = await loadSidebarWorld({ vram: [], info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    // CUDA1 is the genuinely idle card in the fixture (94 of 94.97 GiB free → ~1 GiB residual). CUDA0 has
    // 80 GiB free with nothing of ours on it, so ITS 14.97 GiB really is unattributed — correctly so, which
    // is the other half of this behaviour.
    const cardLegend = w.shadow.querySelectorAll(".rc-track")[1].querySelector(".rc-legend").textContent;
    const busyLegend = w.shadow.querySelectorAll(".rc-track")[0].querySelector(".rc-legend").textContent;
    assert.match(busyLegend, /unattributed/, "a card holding 15 GiB nobody claims IS unattributed");
    assert.match(cardLegend, /driver overhead/,
        "an idle card's residual is ollama's own discovery context, not a phantom third party");
    assert.ok(!/unattributed/.test(cardLegend), "…it never escalates past the floor on an idle card");
    assert.match(cardLegend, /free/, "free capacity is always named");
    // The host pool, by contrast, really does have other processes in it.
    const hostLegend = [...w.shadow.querySelectorAll(".rc-track")].at(-1).querySelector(".rc-legend").textContent;
    assert.match(hostLegend, /unattributed/, "the OS's own RAM use clears the floor and is named as such");
});

test("resource tracks: no /api/info means NO ceiling — it falls back, never invents one", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: null,   // stock Ollama / no passthrough → capacity unknown
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.equal(w.shadow.querySelectorAll(".rc-track").length, 0, "no capacity → no tracks");
    assert.ok(w.shadow.querySelector(".vram-spark"), "…it degrades to the auto-scaled sparkline");
    assert.match(w.shadow.querySelector(".vram-total").textContent, /8\.00 GiB in use/, "the total still renders");
});

// Hovering a coloured band names the model it belongs to — the SAME facts the legend row carries, because a
// band and its row describe one model. One component in two placements, so a future badge lands in both.
test("resource tracks: hovering a band names its model, with the row's own facts", async () => {
    const w = await loadSidebarWorld({
        vram: [
            { model: "gemma4:31b", vramGB: 18, vramBytes: 18 * 1024 ** 3, sizeBytes: 18 * 1024 ** 3,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 18 * 1024 ** 3 }], contextLength: 262144,
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
        ],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    assert.equal(w.shadow.querySelectorAll(".rc-tip").length, 0, "no tooltip until something is hovered");
    const band = w.shadow.querySelector(".rc-band");
    assert.ok(band, "a model's band is hoverable");
    band.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();

    const tip = w.shadow.querySelector(".rc-tip");
    assert.ok(tip, "hovering names the model");
    assert.match(tip.textContent, /gemma4:31b/);
    assert.match(tip.textContent, /18\.00 GiB/, "how much it holds ON THIS card, in binary units");
    assert.match(tip.textContent, /256K/, "the context window — the same fact the row shows");
    assert.match(tip.textContent, /\dm ?\d*s?/, "and the keep-alive TTL");
    // The row lights up too: a band and its row are the same model, so hovering either marks both.
    assert.ok(w.shadow.querySelector(".vram-row.hot"), "the legend row highlights with the band");

    band.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".rc-tip").length, 0, "and it clears on leave");
});

// Tooltip anchoring is a real trap here: `.tt-pop.left` means LEFT-anchored (extends rightward), for triggers
// at the panel's LEFT edge. The track header's figure is right-aligned, so a left-anchored pop runs off the
// panel and is clipped — which is exactly what shipped once.
test("resource tracks: the header tooltip is right-anchored so it can't run off the panel", async () => {
    const w = await loadSidebarWorld({ vram: [], info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    const pop = w.shadow.querySelector(".rc-total .tt-pop");
    assert.ok(pop, "the denominator explains which of the three totals it is");
    assert.ok(!pop.classList.contains("left"),
        "right-aligned trigger → right-anchored pop (extends leftward), or it clips at the panel edge");
    assert.ok(pop.classList.contains("wrap"), "and it wraps — the explanation is prose, not a label");
    // The legend keys sit at the LEFT edge, so those are correctly left-anchored.
    const keyPop = w.shadow.querySelector(".rc-key .tt-pop");
    assert.ok(keyPop.classList.contains("left"), "left-edge trigger → left-anchored pop");
});

test("resource tracks: the hovered band outlines itself, and single-sample runs aren't drawn", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 18, vramBytes: 18 * 1024 ** 3, sizeBytes: 18 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 18 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    // A run of one sample has no shape to draw, and reserving a 2px column for it leaves a pale sliver where
    // the band wash is missing — the "ghost corner". Undrawable runs are skipped entirely.
    const segs = [...w.shadow.querySelectorAll(".rc-seg")];
    assert.ok(segs.every((sg) => sg.querySelectorAll("polygon, polyline").length > 0),
        "every drawn segment actually contains a shape");

    const band = w.shadow.querySelector(".rc-band");
    if (!band) return;   // needs ≥2 samples to have drawn anything yet
    assert.ok(!band.classList.contains("hot"), "nothing is marked until hovered");
    band.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".rc-band.hot"), "the hovered band marks ITSELF, not just its neighbours");
});

test("streamed output: a rule separates the timestamp gutter from the text", async () => {
    // The stamps are right-aligned in a fixed column; without an edge, leading whitespace in the output has
    // nothing to be measured against. Same device as a line-number gutter's rule.
    const css = await import("node:fs").then((fs) => fs.readFileSync("sidebar/sidebar.css", "utf8"));
    // The standalone `.r-ts` rule — not `.r-timed.short .r-ts`, which merely narrows the column.
    const rule = /\n\.r-ts \{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.ok(rule, "the gutter rule exists");
    assert.match(rule, /border-right:\s*1px solid var\(--border\)/, "a hairline between stamps and output");
    assert.match(rule, /padding-right/, "spaced by padding so the rule sits inside the row gap");
});

// Mixed-size GPUs are normal (a 4090 beside a 3060), so an overlay must not assume one shared denominator.
/** A class that dims must have a RULE behind it. Asserting only the class name let both cross-highlight
 *  directions ship with no styling at all — every test green, nothing visibly dimmed. */
function assertDims(selector) {
    const css = require("node:fs").readFileSync("sidebar/sidebar.css", "utf8");
    const at = css.indexOf(selector + " {");
    assert.ok(at !== -1, `no CSS rule for ${selector} — the class would dim nothing`);
    const body = css.slice(at, css.indexOf("}", at));
    assert.match(body, /opacity:\s*0?\.\d/, `${selector} must actually reduce opacity`);
}

const INFO_MIXED = { compute: {
    system_compute: { cpu_cores: 16, total_memory: 68719476736, free_memory: 30 * 1024 ** 3 },
    supported_gpus: [
        { gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 25757220864, free_memory: 5 * 1024 ** 3 },   // 24 GiB
        { gpu_id: "1", name: "CUDA1", runner: "CUDA", total_memory: 12884901888, free_memory: 11 * 1024 ** 3 },  // 12 GiB
    ],
} };

test("overview: pools of DIFFERENT sizes are compared as a share of each, not on one denominator", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    // Default is Overview: ONE track, every pool overlaid — including the host, so a CPU-resident model can
    // never vanish from the chart.
    assert.equal(w.shadow.querySelectorAll(".rc-track").length, 1, "one compact track");
    const keys = [...w.shadow.querySelectorAll(".rc-key")].map((n) => n.textContent);
    assert.equal(keys.length, 3, `both cards and the host pool — got ${keys.join(" | ")}`);
    assert.match(keys.join(" "), /System RAM/, "the host pool is in the overview");
    // Read as a SHARE of each pool: with unequal capacities an absolute height would mean different things
    // per line. The header must not claim a single denominator ("of X each").
    const head = w.shadow.querySelector(".rc-total").textContent;
    assert.match(head, /% of each pool/);
    assert.ok(!/each$/.test(head.split("Each")[0].trim()), "never a single shared capacity for unequal cards");
    assert.match(keys[0], /%/, "each key shows its own occupancy as a percentage");
});

test("model row: hovering shows WHERE it sits, and flags a split", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 25 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 12 * 1024 ** 3 },
                        { id: "1", runner: "CUDA", vramBytes: 7 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    row.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: 200 }));
    await w.flush();

    const tip = w.shadow.querySelector(".vram-rowtip");
    assert.ok(tip, "the row names itself on hover");
    // The placement a single total cannot show: two cards AND a RAM spill.
    assert.match(tip.textContent, /CUDA0 12\.00 GiB/);
    assert.match(tip.textContent, /CUDA1 7\.00 GiB/);
    assert.match(tip.textContent, /RAM 6\.00 GiB/, "the partial offload — why a 'GPU' model can still be slow");
    assert.match(tip.textContent, /split/, "and it is flagged as split, not just listed");
    assert.ok(w.shadow.querySelector(".vram-rowtip-split"), "the split line is marked");

    row.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".vram-rowtip").length, 0, "and clears on leave");
});

// Hovering a pool must never move the layout: a panel that shifts under the cursor reads as broken, and the
// shift can pull the thing you were pointing at out from under the pointer. So no row is injected at all —
// the model rows below ARE the legend, and the ones not on that pool grey out.
test("overview: hovering a line greys the models that aren't on it, and injects no row", async () => {
    const w = await loadSidebarWorld({
        vram: [
            { model: "onzero", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null },
            { model: "onone", vramGB: 8, vramBytes: 8 * 1024 ** 3, sizeBytes: 8 * 1024 ** 3,
              gpus: [{ id: "1", runner: "CUDA", vramBytes: 8 * 1024 ** 3 }], expiresAt: null },
        ],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const rowsBefore = w.shadow.querySelectorAll(".vram-row").length;
    assert.equal(w.shadow.querySelectorAll(".vram-row.away").length, 0, "nothing dimmed until a pool is hovered");

    // Hover CUDA0's key: the model on CUDA1 greys out, the one on CUDA0 does not.
    const key = w.shadow.querySelector(".rc-key");
    key.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();

    assert.equal(w.shadow.querySelectorAll(".vram-row").length, rowsBefore, "no row is added — nothing shifts");
    const away = [...w.shadow.querySelectorAll(".vram-row.away")].map((r) => r.querySelector(".vram-name").textContent);
    assert.deepEqual(away, ["onone"], "only the model that is NOT on this pool greys out");
    // …and the class must actually DIM. A class with no rule behind it passed every test while doing nothing
    // visible — which is exactly how this shipped broken.
    assertDims(".vram-row.away");

    key.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".vram-row.away").length, 0, "and it clears on leave");
});

// The reverse of dimming rows: hovering a MODEL row dims the pools it is NOT resident on, so the chart points
// back at the row as directly as the rows point at the chart.
test("overview: hovering a model row dims the pools it isn't on", async () => {
    const w = await loadSidebarWorld({
        vram: [
            { model: "onzero", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null },
            { model: "onone", vramGB: 8, vramBytes: 8 * 1024 ** 3, sizeBytes: 8 * 1024 ** 3,
              gpus: [{ id: "1", runner: "CUDA", vramBytes: 8 * 1024 ** 3 }], expiresAt: null },
        ],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    assert.equal(w.shadow.querySelectorAll(".rc-key.away").length, 0, "no pool dimmed until a row is hovered");
    const row = [...w.shadow.querySelectorAll(".vram-row")].find((r) => r.textContent.includes("onone"));
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();

    const lit = [...w.shadow.querySelectorAll(".rc-key")].filter((k) => !k.classList.contains("away"))
        .map((k) => k.textContent.replace(/\s+/g, " ").trim());
    assert.equal(lit.length, 1, `only the pool holding it stays lit — got ${lit.join(" | ")}`);
    assert.match(lit[0], /CUDA1/, "the card this model is actually resident on");
    assertDims(".rc-key.away");

    row.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".rc-key.away").length, 0, "and it clears on leave");
});

test("the resource chart window is configurable, and short by default", async () => {
    const { RESWIN_DEFAULT } = await import("../sidebar/store.ts");
    assert.equal(RESWIN_DEFAULT, 300, "5 minutes — 30 squeezed into a narrow panel is an unreadable smear");
    // The knob belongs in DevTools Settings (the superset), per the AGENTS rule for user-editable config.
    const settings = await import("node:fs").then((fs) => fs.readFileSync("sidebar/settings.tsx", "utf8"));
    assert.match(settings, /Resource chart window/, "surfaced in Settings → Appearance");
    assert.match(settings, /RESWIN_KEY/, "and persisted");
    assert.match(settings, /Samples are kept for the whole session either way/,
        "the note distinguishes what is DRAWN from what is retained");
});

// A saved PRESET is re-derived, not replayed: storing its tracks pins the preset as it was the day it was
// picked. Overview later gained the host pool, and a layout saved before that kept drawing a cards-only chart
// with a CPU-resident model missing from it entirely.
test("layout: a saved preset picks up later improvements; only Custom is restored verbatim", async () => {
    const stale = { ml_res_layout: { presetId: "overview", tracks: [
        { id: "overview", series: ["vram.0", "vram.1"], mode: "overlay", heightPx: 96 },   // pre-host-pool
    ] } };
    const w = await loadSidebarWorld({ vram: [], info: INFO_MIXED, local: stale });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    const keys = [...w.shadow.querySelectorAll(".rc-key")].map((n) => n.textContent);
    assert.equal(keys.length, 3, `the CURRENT overview, including the host pool — got ${keys.join(" | ")}`);
    assert.match(keys.join(" "), /System RAM/, "the improvement lands rather than being pinned out");

    // A CUSTOM layout is a literal record of choices, so it IS restored as saved.
    const custom = { ml_res_layout: { presetId: "custom", tracks: [
        { id: "just-one", series: ["vram.1"], mode: "stack", heightPx: 96 },
    ] } };
    const w2 = await loadSidebarWorld({ vram: [], info: INFO_MIXED, local: custom });
    await w2.raw({ __mlSidebarOpen: true });
    w2.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w2.flush();
    await w2.flush();
    assert.deepEqual([...w2.shadow.querySelectorAll(".rc-name")].map((n) => n.textContent), ["CUDA1"],
        "a custom layout is kept exactly as chosen");
});

test("overview: the line tooltip gives size, usage and the consumers", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "onzero", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const key = w.shadow.querySelector(".rc-key");
    key.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    // The tip follows the cursor, so it needs a position before it renders.
    w.shadow.querySelector(".rc-plot").dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true }));
    await w.flush();

    const tip = w.shadow.querySelector(".rc-tip-pool");
    assert.ok(tip, "hovering a pool's line opens the tip");
    assert.match(tip.textContent, /CUDA0/, "which device");
    assert.match(tip.textContent, /of 23\.99 GiB/, "how big the pool is");
    assert.match(tip.textContent, /19\.00 GiB|20\.00 GiB/, "how much of it is consumed");
    assert.match(tip.textContent, /onzero/, "and BY WHAT — the consumers, named again in the tip");
});

// Opening the panel used to flash the OLD sparkline before the tracks replaced it: `capacity: null` could not
// distinguish "the fetch hasn't come back" from "this server has no /api/info", and the fallback for the
// second is that legacy chart.
test("panel open: holds an empty plot until capacity answers, never flashes the old chart", async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_2CARD,
        holdInfo: held,   // the harness waits on this before answering OLLAMA_INFO
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();

    // Capacity has not answered yet.
    assert.equal(w.shadow.querySelectorAll(".vram-spark").length, 0,
        "the legacy sparkline must NOT appear while we are still waiting");
    assert.equal(w.shadow.querySelectorAll(".rc-plot").length, 1, "an empty plot holds the space instead");

    release();
    await w.flush();
    await w.flush();
    assert.ok(w.shadow.querySelectorAll(".rc-key").length > 0, "…and the real tracks replace it once it lands");
    assert.equal(w.shadow.querySelectorAll(".vram-spark").length, 0, "still no legacy chart");
});

// The editor's stack/overlay control must DO something on the layouts the presets actually produce — a track
// per pool, i.e. one series each. It was short-circuiting to the stacked view below two series, so the
// dropdown was inert exactly where it is most used.
test("editor: stack vs overlay changes the rendering even for a single-series track", async () => {
    const one = (mode) => ({ local: { ml_res_layout: { presetId: "custom", tracks: [
        { id: "t", series: ["vram.0"], mode, heightPx: 96 },
    ] } } });
    const mk = async (mode) => {
        const w = await loadSidebarWorld({
            vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                     gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
            info: INFO_MIXED, ...one(mode),
        });
        await w.raw({ __mlSidebarOpen: true });
        w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
        await w.flush();
        await w.flush();
        return w;
    };

    const stacked = await mk("stack");
    assert.ok(stacked.shadow.querySelectorAll("polygon").length > 0, "stack draws per-model BANDS");
    assert.match(stacked.shadow.querySelector(".rc-legend").textContent, /free/, "with the pool's breakdown");

    const overlaid = await mk("overlay");
    assert.equal(overlaid.shadow.querySelectorAll("polygon").length, 0, "overlay draws no bands…");
    assert.ok(overlaid.shadow.querySelectorAll("polyline").length > 0, "…it draws a LINE of the pool's occupancy");
    assert.match(overlaid.shadow.querySelector(".rc-total").textContent, /% of each pool/,
        "and reads as a share, like any overlay");
});

// A cursor-following tip must never sit UNDER the cursor. Clamping `top` to the plot's edge did exactly that
// near the top of the chart: the tip landed on the pointer and covered the line it was describing.
test("chart tips: flip BELOW the cursor near the top edge instead of clamping onto it", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const plot = w.shadow.querySelector(".rc-plot");
    const key = w.shadow.querySelector(".rc-key");
    const tipTop = async (y) => {
        key.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
        const ev = new w.window.PointerEvent("pointermove", { bubbles: true });
        Object.defineProperty(ev, "offsetY", { value: y });
        Object.defineProperty(ev, "offsetX", { value: 40 });
        plot.dispatchEvent(ev);
        await w.flush();
        return parseFloat(w.shadow.querySelector(".rc-tip").style.top);
    };

    // Room above → the tip sits above the cursor.
    const low = await tipTop(60);
    assert.ok(low < 60, `above the cursor when there is room (top ${low} < 60)`);
    // No room above → it goes BELOW, never onto the pointer.
    const high = await tipTop(4);
    assert.ok(high > 4, `below the cursor near the top edge (top ${high} > 4), not clamped onto it`);

    // The model ROW's tip is the third of these and had NO snapping at all — it ran off the window's right
    // edge. It carries .rc-tip now, so it shares both the look and the positioning.
    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    const ev = new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 5000, clientY: 300 });
    row.dispatchEvent(ev);
    await w.flush();
    const rowTip = w.shadow.querySelector(".vram-rowtip");
    assert.ok(rowTip.classList.contains("rc-tip"), "shares the one tooltip look, so sizes match across the panel");
    assert.equal(rowTip.style.left, "auto", "far right → it opens LEFTWARD instead of off-screen");
    assert.ok(parseFloat(rowTip.style.right) >= 2);
});

// Two tooltips for one pointer is never right: the badge has its own, so the row's follower steps aside.
test("model row: a badge's own tooltip suppresses the follow-along tip", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }],
                 contextLength: 262144, expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    row.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: 200 }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".vram-rowtip"), "the row tip follows the cursor across the row");

    // Onto the context badge, which carries its own .tt-pop.
    const badge = w.shadow.querySelector(".vram-ctx");
    assert.ok(badge.classList.contains("tt"), "the badge really does have its own tooltip");
    badge.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".vram-rowtip").length, 0, "the follower yields to the specific one");

    // Back onto the row proper and it returns.
    // pointerleave does NOT bubble in a browser — dispatching it with bubbles:true would also fire the ROW's
    // leave and clear the hover, which is not what happens when you slide off a badge onto the row.
    badge.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: false }));
    row.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 200 }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".vram-rowtip"), "and comes back when you leave the badge");
});

// The resource panel sits above the session list and competes with it for height, so it is draggable and the
// choice is remembered. (Layout is jsdom-less, so this covers the mechanics: the grip exists, a drag sets a
// height, it persists, and a saved height is applied on open. The feel is the e2e's job.)
test("resource panel: drag the bottom edge to resize, and the height is remembered", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const panel = w.shadow.querySelector(".vram");
    assert.ok(!panel.getAttribute("style"), "no height until you choose one — it sizes to its content");
    const grip = w.shadow.querySelector(".vram-grip");
    assert.ok(grip, "the boundary with the session list is a handle");

    grip.dispatchEvent(new w.window.PointerEvent("pointerdown", { bubbles: true, clientY: 300 }));
    w.window.dispatchEvent(new w.window.PointerEvent("pointermove", { clientY: 420, buttons: 1 }));
    await w.flush();
    const h = parseFloat(w.shadow.querySelector(".vram").style.height);
    assert.ok(h > 0, "dragging down sets a height");

    w.window.dispatchEvent(new w.window.PointerEvent("pointerup", {}));
    await w.flush();
    assert.equal(w.localStore.ml_vram_h, h, "…and it is remembered, not just applied");

    // A height can't be dragged to nothing. The floor is MEASURED from the rendered parts, and jsdom has no
    // layout — so this only checks the clamp holds at all; the real geometry is the e2e's job.
    grip.dispatchEvent(new w.window.PointerEvent("pointerdown", { bubbles: true, clientY: 300 }));
    w.window.dispatchEvent(new w.window.PointerEvent("pointermove", { clientY: -5000, buttons: 1 }));
    await w.flush();
    assert.ok(parseFloat(w.shadow.querySelector(".vram").style.height) > 0, "clamped, never dragged past zero");
    w.window.dispatchEvent(new w.window.PointerEvent("pointerup", {}));
});

test("resource panel: a remembered height is applied on open", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_MIXED, local: { ml_vram_h: 240 },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    assert.match(w.shadow.querySelector(".vram").getAttribute("style") || "", /height:\s*240px/);
});

// A custom layout must SURVIVE a detour through a preset. It used to be destroyed: picking a preset
// overwrote the stored tracks, and the "Custom" entry only existed while it was already selected — so there
// was no way back to something you had built by hand.
test("layout: a custom layout survives picking a preset, and can be returned to", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
        local: { ml_res_layout: { presetId: "custom", custom: [{ id: "mine", series: ["vram.1"], mode: "stack", heightPx: 96 }],
                                  tracks: [{ id: "mine", series: ["vram.1"], mode: "stack", heightPx: 96 }] } },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const names = () => [...w.shadow.querySelectorAll(".rc-name")].map((n) => n.textContent);
    const picker = w.shadow.querySelector(".rc-preset");
    assert.deepEqual(names(), ["CUDA1"], "the custom layout is what we start on");
    assert.ok([...picker.options].some((o) => o.value === "custom"), "and Custom is an option");

    // Detour through a preset.
    picker.value = "overview";
    picker.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.ok(names().length >= 1 && names()[0] !== "CUDA1", "the preset takes over");
    assert.ok([...w.shadow.querySelector(".rc-preset").options].some((o) => o.value === "custom"),
        "Custom is STILL offered — it wasn't destroyed by looking at a preset");

    // …and back.
    const p2 = w.shadow.querySelector(".rc-preset");
    p2.value = "custom";
    p2.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.deepEqual(names(), ["CUDA1"], "returning to Custom restores exactly what was built");
    assert.deepEqual(w.localStore.ml_res_layout.custom, [{ id: "mine", series: ["vram.1"], mode: "stack", heightPx: 96 }],
        "and it is still on disk beside whatever is active");
});

// Dragging the panel taller must grow the CHART, not add empty space under it. jsdom has no layout, so this
// asserts the flex chain that makes it so — a fixed-height plot inside a resizable panel is the bug.
test("resource panel: the chart flexes into the dragged height", async () => {
    const css = require("node:fs").readFileSync("sidebar/sidebar.css", "utf8");
    const rule = (sel) => css.slice(css.indexOf(sel + " {"), css.indexOf("}", css.indexOf(sel + " {")));
    for (const sel of [".rc", ".rc-track", ".rc-plot"]) {
        assert.match(rule(sel), /flex:\s*1 1/, `${sel} must grow with the panel`);
    }
    // …but they must NOT be allowed to shrink below their content: `min-height: 0` let the chart be squeezed
    // past what fits, and a flex item smaller than its content overflows and renders ON TOP of the rows below.
    // Too little room is the panel's problem to solve by scrolling.
    assert.ok(!/min-height:\s*0/.test(rule(".rc")), ".rc must not shrink past its content");
    assert.ok(!/min-height:\s*0/.test(rule(".rc-track")), ".rc-track must not shrink past its content");
    // The plot keeps a floor so it can't collapse to nothing.
    assert.match(rule(".rc-plot"), /min-height:\s*\d+px/);
    assert.match(css, /\.vram\[style\*="height"\] \.rc-plot \{ height: auto/, "a dragged height releases the fixed one");
});

// A scroll container CLIPS its children, so the panel only scrolls once a height has been dragged — and the
// badges in the rows open their tooltips UPWARD, since the rows sit at the bottom where the room is above.
test("resource panel: badge tooltips aren't clipped by the resizable panel", async () => {
    const css = require("node:fs").readFileSync("sidebar/sidebar.css", "utf8");
    const vram = css.slice(css.indexOf(".vram {"), css.indexOf("}", css.indexOf(".vram {")));
    assert.ok(!/overflow-y:\s*auto/.test(vram), "no clipping until a height is chosen");
    assert.match(css, /\.vram\[style\*="height"\] \{ overflow-y: auto/, "…and only then");

    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, contextLength: 262144,
                 expiresAt: new Date(Date.now() + 60_000).toISOString() }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    // Direction is no longer a class on the source — the floating layer computes it (tooltip-layer.ts), so
    // asserting `.above` here would be a green test with nothing behind it. What matters now is that the
    // source never renders in place (so a clipping ancestor is irrelevant, and its prose can't be copied).
    for (const sel of [".vram-ctx", ".vram-ttl"]) {
        assert.ok(w.shadow.querySelector(`${sel} .tt-pop`), `${sel} still carries its tooltip content`);
    }
    const ttPop = css.slice(css.indexOf(".tt-pop {"), css.indexOf("}", css.indexOf(".tt-pop {")));
    assert.match(ttPop, /display:\s*none/, "the source is never rendered in the flow, so nothing clips it");
});

// A panel dragged too small cannot fit its header, plot and rows — the content spilled over the session list
// below rather than shrinking. Both the drag and the stylesheet enforce a floor.
test("resource panel: the floor is LEARNED from the actual shortfall, not summed from parts", async () => {
    const { shortfall, layoutKey } = await import("../sidebar/vram.tsx");
    // Summing the parts is a guess about which parts exist and how tall they are — it goes stale the moment a
    // track grows a row or a name wraps, and the symptom is content rendering on top of itself. The shortfall
    // is what does not fit, whatever that content turns out to be.
    assert.equal(shortfall({ scrollHeight: 400, clientHeight: 300 }), 100, "exactly the height that is missing");
    assert.equal(shortfall({ scrollHeight: 300, clientHeight: 300 }), 0, "it fits → nothing to learn");
    assert.equal(shortfall({ scrollHeight: 200, clientHeight: 300 }), 0, "never negative — room to spare is not a floor");
    assert.equal(shortfall(null), 0);

    // The floor is keyed by the LAYOUT, so switching to a smaller view can shrink again rather than the panel
    // ratcheting permanently taller.
    assert.equal(layoutKey(3, 2), layoutKey(3, 2));
    assert.notEqual(layoutKey(3, 2), layoutKey(1, 2), "fewer tracks is a different floor");
    assert.notEqual(layoutKey(3, 2), layoutKey(3, 5), "…and so is a longer model list");
});

// The reported bug: the model quoted an output inline AND designated the same one with the `answer` tool, so
// the table rendered TWICE — once where it was quoted, once appended under the reply. Anything shown inline
// must not be fallback-attached at the end of the turn.
test("answer dedup (sidebar): an output quoted inline is not ALSO appended in the Result block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dup", "compute it"));
    await w.dispatch(compStep("dup"));
    // Both at once: cited inline in the prose, AND designated in the answer set.
    await w.dispatch({ ...agentResult("dup", `The total is ![it](@tool:${OUT}:out).`, 1),
                       answer: `![the sales table](@tool:${OUT}:out)` });
    await openRun(w);

    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply && /COMPUTED_TABLE/.test(reply.textContent), "it expands inline, where the model put it");
    assert.ok(!w.shadow.querySelector(".card-result"), "and is NOT appended again at the end of the turn");
    const shown = (w.shadow.querySelector(".msg.asst").textContent.match(/COMPUTED_TABLE/g) || []).length;
    assert.equal(shown, 1, "exactly one render of the output");
});

// The mixed form is the one a naive dedup misses: the prose cites the tool NAME while the answer set holds
// the hex id (or the reverse). They are the same output, so comparing the strings would render it twice.
test("answer dedup (sidebar): @tool:<name> inline and @tool:<id> in the answer set are ONE output", async () => {
    for (const [prose, designated] of [
        [`See ![it](@tool:python_exec:out).`, `![the table](@tool:${OUT}:out)`],   // name inline, hex designated
        [`See ![it](@tool:${OUT}:out).`, `![the table](@tool:python_exec:out)`],   // hex inline, name designated
    ]) {
        const w = await loadSidebarWorld();
        await w.dispatch(agentStart("mix", "compute it"));
        await w.dispatch(compStep("mix"));
        await w.dispatch({ ...agentResult("mix", prose, 1), answer: designated });
        await openRun(w);
        const count = (w.shadow.querySelector(".msg.asst").textContent.match(/COMPUTED_TABLE/g) || []).length;
        assert.equal(count, 1, `one render for ${prose} + ${designated}`);
        assert.ok(!w.shadow.querySelector(".card-result"), "no duplicate Result block");
    }
});

// Both surfaces render the Result block independently, so the dedup has to hold in each (the parity rule).
test("answer dedup (HUD card): the same output isn't shown twice there either", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("hdup", "compute it"));
    await w.dispatch(compStep("hdup"));
    await w.dispatch({ ...agentResult("hdup", `The total is ![it](@tool:python_exec:out).`, 1),
                       answer: `![the sales table](@tool:${OUT}:out)` });
    await w.tick();

    const card = w.shadow.querySelector(".card-body") || w.shadow.querySelector("body");
    const count = (card.textContent.match(/COMPUTED_TABLE/g) || []).length;
    assert.equal(count, 1, "the HUD shows it once, like the sidebar");
    assert.ok(!w.shadow.querySelector(".card-result"), "no appended duplicate on the card");
});

// …and an output the model did NOT quote still gets appended: dedup must not swallow a real result.
test("answer dedup: an UNquoted designated output still appears in the Result block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("keep", "compute it"));
    await w.dispatch(compStep("keep"));
    await w.dispatch({ ...agentResult("keep", "Done — see below.", 1), answer: `![the sales table](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb && /COMPUTED_TABLE/.test(rb.textContent), "it has nowhere else to be shown, so it is appended");
});

// A programmatic resize (switching views changes the floor) EASES; a drag must not, because easing the
// pointer would feel like lag. Driven by rAF, so the test steps the clock rather than waiting.
test("resize easing: eases to the target over time, and never snaps mid-flight", async () => {
    const { easeVramH } = await import("../sidebar/vram.tsx");
    const { vramH } = await import("../sidebar/store.ts");
    const frames = [];
    const realRaf = globalThis.requestAnimationFrame;
    // rAF timestamps share performance.now()'s origin — start there, or the elapsed fraction is nonsense.
    let now = performance.now();
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    try {
        vramH.value = 200;
        easeVramH(400, 200);
        // It moves in steps, not one jump — and each step lands between where it was and where it's going.
        const seen = [];
        while (frames.length && seen.length < 40) {
            now += 25;
            const fn = frames.shift();
            fn(now);
            seen.push(vramH.value);
        }
        assert.ok(seen.length > 3, `several frames, not a snap (saw ${seen.length})`);
        assert.ok(seen.every((v) => v >= 200 && v <= 400), "never overshoots either end");
        for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "monotonic toward the target");
        assert.equal(Math.round(seen.at(-1)), 400, "lands exactly on the target");
        // Ease-OUT: most of the distance is covered early, so it decelerates into place.
        assert.ok(seen[0] - 200 > (400 - seen.at(-2)), "decelerates — the first step moves further than the last");
    } finally { globalThis.requestAnimationFrame = realRaf; vramH.value = 0; }
});

test("resize easing: a tiny or first-time change is applied directly, not animated", async () => {
    const { easeVramH } = await import("../sidebar/vram.tsx");
    const { vramH } = await import("../sidebar/store.ts");
    const realRaf = globalThis.requestAnimationFrame;
    let scheduled = 0;
    globalThis.requestAnimationFrame = () => { scheduled++; return 1; };
    try {
        vramH.value = 0;                 // no height yet → nothing to animate FROM
        easeVramH(300);
        assert.equal(vramH.value, 300, "the first height is applied directly");
        vramH.value = 300;
        easeVramH(301);                  // a sub-pixel nudge would be an animation nobody can see
        assert.equal(vramH.value, 301);
        assert.equal(scheduled, 0, "neither case schedules a frame");
    } finally { globalThis.requestAnimationFrame = realRaf; vramH.value = 0; }
});

// "Not resident" and "we don't know yet" are different claims — the orb says "Awakening…" for the first and
// must say nothing for the second.
test("residentNow: knows loaded from not-loaded, and unknown from either", async () => {
    const { residentNow } = await import("../sidebar/vram.tsx");
    const { loadedModels } = await import("../sidebar/store.ts");
    const before = loadedModels.value;
    try {
        loadedModels.value = null;                       // no /api/ps answer yet
        assert.equal(residentNow("qwen3:8b"), undefined, "unknown, NOT 'not loaded'");
        loadedModels.value = [{ model: "qwen3:8b" }];
        assert.equal(residentNow("qwen3:8b"), true);
        assert.equal(residentNow("gemma4:31b"), false, "a model that isn't there really isn't");
        // :latest is normalised like the rest of the model plumbing, so the tag doesn't create a false miss.
        loadedModels.value = [{ model: "qwen3:latest" }];
        assert.equal(residentNow("qwen3"), true);
        assert.equal(residentNow(null), undefined, "no model named → nothing to claim");
    } finally { loadedModels.value = before; }
});
