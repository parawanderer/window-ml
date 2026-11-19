// redteam-nested-ask-egress.test.mjs — a registered secret in a nested ask's facts never reaches a reader of the ask
// (#2006): every approvals read an extension page, a peer approver or the run's model can make, with the run hosted as
// the run host hosts it (`keep: forStored`), and what the stored scrub leaves behind at its edges (a value past its
// depth, a value in an object KEY, a value in a container it does not walk).

import { test } from "node:test";
import assert from "node:assert/strict";

const T = { timeout: 20000 };
const VALUE = "REALSECRET-4b1d-77";
const NAME = "PLUG_PASSWORD";
const MARK = `[REDACTED:${NAME}]`;
/** No read may hold the value, or any front of it long enough to mean something. */
const leaks = (s) => typeof s === "string" && (s.includes(VALUE) || s.includes(VALUE.slice(0, 6)));
/** Every string anywhere in a read, keys included, so a secret used AS a key is not missed by the assertion. */
function texts(v, out = []) {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); texts(x, out); }
    return out;
}
const clean = (label, v) => assert.ok(!texts(v).some(leaks), `${label} hands out the registered value: ${JSON.stringify(v).slice(0, 400)}`);

// The worker's chrome, as much of it as sw-asks.ts, sw-consent.ts and sw-scrub.ts reach.
globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-config-key" }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { listeners: [], addListener(f) { this.listeners.push(f); } },
    },
};
const { _setRegistryForTest, _coldRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { hostAsks, raiseAsk, stepAsks, keptEvent } = await import("../src/sw/sw-asks.ts");
const { pendingApprovals, externalApprovals, resolveApproval } = await import("../src/sw/sw-consent.ts");
const { forStored, DEPTH_WITHHELD } = await import("../src/sw/sw-scrub.ts");
const { readState } = await import("../src/state-registry.ts");

_setRegistryForTest([{ name: NAME, value: VALUE }]);

const tick = () => new Promise((res) => setTimeout(res, 0));
let n = 0;

/**
 * A run hosted as sw-run-host.ts hosts one (`keep: forStored`), torn down however the body ends: a leaked ask would
 * otherwise hold its timer, and a failed row would leave its gate for the next row to count.
 * @param body what the row does with the run
 */
async function withRun(body) {
    const ctl = new AbortController();
    const emitted = [];
    const r = {
        runId: `rt${++n}`, unattended: false, routing: "both", signal: ctl.signal,
        emit: (seq, asks) => emitted.push({ seq, asks }), stepOf: () => 4, running: () => true,
        keep: forStored, waitMs: 500,
    };
    const unhost = hostAsks(r);
    const pending = [];
    try { return await body({ r, ctl, emitted, raise: (seq, ask) => { const p = raiseAsk(r.runId, seq, ask); pending.push(p); return p; } }); }
    finally {
        for (const k of [...pendingApprovals.keys()].filter((k) => k.startsWith(`${r.runId}:`))) resolveApproval(k, { approved: false });
        ctl.abort();
        await Promise.allSettled(pending);
        unhost();
    }
}
const keysOf = (runId) => [...pendingApprovals.keys()].filter((k) => k.startsWith(`${runId}:`));

/**
 * Every read an extension page, a peer approver or the run's model can make of the pending ask, asserted clean.
 * `pendingApprovals`' own `descriptor.facts` is NOT asserted: it is the raw copy a policy judges, kept in this worker
 * only, and the reads that leave the worker (`externalApprovals`, `run.approvals`) are given `arguments` instead.
 * @param r the run
 * @param seq the step
 * @param emitted the run's emissions
 */
async function assertEveryReadClean(r, seq, emitted) {
    const [key] = keysOf(r.runId);
    assert.ok(key, "the ask is pending, so there is a gate to read");
    clean("pendingApprovals descriptor arguments", pendingApprovals.get(key).descriptor.arguments);
    const ext = externalApprovals().filter((d) => d.runId === r.runId);
    assert.equal(ext.length, 1, "positive control: an externally resolvable ask is listed");
    clean("__mlApprovals.list()", ext);
    clean("the emitted step", emitted.at(-1).asks);
    clean("stepAsks (the stored view)", stepAsks(r.runId, seq));
    clean("the state the run's model may read", await readState({ runId: r.runId }, "model", "worker"));
    clean("a stored event read back", await keptEvent(emitted.at(-1)));
}

// --- what every approvals read of a pending ask may hold ---

test("a registered value at the TOP of a nested ask's facts reaches no reader (control)", T, async () => {
    await withRun(async ({ r, emitted, raise }) => {
        raise(3, { kind: "sh", facts: { argv: ["x", VALUE], cwd: "/w" }, consumer: "sh", placement: "host-sandbox" });
        await tick();
        await assertEveryReadClean(r, 3, emitted);
        assert.equal(emitted.at(-1).asks[0].facts.argv[1], MARK, "the stored view shows the registered name, not the value");
    });
});

test("a registered value used as an object KEY of an ask's facts is scrubbed like any other text", T, async () => {
    // A tool that groups rows by a value the page supplied (a header, a cell, an attribute name) puts it in a KEY;
    // plainCopy is JSON, which keeps keys as keys, so the scrub is the only thing between it and every reader.
    await withRun(async ({ r, emitted, raise }) => {
        raise(5, { kind: "sh", facts: { byColumn: { [VALUE]: ["row"] }, cwd: "/w" }, consumer: "sh", placement: "host-sandbox" });
        await tick();
        await assertEveryReadClean(r, 5, emitted);
    });
});

test("a registered value nested past the stored scrub's depth is withheld, never handed out as it is", T, async () => {
    await withRun(async ({ r, emitted, raise }) => {
        let deep = [VALUE];
        for (let i = 0; i < 12; i++) deep = [deep];
        raise(6, { kind: "sh", facts: { deep }, consumer: "sh", placement: "host-sandbox" });
        await tick();
        await assertEveryReadClean(r, 6, emitted);
        const shown = JSON.stringify(emitted.at(-1).asks[0].facts);
        assert.ok(shown.includes(DEPTH_WITHHELD), `the deep subtree is withheld, not kept: ${shown.slice(0, 300)}`);
    });
});

// --- the stored scrub's edges: depth, keys, containers ---

test("a container the scrub does not walk is not served, and every exit from the worker serialises it away", T, async () => {
    // The scrub walks arrays and objects (`Object.entries`); a Map or a Set reads as `{}` to it, and an unplain value
    // is serialised away by plainCopy before an ask ever sees it. What every reader gets is clean; what a caller
    // holding the LIVE copy still holds is the value, and the assertions below pin both halves of that measure.
    const got = await forStored({ m: new Map([["k", VALUE]]), s: new Set([VALUE]) });
    clean("forStored over a Map", JSON.parse(JSON.stringify(got)));
    clean("forStored over a Set", JSON.parse(JSON.stringify(got)));
    assert.equal(got.m.get("k"), VALUE, "the scrub passes a Map through untouched: a caller that reads it as a Map holds the value");
    assert.ok(got.s.has(VALUE), "and a Set the same");
});

test("the depth guard fails closed toward WITHHELD, not toward keeping the subtree", T, async () => {
    let deep = [VALUE];
    for (let i = 0; i < 12; i++) deep = [deep];
    const got = await forStored({ deep });
    clean("forStored past its depth", got);
    assert.equal(JSON.stringify(got).includes(DEPTH_WITHHELD), true);
    // A subtree past the depth that holds NO text is kept as it is: the guard is about text, not shape.
    let nums = [1];
    for (let i = 0; i < 12; i++) nums = [nums];
    assert.deepEqual(await forStored({ nums }), { nums });
});

test("the fail-closed path (no registry) withholds values too, and not keys", T, async () => {
    // The same hole, through the path that exists for a scrub that THREW: every string becomes STORED_WITHHELD, and a
    // key is not a string the scrub visits, so it survives anyway.
    _coldRegistryForTest();
    try {
        const got = await forStored({ a: "anything", [VALUE]: "v" });
        clean("forStored with no registry", got);
    } finally { _setRegistryForTest([{ name: NAME, value: VALUE }]); }
});
