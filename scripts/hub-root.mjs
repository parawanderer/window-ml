// hub-root.mjs — an account's ROOT DEVICE on the command line: create an account on a real hub and confirm the pairing
// codes other devices show, before the pairing screens exist.
//
//   node --import tsx scripts/hub-root.mjs create wss://hub.tailnet.ts.net [--invite wmlhub-invite-…] [--label "…"]
//   node --import tsx scripts/hub-root.mjs confirm "ABCD 1234"
//   node --import tsx scripts/hub-root.mjs show
//
// It runs the same calls the screens will (`createAccount`, `lookupOffer`, `confirmOffer` in src/hub/pair-flow.ts)
// over the same Keyring, on fake-indexeddb in memory, loaded from and saved to a state file (`--state`, default
// ~/.config/window-ml/hub-root.json, mode 0600). The difference that matters: a device keeps its keys NON-EXTRACTABLE,
// and this keeps them as JWK in that file, root included, so the file IS the account. It is a test tool; an account
// made with it is one to throw away.
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Certificate } from "../src/proto/wmlhub/v1/identity.gen.ts";
import { Role } from "../src/hub/wire.ts";
import { HubClient } from "../src/hub/client.ts";
import { Keyring } from "../src/hub/keyring.ts";
import { accountId, principalId } from "../src/hub/keys.ts";
import { confirmOffer, createAccount, defaultGrant, issuerOf, lookupOffer } from "../src/hub/pair-flow.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const STATE = flag("--state") ?? join(homedir(), ".config", "window-ml", "hub-root.json");
const [command, arg] = args;

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const hex = (b) => Buffer.from(b).toString("hex");

// ---- keys as JWK: extractable, which is what lets them live in a file ----
async function newIdentity() {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}
async function newAgreement() {
    const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}
const saveKey = async (k) => ({ jwk: await crypto.subtle.exportKey("jwk", k.privateKey), publicKey: b64(k.publicKey) });
const loadKey = async (s, alg, usages) => ({ privateKey: await crypto.subtle.importKey("jwk", s.jwk, { name: alg }, true, usages), publicKey: unb64(s.publicKey) });

const saveMembership = (m) => m && ({ ...m, accountRoot: b64(m.accountRoot), channelKey: b64(m.channelKey), chain: m.chain.map((c) => b64(Certificate.encode(c).finish())) });
const loadMembership = (m) => m && ({ ...m, accountRoot: unb64(m.accountRoot), channelKey: unb64(m.channelKey), chain: m.chain.map((c) => Certificate.decode(unb64(c))) });

/** The state file into a Keyring on a fresh in-memory IndexedDB, with this principal's keys in it (generated if new). */
async function openRing() {
    const idb = new IDBFactory();
    const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
    const records = {
        self: saved
            ? { identity: await loadKey(saved.self.identity, "Ed25519", ["sign"]), agreement: await loadKey(saved.self.agreement, "X25519", ["deriveBits"]) }
            : { identity: await newIdentity(), agreement: await newAgreement() },
    };
    if (saved?.membership) records.membership = loadMembership(saved.membership);
    if (saved?.root) records.root = { ...saved.root, identity: await loadKey(saved.root.identity, "Ed25519", ["sign"]), channelKey: unb64(saved.root.channelKey) };
    // Seeded with the Keyring's own layout (one store, "k", keyed by record name), then opened as a Keyring.
    await new Promise((resolve, reject) => {
        const r = idb.open("ml-hub-keyring", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("k");
        r.onsuccess = () => {
            const t = r.result.transaction("k", "readwrite");
            for (const [k, v] of Object.entries(records)) t.objectStore("k").put(v, k);
            t.oncomplete = () => { r.result.close(); resolve(); };
            t.onerror = () => reject(t.error);
        };
        r.onerror = () => reject(r.error);
    });
    return Keyring.open("ml-hub-keyring", idb);
}

async function persist(ring) {
    const me = await ring.load();
    const out = {
        note: "window-ml hub-root.mjs: an account's ROOT key in the clear. A test account; delete this file to forget it.",
        self: { identity: await saveKey(me.identity), agreement: await saveKey(me.agreement) },
        membership: saveMembership(me.membership),
        root: me.root && { ...me.root, identity: await saveKey(me.root.identity), channelKey: b64(me.root.channelKey) },
    };
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(out, null, 2), { mode: 0o600 });
    chmodSync(STATE, 0o600);
}

async function connect(me) {
    const m = me.membership;
    return HubClient.connect({
        url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement, chain: m.chain,
        accountRoot: m.accountRoot, role: Role.ROLE_CLIENT,
    });
}

const ROLE_NAME = { [Role.ROLE_RUNTIME]: "runtime", [Role.ROLE_CLIENT]: "client", [Role.ROLE_BOX_CONNECTOR]: "box connector" };

async function main() {
    const ring = await openRing();
    try {
        if (command === "create") {
            if (!arg) throw new Error("usage: create <wss://hub> [--invite <token>] [--label <name>]");
            const invite = flag("--invite");
            const m = await createAccount(ring, {
                hubUrl: arg, label: flag("--label") ?? "hub-root.mjs", root: await newIdentity(),
                invite: invite ? new TextEncoder().encode(invite) : undefined,
            });
            await persist(ring);
            console.log(`account ${hex(await accountId(m.accountRoot)).slice(0, 16)}… on ${m.hubName}\nsaved to ${STATE}`);
        } else if (command === "confirm") {
            if (!arg) throw new Error('usage: confirm "ABCD 1234"');
            const me = await ring.load();
            const issuer = await issuerOf(ring);
            if (!me?.membership || !issuer) throw new Error(`no account in ${STATE}; run create first`);
            const client = await connect(me);
            try {
                const found = await lookupOffer(client, arg);
                const grant = defaultGrant(found.offer.role, issuer);
                console.log(`offer: ${ROLE_NAME[found.offer.role] ?? found.offer.role} "${found.offer.label}"`);
                console.log(`fingerprint: ${found.fingerprint}`);
                console.log(`grant: scopes [${grant.scopes.join(", ")}]${grant.mayPair ? " may-pair" : ""}${grant.mayRevoke ? " may-revoke" : ""}`);
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const said = (await rl.question("Does the other screen show the same fingerprint? Type yes to confirm: ")).trim();
                rl.close();
                if (said !== "yes") { console.log("not confirmed; nothing was sent"); return; }
                await confirmOffer(client, issuer, found, grant);
                console.log("answered: the other device should now say it is paired");
            } finally {
                client.close();
            }
        } else if (command === "show") {
            const me = await ring.load();
            if (!me?.membership) { console.log(`no account in ${STATE}`); return; }
            console.log(`hub ${me.membership.hubName} (${me.membership.hubUrl})`);
            console.log(`account ${hex(await accountId(me.membership.accountRoot))}`);
            console.log(`account root ${hex(me.membership.accountRoot)} (what wmlbox prints as its Account)`);
            console.log(`this device ${hex(await principalId(me.identity.publicKey))}${me.root ? " (holds the root)" : ""}`);
        } else {
            console.log("usage: hub-root.mjs create <wss://hub> [--invite T] [--label L] | confirm <code> | show   [--state <file>]");
            process.exitCode = 2;
        }
    } finally {
        ring.close();
    }
}

main().catch((e) => { console.error(`hub-root: ${e?.message ?? e}`); process.exit(1); });
