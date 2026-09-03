// Integration tests for the page-world relay: injected.js (window.ml) talking
// through content.js's postMessage bridge to a stubbed background.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPageWorld } = require("./helpers");

const IMG = "data:image/png;base64,AAA";

// The fetch_url TOOL's display logic (schema flag, non-JSON error, shape-vs-raw size, large-JSON prepend).
// Drive the real tool `run` with a crafted FetchResult (mock FETCH_URL), so this is the shipped code.
const fetchTool = (fr) => {
    const world = loadPageWorld({ onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? { data: fr } : undefined) });
    return world.ml.fetchTool();
};
const jsonResult = (json, extra = {}) => ({
    url: "https://x.test/a.json", status: 200, ok: true, type: "json",
    text: JSON.stringify(json), json, typeByHeader: "json", typeByContent: "json", typeByExtension: null,
    contentType: "application/json", ...extra,
});

// fetch_url's returns are ToolResults wherever an In render rides along (the Markdown ladder's trace); this
// reads the model-facing text out of either shape.
const body = (out) => (typeof out === "string" ? out : out.content);

test("fetch_url tool: the render note flags schema-only vs full-page (so the log says which the agent asked for)", async () => {
    const tool = fetchTool(jsonResult({ a: 1 }));
    const full = tool.render(undefined, { url: "https://x.test/a.json" });
    assert.equal(full.note, "full page", "default fetch → full page");
    const schema = tool.render(undefined, { url: "https://x.test/a.json", schema: true });
    assert.equal(schema.note, "schema only", "schema:true → schema only");
    assert.equal(schema.verb, "fetch");
    assert.equal(schema.target, "https://x.test/a.json");
});

test("fetch_url tool: schema:true returns the JSON shape, not the body", async () => {
    const json = { id: 7, items: [{ name: "a" }, { name: "b" }] };
    const out = body(await fetchTool(jsonResult(json, { schema: "{ id: number, items: { name: string }[] /* 2 items */ }" })).run({ url: "https://x.test/a.json", schema: true }));
    assert.match(out, /JSON schema:/);
    assert.match(out, /items: \{ name: string \}\[\]/);
    assert.doesNotMatch(out, /"name":\s*"a"/, "the raw body is NOT dumped when schema was requested");
});

test("fetch_url tool: schema:true falls back to computing the shape when the result carries none", async () => {
    // No `.schema` on the result → the tool computes jsonShape(json) itself.
    const out = body(await fetchTool(jsonResult({ a: [1, 2, 3] })).run({ url: "https://x.test/a.json", schema: true }));
    assert.match(out, /JSON schema:/);
    assert.match(out, /a: number\[\]/);
});

test("fetch_url tool: schema:true on a NON-JSON body errors and says what it actually was", async () => {
    const html = { url: "https://x.test/page", status: 200, ok: true, type: "html", text: "<!doctype html><title>Hi</title>", typeByHeader: "html", typeByContent: "html", typeByExtension: null, contentType: "text/html" };
    const out = await fetchTool(html).run({ url: "https://x.test/page", schema: true });
    assert.match(out, /^Error:/);
    assert.match(out, /isn't JSON/i);
    assert.match(out, /it's html/i, "tells the model what it WAS");
    assert.match(out, /text\/html/, "includes the Content-Type");
    assert.match(out, /<!doctype html>/, "and the first bytes so the model can see it");
});

test("fetch_url tool: schema:true dumps the RAW json + a note when the shape would be larger than the object", async () => {
    // A tiny flat object: its shape (`{ a: number }`) is longer than the payload itself.
    const out = body(await fetchTool(jsonResult({ a: 1 }, { schema: "{ a: number }" })).run({ url: "https://x.test/a.json", schema: true }));
    assert.doesNotMatch(out, /JSON schema:/, "no shape header");
    assert.match(out, /"a": 1/, "the raw JSON is shown");
    assert.match(out, /schema would be larger than the object/i, "with a note explaining why");
});

test("fetch_url tool: default (no flag) PREPENDS the shape for a LARGE json, but not a small one", async () => {
    // Large json → the shape orients the model even though the body is clipped.
    const big = { items: Array.from({ length: 60 }, (_, i) => ({ name: `item-number-${i}`, index: i })) };
    const bigOut = body(await fetchTool(jsonResult(big, { schema: "{ items: { name: string, index: number }[] /* 60 items */ }" })).run({ url: "https://x.test/a.json" }));
    assert.match(bigOut, /JSON schema: \{ items:/, "a big json gets its shape prepended");
    assert.match(bigOut, /"item-number-0"/, "and the (clipped) body too");
    // Small json → no shape line, just the body.
    const smallOut = body(await fetchTool(jsonResult({ ok: true }, { schema: "{ ok: boolean }" })).run({ url: "https://x.test/a.json" }));
    assert.doesNotMatch(smallOut, /JSON schema:/, "a small json isn't cluttered with a shape line");
    assert.match(smallOut, /"ok": true/);
});

// ASK mode: the tool fetches, then delegates to a reader model and returns only the ANSWER (not the body),
// so a large page/API never floods the driver's context. Mock BOTH the FETCH_URL and the FETCH_LLM subcall.
const askWorld = (fr, reply) => {
    const seen = { llm: null };
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_URL") return { data: fr };
            if (m.type === "FETCH_LLM") { seen.llm = m.payload; return { data: reply }; }
            return undefined;
        },
    });
    return { tool: world.ml.fetchTool(), seen, world };
};

