// reminders.ts — WHAT THE OS SHOULD SAY WHEN NOBODY IS LOOKING AT THIS APP: the certificate deadlines worth a
// notification, and the one line an arriving approval earns. Pure, so both surfaces share the rule and the wording
// (the phone schedules them through `expo-notifications`, the hosted client through `src/chat/notify.ts`).
//
// WHY A SCHEDULE RATHER THAN A PUSH. An expiry is a date this device already holds, so nothing has to travel and no
// server has to be awake: the OS is handed the dates and wakes itself, which works with the app closed, the network
// down and the account's browsers all asleep. A push could only be worse at this particular job. What a push is
// genuinely for is the other direction — a fact that originates elsewhere, like an approval on a laptop — and that is
// why `approvalAlert` below fires only while this app is already running. docs/spec/NOTIFICATIONS.md has the split.
//
// NOTHING ABOUT A SESSION REACHES A LOCK SCREEN. The certificate lines are about this device's own access, which is
// the one subject that is already the reader's; an approval says only that one is waiting, never which session, task
// or page (docs/spec/NATIVE_SHELL.md).
import { CERT_URGENT_MS, CERT_WARN_MS } from "./attention";

const DAY_MS = 86_400_000;

/** WHAT ALLOWING THEM GETS YOU, for the one row on each surface that asks. Here rather than on either surface,
 *  because it is a promise about what this app will and will not put on a lock screen, and two copies of a promise
 *  drift on the first wording change. */
export const NOTIFY_WHAT = "Before this device's access to the account runs out, and when an approval is waiting. Never what a session is doing.";

/**
 * THE WAY BACK FROM A REFUSAL, which is not the same sentence everywhere and is the reason this is a function.
 *
 * In a browser a refusal is undone in that browser's site settings. On an iOS or iPadOS web app added to the Home
 * Screen there is no second ask at all: the permission belongs to that installed copy, and the only way to be asked
 * again is to remove it and add it again.
 *
 * AND THAT IS NOT A FREE ACTION, which is the part worth a sentence of its own. An installed web app's storage is its
 * own container, separate from the browser's, and removing it from the Home Screen takes the container with it. This
 * device's keys live there, so the way back from a refused notification is also what makes it a stranger to the
 * account. Telling someone to remove and re-add it without saying that is handing them a one-tap way to lose their
 * pairing over a notification they could have lived without.
 */
export function notifyDeniedNote(env: { ios: boolean; installed: boolean }): string {
    return env.ios && env.installed
        ? "Turned off for this app. iOS gives an installed web app no second ask: the only way back is to remove it from the Home Screen and add it again, which also clears this device's keys, so it would have to be paired again. Not worth it for a notification."
        : "This browser has them turned off for this site, and its own site settings are the only way back.";
}

/** One notification to hand the OS: a stable id, when it should arrive, and what it says. */
export interface Reminder {
    /** Stable across replans, so scheduling the plan again REPLACES rather than duplicates. A renewal moves the
     *  dates and keeps the ids, which is exactly what cancel-by-id then re-add does. */
    id: string;
    atMs: number;
    title: string;
    body: string;
}

/**
 * The DURABLE half of this device's certificate: the facts that will still be true when a reminder fires.
 *
 * `CertState` (attention.ts) is assignable to it and deliberately wider: `issuerOnline` and `canRenew` are readings of
 * right now, and baking either into a notification set for next month would put a sentence on a lock screen that was
 * true when it was scheduled and wrong when it arrived.
 */
export interface CertDeadline {
    notAfterMs: number;
    /** only the root may renew it, so no press anywhere can */
    mayRevoke?: boolean;
    /** it has a root-signed predecessor, so a renewal is possible at all */
    renewable: boolean;
}

/** When to speak up, and how each one names the time left. The first two are the inbox's own thresholds, so the
 *  first reminder lands exactly as the item appears there rather than on a second schedule nobody can see. */
const LEADS: { id: string; lead: number; when: string }[] = [
    { id: "cert-warn", lead: CERT_WARN_MS, when: `in ${Math.round(CERT_WARN_MS / DAY_MS)} days` },
    { id: "cert-urgent", lead: CERT_URGENT_MS, when: `in ${Math.round(CERT_URGENT_MS / DAY_MS)} days` },
    { id: "cert-last", lead: DAY_MS, when: "tomorrow" },
];

