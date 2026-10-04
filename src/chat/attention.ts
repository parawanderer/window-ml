// attention.ts — WHAT NEEDS SOMEONE'S HAND: the setup steps and lapses that keep a runtime from working fully (no
// model, site access on "on click", an archive folder that lost its permission), as short CODES turned into sentences
// here. Pure, so the wording and the rules are tested without a DOM; the list itself is `attention-page.tsx`.
//
// Almost everything here is a fact about a RUNTIME, not about whoever is looking: a phone driving a laptop needs to
// know the laptop has no model as much as the laptop's own page does. So a runtime reports its own codes on the contract
// (`capabilities.attention`, sw-attention.ts in the extension). The archive folder's state is read as a code too, for
// a runtime that reports the folder but not yet the codes. Codes, not prose: a remote runtime's text is untrusted, and the sentence depends on where it is
// read (a button on the laptop, "on Work laptop" on a phone). An unknown code is still counted, in general words.
import type { RuntimeInfo } from "../session-host";

/** How much it costs to leave it: nothing works, something is missing, or it would be nicer. */
export type AttentionLevel = "blocks" | "limits" | "suggests";

/** One code a runtime (or this device, for it) reports. OPEN: a code this page does not know is shown generally. */
export type AttentionCode =
    | "no-model" | "backend-unreachable" | "site-access" | "tab-groups" | "no-utility-model"
    | "archive-folder-lapsed" | "archive-folder-unsupported" | "python-packages-missing"
    | "archive-off" | "archive-folder-none"
    /** THIS DEVICE, not a runtime: an iPhone or iPad reading the hosted client in a tab rather than as an app. */
    | "add-to-home"
    /** THIS DEVICE's certificate: running out, and run out. See {@link certItems}. */
    | "cert-expiring" | "cert-expired";

/** How it is fixed from here, when it can be: one click (`ChatExtras.fix`), or the extension's Settings. */
export type AttentionFix = { kind: "act"; label: string } | { kind: "settings"; label: string; where: string };

/** One line of the list. `key` is `runtime:code`, what a dismissal remembers. */
export interface AttentionItem {
    key: string;
    /** The machine it is about. ABSENT on the few items that are about THIS DEVICE — the thing you are holding is
     *  not a runtime, has no name worth printing beside the title, and nothing is "fixed on" it but here. */
    runtime?: RuntimeInfo;
    code: string;
    level: AttentionLevel;
    title: string;
    detail: string;
    /** present only where THIS device can apply it */
    fix?: AttentionFix;
}

/** Each known code: its level, its words, and how it is fixed on the runtime's own device (`add-to-home` is about
 *  THIS device and has no fix: Apple gives a page no way to offer installing as a button — see `deviceItems`). */
