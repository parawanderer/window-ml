// HubRuntime (src/hub-runtime.ts) against the real hub, read by the chat page's own client (HubConnection + HubHost):
// the runtime publishes its index and a session's events under its PRINCIPAL rather than its local id, answers
// commands through its local handler, never tells a remote device its settings are editable, and refuses a command
// whose declared scope is not the one its type needs, even when the sender holds that scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB, LIVE, device, hex, poll, startHub } from "./fixtures/hub-harness.mjs";

const { generateIdentity, SCOPE } = await import("../src/hub/keys.ts");
const { ChannelKey } = await import("../src/hub/seal.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const { HubConnection } = await import("../src/chat/hub-connection.ts");
const { HubHost } = await import("../src/chat/hub-host.ts");
const { SESSION_CONTRACT_VERSION } = await import("../src/session-host.ts");
const { HubRuntime, rehome } = await import("../src/hub-runtime.ts");

test("rehome swaps a local runtime id for the principal wherever a `runtime` key holds one, in a copy", () => {
    const before = { type: "upsert", session: { id: { runtime: "local", hash: "a" }, task: "local" }, other: { runtime: "elsewhere" } };
    const after = rehome(before, new Set(["local"]), "ab12");
    assert.deepEqual(after, { type: "upsert", session: { id: { runtime: "ab12", hash: "a" }, task: "local" }, other: { runtime: "elsewhere" } });
    assert.equal(before.session.id.runtime, "local", "the original is untouched");
});

const row = (hash, task) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, task });

/** A stand-in for the worker's session server: a list, a sink it feeds, and a command handler that records. */
function side() {
    const sinks = new Set();
    const commands = [];
    return {
        commands,
        localIds: ["local"],
        list: () => [row("aaaa0001", "read the headline")],
        watch: (sink) => { sinks.add(sink); return () => sinks.delete(sink); },
        emit: (fn) => { for (const s of sinks) fn(s); },
        async command(c) {
            commands.push(c);
            if (c.type === "runtime.info") return { ok: true, data: { kind: "browser", contractVersion: SESSION_CONTRACT_VERSION, capabilities: { chat: true, agent: true, localSettings: true }, nowMs: Date.now() } };
            if (c.type === "session.pin") return { ok: true, data: { session: c.session } };
            return { ok: false, error: { code: "unsupported", message: c.type } };
        },
    };
}

async function world(phoneScopes = [SCOPE.view, SCOPE.drive]) {
    const hub = await startHub();
    const root = await generateIdentity();
    const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
    const phone = await device(root, Role.ROLE_CLIENT, phoneScopes, "phone");
    // a second device with the same scopes, for a test that seals by hand: one principal logs in once
    const other = await device(root, Role.ROLE_CLIENT, phoneScopes, "other");
    const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
    const channelKey = crypto.getRandomValues(new Uint8Array(32));
    const s = side();
    const membership = { hubUrl: hub.url, hubName: HUB, accountRoot: root.publicKey, chain: runtime.chain, channelKey, pairedAtMs: Date.now() };
    const statuses = [];
    const rt = new HubRuntime({ membership, side: s, connect: () => HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME }), onStatus: (st) => statuses.push(st) });
    const running = rt.run();
    await poll("the runtime to come online", () => statuses.some((st) => st.state === "online"));

    const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
    const host = new HubHost(conn, await ChannelKey.fromBytes(channelKey), { id: hex(phone.principal), kind: "device", name: "phone" });
    const close = async () => { conn.close(); rt.stop(); await running; hub.stop(); };
    return { s, rt, conn, host, phone, other, runtime, common, id: hex(runtime.principal), statuses, close };
}