/** What to do about it, in one sentence, from the facts that do not move. */
function remedy(cert: CertDeadline): string {
    if (cert.mayRevoke) return "Only the device holding this account's root key can renew it. Open that one.";
    if (!cert.renewable) return "It was paired by another device rather than by the account's root, so pair this one again.";
    return "Renewing takes one press while it is still valid.";
}

/**
 * The notifications to have waiting for this device's certificate, soonest first.
 *
 * Anything already in the past is LEFT OUT rather than fired late: a device first paired inside the warning window
 * would otherwise be told, on the spot, about a threshold that passed before the app existed, and the inbox is
 * already saying it on screen. An empty plan is the normal answer for a certificate with months left.
 */
export function certReminders(cert: CertDeadline | null, nowMs: number): Reminder[] {
    if (!cert || !Number.isFinite(cert.notAfterMs)) return [];
    const tail = remedy(cert);
    const out: Reminder[] = [];
    for (const { id, lead, when } of LEADS) {
        const atMs = cert.notAfterMs - lead;
        if (atMs <= nowMs) continue;
        out.push({ id, atMs, title: `This device's access runs out ${when}`, body: tail });
    }
    // And one AT the deadline. It can no longer be acted on, which is the point: the device has silently stopped
    // reaching the account, and the only thing worse than being told is finding out by trying to use it.
    if (cert.notAfterMs > nowMs) {
        out.push({
            id: "cert-gone", atMs: cert.notAfterMs,
            title: "This device's access has run out",
            body: "Pair it again from a device that is still in the account.",
        });
    }
    return out;
}

/** One string that changes whenever the plan does, so a surface can skip rescheduling that would change nothing. */
export function reminderPlanId(plan: readonly Reminder[]): string {
    return plan.map((r) => `${r.id}@${r.atMs}`).join(" ");
}

/** The reminders that are due now and have not been shown: for a surface that cannot hand a schedule to the OS and
 *  has to check while it happens to be running (`src/chat/notify.ts`). */
export function dueReminders(plan: readonly Reminder[], shown: readonly string[], nowMs: number): Reminder[] {
    const seen = new Set(shown);
    return plan.filter((r) => r.atMs <= nowMs && !seen.has(`${r.id}@${r.atMs}`));
}

/** When such a surface should look again, or null when nothing is left to wait for. */
export function nextReminderMs(plan: readonly Reminder[], shown: readonly string[], nowMs: number): number | null {
    const seen = new Set(shown);
    const times = plan.filter((r) => r.atMs > nowMs && !seen.has(`${r.id}@${r.atMs}`)).map((r) => r.atMs);
    return times.length ? Math.min(...times) : null;
}

/** What a reminder is remembered by once shown: the id AND its time, so a renewal's new dates are not taken as done. */
export const reminderShownKey = (r: Reminder): string => `${r.id}@${r.atMs}`;

/** The one line an arriving approval earns. No session, task or page: see this module's header. */
export interface ApprovalAlert {
    id: string;
    title: string;
    body: string;
}

/**
 * Whether an approval that just arrived should reach the OS, and what it says.
 *
 * Only on a RISE, and only while this surface is not being looked at. Two failures that shapes around: an app opening
 * with three approvals already waiting would announce all three as news, and someone reading the list they are in
 * would be notified about what is on their screen. The caller takes `now` as the new baseline either way — an
 * approval seen rather than announced is not announced later.
 *
 * ONE alert for all of them, carrying the TOTAL waiting rather than the rise: a notification per session would say
 * how many sessions are busy, which is the thing this is not allowed to say.
 */
export function approvalAlert(
    prev: ReadonlyMap<string, number>,
    now: ReadonlyMap<string, number>,
    visible: boolean,
): ApprovalAlert | null {
    let rose = false;
    let total = 0;
    for (const [key, n] of now) {
        if (n > (prev.get(key) ?? 0)) rose = true;
        total += Math.max(0, n);
    }
    if (!rose || visible || total < 1) return null;
    return {
        id: "approval",
        title: total === 1 ? "An approval is waiting" : `${total} approvals are waiting`,
        body: "Open window.ml to answer it.",
    };
}

/** The pending-approval counts an index amounts to, as `approvalAlert` compares them. Takes the ENTRIES so a client's
 *  index Map goes in as it is, and a phone's list of summaries goes in with its own key for each. */
export function approvalCounts(sessions: Iterable<readonly [string, { pendingApprovals: number }]>): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, s] of sessions) if (s.pendingApprovals > 0) out.set(key, s.pendingApprovals);
    return out;
}
