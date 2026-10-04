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
            if (c.type === "runtime.info") return { ok: true, data: { kind: "browser", contractVersion: SESSION_CONTRACT_VERSION, capabilities: { chat: true, agent: true, localSettings: true, blankStart: { url: "https://pages.example/agent-start.html", granted: false, origins: ["https://a.example/*"], browser: "Brave", extensionId: "zz9" } }, nowMs: Date.now() } };
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
        // …but `blankStart` MUST cross, whole. It exists for the remote reader: a client cannot grant a permission on
        // another machine, so the sites that machine already holds, and the browser to word the fix in, are the only
        // things that make a blocked new-tab run actionable from here. Stripping it would leave the remote case with
        // nothing to offer, and the failure would be silent — a capability that is simply never read.
        assert.deepEqual(rt.capabilities.blankStart, {
            url: "https://pages.example/agent-start.html", granted: false,
            origins: ["https://a.example/*"], browser: "Brave", extensionId: "zz9",
        }, "the whole answer reaches the device that has to act on it");
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

const { DeviceRegistry } = await import("../src/hub-devices.ts");
const { verifyRevocations } = await import("../src/hub/revocation.ts");
const { RevocationList } = await import("../src/proto/wmlhub/v1/identity.gen.ts");
const { Kind } = await import("../src/hub/wire.ts");
const { decodeChain, issueCertificate, principalId, verifyChain } = await import("../src/hub/keys.ts");
const { generateAgreementKey } = await import("../src/hub/hpke.ts");
const { CertificateBody } = await import("../src/proto/wmlhub/v1/identity.gen.ts");

/** A runtime that keeps an allowlist and signs revocations, an admin phone, and a second phone to revoke. */
async function revocationWorld({ runtimeMs = 3_600_000 } = {}) {
    const hub = await startHub();
    const root = await generateIdentity();
    // `runtimeMs` is how long the RUNTIME's own certificate lasts, which bounds every renewal it signs
    // (`OutlivesIssuer`). The default is short, as the other tests want; the renewal ones ask for a long one so a
    // renewal has room to actually extend, and one of them keeps the default to check the clamp.
    const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop", { mayPair: true, mayRevoke: true, notAfterMs: Date.now() + runtimeMs });
    const admin = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive, SCOPE.admin], "root phone");
    const tablet = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive], "tablet");
    const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
    const channelKey = crypto.getRandomValues(new Uint8Array(32));
    let saved = null;
    const devices = await DeviceRegistry.open(async () => saved, async (st) => { saved = st; });
    const membership = { hubUrl: hub.url, hubName: HUB, accountRoot: root.publicKey, chain: runtime.chain, channelKey, pairedAtMs: Date.now() };
    const statuses = [];
    const rt = new HubRuntime({
        membership, side: side(), devices, signer: runtime.identity,
        connect: () => HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME }),
        onStatus: (st) => statuses.push(st),
    });
    const running = rt.run();
    await poll("the runtime to come online", () => statuses.some((st) => st.state === "online"));
    const connect = (who) => HubClient.connect({ ...common, ...who, role: Role.ROLE_CLIENT });
    const to = { principal: runtime.principal, agreementKey: runtime.agreement.publicKey };
    const ask = async (client, scope, command) => {
        const nonce = await client.command(to, scope, new TextEncoder().encode(JSON.stringify(command)));
        for (;;) {
            const e = await client.next();
            if (e.kind === "closed") assert.fail(e.reason);
            if (e.kind === "result" && e.opened.answers.every((b, i) => b === nonce[i])) return JSON.parse(new TextDecoder().decode(e.opened.body));
        }
    };
    const close = async () => { rt.stop(); await running; hub.stop(); };
    return { root, runtime, admin, tablet, devices, rt, statuses, connect, ask, common, channelKey, id: hex(runtime.principal), close, getSaved: () => saved };
}

