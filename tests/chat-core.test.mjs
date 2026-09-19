// The chat core's logic with no UI: the stream rules one session subscription applies, the client store over a host,
// the composite host's routing, and the services the shared views call through. The fake host keeps real epochs and
// cursors, so these exercise what a local or hub host will send (docs/spec/SESSION_CONTRACT.md).
import test from "node:test";
import assert from "node:assert/strict";
import { SessionFeed } from "../src/chat/session-feed.ts";
import { ChatStore } from "../src/chat/chat-store.ts";
import { CompositeHost } from "../src/chat/composite-host.ts";
import { FakeHost } from "../src/chat/fake-host.ts";
import { hostServices } from "../src/chat/host-services.ts";
import { holds, mayCommand } from "../src/chat/grants.ts";
import { resumableHere } from "../src/chat/new-session.tsx";
import { CALM_KEY, LIST_KEY, PINNED_KEY, calm, dropPin, installViewPrefs, listOpen, pinned, setCalm, setListOpen, togglePin } from "../src/chat/view-mode.tsx";
import { sessionMap, view } from "../src/sidebar/store.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session-host.ts";

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const ALL = [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }];
const runtime = (id, over = {}) => ({
    id, name: id, kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION,
    capabilities: { chat: true, agent: true, sideCalls: true, highlight: true, tabs: true }, grants: ALL, ...over,
});
const summary = (runtime, hash, over = {}) => ({
    id: { runtime, hash }, kind: "agent", status: "running", task: `task ${hash}`, createdTs: 1000, lastTs: 1000,
    pendingApprovals: 0, saved: true, ...over,
});
const agentStart = (hash, task = "t") => ({ kind: "agent", id: hash, ts: 1000, save: true, session: { hash, turn: 0 }, task, model: "m", maxSteps: 10, config: null });
const step = (hash, seq, over = {}) => ({ kind: "agent-step", id: hash, ts: 1000 + seq, save: true, session: { hash, turn: seq }, step: seq, seq, tool: "exec", arguments: { js: "1" }, result: "1", ...over });
const envelope = (runtime, hash, epoch, cursor, event, v = SESSION_CONTRACT_VERSION) => ({ type: "event", v, session: { runtime, hash }, epoch, cursor, event });

/* ------------------------------ the stream rules ------------------------------ */

test("feed: applies events once, drops repeats, and keeps a lower cursor that arrives late", () => {
    const f = new SessionFeed({ runtime: "r", hash: "aaaa0001" });
    assert.equal(f.handle(envelope("r", "aaaa0001", "e1", 3, agentStart("aaaa0001"))).type, "apply");
    assert.deepEqual(f.handle(envelope("r", "aaaa0001", "e1", 3, agentStart("aaaa0001"))), { type: "drop", reason: "duplicate" });
    assert.equal(f.handle(envelope("r", "aaaa0001", "e1", 2, step("aaaa0001", 1))).type, "apply", "reordered, not repeated");
    assert.deepEqual(f.position, { epoch: "e1", cursor: 3 });
});

test("feed: an event about another session, from an unknown version, or from a stale epoch never applies", () => {
    const f = new SessionFeed({ runtime: "r", hash: "aaaa0001" });
    f.handle(envelope("r", "aaaa0001", "e1", 1, agentStart("aaaa0001")));
    assert.deepEqual(f.handle(envelope("r", "bbbb0002", "e1", 2, agentStart("bbbb0002"))), { type: "drop", reason: "other-session" });
    assert.deepEqual(f.handle(envelope("other", "aaaa0001", "e1", 2, agentStart("aaaa0001"))), { type: "drop", reason: "other-session" }, "same hash, other runtime");
    assert.deepEqual(f.handle(envelope("r", "aaaa0001", "e1", 2, step("aaaa0001", 1), SESSION_CONTRACT_VERSION + 1)), { type: "drop", reason: "version" });
    // The envelope says this session; the payload names another. A runtime must not be able to write into a record by
    // mislabelling an event.
    assert.deepEqual(f.handle(envelope("r", "aaaa0001", "e1", 2, step("cccc0003", 1))), { type: "drop", reason: "mislabelled" });
    assert.deepEqual(f.handle(envelope("r", "aaaa0001", "e0", 9, step("aaaa0001", 1))), { type: "drop", reason: "stale-epoch" });
    assert.deepEqual(f.handle({ type: "brand-new-kind", session: { runtime: "r", hash: "aaaa0001" } }), { type: "drop", reason: "version" });
});

