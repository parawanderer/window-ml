// The chat page's hub CONNECTION against the real hub: who is there, and a sealed command answered by its result.
//
// This is the half of a `SessionHost` that needs no decisions about channels, and it is tested against the real
// `wmlhub` binary for the same reason the client below it is: what is worth checking is that two implementations
// agree, which a fake on this side cannot tell you. It self-skips without the binary — `tests/hub-client.test.mjs`
// says how to build the pinned tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB, LIVE as T, device, hex, poll, startHub } from "./fixtures/hub-harness.mjs";

const { generateIdentity, SCOPE } = await import("../src/hub/keys.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const { HubConnection } = await import("../src/chat/hub-connection.ts");

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
