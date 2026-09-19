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
    | "archive-off" | "archive-folder-none";

/** How it is fixed from here, when it can be: one click (`ChatExtras.fix`), or the extension's Settings. */
export type AttentionFix = { kind: "act"; label: string } | { kind: "settings"; label: string; where: string };

/** One line of the list. `key` is `runtime:code`, what a dismissal remembers. */
export interface AttentionItem {
    key: string;
    runtime: RuntimeInfo;
    code: string;
    level: AttentionLevel;
    title: string;
    detail: string;
    /** present only where THIS device can apply it */
    fix?: AttentionFix;
}

/** Each known code: its level, its words, and how it is fixed on the runtime's own device. */
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