test("feed: reset adopts the new epoch and forgets the old cursors", () => {
    const f = new SessionFeed({ runtime: "r", hash: "aaaa0001" });
    f.handle(envelope("r", "aaaa0001", "e1", 1, agentStart("aaaa0001")));
    assert.deepEqual(f.handle({ type: "reset", session: { runtime: "r", hash: "aaaa0001" }, epoch: "e2" }), { type: "reset" });
    assert.equal(f.position, undefined);
    assert.equal(f.handle(envelope("r", "aaaa0001", "e2", 1, agentStart("aaaa0001"))).type, "apply", "cursor 1 again, under the new epoch");
    assert.deepEqual(f.handle(envelope("r", "aaaa0001", "e1", 5, step("aaaa0001", 1))).reason, "stale-epoch");
});

test("feed: backfilled truncated under a new epoch keeps what is shown and accepts the live events after it", () => {
    const f = new SessionFeed({ runtime: "r", hash: "aaaa0001" });
    f.handle(envelope("r", "aaaa0001", "e1", 7, agentStart("aaaa0001")));
    assert.deepEqual(f.handle({ type: "backfilled", session: { runtime: "r", hash: "aaaa0001" }, epoch: "e2", cursor: 0, truncated: true }), { type: "backfilled", truncated: true });
    assert.equal(f.handle(envelope("r", "aaaa0001", "e2", 1, step("aaaa0001", 2))).type, "apply", "not dropped as stale");
});

/* ------------------------------ the store ------------------------------ */

function world() {
    sessionMap.clear();
    view.value = { name: "list" };
    const fake = new FakeHost({
        runtimes: [runtime("laptop"), runtime("box", { grants: [{ scope: "view" }] })],
        sessions: [
            { summary: summary("laptop", "aaaa0001"), events: [agentStart("aaaa0001", "on the laptop"), step("aaaa0001", 1)] },
            { summary: summary("box", "aaaa0001", { lastTs: 5000 }), events: [agentStart("aaaa0001", "on the box")] },
        ],
    });
    const store = new ChatStore(fake);
    store.start();
    return { fake, store };
}

test("store: the index lists both runtimes' sessions, and the same hash on two runtimes is two sessions", async () => {
    const { store } = world();
    await flush();
    assert.deepEqual(store.listed().map((s) => `${s.id.runtime}:${s.id.hash}`), ["box:aaaa0001", "laptop:aaaa0001"], "newest first");
    store.open("laptop:aaaa0001");
    await flush();
    assert.equal(sessionMap.get("laptop:aaaa0001")?.task, "on the laptop");
    assert.equal(sessionMap.get("laptop:aaaa0001")?.steps.length, 1);
    assert.equal(sessionMap.has("box:aaaa0001"), false, "only the open session is subscribed");
    store.dispose();
});

test("store: a runtime speaking another contract major is not listed", async () => {
    const { fake, store } = world();
    fake.setRuntime("box", { contractVersion: SESSION_CONTRACT_VERSION + 1 });
    await flush();
    assert.deepEqual(store.listed().map((s) => s.id.runtime), ["laptop"]);
    store.dispose();
});

