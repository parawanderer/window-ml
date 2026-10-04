// What the OS is told when nobody is looking at the app: the certificate schedule handed to it in advance, and the
// one line an arriving approval earns. The rules are pure and shared by the phone (which schedules them with the OS)
// and the hosted client (which can only check while it runs), so both surfaces are covered here once; the last
// section is the hosted client's own timer, over a stubbed Notification and storage (docs/spec/NOTIFICATIONS.md).
import test from "node:test";
import assert from "node:assert/strict";
import { approvalAlert, approvalCounts, certReminders, dueReminders, nextReminderMs, reminderPlanId, reminderShownKey } from "../src/chat/reminders.ts";
import { CERT_URGENT_MS, CERT_WARN_MS } from "../src/chat/attention.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
/** A certificate with `days` left, renewable by a press unless told otherwise. */
const cert = (days, over = {}) => ({ notAfterMs: NOW + days * DAY, renewable: true, ...over });

// --- the certificate schedule ---

test("a certificate with months left is told about at every threshold, soonest first", () => {
    const plan = certReminders(cert(90), NOW);
    assert.deepEqual(plan.map((r) => r.id), ["cert-warn", "cert-urgent", "cert-last", "cert-gone"]);
    assert.deepEqual(plan.map((r) => r.atMs), [
        NOW + 90 * DAY - CERT_WARN_MS, NOW + 90 * DAY - CERT_URGENT_MS, NOW + 89 * DAY, NOW + 90 * DAY,
    ]);
    for (const r of plan) assert.ok(r.atMs > NOW, `${r.id} is in the future`);
});

test("the first reminder lands exactly as the inbox starts saying it", () => {
    const warn = certReminders(cert(90), NOW).find((r) => r.id === "cert-warn");
    assert.equal(warn.atMs, NOW + 90 * DAY - CERT_WARN_MS);
    assert.match(warn.title, /in 14 days/);
});

test("a threshold already past is left out rather than fired late", () => {
    // Paired INSIDE the warning window: the 14-day line is behind us and the inbox is already saying so on screen.
    const plan = certReminders(cert(5), NOW);
    assert.deepEqual(plan.map((r) => r.id), ["cert-urgent", "cert-last", "cert-gone"]);
});

test("inside the last day only the expiry itself is left", () => {
    assert.deepEqual(certReminders(cert(0.5), NOW).map((r) => r.id), ["cert-gone"]);
});

test("an expired certificate schedules nothing: every date it has is behind us", () => {
    assert.deepEqual(certReminders(cert(-1), NOW), []);
    assert.deepEqual(certReminders(cert(0), NOW), []);
});

test("no certificate, or one with no deadline, is no schedule", () => {
    assert.deepEqual(certReminders(null, NOW), []);
    assert.deepEqual(certReminders({ notAfterMs: NaN, renewable: true }, NOW), []);
    assert.deepEqual(certReminders({ notAfterMs: Infinity, renewable: true }, NOW), []);
});

test("the last reminder before the deadline says tomorrow, and the deadline's says it has gone", () => {
    const plan = certReminders(cert(90), NOW);
    assert.match(plan.find((r) => r.id === "cert-last").title, /runs out tomorrow$/);
    assert.match(plan.find((r) => r.id === "cert-gone").title, /has run out$/);
});

// --- what each one says, from the facts that will still be true when it fires ---

test("a renewable certificate's reminders say a press is all it takes", () => {
    for (const r of certReminders(cert(90), NOW).slice(0, 3)) assert.match(r.body, /one press/);
});

test("the revocation signer's reminders send you to the root device, which is the only thing that can renew it", () => {
    for (const r of certReminders(cert(90, { mayRevoke: true }), NOW).slice(0, 3)) {
        assert.match(r.body, /root key/);
        assert.doesNotMatch(r.body, /one press/);
    }
});

test("a certificate issued by a delegate says to pair again, because there is nothing to renew", () => {
    for (const r of certReminders(cert(90, { renewable: false }), NOW).slice(0, 3)) assert.match(r.body, /pair this one again/);
});

test("the expiry line says to pair again whatever the device was, since nothing can be renewed after it", () => {
    for (const may of [true, false]) {
        const gone = certReminders(cert(90, { mayRevoke: may }), NOW).find((r) => r.id === "cert-gone");
        assert.match(gone.body, /Pair it again/);
    }
});

test("nothing a reminder says is about a session, a task or a page", () => {
    for (const c of [cert(90), cert(90, { mayRevoke: true }), cert(90, { renewable: false })]) {
        for (const r of certReminders(c, NOW)) {
            assert.doesNotMatch(`${r.title} ${r.body}`, /session|\btask\b|\btab\b|\bpage\b|agent/i);
        }
    }
});

