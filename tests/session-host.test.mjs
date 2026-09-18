// session-host.ts — the session contract's two helpers and its scope table. The key form is what a client keys
// its merged store by, so a round trip that lost or mangled a part would merge two runtimes' sessions into one.
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { sessionKey, parseSessionKey, isAbsoluteRuntimeId, isPortableSessionKey, COMMAND_SCOPE } from "../src/session-host.ts";

test("a session key round-trips", () => {
    const id = { runtime: "rt_7f3a9c", hash: "0a1b2c3d" };
    assert.equal(sessionKey(id), "rt_7f3a9c:0a1b2c3d");
    assert.deepEqual(parseSessionKey(sessionKey(id)), id);
});

test("the same hash on two runtimes gives two keys", () => {
    assert.notEqual(sessionKey({ runtime: "a", hash: "0a1b2c3d" }), sessionKey({ runtime: "b", hash: "0a1b2c3d" }));
});

test("parsing splits on the last colon", () => {
    assert.deepEqual(parseSessionKey("x:y:0a1b2c3d"), { runtime: "x:y", hash: "0a1b2c3d" });
});

test("a string that is not a key parses to null", () => {
    for (const s of ["", "0a1b2c3d", ":0a1b2c3d", "local:"]) assert.equal(parseSessionKey(s), null, s);
});

test("approving is its own scope, never drive", () => {
    assert.equal(COMMAND_SCOPE["approval.answer"], "approve");
    const approving = Object.entries(COMMAND_SCOPE).filter(([, s]) => s === "approve").map(([t]) => t);
    assert.deepEqual(approving, ["approval.answer"]);
});

test("administering devices is its own scope, never approve or drive", async () => {
    const { COMMAND_SCOPE: SCOPES } = await import("../src/session-host.ts");
    // A phone that may approve a click must not thereby be able to pair another phone, so every device.* command
    // takes `admin` and nothing else does.
    const admin = Object.entries(SCOPES).filter(([, s]) => s === "admin").map(([t]) => t).sort();
    assert.deepEqual(admin, ["device.list", "device.renew", "device.revoke", "device.scopes"]);
    for (const t of admin) assert.notEqual(SCOPES[t], "drive", t);
});

test("every command names a scope, so a new one cannot arrive unguarded", async () => {
    const { COMMAND_SCOPE: SCOPES } = await import("../src/session-host.ts");
    const src = await readFile(new URL("../src/session-host.ts", import.meta.url), "utf8");
    // The `type:` of each member of the Command union — and ONLY that union, since the index updates and the stream
    // events are unions of the same shape. The scope table must have an entry for each: a command with no scope
    // would be typed as needing one and enforced as needing none.
    const union = src.slice(src.indexOf("export type Command ="), src.indexOf("export type CommandType"));
    const declared = [...union.matchAll(/type: "([a-z.]+)"/g)].map((m) => m[1]);
    assert.ok(declared.length >= 15, `found ${declared.length} commands in the union`);
    for (const t of new Set(declared)) assert.ok(SCOPES[t], `${t} has no scope`);
});

test("a principal id compares case-insensitively, though the contract says lowercase", async () => {
    const { samePrincipal } = await import("../src/session-host.ts");
    assert.equal(samePrincipal("0a3f9c", "0a3f9c"), true);
    // A runtime that ignores the rule costs nothing: the alternative is a list with no "this device" row and no
    // logout warning, and nothing wrong to see in either value.
    assert.equal(samePrincipal("0A3F9C", "0a3f9c"), true);
    assert.equal(samePrincipal("0a3f9c", "0a3f9d"), false);
    // Absent is never equal to absent: two devices that failed to report an id are not the same device.
    for (const [a, b] of [[undefined, undefined], ["0a3f9c", undefined], [undefined, "0a3f9c"], ["", ""]]) {
        assert.equal(samePrincipal(a, b), false, `${a} vs ${b}`);
    }
});

// --- aliases are RECOGNISED, never emitted (the hub session's note on `local`) ---

test("an absolute runtime id denotes one machine; `local` denotes whoever is holding it", () => {
    const principal = "a".repeat(64);
    assert.equal(isAbsoluteRuntimeId(principal), true);
    assert.equal(isAbsoluteRuntimeId("local"), false);
    // The case is part of the contract, because the comparison that matters is `===`.
    assert.equal(isAbsoluteRuntimeId("A".repeat(64)), false);
    // Not a hash of anything: the wrong length is not an id.
    assert.equal(isAbsoluteRuntimeId("a".repeat(63)), false);
    assert.equal(isAbsoluteRuntimeId("a".repeat(65)), false);
    assert.equal(isAbsoluteRuntimeId(""), false);
    assert.equal(isAbsoluteRuntimeId(undefined), false);
});

test("a session key may leave the machine only when its runtime segment is absolute", () => {
    const principal = "b".repeat(64);
    assert.equal(isPortableSessionKey(`${principal}:a1b2c3d4`), true);

    // The one that would really hurt: a relative name inside a signed capability means one session to the granter
    // and something else to the device holding it, and a certificate cannot be edited afterwards.
    assert.equal(isPortableSessionKey("local:a1b2c3d4"), false);
    // Two browsers each holding this are two different sessions with one name — a hash is unique only within its
    // runtime, and the runtime id is what was supposed to prevent the collision.
    assert.equal(isPortableSessionKey("laptop:a1b2c3d4"), false);

    // Still a key, still malformed.
    assert.equal(isPortableSessionKey(`${principal}:`), false);
    assert.equal(isPortableSessionKey(principal), false);
    assert.equal(isPortableSessionKey(""), false);

    // A runtime id contains no colon, so the LAST one splits the key and an absolute id survives the round trip.
    assert.deepEqual(parseSessionKey(`${principal}:a1b2c3d4`), { runtime: principal, hash: "a1b2c3d4" });
});
