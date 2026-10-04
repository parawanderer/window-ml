// pull-history.test.mjs — fetching the REST of a paged session (src/chat/pull-history.ts), which is what an export
// needs before it can claim to be the conversation rather than the end of one.
//
// The happy path runs against the fake host with a short ring, so the paging is the contract's own. The two failure
// paths are driven by a stub, because what they describe — a reader stopping it, and a runtime that answers without
// making progress — is the loop's behaviour rather than any host's.

import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../src/chat/chat-store.ts";
import { FakeHost } from "../src/chat/fake-host.ts";
import { pullAllHistory } from "../src/chat/pull-history.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session-host.ts";
import { sessionMap } from "../src/sidebar/store.ts";

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const runtime = (id) => ({
    id, name: id, kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION,
    capabilities: { chat: true, agent: true }, grants: [{ scope: "view" }, { scope: "drive" }],
});
const summary = (hash) => ({ id: { runtime: "laptop", hash }, kind: "agent", status: "done", task: "t", createdTs: 1000, lastTs: 1000, pendingApprovals: 0, saved: true });
const step = (hash, seq) => ({ kind: "agent-step", id: hash, ts: 1000 + seq, save: true, session: { hash, turn: seq }, step: seq, seq, tool: "exec", arguments: { js: "1" }, result: String(seq) });

/** A store that holds `from` events it has not fetched, and whose pages move it by `per` — or not at all. */
function stubStore(from, per) {
    const state = { from, more: from > 0, truncated: false, loading: false };
    return {
        earlier: { value: new Map([["laptop:aaaa0001", state]]) },
        async loadEarlier() {
            state.from = Math.max(0, state.from - per);
            state.more = state.from > 0;
        },
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
