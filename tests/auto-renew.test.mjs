// Keeping a certificate current with nobody pressing anything: which conditions earn an attempt, which rule refuses
// it and why, and the driver's two promises — it never asks twice while one is in flight, and a failure is silent
// (docs/spec/NOTIFICATIONS.md). The press's own path is tests/chat-core.test.mjs and tests/hub-runtime.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_RENEW_RETRY_MS, autoRenewSkip, startAutoRenew } from "../src/chat/auto-renew.ts";
import { RENEW_WITHIN_MS } from "../src/hub/keys.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
/** A renewable client certificate with `days` left. */
const cert = (days, over = {}) => ({ notAfterMs: NOW + days * DAY, renewable: true, ...over });
const up = { runtimeOnline: true };

// --- which conditions earn an attempt ---

test("inside the renewal window, with a browser awake, it asks", () => {
    assert.equal(autoRenewSkip(cert(5), NOW, up), null);
});

test("the window it asks in is the one the runtime actually grants, not a second constant", () => {
    const justInside = { notAfterMs: NOW + RENEW_WITHIN_MS - 1000, renewable: true };
    const justOutside = { notAfterMs: NOW + RENEW_WITHIN_MS + 1000, renewable: true };
    assert.equal(autoRenewSkip(justInside, NOW, up), null);
    assert.equal(autoRenewSkip(justOutside, NOW, up), "not-due");
});

test("far from its end it does not ask: the runtime would answer with the window it already has", () => {
    assert.equal(autoRenewSkip(cert(60), NOW, up), "not-due");
});

// --- which rule refuses, and in which order ---

test("past its end nothing can renew it, because it can no longer prove who it is", () => {
    assert.equal(autoRenewSkip(cert(-1), NOW, up), "expired");
    assert.equal(autoRenewSkip(cert(0), NOW, up), "expired");
});

test("no membership at all is not a renewal problem", () => {
    assert.equal(autoRenewSkip(null, NOW, up), "no-certificate");
    assert.equal(autoRenewSkip({ notAfterMs: NaN, renewable: true }, NOW, up), "no-certificate");
});

test("the revocation signer is never asked for: only the root may renew it and no runtime will", () => {
    assert.equal(autoRenewSkip(cert(5, { mayRevoke: true }), NOW, up), "revocation-signer");
});

test("a delegate-issued certificate has no predecessor to re-sign, so asking is pointless", () => {
    assert.equal(autoRenewSkip(cert(5, { renewable: false }), NOW, up), "no-predecessor");
});

test("with nothing awake to sign it, it waits rather than asking", () => {
    assert.equal(autoRenewSkip(cert(5), NOW, { runtimeOnline: false }), "no-runtime");
});

test("expiry is reported before the account's rules, which are reported before what is reachable", () => {
    // The order is what a surface would say it is waiting for, so the most fundamental reason has to win: an expired
    // revocation signer with no runtime online is EXPIRED, not three other things.
    const hopeless = { notAfterMs: NOW - DAY, renewable: false, mayRevoke: true };
    assert.equal(autoRenewSkip(hopeless, NOW, { runtimeOnline: false }), "expired");
    assert.equal(autoRenewSkip(cert(5, { mayRevoke: true, renewable: false }), NOW, { runtimeOnline: false }), "revocation-signer");
    assert.equal(autoRenewSkip(cert(5, { renewable: false }), NOW, { runtimeOnline: false }), "no-predecessor");
});

// --- not asking twice ---

test("an attempt just made is left alone, and one long enough ago is tried again", () => {
    assert.equal(autoRenewSkip(cert(5), NOW, { ...up, lastTryMs: NOW - 1000 }), "too-soon");
    assert.equal(autoRenewSkip(cert(5), NOW, { ...up, lastTryMs: NOW - AUTO_RENEW_RETRY_MS - 1 }), null);
});

