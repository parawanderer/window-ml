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
export type AttentionLevel = RuntimeAttentionLevel | "ready" | "working";

/** The three a RUNTIME's own codes can take. Named apart from the two above because the phone's inbox carries only
 *  these (`src/native/snapshot.ts`): it is a native screen fed the runtimes' items, and the other two are about work
 *  the PAGE is doing — which on a phone happens inside the WebView and is reported by the page's own list. */
export type RuntimeAttentionLevel = "blocks" | "limits" | "suggests";

/** One code a runtime (or this device, for it) reports. OPEN: a code this page does not know is shown generally. */
export type AttentionCode =
    | "no-model" | "backend-unreachable" | "site-access" | "tab-groups" | "no-utility-model"
    | "archive-folder-lapsed" | "archive-folder-unsupported" | "python-packages-missing"
    | "archive-off" | "archive-folder-none"
    /** THIS DEVICE, not a runtime: an iPhone or iPad reading the hosted client in a tab rather than as an app. */
    | "add-to-home";

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
    | { kind: "run"; label: string; run: () => void };

/** One line of the list about a RUNTIME, which is every line the phone's inbox is given. */
export interface RuntimeAttentionItem extends AttentionItem { level: RuntimeAttentionLevel }

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
}

/** Each known code: its level, its words, and how it is fixed on the runtime's own device (`add-to-home` is about
 *  THIS device and has no fix: Apple gives a page no way to offer installing as a button — see `deviceItems`). */
const KNOWN: Record<AttentionCode, { level: RuntimeAttentionLevel; title: string; detail: string; fix?: AttentionFix; again?: { title: string; detail: string } }> = {
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
    /** has this code come back after this device fixed it once? Then it is worded as a repeat (the codes with `again`) */
    repeat: (runtime: RuntimeInfo, code: string) => boolean = () => false,
): RuntimeAttentionItem[] {
    const out: RuntimeAttentionItem[] = [];
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
