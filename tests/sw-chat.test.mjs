// Chats the worker hosts with no page behind them (src/sw-chat.ts): the events one turn emits, what a failed or
// cancelled turn leaves in the history, what survives an eviction through storage, and the memory cap.
import test from "node:test";
import assert from "node:assert/strict";
import {
    backgroundChats, cancelBackgroundChat, configureBackgroundChats, forgetBackgroundChat, isBackgroundChat,
    sendBackgroundChat, startBackgroundChat, MAX_BG_CHATS, MAX_TURN_IMAGES, READER_PAGE_MAX, CHAT_PAGE_RECOVERY,
    pdfTextBudget, CHARS_PER_TOKEN, PDF_CONTEXT_SHARE, PDF_TEXT_FLOOR,
} from "../src/sw/sw-chat.ts";
import { FilesRefused, FILE_INLINE_MAX } from "../src/attached-files.ts";
import { ImagesRefused } from "../src/image-gate.ts";

// A hung turn would otherwise hang the runner rather than fail the test.
const T = { timeout: 5000 };

/** A worker whose model call, storage and clock are scriptable. `answer` may resolve, reject, or wait. `stream`, when
 *  given, is the worker's streamed call (a turn then takes it instead of `call`), and `clock` the worker's clock. */
function world({ answer, stream, clock, plan, read, pdf, ctx } = {}) {
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
        ...(pdf ? { pdf } : {}),
        // The context the model is loaded with: a number, a function of the model, or absent (not known).
        ...(ctx !== undefined ? { contextTokens: async (model) => { ctxAsked.push(model); return typeof ctx === "function" ? ctx(model) : ctx; } } : {}),
    };
    const asked = [], ctxAsked = [];
    configureBackgroundChats(deps);
    for (const hash of backgroundChats()) forgetBackgroundChat(hash);   // the module's map is worker-wide
    return {
        events, stored, deps, asked, ctxAsked,
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

// --- PDFs: read before the turn, pages drawn in it (docs/spec/FILE_ATTACHMENTS.md, "Wiring a PDF") ---

/** A read document: one page per kind given, page n's text "text of n" (a scan's is empty). */
const docOf = (...kinds) => ({ pageCount: kinds.length, pages: kinds.map((kind, i) => ({ n: i + 1, kind, text: kind === "scanned" || kind === "blank" ? "" : `text of ${i + 1}`, measure: {} })) });
/** The offscreen reader, scripted: `read` answers with `doc` (or a refusal), `render` draws page n as "png-n". */
function reader(doc, { renderFails = [] } = {}) {
    const calls = { read: 0, render: [] };
    return {
        calls,
        read: async () => { calls.read++; return doc.ok === false ? doc : { ok: true, doc }; },
        render: async (_b64, n, scale) => {
            calls.render.push({ n, scale });
            return renderFails.includes(n) ? { ok: false, code: "unreadable", refusal: "This PDF could not be read." } : { ok: true, pngB64: `png-${n}`, width: 1, height: 1, scale };
        },
    };
}
const PDF = { name: "paper.pdf", type: "application/pdf", data: "JVBERi0xLjQK" };   // "%PDF-1.4\n"
const userOf = (w) => w.of("chat")[0].request.messages.at(-1);

test("a text PDF: one <file> block of <page> sections, no vision asked, no page drawn, the chip counts pages", T, async () => {
    const r = reader(docOf("text", "blank", "ocr-scan"));
    const w = world({ pdf: r });
    await startBackgroundChat({ text: "summarise", files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const u = userOf(w);
    assert.equal(u.content, 'summarise\n\n<file name="paper.pdf" type="application/pdf" bytes="9" pages="3">\n<page n="1">\ntext of 1\n</page>\n<page n="3">\ntext of 3\n</page>\n</file>');
    assert.equal(u.images, undefined);
    assert.deepEqual(w.asked, [], "nothing would send an image, so vision is not asked");
    assert.deepEqual(r.calls.render, []);
    assert.deepEqual(w.of("chat")[0].display.context, [{ kind: "file", file: { name: "paper.pdf", type: "application/pdf", bytes: 9, lines: 0, pages: 3 } }]);
});

test("to the model: a scan is drawn and numbered after the pasted images, and the event carries every image", T, async () => {
    const r = reader(docOf("scanned", "text", "mixed"));
    const w = world({ pdf: r });
    await startBackgroundChat({ text: "", images: ["data:image/png;base64,pasted"], files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const u = userOf(w);
    assert.match(u.content, /<page n="1" image="2">\n<\/page>/);
    assert.match(u.content, /<page n="3" image="3">\ntext of 3\n<\/page>/);
    assert.deepEqual(u.images, ["data:image/png;base64,pasted", "data:image/png;base64,png-1", "data:image/png;base64,png-3"]);
    assert.deepEqual(w.of("chat")[0].request.images, u.images);
    assert.deepEqual(r.calls.render.map((c) => c.n), [1, 3]);
});

test("past the image cap: the reader reads the scans past it, and with no reader they are named with the recovery", T, async () => {
    const kinds = Array.from({ length: MAX_TURN_IMAGES + 2 }, () => "scanned");
    for (const withReader of [true, false]) {
        const w = world({ pdf: reader(docOf(...kinds)), plan: () => (withReader ? { route: "model", reader: "ocr" } : { route: "model" }) });
        await startBackgroundChat({ text: "", files: [PDF] });
        await until(() => w.of("chat-result").length === 1, "the turn");
        const u = userOf(w);
        assert.equal(u.images.length, MAX_TURN_IMAGES);
        if (withReader) {
            assert.match(u.content, /<page n="9" read-by="ocr">\nocr read \d+ chars\n<\/page>/);
            assert.doesNotMatch(u.content, /not sent/);
        } else {
            assert.ok(u.content.includes(`pages 9-10 are scans not sent as images. ${CHAT_PAGE_RECOVERY}`), u.content);
        }
    }
});

test("to a reader: each scan is read in place of its text, a figure is named, and the reader's pages are capped", T, async () => {
    const kinds = ["mixed", ...Array.from({ length: READER_PAGE_MAX + 1 }, () => "scanned")];
    const w = world({ pdf: reader(docOf(...kinds)), plan: () => ({ route: "reader", reader: "ocr" }) });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const u = userOf(w);
    assert.equal(u.images, undefined);
    assert.match(u.content, /<page n="1">\ntext of 1\n\(page 1 has a figure you cannot see\)\n<\/page>/);
    assert.equal((u.content.match(/read-by="ocr"/g) ?? []).length, READER_PAGE_MAX);
    assert.ok(u.content.includes(`page ${READER_PAGE_MAX + 2} is a scan not sent as an image. ${CHAT_PAGE_RECOVERY}`), u.content);
});

test("named: a model known not to see gets each scan named with what would read it", T, async () => {
    const w = world({ pdf: reader(docOf("scanned")), plan: () => ({ route: "named" }) });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    assert.match(userOf(w).content, /<page n="1">\n\(page 1 is a scan this model cannot see; set a reader model in Settings to have it read\)\n<\/page>/);
});

test("unknown vision, no reader: a scan refuses the message before it starts; a figure alone does not", T, async () => {
    const refused = () => ({ route: "refused", message: "may not see" });
    const w = world({ pdf: reader(docOf("scanned")), plan: refused });
    await assert.rejects(startBackgroundChat({ text: "", files: [PDF] }), (e) => e instanceof ImagesRefused && e.message === "may not see");
    assert.deepEqual(w.events, []);
    assert.deepEqual(backgroundChats(), []);

    const f = world({ pdf: reader(docOf("mixed")), plan: refused });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => f.of("chat-result").length === 1, "the turn");
    assert.match(userOf(f).content, /\(page 1 has a figure you cannot see\)/);
});

test("a page that will not draw says so in its section and takes no image number", T, async () => {
    const w = world({ pdf: reader(docOf("scanned", "scanned"), { renderFails: [1] }) });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const u = userOf(w);
    assert.match(u.content, /<page n="1">\n\(page 1 could not be drawn as an image: This PDF could not be read\.\)\n<\/page>/);
    assert.match(u.content, /<page n="2" image="1">/);
    assert.equal(u.images.length, 1);
});

test("refused before the turn: a PDF that will not read, or no reader at all", T, async () => {
    const cases = [
        [reader({ ok: false, code: "encrypted", refusal: "This PDF is password protected, so it cannot be read." }), "paper.pdf: This PDF is password protected, so it cannot be read."],
        [undefined, "paper.pdf is a PDF, which this runtime does not read"],
    ];
    for (const [pdf, why] of cases) {
        const w = world({ pdf });
        await assert.rejects(startBackgroundChat({ text: "", files: [PDF] }), (e) => e instanceof FilesRefused && (typeof why === "string" ? e.message === why : why.test(e.message)));
        assert.deepEqual(w.events, []);
    }
});

test("a later message with a PDF is read before its turn, and a refusal leaves the chat idle", T, async () => {
    const r = reader({ ok: false, code: "damaged", refusal: "This PDF is damaged or incomplete, so it cannot be read." });
    const w = world({ pdf: r });
    const hash = await startBackgroundChat({ text: "hi" });
    await until(() => w.of("chat-result").length === 1, "the first turn");
    await assert.rejects(sendBackgroundChat(hash, "", undefined, [PDF]), FilesRefused);
    assert.equal(w.of("chat").length, 1);
    assert.equal(await sendBackgroundChat(hash, "again"), "turn");
});

// --- PDF pages past the text a message takes: sent in order while they fit, the rest named ---

/** A document of text pages, page n's text `len` characters of its digit. */
const textDoc = (...lens) => ({ pageCount: lens.length, pages: lens.map((len, i) => ({ n: i + 1, kind: "text", text: String(i + 1).repeat(len), measure: {} })) });

test("the budget is half the loaded context at 3.5 characters a token, with a floor, and slice 1's cap when not known", () => {
    assert.equal(pdfTextBudget(null), FILE_INLINE_MAX);
    assert.equal(pdfTextBudget(0), FILE_INLINE_MAX);
    assert.equal(pdfTextBudget(32768), Math.floor(32768 * CHARS_PER_TOKEN * PDF_CONTEXT_SHARE));
    assert.equal(pdfTextBudget(32768), 57344);
    assert.equal(pdfTextBudget(1024), PDF_TEXT_FLOOR);
});

test("context not known: pages go while they fit in slice 1's cap, and the rest are named, not refused", T, async () => {
    const half = FILE_INLINE_MAX / 2;
    const w = world({ pdf: reader(textDoc(half, half, 1, 5)) });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const u = userOf(w).content;
    assert.match(u, /<page n="2">/);
    assert.doesNotMatch(u, /<page n="3">/);
    assert.match(u, /\npages 3-4 were not sent: past the text a message takes\. This chat cannot show them\.\n<\/file>$/);
    assert.match(u, /pages="4"/, "the file still says how many pages it has");
});

test("context known: the loaded model's context sizes the budget, asked for the chat's model", T, async () => {
    const big = 25_000;   // two of these pass slice 1's cap, and fit half of a 32k context (57,344)
    const w = world({ pdf: reader(textDoc(big, big, 20_000)), ctx: (m) => (m === "big" ? 32768 : null) });
    await startBackgroundChat({ text: "", files: [PDF], model: "big" });
    await until(() => w.of("chat-result").length === 1, "the turn");
    assert.deepEqual(w.ctxAsked, ["big"]);
    const u = userOf(w).content;
    assert.match(u, /<page n="2">/);
    assert.match(u, /\npage 3 was not sent: past the text a message takes\./);

    const d = world({ pdf: reader(textDoc(big, big)), ctx: () => null });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => d.of("chat-result").length === 1, "the default's turn");
    assert.deepEqual(d.ctxAsked, [null], "no model: the default is asked for");
    assert.match(userOf(d).content, /\npage 2 was not sent/, "not loaded: slice 1's cap");
});

test("text files take their share first and are still refused whole past the cap; a PDF fits in what is left", T, async () => {
    const note = { name: "notes.txt", type: "text/plain", text: "n".repeat(FILE_INLINE_MAX - 10) };
    const w = world({ pdf: reader(textDoc(10, 1)) });
    await startBackgroundChat({ text: "", files: [note, PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    const u = userOf(w).content;
    assert.match(u, /<page n="1">/);
    assert.match(u, /\npage 2 was not sent: past the text a message takes\./);

    world({ pdf: reader(textDoc(1)) });
    const huge = { name: "server.log", type: "text/plain", text: "x".repeat(FILE_INLINE_MAX + 1) };
    await assert.rejects(startBackgroundChat({ text: "", files: [huge, PDF] }), (e) => e instanceof FilesRefused && /^server\.log is too large to send whole/.test(e.message));
});

test("a scan past the cut asks no vision, draws nothing and refuses nothing", T, async () => {
    const doc = { pageCount: 2, pages: [{ n: 1, kind: "text", text: "x".repeat(FILE_INLINE_MAX + 1), measure: {} }, { n: 2, kind: "scanned", text: "", measure: {} }] };
    const r = reader(doc);
    const w = world({ pdf: r, plan: () => ({ route: "refused", message: "may not see" }) });
    await startBackgroundChat({ text: "", files: [PDF] });
    await until(() => w.of("chat-result").length === 1, "the turn");
    assert.deepEqual(w.asked, []);
    assert.deepEqual(r.calls.render, []);
    assert.equal(userOf(w).images, undefined);
    assert.match(userOf(w).content, /\npages 1-2 were not sent: past the text a message takes\./);
});