test("fetch_url tool: `ask` distills the body via a reader model and returns the ANSWER, not the bytes", async () => {
    const big = { widgets: Array.from({ length: 40 }, (_, i) => ({ id: i, price: i * 3 })) };
    const { tool, seen } = askWorld(jsonResult(big), "The cheapest widget costs 0.");
    const out = await tool.run({ url: "https://x.test/a.json", ask: "What is the cheapest widget price?" });
    assert.match(out.content, /Answer:/);
    assert.match(out.content, /cheapest widget costs 0/, "the reader's answer is returned");
    assert.doesNotMatch(out.content, /"price": 117/, "the raw body is NOT dumped into the driver's context");
    // The rendered In carries the FULL question on its own field (not squeezed into the note, not truncated).
    assert.equal(out.renderIn.type, "action");
    assert.equal(out.renderIn.ask, "What is the cheapest widget price?");
    // The reader sub-call saw the fetched content AND the question.
    const prompt = seen.llm.messages[seen.llm.messages.length - 1].content;
    assert.match(prompt, /What is the cheapest widget price\?/, "the question reached the reader");
    assert.match(prompt, /"price": 3/, "the fetched content reached the reader");
    assert.equal(seen.llm.extend, "utility", "the sub-call uses the fast utility reader model");
});

test("fetch_url tool: `ask` takes precedence over `schema`", async () => {
    const { tool } = askWorld(jsonResult({ a: 1 }, { schema: "{ a: number }" }), "It has one field, a.");
    const out = await tool.run({ url: "https://x.test/a.json", schema: true, ask: "How many fields?" });
    assert.match(out.content, /Answer:/, "ask wins");
    assert.doesNotMatch(out.content, /JSON schema:/, "the schema branch didn't run");
});

test("fetch_url tool: `ask` on an oversized body clips the content and FLAGS that the answer may be incomplete", async () => {
    const huge = { blob: "x".repeat(50000) };
    const { tool, seen } = askWorld(jsonResult(huge), "ok");
    const out = await tool.run({ url: "https://x.test/a.json", ask: "anything?" });
    assert.match(out.content, /truncated before reading/i, "the driver is told the read was partial");
    const prompt = seen.llm.messages[seen.llm.messages.length - 1].content;
    assert.ok(prompt.length < 30000, "the content handed to the reader was clipped to the budget");
});

test("fetch_url tool: the render puts the ASK on its own field, FULL (never truncated) and NOT in the inline note", () => {
    const { tool } = askWorld(jsonResult({ a: 1 }), "x");
    const long = "List only the file paths (type: blob) that plausibly hold a system prompt, and nothing else at all please";
    const r = tool.render(undefined, { url: "https://x.test/a.json", ask: long });
    assert.equal(r.ask, long, "the whole question is carried, untruncated");
    assert.ok(!/ask:/.test(r.note || ""), "the ask is NOT crammed into the inline note");
    assert.equal(r.verb, "fetch");
    // A credentialed ask still shows the cookies note AND the ask field.
    const cred = tool.render(undefined, { url: "https://x.test/a.json", ask: "who?", credentials: true });
    assert.match(cred.note, /sends your cookies/);
    assert.equal(cred.ask, "who?");
});

test("ml.fetch travels the relay, returns the FetchResult, and CACHES it for readonly reuse", async () => {
    const result = { url: "https://x.test/a.json", status: 200, ok: true, type: "json", text: '{"n":7}', json: { n: 7 } };
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => (msg.type === "FETCH_URL" ? { data: result } : undefined),
    });
    const got = await world.ml.fetch("https://x.test/a.json");
    assert.deepEqual(got, result, "the FetchResult comes back over the relay");
    assert.equal(world.runtimeCalls[0].type, "FETCH_URL");
    assert.equal(world.runtimeCalls[0].payload.url, "https://x.test/a.json");
    // The result is now cached — this is what the read-only dialect's ml.fetch reads (free re-reads).
    assert.deepEqual(world.ml._fetchCached("https://x.test/a.json"), result, "a fetched URL is cached");
    assert.equal(world.ml._fetchCached("https://x.test/never"), undefined, "an unfetched URL is a cache miss");
});

test("ml.fetch: a CREDENTIALED (as-the-user) result is NEVER cached — authenticated bytes must not leak via the readonly cache", async () => {
    const result = { url: "https://x.test/me", status: 200, ok: true, type: "json", text: '{"me":1}', json: { me: 1 }, typeByHeader: "json", typeByContent: "json", typeByExtension: null, contentType: "application/json" };
    let sawCreds;
    const world = loadPageWorld({ onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? (sawCreds = m.payload.credentials, { data: result }) : undefined) });
    const got = await world.ml.fetch("https://x.test/me", { credentials: true });
    assert.deepEqual(got, result, "the credentialed result comes back to the caller");
    assert.equal(sawCreds, true, "the credentials flag reached the background");
    assert.equal(world.ml._fetchCached("https://x.test/me"), undefined, "…but it's NOT cached (no free readonly re-read of authenticated data)");
});

