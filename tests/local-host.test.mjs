// The chat page's local host end to end, with no browser: the real `LocalHost` client, over an in-memory port, to the
// real `SessionServer` and `SessionIndex` the background runs, with the real `ChatStore` on top. What the background
// ingests must reach the page's list and transcript, and a worker restart (the port dropping) must resume or reset by
// the contract's rules (docs/spec/SESSION_CONTRACT.md).
import test from "node:test";
import assert from "node:assert/strict";
import { LocalHost } from "../src/chat/local-host.ts";
import { ChatStore } from "../src/chat/chat-store.ts";
import { SessionIndex } from "../src/session-index.ts";
import { SessionServer } from "../src/session-server.ts";
import { sessionMap } from "../src/sidebar/store.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session-host.ts";

/** A regression here tends to leave a promise unresolved; fail it rather than hang the runner. */
const T = { timeout: 5000 };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const TAB = 7;
const base = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1000, save: false, session: { hash, turn: 0 }, ...over });
const start = (hash, task = "find the price") => base(hash, "agent", { task, model: "m", maxSteps: 10, config: null });
const step = (hash, seq, over = {}) => base(hash, "agent-step", { step: seq, seq, tool: "exec", arguments: {}, result: `r${seq}`, ...over });

/** A connected pair of ports. Messages are structured-cloned and delivered asynchronously, as chrome's are, and a
 *  disconnect fires `onDisconnect` on the OTHER end only. */
function portPair() {
    const ends = [{ on: [], off: [] }, { on: [], off: [] }];
    let open = true;
    const end = (me, other) => ({
        postMessage: (m) => {
            if (!open) throw new Error("Attempting to use a disconnected port object");
            const copy = structuredClone(m);
            queueMicrotask(() => { if (open) for (const h of other.on) h(copy); });
        },
        onMessage: { addListener: (fn) => me.on.push(fn) },
        onDisconnect: { addListener: (fn) => me.off.push(fn) },
        disconnect: () => { if (!open) return; open = false; for (const h of other.off) h(); },
    });
    return {
        client: end(ends[0], ends[1]),
        server: end(ends[1], ends[0]),
        /** the worker died: both ends see the disconnect */
        kill: () => { if (!open) return; open = false; for (const e of ends) for (const h of e.off) h(); },
    };
}

const RUNTIME = { id: "local", name: "This browser", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION, capabilities: {}, grants: [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }] };

/** One background worker's life: its index and server, and optionally the sessions a previous one saved. */
function worker(spawn, saved) {
    const index = new SessionIndex({ runtime: "local", spawn });
    const commands = [];
    const server = new SessionServer(index, {
        runtime: () => RUNTIME,
        command: async (c) => { commands.push(c); return { ok: false, error: { code: "unsupported", message: "not yet" } }; },
        ...(saved ? { stored: async (hash) => saved.read(hash) } : {}),
    });
    if (saved) server.restored(index.restore(saved.rows()));
    return { index, server, commands };
}

/** Saved sessions, as a previous worker left them: rows for the list, events for a transcript. */
function savedSessions(entries) {
    return {
        rows: () => entries.map((e) => ({ summary: e.summary, count: e.events.length })),
        read: async (hash) => {
            if (savedSessions.hold) await savedSessions.hold;
            return entries.find((e) => e.summary.id.hash === hash)?.events ?? [];
        },
    };
}

/** Manually fired timers, so a reconnect happens when the test says. */
function manualTimers() {
    const queue = [];
    return {
        setTimeout: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; },
        clearTimeout: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
        // The shortest delay first, as a clock moving forward would (a reconnect at 250 ms before a 3 s grace).
        fire: () => { const t = [...queue].sort((a, b) => a.ms - b.ms)[0]; if (t) { queue.splice(queue.indexOf(t), 1); t.fn(); } return t; },
        pending: () => queue.length,
    };
}

/** A LocalHost whose connections go to whichever worker is current, recording what each connection carried. */
function setup(first = worker("w1")) {
    const world = { current: first, ports: [], streamed: [] };
    const timers = manualTimers();
    const host = new LocalHost(() => {
        const p = portPair();
        world.ports.push(p);
        world.current.server.attach(p.server);
        p.client.onMessage.addListener((m) => { if (m.type === "stream") world.streamed.push(m.message); });
        return p.client;
    }, timers);
    return { world, timers, host };
}

