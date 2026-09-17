// session-host.ts — the session contract's two helpers and its scope table. The key form is what a client keys
// its merged store by, so a round trip that lost or mangled a part would merge two runtimes' sessions into one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionKey, parseSessionKey, COMMAND_SCOPE } from "../src/session-host.ts";

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