test("ml.fetch: a FAILED (non-2xx) fetch is NOT cached — a retry re-fetches after the server recovers", async () => {
    const bad = { url: "https://x.test/down", status: 503, ok: false, type: "text", text: "Service Unavailable", typeByHeader: "text", typeByContent: "text", typeByExtension: null, contentType: "text/plain" };
    const world = loadPageWorld({ onRuntimeMessage: (m) => (m.type === "FETCH_URL" ? { data: bad } : undefined) });
    const got = await world.ml.fetch("https://x.test/down");
    assert.equal(got.status, 503, "the failure result is returned to the caller");
    assert.equal(world.ml._fetchCached("https://x.test/down"), undefined, "…but NOT cached (so a readonly re-read re-fetches, not serves the stale 503)");
});

test("ml.chat travels the relay and returns the reply verbatim", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "FETCH_LLM");
            return { data: "hello" };
        }
    });

    const out = await world.ml.chat("hi");
    assert.equal(out, "hello");
    assert.deepEqual(world.runtimeCalls[0].payload.messages, [
        { role: "user", content: "hi" }
    ]);
});

test("ml.chat converts <img> elements to data URLs in the payload", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: "seen" })
    });

    const img = new world.context.HTMLImageElement();
    img.currentSrc = IMG;

    await world.ml.chat("look", { images: [img] });
    assert.deepEqual(world.runtimeCalls[0].payload.messages[0].images, [IMG]);
});

test("window.ml signals readiness via the ml:ready event and ml.ready promise", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "ok" }) });
    assert.ok(world.dispatchedEvents.includes("ml:ready"));
    assert.strictEqual(await world.ml.ready, world.ml);
});

test("CANCEL_RUN_REQUEST relays a fire-and-forget CANCEL_RUN so a handle kills its background loop", async () => {
    // A createAgent handle's cancel() posts this for a BACKGROUND run: aborting the page controller alone
    // only kills a FETCH_LLM (via ABORT_TASK), not the SW-side loop — which would keep stepping and emit a
    // stale approval AFTER the "cancelled" bubble. content.js must relay it as a runtime CANCEL_RUN.
    const world = loadPageWorld({ onRuntimeMessage: () => undefined });
    world.context.window.postMessage({ type: "CANCEL_RUN_REQUEST", payload: { runId: "run42" } });
    await new Promise(r => setTimeout(r, 0));   // the harness posts on a microtask
    const cancel = world.runtimeCalls.find(m => m.type === "CANCEL_RUN");
    assert.ok(cancel, "content.js relayed a CANCEL_RUN runtime message");
    assert.equal(cancel.payload.runId, "run42", "carrying the run id to abort");
});

test("relay: a MISSING background response rejects with an actionable error (not a silent undefined)", async () => {
    // The MV3 service worker was evicted/reloaded mid-task, so it never called sendResponse → the callback
    // fires with `undefined`. content.js must synthesise an error so the page REJECTS cleanly, instead of
    // resolving `undefined` (which crashed downstream as "Cannot read properties of undefined (reading …)").
    // serverTools → LIST_SERVER_TOOLS (not a config/caps probe the harness auto-answers), so the undefined
    // return reaches the relay callback as a missing response — exactly the evicted-SW case.
    const world = loadPageWorld({ onRuntimeMessage: () => undefined });
    await assert.rejects(world.ml.serverTools(), /didn't respond|evicted/i);
});

test("ml.step returns the raw assistant message with tool_calls", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.payload.raw, true);
            assert.ok(Array.isArray(msg.payload.tools));
            return { data: { content: null, tool_calls: [{ id: "call_0", name: "readDom", arguments: { selector: ".x" } }] } };
        }
    });

    const out = await world.ml.step(
        [{ role: "user", content: "go" }],
        { tools: [{ type: "function", function: { name: "readDom" } }] }
    );
    assert.equal(out.content, null);
    assert.equal(out.tool_calls[0].name, "readDom");
    assert.deepEqual(out.tool_calls[0].arguments, { selector: ".x" });
});

test("ml.capabilities relays a MODEL_CAPS request and returns the capability list", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "MODEL_CAPS");
            assert.equal(msg.payload.model, "qwen3:32b");
            return { data: ["completion", "tools", "thinking"] };
        }
    });

    const caps = await world.ml.capabilities("qwen3:32b");
    assert.deepEqual(caps, ["completion", "tools", "thinking"]);
});

test("ml.serverTools relays a LIST_SERVER_TOOLS request and returns the tool list", async () => {
    const tools = [{ id: "searxng_web_search", name: "SearXNG", description: "", kind: "local", functions: [] }];
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "LIST_SERVER_TOOLS");
            return { data: tools };
        }
    });

    assert.deepEqual(await world.ml.serverTools(), tools);
});

