// job-registry.test.mjs — the background-job registry (src/job-registry.ts): what a declaration may say, how a job's
// state is derived from its live answer and the housekeeping log (interrupted included), a log from before a job
// logged anything, DUMP_JOBS refusing a page, and the Background work section's rows (housekeeping-log.tsx).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

const R = await import("../src/job-registry.ts");

const LOG = { subsystem: "sessions", start: "compact-pass", done: ["compact-pass-done"], failed: ["compact-images-failed"], also: ["compact-images"] };
const job = (over) => ({ id: "sessions.compact-images", title: "Screenshot compaction", trigger: "when quiet", log: LOG, ...over });
const e = (t, kind, over) => ({ t, subsystem: "sessions", kind, origin: "worker", ...over });

// --- declaring ---

test("jobs are listed in declaration order, and an id cannot be declared twice", () => {
    R.resetJobRegistry();
    R.defineJob(job({ id: "b.second" }));
    R.defineJob(job({ id: "a.first" }));
    assert.deepEqual(R.declaredJobs().map((d) => d.id), ["b.second", "a.first"]);
    assert.throws(() => R.defineJob(job({ id: "a.first" })), /declared twice/);
});

test("an undeclared job is absent: readJobs lists exactly what was declared", async () => {
    R.resetJobRegistry();
    assert.deepEqual(await R.readJobs([]), []);
    R.defineJob(job());
    assert.deepEqual((await R.readJobs([])).map((j) => j.id), ["sessions.compact-images"]);
});

test("a status is plain data: a copy of the live answer, not the job's own object", async () => {
    R.resetJobRegistry();
    const mine = { pending: 2, pendingLabel: "sessions" };
    R.defineJob(job({ live: () => mine }));
    const [s] = await R.readJobs([]);
    mine.pending = 99;
    assert.equal(s.pending, 2);
    assert.doesNotThrow(() => structuredClone(s));
});

test("a live answer that throws keeps the job listed, with the log's view and the error", async () => {
    R.resetJobRegistry();
    R.defineJob(job({ live: () => { throw new Error("store closed"); } }));
    const [s] = await R.readJobs([e(1, "compact-pass"), e(2, "compact-pass-done")]);
    assert.equal(s.state, "idle");
    assert.equal(s.error, "store closed");
    assert.equal(s.lastRun.kind, "compact-pass-done");
});

// --- the state, from the live answer and the log ---

test("idle → waiting (with the count) → running → idle with the last run", () => {
    const d = job();
    assert.equal(R.jobStatus(d, { pending: 0 }, []).state, "idle");
    const w = R.jobStatus(d, { pending: 3, pendingLabel: "sessions with PNG screenshots", nextDue: 5000 }, []);
    assert.equal(R.jobStatus(d, { pending: 1, blocked: "needs a grant" }, []).blocked, "needs a grant");
    assert.deepEqual([w.state, w.pending, w.pendingLabel, w.nextDue], ["waiting", 3, "sessions with PNG screenshots", 5000]);
    assert.equal(R.jobStatus(d, { running: true, pending: 3 }, [e(10, "compact-pass")]).state, "running");
    const done = R.jobStatus(d, { pending: 0 }, [e(10, "compact-pass"), e(11, "compact-images", { key: "h1" }), e(20, "compact-pass-done", { bytes: 900, ms: 10, detail: { sessions: 1, images: 2 } })]);
    assert.equal(done.state, "idle");
    assert.deepEqual(done.lastRun, { t: 20, ok: true, kind: "compact-pass-done", ms: 10, bytes: 900, detail: { sessions: 1, images: 2 } });
    assert.equal(done.interruptedAt, undefined);
});

test("a pass that ends in its failure record is failed, until a later pass finishes", () => {
    const d = job();
    const failed = R.jobStatus(d, { pending: 2 }, [e(1, "compact-pass"), e(2, "compact-images-failed", { level: "warn", detail: { error: "worker gone" } })]);
    assert.equal(failed.state, "failed");
    assert.deepEqual([failed.lastRun.ok, failed.lastRun.detail.error], [false, "worker gone"]);
    assert.equal(R.jobStatus(d, { pending: 0 }, [e(1, "compact-pass"), e(2, "compact-images-failed"), e(3, "compact-pass"), e(4, "compact-pass-done")]).state, "idle");
});

