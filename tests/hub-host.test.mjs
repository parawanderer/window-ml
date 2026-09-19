// HubHost end to end against the real hub: a runtime publishes its session list and a session's events, and a phone
// reads them through the SAME SessionHost contract the chat page reads the local browser through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB, LIVE, device, hex, poll, startHub } from "./fixtures/hub-harness.mjs";

const { generateIdentity, SCOPE } = await import("../src/hub/keys.ts");
const { ChannelKey } = await import("../src/hub/seal.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Kind, Role } = await import("../src/hub/wire.ts");
const { SessionPublisher, hubPublish } = await import("../src/session-publisher.ts");
const { IndexPublisher } = await import("../src/session-relay.ts");
const { HubConnection } = await import("../src/chat/hub-connection.ts");
const { HubHost } = await import("../src/chat/hub-host.ts");
const { SESSION_CONTRACT_VERSION } = await import("../src/session-host.ts");

const CAPS = { chat: true, agent: true, tabs: true };

/** A runtime that answers `runtime.info` the way the extension does, and refuses everything else. */
function answering(client) {
    void (async () => {
        for (;;) {
            const e = await client.next();
            if (e.kind === "closed") return;
            if (e.kind !== "command") continue;
            const c = JSON.parse(new TextDecoder().decode(e.opened.body));
            // A kept session with five stored events, `bbbb0005`, as `session.backfill` pages it.
            const stored = [0, 1, 2, 3, 4].map((i) => ({ kind: "agent-say", id: "bbbb0005", session: { hash: "bbbb0005", turn: 0 }, text: `stored ${i}` }));
            const body = c.type === "runtime.info"
                ? { ok: true, data: { kind: "browser", contractVersion: SESSION_CONTRACT_VERSION, capabilities: CAPS, nowMs: Date.now() } }
                : c.type === "session.backfill" && c.session.hash === "bbbb0005"
                    ? (() => {
                        const end = Math.min(c.before ?? 5, 5), from = Math.max(0, end - (c.limit ?? 100));
                        return { ok: true, data: { session: c.session, epoch: "w1.0", events: stored.slice(from, end), from, more: from > 0, truncated: false } };
                    })()
                    : { ok: false, error: { code: "unsupported", message: c.type } };
            await client.result({ principal: e.opened.from, agreementKey: e.opened.verified.leaf.agreementKey }, e.opened.nonce, new TextEncoder().encode(JSON.stringify(body)));
        }
    })();
}

async function world() {
    const hub = await startHub();
    const root = await generateIdentity();
    const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
    const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive], "phone");
    const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
    const channels = await ChannelKey.generate();   // what pairing hands every device of the account

    const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
    answering(rt);
    const pub = new SessionPublisher(hubPublish(rt, Kind.KIND_SESSION_EVENTS), channels, runtime.principal);
    await pub.deviceOnline({ id: hex(phone.principal), scopes: [SCOPE.view, SCOPE.drive], recipient: { principal: phone.principal, agreementKey: phone.agreement.publicKey } });
    const index = new IndexPublisher(hex(runtime.principal), (batch) => pub.publishIndex(batch));

    const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
    const host = new HubHost(conn, channels, { id: hex(phone.principal), kind: "device", name: "phone" });
    const close = () => { conn.close(); rt.close(); hub.stop(); };
    return { hub, root, channels, runtime, phone, rt, pub, index, conn, host, id: hex(runtime.principal), close };
}

test("the runtime is listed once it has said what it is, named by its verified label", LIVE, async () => {
    const w = await world();
    try {
        let latest = [];
        w.host.runtimes((r) => { latest = r; });
        const rt = await poll("the runtime to be described", () => latest.find((r) => r.id === w.id));
        assert.equal(rt.name, "Work laptop", "the label on its VERIFIED leaf");
        assert.equal(rt.kind, "browser");
        assert.equal(rt.contractVersion, SESSION_CONTRACT_VERSION);
        assert.deepEqual(rt.capabilities, CAPS, "from runtime.info — a transport cannot know this");
        assert.equal(rt.online, true);
        assert.deepEqual(rt.grants.map((g) => g.scope).sort(), ["drive", "view"], "this device's own scopes");
        assert.equal(typeof rt.clockOffsetMs, "number");
        // The phone's own presence arrives the same way a runtime's does; it must not be listed as one.
        assert.equal(latest.length, 1);
    } finally { w.close(); }
});