test("the allowlist: devices seen are listed, a revoked one is refused at once, and the runtime reconnects to rotate", LIVE, async () => {
    const w = await revocationWorld();
    let admin, tablet;
    try {
        admin = await w.connect(w.admin);
        tablet = await w.connect(w.tablet);
        await poll("both phones seen", () => w.devices.list().length === 2);
        const list = await w.ask(admin, SCOPE.admin, { type: "device.list", runtime: w.id });
        assert.equal(list.ok, true);
        assert.deepEqual(list.data.devices.map((d) => d.label).sort(), ["root phone", "tablet"]);
        assert.equal(list.data.devices.find((d) => d.label === "tablet").principal, hex(w.tablet.principal));

        // device.* needs admin, which the tablet does not hold.
        const refused = await w.ask(tablet, SCOPE.view, { type: "device.list", runtime: w.id });
        assert.equal(refused.error.code, "forbidden");
        // The runtime never revokes itself: it signs the list.
        const self = await w.ask(admin, SCOPE.admin, { type: "device.revoke", runtime: w.id, principal: w.id });
        assert.equal(self.error.code, "conflict");

        const onlinesBefore = w.statuses.filter((s) => s.state === "online").length;
        const revoked = await w.ask(admin, SCOPE.admin, { type: "device.revoke", runtime: w.id, principal: hex(w.tablet.principal) });
        assert.equal(revoked.ok, true);
        assert.equal(w.devices.isRevoked(hex(w.tablet.principal)), true, "the allowlist changed before the answer");
        await poll("the runtime to reconnect under fresh keys", () => w.statuses.filter((s) => s.state === "online").length > onlinesBefore, 10_000);
        assert.deepEqual(w.devices.list().map((d) => d.label), ["root phone"], "no longer listed");
        const after = await w.ask(tablet, SCOPE.view, { type: "runtime.info", runtime: w.id });
        assert.deepEqual([after.ok, after.error?.message], [false, "this device was revoked"]);
        assert.ok(w.getSaved().revoked.principals.includes(hex(w.tablet.principal)), "and it is persisted");
    } finally { admin?.close(); tablet?.close(); await w.close(); }
});

test("a device renews ITSELF, and the chain it is answered with verifies to the account root", LIVE, async () => {
    // Nothing can push a certificate at a device, so the asker has to be the one that installs it. The answer is the
    // delivery, which is the whole reason this is not an administrative command.
    const w = await revocationWorld({ runtimeMs: 80 * 86_400_000 });
    let tablet;
    try {
        tablet = await w.connect(w.tablet);
        await poll("the tablet seen", () => w.devices.list().some((d) => d.label === "tablet"));
        const before = CertificateBody.decode(w.tablet.chain[0].body).notAfterMs;

        const r = await w.ask(tablet, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(w.tablet.principal) });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.ok(r.data.notAfterMs > before, "a later window than the one it had");
        assert.ok(Array.isArray(r.data.chain) && r.data.chain.length >= 2, "the leaf, then the runtime that signed it");

        // What the device would do with it: decode, and check it before trusting it.
        const chain = decodeChain(r.data.chain);
        const verified = await verifyChain(w.root.publicKey, chain, Date.now());
        assert.equal(hex(await principalId(verified.leaf.subject)), hex(w.tablet.principal), "the same device");
        assert.deepEqual([...verified.leaf.scopes].sort(), [SCOPE.drive, SCOPE.view], "and the same scopes: a renewal grants nothing");
        assert.equal(CertificateBody.decode(chain[0].body).notAfterMs, r.data.notAfterMs);
        // It embeds the ROOT-issued original, which is what lets a delegate sign a renewal at all.
        assert.ok(CertificateBody.decode(chain[0].body).renews, "the predecessor travels inside it");
        // And the allowlist knows the new window, so the list a person reads does not still say it is about to lapse.
        await poll("the row to carry the new window", () => w.devices.list().find((d) => d.label === "tablet")?.notAfterMs === r.data.notAfterMs);
    } finally { tablet?.close(); await w.close(); }
});

