// Keeping a certificate current with nobody pressing anything: which conditions earn an attempt, which rule refuses
// it and why, and the driver's two promises — it never asks twice while one is in flight, and a failure is silent
// (docs/spec/NOTIFICATIONS.md). The press's own path is tests/chat-core.test.mjs and tests/hub-runtime.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_RENEW_RETRY_MS, autoRenewSkip, startAutoRenew } from "../src/chat/auto-renew.ts";
import { RENEW_WITHIN_MS } from "../src/hub/keys.ts";
import { CERT_WARN_MS } from "../src/chat/attention.ts";

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

// --- the invariant: every device an account can contain has a way to STAY in it ---

/**
 * The renewal path of a device paired on the defaults, asked of the real code rather than of a copy of it:
 * `defaultGrant` says what the certificate carries, `autoRenewSkip` says whether anything renews it. Conditions are
 * set as favourably as they ever get — inside the window, a browser awake, nothing tried recently — so the only
 * thing that can refuse is the certificate itself.
 */
async function pathFor(role, { signerKnown = false } = {}) {
    const { defaultGrant } = await import("../src/hub/pair-flow.ts");
    const { Role } = await import("../src/hub/wire.ts");
    const grant = defaultGrant(Role[role], undefined, signerKnown);
    const skip = autoRenewSkip(
        { notAfterMs: NOW + DAY, renewable: true, ...(grant.mayRevoke ? { mayRevoke: true } : {}) },
        NOW,
        { runtimeOnline: true },
    );
    return { grant, skip };
}

test("a CLIENT paired on the defaults keeps itself in the account, which is what auto-renew is for", async () => {
    const { grant, skip } = await pathFor("ROLE_CLIENT");
    assert.equal(grant.mayRevoke, false);
    assert.equal(skip, null, "nothing in its certificate stops it renewing");
});

test("a BOX CONNECTOR keeps itself in the account too", async () => {
    const { skip } = await pathFor("ROLE_BOX_CONNECTOR");
    assert.equal(skip, null);
});

test("the FIRST runtime on an account signs revocations, and that is the one device with no self-service renewal", async () => {
    // An account with no signer cannot publish a revocation at all (`publishList` returns early), so a first browser
    // has to arrive holding it. The cost is that this one device cannot renew itself: `device.renew` refuses a
    // `may_revoke` certificate, and both verifiers refuse `may_revoke` on anything a delegate issued, deliberately,
    // because keeping a second holder alive by renewal is how two signers happen. So it visits the root each quarter.
    const { grant, skip } = await pathFor("ROLE_RUNTIME", { signerKnown: false });
    assert.equal(grant.mayRevoke, true, "a first runtime becomes the signer");
    assert.equal(skip, "revocation-signer", "which is exactly why it cannot renew itself");
});

test("a SECOND runtime is not offered the grant, so it keeps itself in the account like everything else", async () => {
    // Exactly one principal may hold it: two race, the loser's removal of a lost device is refused as stale, and the
    // hub now refuses the second one's login outright.
    const { grant, skip } = await pathFor("ROLE_RUNTIME", { signerKnown: true });
    assert.equal(grant.mayRevoke, false);
    assert.equal(skip, null, "nothing in its certificate stops it renewing");
});

test("THE SET of devices with no renewal path is exactly the account's one revocation signer", async () => {
    const stuck = [];
    for (const role of ["ROLE_CLIENT", "ROLE_RUNTIME", "ROLE_BOX_CONNECTOR"]) {
        if ((await pathFor(role, { signerKnown: true })).skip !== null) stuck.push(role);
    }
    // Once an account HAS a signer, nothing else paired into it is stuck. A failure here means a new role, or a
    // changed default, has left some device unable to stay in the account — which is the regression this guards.
    assert.deepEqual(stuck, []);
});

test("the inbox never offers a renewal the runtime would refuse, which would be a press that does nothing", () => {
    // `certItems` starts offering the press at CERT_WARN_MS; a runtime grants one only inside RENEW_WITHIN_MS. If the
    // first were ever the wider of the two, a press in the gap would be answered "not due", which renewSelf reports
    // as a SUCCESS with nothing installed, so the card would say nothing and leave the warning up. That is exactly
    // the dead-button failure #323 shipped and #325 fixed, arriving by a different route.
    assert.ok(CERT_WARN_MS <= RENEW_WITHIN_MS, `the inbox warns at ${CERT_WARN_MS} but a renewal is granted at ${RENEW_WITHIN_MS}`);
});

