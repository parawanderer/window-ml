// The session-command relay: a command from the worker reaches the page, and the page answers it.
//
// Worth its own file because the two halves used to be inline branches in two different listeners of
// shell.ts and could not be reached from a test at all. What is checked here is the JOIN between them — the
// waiter map — and specifically its failure modes, which are silent in production: a page that never answers
// must still resolve the background's call, and an answer that arrives twice must not resolve it twice.
import test from "node:test";
import assert from "node:assert";

const posted = [];
globalThis.window = { postMessage: (m) => posted.push(m) };

const { onSessionDone, relaySessionToPage, relayStartAgent } = await import("../src/sidebar/shell-session-relay.ts");

const reset = () => { posted.length = 0; };

test("a steer command reaches the page and waits for the page's answer", async () => {
    reset();
    let replied;
    const async_ = relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "send", hash: "abc12345", text: "hi", reqId: "r1" }, (r) => { replied = r; });
    assert.equal(async_, true, "a reqId means the reply comes later");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].__mlSessionSend.hash, "abc12345");
    assert.equal(posted[0].__mlSessionSend.reqId, "r1");
    assert.equal(replied, undefined, "nothing is answered until the page says what it did");

    onSessionDone({ reqId: "r1", outcome: "sent", hash: "abc12345" });
    assert.deepEqual(replied, { outcome: "sent", hash: "abc12345" });
});

test("the DevTools composer sends no reqId, so the reply channel is not held open", () => {
    reset();
    const async_ = relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "cancel", hash: "abc12345" }, () => {
        assert.fail("a composer command asks for no answer");
    });
    assert.equal(async_, false);
    assert.equal(posted[0].__mlCancelSession.hash, "abc12345");
    assert.equal(posted[0].__mlCancelSession.reqId, undefined);
});

test("an unrecognised action posts nothing", () => {
    reset();
    const async_ = relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "explode", hash: "abc12345", reqId: "r2" }, () => {
        assert.fail("nothing was relayed, so nothing answers");
    });
    assert.equal(async_, false);
    assert.equal(posted.length, 0);
});

test("a page that never answers still resolves the background's call, as no-answer", async () => {
    reset();
    let replied;
    relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "continue", hash: "abc12345", reqId: "r3" }, (r) => { replied = r; });
    await new Promise((r) => setTimeout(r, 3200));   // SESSION_DONE_MS is 3s
    assert.deepEqual(replied, { outcome: "no-answer" }, "a page whose window.ml never loaded must not hang the caller");
});

test("a second answer for the same request is ignored", async () => {
    reset();
    const replies = [];
    relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "send", hash: "abc12345", text: "x", reqId: "r4" }, (r) => replies.push(r));
    onSessionDone({ reqId: "r4", outcome: "sent" });
    onSessionDone({ reqId: "r4", outcome: "sent" });
    assert.equal(replies.length, 1);
});

test("an answer for an unknown request is dropped rather than throwing", () => {
    assert.equal(onSessionDone({ reqId: "never-asked", outcome: "sent" }), true);
    assert.equal(onSessionDone(undefined), true);
});

test("agent.start carries the shell's hud setting and the caller's fields, dropping the ones it did not send", () => {
    reset();
    let replied;
    const async_ = relayStartAgent({ type: "ML_START_AGENT", reqId: "s1", task: "do it", maxSteps: 4, model: "  m1  ", stream: true }, (r) => { replied = r; }, "quiet");
    assert.equal(async_, true);
    const sent = posted[0].__mlStartAgent;
    assert.equal(sent.task, "do it");
    assert.equal(sent.maxSteps, 4);
    assert.equal(sent.model, "m1", "a model id is trimmed");
    assert.equal(sent.stream, true);
    assert.equal(sent.vision, undefined, "not requested, so not asserted as false");
    assert.equal(sent.hud, "quiet", "the shell owns the hud setting and passes it in");

    onSessionDone({ reqId: "s1", outcome: "started", hash: "deadbeef" });
    assert.deepEqual(replied, { outcome: "started", hash: "deadbeef" });
});