test("store: reopening resumes from its position, so nothing is applied twice", async () => {
    const { fake, store } = world();
    store.open("laptop:aaaa0001");
    await flush();
    store.close();
    fake.emit("laptop:aaaa0001", step("aaaa0001", 2));
    // Count what the host re-sends: the reducer would absorb a repeated step by seq, so the transcript alone cannot
    // tell a resume from a full replay.
    const events = fake.events.bind(fake), sent = [];
    fake.events = (id, listener, opts) => events(id, (m) => { sent.push(m.type); listener(m); }, opts);
    store.open("laptop:aaaa0001");
    await flush();
    assert.deepEqual(sent, ["event", "backfilled"], "only the step it had not seen");
    assert.deepEqual(sessionMap.get("laptop:aaaa0001").steps.map((s) => s.seq), [1, 2]);
    store.dispose();
});

test("store: a restart that kept history resets the reduced session and rebuilds it from the backfill", async () => {
    const { fake, store } = world();
    store.open("laptop:aaaa0001");
    await flush();
    const before = sessionMap.get("laptop:aaaa0001");
    fake.restart("laptop:aaaa0001", true);
    await flush();
    const after = sessionMap.get("laptop:aaaa0001");
    assert.notEqual(after, before, "rebuilt, not appended to");
    assert.deepEqual(after.steps.map((s) => s.seq), [1]);
    assert.equal(store.truncated.value.has("laptop:aaaa0001"), false);
    store.dispose();
});

test("store: a restart that lost history keeps what is shown, marks it truncated, and applies what comes next", async () => {
    const { fake, store } = world();
    store.open("laptop:aaaa0001");
    await flush();
    fake.restart("laptop:aaaa0001", false);
    await flush();
    assert.equal(sessionMap.get("laptop:aaaa0001")?.steps.length, 1, "kept");
    assert.equal(store.truncated.value.has("laptop:aaaa0001"), true);
    fake.emit("laptop:aaaa0001", step("aaaa0001", 2));
    await flush();
    assert.deepEqual(sessionMap.get("laptop:aaaa0001").steps.map((s) => s.seq), [1, 2]);
    store.dispose();
});

/** A session with `n` steps and a user message after step 2, behind a ring of `ring` events. */
function pagedWorld(n, ring) {
    sessionMap.clear();
    const say = (hash, at) => ({ kind: "agent-say", id: hash, ts: 1000 + at + 0.5, save: true, session: { hash, turn: at }, text: `said after ${at}` });
    const events = [agentStart("bbbb0001")];
    for (let i = 1; i <= n; i++) { events.push(step("bbbb0001", i)); if (i === 2) events.push(say("bbbb0001", 2)); }
    const fake = new FakeHost({ runtimes: [runtime("laptop")], sessions: [{ summary: summary("laptop", "bbbb0001"), events }] });
    fake.ringLimit = ring;
    const store = new ChatStore(fake);
    store.start();
    return { fake, store, total: events.length };
}