test("the backoff is comfortably past the runtime's own answer cache, so a retry is a fresh question", () => {
    // RENEW_COOLDOWN_MS in hub-runtime.ts is a minute: inside it the runtime re-gives the answer it already gave.
    assert.ok(AUTO_RENEW_RETRY_MS > 60_000, `${AUTO_RENEW_RETRY_MS} is past the runtime's cache`);
});

// --- the driver ---

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

test("it renews once the conditions are met, and says nothing when they are not", async () => {
    const outcomes = [];
    let calls = 0;
    const stop = startAutoRenew({
        read: async () => cert(5),
        runtimeOnline: () => true,
        renew: async () => { calls++; return null; },
        now: () => NOW,
        pollMs: 10_000,
        onOutcome: (r) => outcomes.push(r),
    });
    await tick();
    stop();
    assert.equal(calls, 1);
    assert.deepEqual(outcomes, [{ skip: null }]);
});

test("nothing is asked when a rule refuses, and the reason is reported rather than acted on", async () => {
    const outcomes = [];
    let calls = 0;
    const stop = startAutoRenew({
        read: async () => cert(60),
        runtimeOnline: () => true,
        renew: async () => { calls++; return null; },
        now: () => NOW, pollMs: 10_000, onOutcome: (r) => outcomes.push(r),
    });
    await tick();
    stop();
    assert.equal(calls, 0);
    assert.deepEqual(outcomes, [{ skip: "not-due" }]);
});

test("a renewal in flight is never started a second time", async () => {
    // Marked BEFORE the attempt, not after: a renewal that hangs must not be started again on every poll.
    let calls = 0;
    let release;
    const stop = startAutoRenew({
        read: async () => cert(5),
        runtimeOnline: () => true,
        renew: () => { calls++; return new Promise((r) => { release = () => r(null); }); },
        now: () => NOW, pollMs: 1,
    });
    await tick(20);
    assert.equal(calls, 1, "one attempt, however many polls went by");
    release?.();
    stop();
});

test("a failure is SILENT: it is reported to the tap and nothing else, and does not retry at once", async () => {
    const outcomes = [];
    let calls = 0;
    let clock = NOW;
    const stop = startAutoRenew({
        read: async () => cert(5),
        runtimeOnline: () => true,
        renew: async () => { calls++; return "None of your browsers is connected right now."; },
        now: () => clock, pollMs: 1, onOutcome: (r) => outcomes.push(r),
    });
    await tick(20);
    stop();
    assert.equal(calls, 1, "the backoff holds it to one attempt");
    assert.equal(outcomes[0].problem, "None of your browsers is connected right now.");
    // Nothing else is returned to the caller: there is no notice, toast or thrown error to surface.
    assert.ok(outcomes.every((o) => "skip" in o));
});

test("a throwing renewal is caught, so a client is never taken down by a background renewal", async () => {
    const outcomes = [];
    const stop = startAutoRenew({
        read: async () => cert(5),
        runtimeOnline: () => true,
        renew: async () => { throw new Error("the keyring is locked"); },
        now: () => NOW, pollMs: 10_000, onOutcome: (r) => outcomes.push(r),
    });
    await tick();
    stop();
    assert.equal(outcomes[0].problem, "the keyring is locked");
});

test("a keyring that will not answer is retried later rather than reported", async () => {
    const outcomes = [];
    let calls = 0;
    const stop = startAutoRenew({
        read: async () => { throw new Error("no indexeddb"); },
        runtimeOnline: () => true,
        renew: async () => { calls++; return null; },
        now: () => NOW, pollMs: 10_000, onOutcome: (r) => outcomes.push(r),
    });
    await tick();
    stop();
    assert.equal(calls, 0);
    assert.deepEqual(outcomes, [], "a read that failed says nothing: the next poll asks again");
});

test("stopping it stops asking", async () => {
    let calls = 0;
    const stop = startAutoRenew({
        read: async () => cert(5),
        runtimeOnline: () => true,
        renew: async () => { calls++; return null; },
        now: () => NOW, pollMs: 1,
    });
    await tick();
    stop();
    const after = calls;
    await tick(20);
    assert.equal(calls, after, "nothing more after stop()");
});
