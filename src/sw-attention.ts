// sw-attention.ts — what needs someone's hand on this runtime (no model, a backend that does not answer, site access
// withheld, an archive folder whose grant lapsed), as the short codes `capabilities.attention` carries. The chat page
// turns a code into words; a phone driving this browser reads the same codes, which is why they are worked out here
// rather than by whichever page is looking.

import { listAvailableModels } from "./sw-llm";
import { lastFolderReport } from "./sw-archive";

/** The codes this runtime reports. OPEN on the wire: a client words an unknown one generally. */
export type AttentionCode =
    | "no-model" | "backend-unreachable" | "site-access" | "tab-groups" | "no-utility-model"
    | "archive-folder-lapsed" | "archive-folder-unsupported";

/** How long an answer about the backend stands before a page connecting asks again. */
const BACKEND_TTL_MS = 60_000;

let codes: AttentionCode[] = [];
let cfg: { model: string; utilityModel: string; chatUrl: string } | null = null;
let perms = { sites: true, groups: true };
/** null: not asked yet, or no URL to ask */
let backendOk: boolean | null = null;
let backendAt = 0;
let probing: Promise<void> | null = null;
let deps: { archiveOn: () => boolean; onChange: () => void } | null = null;

/** The codes as they stand now, in a fixed order; empty until the first read. */
export function attentionCodes(): AttentionCode[] {
    return codes;
}

/**
 * Work the codes out again from what is known, and tell the runtime when they changed. Cheap: it reads nothing,
 * which is why every input keeps its own copy current.
 */
export function recomputeAttention(): void {
    if (!deps) return;
    const next: AttentionCode[] = [];
    if (cfg && !cfg.model.trim()) next.push("no-model");
    if (backendOk === false) next.push("backend-unreachable");
    if (!perms.sites) next.push("site-access");
    if (!perms.groups) next.push("tab-groups");
    if (cfg && !cfg.utilityModel.trim()) next.push("no-utility-model");
    if (deps.archiveOn()) {
        const folder = lastFolderReport()?.state;
        if (folder === "needs-grant") next.push("archive-folder-lapsed");
        else if (folder === "unsupported") next.push("archive-folder-unsupported");
    }
    if (next.join() === codes.join()) return;
    codes = next;
    deps.onChange();
}

/** Ask the backend for its model list: whether it answers is the whole question. Skipped with no URL set. */
function probeBackend(): Promise<void> {
    if (probing) return probing;
    if (!cfg?.chatUrl.trim()) { backendOk = null; recomputeAttention(); return Promise.resolve(); }
    probing = listAvailableModels()
        .then(() => true, () => false)
        .then((ok) => { backendOk = ok; backendAt = Date.now(); probing = null; recomputeAttention(); });
    return probing;
}

/** A page connected: the backend's answer may be old, since nothing tells the worker a server came back up. */
export function refreshBackendAttention(): void {
    if (deps && Date.now() - backendAt > BACKEND_TTL_MS) void probeBackend();
}

async function readPermissions(): Promise<void> {
    // Unknown reads as granted: a code has to be earned, or a harness with no permissions API nags about everything.
    const has = (p: chrome.permissions.Permissions): Promise<boolean> => {
        try { return typeof chrome.permissions?.contains === "function" ? chrome.permissions.contains(p).catch(() => true) : Promise.resolve(true); }
        catch { return Promise.resolve(true); }
    };
    const [sites, groups] = await Promise.all([has({ origins: ["<all_urls>"] }), has({ permissions: ["tabGroups"] as chrome.runtime.ManifestPermission[] })]);
    perms = { sites, groups };
    recomputeAttention();
}

async function readConfig(): Promise<void> {
    const c = await chrome.storage.sync.get({ model: "", utilityModel: "", chatUrl: "" }).catch(() => null) as Record<string, unknown> | null;
    if (!c) return;
    cfg = { model: String(c.model ?? ""), utilityModel: String(c.utilityModel ?? ""), chatUrl: String(c.chatUrl ?? "") };
    recomputeAttention();
}

/**
 * Start keeping the codes: read the config and the permissions, and follow each of them from
 * then on. `archiveOn` is the session store's reading of the setting; `onChange` re-sends the runtime's description.
 * The archive folder's own changes arrive through `recomputeAttention`, called by whoever hears them.
 */
export function watchAttention(opts: { archiveOn: () => boolean; onChange: () => void }): void {
    deps = opts;
    // The backend is asked only when a page connects (`refreshBackendAttention`) or its settings change: a worker
    // stopped when idle starts again often, and a fetch at every start would be traffic nobody reads.
    void readConfig();
    void readPermissions();
    try {
        chrome.permissions?.onAdded?.addListener(() => void readPermissions());
        chrome.permissions?.onRemoved?.addListener(() => void readPermissions());
        chrome.storage.onChanged?.addListener((changes, area) => {
            if (area !== "sync") return;
            const backend = changes.chatUrl || changes.apiKey || changes.apiFormat;
            if (!(changes.model || changes.utilityModel || backend || changes.sessionArchive)) return;
            void readConfig().then(() => { if (backend) { backendAt = 0; return probeBackend(); } });
        });
    } catch { /* no events (a test harness) */ }
}