test("renewal is the asker's own, is not signed again when it is not due, and is refused for the revocation signer", LIVE, async () => {
    const w = await revocationWorld();
    let tablet, admin;
    try {
        tablet = await w.connect(w.tablet);
        admin = await w.connect(w.admin);
        await poll("both seen", () => w.devices.list().length === 2);

        // SOMEBODY ELSE'S is refused even from the device holding `admin`: there is nowhere to deliver it to.
        const other = await w.ask(admin, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(w.tablet.principal) });
        assert.deepEqual([other.ok, other.error.code], [false, "forbidden"]);
        assert.match(other.error.message, /renews only its own/);

        // A device holding `may_revoke` is refused, because a delegate may neither issue nor renew it: only the root
        // can. Asked by that device ITSELF, so it is the `may_revoke` rule being tested and not the self-only one.
        const revoker = await device(w.root, Role.ROLE_CLIENT, [SCOPE.view], "spare signer", { mayRevoke: true });
        const signer = await w.connect(revoker);
        try {
            const r = await w.ask(signer, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(revoker.principal) });
            assert.deepEqual([r.ok, r.error.code], [false, "forbidden"]);
            assert.match(r.error.message, /only the root device may renew/);
        } finally { signer.close(); }

        // NOT DUE: answered with the window it already has, and nothing is signed. This is the rate limit and the
        // whole of `idempotencyKey` — asking in a loop cannot make the runtime sign in a loop.
        const far = await device(w.root, Role.ROLE_CLIENT, [SCOPE.view], "fresh tablet", { notAfterMs: Date.now() + 60 * 86_400_000 });
        const fresh = await w.connect(far);
        try {
            const r = await w.ask(fresh, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(far.principal) });
            assert.equal(r.ok, true, JSON.stringify(r));
            assert.equal(r.data.notAfterMs, CertificateBody.decode(far.chain[0].body).notAfterMs, "its own window, unchanged");
            assert.equal(r.data.chain, undefined, "and nothing to install");
        } finally { fresh.close(); }

        // ASKED TWICE: the same answer, not a second signature. A live connection keeps presenting the chain it opened
        // with, so the runtime cannot tell a repeat from a first ask by looking at the certificate — it remembers.
        // Re-given rather than refused, because a device whose answer was lost to a dropped connection has to be able
        // to ask again, or the renewal happened and the device expires anyway.
        const first = await w.ask(tablet, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(w.tablet.principal) });
        const again = await w.ask(tablet, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(w.tablet.principal) });
        assert.ok(first.data.chain.length >= 2);
        assert.deepEqual(again.data, first.data, "the same certificate, byte for byte, rather than a fresh signature");
    } finally { tablet?.close(); admin?.close(); await w.close(); }
});

test("a renewal never outlives the runtime that signed it, so a runtime near its own expiry hands out shorter windows", LIVE, async () => {
    // `OutlivesIssuer`. The root visit that renews the RUNTIME is the one that does not disappear, and until it
    // happens every device it renews is cut to what the runtime has left. Nobody is told, which is the point: the
    // device keeps working and the windows quietly shorten.
    const w = await revocationWorld({ runtimeMs: 2 * 86_400_000 });
    let tablet;
    try {
        tablet = await w.connect(w.tablet);
        await poll("the tablet seen", () => w.devices.list().some((d) => d.label === "tablet"));
        const r = await w.ask(tablet, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(w.tablet.principal) });
        assert.equal(r.ok, true, JSON.stringify(r));
        const mine = CertificateBody.decode(w.runtime.chain[0].body).notAfterMs;
        assert.equal(r.data.notAfterMs, mine, "cut to the runtime's own end, not the 90 days it would otherwise get");
        // And it is still a valid chain: a clamped window is a shorter certificate, never an invalid one.
        await verifyChain(w.root.publicKey, decodeChain(r.data.chain), Date.now());
    } finally { tablet?.close(); await w.close(); }
});

