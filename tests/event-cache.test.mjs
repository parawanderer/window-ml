// event-cache.test.mjs — what a phone keeps of the sessions it has seen (src/chat/event-cache.ts), and the store that
// replays it (src/chat/chat-store.ts): a copy is replayed on a later launch and the subscription RESUMES from it, a
// history that changed while the app was closed replaces the copy, and a session too big to keep whole is not kept.
import { test } from "node:test";
import assert from "node:assert/strict";

const { SessionFeed } = await import("../src/chat/session-feed.ts");
const { ChatStore } = await import("../src/chat/chat-store.ts");
const { FakeHost } = await import("../src/chat/fake-host.ts");
const { sessionMap } = await import("../src/sidebar/store.ts");
const { SESSION_CONTRACT_VERSION } = await import("../src/session/session-host.ts");

/** An `EventCache` over a Map: what these tests need of one is that it keeps a copy and gives it back, which is all
 *  the store asks. The real implementation is the phone's SQLite archive (mobile/src/archive.ts), reached over the
 *  bridge — it cannot run here, and these tests are about the STORE's behaviour with a cache rather than about it. */
function mapStore() {
    const m = new Map();
    return {
        m,
        load: async (k) => m.get(k) ?? null,
        save: async (c) => { m.set(c.key, c); },
        drop: async (k) => { m.delete(k); },
        clear: async () => { m.clear(); },
    };
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const rt = { id: "laptop", name: "Work laptop", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION, grants: [{ scope: "control" }], capabilities: { chat: true } };
const summary = (hash) => ({ id: { runtime: "laptop", hash }, kind: "chat", status: "done", createdTs: 1, lastTs: 2, pendingApprovals: 0, title: hash });
const turn = (hash, i, text) => [
    { id: `${hash}-${i}`, ts: 1000 + i, save: true, session: { hash, turn: i }, kind: "chat", streaming: false,
        request: { model: "m", extend: null, messages: [{ role: "user", content: `q${i}` }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
        config: { system: null, model: "m", think: null, schema: false, toolIds: null, maxTokens: null, save: true } },
    { id: `${hash}-${i}`, ts: 1001 + i, save: true, session: { hash, turn: i }, kind: "chat-result", model: "m", extend: null,
        reasoning: null, sources: null, structured: false, usage: null, content: text },
];

test("a feed's position survives a save and restore, and what it had applied is still a duplicate", () => {
    const id = { runtime: "laptop", hash: "a" };
    const f = new SessionFeed(id);
    assert.equal(f.snapshot(), null, "nothing arrived yet: nothing to keep");
    const ev = (cursor) => ({ type: "event", v: SESSION_CONTRACT_VERSION, session: id, epoch: "e1", cursor, event: { session: { hash: "a" } } });
    f.handle(ev(1)); f.handle(ev(3));
    const snap = f.snapshot();
    assert.deepEqual(snap, { epoch: "e1", cursors: [1, 3] });
    const g = SessionFeed.restore(id, snap);
    assert.deepEqual(g.position, { epoch: "e1", cursor: 3 });
    assert.equal(g.handle(ev(3)).type, "drop", "a re-sent event is dropped as a duplicate");
    assert.equal(g.handle(ev(4)).type, "apply", "and the next one applies");
});

test("a later launch replays the copy at once, then resumes from it: the runtime sends only what is new", async () => {
    const host = new FakeHost({ runtimes: [rt], sessions: [{ summary: summary("c1"), events: [...turn("c1", 0, "first answer"), ...turn("c1", 1, "second answer")] }] });
    const st = mapStore();
    const one = new ChatStore(host, { cache: st });
    one.start();
    await flush();
    one.open("laptop:c1");
    await flush();
    assert.equal(sessionMap.get("laptop:c1")?.turns.length, 2);
    await flush(900);   // the copy is saved a moment after the session last changed
    assert.deepEqual([...st.m.keys()], ["laptop:c1"], "the session was kept, under its own key");
    one.close();

    // The app is killed; the runtime moves on by one turn while it is gone.
    sessionMap.delete("laptop:c1");
    host.emit("laptop:c1", turn("c1", 2, "third answer")[0]);
    host.emit("laptop:c1", turn("c1", 2, "third answer")[1]);

    // Next launch: a new store over the same runtime and the same copy.
    const subscribed = [];
    const events = host.events.bind(host);
    host.events = (id, l, opts) => { subscribed.push(opts?.since ?? null); return events(id, l, opts); };
    const two = new ChatStore(host, { cache: st });
    two.start();
    await flush();
    two.open("laptop:c1");
    await flush();
    assert.equal(subscribed.length, 1);
    assert.ok(subscribed[0], "it resumed from the copy's position instead of from nothing");
    assert.equal(sessionMap.get("laptop:c1")?.turns.length, 3, "the copy, and then only the turn that is new");
    assert.equal(sessionMap.get("laptop:c1")?.turns.at(-1)?.assistant, "third answer");
    two.close();
});

test("a history that changed while the app was closed replaces the copy: the runtime's reset wins", async () => {
    const host = new FakeHost({ runtimes: [rt], sessions: [{ summary: summary("c2"), events: turn("c2", 0, "before") }] });
    const st = mapStore();
    const one = new ChatStore(host, { cache: st });
    one.start();
    await flush();
    one.open("laptop:c2");
    await flush(900);
    one.close();

    // The runtime rebuilt the session under a new epoch: whatever the phone kept is someone else's history now.
    sessionMap.delete("laptop:c2");
    host.restart("laptop:c2", false);
    host.emit("laptop:c2", turn("c2", 0, "after")[0]);
    host.emit("laptop:c2", turn("c2", 0, "after")[1]);

    const two = new ChatStore(host, { cache: st });
    two.start();
    await flush();
    two.open("laptop:c2");
    await flush();
    const turns = sessionMap.get("laptop:c2")?.turns ?? [];
    assert.equal(turns.at(-1)?.assistant, "after");
    assert.equal(turns.some((t) => t.assistant === "before"), false, "nothing from the replaced history survives");
    two.close();
});

test("forgetting the cache clears every kept session: a device that changes accounts replays none of the last one", async () => {
    const host = new FakeHost({ runtimes: [rt], sessions: [{ summary: summary("c3"), events: turn("c3", 0, "hi") }] });
    const st = mapStore();
    const s = new ChatStore(host, { cache: st });
    s.start();
    await flush();
    s.open("laptop:c3");
    await flush(900);
    assert.ok(st.m.size > 0);
    await s.forgetCache();
    assert.equal(st.m.size, 0);
    s.close();
});

test("a cache that never answers does not hold a session on 'Loading…': it opens the ordinary way", async () => {
    const host = new FakeHost({ runtimes: [rt], sessions: [{ summary: summary("c4"), events: turn("c4", 0, "still here") }] });
    const stuck = { load: () => new Promise(() => {}), save: async () => {}, drop: async () => {}, clear: async () => {} };
    const s = new ChatStore(host, { cache: stuck });
    s.start();
    await flush();
    s.open("laptop:c4");
    await flush(1800);
    assert.equal(sessionMap.get("laptop:c4")?.turns.at(-1)?.assistant, "still here");
    s.close();
});