test("store: a short ring says where paging starts, and each page replays into the transcript the full order makes", async () => {
    const K = "laptop:bbbb0001";
    const { store, total } = pagedWorld(50, 5);
    store.open(K);
    await flush();
    assert.deepEqual(store.earlier.value.get(K), { from: total - 5, more: true, truncated: false, loading: false });
    assert.equal(store.truncated.value.has(K), false, "a short ring is not a loss");

    await store.loadEarlier(K);   // positions total-45 .. total-6
    assert.deepEqual({ ...store.earlier.value.get(K) }, { from: total - 45, more: true, truncated: false, loading: false });
    await store.loadEarlier(K);   // the rest, down to the start
    assert.deepEqual({ ...store.earlier.value.get(K) }, { from: 0, more: false, truncated: false, loading: false });

    // What the whole history, applied in order, would have shown: every step once, the one user message once and
    // after step 2, with the start present so nothing is held as an orphan.
    const s = sessionMap.get(K);
    assert.deepEqual(s.steps.map((x) => x.seq), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.equal(s.says.length, 1, "the message the ring and the page both touched is not doubled");
    assert.equal(s.says[0].atStep, 2);
    assert.equal(s.task, "t");
    await store.loadEarlier(K);   // nothing more to ask for: a no-op, not a request
    store.dispose();
});

test("store: live events during paging stay, a second call while loading is ignored, and a failure is kept, not toasted", async () => {
    const K = "laptop:bbbb0001";
    const { fake, store } = pagedWorld(10, 3);
    store.open(K);
    await flush();
    fake.emit(K, step("bbbb0001", 11));
    await flush();
    let calls = 0;
    fake.handlers["session.backfill"] = () => { calls++; return undefined; };
    const one = store.loadEarlier(K), two = store.loadEarlier(K);
    assert.equal(store.earlier.value.get(K).loading, true);
    await Promise.all([one, two]);
    assert.equal(calls, 1);
    assert.deepEqual(sessionMap.get(K).steps.map((x) => x.seq), Array.from({ length: 11 }, (_, i) => i + 1), "the live step survived the replay");

    const failing = pagedWorld(10, 3);
    failing.fake.handlers["session.backfill"] = () => ({ ok: false, error: { code: "unavailable", message: "the laptop is asleep" } });
    failing.store.open(K);
    await flush();
    await failing.store.loadEarlier(K);
    assert.equal(failing.store.earlier.value.get(K).error, "the laptop is asleep");
    assert.equal(failing.store.earlier.value.get(K).loading, false);
    assert.equal(failing.store.notices.value.length, 0, "shown where the page would be, not as a notice");
    failing.store.dispose();
    store.dispose();
});

test("store: a page from another epoch is discarded, and a whole history is never offered paging", async () => {
    const K = "laptop:bbbb0001";
    const { fake, store } = pagedWorld(10, 3);
    store.open(K);
    await flush();
    const before = sessionMap.get(K).steps.length;
    fake.handlers["session.backfill"] = (c) => ({ ok: true, data: { session: c.session, epoch: "another", events: [agentStart("bbbb0001")], from: 0, more: false, truncated: false } });
    await store.loadEarlier(K);
    assert.equal(sessionMap.get(K).steps.length, before, "nothing stitched on");
    assert.equal(store.earlier.value.get(K).from > 0, true, "still pageable once the stream says what happened");
    store.dispose();

    const whole = pagedWorld(3, undefined);
    whole.store.open(K);
    await flush();
    assert.equal(whole.store.earlier.value.has(K), false, "from 0: nothing to page");
    whole.store.dispose();
});

test("store: a ring without the session's start pages back on its own until the transcript has one", async () => {
    // Every step waits in the reducer for its start, so a ring that lost it would show nothing at all. An older runtime
    // sends such a ring; the store fetches pages until the start arrives.
    const K = "laptop:bbbb0001";
    const { fake, store } = pagedWorld(60, 5);
    fake.ringDropsStart = true;
    store.open(K);
    await flush(12);
    assert.equal(store.earlier.value.get(K).from, 0);
    assert.deepEqual(sessionMap.get(K).steps.map((x) => x.seq), Array.from({ length: 60 }, (_, i) => i + 1));
    store.dispose();
});

test("store: a deleted session leaves the index and the reduced state, and the open view returns to the list", async () => {
    const { fake, store } = world();
    view.value = { name: "detail", hash: "laptop:aaaa0001" };
    store.open("laptop:aaaa0001");
    await flush();
    fake.deleteSession("laptop:aaaa0001");
    await flush();
    assert.equal(store.index.value.has("laptop:aaaa0001"), false);
    assert.equal(sessionMap.has("laptop:aaaa0001"), false);
    assert.deepEqual(view.value, { name: "list" });
    assert.match(store.notices.value.at(-1)?.text ?? "", /deleted/);
    store.dispose();
});

test("store: a mislabelled event injected by a host changes nothing", async () => {
    const { fake, store } = world();
    store.open("laptop:aaaa0001");
    await flush();
    fake.inject("laptop:aaaa0001", envelope("laptop", "aaaa0001", "whatever", 99, agentStart("ffff9999", "forged")));
    await flush();
    assert.equal(sessionMap.has("laptop:ffff9999"), false);
    assert.equal(sessionMap.get("laptop:aaaa0001")?.task, "on the laptop");
    store.dispose();
});

test("store: a runtime's clock offset moves its timestamps onto ours", async () => {
    const { fake, store } = world();
    fake.setRuntime("laptop", { clockOffsetMs: 400 });
    await flush();
    store.open("laptop:aaaa0001");
    await flush();
    assert.equal(sessionMap.get("laptop:aaaa0001")?.createdTs, 600);
    store.dispose();
});

test("store: a refused command becomes a notice saying why", async () => {
    const { store } = world();
    await flush();
    const r = await store.send({ type: "session.cancel", session: { runtime: "box", hash: "aaaa0001" } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "forbidden");
    assert.match(store.notices.value.at(-1).text, /^Not allowed from this device/);
    store.dispose();
});

/* ------------------------------ grants ------------------------------ */

test("grants: scope, expiry and session coverage", () => {
    const self = { id: "me", kind: "device" };
    const rt = runtime("r", { grants: [{ scope: "drive", sessions: "started" }, { scope: "approve", expires: 10 }, { scope: "view", sessions: ["r:aaaa0001"] }] });
    const mine = { key: "r:bbbb0002", summary: summary("r", "bbbb0002", { startedBy: self }) };
    const theirs = { key: "r:cccc0003", summary: summary("r", "cccc0003", { startedBy: { id: "else", kind: "device" } }) };
    assert.equal(holds(rt, "drive", mine, self), true);
    assert.equal(holds(rt, "drive", theirs, self), false);
    assert.equal(holds(rt, "approve", mine, self, 5), true);
    assert.equal(holds(rt, "approve", mine, self, 10), false, "expired");
    assert.equal(holds(rt, "view", { key: "r:aaaa0001" }), true);
    assert.equal(holds(rt, "view", { key: "r:dddd0004" }), false);
    assert.equal(mayCommand(rt, "session.cancel", mine, self), true, "drive, via COMMAND_SCOPE");
    assert.equal(mayCommand(rt, "approval.answer", mine, self), false, "that approve grant expired long ago");
    assert.equal(holds(undefined, "view"), false);
});

/* ------------------------------ composite ------------------------------ */

test("composite: runtimes merge, the first host wins a runtime both report, and commands route to its owner", async () => {
    const direct = new FakeHost({ runtimes: [runtime("laptop")], sessions: [{ summary: summary("laptop", "aaaa0001"), events: [agentStart("aaaa0001", "direct")] }] });
    const hub = new FakeHost({
        runtimes: [runtime("laptop"), runtime("box")],
        sessions: [
            { summary: summary("laptop", "aaaa0001"), events: [agentStart("aaaa0001", "through the hub")] },
            { summary: summary("box", "bbbb0002"), events: [agentStart("bbbb0002", "box")] },
        ],
    });
    const host = new CompositeHost([direct, hub]);
    const store = new ChatStore(host);
    sessionMap.clear();
    store.start();
    await flush(8);
    assert.deepEqual(store.runtimes.value.map((r) => r.id), ["laptop", "box"]);
    assert.equal(store.index.value.size, 2);
    store.open("laptop:aaaa0001");
    await flush(8);
    assert.equal(sessionMap.get("laptop:aaaa0001")?.task, "direct", "the direct path, not the hub's copy");
    await store.send({ type: "session.cancel", session: { runtime: "box", hash: "bbbb0002" } });
    assert.equal(hub.commands.length, 1);
    assert.equal(direct.commands.length, 0);
    const r = await host.send({ type: "tabs.list", runtime: "nowhere" });
    assert.equal(r.error?.code, "not-found");
    store.dispose();
    host.dispose();
});

test("composite: an event subscription opened before the runtime list arrives attaches once it does", async () => {
    const inner = new FakeHost({ runtimes: [runtime("late")], sessions: [{ summary: summary("late", "aaaa0001"), events: [agentStart("aaaa0001", "late")] }] });
    const host = new CompositeHost([inner]);
    const got = [];
    host.events({ runtime: "late", hash: "aaaa0001" }, (m) => got.push(m.type));
    await flush(8);
    assert.deepEqual(got, ["event", "backfilled"]);
    host.dispose();
});

/* ------------------------------ services over a host ------------------------------ */

test("services: approvals, messages and side calls become contract commands on the session's runtime", async () => {
    const { fake, store } = world();
    fake.addSession(summary("laptop", "gate0001", { status: "waiting", pendingApprovals: 1 }), [
        agentStart("gate0001"), step("gate0001", 1, { pending: true, awaitingApproval: true, result: undefined }),
    ]);
    const posted = [];
    const svc = hostServices(store, { kind: "web", prefs: { get: () => undefined, set: (k, v) => posted.push([k, v]) }, openImage: (s) => posted.push(["image", s]), saveFile() {}, copyText: async () => true });
    await flush();
    store.open("laptop:gate0001");
    await flush();
    svc.answerApproval("laptop:gate0001", 1, true, false);
    await flush();
    assert.deepEqual(fake.commands.at(-1), { type: "approval.answer", session: { runtime: "laptop", hash: "gate0001" }, seq: 1, decision: "approve" });
    const st = sessionMap.get("laptop:gate0001").steps.find((s) => s.seq === 1);
    assert.equal(st.awaitingApproval, false, "the gate closed from the runtime's own event, not optimistically");

    svc.sendToSession("laptop:gate0001", "keep going");
    await flush();
    assert.equal(fake.commands.at(-1).type, "session.send");

    assert.equal(svc.sideCalls("laptop:gate0001"), true);
    assert.equal(svc.sideCalls("box:aaaa0001"), false, "view-only on that runtime");
    const r = await svc.sideCall({ purpose: "title", session: "laptop:gate0001", messages: [{ role: "user", content: "x" }], maxTokens: 32 });
    assert.deepEqual(r, { ok: true, content: "A scripted title" });

    svc.savePref("k", 1);
    svc.openLightbox("data:image/png;base64,AA");
    assert.deepEqual(posted, [["k", 1], ["image", "data:image/png;base64,AA"]]);
    assert.equal(svc.bench, false);
    assert.equal(svc.hostAccess, null);
    store.dispose();
});

test("services: highlight goes to the open session's page, only where the runtime has one, and stays quiet on failure", async () => {
    const { fake, store } = world();
    const svc = hostServices(store, { kind: "web", prefs: { get: () => undefined, set() {} }, openImage() {}, saveFile() {}, copyText: async () => true });
    await flush();
    svc.highlight({ selector: "#x" });
    await flush();
    assert.equal(fake.commands.length, 0, "no session open");
    view.value = { name: "detail", hash: "laptop:aaaa0001" };
    svc.highlight({ selector: "#x", kind: "approve" });
    svc.highlight(null);
    await flush();
    assert.deepEqual(fake.commands.map((c) => c.ref), [{ selector: "#x" }, null]);
    fake.setRuntime("laptop", { capabilities: { highlight: false } });
    await flush();
    svc.highlight({ token: "@tool:abc1234" });
    await flush();
    assert.equal(fake.commands.length, 2, "no page on this runtime: nothing sent");
    assert.equal(store.notices.value.length, 0);
    store.dispose();
});

// --- offering a resume: the one thing that works when a run's page has gone (slice 5) ---

test("a resume is offered only where it would DO something, and refused where the composer already works", () => {
    const rt = runtime("laptop");
    const key = "laptop:aaaa0001";
    const done = (over) => summary("laptop", "aaaa0001", { status: "capped", ...over });

    // A saved run, finished, whose tab has gone: `session.send` would end at a tab that is closed.
    assert.equal(resumableHere(rt, key, done()), true);
    assert.equal(resumableHere(rt, key, done({ status: "interrupted" })), true);

    // Its tab is still open, so the composer reaches it. Two ways to continue one run is one too many.
    assert.equal(resumableHere(rt, key, done({ page: { url: "https://a.example/", tabId: 7 } })), false);
    // A page recorded but no tab is a CLOSED tab — the index drops `tabId` and keeps the url.
    assert.equal(resumableHere(rt, key, done({ page: { url: "https://a.example/" } })), true);

    // Still going: it does not need resuming.
    assert.equal(resumableHere(rt, key, done({ status: "running" })), false);
    assert.equal(resumableHere(rt, key, done({ status: "waiting" })), false);

    // Never saved: there is nothing kept to continue from.
    assert.equal(resumableHere(rt, key, done({ saved: false })), false);

    // A chat resumes on its next message and needs no page, so the page never offers it one.
    assert.equal(resumableHere(rt, key, done({ kind: "chat" })), false);

    // An offline runtime cannot be asked, and one this client may only watch will not be.
    assert.equal(resumableHere(runtime("laptop", { online: false }), key, done()), false);
    assert.equal(resumableHere(runtime("laptop", { grants: [{ scope: "view" }] }), key, done()), false);
    assert.equal(resumableHere(undefined, key, done()), false);
    assert.equal(resumableHere(rt, key, undefined), false);
});

/* ------------------------------ the page's own view preferences ------------------------------ */

/** A `PlatformPrefs` over a Map, which is all either adapter's is. */
const fakePrefs = (seed = {}) => {
    const m = new Map(Object.entries(seed));
    return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), all: m };
};