test("the session list arrives whole, through the key the runtime handed this device", LIVE, async () => {
    const w = await world();
    try {
        const row = (hash, task) => ({ id: { runtime: w.id, hash }, kind: "agent", status: "done", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, task });
        await w.index.snapshot([row("aaaa0001", "read the headline")]);
        await w.index.update({ type: "upsert", session: row("aaaa0002", "summarise the page") });

        const got = [];
        w.host.sessions((u) => got.push(u));
        await poll("the snapshot and the upsert", () => got.length >= 2);
        assert.equal(got[0].type, "snapshot", "a whole list first, never a fragment");
        assert.deepEqual(got[0].sessions.map((s) => s.task), ["read the headline"]);
        assert.equal(got[1].session.task, "summarise the page");
    } finally { w.close(); }
});

test("a session's events arrive in the contract's order, with its own cursor", LIVE, async () => {
    const w = await world();
    try {
        const ev = (cursor, text) => ({ type: "event", v: 1, session: { runtime: w.id, hash: "aaaa0001" }, epoch: "w1.0", cursor, event: { kind: "agent-say", id: "aaaa0001", text } });
        await w.pub.publish("aaaa0001", ev(1, "first"));
        await w.pub.publish("aaaa0001", ev(2, "second"));

        const got = [];
        w.host.events({ runtime: w.id, hash: "aaaa0001" }, (m) => got.push(m));
        await poll("the backfill", () => got.some((m) => m.type === "backfilled"));
        await w.pub.publish("aaaa0001", ev(3, "live"));
        await poll("the live event", () => got.some((m) => m.type === "event" && m.cursor === 3));

        assert.deepEqual(got.map((m) => (m.type === "event" ? m.event.text : m.type)), ["reset", "first", "second", "backfilled", "live"]);
    } finally { w.close(); }
});

test("a command reaches the runtime and its refusal comes back as a result", LIVE, async () => {
    const w = await world();
    try {
        await poll("the runtime", () => w.conn.peer(w.id));
        const r = await w.host.send({ type: "tabs.list", runtime: w.id });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "unsupported", "the runtime's own answer, through the seal");
    } finally { w.close(); }
});

/** Drop a connection's socket as a sleeping phone would: the connection ends without anyone having called close(). */
const drop = (conn) => conn.client.socket.close();

/** A second client on the account, granted like the phone, for a host that opens its own connections: the hub admits
 *  one connection per principal, and `world()` already holds the phone's. */
async function tablet(w) {
    const t = await device(w.root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive], "tablet");
    await w.pub.deviceOnline({ id: hex(t.principal), scopes: [SCOPE.view, SCOPE.drive], recipient: { principal: t.principal, agreementKey: t.agreement.publicKey } });
    const open = () => HubConnection.open({ url: w.hub.url, hubName: HUB, accountRoot: w.root.publicKey, ...t, role: Role.ROLE_CLIENT });
    return { t, open, self: { id: hex(t.principal), kind: "device", name: "tablet" } };
}

