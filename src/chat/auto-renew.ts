// auto-renew.ts — KEEPING THIS DEVICE'S CERTIFICATE CURRENT WITHOUT ANYONE PRESSING ANYTHING.
//
// A certificate is issued for 90 days (`MAX_CERTIFICATE_MS`) and a renewal is only granted inside the last 14
// (`RENEW_WITHIN_MS`), so a press-only renewal asks a person to open the app during one particular fortnight every
// quarter. That is what this removes: a device that connects AT ALL inside the window renews itself, and the inbox's
// reminder becomes the backstop for a device genuinely unused for a fortnight rather than the thing holding an
// account together.
//
// It is the same operation as the press, not a wider one. `verifyChain` holds a renewal to the same subject,
// agreement key, role, scopes and `may_pair` as the certificate it renews, so this moves a window and can do nothing
// else; the runtime answering it enforces that the asker is the subject and refuses outside the window. So there is
// no decision here that a person would want to make, which is the argument for not asking them.
//
// A FAILURE IS SILENT, deliberately. Nobody asked for this, so nothing may interrupt them about it: it degrades to
// the inbox item and its button, which is the visible path that already exists and says why. The one thing worse
// than a renewal that did not happen is a dialog about a renewal nobody requested.
//
// It lives in `src/chat/` so the page half serves BOTH surfaces from one implementation: the hosted client
// (`client.tsx`) and the phone, whose page is the same client inside a WebView (`native-embed.tsx`). The phone
// therefore needs no Renew button of its own. docs/spec/NOTIFICATIONS.md has the accounting.
import { RENEW_WITHIN_MS } from "../hub/keys";

/** The DURABLE facts a renewal turns on, the same subset a reminder is built from (`reminders.ts`). */
export interface AutoRenewState {
    notAfterMs: number;
    /** it signs the account's revocations, which only the root may renew: no runtime will, so asking is pointless */
    mayRevoke?: boolean;
    /** it has a root-signed predecessor, so a renewal is possible at all */
    renewable: boolean;
}

/** How long to leave it after an attempt. Comfortably past the runtime's own 60-second answer cache, so a retry is a
 *  fresh question rather than the same answer again, and rare enough that a refusing account is never hammered. */
export const AUTO_RENEW_RETRY_MS = 5 * 60_000;

/** How often the conditions are re-examined. The window is measured in days, so this is only about noticing that a
 *  browser woke up, and a minute is far below any rate the hub cares about. */
export const AUTO_RENEW_POLL_MS = 60_000;

/**
 * Why nothing is being asked, or `null` when it should be.
 *
 * A REASON rather than a boolean so a test names the rule that fired, and so a surface could say what it is waiting
 * for. The order is from the most fundamental outwards: what the certificate is, then what the account allows, then
 * what is reachable, then how recently this was tried.
 */
export type AutoRenewSkip =
    /** no membership on this device at all */
    | "no-certificate"
    /** past its end: nothing can renew it, because it can no longer prove who it is */
    | "expired"
    /** too early; the runtime would answer with the window it already has */
    | "not-due"
    /** only the root may renew this one, and no runtime will */
    | "revocation-signer"
    /** issued by a delegate, so there is no root-signed predecessor to re-sign */
    | "no-predecessor"
    /** nothing is awake to sign it */
    | "no-runtime"
    /** asked recently; leave it */
    | "too-soon"
    | null;

/** Should this device ask for a renewal right now, and if not, which rule said so. */
export function autoRenewSkip(
    cert: AutoRenewState | null,
    nowMs: number,
    ctx: { runtimeOnline: boolean; lastTryMs?: number },
): AutoRenewSkip {
    if (!cert || !Number.isFinite(cert.notAfterMs)) return "no-certificate";
    const left = cert.notAfterMs - nowMs;
    if (left <= 0) return "expired";
    if (left > RENEW_WITHIN_MS) return "not-due";
    if (cert.mayRevoke) return "revocation-signer";
    if (!cert.renewable) return "no-predecessor";
    if (!ctx.runtimeOnline) return "no-runtime";
    if (ctx.lastTryMs !== undefined && nowMs - ctx.lastTryMs < AUTO_RENEW_RETRY_MS) return "too-soon";
    return null;
}

/** What the driver needs: the facts, read fresh each time, and the one thing it does. */
export interface AutoRenewOpts {
    /** this device's membership, re-read rather than captured: a renewal changes it */
    read: () => Promise<AutoRenewState | null>;
    runtimeOnline: () => boolean;
    /** `ChatExtras.renewSelf`: resolves to null when nothing is wrong, or the problem in words */
    renew: () => Promise<string | null>;
    now?: () => number;
    pollMs?: number;
    /** for tests and for a debug line; never a user-facing surface */
    onOutcome?: (r: { skip: AutoRenewSkip; problem?: string }) => void;
}

/**
 * Watch the conditions and renew when they are met. Returns the way to stop, which an entry point calls when its
 * client goes away.
 *
 * POLLED rather than driven by a signal, because what it is waiting for is "a browser woke up", the window it is
 * waiting inside is measured in days, and a minute's granularity against a fortnight is free. Driving it from the
 * runtimes signal would couple this to how each of the two surfaces holds its store, for no gain.
 */
export function startAutoRenew(o: AutoRenewOpts): () => void {
    const now = o.now ?? Date.now;
    const pollMs = o.pollMs ?? AUTO_RENEW_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let lastTryMs: number | undefined;
    let busy = false;

    const tick = async () => {
        if (stopped || busy) return;
        let skip: AutoRenewSkip;
        try {
            skip = autoRenewSkip(await o.read(), now(), { runtimeOnline: o.runtimeOnline(), lastTryMs });
        } catch {
            // A keyring that will not answer is not this module's problem to report: try again next time.
            return;
        }
        if (stopped) return;
        if (skip !== null) { o.onOutcome?.({ skip }); return; }
        // Marked before the attempt, not after: a renewal that hangs must not be started again every minute.
        lastTryMs = now();
        busy = true;
        try {
            const problem = await o.renew();
            o.onOutcome?.({ skip: null, ...(problem ? { problem } : {}) });
        } catch (e) {
            o.onOutcome?.({ skip: null, problem: (e as Error)?.message || "it did not go" });
        } finally {
            busy = false;
        }
    };

    const loop = () => {
        void tick().finally(() => { if (!stopped) timer = setTimeout(loop, pollMs); });
    };
    loop();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
