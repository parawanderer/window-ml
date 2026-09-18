// The chat page's hub CONNECTION against the real hub: who is there, and a sealed command answered by its result.
//
// This is the half of a `SessionHost` that needs no decisions about channels, and it is tested against the real
// `wmlhub` binary for the same reason the client below it is: what is worth checking is that two implementations
// agree, which a fake on this side cannot tell you. It self-skips without the binary — `tests/hub-client.test.mjs`
// says how to build the pinned tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { generateAgreementKey } = await import("../src/hub/hpke.ts");
const { generateIdentity, issueCertificate, principalId, SCOPE } = await import("../src/hub/keys.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const { HubConnection } = await import("../src/chat/hub-connection.ts");

const HUB = "hub.test";
const HUB_TAG = "v0.2.0";
const BIN =
    process.env.WMLHUB_BIN ??
    [`../../window-ml-hub-${HUB_TAG}/target/release/wmlhub`, `../../window-ml-hub-${HUB_TAG}/target/debug/wmlhub`]
        .map((p) => new URL(p, import.meta.url).pathname)
        .find((p) => existsSync(p));
const HAVE_HUB = !!BIN && existsSync(BIN);
const NO_HUB = `no wmlhub ${HUB_TAG} binary: clone the tag and \`cargo build --release -p wmlhub\`, or set WMLHUB_BIN`;
const T = { skip: !HAVE_HUB && NO_HUB, timeout: 30_000 };

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

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
        socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
        socket.on("connect", () => { socket.end(); resolve(true); });
        socket.on("error", () => resolve(false));
    });

async function startHub() {
    const port = await freePort();
    const state = mkdtempSync(join(tmpdir(), "wmlhub-conn-"));
    const hub = spawn(BIN, ["serve", "--hub-name", HUB, "--registration", "open", "--state-dir", state, "--listen", `127.0.0.1:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    hub.stderr.on("data", (d) => { stderr += d; });
    const stop = () => { hub.kill(); try { rmSync(state, { recursive: true, force: true }); } catch { /* gone */ } };
    for (let i = 0; i < 100; i++) {
        if (await canConnect(port)) return { url: `ws://127.0.0.1:${port}`, stop };
        await new Promise((r) => setTimeout(r, 50));
    }
    stop();
    throw new Error(`the hub did not listen on ${port}: ${stderr}`);
}

/** One principal of an account: fresh keys, and the certificate the root issued it. */
async function device(root, role, scopes, label = "") {
    const identity = await generateIdentity();
    const agreement = await generateAgreementKey();
    const chain = [await issueCertificate(root, {
        subject: identity.publicKey, agreementKey: agreement.publicKey, role, scopes, label,
        notBeforeMs: Date.now() - 3_600_000, notAfterMs: Date.now() + 3_600_000,
    })];
    return { identity, agreement, chain, principal: await principalId(identity.publicKey) };
}

/** Wait until a predicate holds, so presence arriving a tick late never makes a test flaky. */
async function poll(what, fn, ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v !== undefined && v !== null && v !== false) return v;
        if (Date.now() > until) assert.fail(`waiting for ${what}: it never happened`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A runtime that answers every command sealed to it with whatever `answer` returns for that command. */
function runtimeThatAnswers(client, answer) {
    void (async () => {
        for (;;) {
            const e = await client.next();
            if (e.kind === "closed") return;
            if (e.kind !== "command") continue;
            const body = JSON.parse(new TextDecoder().decode(e.opened.body));
            const to = { principal: e.opened.from, agreementKey: e.opened.verified.leaf.agreementKey };
            await client.result(to, e.opened.nonce, new TextEncoder().encode(JSON.stringify(answer(body))));
        }
    })();
}

test("a runtime's presence becomes a peer, verified against our own account root", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };

        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });

        const id = hex(runtime.principal);
        const peer = await poll("the runtime's presence", () => conn.peer(id));
        assert.equal(peer.online, true);
        // The NAME is the label on the VERIFIED leaf: its owner's words, proved to be theirs, and proof of nothing else.
        assert.equal(peer.name, "Work laptop");
        assert.deepEqual([...peer.recipient.agreementKey], [...runtime.agreement.publicKey], "what a command is sealed to");
        assert.ok(peer.lastSeen > 0);

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

test("a command reaches the runtime and its result comes back, matched by nonce", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };

        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        runtimeThatAnswers(rt, (c) =>
            c.type === "tabs.list"
                ? { ok: true, data: { tabs: [{ tabId: 7, url: "https://a.example/", title: "A", active: true }] } }
                : { ok: false, error: { code: "unsupported", message: `no ${c.type} here` } });

        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));

        const r = await conn.send({ type: "tabs.list", runtime: id });
        assert.equal(r.ok, true);
        assert.equal(r.data.tabs[0].title, "A");

        // A refusal from the RUNTIME is a result, not an exception: one answer shape all the way down. It has to be
        // a command this device may SEND, or the seal stops it here and the runtime never gets a say (below).
        const no = await conn.send({ type: "page.highlight", session: { runtime: id, hash: "aaaa0001" }, ref: null });
        assert.equal(no.ok, false);
        assert.equal(no.error.code, "unsupported");

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

test("a runtime nobody has heard of, and one that has gone, are told apart", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });

        // Never seen: there is nobody to be slow, so this answers at once rather than after a timeout.
        const unknown = await conn.send({ type: "tabs.list", runtime: "f".repeat(64) });
        assert.equal(unknown.error.code, "not-found");

        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));
        rt.close();

        // Gone is a different sentence from never-here, and it keeps its name so a list can still show the row.
        await poll("the runtime going away", () => conn.peer(id)?.online === false);
        const gone = await conn.send({ type: "tabs.list", runtime: id });
        assert.equal(gone.error.code, "unavailable");
        assert.match(gone.error.message, /Work laptop/);

        conn.close();
    } finally { hub.stop(); }
});

test("a runtime that never answers times out as unavailable, and an abort is its own reason", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Silent laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));

        // Connected, so this is not `unavailable` for being absent: it is a runtime that took the command and said
        // nothing, which a caller has to be told rather than left waiting on.
        const late = await conn.send({ type: "tabs.list", runtime: id }, { timeoutMs: 200 });
        assert.equal(late.error.code, "unavailable");
        assert.match(late.error.message, /did not answer/);

        // An abort is a different fact: the command WAS sent, and may still be carried out.
        const ctrl = new AbortController();
        const pending = conn.send({ type: "tabs.list", runtime: id }, { signal: ctrl.signal, timeoutMs: 10_000 });
        ctrl.abort();
        assert.equal((await pending).error.code, "aborted");

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

test("a command this device may not SEND is refused here, not waited on", T, async () => {
    // The seal refuses a scope the leaf does not grant, so the runtime never sees the command and never answers.
    // Before this was checked locally, the caller waited thirty seconds for something that was never going to
    // arrive — and then read "did not answer", about a runtime that was never asked.
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        let asked = 0;
        runtimeThatAnswers(rt, () => { asked++; return { ok: true, data: {} }; });
        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));

        // `device.list` needs `admin`, which this phone's certificate does not grant.
        const r = await conn.send({ type: "device.list", runtime: id }, { timeoutMs: 1500 });
        assert.equal(r.error.code, "forbidden");
        assert.match(r.error.message, /admin/);
        assert.equal(asked, 0, "and it never left this device");

        // What it DOES hold still goes through, so this is a scope check and not a refusal of everything.
        assert.equal((await conn.send({ type: "tabs.list", runtime: id })).ok, true);

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});
