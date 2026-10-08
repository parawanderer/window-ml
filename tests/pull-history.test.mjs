// pull-history.test.mjs — fetching the REST of a paged session (src/chat/pull-history.ts), which is what an export
// needs before it can claim to be the conversation rather than the end of one, and the TASK that carries one of
// those past the dialog that started it (src/chat/export-tasks.ts).
//
// The happy path runs against the fake host with a short ring, so the paging is the contract's own. The two failure
// paths are driven by a stub, because what they describe — a reader stopping it, and a runtime that answers without
// making progress — is the loop's behaviour rather than any host's. The task tests use the same stub: what they are
// about is when the offer appears and what is written when, not how a page arrives.

import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../src/chat/chat-store.ts";
import { FakeHost } from "../src/chat/fake-host.ts";
import { pullAllHistory } from "../src/chat/pull-history.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session/session-host.ts";
import { sessionMap } from "../src/sidebar/store.ts";

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const runtime = (id) => ({
    id, name: id, kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION,
    capabilities: { chat: true, agent: true }, grants: [{ scope: "view" }, { scope: "drive" }],
});
const summary = (hash) => ({ id: { runtime: "laptop", hash }, kind: "agent", status: "done", task: "t", createdTs: 1000, lastTs: 1000, pendingApprovals: 0, saved: true });
const step = (hash, seq) => ({ kind: "agent-step", id: hash, ts: 1000 + seq, save: true, session: { hash, turn: seq }, step: seq, seq, tool: "exec", arguments: { js: "1" }, result: String(seq) });

/** A store that holds `from` events it has not fetched, and whose pages move it by `per` — or not at all. `applied`
 *  counts the calls that ended the deferral, which is what says the pull reduced once rather than per page. */
function stubStore(from, per) {
    const state = { from, more: from > 0, truncated: false, loading: false };
    const calls = { deferred: 0, plain: 0, applied: 0 };
    return {
        calls,
        earlier: { value: new Map([["laptop:aaaa0001", state]]) },
        async loadEarlier(_key, opts) {
            if (opts?.defer) calls.deferred++; else calls.plain++;
            state.from = Math.max(0, state.from - per);
            state.more = state.from > 0;
        },
        applyEarlier() { calls.applied++; },
    };
}

// --- paging a session back to its first event ---

test("it pages to the start, and the progress it reports is determinate", async () => {
    const events = [{ kind: "agent", id: "aaaa0001", ts: 1000, save: true, session: { hash: "aaaa0001", turn: 0 }, task: "t", model: "m", maxSteps: 10, config: null },
        ...Array.from({ length: 19 }, (_, i) => step("aaaa0001", i + 1))];
    const host = new FakeHost({ runtimes: [runtime("laptop")], sessions: [{ summary: summary("aaaa0001"), events }] });
    host.ringLimit = 5;   // a short ring, so the session arrives as its end and the rest is paged
    const store = new ChatStore(host);
    store.start();
    await flush();
    store.open("laptop:aaaa0001");
    await flush(12);

    const before = store.earlier.value.get("laptop:aaaa0001");
    assert.ok(before?.more, "the session arrived with more behind it");
    assert.ok(before.from > 0);

    const seen = [];
    const out = await pullAllHistory(store, "laptop:aaaa0001", { onProgress: (p) => seen.push(p) });
    assert.deepEqual(out, { kind: "complete" });
    assert.equal(store.earlier.value.get("laptop:aaaa0001")?.more, false, "nothing is left behind it");
    assert.equal(sessionMap.get("laptop:aaaa0001")?.steps?.length ?? 0, 19, "and every step is held");

    // The denominator is known up front, so this is a bar rather than a spinner.
    assert.equal(seen[0].done, 0);
    assert.equal(seen[0].total, before.from);
    assert.equal(seen.at(-1).done, before.from, "and it finishes at the number it promised");
    // How MANY reports there are is the host's business (a page size), not this loop's: what matters is that one
    // lands before any work and one after the last page.
    assert.ok(seen.length >= 2, "it reported at the start and again when it finished");
});

// --- stopping, and being made to stop ---