const KNOWN: Record<AttentionCode, { level: AttentionLevel; title: string; detail: string; fix?: AttentionFix; again?: { title: string; detail: string } }> = {
    "no-model": {
        level: "blocks", title: "No model is chosen",
        detail: "Nothing can run until the extension has a model to send to.",
        fix: { kind: "settings", label: "Choose one", where: "Extension → Models → Defaults" },
    },
    "backend-unreachable": {
        level: "blocks", title: "The backend is not answering",
        detail: "Its server URL or API key may be wrong, or the server is down.",
        fix: { kind: "settings", label: "Check it", where: "Extension → Connection" },
    },
    "site-access": {
        level: "limits", title: "Site access is limited",
        detail: "The extension may only reach sites you click it on, so the agent cannot fetch other pages and tabs show no icons.",
        fix: { kind: "act", label: "Allow all sites" },
    },
    "archive-folder-lapsed": {
        level: "limits", title: "The archive folder needs reconnecting",
        detail: "It lost the browser's permission, so old sessions are no longer copied into it. They are still kept and searchable in the browser. When the browser asks, choose Always allow (Allow on every visit), or this comes back after every restart.",
        fix: { kind: "act", label: "Reconnect" },
        again: {
            title: "The archive folder lapsed again",
            detail: "Last time it was allowed only until the browser restarted. Reconnect, and this time choose Always allow (Allow on every visit) in the browser's prompt, so it stays connected.",
        },
    },
    "archive-folder-unsupported": {
        level: "limits", title: "This browser cannot keep an archive folder",
        detail: "It does not let pages pick a folder. In Brave, turn on brave://flags/#file-system-access-api and restart it.",
    },
    "python-packages-missing": {
        level: "limits", title: "Python has no packages",
        detail: "This build was made without its Python wheels, so python_exec and the bench fail. Run npm run fetch-pyodide, then rebuild.",
    },
    "no-utility-model": {
        level: "suggests", title: "No utility model",
        detail: "Sessions get no titles or summaries, and side calls use nothing. A small, fast model is enough.",
        fix: { kind: "settings", label: "Choose one", where: "Extension → Models → Utility model" },
    },
    "tab-groups": {
        level: "suggests", title: "Tab groups show without names",
        detail: "The tab picker groups tabs either way; their names and colours need the browser's permission.",
        fix: { kind: "act", label: "Show them" },
    },
    // Both are filled in by `certItems`, which knows the days left and whether this device can renew itself. The words
    // here are the fallback a surface would show if it ever read them straight out of the table.
    "cert-expiring": {
        level: "limits", title: "This device's access is running out",
        detail: "Its certificate expires soon. Renewing is one press while it is still valid; after it lapses the device has to be paired again from scratch.",
        fix: { kind: "act", label: "Renew" },
    },
    "cert-expired": {
        level: "blocks", title: "This device's access has expired",
        detail: "It can no longer prove who it is, so there is nothing left to renew. Pair it again from a device that is already in the account.",
    },
    "add-to-home": {
        level: "suggests", title: "Add this to your home screen",
        // What it actually buys, not a slogan: it opens full screen, and the icon can carry the same count the inbox
        // does — which in a tab is specified to do nothing at all (app-badge.ts).
        detail: "Installed, it opens full screen and its icon can show the count of what needs you; in a browser tab that badge does nothing. Tap the Share button, then Add to Home Screen.",
    },
    "archive-off": {
        level: "suggests", title: "Old sessions are deleted, not kept",
        detail: "Retention deletes a session for good once it is old enough or storage runs out. The archive keeps them instead, in the browser's own storage, every word searchable.",
        fix: { kind: "act", label: "Keep them" },
    },
    "archive-folder-none": {
        level: "suggests", title: "Keep a copy of the archive on disk",
        detail: "Pick a folder and the archive copies itself there as one SQLite file per month: it survives a wiped browser, any SQLite tool opens it, and a sync tool can carry it. A new folder in Documents, say \"window.ml archive\", is a good home; the picker can make one.",
        fix: { kind: "act", label: "Pick a folder" },
    },
};

const RANK: Record<AttentionLevel, number> = { blocks: 0, limits: 1, suggests: 2 };

/**
 * The list, most urgent first. `local` is this device's own codes per runtime (null for a runtime it cannot check);
 * `canFix(runtime, fix)` says whether this device can apply a fix there (one click, or the Settings it holds); `hidden`
 * is the dismissed suggestions. A code both reported and checked appears once.
 */
