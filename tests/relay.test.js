// Integration tests for the page-world relay: injected.js (window.ml) talking
// through content.js's postMessage bridge to a stubbed background.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPageWorld } = require("./helpers");

const IMG = "data:image/png;base64,AAA";

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
