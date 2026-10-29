// Chats the worker hosts with no page behind them (src/sw-chat.ts): the events one turn emits, what a failed or
// cancelled turn leaves in the history, what survives an eviction through storage, and the memory cap.
import test from "node:test";
import assert from "node:assert/strict";
import {
    backgroundChats, cancelBackgroundChat, configureBackgroundChats, forgetBackgroundChat, isBackgroundChat,
    sendBackgroundChat, startBackgroundChat, MAX_BG_CHATS,
} from "../src/sw/sw-chat.ts";

// A hung turn would otherwise hang the runner rather than fail the test.
const T = { timeout: 5000 };

/** A worker whose model call, storage and clock are scriptable. `answer` may resolve, reject, or wait. `stream`, when
 *  given, is the worker's streamed call (a turn then takes it instead of `call`), and `clock` the worker's clock. */
function world({ answer, stream, clock, plan, read } = {}) {
    const events = [];
    const stored = new Map();
    let pending = null;
    const deps = {
        emit: (e) => events.push(e),
        call: (req, signal) => {
            if (answer) return answer(req, signal);
            return Promise.resolve({ content: `re: ${req.messages.at(-1).content}`, model: "m1" });
        },
        ...(stream ? { stream } : {}),
        load: async (hash) => stored.get(hash) ?? null,
        save: async (hash, session) => { stored.set(hash, session); },
        now: clock ?? (() => 1000),
        // Where images go: to the model unless a test says otherwise; `asked` records each question.
        images: async (model, forced) => { asked.push({ model, forced }); return plan ? plan(model, forced) : { route: "model" }; },
        read: read ?? (async (image, reader) => `${reader} read ${image.length} chars`),
    };
    const asked = [];
    configureBackgroundChats(deps);
    for (const hash of backgroundChats()) forgetBackgroundChat(hash);   // the module's map is worker-wide
    return {
        events, stored, deps, asked,
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

// --- a streamed turn: live chat-stream previews, superseded by the result ---

test("a streamed turn previews its reply as it is written, throttled, and the result follows", T, async () => {
    let t = 1000;
    const w = world({
        clock: () => t,
        stream: async (_req, onDelta) => {
            onDelta({ reasoning: "hmm " });
            t += 100; onDelta({ content: "Hel" });
            t += 10; onDelta({ content: "lo" });          // inside the window: held, and folded into the next preview
            t += 100; onDelta({ content: " there" });
            return { content: "Hello there", reasoning: "hmm ", model: "m1" };
        },
    });
    const hash = await startBackgroundChat({ text: "hi" });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");

    assert.deepEqual(w.kinds(), ["chat", "chat-stream", "chat-stream", "chat-stream", "chat-result"]);
    const [start] = w.events;
    assert.equal(start.streaming, true, "the turn says it streams");
    const previews = w.of("chat-stream");
    // Every preview is the turn's (one id, so the index can supersede them) and transient.
    for (const p of previews) { assert.equal(p.id, start.id); assert.equal(p.save, false); assert.equal(p.session.hash, hash); }
    // ACCUMULATED, not deltas: each carries everything so far, so a reader that missed one is not behind.
    assert.deepEqual(previews.map((p) => [p.reasoning ?? null, p.content ?? null]), [["hmm ", null], ["hmm ", "Hel"], ["hmm ", "Hello there"]]);
    assert.equal(w.of("chat-result")[0].content, "Hello there");
    assert.deepEqual(w.stored.get(hash).messages.map((m) => m.content), ["hi", "Hello there"]);
});

test("a turn with no streamed call falls back to the one-shot call and says it does not stream", T, async () => {
    const w = world();
    await startBackgroundChat({ text: "hi" });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");
    assert.equal(w.of("chat")[0].streaming, false);
    assert.equal(w.of("chat-stream").length, 0);
});

test("cancelling mid-stream aborts the call, stops the previews and ends the turn as an error", T, async () => {
    let t = 1000, push = null, aborted = null;
    const w = world({
        clock: () => t,
        stream: (_req, onDelta, signal) => {
            push = onDelta; aborted = signal;
            onDelta({ content: "partial" });
            return w.hold();
        },
    });
    const hash = await startBackgroundChat({ text: "long one" });
    await until(() => w.of("chat-stream").length === 1, "the first preview");

    assert.equal(cancelBackgroundChat(hash), true);
    assert.equal(aborted.aborted, true, "the streamed fetch's signal is aborted");
    // Pieces already in flight still arrive; none of them may reach the transcript of a turn the person stopped.
    t += 1000; push({ content: " and more" });
    w.release({ content: "partial and more" });
    await until(() => w.of("chat-error").length === 1, "the cancel to land");
    assert.equal(w.of("chat-stream").length, 1);
    assert.equal(w.of("chat-result").length, 0);
});

// The session hash itself (contract-run.ts). It names a session in the index, keys its stored record, and names it
// in an archive that outlives every index it was ever in — so its width is a property worth pinning, not an
// incidental of how it is generated.
test("a session hash is long enough to stay unique, and short where it is read", async () => {
    const { shortHash, HASH_SHOWN } = await import("../src/contract/contract-run.ts");
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

// --- attached text files (docs/spec/FILE_ATTACHMENTS.md, slice 1) ---

const NOTES = { name: "notes.md", type: "text/markdown", text: "# todo\n- ship\n" };

test("a chat started with files sends the model the typed words and the file's block, and the event keeps the two apart", T, async () => {
    const w = world();
    await startBackgroundChat({ text: "summarise", files: [NOTES] });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");

    const block = '<file name="notes.md" type="text/markdown" bytes="14">\n# todo\n- ship\n</file>';
    const [start] = w.of("chat");
    assert.equal(start.request.messages.at(-1).content, `summarise\n\n${block}`, "what the model got, exactly");
    assert.deepEqual(start.display, { typed: "summarise", context: [{ kind: "file", file: { name: "notes.md", type: "text/markdown", bytes: 14, lines: 2 } }] });
    assert.equal(w.of("chat-result")[0].content, `re: summarise\n\n${block}`, "the fake model echoes what it was sent");
});

test("a later turn sends the files again as part of the history, and a message of only a file is a turn", T, async () => {
    const w = world();
    const hash = await startBackgroundChat({ text: "read this", files: [NOTES] });
    await until(() => w.of("chat-result").length === 1, "turn 1");
    assert.equal(await sendBackgroundChat(hash, "", undefined, [{ name: "b.txt", type: "text/plain", text: "more" }]), "turn");
    await until(() => w.of("chat-result").length === 2, "turn 2");

    const second = w.of("chat")[1];
    assert.equal(second.request.messages[0].content.includes('<file name="notes.md"'), true, "the first turn's file is still in the history the model reads");
    assert.equal(second.request.messages.at(-1).content, '<file name="b.txt" type="text/plain" bytes="4">\nmore\n</file>');
    assert.equal(second.display.typed, "");
    assert.ok(w.stored.get(hash).messages[0].content.includes("<file name=\"notes.md\""), "saved with the files, so a resume has them");
});

test("a turn without files is unchanged: no display on the event, the typed text is the message", T, async () => {
    const w = world();
    await startBackgroundChat({ text: "plain" });
    await until(() => w.of("chat-result").length === 1, "the turn to finish");
    assert.equal("display" in w.of("chat")[0], false);
    assert.equal(w.of("chat")[0].request.messages.at(-1).content, "plain");
});

// --- images: to the model, to a reader, named, or refused before anything is sent (src/image-gate.ts) ---

const PNG = "data:image/png;base64,AAAA";

test("a chat whose images may not be sent is refused before it starts: no chat, no event, no model call", T, async () => {
    let calls = 0;
    const w = world({ plan: () => ({ route: "refused", message: "This model may not see images." }), answer: async () => { calls++; return { content: "x" }; } });
    await assert.rejects(startBackgroundChat({ text: "what is this", images: [PNG], model: "cloud-x" }), { name: "ImagesRefused", message: "This model may not see images." });
    assert.deepEqual(backgroundChats(), []);
    assert.deepEqual(w.events, []);
    assert.equal(calls, 0);
    assert.deepEqual(w.asked, [{ model: "cloud-x", forced: false }]);
});

test("a later message refused for its images leaves the chat idle and its history untouched", T, async () => {
    let refuse = false;
    const w = world({ plan: () => (refuse ? { route: "refused", message: "no" } : { route: "model" }) });
    const hash = await startBackgroundChat({ text: "hi" });
    await until(() => w.of("chat-result").length === 1, "turn 1");
    refuse = true;
    await assert.rejects(sendBackgroundChat(hash, "and this?", [PNG]), { name: "ImagesRefused" });
    assert.equal(w.of("chat").length, 1, "no second turn was started");
    refuse = false;
    assert.equal(await sendBackgroundChat(hash, "plain words"), "turn", "the chat is not left busy");
});

test("vision: true is passed to the question as the person's word, on start and on send", T, async () => {
    const w = world();
    const hash = await startBackgroundChat({ text: "look", images: [PNG], vision: true });
    await until(() => w.of("chat-result").length === 1, "turn 1");
    assert.equal(await sendBackgroundChat(hash, "again", [PNG], undefined, true), "turn");
    await until(() => w.of("chat-result").length === 2, "turn 2");
    assert.deepEqual(w.asked.map((a) => a.forced), [true, true]);
});

test("a message without images asks nothing", T, async () => {
    const w = world({ plan: () => ({ route: "refused", message: "no" }) });
    await startBackgroundChat({ text: "words only" });
    await until(() => w.of("chat-result").length === 1, "the turn");
    assert.deepEqual(w.asked, []);
});

test("to the model: the images ride on the message and on the event", T, async () => {
    const w = world();
    await startBackgroundChat({ text: "see", images: [PNG] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const [start] = w.of("chat");
    assert.deepEqual(start.request.messages.at(-1).images, [PNG]);
    assert.deepEqual(start.request.images, [PNG]);
});

test("to a reader: the model gets each reading, credited to the reader, and no pixels", T, async () => {
    const w = world({ plan: () => ({ route: "reader", reader: "llava" }), read: async (image, reader) => `text of ${image === PNG ? "png" : "?"} by ${reader}` });
    await startBackgroundChat({ text: "what does it say", images: [PNG, PNG] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const [start] = w.of("chat");
    const msg = start.request.messages.at(-1);
    assert.equal(msg.images, undefined);
    assert.equal(start.request.images, null);
    assert.equal(msg.content, "what does it say\n\n[Pasted image 1: you can't see images, so llava transcribed its text:]\ntext of png by llava\n\n[Pasted image 2: you can't see images, so llava transcribed its text:]\ntext of png by llava");
});

test("to a reader that fails: the note says the image could not be read, and the turn still runs", T, async () => {
    const w = world({ plan: () => ({ route: "reader", reader: "llava" }), read: async () => { throw new Error("down"); } });
    await startBackgroundChat({ text: "", images: [PNG] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    assert.equal(w.of("chat")[0].request.messages.at(-1).content, "[Pasted image: you can't see images, so llava transcribed its text:]\n(could not read the image)");
});

test("named: a model known not to see, with no reader, is told each image was not sent", T, async () => {
    const w = world({ plan: () => ({ route: "named" }) });
    await startBackgroundChat({ text: "here", images: [PNG] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const msg = w.of("chat")[0].request.messages.at(-1);
    assert.equal(msg.images, undefined);
    assert.equal(msg.content, "here\n\n[Pasted image was not sent: you can't see images, and no reader model is set to read it.]");
});
