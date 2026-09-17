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