test("auto-renew asks no earlier than the inbox would, so a silent renewal happens before anyone is told", () => {
    // Both read RENEW_WITHIN_MS, so the first thing that happens inside the window is the device renewing itself; the
    // reminder is the backstop for when that did not work. If auto-renew asked LATER than the inbox warned, every
    // user would be told about something that was about to fix itself.
    const atWarning = { notAfterMs: NOW + CERT_WARN_MS - 1000, renewable: true };
    assert.equal(autoRenewSkip(atWarning, NOW, { runtimeOnline: true }), null);
});

test("KNOWN GAP: two signers do not produce the rising version a publisher requires, so a removal can be refused as stale", async () => {
    // The SECOND consequence of the same default, and the worse one. `DeviceRegistry.sign` takes its version from
    // `Math.max(nowMs, this.state.version + 1)` where `state` is EACH RUNTIME's own, so two signers are two
    // independent sequences. A publisher refuses a version at or below the one it holds, so whichever browser's
    // clock trails the other has its revocation list rejected: removing a lost device silently fails, which
    // window-ml-hub docs/design/revocation.md names as the worst possible way for a revocation to fail.
    //
    // This is why "exactly one principal holds it at a time" is a correctness rule and not tidiness, and why
    // `defaultGrant` handing it to every runtime is a defect rather than a choice.
    //
    // WHEN THIS FAILS, two signers have stopped being reachable. Delete it and the gap tests above.
    const { DeviceRegistry } = await import("../src/hub-devices.ts");
    const { generateIdentity, issueCertificate } = await import("../src/hub/keys.ts");
    const { generateAgreementKey } = await import("../src/hub/hpke.ts");
    const { Role, RevocationBody } = await import("../src/proto/wmlhub/v1/identity.gen.ts");

    const root = await generateIdentity();
    const signer = async () => {
        const id = await generateIdentity();
        const ag = await generateAgreementKey();
        const cert = await issueCertificate(root, {
            subject: id.publicKey, agreementKey: ag.publicKey, role: Role.ROLE_RUNTIME, scopes: [], label: "",
            mayRevoke: true, notBeforeMs: NOW - DAY, notAfterMs: NOW + 30 * DAY,
        });
        return { id, chain: [cert] };
    };
    const a = await signer();
    const b = await signer();
    // Two runtimes, two stores: nothing links their versions, which is the whole point.
    const storeA = await DeviceRegistry.open(async () => null, async () => {});
    const storeB = await DeviceRegistry.open(async () => null, async () => {});

    // The version rides inside the signed body, which is the thing a publisher compares.
    const versionOf = (list) => RevocationBody.decode(list.body).version;
    const vA = versionOf(await storeA.sign(a.id, a.chain, root.publicKey, NOW));
    // B signs a second later by its own clock, which is a second BEHIND A's: an utterly ordinary amount of skew.
    const vB = versionOf(await storeB.sign(b.id, b.chain, root.publicKey, NOW - 1000));
    assert.ok(vB <= vA, `B signed ${vB}, which a publisher holding ${vA} refuses as stale`);
});

// --- the UPGRADE: devices paired before the default moved (AGENTS.md, "test the UPGRADE") ---

test("a runtime paired on the OLD default still reads as the signer, and still cannot renew itself", async () => {
    // The old default gave `may_revoke` to EVERY runtime, so an account paired before this change has certificates
    // this code did not issue and cannot reissue. Nothing here may treat them as the new default would: the facts
    // come off the certificate, never off `defaultGrant`, which is what makes the transition a non-event for them.
    const old = { notAfterMs: NOW + DAY, renewable: true, mayRevoke: true };
    assert.equal(autoRenewSkip(old, NOW, { runtimeOnline: true }), "revocation-signer");
});

test("and a SECOND runtime from an old account renews itself as soon as its certificate is replaced, not before", async () => {
    // The transition for an account with two signers is the hub's: the first to connect keeps the record, the others
    // are refused their login until re-paired without the grant. Until that re-pairing their certificate still says
    // `may_revoke`, so auto-renew must keep refusing them — it reads the certificate, not the account's new rule.
    const stillOld = { notAfterMs: NOW + DAY, renewable: true, mayRevoke: true };
    const rePaired = { notAfterMs: NOW + DAY, renewable: true };
    assert.equal(autoRenewSkip(stillOld, NOW, { runtimeOnline: true }), "revocation-signer");
    assert.equal(autoRenewSkip(rePaired, NOW, { runtimeOnline: true }), null);
});

test("an old account's extra signers are visible to the pairing screen, so it stops offering a third", async () => {
    // `revocationSigner()` reads presence leaves rather than the local default, so an account that already has two
    // signers from before this change still reports one, and a device paired now is not given a third.
    const { defaultGrant } = await import("../src/hub/pair-flow.ts");
    const { Role } = await import("../src/hub/wire.ts");
    assert.equal(defaultGrant(Role.ROLE_RUNTIME, undefined, true).mayRevoke, false);
});
