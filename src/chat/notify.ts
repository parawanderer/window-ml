// notify.ts — THE HOSTED CLIENT'S HALF OF THE NOTIFICATIONS: asking once, showing one, and keeping the certificate
// reminders this page can keep. The rule and every sentence are `reminders.ts`; nothing is decided here.
//
// WHAT A WEB PAGE CAN AND CANNOT DO, because the difference is the whole shape of this file. It can show a
// notification whenever its code is running, which on an installed app includes being BACKGROUNDED: a phone or an
// iPad with the app behind something else still runs its timers for a while, and that is the case this covers. It
// cannot hand the OS a date and be woken at it: the Notification Triggers API never shipped anywhere, so with the app
// CLOSED there is no timer and nothing fires. Closing that gap takes Web Push, which is a server, a key pair and a
// subscription per device (docs/spec/NOTIFICATIONS.md). The phone app has no such gap: it schedules with the OS.
//
// So a reminder here is checked whenever the page is alive: on load, and on a timer to the next one. A plan this page
// was HOLDING across the moment (a laptop asleep with the tab open) fires late when it wakes, because the deadline has
// not moved. A threshold that passed while the app was CLOSED is not announced on opening — `certReminders` leaves a
// past date out, and opening the app is the moment the inbox says it on screen anyway.
import { effect, signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { approvalAlert, approvalCounts, certReminders, dueReminders, nextReminderMs, reminderPlanId, reminderShownKey, type ApprovalAlert, type CertDeadline, type Reminder } from "./reminders";

/** What this page may do about notifications: ask, show, or nothing at all. */
export type NotifyState = "unsupported" | "default" | "granted" | "denied";

/** Whether the browser has the API at all. False in the phone app's WebView, where the native side notifies. */
export function notifySupported(): boolean {
    try { return typeof Notification !== "undefined" && "permission" in Notification; } catch { return false; }
}

/** What has been decided so far. `default` is "not asked", the only state in which asking does anything. */
export function notifyState(): NotifyState {
    if (!notifySupported()) return "unsupported";
    try { return Notification.permission as NotifyState; } catch { return "unsupported"; }
}

/**
 * Whether notifications are allowed, as a SIGNAL rather than a reading.
 *
 * `Notification.permission` is a plain property that nothing observes, so the press that grants it would otherwise
 * reach only the row that was pressed: the surfaces that act on it (the reminder timer, the approval line) would stay
 * off until something unrelated redrew them. That is the bug this exists for.
 */
export const notifyAllowed = signal(notifyState() === "granted");

/** Ask, once. Resolves with the state afterwards, whatever the answer; a browser that refuses to be asked reads as
 *  `denied`, since from here the two are the same thing. */
export async function askNotify(): Promise<NotifyState> {
    if (!notifySupported()) return "unsupported";
    try {
        const got = (await Notification.requestPermission()) as NotifyState;
        notifyAllowed.value = got === "granted";
        return got;
    } catch { return "denied"; }
}

/**
 * Show one, through the service worker where there is one.
 *
 * `registration.showNotification` is not a nicety: Android's Chrome THROWS on `new Notification()` and has for years,
 * so a page that only knows the constructor is silent on most phones. The constructor is the fallback for a desktop
 * browser with no worker registered, which is every extension page here.
 */
export async function showNotice(n: { id: string; title: string; body: string }): Promise<boolean> {
    if (notifyState() !== "granted") return false;
    const opts = { body: n.body, tag: n.id, icon: "icon-192.png" };
    try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg?.showNotification) { await reg.showNotification(n.title, opts); return true; }
    } catch { /* fall through to the constructor */ }
    try { new Notification(n.title, opts); return true; } catch { return false; }
}

/** An approval that arrived while this page was not being looked at (`approvalAlert` decided that). */
export const showApprovalAlert = (a: ApprovalAlert): Promise<boolean> => showNotice(a);

const SHOWN_KEY = "wml_reminded";

/** Which reminders this device has already been shown, so a reload does not repeat them. */
function shownKeys(): string[] {
    try { const v = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}

/** Remember one, keeping only the keys still in the plan: a renewed certificate's old dates are nobody's business
 *  and would otherwise accumulate for the life of the install. */
function remember(key: string, plan: readonly Reminder[]): void {
    const live = new Set(plan.map(reminderShownKey));
    const keep = shownKeys().filter((k) => live.has(k));
    if (!keep.includes(key)) keep.push(key);
    try { localStorage.setItem(SHOWN_KEY, JSON.stringify(keep)); } catch { /* a page with no storage still notifies, it just repeats */ }
}

/**
 * Keep a plan while this page is alive: show what is due, then sleep until the next one.
 *
 * Returns the way to stop, which the caller MUST call when the plan changes — a renewal replans, and two live timers
 * would both fire. One timer, not an interval: there are at most four dates and the next one is known exactly.
 */
export function runReminders(plan: readonly Reminder[], now: () => number = Date.now): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
        if (stopped) return;
        for (const r of dueReminders(plan, shownKeys(), now())) {
            const key = reminderShownKey(r);
            // Remembered BEFORE it is shown. `showNotice` is async and a page can be closed mid-await; a reminder
            // shown twice is worse than one that was marked and then failed, because the second is already late.
            remember(key, plan);
            void showNotice(r);
        }
        const next = nextReminderMs(plan, shownKeys(), now());
        if (next === null) return;
        // A phone asleep for a week comes back with a timer that should have fired; `setTimeout` is also capped near
        // 2^31 ms, so a date months out is waited for in steps rather than overflowing to "immediately".
        timer = setTimeout(tick, Math.min(Math.max(next - now(), 0), 6 * 3_600_000));
    };
    tick();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}

/**
 * Keep this device's notifications current: the certificate's schedule while the page is alive, and an approval that
 * arrives while someone is somewhere else.
 *
 * Both are silent until notifications have been allowed, which is a press on the Settings row and never asked for
 * here: a permission prompt nobody opened is how a browser learns to refuse this app for good.
 */
export function useNotifications(cert: CertDeadline | null, index: { value: Iterable<readonly [string, { pendingApprovals: number }]> }): void {
    const allowed = notifyAllowed.value;
    // Keyed on the PLAN rather than on the certificate, so a re-read of the keyring that changed nothing does not
    // tear down and rebuild the timer, and a renewal does.
    const plan = allowed && cert ? certReminders(cert, Date.now()) : [];
    const planId = reminderPlanId(plan);
    const held = useRef(plan);
    held.current = plan;
    useEffect(() => (planId ? runReminders(held.current) : undefined), [planId]);

    // The index is FOLLOWED rather than read while rendering. A component that reads it is converted to re-render
    // from it, and this one draws the whole client: every event's timestamp would redraw the page.
    useEffect(() => {
        if (!allowed) return;
        let prev: Map<string, number> | null = null;
        return effect(() => {
            const now = approvalCounts(index.value);
            const before = prev;
            prev = now;
            // THE FIRST LOOK IS THE BASELINE, never news: an app opened with three approvals already waiting would
            // otherwise announce all three, and the one place they are all visible is the screen that just opened.
            if (!before) return;
            let visible = true;
            try { visible = document.visibilityState === "visible"; } catch { /* no document: treat as watched */ }
            const alert = approvalAlert(before, now, visible);
            if (alert) void showApprovalAlert(alert);
        });
    }, [allowed, index]);
}