test("a reader who cancels gets back how far it got, not a claim of completeness", async () => {
    const store = stubStore(100, 10);
    const stop = new AbortController();
    const out = await pullAllHistory(store, "laptop:aaaa0001", {
        signal: stop.signal,
        onProgress: (p) => { if (p.done >= 30) stop.abort(); },
    });
    assert.equal(out.kind, "cancelled");
    assert.equal(out.total, 100);
    assert.equal(store.calls.applied, 1, "and what it did fetch was reduced on the way out");
    assert.ok(out.done >= 30 && out.done < 100, `stopped part way, at ${out.done}`);
});

test("a runtime that answers without making progress ENDS the pull rather than spinning on it", async () => {
    // The failure this exists for is not an error, it is a bar that never moves: nobody interrupts something that
    // looks like it is working, so the loop has to notice and say so itself.
    const store = stubStore(100, 0);
    const out = await pullAllHistory(store, "laptop:aaaa0001", {});
    assert.equal(out.kind, "failed");
    assert.match(out.why, /stopped sending/);
    assert.equal(out.done, 0);
});

// --- paging in is the same session as receiving it whole ---

test("a session paged in event by event ends up identical to one delivered in a single ring", async () => {
    // This is the invariant `loadEarlier` has to preserve, and the one that says whether its replay is needed at
    // all: the reducer is documented to CONVERGE whatever the order ("patches by `seq` rather than appending"), so
    // a session assembled from pages must equal the same session that arrived in one piece. Written before the
    // replay was touched, so it describes the behaviour rather than the change.
    const events = [{ kind: "agent", id: "aaaa0001", ts: 1000, save: true, session: { hash: "aaaa0001", turn: 0 }, task: "t", model: "m", maxSteps: 10, config: null },
        ...Array.from({ length: 49 }, (_, i) => step("aaaa0001", i + 1))];

    const whole = new ChatStore(new FakeHost({ runtimes: [runtime("laptop")], sessions: [{ summary: summary("aaaa0001"), events }] }));
    whole.start();
    await flush();
    whole.open("laptop:aaaa0001");
    await flush(14);
    const want = JSON.parse(JSON.stringify(sessionMap.get("laptop:aaaa0001")));

    const pagedHost = new FakeHost({ runtimes: [runtime("laptop")], sessions: [{ summary: summary("aaaa0001"), events }] });
    pagedHost.ringLimit = 7;
    const paged = new ChatStore(pagedHost);
    paged.start();
    await flush();
    paged.open("laptop:aaaa0001");
    await flush(14);
    assert.equal(await pullAllHistory(paged, "laptop:aaaa0001", {}).then((o) => o.kind), "complete");
    const got = JSON.parse(JSON.stringify(sessionMap.get("laptop:aaaa0001")));

    assert.equal(got.steps.length, want.steps.length, "the same number of steps");
    assert.deepEqual(got.steps.map((s) => s.seq), want.steps.map((s) => s.seq), "in the same order");
    assert.deepEqual(got.steps, want.steps, "and the same content, field for field");
    assert.equal(got.task, want.task);
    assert.equal(got.kind, want.kind);
});

// --- a pull that outlives its dialog ---

test("the offer to go to the background is earned by what the pull has cost, not predicted from its size", async () => {
    const { shouldOfferBackground, BG_AFTER_MS } = await import("../src/chat/export-tasks.ts");
    // The whole point: a short session must never meet this mechanism, however many events it has, so the rule reads
    // only elapsed time and the rate observed.
    assert.equal(shouldOfferBackground({ done: 40, total: 25_000, elapsedMs: 200 }), false, "huge, but it has cost nothing yet");
    assert.equal(shouldOfferBackground({ done: 8_000, total: 8_040, elapsedMs: 60_000 }), false, "slow, but it is all but done");
    assert.equal(shouldOfferBackground({ done: 1_000, total: 25_000, elapsedMs: BG_AFTER_MS }), true, "slow, and most of it is still to come");
    assert.equal(shouldOfferBackground({ done: 0, total: 100, elapsedMs: BG_AFTER_MS }), true, "not one page has landed, which is the slowest case there is");
});