test("a reconnecting host moves every subscription onto the new connection: nothing repeated, nothing lost", LIVE, async () => {
    const w = await world();
    const tb = await tablet(w);
    const opened = [];
    const host = HubHost.reconnecting(async () => {
        const c = await tb.open();
        opened.push(c);
        return c;
    }, w.channels, tb.self);
    try {
        const statuses = [], lists = [], index = [], got = [];
        host.status((s) => statuses.push(s.state));
        host.runtimes((r) => lists.push(r));
        host.sessions((u) => index.push(u));
        const ev = (cursor, text) => ({ type: "event", v: 1, session: { runtime: w.id, hash: "aaaa0001" }, epoch: "w1.0", cursor, event: { kind: "agent-say", id: "aaaa0001", text } });
        const row = (hash, task) => ({ id: { runtime: w.id, hash }, kind: "agent", status: "done", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, task });
        await w.pub.publish("aaaa0001", ev(1, "first"));
        await w.pub.publish("aaaa0001", ev(2, "second"));
        await w.index.snapshot([row("aaaa0001", "read the headline")]);
        host.events({ runtime: w.id, hash: "aaaa0001" }, (m) => got.push(m));
        await poll("the backfill", () => got.some((m) => m.type === "backfilled"));
        await poll("the runtime listed", () => lists.at(-1)?.some((r) => r.id === w.id && r.online));
        await poll("the index", () => index.length >= 1);

        drop(host.connection);
        await poll("offline, with when it will try again", () => statuses.includes("offline"));
        // Published while the phone is away: it must arrive after the reconnect, once.
        await w.pub.publish("aaaa0001", ev(3, "while away"));
        await poll("a second connection", () => opened.length === 2 && statuses.at(-1) === "online", 10_000);
        await w.pub.publish("aaaa0001", ev(4, "after"));
        await w.index.update({ type: "upsert", session: row("aaaa0002", "after the reconnect") });
        await poll("the live event after the reconnect", () => got.some((m) => m.type === "event" && m.cursor === 4));
        await poll("the index update after the reconnect", () => index.some((u) => u.type === "upsert" && u.session.task === "after the reconnect"));

        const events = got.filter((m) => m.type === "event").map((m) => m.event.text);
        assert.deepEqual(events, ["first", "second", "while away", "after"], "each event exactly once, in order");
        assert.equal(got.filter((m) => m.type === "reset").length, 1, "the reconnect resumed rather than starting again");
        assert.deepEqual(statuses.slice(0, 2), ["connecting", "online"]);
        assert.deepEqual(statuses.slice(statuses.indexOf("offline")), ["offline", "connecting", "online"]);
        // The runtime never left the list while the phone was away; it only went offline.
        const after = lists.slice(lists.findIndex((l) => l.some((r) => r.id === w.id)));
        assert.ok(after.every((l) => l.some((r) => r.id === w.id)), "listed throughout");
        assert.ok(after.some((l) => l.find((r) => r.id === w.id).online === false), "shown offline while the phone was");
        await poll("online again", () => lists.at(-1).find((r) => r.id === w.id).online);
        const r = await host.send({ type: "tabs.list", runtime: w.id });
        assert.equal(r.error?.code, "unsupported", "commands go over the new connection");
    } finally { host.close(); w.close(); }
});

test("a reconnecting host backs off after a failed open, and reconnect() tries at once", LIVE, async () => {
    const w = await world();
    const tb = await tablet(w);
    let calls = 0;
    const host = HubHost.reconnecting(async () => {
        calls++;
        if (calls === 1) throw new Error("no network");
        return tb.open();
    }, w.channels, tb.self);
    try {
        const statuses = [];
        host.status((s) => statuses.push(s));
        await poll("offline after the failure", () => statuses.some((s) => s.state === "offline"));
        const off = statuses.find((s) => s.state === "offline");
        assert.equal(off.reason, "no network");
        assert.ok(off.retryAt > Date.now() - 100, "says when it will try again");
        host.reconnect();
        await poll("online without waiting out the backoff", () => statuses.at(-1).state === "online", 900);
        assert.equal(calls, 2);
        host.close();
        await w.pub.publish("aaaa0001", { type: "event", v: 1, session: { runtime: w.id, hash: "aaaa0001" }, epoch: "e", cursor: 1, event: { kind: "agent-say", id: "aaaa0001", text: "x" } });
        await new Promise((r) => setTimeout(r, 1500));
        assert.equal(calls, 2, "a closed host never reopens");
    } finally { host.close(); w.close(); }
});

test("a session that has published nothing since its runtime connected: no key, and the runtime says where its history ends", LIVE, async () => {
    // The phone app's "Loading…" forever: the runtime starts a session's stream (its key, its frames) only when the
    // session publishes, so an idle session has neither, and the ring's end marker used to wait behind a key that was
    // never coming.
    const w = await world();
    try {
        await poll("the runtime", () => w.conn.peer(w.id));
        const got = [];
        w.host.events({ runtime: w.id, hash: "bbbb0005" }, (m) => got.push(m));
        await poll("the end of the ring", () => got.some((m) => m.type === "backfilled"), 10_000);
        assert.deepEqual(got.map((m) => m.type), ["backfilled"], "no events and no reset: nothing to replace");
        assert.equal(got[0].epoch, "w1.0");
        assert.equal(got[0].from, 5, "the history ends at 5, so the client pages back from there");
        assert.equal(got[0].truncated, false);

        // When the session does publish, the key is granted and its events arrive live.
        await w.pub.publish("bbbb0005", { type: "event", v: 1, session: { runtime: w.id, hash: "bbbb0005" }, epoch: "w1.0", cursor: 6, pos: 5, event: { kind: "agent-say", id: "bbbb0005", text: "new" } });
        await poll("the live event", () => got.some((m) => m.type === "event"));
        assert.equal(got.at(-1).event.text, "new");
        assert.equal(got.at(-1).pos, 5);
    } finally { w.close(); }
});