test("what the background ingests reaches the page's list and transcript, live", T, async () => {
    const { world, host } = setup();
    world.current.server.ingest(start("aaaa0001", "before the page opened"), { tabId: TAB, trusted: true });
    const store = new ChatStore(host);
    store.start();
    await flush();
    assert.equal(store.status.value.state, "online");
    assert.deepEqual(store.runtimes.value.map((r) => r.id), ["local"]);
    assert.equal(store.index.value.get("local:aaaa0001")?.task, "before the page opened");

    world.current.server.ingest(start("bbbb0002", "after"), { tabId: TAB, trusted: false, page: { url: "https://shop.example/", title: "Shop" } });
    await flush();
    assert.equal(store.index.value.get("local:bbbb0002")?.page?.url, "https://shop.example/");

    store.open("local:aaaa0001");
    await flush();
    assert.equal(sessionMap.get("local:aaaa0001")?.task, "before the page opened");
    world.current.server.ingest(step("aaaa0001", 1, { pending: true, awaitingApproval: true, result: undefined }), { tabId: TAB, trusted: true });
    await flush();
    assert.equal(sessionMap.get("local:aaaa0001")?.steps?.[0]?.awaitingApproval, true);
    assert.equal(store.index.value.get("local:aaaa0001")?.status, "waiting");
    assert.equal(store.index.value.get("local:aaaa0001")?.pendingApprovals, 1);

    // A page that does not own the session cannot write into it through the index.
    world.current.server.ingest(step("aaaa0001", 2), { tabId: TAB + 1, trusted: false });
    await flush();
    assert.equal(sessionMap.get("local:aaaa0001")?.steps?.length, 1);

    // Deleting a session ends its subscription with `gone`.
    world.current.server.remove({ runtime: "local", hash: "aaaa0001" });
    await flush();
    assert.equal(store.index.value.has("local:aaaa0001"), false);
    assert.equal(sessionMap.has("local:aaaa0001"), false);
    assert.match(store.notices.value.at(-1)?.text ?? "", /deleted/);
    store.dispose();
    host.dispose();
});

test("the port dropping with the worker still alive: reconnect and resume, sending only what is new", T, async () => {
    const { world, timers, host } = setup();
    const w = world.current;
    w.server.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    w.server.ingest(step("aaaa0001", 1), { tabId: TAB, trusted: true });
    const store = new ChatStore(host);
    store.start();
    store.open("local:aaaa0001");
    await flush();
    assert.equal(sessionMap.get("local:aaaa0001")?.steps?.length, 1);

    const inFlight = host.send({ type: "tabs.list", runtime: "local" });
    world.ports[0].kill();
    assert.deepEqual(await inFlight, { ok: false, error: { code: "unavailable", message: "the extension's worker restarted" } });
    await flush();
    // A drop the port recovers from quickly is not shown: saying "offline" for a quarter of a second redrew every
    // view keyed on it, which read as the page reloading. Only the command in flight failed.
    assert.equal(store.status.value.state, "online");
    assert.equal(store.runtimes.value[0].online, true);
    assert.equal(w.server.connections, 0);

    w.server.ingest(step("aaaa0001", 2), { tabId: TAB, trusted: true });
    const before = world.streamed.length;
    assert.equal(timers.fire().ms, 250);
    await flush();
    assert.equal(store.status.value.state, "online");
    const resent = world.streamed.slice(before);
    assert.deepEqual(resent.map((m) => (m.type === "event" ? m.event.kind : m.type)), ["agent-step", "backfilled"], "only the step it missed, no reset");
    assert.equal(sessionMap.get("local:aaaa0001")?.steps?.length, 2);
    // The grace was cancelled by the reconnect: nothing is left to say "offline" later.
    assert.equal(timers.pending(), 0);
    store.dispose();
    host.dispose();
});

test("a worker that stays down past the grace is shown offline, and back online when it answers", T, async () => {
    const { world, timers, host } = setup();
    const store = new ChatStore(host);
    store.start();
    await flush();
    const w = world.current;
    // The next connection attempts fail: the worker is not coming back yet.
    world.ports[0].kill();
    const failing = world.current;
    world.current = { server: { attach: (port) => queueMicrotask(() => port.disconnect?.()) } };
    assert.equal(timers.fire().ms, 250);   // a reconnect that fails
    await flush();
    assert.equal(store.status.value.state, "online", "still inside the grace");
    // Time moves on past the grace: now it is said.
    let t;
    while ((t = timers.fire()) && t.ms !== 3000) await flush();
    await flush();
    assert.equal(store.status.value.state, "offline");
    assert.equal(store.runtimes.value[0].online, false);
    world.current = failing;
    while (store.status.value.state !== "online" && timers.fire()) await flush();
    assert.equal(store.status.value.state, "online");
    assert.equal(store.runtimes.value[0].online, true);
    assert.equal(w, failing);
    store.dispose();
    host.dispose();
});

