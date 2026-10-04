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

/**
 * How much it costs to leave it: nothing works, something is missing, or it would be nicer — and the two levels
 * that are not about a runtime at all but about WORK THIS PAGE IS DOING for you (`export-tasks.ts`): one finished
 * and waiting for a hand (`ready`), one still running (`working`).
 *
 * Those two are here rather than in a second list because the inbox is already the answer to "what needs me", and
 * a long export that finished while you were reading something else is exactly that. `working` is the one level
 * that needs NOTHING: it is in the list so that stopping it is reachable, and it is left out of the count.
 */
export type AttentionLevel = StateAttentionLevel | "ready" | "working";

/** The three an item about a STATE can take: a runtime's own codes, and this device's certificate. Named apart from
 *  the two above because the phone's inbox carries only these (`src/native/snapshot.ts`): it is a native screen fed
 *  those items, and the other two are about work the PAGE is doing — which on a phone happens inside the WebView and
 *  is reported by the page's own list. */
export type StateAttentionLevel = "blocks" | "limits" | "suggests";

/** One code a runtime (or this device, for it) reports. OPEN: a code this page does not know is shown generally. */
export type AttentionCode =
    | "no-model" | "backend-unreachable" | "site-access" | "tab-groups" | "no-utility-model"
    | "archive-folder-lapsed" | "archive-folder-unsupported" | "python-packages-missing"
    | "archive-off" | "archive-folder-none"
    /** THIS DEVICE, not a runtime: an iPhone or iPad reading the hosted client in a tab rather than as an app. */
    | "add-to-home"
    /** THIS DEVICE's certificate: running out, and run out. See {@link certItems}. */
    | "cert-expiring" | "cert-expired";

/**
 * How it is fixed from here, when it can be: one click on the runtime (`ChatExtras.fix`), the extension's Settings,
 * or — for an item this page raised about its own work — something this page just does (`run`).
 *
 * `run` carries its own function because such an item has no runtime to resolve one against: the two others are
 * looked up by `(runtime, code)`, which is the whole reason they are described rather than given.
 */
export type AttentionFix =
    | { kind: "act"; label: string }
    | { kind: "settings"; label: string; where: string }
    /** open Settings → Devices on THIS surface, where a pairing both starts and is confirmed */
    | { kind: "devices"; label: string }
    | { kind: "run"; label: string; run: () => void };

/** One line of the list about a STATE of something, which is every line the phone's inbox is given. */
export interface StateAttentionItem extends AttentionItem { level: StateAttentionLevel }

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
    /**
     * How far along, where the item is about work in progress rather than about a state.
     *
     * A count in the prose answers "how much" but not "is it moving" — which is the only question a reader of a
     * background job actually has, and the one a bar answers without being read.
     */
    progress?: { done: number; total: number };
    /**
     * Clear it from HERE, where clearing is its own act rather than a fix.
     *
     * A dismissed SUGGESTION is remembered (`view-mode.ts`), because telling someone twice about a menu item they
     * have decided against is nagging; a finished export is simply dropped, because there is nothing to remember
     * once the task is gone. Two mechanisms, and the item says which it has rather than the list guessing from the
     * level.
     */
    dismiss?: () => void;
    /** this one may be put away with the stored dismissal although it is not a suggestion: it has already said that
     *  nothing more can be done about it (see `settled` in `KNOWN`) */
    hideable?: boolean;
}

/** Each known code's words, and how it is fixed on the runtime's own device (`add-to-home` is about THIS device and
 *  has no fix: Apple gives a page no way to offer installing as a button — see `deviceItems`). */
/** One code: its level, its words, how it is fixed — and the words for a lapse that has come back DESPITE being
 *  fixed. `again` is the second telling, which names what to do differently; `settled` is the third, for when that
 *  has been done and it came back anyway, and is the only wording a non-suggestion can be put away from. */
interface Known { level: StateAttentionLevel; title: string; detail: string; fix?: AttentionFix; again?: { title: string; detail: string }; settled?: { title: string; detail: string } }