test("view prefs: calm is the default, a stored answer wins, and both toggles write back", () => {
    // Nothing stored: the page opens calm, with the list out, which is what this surface is for.
    installViewPrefs(fakePrefs());
    assert.equal(calm.value, true);
    assert.equal(listOpen.value, true);

    // A device that has said otherwise keeps its answer across a reload.
    installViewPrefs(fakePrefs({ [CALM_KEY]: false, [LIST_KEY]: false }));
    assert.equal(calm.value, false);
    assert.equal(listOpen.value, false);

    const prefs = fakePrefs();
    installViewPrefs(prefs);
    setCalm(false);
    setListOpen(false);
    assert.equal(prefs.all.get(CALM_KEY), false);
    assert.equal(prefs.all.get(LIST_KEY), false);
    assert.equal(calm.value, false);

    // A stored value of the wrong shape is ignored rather than coerced: `undefined` means "never asked".
    installViewPrefs(fakePrefs({ [CALM_KEY]: "yes" }));
    assert.equal(calm.value, true);
});

test("view prefs: a pin is this device's, survives a reload, and a delete from here takes it away", () => {
    const prefs = fakePrefs();
    installViewPrefs(prefs);
    assert.deepEqual([...pinned.value], []);
    togglePin("laptop:aaaa0001");
    togglePin("laptop:bbbb0002");
    assert.deepEqual(prefs.all.get(PINNED_KEY), ["laptop:aaaa0001", "laptop:bbbb0002"]);
    togglePin("laptop:aaaa0001");   // pressed again: unpinned
    assert.deepEqual([...pinned.value], ["laptop:bbbb0002"]);

    installViewPrefs(fakePrefs({ [PINNED_KEY]: ["laptop:bbbb0002", 7] }));   // a junk entry is dropped, not coerced
    assert.deepEqual([...pinned.value], ["laptop:bbbb0002"]);
    dropPin("laptop:bbbb0002");
    dropPin("laptop:never");   // not pinned: nothing happens
    assert.deepEqual([...pinned.value], []);
});

