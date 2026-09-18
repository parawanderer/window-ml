// The TypeScript client against the REAL hub, over a real websocket.
//
// The hub is window-ml-hub's `wmlhub` binary, started here in `--registration open` mode with keys, so the handshake,
// the certificate chain, the sealed commands and the encrypted stream are all the shipping ones. Anything the two
// implementations disagree about — the transcript, the frame layout, a limit — fails here rather than in a browser.
//
// It SELF-SKIPS when the binary is absent, the way the CPython tests skip without their wheels: CI here has no Rust
// toolchain, and a test that cannot run should say so rather than fail. Build it with:
//
//   cd ../window-ml-hub && cargo build --release -p wmlhub
//
// or point WMLHUB_BIN at one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { generateAgreementKey } = await import("../src/hub/hpke.ts");
const { generateIdentity, issueCertificate, principalId, SCOPE } = await import("../src/hub/keys.ts");
const { StreamKey, StreamReader, ChannelKey, wrapKey, sealFrame } = await import("../src/hub/seal.ts");
const { HubClient, ConnectError } = await import("../src/hub/client.ts");
const { Kind, Role } = await import("../src/hub/wire.ts");

const HUB = "hub.test";
const BIN =
    process.env.WMLHUB_BIN ??
    ["../../window-ml-hub/target/release/wmlhub", "../../window-ml-hub/target/debug/wmlhub"]
        .map((p) => new URL(p, import.meta.url).pathname)
        .find((p) => existsSync(p));
const HAVE_HUB = !!BIN && existsSync(BIN);

/** A port nothing is listening on. Racy in principle; the hub is started immediately after. */
const freePort = () =>
    new Promise((resolve) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });

const canConnect = (port) =>
    new Promise((resolve) => {
        const socket = createConnection({ port, host: "127.0.0.1" });
        // A connect with no deadline can wait forever on a filtered port, which is a hung test rather than a failed one.
        socket.setTimeout(300, () => {
            socket.destroy();
            resolve(false);
        });
        socket.on("connect", () => {
            socket.end();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });

/** Start a hub, and hand back its url and a way to stop it. */
async function startHub() {
    const port = await freePort();
    const state = mkdtempSync(join(tmpdir(), "wmlhub-ts-"));
    const hub = spawn(
        BIN,
        ["serve", "--hub-name", HUB, "--registration", "open", "--state-dir", state, "--listen", `127.0.0.1:${port}`],
        { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    hub.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    for (let i = 0; i < 100; i++) {
        if (hub.exitCode !== null) throw new Error(`the hub exited: ${stderr}`);
        if (await canConnect(port)) {
            return {
                url: `ws://127.0.0.1:${port}`,
                stop() {
                    hub.kill();
                    rmSync(state, { recursive: true, force: true });
                },
            };
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    hub.kill();
    throw new Error(`the hub did not listen on ${port}: ${stderr}`);
}

/** One principal of an account: fresh keys, and the certificate the root issued it. */
async function device(root, role, scopes) {
    const identity = await generateIdentity();
    const agreement = await generateAgreementKey();
    const chain = [
        await issueCertificate(root, { subject: identity.publicKey, agreementKey: agreement.publicKey, role, scopes }),
    ];
    return { identity, agreement, chain, principal: await principalId(identity.publicKey) };
}

/** The next event, or a failure naming what was waited for: a test that can wait forever is a hung test. */
function nextWithin(client, what, ms = 5_000) {
    return Promise.race([
        client.next(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`waiting for ${what}: nothing arrived in ${ms} ms`)), ms)),
    ]);
}

/** Read events until one matches, so presence and backfill markers never make a test flaky. */
async function until(client, what, pick) {
    for (let i = 0; i < 30; i++) {
        const event = await nextWithin(client, what);
        if (event.kind === "closed") assert.fail(`waiting for ${what}: ${event.reason}`);
        if (event.kind === "error") assert.fail(`waiting for ${what}: hub said ${event.message}`);
        const found = pick(event);
        if (found !== undefined && found !== null && found !== false) return found;
    }
    assert.fail(`waiting for ${what}: thirty events went by without it`);
}

test("the client drives a real hub: a command, its result, and an encrypted stream", { skip: !HAVE_HUB && "wmlhub binary not built", timeout: 30_000 }, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, []);
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        const ph = await HubClient.connect({ ...common, ...phone, role: Role.ROLE_CLIENT });

        assert.deepEqual([...rt.principal], [...runtime.principal], "the hub agrees who the runtime is");
        assert.deepEqual([...rt.account], [...ph.account], "one account, two principals");
        assert.ok(rt.limits.maxPayloadBytes > 0, "the welcome carried limits");

        const channelKey = await ChannelKey.generate();
        const events = await channelKey.channel("events", new TextEncoder().encode("session-1"));
        const keys = await channelKey.channel("keys", new TextEncoder().encode("session-1"));
        ph.subscribe(runtime.principal, keys);
        ph.subscribe(runtime.principal, events);
        await until(ph, "the events backfill", (e) =>
            e.kind === "backfilled" && [...(e.stream?.channel ?? [])].join() === [...events].join(),
        );

        // the runtime grants the phone the stream key, then publishes an encrypted batch
        const key = await StreamKey.generate();
        const wrapped = await wrapKey(rt.sender(), { principal: phone.principal, agreementKey: phone.agreement.publicKey }, events, key, 1, Date.now());
        rt.publish(keys, Kind.KIND_SESSION_EVENTS, wrapped);
        const batch = new TextEncoder().encode("the night's events");
        rt.publish(events, Kind.KIND_SESSION_EVENTS, await sealFrame(rt.sender(), events, key, 1, batch));

        const grantBytes = await until(ph, "the wrapped key", (e) =>
            e.kind === "published" && [...e.stream.channel].join() === [...keys].join() ? e : null,
        );
        const grant = await ph.openGrant(grantBytes.sender, grantBytes.payload);
        const reader = new StreamReader(grant);
        const frame = await until(ph, "the published batch", (e) =>
            e.kind === "published" && [...e.stream.channel].join() === [...events].join() ? e : null,
        );
        const opened = await reader.open(frame.payload);
        assert.equal(new TextDecoder().decode(opened.batch), "the night's events");
        assert.equal(opened.counter, 1);
        assert.equal(opened.skipped, 0);

        // the phone drives the runtime, and the runtime answers
        const nonce = await ph.command(
            { principal: runtime.principal, agreementKey: runtime.agreement.publicKey },
            SCOPE.drive,
            new TextEncoder().encode("session.send hello"),
        );
        const command = await until(rt, "the command", (e) => (e.kind === "command" ? e.opened : null));
        assert.deepEqual([...command.from], [...phone.principal]);
        assert.equal(command.scope, SCOPE.drive);
        assert.equal(new TextDecoder().decode(command.body), "session.send hello");
        assert.deepEqual([...command.nonce], [...nonce]);

        await rt.result({ principal: phone.principal, agreementKey: phone.agreement.publicKey }, command.nonce, new TextEncoder().encode("sent"));
        const result = await until(ph, "the result", (e) => (e.kind === "result" ? e.opened : null));
        assert.deepEqual([...result.answers], [...nonce]);
        assert.equal(new TextDecoder().decode(result.body), "sent");

        rt.close();
        ph.close();
    } finally {
        hub.stop();
    }
});

