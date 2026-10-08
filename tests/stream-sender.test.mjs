"use strict";
// stream-sender.test.mjs — the producer's side of live tool output (src/agent/stream-sender.ts): a tool's stream
// crosses the page → content → worker chain in bounded posts, one per beat, never more than the panel keeps.
import { test } from "node:test";
import assert from "node:assert";
import { makeStreamSender, SEND_EVERY_MS } from "../src/agent/stream-sender.ts";
import { runAgentLoop } from "../src/agent/agent-loop.ts";
import { UI_OUT_CAP } from "../src/contract/contract-chat.ts";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
/** A sender that records every post. */
function recorder(cap) {
    const posts = [];
    const s = makeStreamSender((text, ts, skipped) => posts.push({ text, ts, skipped }), cap);
    return { s, posts, chars: () => posts.reduce((n, p) => n + p.text.length, 0), skipped: () => posts.reduce((n, p) => n + p.skipped, 0) };
}

// --- liveness: a slow stream is not delayed ------------------------------------------------------------------------

test("a slow trickle posts each chunk at once, with its own timestamp", async () => {
    const { s, posts } = recorder(1000);
    s.push("one\n", 1);
    await tick(SEND_EVERY_MS + 20);
    s.push("two\n", 2);
    assert.deepEqual(posts, [{ text: "one\n", ts: 1, skipped: 0 }, { text: "two\n", ts: 2, skipped: 0 }]);
});

test("a burst is merged into one post per beat, and flush sends what is held", async () => {
    const { s, posts } = recorder(1000);
    for (let i = 0; i < 50; i++) s.push(`l${i}\n`, 100 + i);
    assert.equal(posts.length, 1, "the first line went at once; the rest are held");
    s.flush();
    assert.equal(posts.length, 2);
    assert.equal(posts.map((p) => p.text).join(""), Array.from({ length: 50 }, (_, i) => `l${i}\n`).join(""), "nothing lost under the cap");
    assert.equal(posts[1].ts, 101, "a merged post carries the time its first part was produced");
    s.flush();
    assert.equal(posts.length, 2, "flushing with nothing held posts nothing");
});

// --- bounds: a runaway print is not gigabytes of messages ----------------------------------------------------------

test("past the cap, a post carries only the LATEST cap characters and counts the rest; the start goes whole", () => {
    const cap = 1000;
    const { s, posts, chars, skipped } = recorder(cap);
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${String(i).padStart(4, "0")}\n`);   // 55,000 chars
    for (const l of lines) s.push(l);
    s.flush();
    const all = lines.join("");
    assert.equal(posts.map((p) => p.text).join("").slice(0, cap), all.slice(0, cap), "the first `cap` characters arrive whole and in order");
    assert.ok(posts.at(-1).text.endsWith(lines.at(-1)), "the newest line is in the last post");
    assert.equal(chars() + skipped(), all.length, "posted + skipped is the whole stream");
    assert.ok(chars() <= 3 * cap, `bounded: ${chars()} characters posted for ${all.length}`);
});

test("200 lines of 9 MB: a few posts of at most the cap, not 1.8 GB", () => {
    const { s, posts, chars, skipped } = recorder(UI_OUT_CAP);
    const big = "x".repeat(9_000_000);
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) s.push(big + "\n");
    s.flush();
    const ms = Date.now() - t0;
    assert.ok(posts.every((p) => p.text.length <= UI_OUT_CAP), "no post larger than the cap");
    // The bound is one post per beat (plus the start, and the final flush), each at most the cap.
    assert.ok(posts.length <= 3 + Math.ceil(ms / SEND_EVERY_MS), `${posts.length} posts in ${ms}ms`);
    assert.ok(chars() < 1_000_000, `${chars()} characters posted, of 1.8 billion`);
    assert.equal(chars() + skipped(), 200 * 9_000_001);
    assert.ok(ms < 2000, `and quickly (${ms}ms)`);
});

// --- the fan counts what the sender skipped -------------------------------------------------------------------------

test("the loop's fan adds a post's `skipped` to what it reports dropped", async () => {
    const emits = [];
    let i = 0;
    const turns = [{ content: "", tool_calls: [{ id: "c1", name: "exec", arguments: {} }] }, { content: "done", tool_calls: [] }];
    await runAgentLoop("x", { tools: [{ name: "exec" }], stream: true }, {
        callModel: async () => turns[i++],
        runTool: async (_n, _a, onStream) => {
            onStream("a".repeat(UI_OUT_CAP), 1);
            await tick(SEND_EVERY_MS + 20);
            onStream("b".repeat(100), 2, 5000);   // 5,000 characters left out by the sender before these
            await tick(150);
            return { result: "ok" };
        },
        approve: async () => true,
        buildMessages: (t) => [{ role: "user", content: t }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        emit: (ev) => emits.push(ev),
    });
    const last = emits.filter((e) => e.streamOutput != null && e.tool == null).at(-1).streamOutput;
    assert.match(last, /\[\+5100 chars\]$/, "the skipped 5,000 and the 100 past the cap");
});