export function attentionItems(
    runtimes: readonly RuntimeInfo[],
    local: ReadonlyMap<string, readonly string[]>,
    canFix: (runtime: RuntimeInfo, fix: AttentionFix, code: string) => boolean,
    hidden: ReadonlySet<string> = new Set(),
    /** has this code come back after this device fixed it once? Then it is worded as a repeat (the codes with `again`) */
    repeat: (runtime: RuntimeInfo, code: string) => boolean = () => false,
): AttentionItem[] {
    const out: AttentionItem[] = [];
    for (const rt of runtimes) {
        const codes = new Set<string>([...reported(rt), ...(local.get(rt.id) ?? [])]);
        for (const code of codes) {
            const k = KNOWN[code as AttentionCode];
            const key = `${rt.id}:${code}`;
            const level = k?.level ?? "limits";
            if (level === "suggests" && hidden.has(key)) continue;
            const words = k?.again && repeat(rt, code) ? k.again : k;
            out.push({
                key, runtime: rt, code, level,
                title: words?.title ?? "Something needs attention",
                detail: words?.detail ?? `${rt.name} reported "${code.slice(0, 40)}", which this page does not know. Its own Settings will say more.`,
                ...(k?.fix && canFix(rt, k.fix, code) ? { fix: k.fix } : {}),
            });
        }
    }
    return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

/** What the runtime itself reports: its `attention` codes, and the archive folder's state for one without them. */
function reported(rt: RuntimeInfo): string[] {
    const caps = rt.capabilities as RuntimeInfo["capabilities"] & { attention?: unknown };
    const codes = Array.isArray(caps.attention) ? caps.attention.filter((c): c is string => typeof c === "string" && c.length <= 64) : [];
    if (caps.archive?.folder === "needs-grant") codes.push("archive-folder-lapsed");
    if (caps.archive?.folder === "unsupported") codes.push("archive-folder-unsupported");
    return codes;
}

/** What the count on the button says: problems only, never the suggestions, so a set-up page shows no number. */
export function attentionCount(items: readonly AttentionItem[]): number {
    return items.filter((i) => i.level !== "suggests").length;
}

/** How long before a certificate runs out the inbox starts saying so. Early enough that the two devices a renewal
 *  may need are likely to be awake together at some point inside it. */
export const CERT_WARN_MS = 14 * 86_400_000;
/** Below this it stops being something to get round to: an expiry cannot be undone, only re-paired through. */
export const CERT_URGENT_MS = 3 * 86_400_000;

/** This device's own certificate, as the few facts the rule below turns on. */
export interface CertState {
    /** when it stops being valid */
    notAfterMs: number;
    /** it signs the account's revocations, which only the ROOT device may renew — so no button here can do it */
    mayRevoke?: boolean;
    /** its certificate was issued by the root, so a runtime holding `may_pair` can re-sign it (`renewalPredecessor`) */
    renewable: boolean;
    /** a runtime that could do the renewing is reachable right now; without one the item says what to open instead */
    issuerOnline: boolean;
    /** THIS SURFACE can carry a press out (it holds a keyring to install into and a way to ask). Absent is false, so a
     *  surface that has not wired it up offers nothing rather than a button that does nothing. */
    canRenew?: boolean;
}

/**
 * THIS DEVICE'S CERTIFICATE, as an inbox item. Not a runtime's: it is about the thing in your hand, which is why it
 * carries no `runtime` and sits beside `add-to-home` rather than among the per-machine codes.
 *
 * It exists because renewal removed the thing that used to catch a forgotten device. A certificate used to lapse and
 * take the device out of the account with it; now a device that keeps connecting keeps itself current, so the only
 * signal left is a person being told — early enough to act, and only while acting is still possible.
 *
 * A BUTTON ONLY WHERE PRESSING ONE WOULD WORK, which is most of the rule. Everywhere else names the remedy that does
 * — pair it again — and says WHY there is nothing quicker, which is the part a person needs to judge their time by:
 *   - expired: nothing can renew it, because it can no longer prove who it is. Pair it again.
 *   - `may_revoke`: only the root may renew it, and the root is not a thing a page can reach.
 *   - issued by a delegate: it has no root-signed predecessor and never will, so it can only be re-paired.
 *   - no runtime online: renewing needs one to sign. Say which device to open rather than offering a button that fails.
 */
export function certItems(cert: CertState | null, nowMs: number): AttentionItem[] {
    if (!cert || !Number.isFinite(cert.notAfterMs)) return [];
    const left = cert.notAfterMs - nowMs;
    if (left > CERT_WARN_MS) return [];
    const base = { runtime: undefined, level: "blocks" as AttentionLevel };
    if (left <= 0) {
        return [{ ...base, key: "this-device:cert-expired", code: "cert-expired", title: KNOWN["cert-expired"].title, detail: KNOWN["cert-expired"].detail }];
    }
    const days = Math.max(1, Math.ceil(left / 86_400_000));
    const when = days === 1 ? "today" : `in ${days} days`;
    // Inside the last few days it stops being something to get round to: the cost of missing it is re-pairing, which
    // is a different and larger job than pressing a button.
    const level: AttentionLevel = left <= CERT_URGENT_MS ? "blocks" : "limits";
    const tail = "After that it has to be paired again from scratch.";
    if (cert.mayRevoke) {
        return [{ ...base, level, key: "this-device:cert-expiring", code: "cert-expiring",
            title: `This device's access runs out ${when}`,
            detail: `It signs this account's revocations, which only the device holding the account's root key may renew. Open that one. ${tail}` }];
    }
    if (!cert.renewable) {
        return [{ ...base, level, key: "this-device:cert-expiring", code: "cert-expiring",
            title: `This device's access runs out ${when}`,
            detail: `It was paired by another device rather than by the one holding the account's root key, so there is nothing to renew: pair it again. ${tail}` }];
    }
    if (!cert.issuerOnline) {
        return [{ ...base, level, key: "this-device:cert-expiring", code: "cert-expiring",
            title: `This device's access runs out ${when}`,
            detail: `Renewing takes one press, on a moment when one of your browsers is awake to sign it. None is right now. ${tail}` }];
    }
    // The one branch that earns a button. `canRenew` is the SURFACE's answer — whether anything here can carry the
    // press out — kept apart from the account facts above it, so a surface that cannot act says what is true for it
    // rather than offering a control that does nothing. That is the failure this separation exists for.
    if (!cert.canRenew) {
        return [{ ...base, level, key: "this-device:cert-expiring", code: "cert-expiring",
            title: `This device's access runs out ${when}`,
            detail: `Renewing it is not something this screen can do, so pair it again before then. ${tail}` }];
    }
    return [{ ...base, level, key: "this-device:cert-expiring", code: "cert-expiring",
        title: `This device's access runs out ${when}`,
        detail: `Renewing takes one press and changes nothing else about what this device may do. ${tail}`,
        fix: { kind: "act", label: "Renew" } }];
}

/** What this device is, as the few plain facts the suggestion below turns on. Passed in rather than read here, so
 *  the rule and the wording stay testable without a DOM, like everything else in this file. */
export interface DeviceEnv {
    /** already running as a home-screen app */
    installed: boolean;
    /** an iPhone or iPad, where installing is a Share-sheet step and nothing else */
    ios: boolean;
    /** this build declares a manifest — the hosted client, not an extension page and not the phone app's WebView */
    installable: boolean;
}

/**
 * What THIS DEVICE could do better, as inbox items. Only one today: an iPhone or iPad reading the hosted client in a
 * tab, which could be an app.
 *
 * It carries no `fix` because there is nothing to wire one to. Every other browser fires `beforeinstallprompt` and a
 * page can offer a button; Safari fires nothing and exposes no install API, so the only honest thing a page can do is
 * say where the menu item is. That is also why this is a SUGGESTION: it is dismissible, and telling someone twice
 * about a menu they have decided not to use is nagging.
 */
export function deviceItems(env: DeviceEnv, hidden: ReadonlySet<string> = new Set()): AttentionItem[] {
    if (!env.ios || env.installed || !env.installable) return [];
    const key = "this-device:add-to-home";
    if (hidden.has(key)) return [];
    const k = KNOWN["add-to-home"];
    return [{ key, code: "add-to-home", level: k.level, title: k.title, detail: k.detail }];
}