test("a hub that names itself something else is refused before anything is signed", { skip: !HAVE_HUB && "wmlhub binary not built", timeout: 30_000 }, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view]);
        await assert.rejects(
            () => HubClient.connect({ url: hub.url, hubName: "another.hub", accountRoot: root.publicKey, ...phone, role: Role.ROLE_CLIENT }),
            (e) => e instanceof ConnectError && e.reason === "wrong-hub",
        );
    } finally {
        hub.stop();
    }
});

test("a certificate from another root is refused by the hub", { skip: !HAVE_HUB && "wmlhub binary not built", timeout: 30_000 }, async () => {
    const hub = await startHub();
    try {
        const [root, other] = [await generateIdentity(), await generateIdentity()];
        const phone = await device(other, Role.ROLE_CLIENT, [SCOPE.view]);
        await assert.rejects(
            () => HubClient.connect({ url: hub.url, hubName: HUB, accountRoot: root.publicKey, ...phone, role: Role.ROLE_CLIENT }),
            (e) => e instanceof ConnectError && e.reason === "refused" && /did not verify/.test(e.message),
        );
    } finally {
        hub.stop();
    }
});

test("every next() after the socket closes resolves with the close, not never", { skip: !HAVE_HUB && "wmlhub binary not built", timeout: 30_000 }, async () => {
    // A promise that never settles is how a reconnect loop hangs, and a hang there reads like a service worker
    // eviction for an hour before it reads like this.
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view]);
        const client = await HubClient.connect({
            url: hub.url,
            hubName: HUB,
            accountRoot: root.publicKey,
            ...phone,
            role: Role.ROLE_CLIENT,
        });
        hub.stop();
        const first = await nextWithin(client, "the close");
        assert.equal(first.kind, "closed");
        for (let i = 0; i < 3; i++) {
            const again = await nextWithin(client, "the close again");
            assert.equal(again.kind, "closed", "and again, however many times a loop asks");
        }
    } finally {
        hub.stop();
    }
});

test("a consumer that stops reading is told what it dropped", async () => {
    const { MAX_QUEUED_EVENTS } = await import("../src/hub/client.ts");
    // Driven through the private queue rather than a hub, because filling it over a socket would mean publishing
    // four thousand frames to prove an arithmetic property.
    const client = Object.create(HubClient.prototype);
    Object.assign(client, { queue: [], waiting: [], dropped: 0, ended: null });
    // No optional call: if this method is renamed the test must fail here rather than quietly testing nothing.
    const push = HubClient.prototype.push;
    assert.equal(typeof push, "function", "the queue is filled through the client's own path");
    for (let i = 0; i < MAX_QUEUED_EVENTS + 5; i++) {
        push.call(client, { kind: "presence", principal: new Uint8Array(32), role: 2, online: true });
    }
    const first = await client.next();
    assert.equal(first.kind, "dropped", "the loss is reported before the events that survived it");
    assert.equal(first.count, 5);
    assert.equal((await client.next()).kind, "presence");
    assert.equal((await client.next()).kind, "presence", "and the rest are still there");
});