test("ml.config relays a GET_CONFIG request and returns the non-secret config", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "GET_CONFIG");
            return { data: { model: "qwen3:235b", ocrModel: "qwen2.5vl", apiFormat: "ollama" } };
        }
    });

    const cfg = await world.ml.config();
    assert.deepEqual(cfg, { model: "qwen3:235b", ocrModel: "qwen2.5vl", apiFormat: "ollama" });
});

test("ml.chat forwards a maxTokens cap in the request payload", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.payload.maxTokens, 300);
            return { data: "ok" };
        }
    });

    const out = await world.ml.chat("hi", { maxTokens: 300 });
    assert.equal(out, "ok");
});

test("ml.chat forwards the extend profile in the request payload", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.payload.extend, "utility");
            return { data: "ok" };
        }
    });
    assert.equal(await world.ml.chat("hi", { extend: "utility" }), "ok");
});

test("ml.chat rejects an invalid extend value", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => assert.fail("no request should be sent") });
    await assert.rejects(world.ml.chat("hi", { extend: "bogus" }), /invalid extend/);
});

test("debug stream is silent until the sidebar handshakes, then emits chat events with the save flag", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi there" }) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });

    // No sidebar mounted yet → emission is gated off entirely.
    await world.ml.chat("before");
    assert.equal(events.length, 0, "silent until the sidebar handshakes");

    // Sidebar mounts and announces itself → injected.js starts emitting.
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));

    await world.ml.chat("hello", { save: true });
    const start = events.find(e => e.kind === "chat");
    const done = events.find(e => e.kind === "chat-result");
    assert.ok(start && done, events.map(e => e.kind).join());
    assert.equal(start.save, true);                                   // save flag threads through
    assert.equal(start.request.messages.at(-1).content, "hello");     // request snapshot carried
    assert.equal(done.content, "hi there");                           // reply carried on settle
    assert.equal(done.save, true);
});

test("debug events emitted between sidebar 'present' and 'ready' are buffered then replayed", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi" }) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });

    // Shell mounts (config.sidebar on) → injected starts BUFFERING, but the iframe
    // app hasn't handshaked, so nothing is emitted live yet.
    win.postMessage({ __mlSidebar: "present" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.chat("early", { save: true });
    assert.equal(events.length, 0, "buffered, not emitted, until the app is listening");

    // The iframe app finishes loading and handshakes → the buffered turn replays.
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    assert.ok(events.find(e => e.kind === "chat" && e.request.messages.at(-1).content === "early"), "early chat replayed on ready (not dropped)");
    assert.ok(events.find(e => e.kind === "chat-result"), "its result replayed too");
});

test("injected announces 'hello' on load (so a shell that mounted first can re-handshake)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi" }) });
    const win = world.context.window;
    const signals = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlSidebar) signals.push(e.data.__mlSidebar); });
    await new Promise(r => setTimeout(r, 0));   // let the queued announce deliver
    assert.ok(signals.includes("hello"), "posts a hello so a page-load-race handshake isn't lost");
});

test("a second 'ready' does NOT re-replay the ring (idempotent re-handshake on hello)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi" }) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });

    win.postMessage({ __mlSidebar: "present" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.chat("early", { save: true });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const afterFirst = events.length;
    assert.ok(afterFirst >= 2, "buffered turn replayed on the first ready");

    // The shell re-sends the handshake when injected posts `hello` (page-load race guard);
    // a second `ready` must not re-emit events that already went out.
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(events.length, afterFirst, "second ready is a no-op — no duplicate events");
});

test("with no sidebar present, nothing is buffered (disabled = zero cost)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi" }) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });

    await world.ml.chat("x");                          // no shell → not buffered
    win.postMessage({ __mlSidebar: "ready" });          // even a late handshake finds an empty ring
    await new Promise(r => setTimeout(r, 0));
    assert.equal(events.length, 0, "events before a sidebar existed are never retained");
});

test("switching the sidebar OFF stops emission and drops the buffered events", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi" }) });
    const win = world.context.window;
    const events = [];
    win.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) events.push(e.data.__mlDebug); });

    win.postMessage({ __mlSidebar: "present" });
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    await world.ml.chat("while on");
    assert.ok(events.length > 0, "emitting while the sidebar is on");

    // The user unchecks the sidebar → the shell unmounts and reports "gone".
    win.postMessage({ __mlSidebar: "gone" });
    await new Promise(r => setTimeout(r, 0));
    const after = events.length;
    await world.ml.chat("while off");
    assert.equal(events.length, after, "no events emitted once the sidebar is off");

    // The ring was dropped too: re-enabling replays NOTHING from the off period
    // (otherwise disabling would silently keep retaining prompts/replies).
    win.postMessage({ __mlSidebar: "ready" });
    await new Promise(r => setTimeout(r, 0));
    const texts = JSON.stringify(events);
    assert.ok(!texts.includes("while off"), "nothing captured while off is retained or replayed");
});