test("a phone lists the runtime, sees its sessions under its principal, and is not told its settings are editable", LIVE, async () => {
    const w = await world();
    try {
        let runtimes = [];
        w.host.runtimes((r) => { runtimes = r; });
        const rt = await poll("the runtime to be described", () => runtimes.find((r) => r.id === w.id));
        assert.equal(rt.name, "Work laptop");
        assert.equal(rt.capabilities.localSettings, undefined, "a remote device never edits this runtime's settings");
        assert.deepEqual(w.s.commands[0], { type: "runtime.info", runtime: "local" }, "addressed by principal, run by local id");

        const got = [];
        w.host.sessions((u) => got.push(u));
        await poll("the snapshot", () => got.some((u) => u.type === "snapshot"));
        const snap = got.find((u) => u.type === "snapshot");
        assert.deepEqual(snap.sessions.map((x) => [x.id.runtime, x.task]), [[w.id, "read the headline"]]);

        // A change the worker's index makes later reaches the phone too, rehomed.
        w.s.emit((sink) => sink.index({ type: "upsert", session: row("aaaa0002", "summarise the page") }));
        const up = await poll("the upsert", () => got.find((u) => u.type === "upsert"));
        assert.deepEqual([up.session.id.runtime, up.session.task], [w.id, "summarise the page"]);

        // A command with a session in it is rehomed both ways.
        const pinned = await w.host.send({ type: "session.pin", session: { runtime: w.id, hash: "aaaa0001" }, pinned: true });
        assert.equal(pinned.ok, true);
        assert.deepEqual(w.s.commands.at(-1).session, { runtime: "local", hash: "aaaa0001" });
        assert.deepEqual(pinned.data.session, { runtime: w.id, hash: "aaaa0001" });
    } finally { await w.close(); }
});

test("a session's events, published as they happen, reach a phone watching it", LIVE, async () => {
    const w = await world();
    try {
        let runtimes = [];
        w.host.runtimes((r) => { runtimes = r; });
        await poll("the runtime", () => runtimes.find((r) => r.id === w.id));
        const seen = [];
        w.host.events({ runtime: w.id, hash: "aaaa0001" }, (m) => seen.push(m));
        const session = { runtime: "local", hash: "aaaa0001" };
        const ev = (cursor, kind) => ({ type: "event", v: SESSION_CONTRACT_VERSION, session, epoch: "e1", cursor, event: { kind, id: "aaaa0001", ts: cursor, session: { hash: "aaaa0001", turn: 0 } } });
        // Published once the phone is granted: a moment after presence, so give the grant a beat.
        await new Promise((r) => setTimeout(r, 200));
        w.s.emit((sink) => sink.stream("aaaa0001", ev(1, "agent")));
        w.s.emit((sink) => sink.stream("aaaa0001", ev(2, "agent-result")));
        const events = await poll("both events", () => { const e = seen.filter((m) => m.type === "event"); return e.length >= 2 && e; });
        assert.deepEqual(events.map((m) => [m.session.runtime, m.cursor, m.event.kind]), [[w.id, 1, "agent"], [w.id, 2, "agent-result"]]);
    } finally { await w.close(); }
});

test("a command whose declared scope is not the one its type needs is refused, though the sender holds the scope it declared", LIVE, async () => {
    const w = await world([SCOPE.view]);
    let raw;
    try {
        // A bare client: HubConnection would refuse to send this, which is exactly why the runtime has to check too.
        raw = await HubClient.connect({ ...w.common, ...w.other, role: Role.ROLE_CLIENT });
        const to = { principal: w.runtime.principal, agreementKey: w.runtime.agreement.publicKey };
        const body = (c) => new TextEncoder().encode(JSON.stringify(c));
        const answerTo = async (nonce) => {
            for (;;) {
                const e = await raw.next();
                if (e.kind === "closed") assert.fail(e.reason);
                if (e.kind === "result" && e.opened.answers.every((b, i) => b === nonce[i])) return JSON.parse(new TextDecoder().decode(e.opened.body));
            }
        };
        const deleted = await answerTo(await raw.command(to, SCOPE.view, body({ type: "session.delete", session: { runtime: w.id, hash: "aaaa0001" } })));
        assert.deepEqual([deleted.ok, deleted.error.code], [false, "forbidden"]);
        assert.ok(w.s.commands.every((c) => c.type !== "session.delete"), "the handler never saw it");
        const garbage = await answerTo(await raw.command(to, SCOPE.view, new TextEncoder().encode("not json")));
        assert.deepEqual([garbage.ok, garbage.error.code], [false, "invalid"]);
        const info = await answerTo(await raw.command(to, SCOPE.view, body({ type: "runtime.info", runtime: w.id })));
        assert.equal(info.ok, true, "a command whose scope matches still runs");
    } finally { raw?.close(); await w.close(); }
});