test("a new worker: a session it rebuilt resets the transcript; one it lost keeps what is shown and says so", T, async () => {
    const { world, timers, host } = setup();
    for (const h of ["aaaa0001", "bbbb0002"]) {
        world.current.server.ingest(start(h), { tabId: TAB, trusted: true });
        world.current.server.ingest(step(h, 1), { tabId: TAB, trusted: true });
    }
    const store = new ChatStore(host);
    store.start();
    store.open("local:aaaa0001");
    await flush();

    // The worker is evicted. The new one holds bbbb0002 again (a resurrected run re-announces), not aaaa0001.
    world.ports[0].kill();
    world.current = worker("w2");
    world.current.server.ingest(start("bbbb0002"), { tabId: TAB, trusted: true });
    timers.fire();
    await flush();
    assert.equal(store.truncated.value.has("local:aaaa0001"), true);
    assert.equal(sessionMap.get("local:aaaa0001")?.steps?.length, 1, "the lost session's transcript is kept");
    assert.deepEqual([...store.index.value.keys()], ["local:bbbb0002"], "the new worker's snapshot replaces the list");
    // Live events under the new worker's epoch apply rather than being dropped as stale.
    world.current.server.ingest(step("aaaa0001", 2), { tabId: TAB, trusted: true });
    await flush();
    assert.equal(sessionMap.get("local:aaaa0001")?.steps?.length, 2);

    store.open("local:bbbb0002");
    await flush();
    assert.equal(sessionMap.get("local:bbbb0002")?.steps?.length, 0, "the rebuilt session was reset to what the new worker holds");
    store.dispose();
    host.dispose();
});

test("commands: the handler's answer comes back, and an abort resolves at once", T, async () => {
    const { world, host } = setup();
    await flush();
    assert.deepEqual(await host.send({ type: "tabs.list", runtime: "local" }), { ok: false, error: { code: "unsupported", message: "not yet" } });
    assert.deepEqual(world.current.commands, [{ type: "tabs.list", runtime: "local" }]);
    assert.equal((await host.send({ type: "session.explode", runtime: "local" })).error.code, "unsupported");
    const ctl = new AbortController();
    const p = host.send({ type: "tabs.list", runtime: "local" }, { signal: ctl.signal });
    ctl.abort();
    assert.equal((await p).error.code, "aborted");
    host.dispose();
    assert.equal((await host.send({ type: "tabs.list", runtime: "local" })).error.code, "unavailable");
});

test("a second index listener starts from what is held; a listener for another runtime hears nothing", T, async () => {
    const { world, host } = setup();
    world.current.server.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    const first = [], second = [], other = [];
    host.sessions((u) => first.push(u));
    await flush();
    host.sessions((u) => second.push(u));
    host.sessions((u) => other.push(u), { runtime: "laptop" });
    await flush();
    assert.deepEqual(second.map((u) => [u.type, u.sessions.map((s) => s.id.hash)]), [["snapshot", ["aaaa0001"]]]);
    assert.equal(first.length, 1, "the first listener was not sent a second snapshot");
    world.current.server.ingest(start("bbbb0002"), { tabId: TAB, trusted: true });
    await flush();
    assert.deepEqual([first.length, second.length, other.length], [2, 2, 0]);
    host.dispose();
});

test("a worker that restarted serves a saved session from disk, and holds live events until it has", T, async () => {
    const hash = "5aved001";
    const summary = { id: { runtime: "local", hash }, kind: "agent", status: "done", createdTs: 900, lastTs: 1000, pendingApprovals: 0, saved: true, task: "find the price" };
    const saved = savedSessions([{ summary, events: [start(hash), step(hash, 1), step(hash, 2)] }]);
    const { world, host } = setup(worker("w2", saved));
    await flush();

    // The list is there before anything is opened: an evicted worker comes back with what it saved.
    const updates = [];
    host.sessions((u) => updates.push(u));
    await flush();
    assert.deepEqual(updates.map((u) => [u.type, u.sessions?.map((s) => s.id.hash) ?? u.session?.id.hash]), [["snapshot", [hash]]]);

    // Reading the disk is slow, and an event arrives while it is in flight.
    let release;
    savedSessions.hold = new Promise((r) => { release = r; });
    host.events({ runtime: "local", hash }, () => {});
    await flush();
    assert.deepEqual(world.streamed, [], "nothing until the saved events are read");
    world.current.server.ingest(step(hash, 3), { tabId: TAB, trusted: true });
    await flush();
    assert.deepEqual(world.streamed, [], "and the live event waits for them, rather than arriving first");

    release();
    savedSessions.hold = null;
    await flush(12);

    // The contract's order survives the disk: one `reset`, the session's events in cursor order, then `backfilled`.
    // The event that arrived mid-read is INSIDE the backfill rather than after it, because by the time the backfill
    // was built it was already in the ring — the queue exists for what cannot be, not for everything that waited.
    assert.deepEqual(world.streamed.map((m) => m.type), ["reset", "event", "event", "event", "event", "backfilled"]);
    const cursors = world.streamed.filter((m) => m.type === "event").map((m) => m.cursor);
    assert.deepEqual(cursors.slice(0, 3), [1, 2, 3], "the saved events are the session from its first cursor");
    assert.ok(cursors[3] > 3, `the live event continues after them (got ${cursors[3]})`);
    assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b), "in order");
    assert.equal(new Set(cursors).size, cursors.length, "and each exactly once: the ring and the disk overlap");
    assert.equal(world.streamed.find((m) => m.type === "backfilled").truncated, false, "nothing was lost: it was all on disk");
});