const KNOWN: Record<AttentionCode, Known> = {
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
        detail: "It lost the browser's permission, so old sessions are no longer copied into it. They are still kept and searchable in the browser. If the browser's prompt offers to allow it on every visit, choose that, or this comes back after every restart.",
        fix: { kind: "act", label: "Reconnect" },
        again: {
            title: "The archive folder lapsed again",
            detail: "It was allowed only until the browser restarted. Reconnect, and look in the prompt for a lasting choice (Always allow, or Allow on every visit). Not every browser offers one, and one that has had the prompt dismissed a few times stops offering it: the extension's Settings say how to get it back.",
        },
        settled: {
            title: "This browser will not keep the archive folder",
            detail: "It has asked again after every restart, whichever option was chosen, so there is nothing further to do about it here. Nothing is lost: the archive itself is in the browser and every word of it is still searchable, and only the copy on disk waits. Reconnect whenever you want that copy brought up to date.",
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

// Most urgent first. A finished export sits above a runtime's `limits` because it is TRANSIENT — it is waiting on
// one click and then it is gone, while a lapsed grant will still be there tomorrow — and `working` sits below them
// both because it is a progress report, not a request.
const RANK: Record<AttentionLevel, number> = { blocks: 0, ready: 1, limits: 2, working: 3, suggests: 4 };

/** The list's order, shared by everything that contributes to it: level first, then the order it was added in
 *  (`Array#sort` is stable, which is what keeps a runtime's own codes grouped as they were built). */
export function sortAttention<T extends AttentionItem>(items: T[]): T[] {
    return items.sort((a, b) => RANK[a.level] - RANK[b.level]);
}

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
    /** HOW MANY TIMES this device has fixed this code already, for one that has come back: 0 is the first telling,
     *  1 says what to do differently (`again`), and 2 or more is the admission that it did not work (`settled`). */
    repeat: (runtime: RuntimeInfo, code: string) => number = () => 0,
): StateAttentionItem[] {
    const out: StateAttentionItem[] = [];
    for (const rt of runtimes) {
        const codes = new Set<string>([...reported(rt), ...(local.get(rt.id) ?? [])]);
        for (const code of codes) {
            const k = KNOWN[code as AttentionCode];
            const key = `${rt.id}:${code}`;
            const level = k?.level ?? "limits";
            const fixed = repeat(rt, code);
            const words = (fixed >= 2 && k?.settled) || (fixed >= 1 && k?.again) || k;
            // The ONE non-suggestion that can be put away, and only once it has said there is nothing left to do:
            // a card that cannot be acted on and cannot be dismissed is a permanent mark for a permanent fact.
            const hideable = fixed >= 2 && !!k?.settled;
            if ((level === "suggests" || hideable) && hidden.has(key)) continue;
            out.push({
                key, runtime: rt, code, level,
                title: words?.title ?? "Something needs attention",
                detail: words?.detail ?? `${rt.name} reported "${code.slice(0, 40)}", which this page does not know. Its own Settings will say more.`,
                ...(hideable ? { hideable } : {}),
                ...(k?.fix && canFix(rt, k.fix, code) ? { fix: k.fix } : {}),
            });
        }
    }
    return sortAttention(out);
}

/** What the runtime itself reports: its `attention` codes, and the archive folder's state for one without them. */
function reported(rt: RuntimeInfo): string[] {
    const caps = rt.capabilities as RuntimeInfo["capabilities"] & { attention?: unknown };
    const codes = Array.isArray(caps.attention) ? caps.attention.filter((c): c is string => typeof c === "string" && c.length <= 64) : [];
    if (caps.archive?.folder === "needs-grant") codes.push("archive-folder-lapsed");
    if (caps.archive?.folder === "unsupported") codes.push("archive-folder-unsupported");
    return codes;
}

/** What the count on the button says: what actually wants a hand. Never the suggestions, so a set-up page shows no
 *  number — and never `working`, which wants nothing: a number that counts something already in progress asks the
 *  reader to go and look at a thing they cannot help with. */
export function attentionCount(items: readonly AttentionItem[]): number {
    return items.filter((i) => i.level !== "suggests" && i.level !== "working").length;
}

/**
 * What the inbox calls itself, which is whatever the most urgent thing in it is.
 *
 * It cannot be read off the count alone. A list holding nothing but a background export says "Suggestions" that way,
 * which is a lie about the one thing in it — and the button exists at all only because the list is not empty.
 */
export function attentionLabel(items: readonly AttentionItem[]): { word: string; count: number } {
    const count = attentionCount(items);
    if (count) return { word: "Needs attention", count };
    return { word: items.some((i) => i.level === "working") ? "In progress" : "Suggestions", count: 0 };
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
export function certItems(cert: CertState | null, nowMs: number): StateAttentionItem[] {
    if (!cert || !Number.isFinite(cert.notAfterMs)) return [];
    const left = cert.notAfterMs - nowMs;
    if (left > CERT_WARN_MS) return [];
    const base = { runtime: undefined, level: "blocks" as StateAttentionLevel };
    if (left <= 0) {
        return [{ ...base, key: "this-device:cert-expired", code: "cert-expired", title: KNOWN["cert-expired"].title, detail: KNOWN["cert-expired"].detail }];
    }
    const days = Math.max(1, Math.ceil(left / 86_400_000));
    const when = days === 1 ? "today" : `in ${days} days`;
    // Inside the last few days it stops being something to get round to: the cost of missing it is re-pairing, which
    // is a different and larger job than pressing a button.
    const level: StateAttentionLevel = left <= CERT_URGENT_MS ? "blocks" : "limits";
    const tail = "After that it has to be paired again from scratch.";
    if (cert.mayRevoke) {
        // PAIR IT AGAIN, which is the only thing that works and the one thing this did not say. It read "only the
        // device holding the account's root key may renew. Open that one" — true of the rule and useless as an
        // instruction, because nothing on the root device renews anything: `device.renew` refuses a `may_revoke`
        // certificate outright and no root-side renewal was ever built. Signing the account's revocations is the one
        // grant a renewal may never re-issue, so this device's quarter is a refreshed pairing rather than a press.
        //
        // IT IS CALLED REFRESHING, NOT RE-PAIRING, because "pair it again" makes a person ask what they lose and the
        // answer is nothing: a device keeps its keys across pairings (keyring.ts), so the same principal arrives
        // again under a new certificate, and its sessions were never the account's to take — they are this browser's
        // own storage (`ml_session_<hash>`), untouched by any of it.
        return [{ ...base, level, key: "this-device:cert-expiring", code: "cert-expiring",
            title: `This device's access runs out ${when}`,
            detail: "It signs this account's revocations, which is the one grant a renewal may never re-issue, so this device refreshes its pairing instead. Nothing is lost: the same keys, the same name, and every session stay as they are. It takes a code shown here and scanned from the device you pair devices from.",
            fix: { kind: "devices", label: "Refresh pairing" } }];
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