test("ml.chat forwards toolIds for server-side tools", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.deepEqual(msg.payload.toolIds, ["web_search"]);
            return { data: "answer" };
        }
    });

    const out = await world.ml.chat("weather?", { toolIds: ["web_search"] });
    assert.equal(out, "answer");
});

test("ml.read sends an OCR request and returns cleaned text", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "FETCH_LLM");
            assert.equal(msg.payload.ocr, true);
            assert.equal(msg.payload.think, null);
            assert.deepEqual(msg.payload.messages[0].images, [IMG]);
            assert.match(msg.payload.messages[0].content, /transcribe/i);
            return { data: "  Invoice #42  " };
        }
    });

    const text = await world.ml.read(IMG);
    assert.equal(text, "Invoice #42"); // trimmed
});

test("ml.read passes a per-call model override", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.payload.model, "got-ocr2");
            return { data: "text" };
        }
    });

    await world.ml.read(IMG, { model: "got-ocr2" });
});

test("createChat accumulates history and resends it each turn", async () => {
    let n = 0;
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: `r${++n}` })
    });

    const h = world.ml.createChat({ system: "sys" });
    assert.equal(await h.chat("a"), "r1");
    assert.equal(await h.chat("b"), "r2");

    assert.deepEqual(h.messages, [
        { role: "system", content: "sys" },
        { role: "user", content: "a" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "b" },
        { role: "assistant", content: "r2" }
    ]);
    // Second request carried the full prior context.
    assert.deepEqual(
        world.runtimeCalls[1].payload.messages.map(m => m.content),
        ["sys", "a", "r1", "b"]
    );
});

test("a failed request leaves the history untouched", async () => {
    let fail = false;
    const world = loadPageWorld({
        onRuntimeMessage: () => (fail ? { error: "boom" } : { data: "r1" })
    });

    const h = world.ml.createChat();
    await h.chat("a");

    fail = true;
    await assert.rejects(h.chat("b"), (err) => err === "boom");
    assert.equal(h.messages.length, 2); // just the first exchange
});

test("fork produces an independent deep copy", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: "r1" })
    });

    const h = world.ml.createChat({ system: "sys" });
    await h.chat("a");

    const copy = h.fork();
    assert.deepEqual(copy.messages, h.messages);
    assert.notStrictEqual(copy.messages[0], h.messages[0]);

    copy.messages.push({ role: "user", content: "divergent" });
    copy.messages[0].content = "mutated";
    assert.equal(h.messages.length, 3);
    assert.equal(h.messages[0].content, "sys");
});

test("per-turn overrides beat the chat defaults", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: "ok" })
    });

    const h = world.ml.createChat({ model: "chat-default", think: false });
    await h.chat("a");
    await h.chat("b", { model: "turn-override", think: true });

    assert.equal(world.runtimeCalls[0].payload.model, "chat-default");
    assert.equal(world.runtimeCalls[0].payload.think, false);
    assert.equal(world.runtimeCalls[1].payload.model, "turn-override");
    assert.equal(world.runtimeCalls[1].payload.think, true);
});

test("schema returns parsed JSON and stores raw text in history", async () => {
    const schema = { type: "object", properties: { hide: { type: "boolean" } } };
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.deepEqual(msg.payload.schema, schema);
            return { data: '{"hide":true,"title":"clean"}' };
        }
    });

    const out = await world.ml.chat("judge this", { schema });
    assert.deepEqual(out, { hide: true, title: "clean" });

    // Multi-turn keeps the raw JSON string as context, not the parsed object.
    const h = world.ml.createChat({ schema });
    await h.chat("again");
    assert.equal(h.messages.at(-1).content, '{"hide":true,"title":"clean"}');
    assert.equal(typeof h.messages.at(-1).content, "string");
});

test("schema tolerates a ```json fence around the reply", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: '```json\n{"ok":1}\n```' })
    });

    const out = await world.ml.chat("x", { schema: { type: "object" } });
    assert.deepEqual(out, { ok: 1 });
});

test("schema surfaces invalid JSON with the raw text", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: "sorry, I cannot do that" })
    });

    await assert.rejects(
        world.ml.chat("x", { schema: { type: "object" } }),
        /wasn't valid JSON.*sorry, I cannot/s
    );
});

test("ml.chat streams tokens via onToken and resolves the full string", async () => {
    const world = loadPageWorld({
        onStream: (msg, emit) => {
            assert.ok(Array.isArray(msg.payload.messages));
            emit({ type: "chunk", delta: "Hel" });
            emit({ type: "chunk", delta: "lo" });
            emit({ type: "done", content: "Hello" });
        }
    });

    const tokens = [];
    const full = await world.ml.chat("hi", { onToken: (t) => tokens.push(t) });
    assert.deepEqual(tokens, ["Hel", "lo"]);
    assert.equal(full, "Hello");
});

test("streaming onToken sees each delta and the resolved value is the reply verbatim", async () => {
    const world = loadPageWorld({
        onStream: (msg, emit) => {
            emit({ type: "chunk", delta: "Hi" });
            emit({ type: "chunk", delta: " there" });
            emit({ type: "done", content: "Hi there" });
        }
    });

    const seen = [];
    const full = await world.ml.chat("q", { onToken: (t) => seen.push(t) });
    assert.deepEqual(seen, ["Hi", " there"]);
    assert.equal(full, "Hi there");            // returned verbatim (no cleaning)
});

