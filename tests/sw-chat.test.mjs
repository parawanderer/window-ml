// Chats the worker hosts with no page behind them (src/sw-chat.ts): the events one turn emits, what a failed or
// cancelled turn leaves in the history, what survives an eviction through storage, and the memory cap.
import test from "node:test";
import assert from "node:assert/strict";
import {
    backgroundChats, cancelBackgroundChat, configureBackgroundChats, forgetBackgroundChat, isBackgroundChat,
    sendBackgroundChat, startBackgroundChat, MAX_BG_CHATS,
} from "../src/sw-chat.ts";

// A hung turn would otherwise hang the runner rather than fail the test.
const T = { timeout: 5000 };

/** A worker whose model call, storage and clock are scriptable. `answer` may resolve, reject, or wait. */
function world({ answer } = {}) {
    const events = [];
    const stored = new Map();
    let pending = null;
    const deps = {
        emit: (e) => events.push(e),
        call: (req, signal) => {
            if (answer) return answer(req, signal);
            return Promise.resolve({ content: `re: ${req.messages.at(-1).content}`, model: "m1" });
        },
        load: async (hash) => stored.get(hash) ?? null,
        save: async (hash, session) => { stored.set(hash, session); },
        now: () => 1000,
    };
    configureBackgroundChats(deps);
    for (const hash of backgroundChats()) forgetBackgroundChat(hash);   // the module's map is worker-wide
    return {
        events, stored, deps,
        kinds: () => events.map((e) => e.kind),
        of: (kind) => events.filter((e) => e.kind === kind),
        hold: () => new Promise((resolve) => { pending = resolve; }),
        release: (value) => pending(value),
    };
}