// The tab picker's order (src/chat/tab-tree.ts): the browser's, window by window, groups gathered under a heading.
test("tabTree: browser order per window, a group's run of tabs under its heading, and no window heading for one window", async () => {
    const { tabTree, faviconSrc, tabMatches } = await import("../src/chat/tab-tree.ts");
    const t = (tabId, index, groupId, windowId = 1) => ({ tabId, url: `https://s${tabId}.example/`, title: `T${tabId}`, active: false, windowId, index, groupId });
    // Arrival order is not strip order: `index` wins.
    const one = tabTree([t(3, 2, -1), t(1, 0, -1), t(2, 1, 7), t(4, 3, 7), t(5, 4, 7)], [{ id: 7, title: "Research", color: "blue" }]);
    assert.deepEqual(one.map((i) => i.kind === "tab" ? `${i.indent ? "  " : ""}${i.tab.tabId}` : i.kind === "group" ? `[${i.group.title}:${i.count}]` : `W${i.windowId}`),
        ["1", "[Research:1]", "  2", "3", "[Research:2]", "  4", "  5"]);
    // Two windows: a heading each, in the order their tabs arrived.
    const two = tabTree([t(9, 0, -1, 2), t(1, 0, -1, 1)]);
    assert.deepEqual(two.map((i) => i.kind === "window" ? `W${i.windowId}:${i.count}` : `${i.tab.tabId}`), ["W2:1", "9", "W1:1", "1"]);
    // A group the runtime did not describe still gets a heading; a runtime that reports no index keeps arrival order.
    const undescribed = tabTree([{ ...t(1), index: undefined, groupId: 4 }]);
    assert.deepEqual(undescribed.map((i) => i.kind), ["group", "tab"]);
    assert.equal(undescribed[0].described, false, "no name or colour to draw: a plain rule");
    assert.equal(one.find((i) => i.kind === "group").described, true);
    // Only a runtime-made data URL is ever drawn: a site's own favicon URL would be a fetch to that site.
    assert.equal(faviconSrc({ ...t(1), favicon: "data:image/png;base64,AAAA" }), "data:image/png;base64,AAAA");
    assert.equal(faviconSrc({ ...t(1), favicon: "https://evil.example/f.ico" }), null);
    assert.equal(faviconSrc({ ...t(1), favicon: "javascript:alert(1)" }), null);
    assert.ok(tabMatches(t(1), "s1.EXAMPLE") && !tabMatches(t(1), "nope"));
});

