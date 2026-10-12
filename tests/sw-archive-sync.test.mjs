// sw-archive-sync.test.mjs — the archive folder sync as a background job (sw-archive.ts `syncFolder`): logged as a pass
// only while a folder is connected, its failures kept, and its status naming what waits and what blocks it.
import { test } from "node:test";
import assert from "node:assert/strict";

/** The archive's answers, by op: a report, or an Error to reject with. */
let answers = {};
globalThis.chrome = {
    offscreen: { hasDocument: async () => true, Reason: {} },
    runtime: {
        sendMessage: async ({ op }) => {
            const a = answers[op];
            return a instanceof Error ? { ok: false, error: a.message } : { ok: true, result: a };
        },
    },
};
const { resetJobRegistry, readJobs } = await import("../src/job-registry.ts");
resetJobRegistry();
const { syncFolder, folderAction } = await import("../src/sw/sw-archive.ts");
const { housekeeping } = await import("../src/sw/sw-housekeeping.ts");

const report = (over) => ({ state: "connected", name: "Archive", pending: 0, lastSync: 1, ...over });

/** The archive records written since `from`, and the sync job's status against the whole log. */
async function since(from) {
    const all = await housekeeping.all();
    return { recs: all.slice(from).filter((e) => e.subsystem === "archive"), job: (await readJobs(all)).find((j) => j.id === "archive.folder-sync") };
}

// --- logged only while a folder is connected ---

test("before the folder's state is known, a sync that wrote nothing logs nothing; one that wrote something logs its result", async () => {
    // The worker's first sync: nothing has said whether a folder is picked.
    answers = { sync: report({ state: "none" }) };
    let from = (await housekeeping.all()).length;
    await syncFolder("sync", "alarm");
    assert.deepEqual((await since(from)).recs, []);
    // The folder said "none" last time, and this sync wrote two months (one was just picked): that is worth a record,
    // a done with no start, which is a run, never an interruption.
    answers = { sync: report({ written: ["2026-09.sqlite", "2026-10.sqlite"] }) };
    from = (await housekeeping.all()).length;
    await syncFolder("sync", "alarm");
    const { recs, job } = await since(from);
    assert.deepEqual(recs.map((r) => r.kind), ["folder-sync-done"]);
    assert.equal(recs[0].detail.written, 2);
    assert.equal(job.interruptedAt, undefined);
});

test("with a folder connected a sync is a pass: folder-sync, then folder-sync-done with what it wrote", async () => {
    answers = { folder: report() };
    await folderAction("status");
    answers = { sync: report({ written: ["2026-09.sqlite", "2026-10.sqlite"], removed: [] }) };
    const from = (await housekeeping.all()).length;
    await syncFolder("sync", "write");
    const { recs, job } = await since(from);
    assert.deepEqual(recs.map((r) => [r.kind, r.reason]), [["folder-sync", "write"], ["folder-sync-done", "write"]]);
    assert.deepEqual(recs[1].detail, { written: 2, removed: 0, pending: 0, state: "connected" });
    assert.deepEqual([job.state, job.lastRun.ok], ["idle", true]);
});

test("a sync that fails is logged with its error, and the job is failed", async () => {
    answers = { folder: report() };
    await folderAction("status");
    answers = { sync: new Error("NotAllowedError: the folder is gone") };
    const from = (await housekeeping.all()).length;
    await assert.rejects(syncFolder("sync", "settings"), /folder is gone/);
    const { recs, job } = await since(from);
    assert.deepEqual(recs.map((r) => [r.kind, r.level ?? "info"]), [["folder-sync", "info"], ["folder-sync-failed", "warn"]]);
    assert.match(recs[1].detail.error, /folder is gone/);
    assert.equal(job.state, "failed");
});

// --- what waits, and what blocks it ---

test("a lapsed grant with months waiting is blocked, and says what a person has to do", async () => {
    answers = { folder: report({ state: "needs-grant", pending: 3 }) };
    await folderAction("status");
    const { job } = await since(0);
    assert.deepEqual([job.pending, job.pendingLabel], [3, "month files to write"]);
    assert.match(job.blocked, /access granted again/);
});

test("no folder, or a browser that cannot have one: nothing waits for the job", async () => {
    for (const state of ["none", "unsupported"]) {
        answers = { folder: report({ state, pending: 5 }) };
        await folderAction("status");
        const { job } = await since(0);
        assert.deepEqual([job.pending, job.blocked], [undefined, undefined], state);
    }
});