test("a detached pull keeps going, shows in the inbox, and writes nothing until it is taken", async () => {
    const tasks = await import("../src/chat/export-tasks.ts");
    let wrote = 0;
    // Three pages of ten, so the task is still running when it is let go of.
    const store = stubStore(30, 10);
    const id = tasks.startExportPull({ store, key: "laptop:aaaa0001", title: "a long one", verb: "Save", finish: () => { wrote++; } });
    tasks.detachExport(id);
    const mine = () => tasks.exportTaskItems(tasks.exportTasks.value.filter((t) => t.id === id));
    const working = mine();
    assert.equal(working.length, 1);
    assert.equal(working[0].level, "working", "it is in the list, but it is not asking for anything");
    assert.ok(working[0].progress, "and it says whether it is moving");

    await flush(10);
    const ready = mine();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].level, "ready");
    assert.equal(ready[0].fix.label, "Save", "the verb it was started with");
    assert.equal(wrote, 0, "and it has still written nothing: a file appearing with nothing to explain it reads as a bug");

    ready[0].fix.run();
    assert.equal(wrote, 1, "taking it is what writes the file");
    assert.equal(mine().length, 0, "and the task is gone");
});

test("a pull the dialog is still watching exports itself, and never appears in the inbox", async () => {
    const tasks = await import("../src/chat/export-tasks.ts");
    let wrote = 0;
    const store = stubStore(20, 10);
    const id = tasks.startExportPull({ store, key: "laptop:aaaa0001", title: "a short one", verb: "Save", finish: () => { wrote++; } });
    const mine = () => tasks.exportTaskItems(tasks.exportTasks.value.filter((t) => t.id === id));
    assert.deepEqual(mine(), [], "the dialog is saying it; the inbox would be saying it twice");
    await flush(10);
    assert.equal(wrote, 1, "it finished under someone's eyes, so making them press the button again would be a joke");
    assert.deepEqual(mine(), []);
});

test("a detached pull that breaks off offers what it did fetch, rather than nothing", async () => {
    const tasks = await import("../src/chat/export-tasks.ts");
    let wrote = 0;
    const store = stubStore(100, 0);   // answers, never moves: the guard in pullAllHistory ends it
    const id = tasks.startExportPull({ store, key: "laptop:aaaa0001", title: "a stuck one", verb: "Print", finish: () => { wrote++; } });
    tasks.detachExport(id);
    await flush(10);
    const [item] = tasks.exportTaskItems(tasks.exportTasks.value.filter((t) => t.id === id));
    assert.equal(item.level, "ready", "it wants a hand: it is short of the whole session and only a person can decide that is fine");
    assert.match(item.detail, /stopped sending/);
    assert.match(item.fix.label, /^Print what was fetched$/);
    item.fix.run();
    assert.equal(wrote, 1);
});

test("stopping a detached pull forgets it without writing anything", async () => {
    const tasks = await import("../src/chat/export-tasks.ts");
    let wrote = 0;
    const store = stubStore(1000, 1);
    const id = tasks.startExportPull({ store, key: "laptop:aaaa0001", title: "too long", verb: "Save", finish: () => { wrote++; } });
    tasks.detachExport(id);
    const mine = () => tasks.exportTaskItems(tasks.exportTasks.value.filter((t) => t.id === id));
    mine()[0].fix.run();   // "Stop"
    await flush(6);
    assert.deepEqual(mine(), []);
    assert.equal(wrote, 0);
});

// --- what a pull costs ---

test("a pull reduces ONCE, however many pages it took", async () => {
    // The replay in `loadEarlier` rebuilds the session from everything held. That is the right cost for the one page
    // a reader asked for and quadratic for a pull: 25,600 events spent 5.3s of CPU rebuilding a transcript nobody
    // was watching. The fix is not a cheaper replay, it is one replay — which is a thing to assert, because nothing
    // about the result it produces would ever show that it had been done six hundred times.
    const store = stubStore(400, 40);
    assert.deepEqual(await pullAllHistory(store, "laptop:aaaa0001", {}), { kind: "complete" });
    assert.equal(store.calls.deferred, 10, "ten pages");
    assert.equal(store.calls.plain, 0, "none of them reduced on its own");
    assert.equal(store.calls.applied, 1, "and one replay at the end");
});

test("a pull that ends badly still reduces what it fetched", async () => {
    // Every way out has to pass through it: a session left deferred shows the tail it had before the pull, with the
    // rest fetched and invisible, which is the worst of both and silent.
    const store = stubStore(100, 0);
    assert.equal((await pullAllHistory(store, "laptop:aaaa0001", {})).kind, "failed");
    assert.equal(store.calls.applied, 1);
});