test("streaming updates history with the full reply for follow-ups", async () => {
    const world = loadPageWorld({
        onStream: (msg, emit) => {
            emit({ type: "chunk", delta: "two" });
            emit({ type: "done", content: "two" });
        }
    });

    const h = world.ml.createChat();
    await h.chat("one", { onToken: () => {} });
    assert.deepEqual(h.messages, [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" }
    ]);
});

test("a schema call ignores onToken (streaming is text-only)", async () => {
    let streamed = false;
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: '{"ok":true}' }),
        onStream: () => { streamed = true; }
    });

    const out = await world.ml.chat("x", {
        schema: { type: "object" },
        onToken: () => {}
    });
    assert.equal(streamed, false);             // went through the one-shot path
    assert.deepEqual(out, { ok: true });
});

test("chat attaches server-side sources to the assistant message (non-stream)", async () => {
    const srcs = [{ source: { name: "web/search" }, metadata: [{ source: "https://x.com" }] }];
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: "answer", sources: srcs })
    });

    const h = world.ml.createChat();
    const out = await h.chat("q", { toolIds: ["web"] });
    assert.equal(out, "answer");
    assert.deepEqual(h.messages.at(-1).sources, srcs);
});

test("streaming chat attaches sources from the done message", async () => {
    const srcs = [{ source: { name: "web" }, metadata: [{ source: "https://x.com" }] }];
    const world = loadPageWorld({
        onStream: (msg, emit) => {
            emit({ type: "chunk", delta: "hi" });
            emit({ type: "done", content: "hi", sources: srcs });
        }
    });

    const h = world.ml.createChat();
    await h.chat("q", { onToken: () => {} });
    assert.deepEqual(h.messages.at(-1).sources, srcs);
});

test("a plain reply has no sources field on the message", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "hi" }) });
    const h = world.ml.createChat();
    await h.chat("q");
    assert.ok(!("sources" in h.messages.at(-1)));
});

test("CAPTURE_TAB_REQUEST relays to a CAPTURE_TAB background message", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "CAPTURE_TAB");
            return { data: "data:image/png;base64,SHOT" };
        }
    });
    // Post the raw request (ml.screenshot's crop needs a real canvas — browser
    // only); this asserts the content.js HANDLE_MAP wiring forwards it.
    world.context.window.postMessage({ type: "CAPTURE_TAB_REQUEST", requestId: "r1", payload: {} });
    await new Promise(r => setTimeout(r));
    assert.equal(world.runtimeCalls[0].type, "CAPTURE_TAB");
});

test("INVOCATION_REQUEST relays to a GET_INVOCATION background message", async () => {
    // agent_api_docs asks for the LIVE HUD shortcut through the normal relay rather than
    // hardcoding one, since the user can rebind it at <scheme>://extensions/shortcuts.
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: { shortcut: "Alt+Space", defaultShortcut: "Alt+Space", isDefault: true, contextMenu: false } })
    });
    world.context.window.postMessage({ type: "INVOCATION_REQUEST", requestId: "r1", payload: {} });
    await new Promise(r => setTimeout(r));
    assert.equal(world.runtimeCalls[0].type, "GET_INVOCATION");
});

test("ml.screenshot() with no target returns the whole viewport uncropped", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "CAPTURE_TAB");
            return { data: "data:image/png;base64,VIEWPORT" };
        }
    });
    // No target → no crop (no canvas), so this whole path is testable headless.
    assert.equal(await world.ml.screenshot(), "data:image/png;base64,VIEWPORT");
});

test("ml.resumeChat continues a same-tab session from memory (the same object)", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "reply" }) });
    const h = world.ml.createChat({ model: "m" });
    await h.chat("first");
    const resumed = await world.ml.resumeChat(h.hash);
    assert.equal(resumed, h, "same tab → the same history object");
    assert.equal(resumed.messages.length, 2);   // user + assistant
});

test("ml.chat with save:true persists the session via SAVE_SESSION", async () => {
    const saves = [];
    const world = loadPageWorld({
        onRuntimeMessage: (m) => {
            if (m.type === "SAVE_SESSION") { saves.push(m.payload); return { data: true }; }
            return { data: "reply" };
        }
    });
    const h = world.ml.createChat({ model: "m", save: true });
    await h.chat("hi");
    await new Promise(r => setTimeout(r, 10));   // let the fire-and-forget save land
    assert.equal(saves.length, 1);
    assert.equal(saves[0].hash, h.hash);
    assert.equal(saves[0].session.messages.length, 2);
    assert.equal(saves[0].session.save, true);
});

