// notify.ts — THE PHONE'S NOTIFICATIONS: the one thing in this app the page in the WebView cannot do for itself.
//
// Everything about WHEN and WHAT is decided in `src/chat/reminders.ts` and arrives over the bridge as a finished plan
// (`reminders`); this file only hands it to the OS. That split is on purpose: the sentences are the product's and are
// read on two surfaces, and a second copy of the rule on the phone would drift on the first wording change.
//
// WHY THIS IS NOT PUSH, which is the piece people expect here. An expiry is a date this device already holds, so the
// OS can be given the dates and wake itself: it works with the app closed, the network down, and every browser on the
// account asleep, which is more than a push could manage. The approval line is the opposite case, a fact that
// originates on a laptop, and it is posted only while this app is already connected and running. docs/spec/
// NOTIFICATIONS.md has the whole split and what a real push would add.
import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { NOTIFY_WHAT, approvalAlert, approvalCounts, type ApprovalAlert, type Reminder } from "../../src/chat/reminders";

/** The one channel Android needs before anything can be posted to it. Named for what it is about rather than for the
 *  app, because this is a row in the phone's own settings and "window.ml" there says nothing. */
const CHANNEL = "access";

/** Where every reminder's identifier starts, so a resync can tell OURS from anything else ever scheduled here. */
const REMINDER_PREFIX = "cert-";

/** The plan as the page last reported it, kept so that ALLOWING notifications can act on it (`askNotify`). */
let lastPlan: readonly Reminder[] = [];

/** Show a notification even when the app is in the FOREGROUND. Without a handler the OS hands it to the app and
 *  nothing appears, so a reminder firing while someone is reading a session would be silently swallowed. */
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowBanner: true, shouldShowList: true,
        // No sound and no badge of its own: the count on the icon is the inbox's, set from one place below.
        shouldPlaySound: false, shouldSetBadge: false,
    }),
});

/** The same promise the hosted client's Settings row makes, for this app's (`src/chat/reminders.ts`). */
export { NOTIFY_WHAT };

/** What this phone has decided: `undetermined` is the only state in which asking does anything. */
export type NotifyPermission = "granted" | "denied" | "undetermined";

/** Whether this phone has been asked, and what it said. */
export async function notifyState(): Promise<NotifyPermission> {
    try {
        const p = await Notifications.getPermissionsAsync();
        return p.granted ? "granted" : p.canAskAgain ? "undetermined" : "denied";
    } catch { return "denied"; }
}

/**
 * Ask, once, on a press. Android 13+ needs this at runtime as much as iOS does.
 *
 * A grant RESCHEDULES what is already known. The plan arrives from the page about once an hour, and without this a
 * phone allowed at noon would have nothing with the OS until the next read: the dates were refused when they came.
 */
export async function askNotify(): Promise<NotifyPermission> {
    try {
        await ensureChannel();
        const p = await Notifications.requestPermissionsAsync();
        if (p.granted) await syncReminders(lastPlan);
        return p.granted ? "granted" : p.canAskAgain ? "undetermined" : "denied";
    } catch { return "denied"; }
}

/** The Android channel. A no-op elsewhere, and safe to call again: creating one that exists updates it. */
export async function ensureChannel(): Promise<void> {
    if (Platform.OS !== "android") return;
    try {
        await Notifications.setNotificationChannelAsync(CHANNEL, {
            name: "Account access",
            description: "When this phone's access to your account is running out, and when an approval is waiting.",
            // DEFAULT, not HIGH: a deadline two weeks out has not earned a sound and a banner over what you are doing.
            importance: Notifications.AndroidImportance.DEFAULT,
            showBadge: true,
        });
    } catch { /* an OS that will not take a channel still takes notifications on the default one */ }
}

/**
 * Hand the OS the plan: cancel what is no longer in it, then schedule each one by its own id.
 *
 * Idempotent, because it is called on every certificate read. Scheduling an id that is already scheduled replaces
 * it, which is exactly what a renewal needs — the ids stay and the dates move.
 *
 * A plan arriving while notifications are REFUSED still cancels: a phone that was allowed, told to stop, and then
 * renewed should not keep four old dates in the OS waiting to fire if it is ever allowed again.
 */
export async function syncReminders(plan: readonly Reminder[]): Promise<void> {
    lastPlan = plan;
    try {
        const wanted = new Map(plan.map((r) => [r.id, r]));
        for (const s of await Notifications.getAllScheduledNotificationsAsync()) {
            if (s.identifier.startsWith(REMINDER_PREFIX) && !wanted.has(s.identifier)) {
                await Notifications.cancelScheduledNotificationAsync(s.identifier);
            }
        }
        if ((await notifyState()) !== "granted") return;
        await ensureChannel();
        for (const r of plan) {
            await Notifications.scheduleNotificationAsync({
                identifier: r.id,
                content: { title: r.title, body: r.body },
                trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(r.atMs), channelId: CHANNEL },
            });
        }
    } catch { /* the app works without notifications; it just goes quiet */ }
}

/** Post an approval's one line now. `approvalAlert` has already decided that this phone is not being looked at. */
export async function postApprovalAlert(alert: ApprovalAlert): Promise<void> {
    try {
        if ((await notifyState()) !== "granted") return;
        await ensureChannel();
        await Notifications.scheduleNotificationAsync({
            identifier: alert.id,
            content: { title: alert.title, body: alert.body },
            // No trigger: now. The same identifier every time, so two arrivals replace rather than stack.
            trigger: null,
        });
    } catch { /* see syncReminders */ }
}

/**
 * THE COUNT ON THE APP'S ICON, which is the inbox's count and not a second one (`src/chat/app-badge.ts` does this for
 * the hosted client installed as an app).
 *
 * iOS puts it on the icon directly. Android has no such guarantee: a badge there belongs to the launcher, most of
 * which show a dot for an app that has a notification showing rather than a number anybody set. So this is honest
 * where it works and silent where it does not, like the web one.
 */
export function setAppBadge(n: number): void {
    void Notifications.setBadgeCountAsync(Math.max(0, n)).catch(() => {});
}

/**
 * Keep the icon's count and the approval line current, from what the page has already reported.
 *
 * The approval half only reaches someone while this app is RUNNING, foreground or just behind something else. With
 * it killed there is nothing here to notice an approval and nothing to post one: that is the gap a real push would
 * close, and the only one left (docs/spec/NOTIFICATIONS.md). The certificate half has no such gap, because its dates
 * are already with the OS.
 *
 * The demo world is left out of both: a fake account's fake approvals are not worth a notification, and its
 * certificate is not this phone's.
 */
export function useNotices(
    sessions: readonly { id: { runtime: string; hash: string }; pendingApprovals: number }[],
    count: number,
    demo: boolean,
): void {
    useEffect(() => { if (!demo) setAppBadge(count); }, [count, demo]);
    const before = useRef<Map<string, number> | null>(null);
    useEffect(() => {
        const now = approvalCounts(sessions.map((s) => [`${s.id.runtime}:${s.id.hash}`, s] as const));
        const prev = before.current;
        before.current = now;
        // The first report is the BASELINE, never news: an app opened with approvals already waiting would otherwise
        // announce them, and the screen that just opened is where they are all listed.
        if (!prev || demo) return;
        const alert = approvalAlert(prev, now, AppState.currentState === "active");
        if (alert) void postApprovalAlert(alert);
    }, [sessions, demo]);
}