test("a live reading cannot reach a reminder: the same plan comes back whatever is awake right now", () => {
    // `issuerOnline` and `canRenew` are readings of this moment. Baking either into a notification set for next month
    // would put a sentence on a lock screen that was true when it was scheduled and wrong when it arrived.
    const a = certReminders({ ...cert(90), issuerOnline: true, canRenew: true }, NOW);
    const b = certReminders({ ...cert(90), issuerOnline: false, canRenew: false }, NOW);
    assert.deepEqual(a, b);
});

// --- replanning: an id is stable, a plan id is not ---

test("a renewal keeps the ids and moves the dates, so scheduling again replaces rather than duplicates", () => {
    const before = certReminders(cert(10), NOW);
    const after = certReminders(cert(100), NOW);
    assert.deepEqual(after.map((r) => r.id).filter((id) => before.some((b) => b.id === id)).sort(),
        before.map((r) => r.id).sort());
    for (const b of before) {
        const a = after.find((r) => r.id === b.id);
        assert.ok(a.atMs > b.atMs, `${b.id} moved later`);
    }
});

test("the plan id changes when a date does, and not when the same plan is computed twice", () => {
    assert.equal(reminderPlanId(certReminders(cert(90), NOW)), reminderPlanId(certReminders(cert(90), NOW + 1000)));
    assert.notEqual(reminderPlanId(certReminders(cert(90), NOW)), reminderPlanId(certReminders(cert(91), NOW)));
    assert.equal(reminderPlanId([]), "");
});

// --- the surface that can only look while it is running ---

test("nothing is due before its time, and the next wake is the soonest one", () => {
    const plan = certReminders(cert(90), NOW);
    assert.deepEqual(dueReminders(plan, [], NOW), []);
    assert.equal(nextReminderMs(plan, [], NOW), plan[0].atMs);
});

test("a reminder whose moment has passed is shown late rather than dropped", () => {
    const plan = certReminders(cert(90), NOW);
    const after = plan[1].atMs + DAY;
    assert.deepEqual(dueReminders(plan, [], after).map((r) => r.id), ["cert-warn", "cert-urgent"]);
    assert.equal(nextReminderMs(plan, [], after), plan[2].atMs);
});

test("one already shown is neither shown again nor waited for", () => {
    const plan = certReminders(cert(90), NOW);
    const shown = [reminderShownKey(plan[0])];
    assert.deepEqual(dueReminders(plan, shown, plan[0].atMs), []);
    assert.equal(nextReminderMs(plan, shown, NOW), plan[1].atMs);
});

test("what is remembered carries the date, so a renewal's new threshold is not taken as already done", () => {
    const before = certReminders(cert(10), NOW);
    const shown = [reminderShownKey(before.find((r) => r.id === "cert-urgent"))];
    const after = certReminders(cert(100), NOW);
    const moved = after.find((r) => r.id === "cert-urgent");
    assert.deepEqual(dueReminders(after, shown, moved.atMs).map((r) => r.id), ["cert-warn", "cert-urgent"]);
});

test("an empty plan has nothing due and nothing to wait for", () => {
    assert.deepEqual(dueReminders([], [], NOW), []);
    assert.equal(nextReminderMs([], [], NOW), null);
});

// --- an approval arriving while you are elsewhere ---

const counts = (...pairs) => new Map(pairs);

test("an approval that arrives while the app is not being looked at is announced", () => {
    const a = approvalAlert(counts(), counts(["s1", 1]), false);
    assert.equal(a.title, "An approval is waiting");
    assert.equal(a.id, "approval");
});

test("the same arrival is NOT announced while the list it is in is on screen", () => {
    assert.equal(approvalAlert(counts(), counts(["s1", 1]), true), null);
});

test("approvals already waiting when the app opens are not announced as news", () => {
    // The baseline is taken on the first look, so three that were already there are not three arrivals.
    const first = counts(["s1", 1], ["s2", 2]);
    assert.equal(approvalAlert(first, first, false), null);
});

test("one alert for all of them, carrying the total waiting rather than the rise", () => {
    const a = approvalAlert(counts(["s1", 2]), counts(["s1", 2], ["s2", 1]), false);
    assert.equal(a.title, "3 approvals are waiting");
});

test("an approval being answered is not an arrival", () => {
    assert.equal(approvalAlert(counts(["s1", 2]), counts(["s1", 1]), false), null);
    assert.equal(approvalAlert(counts(["s1", 1]), counts(), false), null);
});