test("ml.resumeChat rehydrates a saved session from storage and continues it", async () => {
    const session = {
        hash: "stored1", model: "saved-model", extend: null, numCtx: null, numGpu: null,
        think: null, schema: null, toolIds: null, maxTokens: null, save: true,
        messages: [{ role: "user", content: "old" }, { role: "assistant", content: "hi" }],
    };
    const world = loadPageWorld({
        onRuntimeMessage: (m) => m.type === "GET_SESSION" ? { data: m.payload.hash === "stored1" ? session : null } : { data: "reply" }
    });
    const h = await world.ml.resumeChat("stored1");
    assert.equal(h.hash, "stored1");
    assert.equal(h.model, "saved-model");
    assert.deepEqual(h.messages, session.messages);

    await h.chat("next");   // continues with the full prior context
    const sent = world.runtimeCalls.find(c => c.payload && c.payload.messages).payload.messages;
    assert.ok(sent.some(msg => msg.content === "old"), "resent the rehydrated history");
    assert.equal(h.messages.at(-2).content, "next");
});

test("ml.resumeChat throws for an unknown / session-local hash", async () => {
    const world = loadPageWorld({ onRuntimeMessage: (m) => m.type === "GET_SESSION" ? { data: null } : { data: "r" } });
    await assert.rejects(world.ml.resumeChat("ghost"), /No resumable session/);
});

// A minimal window bus: derefViaBackground talks to the content script over window.postMessage, so the test
// needs the two halves of that bus and nothing else. (loadPageWorld builds a whole page realm; this contract
// is just messages, so a bus keeps the test about the protocol.)
function withWindowBus(fn) {
    const listeners = new Set();
    const prev = globalThis.window;
    globalThis.window = {
        addEventListener: (t, l) => { if (t === "message") listeners.add(l); },
        removeEventListener: (t, l) => { if (t === "message") listeners.delete(l); },
        postMessage: (data) => { for (const l of [...listeners]) queueMicrotask(() => l({ data })); },
    };
    return Promise.resolve(fn(globalThis.window)).finally(() => { globalThis.window = prev; });
}

// `ml.dereference` on the BACKGROUND-hosted path. The loop (and the pointer store) live in the service worker
// while the tool runs in the page, so the read rings back over the same relay every page→background request
// uses. This drives the REAL page-side half (derefViaBackground → window.postMessage) against a stubbed
// content script, so the message contract can't drift.
test("ml.dereference (background-hosted): the page rings back to the SW, id-matched", async () => {
    const { derefViaBackground } = await import("../src/ml-agent.ts");
    await withWindowBus(async (window) => {
    const seen = [];
    // Stand in for content.ts: answer a PAGE_DEREF with a PAGE_DEREF_RESULT carrying the same id.
    const onMsg = (e) => {
        const d = e.data;
        if (!d || d.type !== "PAGE_DEREF") return;
        seen.push(d);
        window.postMessage({ type: "PAGE_DEREF_RESULT", id: d.id, value: `resolved:${d.ref}|${d.pipe}` }, "*");
    };
    window.addEventListener("message", onMsg);
    try {
        const read = await derefViaBackground("run-7", "@tool:a1b2c3f", "head 5");
        assert.equal(read.value, "resolved:@tool:a1b2c3f|head 5");
        assert.equal(read.warning, undefined, "no advisory when the pointer matched exactly");
        assert.equal(seen.length, 1);
        assert.equal(seen[0].runId, "run-7", "the read is scoped to the run whose tool is executing");
        assert.equal(seen[0].ref, "@tool:a1b2c3f");
        assert.ok(seen[0].id, "carries a request id so concurrent reads can't cross");
    } finally { window.removeEventListener("message", onMsg); }
    });
});

test("ml.dereference (background-hosted): an error from the SW rejects, and a foreign id is ignored", async () => {
    const { derefViaBackground } = await import("../src/ml-agent.ts");
    await withWindowBus(async (window) => {
    const onMsg = (e) => {
        const d = e.data;
        if (!d || d.type !== "PAGE_DEREF") return;
        // A reply for a DIFFERENT request must not settle this one (concurrent reads share the window bus).
        window.postMessage({ type: "PAGE_DEREF_RESULT", id: "someone-else", value: "wrong" }, "*");
        window.postMessage({ type: "PAGE_DEREF_RESULT", id: d.id, error: "MemoryFault: pointer '@tool:zzzzzz' does not exist." }, "*");
    };
    window.addEventListener("message", onMsg);
    try {
        await assert.rejects(() => derefViaBackground("run-7", "@tool:zzzzzz"), /MemoryFault/);
    } finally { window.removeEventListener("message", onMsg); }
    });
});

// The `ml.dereference` METHOD's boundary: from a page's own console there is no active run, so nothing is
// bound and it throws — rather than silently resolving to nothing. (The binding itself, and the array-pipe
// normalisation, are covered in token-pipe.test.mjs; the page world runs its own module graph, so a resolver
// bound out here would not be the one the sandbox sees.)
test("ml.dereference: throws when called outside a run", async () => {
    const { loadPageWorld } = require("./helpers");
    const world = loadPageWorld({});
    await assert.rejects(() => world.ml.dereference("@tool:a1b2c3f"), /only live inside an ml\.agent run/);
});