test("interrupted is DERIVED: a start with no end, across a worker restart, and no pass running now", () => {
    const d = job();
    const log = [e(1, "compact-pass-done"), e(10, "compact-pass"), e(11, "compact-images"), { t: 40, subsystem: "sw", kind: "start", origin: "worker" }];
    const s = R.jobStatus(d, { pending: 2 }, log);
    assert.equal(s.state, "interrupted");
    assert.equal(s.interruptedAt, 10);
    assert.equal(s.lastRun.t, 1, "the last run is still the last one that ENDED");
    // The resumed pass: running again, and once it ends the interruption is history.
    assert.equal(R.jobStatus(d, { running: true }, [...log, e(50, "compact-pass")]).state, "running");
    const after = R.jobStatus(d, { pending: 0 }, [...log, e(50, "compact-pass"), e(60, "compact-pass-done")]);
    assert.deepEqual([after.state, after.interruptedAt], ["idle", undefined]);
});

test("another job's records in the same subsystem decide nothing for this one", () => {
    const d = job();
    const s = R.jobStatus(d, {}, [e(1, "evict"), e(2, "archive-failed", { level: "warn" })]);
    assert.deepEqual([s.state, s.lastRun], ["idle", undefined]);
    assert.ok(R.isJobEvent(LOG, e(1, "compact-images")));
    assert.ok(!R.isJobEvent(LOG, e(1, "evict")));
    assert.ok(!R.isJobEvent(LOG, { subsystem: "value-store", kind: "compact-pass" }));
});

test("a job with no start record: each done record is a run, and a failure record is failed", () => {
    const d = job({ id: "sessions.evict", log: { subsystem: "sessions", done: ["evict"], failed: ["archive-failed"] } });
    assert.equal(R.jobStatus(d, undefined, [e(1, "evict", { bytes: 10 })]).lastRun.bytes, 10);
    assert.equal(R.jobStatus(d, undefined, [e(1, "evict"), e(2, "archive-failed")]).state, "failed");
    assert.equal(R.jobStatus(d, undefined, [e(1, "archive-failed"), e(2, "evict")]).state, "idle");
});

// --- upgrade: a log written before a job logged anything ---

test("UPGRADE: a log from before compaction existed derives no last run, no interruption, and the live state alone", async () => {
    // What an older worker left in storage.session: restarts and evictions, no compact-* record at all.
    const old = [
        { t: 1, subsystem: "sw", kind: "start", origin: "worker" },
        { t: 2, subsystem: "sessions", kind: "evict", reason: "budget", key: "aaaa", bytes: 100, origin: "worker" },
        { t: 3, subsystem: "sw", kind: "evicted-inferred", reason: "idle", origin: "worker" },
    ];
    R.resetJobRegistry();
    R.defineJob(job({ live: () => ({ pending: 4, pendingLabel: "sessions with PNG screenshots" }) }));
    const [s] = await R.readJobs(old);
    assert.equal(s.state, "waiting");
    assert.equal(s.pending, 4);
    assert.equal(s.lastRun, undefined);
    assert.equal(s.interruptedAt, undefined);
});

// --- DUMP_JOBS: extension pages only ---

test("DUMP_JOBS refuses a page and answers an extension page with every declared job", async () => {
    globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://x/${p}` } };
    const { handleJobsDump } = await import("../src/sw/sw-housekeeping.ts");
    R.resetJobRegistry();
    R.defineJob(job({ live: () => ({ pending: 1 }) }));
    const page = await handleJobsDump({ url: "https://evil.test/", tab: { id: 3 } });
    assert.match(page.error, /Refused/);
    assert.equal(page.data, undefined);
    const ext = await handleJobsDump({ url: "chrome-extension://x/sidebar.html" });
    assert.deepEqual(ext.data.map((j) => [j.id, j.state, j.pending]), [["sessions.compact-images", "waiting", 1]]);
});

// --- the Background work section ---

let h, render, act, BackgroundWork, jobStateText, lastRunText, doc;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ act } = require_("preact/test-utils"));
    ({ BackgroundWork, jobStateText, lastRunText } = await import("../src/sidebar/housekeeping-log.tsx"));
});

const NOW = 1_000_000;
const status = (over) => ({ id: "sessions.compact-images", title: "Screenshot compaction", trigger: "15 s after saved sessions stop changing", subsystem: "sessions",
    kinds: ["compact-pass", "compact-pass-done", "compact-images-failed", "compact-images"], state: "idle", ...over });

