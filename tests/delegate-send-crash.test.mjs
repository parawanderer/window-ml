// delegate-send-crash.test.mjs — how delegateSend tells a crashed renderer from a navigation: the tab's own report
// (`status: "unloaded"`, not discarded) turns a lost channel into "crashed" and records it in the run's log.
// delegate-send.ts imports the worker's state, so a minimal `chrome` is stood up before it is loaded.
import { test } from "node:test";
import assert from "node:assert";

// --- a scripted chrome: tabs.get answers `tab`, tabs.sendMessage runs `onSend` ---
const area = () => { const m = {}; return { get: async (k) => (typeof k === "string" ? { [k]: m[k] } : { ...m }), set: async (o) => { Object.assign(m, o); }, remove: async () => {} }; };
let tab = { status: "complete", discarded: false };
let onSend = async () => { throw new Error("Receiving end does not exist"); };
globalThis.chrome = {
    storage: { session: area(), local: area(), sync: area() },
    runtime: { getManifest: () => ({ version: "0" }), onMessage: { addListener() {} }, id: "x" },
    tabs: { get: async () => tab, sendMessage: (...a) => onSend(...a), reload: async () => {} },
};

const { delegateSend } = await import("../src/sw/delegate-send.ts");
const { PageUnreachable } = await import("../src/sw/page-reachable.ts");
const { activeRuns } = await import("../src/sw/sw-runs.ts");
const { runLog } = await import("../src/sw/sw-run-log.ts");

// --- a lost channel on a crashed tab versus a navigating one ---

test("a send that loses its channel on an unloaded, not-discarded tab fails as crashed and logs page/unreachable crashed", async () => {
    tab = { status: "unloaded", discarded: false };
    activeRuns.set(41, new Set(["run-crash"]));
    const e = await delegateSend(41, { type: "X" }).then(() => null, (x) => x);
    assert.ok(e instanceof PageUnreachable, String(e));
    assert.equal(e.state, "crashed");
    assert.match(e.message, /crashed/);
    const rec = (await runLog.forRun("run-crash")).find((r) => r.subsystem === "page" && r.kind === "unreachable");
    assert.ok(rec, "a page/unreachable record");
    assert.equal(rec.reason, "crashed");
});

test("the same rejection on a complete, not-discarded tab does NOT say crashed", async () => {
    tab = { status: "complete", discarded: false };
    activeRuns.set(42, new Set(["run-nav"]));
    const e = await delegateSend(42, { type: "X" }).then(() => null, (x) => x);
    assert.ok(e instanceof Error);
    assert.doesNotMatch(String(e.message), /crashed/);
    assert.ok(!(e instanceof PageUnreachable && e.state === "crashed"));
    const recs = await runLog.forRun("run-nav");
    assert.ok(!recs.some((r) => r.reason === "crashed"));
});