test("a device paired by ANOTHER DEVICE cannot be renewed, and is told to pair again rather than left guessing", LIVE, async () => {
    // A renewal's predecessor must verify under the ROOT, or a narrow renewal becomes a wide one. A device whose
    // certificate was issued by a delegate has no such predecessor and never will, so this is permanent and the
    // message says the only thing that works.
    const w = await revocationWorld();
    let paired;
    try {
        // A phone that MAY PAIR issues it, so its leaf is signed by that phone rather than by the root. (The admin
        // phone cannot: `may_pair` is granted, not implied by holding `admin`.)
        const pairer = await device(w.root, Role.ROLE_CLIENT, [SCOPE.view], "pairing phone", { mayPair: true });
        const identity = await generateIdentity();
        const agreement = await generateAgreementKey();
        const leaf = await issueCertificate(pairer.identity, {
            subject: identity.publicKey, agreementKey: agreement.publicKey, role: Role.ROLE_CLIENT,
            scopes: [SCOPE.view], label: "pairs-from-phone",
            // Strictly INSIDE the pairer's window: `OutlivesIssuer` compares the two, and taking `Date.now()` twice
            // makes the second later than the first often enough to be a flake rather than a failure.
            notBeforeMs: Date.now() - 3_600_000, notAfterMs: CertificateBody.decode(pairer.chain[0].body).notAfterMs - 1,
        });
        const sub = { identity, agreement, chain: [leaf, ...pairer.chain], principal: await principalId(identity.publicKey) };
        paired = await w.connect(sub);
        const r = await w.ask(paired, SCOPE.view, { type: "device.renew", runtime: w.id, principal: hex(sub.principal) });
        assert.deepEqual([r.ok, r.error.code], [false, "unsupported"]);
        assert.match(r.error.message, /paired by another device/);
        assert.match(r.error.message, /pair it again/);
    } finally { paired?.close(); await w.close(); }
});

test("device.scopes NARROWS at once, from the allowlist, and the certificate is not what is consulted", LIVE, async () => {
    // Taking a scope away cannot wait for the device to come and ask: it would hold the wider set for as long as it
    // stayed away. So it is the allowlist, like revocation — the certificate still says `view, drive` and nothing
    // here can change that, which is exactly why the allowlist is what the runtime reads.
    const w = await revocationWorld();
    let admin, tablet;
    try {
        admin = await w.connect(w.admin);
        tablet = await w.connect(w.tablet);
        await poll("both seen", () => w.devices.list().length === 2);
        assert.deepEqual(w.devices.list().find((d) => d.label === "tablet").scopes.sort(), [SCOPE.drive, SCOPE.view]);
        // It can drive today.
        const drive = { type: "session.pin", session: { runtime: w.id, hash: "aaaa0001" }, pinned: true };
        assert.equal((await w.ask(tablet, SCOPE.drive, drive)).ok, true);

        const r = await w.ask(admin, SCOPE.admin, { type: "device.scopes", runtime: w.id, principal: hex(w.tablet.principal), scopes: [SCOPE.view] });
        assert.deepEqual([r.ok, r.data.scopes], [true, [SCOPE.view]]);

        // At once, on the connection it already has: no reconnect, no new certificate.
        const after = await w.ask(tablet, SCOPE.drive, drive);
        assert.deepEqual([after.ok, after.error.code], [false, "forbidden"]);
        assert.match(after.error.message, /no longer allowed `drive`/);
        assert.equal((await w.ask(tablet, SCOPE.view, { type: "runtime.info", runtime: w.id })).ok, true, "what is left still works");

        // The list says what it may ACTUALLY do, which is the question a person reading it is asking.
        assert.deepEqual(w.devices.list().find((d) => d.label === "tablet").scopes, [SCOPE.view]);
        assert.ok(w.getSaved().devices[hex(w.tablet.principal)].narrowed, "and it is persisted, so a restart keeps it");
    } finally { admin?.close(); tablet?.close(); await w.close(); }
});