test("each state in words: what waits, when it is next due, and an interruption says it resumes", () => {
    assert.equal(jobStateText(status(), NOW), "idle");
    assert.equal(jobStateText(status({ state: "waiting", pending: 3, pendingLabel: "sessions with PNG screenshots", nextDue: NOW + 12_000 }), NOW),
        "waiting · 3 sessions with PNG screenshots · next in 12s");
    assert.equal(jobStateText(status({ state: "running", pending: 3, pendingLabel: "sessions", nextDue: NOW + 5000 }), NOW), "running · 3 sessions", "no countdown while it runs");
    assert.equal(jobStateText(status({ state: "interrupted", interruptedAt: NOW - 120_000, pending: 2, pendingLabel: "sessions" }), NOW),
        "interrupted 2m ago, resumes on its own · 2 sessions");
    assert.equal(jobStateText(status({ state: "failed" }), NOW), "last run failed");
    assert.equal(jobStateText(status({ nextDue: NOW - 1 }), NOW), "idle · due now");
    assert.equal(jobStateText(status({ state: "waiting", pending: 3, pendingLabel: "month files to write", nextDue: NOW + 5000, blocked: "the folder needs access" }), NOW),
        "waiting · 3 month files to write · blocked: the folder needs access", "what blocks it, in place of a countdown that would not help");
});

test("the last run in words, a failure with its error, and none recorded", () => {
    assert.equal(lastRunText(status(), NOW), "No run recorded since the browser started.");
    assert.equal(lastRunText(status({ lastRun: { t: NOW - 60_000, ok: true, kind: "compact-pass-done", ms: 3100, bytes: 2048 } }), NOW),
        "Last run finished, 1m ago, took 3.1s, freed 2.00 KiB.");
    assert.equal(lastRunText(status({ lastRun: { t: NOW - 5000, ok: false, kind: "compact-images-failed", detail: { error: "worker gone" } } }), NOW),
        "Last run failed (compact-images-failed), 5s ago, worker gone.");
});

test("the section draws a row per job, and opening one shows only that job's records", async () => {
    const answer = [status({ state: "waiting", pending: 2, pendingLabel: "sessions with PNG screenshots" }),
        status({ id: "sessions.evict", title: "Saved-session cleanup", kinds: ["evict", "archive-failed"], state: "idle" })];
    const sent = [];
    globalThis.chrome = { runtime: { sendMessage: (m, cb) => { sent.push(m.type); cb({ data: answer }); }, lastError: undefined } };
    const events = [e(1, "compact-pass"), e(2, "compact-images", { key: "hash-compacted" }), e(3, "evict", { key: "hash-evicted" }), { t: 4, subsystem: "sw", kind: "start", origin: "worker" }];
    const host = doc.getElementById("root");
    await act(async () => { render(h(BackgroundWork, { events }), host); });
    try {
        assert.equal(sent[0], "DUMP_JOBS");
        const heads = [...host.querySelectorAll(".disc-head")];
        assert.deepEqual(heads.map((b) => b.querySelector(".disc-label").textContent), ["Screenshot compaction", "Saved-session cleanup"]);
        assert.match(heads[0].textContent, /waiting · 2 sessions with PNG screenshots/);
        assert.ok(host.querySelector(".bgw-state.waiting"));
        await act(async () => { heads[0].click(); });
        const body = host.querySelector(".disc.open").textContent;
        assert.match(body, /hash-compacted/);
        assert.doesNotMatch(body, /hash-evicted/, "another job's record");
        assert.match(body, /Runs 15 s after saved sessions stop changing\./);
    } finally {
        await act(async () => { render(null, host); });
    }
});

test("no declared jobs: the section draws nothing; an error says so", async () => {
    const host = doc.getElementById("root");
    globalThis.chrome = { runtime: { sendMessage: (_m, cb) => cb({ data: [] }) } };
    await act(async () => { render(h(BackgroundWork, { events: [] }), host); });
    assert.equal(host.textContent, "");
    globalThis.chrome = { runtime: { sendMessage: (_m, cb) => cb({ error: "Refused" }) } };
    await act(async () => { render(null, host); render(h(BackgroundWork, { events: [] }), host); });
    assert.match(host.textContent, /could not read background jobs: Refused/);
    await act(async () => { render(null, host); });
});