/** Wait until `fn()` is true, so a test never races the turn it started. */
async function until(fn, what) {
    for (let i = 0; i < 200; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
}

test("a started chat emits its turn, keeps the history and saves it", T, async () => {
    const w = world();
    const hash = await startBackgroundChat({ text: "hello", system: "be terse" });

    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.equal(isBackgroundChat(hash), true);
    await until(() => w.of("chat-result").length === 1, "the turn to finish");

    assert.deepEqual(w.kinds(), ["chat", "chat-result"]);
    const [start, result] = w.events;
    // One id across the start and its result: the index closes the open turn by it.
    assert.equal(start.id, result.id);
    assert.equal(start.id, `${hash}-1`);
    assert.equal(start.session.hash, hash);
    assert.equal(start.session.turn, 1);
    assert.equal(start.streaming, false);
    assert.equal(start.config.system, "be terse");
    // The system prompt leads the request, then the person's message.
    assert.deepEqual(start.request.messages.map((m) => m.role), ["system", "user"]);
    assert.equal(result.content, "re: hello");
    assert.equal(result.model, "m1");

    const saved = w.stored.get(hash);
    assert.equal(saved.save, true);
    assert.deepEqual(saved.messages.map((m) => m.role), ["system", "user", "assistant"]);
});

test("an ephemeral chat is never written to storage", T, async () => {
    const w = world();
    const hash = await startBackgroundChat({ text: "hi", ephemeral: true });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");
    assert.equal(w.stored.size, 0);
    assert.equal(w.events[0].save, false);
});

test("a second message is the next turn, and one mid-turn is busy", T, async () => {
    const w = world({ answer: () => w.hold() });
    const hash = await startBackgroundChat({ text: "one" });
    await until(() => w.of("chat").length === 1, "the first turn to start");

    assert.equal(await sendBackgroundChat(hash, "while it thinks"), "busy");

    w.release({ content: "first answer" });
    await until(() => w.of("chat-result").length === 1, "the first turn to finish");

    assert.equal(await sendBackgroundChat(hash, "two"), "turn");
    await until(() => w.of("chat").length === 2, "the second turn to start");
    const second = w.of("chat")[1];
    assert.equal(second.id, `${hash}-2`);
    assert.equal(second.session.turn, 2);
    // The second turn carries the first turn's answer back to the model.
    assert.deepEqual(second.request.messages.map((m) => m.role), ["user", "assistant", "user"]);
    w.release({ content: "second answer" });
});

test("a failed turn reports the error and does not keep the message it could not answer", T, async () => {
    const w = world({ answer: async () => { throw new Error("the backend is down"); } });
    const hash = await startBackgroundChat({ text: "hello" });
    await until(() => w.of("chat-error").length === 1, "the turn to fail");

    assert.deepEqual(w.kinds(), ["chat", "chat-error"]);
    assert.match(w.of("chat-error")[0].error, /backend is down/);
    assert.equal(w.stored.has(hash), false);

    // The next turn starts from an empty history, not from a question the model never answered.
    assert.equal(await sendBackgroundChat(hash, "again"), "turn");
    await until(() => w.of("chat").length === 2, "the retry to start");
    assert.deepEqual(w.of("chat")[1].request.messages.map((m) => m.content), ["again"]);
});

test("a cancelled turn ends as an error and never reports the answer that arrived late", T, async () => {
    const w = world({ answer: () => w.hold() });
    const hash = await startBackgroundChat({ text: "long one" });
    await until(() => w.of("chat").length === 1, "the turn to start");

    assert.equal(cancelBackgroundChat(hash), true);
    assert.equal(cancelBackgroundChat(hash), false, "nothing is running any more");

    // The model answers anyway, as a fetch that was already in flight does.
    w.release({ content: "too late" });
    await until(() => w.of("chat-error").length === 1, "the cancel to land");
    assert.equal(w.of("chat-result").length, 0);
    assert.equal(w.stored.has(hash), false);
});

test("a saved chat comes back from storage after the worker forgot it", T, async () => {
    const w = world();
    const hash = await startBackgroundChat({ text: "hello" });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");

    forgetBackgroundChat(hash);   // what an eviction leaves behind: storage, and nothing in memory
    assert.equal(isBackgroundChat(hash), false);

    assert.equal(await sendBackgroundChat(hash, "still there?"), "turn");
    await until(() => w.of("chat").length === 2, "the turn after the eviction");
    const revived = w.of("chat")[1];
    // The history is the stored one, and the turn number counts on from the answers in it rather than restarting
    // at 1, which would give two different turns the same id.
    assert.deepEqual(revived.request.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(revived.id, `${hash}-2`);
});

test("an ephemeral chat the worker forgot is gone", T, async () => {
    const w = world();
    const hash = await startBackgroundChat({ text: "hi", ephemeral: true });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");
    forgetBackgroundChat(hash);
    assert.equal(await sendBackgroundChat(hash, "hello?"), "not-found");
});

test("the map stays under its cap, dropping the chat idle longest", T, async () => {
    const w = world();
    const first = await startBackgroundChat({ text: "one", ephemeral: true });
    await until(() => w.of("chat-result").length === 1, "the first chat to answer");
    for (let i = 0; i < MAX_BG_CHATS; i++) await startBackgroundChat({ text: `n${i}`, ephemeral: true });
    assert.ok(backgroundChats().length <= MAX_BG_CHATS, `${backgroundChats().length} chats held`);
    assert.equal(isBackgroundChat(first), false, "the oldest idle chat is the one dropped");
});

// The session hash itself (contract-run.ts). It names a session in the index, keys its stored record, and names it
// in an archive that outlives every index it was ever in — so its width is a property worth pinning, not an
// incidental of how it is generated.
test("a session hash is long enough to stay unique, and short where it is read", async () => {
    const { shortHash, HASH_SHOWN } = await import("../src/contract-run.ts");
    const one = shortHash();
    assert.match(one, /^[0-9a-f]{32}$/, "128 bits of hex");
    // Distinct across a sample that would be a coin flip at the old 32 bits: at 2^32 a collision is about even by
    // ~77k ids, and the archive is a store meant to hold years of them.
    const many = new Set(Array.from({ length: 20000 }, shortHash));
    assert.equal(many.size, 20000, "no collision in a sample the old width would not have survived");
    // Shown short, so it stays a name a person can read out; the whole thing is what resumes it.
    assert.equal(HASH_SHOWN, 8);
    assert.equal(one.slice(0, HASH_SHOWN).length, 8);
});