test("attentionItems: reported and checked codes once each, problems first, fixes only where this device can apply them", async () => {
    const { attentionItems, attentionCount } = await import("../src/chat/attention.ts");
    const rt = (id, caps) => ({ id, name: id === "local" ? "This browser" : "Lab box", kind: "browser", online: true, contractVersion: 1, grants: [], capabilities: caps });
    const here = rt("local", { localSettings: true, archive: { folder: "needs-grant" }, attention: ["no-model"] });
    const box = rt("box", { attention: ["no-utility-model", "some-future-code"] });
    const local = new Map([["local", ["no-model", "tab-groups", "site-access"]]]);
    const canFix = (r, fix) => r.id === "local" && (fix.kind === "settings" || fix.kind === "act");
    const items = attentionItems([here, box], local, canFix);
    assert.deepEqual(items.map((i) => i.key), [
        "local:no-model",                       // blocks: first, and once though both reported and checked
        "local:archive-folder-lapsed", "local:site-access", "box:some-future-code",   // limits
        "local:tab-groups", "box:no-utility-model",                                   // suggests
    ]);
    assert.equal(items.find((i) => i.key === "local:no-model").fix.kind, "settings");
    assert.equal(items.find((i) => i.key === "box:no-utility-model").fix, undefined, "fixed on the box, not from here");
    assert.match(items.find((i) => i.code === "some-future-code").detail, /does not know/, "an unknown code is said in general words");
    assert.equal(attentionCount(items), 4, "suggestions are never counted");
    // A dismissed suggestion is gone; a dismissed PROBLEM is not something a dismissal can hide.
    const kept = attentionItems([here, box], local, canFix, new Set(["local:tab-groups", "local:site-access"]));
    assert.ok(!kept.some((i) => i.key === "local:tab-groups"));
    assert.ok(kept.some((i) => i.key === "local:site-access"));
    // A runtime's text is never trusted as a code: long or non-string entries are dropped.
    const odd = attentionItems([rt("x", { attention: ["a".repeat(65), 7, "ok-code"] })], new Map(), () => false);
    assert.deepEqual(odd.map((i) => i.code), ["ok-code"]);
});
