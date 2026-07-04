// Integration tests for the page-world relay: injected.js (window.ml) talking
// through content.js's postMessage bridge to a stubbed background.
const { test } = require("node:test");
const assert = require("node:assert");
const { loadPageWorld } = require("./helpers");

const IMG = "data:image/png;base64,AAA";

test("ml.chat travels the relay and strips the think block", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: (msg) => {
            assert.equal(msg.type, "FETCH_LLM");
            return { data: "<think>meh</think>hello" };
        }
    });

    const out = await world.ml.chat("hi");
    assert.equal(out, "hello");
    assert.deepEqual(world.runtimeCalls[0].payload.messages, [
        { role: "user", content: "hi" }
    ]);
});

test("ml.chat keeps the think block with cleanup: false", async () => {
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: "<think>meh</think>hello" })
    });

    const out = await world.ml.chat("hi", { cleanup: false });
    assert.equal(out, "<think>meh</think>hello");
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

test("createChat accumulates history and resends it each turn", async () => {
    let n = 0;
    const world = loadPageWorld({
        onRuntimeMessage: () => ({ data: `<think>t</think>r${++n}` })
    });

    const h = world.ml.createChat({ system: "sys" });
    assert.equal(await h.chat("a"), "r1");
    assert.equal(await h.chat("b"), "r2");

    assert.deepEqual(h.messages, [
        { role: "system", content: "sys" },
        { role: "user", content: "a" },
        { role: "assistant", content: "r1" }, // stored post-cleanup
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
