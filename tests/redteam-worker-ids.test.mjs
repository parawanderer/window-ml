// redteam-worker-ids.test.mjs — what one Python worker must NOT get from ANOTHER principal's pending run. The
// offscreen document matches every worker message against `pending` by its numeric id alone (src/offscreen.ts, the
// worker's onmessage), and ids are the document's own small sequential counter, so the question is whether a worker
// that can post can name a run it was never asked to run. A FULL (never locked down) worker's cell can: `import js`
// is intact there (tests/python.test.mjs, "FULL mode leaves the js bridge intact"), so `js.self.postMessage` reaches
// the document. The three effects a forged id would buy are the three below: it can ANSWER another run (the victim's
// model sees forged tool output), STREAM into another run's live stdout (the page shows text the victim never
// printed), and MAKE the victim run's `ml` wire call (the call runs under the victim's client and run id, and the
// immediate answer is posted back to the attacker's worker). Each row carries its own positive control on the
// sender's OWN id, so a refusal row cannot pass because the reply shape stopped parsing. The refusal is not silence:
// it is recorded once (HOUSEKEEPING_REPORT, kind "foreign-id", with nothing of the message) and an `ml` call is
// answered to its sender as a cell with no wire, so a forged call cannot hang. Tests/offscreen-worker-ids.test.mjs
// (async's) enumerates the handler's branches; these three are the effects.
//
// The offscreen document is imported for real under a mocked `chrome` and fake Workers, as python-reap.test.mjs does.
import { test } from "node:test";
import assert from "node:assert/strict";

const listeners = [];
const sent = [];   // chrome.runtime.sendMessage payloads (this document talking to the service worker)
const workers = [];
class FakeWorker {
    constructor() { this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(m) { this.posts.push(m); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
globalThis.chrome = {
    runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (m) => { sent.push(m); return Promise.resolve(undefined); },
    },
};
await import("../src/offscreen.ts");

const send = (msg) => new Promise((resolve) => {
    for (const fn of listeners) { if (fn(msg, { id: "test" }, resolve) === true) return; }
    resolve(undefined);
});
/** Let promises and posted replies settle. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/**
 * Start one run on its own principal and return its worker, the id the document gave it, and the answer promise.
 * `noTimeout` keeps the real start timer out of a test that never finishes the run.
 */
function start(letter) {
    const before = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", hardened: false, tables: null, noTimeout: true,
        principal: `run:${letter}`, wire: { client: `c${letter}`, run: letter }, stream: true, streamId: `stream-${letter}` });
    return settle().then(() => {
        const w = workers.find((x) => x.posts.length > (before.get(x) ?? 0));
        assert.ok(w, `no worker was asked to run ${letter}`);
        const id = w.posts.at(-1).id;
        assert.equal(typeof id, "number", `the ${letter} run got no numeric id`);
        return { w, id, answer };
    });
}
/** Whether a promise has settled, after letting the microtask queue drain. */
async function settled(p) {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    await settle();
    return done;
}

// --- a reply carrying another principal's id does not answer the run it names ---

test("RED TEAM (worker ids): a worker's reply is matched to a run it was asked to run, not to any pending id", async () => {
    const A = await start("a");
    const B = await start("b");
    assert.notEqual(A.id, B.id);
    // Positive control: the sender's own id answers its own run, so the reply shape is one the document takes.
    A.w.reply({ id: A.id, ok: true, stdout: "own", result: null, error: null });
    assert.equal(await settled(A.answer), true, "control: the reply to A's own id did not answer A");
    assert.equal(await settled(B.answer), false, "control: the reply to A's id answered B's run");
    // The forgery: A's worker answers B's run.
    sent.length = 0;
    A.w.reply({ id: B.id, ok: true, stdout: "FORGED BY A", result: "forged", error: null });
    assert.equal(await settled(B.answer), false, "A's worker answered B's run: its model now sees forged tool output");
    // Refused, not silently dropped: the refusal is recorded once, with nothing of the message.
    assert.ok(sent.some((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload?.kind === "foreign-id" && m.payload?.reason === "result"), "the foreign-id refusal left no record");
});

// --- a live stdout chunk carrying another principal's id does not reach that run's stream ---

test("RED TEAM (worker ids): a stream chunk answers only a run the posting worker was asked to run", async () => {
    const A = await start("a");
    const B = await start("b");
    // Positive control: A's own chunk reaches A's stream.
    A.w.reply({ id: A.id, partial: true, chunk: "own", ts: 1 });
    await settle();
    assert.ok(sent.some((m) => m.type === "PY_STDOUT" && m.streamId === "stream-a" && m.chunk === "own"), "control: A's own chunk did not reach A's stream");
    sent.length = 0;
    // The forgery: A's worker streams into B's run.
    A.w.reply({ id: B.id, partial: true, chunk: "FORGED BY A", ts: 1 });
    await settle();
    assert.deepEqual(sent.filter((m) => m.type === "PY_STDOUT" && m.streamId === "stream-b"), [], "A's worker streamed into B's run");
});

// --- an `ml` wire call carrying another principal's id does not run as that run ---

test("RED TEAM (worker ids): the ml wire answers the client and run the document stamped, never one a message names", async () => {
    const A = await start("a");
    const B = await start("b");
    // Positive control: a call on A's own id is stamped with A's client and run.
    A.w.reply({ id: A.id, mlCall: { seq: 1, call: "fetch", args: [] } });
    await settle();
    assert.ok(sent.some((m) => m.type === "ML_CALL" && m.client === "ca" && m.run === "a"), "control: A's own call was not stamped with A's client and run");
    sent.length = 0;
    // The forgery: A's worker makes B's run's call, under B's client and run id.
    A.w.reply({ id: B.id, mlCall: { seq: 1, call: "fetch", args: [] } });
    await settle();
    assert.deepEqual(sent.filter((m) => m.type === "ML_CALL" && m.run === "b"), [], "A's worker made B's run's ml call, answered under B's client");
    // And the sender is answered as a cell with no wire, so a forged call refuses instead of hanging.
    assert.ok(A.w.posts.some((m) => m.mlAnswer?.answer?.error?.code === "Refused"), "the forged call was not answered to its sender as a no-wire refusal");
});
