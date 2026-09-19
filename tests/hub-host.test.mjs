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
            const body = c.type === "runtime.info"
                ? { ok: true, data: { kind: "browser", contractVersion: SESSION_CONTRACT_VERSION, capabilities: CAPS, nowMs: Date.now() } }
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
    return { hub, runtime, phone, rt, pub, index, conn, host, id: hex(runtime.principal), close };
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