// ml.info() across the real page relay: injected.js → content.js HANDLE_MAP → background.
test("ml.info(): the capacity round-trip, and null when the route isn't served", async () => {
    const INFO = { compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12330946560 },
        supported_gpus: [{ gpu_id: "0", name: "CUDA0", total_memory: 101972967424, physical_memory: 102641958912, free_memory: 101386813440, runner: "CUDA" }],
    } };
    const world = loadPageWorld({ onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: INFO } : undefined) });
    const info = await world.ml.info();
    assert.equal(info.compute.supported_gpus[0].total_memory, 101972967424);
    assert.equal(info.compute.supported_gpus[0].physical_memory, 102641958912);

    // Capacity UNKNOWN must arrive as null, so the panel omits its ceiling rather than drawing one at zero.
    const none = loadPageWorld({ onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: null } : undefined) });
    assert.equal(await none.ml.info(), null);
});

// An advisory (a label resolved by similarity) must survive the background relay ALONGSIDE the value, so the
// page-side ml.dereference can console.warn it without touching the data the script is about to parse.
test("ml.dereference (background-hosted): a soft-match advisory crosses the relay beside the value", async () => {
    const { derefViaBackground } = await import("../src/ml-agent.ts");
    await withWindowBus(async (window) => {
        const onMsg = (e) => {
            const d = e.data;
            if (!d || d.type !== "PAGE_DEREF") return;
            window.postMessage({ type: "PAGE_DEREF_RESULT", id: d.id, value: "ROWS", warning: "resolved by similarity" }, "*");
        };
        window.addEventListener("message", onMsg);
        try {
            const read = await derefViaBackground("run-7", '@tool:"sales table"');
            assert.equal(read.value, "ROWS", "the value is untouched — a note inside it would corrupt the data");
            assert.equal(read.warning, "resolved by similarity", "and the advisory arrives separately");
        } finally { window.removeEventListener("message", onMsg); }
    });
});

// The page-relay contract for ml.embed: EMBED_REQUEST -> EMBED -> EMBED_RESPONSE, id-matched like every
// other primitive (AGENTS.md's three-file rule).
test("ml.embed relays through the content script and wraps the vectors", async () => {
    const world = loadPageWorld({
        config: { model: "m", ocrModel: "" },
        onRuntimeMessage: (m) => (m.type === "EMBED" ? { data: { model: "embeddinggemma:300m", vectors: [[3, 4]] } } : undefined),
    });
    await new Promise((r) => setTimeout(r, 0));

    // A single string resolves to ONE Embedding, not an array of one.
    const e = await world.ml.embed("hello");
    assert.equal(e.dims, 2);
    assert.deepEqual(e.values.map((v) => +v.toFixed(2)), [0.6, 0.8], "normalised on arrival, so dot is cosine");
    assert.ok(Math.abs(e.dot(e) - 1) < 1e-12);
});

test("ml.embed sends an ARRAY as one request, and returns one vector per input in order", async () => {
    let sent = null;
    const world = loadPageWorld({
        config: { model: "m", ocrModel: "" },
        onRuntimeMessage: (m) => {
            if (m.type !== "EMBED") return undefined;
            sent = m.payload;
            return { data: { model: "e", vectors: m.payload.inputs.map((_, i) => [i + 1, 0]) } };
        },
    });
    await new Promise((r) => setTimeout(r, 0));

    const out = await world.ml.embed(["a", "b", "c"]);
    assert.deepEqual(sent.inputs, ["a", "b", "c"], "one request carrying every input");
    assert.equal(out.length, 3, "one Embedding per input, in order");
    assert.ok(out.every((v) => Math.abs(v.dot(v) - 1) < 1e-12));
});

// `ml.schema` — the TS-like type of one JSON document, or the JOINED type of several. Pure (no relay), but
// driven through the page world so the variadic/await/coercion wiring is the shipped code.
test("ml.schema: one document is its shape; several are the type covering all of them", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "" }) });

    assert.equal(await world.ml.schema({ id: 7, tags: ["a"] }), "{ id: number, tags: string[] /* 1 item */ }");
    // separate documents, so NOT `[]` — and a key missing from one becomes optional
    assert.equal(await world.ml.schema({ id: 1, name: "a" }, { id: 2 }), "{ id: number, name?: string }");
});

test("ml.schema AWAITS its arguments, so pointer reads pass straight in", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "" }) });
    // this is the shape of `ml.schema(ml.dereference(a), ml.dereference(b))` — promises, un-awaited
    const a = Promise.resolve('{"page":1,"rows":[{"x":1}]}');
    const b = Promise.resolve('{"page":2,"rows":[{"x":1,"y":2}],"next":"u"}');

    assert.equal(await world.ml.schema(a, b),
        "{ page: number, rows: { x: number, y?: number }[] /* 2 items */, next?: string }");
});

test("ml.schema refuses prose, naming WHICH argument", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "" }) });

    await assert.rejects(() => world.ml.schema({ a: 1 }, "the page said hello"), /argument 2 is plain text/);
    await assert.rejects(() => world.ml.schema(), /needs at least one value/);
    // a single bad argument is named as "the argument", not "argument 1" — there is only one
    await assert.rejects(() => world.ml.schema("prose"), /the argument is plain text/);
});