test("device.scopes refuses to WIDEN, and says where a wider certificate comes from", LIVE, async () => {
    // A delegate may issue only scopes it holds, and a runtime holds none: scopes are what a client may do TO a
    // runtime, so its own certificate carries an empty set. A renewal cannot carry a wider set either — re-issuing
    // the same scopes is what buys a renewal its exemption. So this is permanent, and the message says the one thing
    // that works rather than failing in general words.
    const w = await revocationWorld();
    let admin, tablet;
    try {
        admin = await w.connect(w.admin);
        // A device is on the allowlist because it was SEEN, so it has to have connected before it can be narrowed.
        tablet = await w.connect(w.tablet);
        await poll("the tablet seen", () => w.devices.list().some((d) => d.label === "tablet"));
        const wider = await w.ask(admin, SCOPE.admin, {
            type: "device.scopes", runtime: w.id, principal: hex(w.tablet.principal), scopes: [SCOPE.view, SCOPE.drive, SCOPE.approve],
        });
        assert.deepEqual([wider.ok, wider.error.code], [false, "forbidden"]);
        assert.match(wider.error.message, /approve/);
        assert.match(wider.error.message, /root device/);
        assert.deepEqual(w.devices.list().find((d) => d.label === "tablet").scopes.sort(), [SCOPE.drive, SCOPE.view], "and nothing changed");

        // Narrowing and then widening back is the same refusal: what was taken away is gone until the root re-issues.
        await w.ask(admin, SCOPE.admin, { type: "device.scopes", runtime: w.id, principal: hex(w.tablet.principal), scopes: [SCOPE.view] });
        const back = await w.ask(admin, SCOPE.admin, { type: "device.scopes", runtime: w.id, principal: hex(w.tablet.principal), scopes: [SCOPE.view, SCOPE.drive] });
        assert.deepEqual([back.ok, back.error.code], [false, "forbidden"]);

        // The runtime does not narrow ITSELF: it answers every command and signs the list, and nothing could widen it back.
        const self = await w.ask(admin, SCOPE.admin, { type: "device.scopes", runtime: w.id, principal: w.id, scopes: [] });
        assert.deepEqual([self.ok, self.error.code], [false, "conflict"]);
    } finally { admin?.close(); tablet?.close(); await w.close(); }
});

test("the revocation list is published signed on the runtime's revocations channel, and a publisher can verify it", LIVE, async () => {
    const w = await revocationWorld();
    let admin, reader;
    try {
        admin = await w.connect(w.admin);
        await new Promise((r) => setTimeout(r, 200));
        await w.ask(admin, SCOPE.admin, { type: "device.revoke", runtime: w.id, principal: hex(w.tablet.principal) });
        await poll("the reconnect", () => w.statuses.filter((s) => s.state === "online").length >= 2, 10_000);
        // What a box connector does: subscribe to channel("revocations", revoker) and verify what the ring holds.
        const box = await device(w.root, Role.ROLE_BOX_CONNECTOR, [], "box");
        reader = await HubClient.connect({ ...w.common, ...box, role: Role.ROLE_BOX_CONNECTOR });
        const channels = await ChannelKey.fromBytes(w.channelKey);
        reader.subscribe(w.runtime.principal, await channels.channel("revocations", w.runtime.principal));
        const lists = [];
        await poll("a list naming the tablet", async () => {
            const e = await Promise.race([reader.next(), new Promise((r) => setTimeout(() => r(null), 300))]);
            if (e?.kind === "published" && e.envelopeKind === Kind.KIND_SESSION_EVENTS) lists.push(RevocationList.decode(e.payload));
            for (const l of lists) {
                const v = await verifyRevocations(w.root.publicKey, l, Date.now(), null).catch(() => null);
                if (v?.principals.has(hex(w.tablet.principal))) return v;
            }
            return null;
        }, 10_000);
        const verified = await Promise.all(lists.map((l) => verifyRevocations(w.root.publicKey, l, Date.now(), null)));
        assert.ok(verified.every((v) => v.signer === w.id), "signed by the runtime, which holds may_revoke");
    } finally { admin?.close(); reader?.close(); await w.close(); }
});
