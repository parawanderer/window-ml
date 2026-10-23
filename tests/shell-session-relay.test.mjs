// The session-command relay: a command from the worker reaches the page, and the page answers it.
//
// Worth its own file because the two halves used to be inline branches in two different listeners of
// shell.ts and could not be reached from a test at all. What is checked here is the JOIN between them — the
// waiter map — and specifically its failure modes, which are silent in production: a page that never answers
// must still resolve the background's call, and an answer that arrives twice must not resolve it twice.
import test from "node:test";
import assert from "node:assert";

// What the relay sends injected.js: with no port handed over yet, the page channel holds it in its queue (page-channel.ts).
// The hand-off listener is kept, so the last section can play a page that hands over a port of its own.
let portListener = null;
globalThis.window = { addEventListener: (type, f) => { if (type === "ml-page-port") portListener = f; } };

const { onSessionDone, relaySessionToPage } = await import("../src/sidebar/shell-session-relay.ts");
const { listenForPage } = await import("../src/page-channel.ts");
listenForPage();
const posted = globalThis.__mlPageChannel.queue;

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

test("a continue carries the step budget to the page, and only a real one", () => {
    reset();
    relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "continue", hash: "abc12345", maxSteps: 50, reqId: "rb" }, () => {});
    assert.equal(posted[0].__mlContinueRun.maxSteps, 50, "a chosen budget reaches the page beside the hash");
    // Anything that is not a positive number is simply not forwarded: the run then keeps the cap it had, which is
    // what Continue did before a budget existed. Passing it through would put junk in front of the loop.
    for (const bad of [undefined, null, 0, -5, 2.5, NaN, "50"]) {   // "50" too: the runtime refuses a string, so this must not take one
        reset();
        relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "continue", hash: "abc12345", maxSteps: bad, reqId: "rb" }, () => {});
        assert.equal("maxSteps" in posted[0].__mlContinueRun, false, `${String(bad)} must not be forwarded`);
    }
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

// --- a hidden page (closed gate) and the page channel ---
// LAST in this file: it hands the isolated side a port, after which nothing goes to `posted` (the queue) any more.

test("a session command sent to a hidden page reaches no port the page holds, now or once one arrives", { todo: "relaySessionToPage (shell-session-relay.ts) calls toPage without gateOpen(), unlike every other shell and content.js send: on a hidden page (the chat page or the DevTools composer sending to a tab that has since navigated to a hidden origin) the person's text is queued on the isolated side and flushed to the first port handed over, which a hidden page can hand over itself at any time (page-channel.ts takes the first). Before step 2b it went straight onto the hidden page's window. Fix: guard the three sends with gateOpen() and answer `none` at once." }, async () => {
    const { setGate } = await import("../src/page-gate.ts");
    const { FakeMessageChannel, FakeMessageEvent } = (await import("./helpers.js")).default;
    reset();
    setGate(false);   // the worker said this page is hidden
    relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "send", hash: "abc12345", text: "SECRET-before", reqId: "h1" }, () => {});
    // The hidden page hands over a port of its own (no injected.js here to have done it first).
    const ch = new FakeMessageChannel(), heard = [];
    ch.port1.onmessage = (e) => heard.push(e.data);
    portListener(new FakeMessageEvent("ml-page-port", { ports: [ch.port2] }));
    relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "send", hash: "abc12345", text: "SECRET-after", reqId: "h2" }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    const hiddenHeard = JSON.stringify(heard);
    // Positive control: once the gate opens (a run the person started there), the same command does reach that port.
    setGate(true);
    relaySessionToPage({ type: "ML_SESSION_TO_PAGE", action: "send", hash: "abc12345", text: "OPEN-now" }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.match(JSON.stringify(heard), /OPEN-now/, "positive control: the port is the isolated side's");
    assert.doesNotMatch(hiddenHeard, /SECRET/, "the person's text reached a hidden page");
});
