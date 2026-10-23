// backup-inventory.ts — every storage key the extension uses, classified as backed up or never, with the reason.

/**
 * The decision, written down once. A settings backup holds exactly what `classify` says "yes" to (and the API key when
 * the backup is encrypted); everything else is left out on purpose and the reason is here. `tests/backup-inventory.test.mjs`
 * scans `src/` and fails on a storage key nobody classified, so a new preference forces the question "does this belong in
 * a backup?" at the commit that adds it, and on an entry here that no source names any more. The design is
 * `docs/dev/backup.md`, "Backup and restore".
 *
 * Pure data and one lookup: no `chrome`, so the worker, a page and Node all read it.
 */
import { DEFAULT_CONFIG } from "../contract/contract-config";

/** Where a key lives: the three `chrome.storage` areas, and `web` for an extension page's own `localStorage`. */
export type StorageArea = "sync" | "local" | "session" | "web";

/** What a backup does with a key. `if-encrypted` is the API key: in a backup only when the file is encrypted (or the person ticked the box). */
export type BackupClass = "yes" | "never" | "if-encrypted";

/** What kind of thing a key holds, for the restore preview and for the reasons below. */
export type KeyGroup =
    | "config" | "policies" | "sites" | "ui"
    | "run-state" | "log" | "cache" | "grant" | "pairing" | "chat" | "page-local";

/** One classified key, or a family of keys sharing a prefix. */
export interface InventoryEntry {
    /** the exact key, or the prefix when `prefix` is set */
    key: string;
    /** a family: `ml_session_<hash>` is one entry, `ml_session_` */
    prefix?: true;
    /** the areas it is written to; a backup reads the `local` and `sync` ones only */
    areas: StorageArea[];
    backup: BackupClass;
    group: KeyGroup;
    /** how a restore treats it: `merge` leaves a key the backup lacks alone, `replace` makes the stored value the backup's (a list is the backup's list) */
    mode?: "merge" | "replace";
    /** one line: why it is, or is not, in a backup */
    why: string;
}

const local = (key: string, group: KeyGroup, why: string, backup: BackupClass = "never", extra: Partial<InventoryEntry> = {}): InventoryEntry =>
    ({ key, areas: ["local"], backup, group, why, ...extra });
const session = (key: string, group: KeyGroup, why: string, extra: Partial<InventoryEntry> = {}): InventoryEntry =>
    ({ key, areas: ["session"], backup: "never", group, why, ...extra });
const web = (key: string, why: string): InventoryEntry => ({ key, areas: ["web"], backup: "never", group: "page-local", why });
const ui = (key: string, why: string): InventoryEntry => local(key, "ui", why, "yes", { mode: "merge" });

