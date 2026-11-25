// offscreen-worker-ids.test.mjs — a Python worker's message acts only on its OWN principal's pending runs (src/offscreen.ts,
// the per-worker `onmessage`). `pending` is one map over every principal, keyed by a sequential id any worker can name,
// so before this a full-mode cell could post under another principal's id and answer its run, write into its stream, or
// call `ml` with its client and run stamp (e4's audit; the behavioural rows are tests/redteam-worker-ids.test.mjs).
//
// One row per branch of the handler that reads an entry, and a row that the table IS the handler's branches: a branch
// added later without the check fails here rather than passing a sample. The offscreen document is imported for real
// under a mocked `chrome`, fake Workers and mocked timers, as python-reap.test.mjs does.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

mock.timers.enable({ apis: ["setTimeout"] });

const listeners = [];
const sent = [];   // chrome.runtime.sendMessage payloads (the document talking to the service worker)
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
const { SPEND_KILLED } = await import("../src/offscreen.ts");

const send = (msg) => new Promise((resolve) => {
    for (const fn of listeners) { if (fn(msg, { id: "test" }, resolve) === true) return; }
    resolve(undefined);
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
let n = 0;

/** Post one cell and leave it pending: its worker, its id, and the promise of the document's answer. */
async function pendingCell(msg) {
    const before = new Map(workers.map((w) => [w, w.posts.length]));
    const answer = send({ type: "PY_RUN", code: "pass", tables: null, ...msg });
    let settled = false;
    answer.then(() => { settled = true; });
    await settle();
    const w = workers.find((x) => x.posts.length > (before.get(x) ?? 0));
    return { w, id: w.posts.at(-1).id, answer, settled: () => settled };
}

/** A victim: a worker-hosted run's leased cell with a stream and a wire. An attacker: a full-mode cell of another principal. */
async function pair() {
    const k = ++n;
    const victim = await pendingCell({ principal: `run:victim${k}`, hardened: true, wire: { client: `mlw-victim${k}`, run: `victim${k}` }, stream: true, streamId: `s-victim${k}`, cell: `cell-victim${k}` });
    const attacker = await pendingCell({ principal: `own-attacker${k}`, hardened: false });
    sent.length = 0;
    return { victim, attacker, k };
}
const foreignRecords = () => sent.filter((m) => m.type === "HOUSEKEEPING_REPORT" && m.payload.kind === "foreign-id");

/** Each branch that reads an entry: the message, and what it would do to the run it names were the id honoured. */
const BRANCHES = {
    partial: {
        msg: (id) => ({ id, partial: true, chunk: "PLANTED" }),
        effect: ({ k }) => sent.some((m) => m.type === "PY_STDOUT" && m.streamId === `s-victim${k}`),
    },
    spending: {
        msg: (id) => ({ id, spending: true }),
        // The victim's kill names the cancel's spend only if its entry was marked: let it start, then time out.
        effect: async ({ victim }) => {
            victim.w.reply({ id: victim.id, started: true });
            mock.timers.tick(24 * 60 * 60_000);
            await settle();
            return (await victim.answer).error === SPEND_KILLED;
        },
    },
    started: {
        msg: (id) => ({ id, started: true }),
        effect: ({ k }) => sent.some((m) => m.type === "PY_STARTED" && m.cell === `cell-victim${k}`),
    },
    mlCall: {
        msg: (id) => ({ id, mlCall: { seq: 1, call: "fetch", args: ["https://evil.example/"] } }),
        effect: ({ k }) => sent.some((m) => m.type === "ML_CALL" && (m.client === `mlw-victim${k}` || m.run === `victim${k}`)),
    },
    result: {
        msg: (id) => ({ id, ok: true, stdout: "FORGED", value: "FORGED" }),
        effect: ({ victim }) => victim.settled(),
    },
};

// --- the table is the handler: every branch that reads an entry has a row, and reads it through the check ---

test("every branch of the worker's message handler that reads a pending entry is a row here, and reads it through `own`", () => {
    const src = readFileSync(new URL("../src/offscreen.ts", import.meta.url), "utf8");
    const start = src.indexOf("    w.onmessage = (e: MessageEvent) => {");
    const end = src.indexOf("\n    };\n", start);
    const body = src.slice(start, end);
    assert.ok(start > 0 && end > start, "found the handler");
    assert.equal((body.match(/pending\.get\(/g) ?? []).length, 0, "no branch reads `pending` but through `own`");
    const asked = [...body.matchAll(/own\([^,]+, "([a-z-]+)"\)/g)].map((m) => m[1]);
    const rows = Object.keys(BRANCHES).map((b) => b === "mlCall" ? "ml-call" : b);
    assert.deepEqual([...asked].sort(), [...rows].sort(), "one row per branch that reads an entry, none missing");
});

// --- one row per branch: another principal's id changes nothing for that run, and is recorded once ---

for (const [branch, row] of Object.entries(BRANCHES)) {
    test(`${branch}: a message naming another principal's pending id does nothing to that run, and is recorded once with none of its content`, async () => {
        const p = await pair();
        p.attacker.w.reply(row.msg(p.victim.id));
        await settle();
        const records = foreignRecords();
        assert.equal(records.length, 1, "recorded once");
        assert.deepEqual(records[0].payload, { subsystem: "pyodide", kind: "foreign-id", reason: branch === "mlCall" ? "ml-call" : branch, key: `own-attacker${p.k}` });
        assert.ok(!JSON.stringify(records).includes("PLANTED") && !JSON.stringify(records).includes("FORGED") && !JSON.stringify(records).includes("evil"), "no content of the message");
        assert.equal(await row.effect(p), false, "the victim's run is as it was");
    });

    test(`${branch}: CONTROL, the same message under the sender's own id acts, and records nothing`, async () => {
        const p = await pair();
        // The victim's own worker sends it: the branch must still work for the run it belongs to.
        p.victim.w.reply(row.msg(p.victim.id));
        await settle();
        assert.equal(foreignRecords().length, 0);
        assert.equal(await row.effect(p), true, "the branch acts on its own principal's run");
    });
}

test("mlCall under another principal's id is answered to the SENDER as a cell with no wire; the victim's stamp is never used", async () => {
    const p = await pair();
    const before = p.attacker.w.posts.length;
    p.attacker.w.reply(BRANCHES.mlCall.msg(p.victim.id));
    await settle();
    const answer = p.attacker.w.posts.slice(before).find((m) => m.mlAnswer);
    assert.equal(answer?.mlAnswer?.answer?.error?.code, "Refused");
    assert.equal(p.victim.w.posts.some((m) => m.mlAnswer), false, "nothing reaches the victim's worker");
});

test("a refused result leaves the victim to be answered by its own worker, with its own value", async () => {
    const p = await pair();
    p.attacker.w.reply(BRANCHES.result.msg(p.victim.id));
    await settle();
    p.victim.w.reply({ id: p.victim.id, ok: true, stdout: "", value: "MINE" });
    assert.equal((await p.victim.answer).value, "MINE");
});