test("a second approval on a session that already had one is an arrival", () => {
    assert.equal(approvalAlert(counts(["s1", 1]), counts(["s1", 2]), false).title, "2 approvals are waiting");
});

test("an approval alert says that one is waiting and nothing else", () => {
    const a = approvalAlert(counts(), counts(["s1", 1]), false);
    assert.doesNotMatch(`${a.title} ${a.body}`, /s1|session|task|tab/i);
});

test("the counts an index amounts to leave out the sessions with none", () => {
    const got = approvalCounts([["a", { pendingApprovals: 0 }], ["b", { pendingApprovals: 2 }], ["c", { pendingApprovals: 1 }]]);
    assert.deepEqual([...got], [["b", 2], ["c", 1]]);
    // A client's own index goes in as it is, with no array built for it.
    assert.deepEqual([...approvalCounts(new Map([["r:1", { pendingApprovals: 3 }]]))], [["r:1", 3]]);
});

// --- the hosted client's timer, which is all a web page gets ---

/** The three browser things `notify.ts` touches, each one a page can be without. */
function stubBrowser() {
    const shown = [];
    const store = new Map();
    const before = { Notification: globalThis.Notification, localStorage: globalThis.localStorage };
    class FakeNotification {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, opts) { shown.push({ title, ...opts }); }
    }
    globalThis.Notification = FakeNotification;
    globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };
    return { shown, store, restore() { globalThis.Notification = before.Notification; globalThis.localStorage = before.localStorage; } };
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

test("a due reminder is shown on the spot, and a remembered one is not shown twice", async () => {
    const env = stubBrowser();
    try {
        const { runReminders } = await import("../src/chat/notify.ts");
        const plan = certReminders(cert(90), NOW);
        const past = plan[0].atMs + 1000;
        runReminders(plan, () => past)();
        await flush();
        assert.deepEqual(env.shown.map((n) => n.title), [plan[0].title]);
        // A reload: the same plan, the same moment, and nothing more is said.
        runReminders(plan, () => past)();
        await flush();
        assert.equal(env.shown.length, 1);
    } finally { env.restore(); }
});

test("nothing is shown before its time, and stopping takes the timer with it", async () => {
    const env = stubBrowser();
    try {
        const { runReminders } = await import("../src/chat/notify.ts");
        const stop = runReminders(certReminders(cert(90), NOW), () => NOW);
        await flush();
        assert.deepEqual(env.shown, []);
        stop();
    } finally { env.restore(); }
});

test("a reminder is marked before it is shown, so a page closing mid-show cannot repeat it", async () => {
    const env = stubBrowser();
    try {
        const { runReminders } = await import("../src/chat/notify.ts");
        const plan = certReminders(cert(90), NOW);
        runReminders(plan, () => plan[0].atMs)();
        await flush();
        assert.deepEqual(JSON.parse(env.store.get("wml_reminded")), [reminderShownKey(plan[0])]);
    } finally { env.restore(); }
});

test("what is remembered is pruned to the plan, so a renewed certificate's old dates do not pile up", async () => {
    const env = stubBrowser();
    try {
        const { runReminders } = await import("../src/chat/notify.ts");
        env.store.set("wml_reminded", JSON.stringify(["cert-warn@1", "cert-urgent@2"]));
        const plan = certReminders(cert(90), NOW);
        runReminders(plan, () => plan[1].atMs)();
        await flush();
        const kept = JSON.parse(env.store.get("wml_reminded"));
        assert.deepEqual(kept.filter((k) => k.endsWith("@1") || k.endsWith("@2")), []);
        assert.equal(kept.length, 2);
    } finally { env.restore(); }
});

test("a page that was refused notifications shows none and does not throw", async () => {
    const env = stubBrowser();
    try {
        globalThis.Notification.permission = "denied";
        const { notifyState, runReminders, showNotice } = await import("../src/chat/notify.ts");
        assert.equal(notifyState(), "denied");
        assert.equal(await showNotice({ id: "x", title: "t", body: "b" }), false);
        const plan = certReminders(cert(90), NOW);
        runReminders(plan, () => plan[0].atMs)();
        await flush();
        assert.deepEqual(env.shown, []);
    } finally { env.restore(); }
});

test("a browser with no Notification at all reads as unsupported rather than failing", async () => {
    const before = globalThis.Notification;
    globalThis.Notification = undefined;
    try {
        const { notifySupported, notifyState, askNotify } = await import("../src/chat/notify.ts");
        assert.equal(notifySupported(), false);
        assert.equal(notifyState(), "unsupported");
        assert.equal(await askNotify(), "unsupported");
    } finally { globalThis.Notification = before; }
});