/** Every key outside `chrome.storage.sync`'s config. The config's own keys are `DEFAULT_CONFIG`'s, classified by `classify`. */
export const INVENTORY: readonly InventoryEntry[] = [
    // --- backed up ---
    local("ml_policies_global", "policies", "the person's own rules for calls they allow or refuse", "yes", { mode: "replace" }),
    local("ml_site_always", "sites", "the sites approved to use window.ml", "yes", { mode: "replace" }),
    local("ml_site_denied", "sites", "the sites refused window.ml", "yes", { mode: "replace" }),
    { key: "ml_site_agents", areas: ["local", "session"], backup: "yes", group: "sites", mode: "replace", why: "each site's agent level; the local half (the session half goes with the browser session)" },
    local("ml_site_selfapprove", "sites", "the sites trusted to answer their own approval prompts", "yes", { mode: "replace" }),
    local("ml_site_schema", "sites", "which layout the site lists are stored in: tells a restore which upgrade an old backup needs", "yes", { mode: "replace" }),
    ui("ml_debug_fontscale", "the panel's font scale"),
    ui("ml_debug_codewrap", "code blocks wrap or scroll"),
    ui("ml_debug_codelines", "code block line numbers"),
    ui("ml_debug_focus", "the panel's focus mode"),
    ui("ml_debug_stats_tokens", "run stats bar: token counts"),
    ui("ml_debug_stats_tps", "run stats bar: tokens per second"),
    ui("ml_debug_outts", "per-line timestamps on streamed output"),
    ui("ml_debug_outmax", "the height of a tool output cell"),
    ui("ml_debug_width", "the panel's width"),
    ui("ml_card_width", "the corner card's dragged width"),
    ui("ml_code_theme", "the code colour theme"),
    ui("ml_code_theme_vscode", "an uploaded VS Code theme"),
    ui("ml_code_theme_ui", "whether the uploaded theme colours the whole panel"),
    ui("ml_bench_open", "the bench drawer is open"),
    ui("ml_bench_dock", "the bench drawer's dock"),
    ui("ml_bench_h", "the bench drawer's height"),
    ui("ml_bench_split", "the bench editor's share"),
    ui("ml_vram_h", "the VRAM chart's height"),
    ui("ml_vram_palette", "which palette names the models"),
    ui("ml_res_window_pref", "the window the resource chart opens at"),
    ui("ml_res_sections", "which resource-panel sections are shown"),
    ui("ml_res_snapdot", "snap the crosshair to a datapoint"),
    ui("ml_res_timegrid", "draw the time grid"),
    ui("ml_res_laneh", "the event lane's height"),
    ui("ml_res_layout", "the resource panel's layout"),
    ui("ml_lane_hidden", "event lane kinds the person hid"),
    ui("ml_lane_scope", "the event lane's scope"),
    ui("ml_res_predict", "show the VRAM predictor's figures"),
    ui("ml_runlog_zoom", "the execution log's zoom"),
    ui("ml_runlog_colour", "the execution log's colouring"),
    ui("ml_runstate_folded", "which run-state sections are folded"),

    // --- never: sessions and what a run leaves behind ---
    local("ml_session_", "chat", "a chat's resumable record, per chat: the session's archive row carries the same history (backup.md, \"Resuming a restored chat\")", "never", { prefix: true }),
    local("ml_bgrun_", "run-state", "a live run's resumable snapshot; a restored machine has no run to resume", "never", { prefix: true }),
    session("ml_answer:", "run-state", "a run's answer set, memory-lifetime", { prefix: true }),
    local("ml_run_models", "run-state", "the model a run was switched to"),
    local("ml_handed_to_worker", "run-state", "runs handed from a page to the worker"),
    session("ml_pinned_tabs", "run-state", "tab ids, meaningless in another browser"),
    local("ml_policies_run", "policies", "run policies belong to one session and go with it when it is archived or restored"),
    local("ml_policies_archived", "policies", "what an archived session lost, told once"),
    local("ml_policies_lapsed", "policies", "why a call asks; text only, never an input to a decision"),

    // --- never: grants that last one browser session ---
    session("ml_site_session", "grant", "sites allowed for this browser session only"),
    session("ml_start_approved", "grant", "agent starts allowed on a card, this browser session"),
    session("ml_start_denials", "grant", "declined starts, this browser session"),
    session("ml_agent_opened", "grant", "tabs an agent opened, this browser session"),
    local("ml_site_upgrade_notice", "sites", "a one-time notice about a migration on this machine"),

    // --- never: logs, history and caches ---
    session("ml_run_log", "log", "the execution log ring"),
    session("ml_hk_log", "log", "the housekeeping log ring"),
    session("ml_hk_seen", "log", "which housekeeping records the person saw"),
    local("ml_hub_log", "log", "the hub connection log"),
    local("ml_hub_alive", "log", "a heartbeat"),
    local("ml_storage_history", "log", "the storage report's history"),
    local("ml_load_records", "log", "model load records for the predictor"),
    local("ml_res_window", "cache", "the resource chart's live window; the preference is ml_res_window_pref"),
    local("ml_res_seen_cards", "cache", "which resource cards were shown"),
    local("ml_bench_env", "cache", "the sandbox's versions, learned on first use"),
    local("ml_runstate_console", "log", "the run-state console's input history"),

    // --- never: unsure, left out until someone asks ---
    local("ml_runstate_watches", "ui", "watches name paths in particular runs, which do not exist on another machine"),
    local("ml_runstate_shared", "ui", "which watches the model may read: a consent, so it is not carried silently"),
    local("ml_runstate_watch_notes", "ui", "notes on those watches"),
    local("ml_synthetic_traffic", "run-state", "marks this browser's requests as synthetic (a bench switch); restoring it would relabel real use"),

    // --- never: not chrome.storage at all ---
    web("ml_dev_hub_url", "the development pairing page's own localStorage"),
    web("ml_set_collapsed", "an extension page's localStorage (collapsed settings sections): the worker cannot read it"),
    web("ml_bench_code", "an extension page's localStorage (the bench editor's text)"),
    web("ml_bench_timeout", "an extension page's localStorage"),
    web("ml_bench_times", "an extension page's localStorage"),
];

/**
 * Stores that are not `chrome.storage`, so they are not keys to classify, with what a backup does with each. Listed so a
 * reader asking "does the backup have my hub pairing?" finds the answer, and a test holds each name to a source.
 */
export const OTHER_STORES: readonly { name: string; backup: "yes" | "never"; why: string }[] = [
    { name: "ml-saved-sessions", backup: "yes", why: "the live session store: every session goes into the backup file" },
    { name: "ml-hub-keyring", backup: "never", why: "the hub pairing and its private keys: pairing is redone on a new machine" },
    { name: "ml-values", backup: "never", why: "fetched tables a run holds; refetchable" },
    { name: "ml-archive-folder", backup: "never", why: "a handle to a folder on this machine" },
    { name: "ml-backup-keyring", backup: "never", why: "the backup data key, non-extractable; the backup file carries its wrapped copies instead" },
];

/** The config's one secret: in a backup only when it is encrypted, or the person ticked the box. */
const API_KEY = "apiKey";

/** Every key of `chrome.storage.sync` a backup carries: `DEFAULT_CONFIG`'s. */
export const CONFIG_KEYS: readonly string[] = Object.keys(DEFAULT_CONFIG);

const configEntry = (key: string): InventoryEntry => key === API_KEY
    ? { key, areas: ["sync"], backup: "if-encrypted", group: "config", mode: "merge", why: "a credential: in a backup only when the file is encrypted, or the person asked for it in a plain one" }
    : { key, areas: ["sync"], backup: "yes", group: "config", mode: "merge", why: "a setting of the extension (DEFAULT_CONFIG)" };

/**
 * What the inventory says about a key in an area, or null when nobody classified it.
 * @param area the storage area the key was found in
 * @param key the key
 */
export function classify(area: StorageArea, key: string): InventoryEntry | null {
    if (area === "sync" && Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return configEntry(key);
    for (const e of INVENTORY) {
        if (!e.areas.includes(area)) continue;
        if (e.prefix ? key.startsWith(e.key) : key === e.key) return e;
    }
    return null;
}

/** Counts by class, for the docs and the report: how many entries are backed up, conditional or never. */
export function inventoryCounts(): Record<BackupClass, number> {
    const n: Record<BackupClass, number> = { yes: 0, never: 0, "if-encrypted": 0 };
    for (const k of CONFIG_KEYS) n[configEntry(k).backup]++;
    for (const e of INVENTORY) n[e.backup]++;
    return n;
}
