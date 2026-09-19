// hub-harness.mjs — a real `wmlhub` for a test to talk to, and the principals of one account.
//
// Shared because three test files needed the same four helpers and the third copy is where they start to disagree.
// The hub is the pinned TAG built from your own clone, never somebody's working tree: see tests/hub-client.test.mjs
// and docs/dev/hub-client.md §Checks for why and how to build it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { generateAgreementKey } = await import("../../src/hub/hpke.ts");
const { generateIdentity, issueCertificate, principalId } = await import("../../src/hub/keys.ts");

export const HUB = "hub.test";
/** The hub release these tests are checked against; move it when a later one is NEEDED, not when one exists. */
export const HUB_TAG = "v0.2.0";
export const BIN =
    process.env.WMLHUB_BIN ??
    [`../../../window-ml-hub-${HUB_TAG}/target/release/wmlhub`, `../../../window-ml-hub-${HUB_TAG}/target/debug/wmlhub`]
        .map((p) => new URL(p, import.meta.url).pathname)
        .find((p) => existsSync(p));
export const HAVE_HUB = !!BIN && existsSync(BIN);
/** A skip that does not say what is missing is a test nobody ever turns on. */
export const NO_HUB = `no wmlhub ${HUB_TAG} binary: clone the tag and \`cargo build --release -p wmlhub\`, or set WMLHUB_BIN`;
/** Options for a test that needs the hub: skipped, with the reason, when there is none. */
export const LIVE = { skip: !HAVE_HUB && NO_HUB, timeout: 30_000 };

export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

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
        // A connect with no deadline can wait forever on a filtered port: a hung test rather than a failed one.
        socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
        socket.on("connect", () => { socket.end(); resolve(true); });
        socket.on("error", () => resolve(false));
    });

/** Start a hub in open-registration mode, and hand back its url and a way to stop it. */
export async function startHub() {
    const port = await freePort();
    const state = mkdtempSync(join(tmpdir(), "wmlhub-test-"));
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
export async function device(root, role, scopes, label = "") {
    const identity = await generateIdentity();
    const agreement = await generateAgreementKey();
    const chain = [await issueCertificate(root, {
        subject: identity.publicKey, agreementKey: agreement.publicKey, role, scopes, label,
        notBeforeMs: Date.now() - 3_600_000, notAfterMs: Date.now() + 3_600_000,
    })];
    return { identity, agreement, chain, principal: await principalId(identity.publicKey) };
}

/** Wait until a predicate holds, so an event arriving a tick late never makes a test flaky. */
export async function poll(what, fn, ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v !== undefined && v !== null && v !== false) return v;
        if (Date.now() > until) assert.fail(`waiting for ${what}: it never happened`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Read a client's events until one matches, failing with what was waited for rather than hanging. */
export async function until(client, what, pick, ms = 5000) {
    for (let i = 0; i < 60; i++) {
        const event = await Promise.race([
            client.next(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`waiting for ${what}: nothing arrived in ${ms} ms`)), ms)),
        ]);
        if (event.kind === "closed") assert.fail(`waiting for ${what}: ${event.reason}`);
        if (event.kind === "error") assert.fail(`waiting for ${what}: hub said ${event.message}`);
        const found = pick(event);
        if (found !== undefined && found !== null && found !== false) return found;
    }
    assert.fail(`waiting for ${what}: sixty events went by without it`);
}
