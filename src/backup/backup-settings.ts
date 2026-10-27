// backup-settings.ts — the settings half of a backup: collect from storage, read an old payload up to today's shape, preview a restore, apply exactly that preview.

/**
 * Everything here is pure over plain objects: the caller reads the storage areas into a `StorageSnapshot`, and writes
 * through a `StorageWriter`, so the rules run in Node tests and in any extension context. What belongs in a backup is
 * `backup-inventory.ts`; the file the payload is stored in is `backup-file.ts`.
 *
 * The restore is three steps, none of which writes: `parseSettings` reads and bounds the payload, `upgradeSettings` brings
 * it to today's layout through the SAME upgrades a stored value gets (`migrateSiteLists`, `protoMode`, the policy
 * validator) and drops what this version does not keep, and `previewRestore` lists the changes. `applyRestore` then writes
 * exactly the preview's changes and nothing else.
 */
import { DEFAULT_CONFIG, LEXICAL_METRICS, protoMode } from "../contract/contract-config";
import { type AgentLevel, type SiteLists, SITE_ACCESS_KEYS, SITE_SCHEMA, SITE_SCHEMA_KEY, levelsFor, migrateSiteLists, originOf } from "../site-access";
import { GLOBAL_POLICIES_KEY, validList, POLICY_LABEL_MAX, POLICY_SOURCE_MAX } from "../sw/policy-valid";
import { type PolicyOrigin, type StoredPolicy } from "../sw/sw-policies";
import { classify } from "./backup-inventory";

type Rec = Record<string, unknown>;

/** The storage areas a backup reads, as plain objects. `session` is read only to know which sites are allowed for this browser session. */
export interface StorageSnapshot { sync: Rec; local: Rec; session?: Rec }

/** What the backup file stores in `backup_settings`. */
export interface SettingsPayload {
    format: "wml-settings";
    /** this payload layout; the storage layouts inside it are upgraded separately (site lists have `ml_site_schema`) */
    v: 1;
    created: string;
    /** whether `sync.apiKey` is in it */
    apiKeyIncluded: boolean;
    sync: Rec;
    local: Rec;
}

/** Why a payload was refused outright. */
export class SettingsError extends Error {
    constructor(readonly reason: "bad-format" | "newer-version" | "too-large", message: string) { super(message); this.name = "SettingsError"; }
}

/** The most a payload may weigh as JSON, and the most one value may. A real one is a few tens of kilobytes. */
export const PAYLOAD_LIMITS = Object.freeze({ bytes: 8 << 20, value: 256 << 10 });

/** The config key holding the server credential: masked in a preview, and the one key `if-encrypted` governs. */
const API_KEY = "apiKey";

/** What a key that is a whole list is when it was never written: collected as this so the backup says "none" rather than "unknown". */
const EMPTY_LISTS: Readonly<Rec> = Object.freeze({
    [GLOBAL_POLICIES_KEY]: [], [SITE_ACCESS_KEYS.always]: [], [SITE_ACCESS_KEYS.denied]: [], [SITE_ACCESS_KEYS.selfApprove]: [], [SITE_ACCESS_KEYS.visible]: [], [SITE_ACCESS_KEYS.agents]: {},
});

const own = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
/** Canonical JSON (keys sorted), for comparing a stored value with a backed-up one. */
function canon(v: unknown): string {
    return JSON.stringify(v, (_k, x) => (isRec(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}

// --- collecting ---

/** What `collectSettings` made, and what it left out that a person might expect. */
export interface Collected {
    payload: SettingsPayload;
    /** the API key is set here and was left out because the backup is not encrypted */
    apiKeyOmitted: boolean;
    /** keys found in sync or local storage that no one classified (a newer or older build's): left out */
    unclassified: { area: "sync" | "local"; key: string }[];
}

/**
 * The settings payload for a backup: every key the inventory says "yes" to, from `sync` and `local`.
 * @param storage the storage areas, as plain objects
 * @param o `encrypted`: the file will be encrypted; `includeApiKey`: the person ticked the box for a plain file
 */
export function collectSettings(storage: StorageSnapshot, o: { encrypted: boolean; includeApiKey?: boolean; now?: Date }): Collected {
    const payload: SettingsPayload = { format: "wml-settings", v: 1, created: (o.now ?? new Date()).toISOString(), apiKeyIncluded: false, sync: {}, local: {} };
    const unclassified: Collected["unclassified"] = [];
    let apiKeyOmitted = false;
    for (const area of ["sync", "local"] as const) {
        const src = storage[area] ?? {};
        for (const key of Object.keys(src).sort()) {
            const rule = classify(area, key);
            if (!rule) { unclassified.push({ area, key }); continue; }
            if (rule.backup === "never" || src[key] === undefined) continue;
            if (rule.backup === "if-encrypted" && !(o.encrypted || o.includeApiKey)) { apiKeyOmitted = apiKeyOmitted || src[key] !== ""; continue; }
            payload[area][key] = clone(src[key]);
            if (area === "sync" && key === API_KEY && src[key] !== "") payload.apiKeyIncluded = true;
        }
    }
    // A list nobody ever wrote is collected as empty: the backup then says "none", so a restore can tell it from a key this version did not know.
    for (const [key, empty] of Object.entries(EMPTY_LISTS)) if (!own(payload.local, key)) payload.local[key] = clone(empty);
    return { payload, apiKeyOmitted, unclassified };
}

// --- reading a payload, up to today's layout ---

/** A key or value left out of a restore, and why. */
export interface Dropped { area: "sync" | "local"; key: string; reason: string }

/** A payload in today's layout: what a restore would write, after the upgrades and the drops. */
export interface UpgradedSettings { sync: Rec; local: Rec; dropped: Dropped[]; notes: string[]; apiKeyIncluded: boolean }

/**
 * Read a payload: bounded, JSON, and the right format.
 * @param raw the JSON text (as stored in `backup_settings`) or an already-parsed object
 * @throws `SettingsError` for a payload too large, not ours, or written by a newer layout
 */
export function parseSettings(raw: unknown): SettingsPayload {
    let v: unknown = raw;
    if (typeof raw === "string") {
        if (raw.length > PAYLOAD_LIMITS.bytes) throw new SettingsError("too-large", "the settings in this backup are larger than any real backup holds");
        try { v = JSON.parse(raw); } catch { throw new SettingsError("bad-format", "the settings in this backup are not valid JSON"); }
    }
    if (!isRec(v) || v.format !== "wml-settings") throw new SettingsError("bad-format", "this backup holds no window.ml settings");
    if (typeof v.v !== "number" || !Number.isInteger(v.v) || v.v < 1) throw new SettingsError("bad-format", "the settings in this backup name no version");
    if (v.v > 1) throw new SettingsError("newer-version", `these settings were written by a newer version (layout ${v.v}); update the extension to restore them`);
    if (!isRec(v.sync) || !isRec(v.local)) throw new SettingsError("bad-format", "the settings in this backup are missing a section");
    return v as unknown as SettingsPayload;
}

/** Value-level upgrades for config keys whose stored shape has changed since the first release. */
const CONFIG_UPGRADES: Record<string, (v: unknown) => unknown> = {
    /** `protoStream` shipped as a boolean (`protoMode` is the same read the worker applies) */
    protoStream: protoMode,
};

/** The settings that are one of a few words, which a restore holds to the words (the types in contract-config.ts; a test holds each default to its list). */
export const CONFIG_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    apiFormat: ["openai", "ollama"], theme: ["auto", "dark", "light"], agentHud: ["progress", "quiet"], debugMode: ["off", "overlay", "devtools"],
    cardCorner: ["bottom-right", "bottom-left", "top-right", "top-left"], labelMatch: LEXICAL_METRICS, defaultModelVision: ["", "yes", "no"],
    execDefaultWorld: ["", "page", "isolated"], protoStream: ["off", "auto", "on"],
});

/** Whether `v` has the type of the key's default: the config is typed, and a restore must not write a string where a flag goes. */
function configTypeOk(key: string, v: unknown): boolean {
    const d = (DEFAULT_CONFIG as unknown as Rec)[key];
    if (own(CONFIG_ENUMS, key)) return typeof v === "string" && CONFIG_ENUMS[key].includes(v);
    if (Array.isArray(d)) return Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof d === "number") return typeof v === "number" && Number.isFinite(v);
    return typeof v === typeof d;
}

/** The agent levels a site list may hold. */
const LEVELS: readonly AgentLevel[] = ["ask", "always", "denied"];
/** Where a policy may say it came from. */
const POLICY_ORIGINS: readonly PolicyOrigin[] = ["person", "card", "proposed"];

/** Only the fields a policy has, so a backup cannot smuggle others into storage. */
function cleanPolicy(p: StoredPolicy): StoredPolicy {
    return {
        id: p.id, scope: "global", consumer: p.consumer, effect: p.effect, source: p.source, label: p.label,
        origin: POLICY_ORIGINS.includes(p.origin) ? p.origin : "person", created: typeof p.created === "number" ? p.created : 0,
    };
}

/**
 * Bring a payload to today's layout and drop what this version does not keep. The upgrades are the ones a stored value
 * gets: the site lists through `migrateSiteLists` (a backup from before slice 3 has no agent levels and keeps its
 * self-approval whitelist in the sync config), `protoStream` through `protoMode`, the policies through the worker's own
 * validator. A key this version does not know, a value of the wrong type or past the size bound, an origin that is not
 * an origin, and a policy that is malformed are dropped and listed, never guessed at.
 */
export function upgradeSettings(payload: SettingsPayload): UpgradedSettings {
    const dropped: Dropped[] = [];
    const notes: string[] = [];
    const sync: Rec = {}, local: Rec = {};
    const tooBig = (v: unknown) => JSON.stringify(v)?.length > PAYLOAD_LIMITS.value;

    for (const [key, raw] of Object.entries(payload.sync)) {
        if (!classify("sync", key)) { dropped.push({ area: "sync", key, reason: "not a setting this version has" }); continue; }
        const v = CONFIG_UPGRADES[key] ? CONFIG_UPGRADES[key](raw) : raw;
        if (!configTypeOk(key, v)) { dropped.push({ area: "sync", key, reason: "the value has the wrong type for this setting" }); continue; }
        if (tooBig(v)) { dropped.push({ area: "sync", key, reason: "the value is too large" }); continue; }
        sync[key] = clone(v);
    }
    for (const [key, raw] of Object.entries(payload.local)) {
        const rule = classify("local", key);
        if (!rule) { dropped.push({ area: "local", key, reason: "not a key this version keeps" }); continue; }
        if (rule.backup === "never") { dropped.push({ area: "local", key, reason: `not restored: ${rule.why}` }); continue; }
        if (tooBig(raw)) { dropped.push({ area: "local", key, reason: "the value is too large" }); continue; }
        local[key] = clone(raw);
    }

    // --- the site lists ---
    const K = SITE_ACCESS_KEYS;
    const siteKeys = [K.always, K.denied, K.agents, K.selfApprove, K.visible, SITE_SCHEMA_KEY];
    // The old self-approval whitelist: read once, by the same migration the worker runs.
    const legacyHosts = sync.pageApprovalDomains;
    const hasSites = siteKeys.some((k) => own(local, k)) || (Array.isArray(legacyHosts) && legacyHosts.length > 0);
    const layout = typeof local[SITE_SCHEMA_KEY] === "number" ? local[SITE_SCHEMA_KEY] as number : 1;
    if (layout > SITE_SCHEMA) {
        for (const k of siteKeys) if (own(local, k)) { delete local[k]; dropped.push({ area: "local", key: k, reason: `the site lists were written in a newer layout (${layout}); update the extension to restore them` }); }
    } else if (hasSites) {
        const origins = (key: string): string[] => {
            const list = Array.isArray(local[key]) ? local[key] as unknown[] : [];
            const ok = [...new Set(list.filter((x): x is string => typeof x === "string" && originOf(x) === x))].sort();
            if (ok.length !== list.length) notes.push(`${list.length - ok.length} entr${list.length - ok.length === 1 ? "y" : "ies"} of ${key} are not a site's origin and were left out`);
            return ok;
        };
        const agents: Record<string, AgentLevel> = {};
        if (isRec(local[K.agents])) for (const [o, lv] of Object.entries(local[K.agents] as Rec)) if (originOf(o) === o && LEVELS.includes(lv as AgentLevel)) agents[o] = lv as AgentLevel;
        let lists: SiteLists = { always: origins(K.always), denied: origins(K.denied), selfApprove: origins(K.selfApprove), visible: origins(K.visible), agents, session: [] };
        if (layout < SITE_SCHEMA) {
            const m = migrateSiteLists(lists, legacyHosts);
            lists = m;
            notes.push(`site lists upgraded from layout ${layout} to ${SITE_SCHEMA}: sites already approved ask before starting agents, and the old self-approval whitelist became origins`);
            if (m.dropped.length) notes.push(`whitelist entries that trusted nothing and were left out: ${m.dropped.join(", ")}`);
        }
        const cleaned: Rec = { [K.always]: lists.always, [K.denied]: lists.denied, [K.agents]: lists.agents, [K.selfApprove]: lists.selfApprove, [K.visible]: lists.visible };
        for (const [k, v] of Object.entries(cleaned)) if (own(local, k) || layout < SITE_SCHEMA) local[k] = clone(v);
        local[SITE_SCHEMA_KEY] = SITE_SCHEMA;
    }

    // --- the policies ---
    if (own(local, GLOBAL_POLICIES_KEY)) {
        const raw = local[GLOBAL_POLICIES_KEY];
        const good = validList(raw, "global");
        const ids = new Set<string>();
        // The policy page refuses a source or a label past these bounds (background.ts `POLICIES`), so a restore does too.
        const inBounds = good.filter((p) => p.source.length <= POLICY_SOURCE_MAX && p.label.length <= POLICY_LABEL_MAX);
        const unique = inBounds.filter((p) => !ids.has(p.id) && ids.add(p.id)).map(cleanPolicy);
        const n = (Array.isArray(raw) ? raw.length : 0) - unique.length;
        if (!Array.isArray(raw)) dropped.push({ area: "local", key: GLOBAL_POLICIES_KEY, reason: "not a list of policies" });
        else if (n > 0) notes.push(`${n} polic${n === 1 ? "y" : "ies"} in the backup were malformed, repeated or past the length bounds of the policy page, and were left out`);
        if (Array.isArray(raw)) local[GLOBAL_POLICIES_KEY] = unique; else delete local[GLOBAL_POLICIES_KEY];
    }
    return { sync, local, dropped, notes, apiKeyIncluded: own(sync, API_KEY) && sync[API_KEY] !== "" };
}

// --- the preview ---

/** The order a restore's changes are shown in: what lets a page use window.ml first. */
export type ChangeGroup = "sites" | "policies" | "risky" | "settings";

/** One key a restore would write. */
export interface Change {
    area: "sync" | "local";
    key: string;
    kind: "added" | "changed" | "removed";
    group: ChangeGroup;
    /** what is stored now (absent for an added key) */
    before?: unknown;
    /** what the restore writes; for a removed list, the empty list */
    after: unknown;
    /** both values as short text for the screen; a credential shows as "(set)" */
    shown: { before?: string; after: string; /** set when either text is cut: render the change's own `before`/`after` for the whole */ truncated?: true; /** the full length of each text, set with `truncated` */ length?: { before?: number; after: number } };
    /** for the `risky` group: what changing it does */
    why?: string;
}

/** One site whose standing a restore would change. */
export interface SiteChange {
    origin: string;
    use: [from: string, to: string];
    agents: [from: string, to: string];
    selfApprove: [from: boolean, to: boolean];
    /** the site would be able to call window.ml where it could not */
    becomesApproved: boolean;
    /** the site would be trusted to answer its own approval prompts */
    gainsSelfApprove: boolean;
}

/** One global policy a restore would add, remove or change. */
export interface PolicyChange {
    id: string; label: string; effect: string; consumer: string; kind: "added" | "removed" | "changed";
    /** the predicate: what the policy matches, which a label can misdescribe (bounded by `POLICY_SOURCE_MAX`) */
    source: string;
}

/** Everything a restore would do, and what it would not. */
export interface RestorePlan {
    /** the keys to write, in display order; `applyRestore` writes exactly these */
    changes: Change[];
    /** sites whose standing changes; sites that would become approved are first */
    sites: SiteChange[];
    policies: PolicyChange[];
    dropped: Dropped[];
    notes: string[];
    /** keys in the backup that already hold the same value */
    unchanged: number;
    apiKeyIncluded: boolean;
}

/** Settings that send traffic or widen what runs without asking: a restore lists them apart, with what they do. */
const RISKY_CONFIG: Readonly<Record<string, string>> = {
    chatUrl: "requests, and the saved API key, go to this address",
    priceSnapshotUrl: "the price list is fetched from this address",
    apiFormat: "changes how requests to the server are written",
    shellEnabled: "lets ml.sh run programs on this machine",
    shellRoots: "the folders ml.sh may reach",
    shellPath: "the directories ml.sh finds programs in",
    shellSandbox: "whether ml.sh runs inside a sandbox",
    autoApproveReadonly: "runs read-only page surveys without asking",
    autoApprovePython: "runs Python without asking",
    autoApproveSelfSource: "reads the agent's own source without asking",
    modelFilter: "the whitelist of models a page or run may use; clearing it allows every model the server offers",
    agentStartPage: "the page a blank agent run starts on",
    pageApprovalDomains: "the old self-approval whitelist: its sites are migrated into the self-approval list, which grants use",
    apiKey: "replaces this browser's saved API key",
    pierceClosedShadow: "lets runs read closed shadow roots",
    cdp: "lets runs use trusted clicks and typing through the debugger",
    execDefaultWorld: "which world page scripts run in",
};

/** A value as text for a screen, cut at 160 characters; `cut` says so, with the full length. */
const show = (key: string, v: unknown): { text: string; cut: boolean; length: number } => {
    if (key === API_KEY) { const t = v === "" || v === undefined ? "(empty)" : "(set)"; return { text: t, cut: false, length: t.length }; }
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 160 ? { text: `${s.slice(0, 157)}...`, cut: true, length: s.length } : { text: s, cut: false, length: s.length };
};

/** The order a restore's changes are shown in. */
const GROUP_ORDER: ChangeGroup[] = ["sites", "policies", "risky", "settings"];

function groupOf(area: "sync" | "local", key: string, entryGroup: string): ChangeGroup {
    if (entryGroup === "sites") return "sites";
    if (entryGroup === "policies") return "policies";
    if (area === "sync" && own(RISKY_CONFIG, key)) return "risky";
    return "settings";
}

/** The site lists as the gate would read them, from storage: local halves plus the session half. */
function listsOf(local: Rec, session: Rec | undefined, override?: Rec): SiteLists {
    const K = SITE_ACCESS_KEYS;
    const pick = (k: string): unknown => (override && own(override, k) ? override[k] : local[k]);
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const lv = (v: unknown): Record<string, AgentLevel> => (isRec(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => LEVELS.includes(x as AgentLevel))) as Record<string, AgentLevel> : {});
    return {
        always: arr(pick(K.always)), denied: arr(pick(K.denied)), selfApprove: arr(pick(K.selfApprove)), visible: arr(pick(K.visible)),
        session: arr(session?.[K.session]),
        agents: { ...lv(pick(K.agents)), ...lv(session?.[K.agents]) },
    };
}

/**
 * What restoring this payload would change, given what is stored now. Writes nothing. Sites that would become approved
 * to use window.ml come first in `sites`, and the site keys come first in `changes`: approving a site lets its pages
 * call window.ml.
 * @param up the payload after `upgradeSettings`
 * @param current the storage areas now
 */
export function previewRestore(up: UpgradedSettings, current: StorageSnapshot): RestorePlan {
    const changes: Change[] = [];
    let unchanged = 0;
    for (const area of ["sync", "local"] as const) {
        const next = up[area], now = current[area] ?? {};
        for (const key of Object.keys(next).sort()) {
            const rule = classify(area, key)!;
            const after = next[key];
            const has = own(now, key) && now[key] !== undefined;
            const empty = own(EMPTY_LISTS, key) && canon(EMPTY_LISTS[key]) === canon(after);
            // A list that was never written and a backup that says "none" agree.
            if ((has && canon(now[key]) === canon(after)) || (!has && empty)) { unchanged++; continue; }
            const kind: Change["kind"] = !has ? "added" : rule.mode === "replace" && empty ? "removed" : "changed";
            const group = groupOf(area, key, rule.group);
            const sb = has ? show(key, now[key]) : undefined, sa = show(key, after);
            const cut = !!sb?.cut || sa.cut;
            changes.push({
                area, key, kind, group, ...(has ? { before: now[key] } : {}), after,
                shown: { ...(sb ? { before: sb.text } : {}), after: sa.text, ...(cut ? { truncated: true as const, length: { ...(sb ? { before: sb.length } : {}), after: sa.length } } : {}) },
                ...(group === "risky" ? { why: key === "chatUrl" && !own(next, API_KEY) && typeof now[API_KEY] === "string" && now[API_KEY] !== ""
                    ? "this backup carries no API key, so THIS browser's saved API key would be sent to this address" : RISKY_CONFIG[key] } : {}),
            });
        }
    }
    changes.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

    // sites: the standing of each origin before and after
    const before = listsOf(current.local ?? {}, current.session);
    const after = listsOf(current.local ?? {}, current.session, up.local);
    const origins = new Set([...before.always, ...before.denied, ...before.selfApprove, ...Object.keys(before.agents), ...after.always, ...after.denied, ...after.selfApprove, ...Object.keys(after.agents)]);
    const usable = (u: string) => u === "always" || u === "session";
    const sites: SiteChange[] = [];
    for (const origin of origins) {
        const a = levelsFor(before, origin), b = levelsFor(after, origin);
        if (a.use === b.use && a.agents === b.agents && a.selfApprove === b.selfApprove) continue;
        sites.push({
            origin, use: [a.use, b.use], agents: [a.agents, b.agents], selfApprove: [a.selfApprove, b.selfApprove],
            becomesApproved: !usable(a.use) && usable(b.use), gainsSelfApprove: !a.selfApprove && b.selfApprove,
        });
    }
    const rank = (s: SiteChange) => (s.becomesApproved ? 0 : s.gainsSelfApprove ? 1 : s.agents[1] === "always" && s.agents[0] !== "always" ? 2 : 3);
    sites.sort((x, y) => rank(x) - rank(y) || x.origin.localeCompare(y.origin));

    // policies: by id
    const policies: PolicyChange[] = [];
    if (own(up.local, GLOBAL_POLICIES_KEY)) {
        const now = validList(current.local?.[GLOBAL_POLICIES_KEY], "global");
        const nowById = new Map(now.map((p) => [p.id, p])), nextById = new Map((up.local[GLOBAL_POLICIES_KEY] as StoredPolicy[]).map((p) => [p.id, p]));
        for (const p of nextById.values()) {
            const o = nowById.get(p.id);
            if (!o) policies.push({ id: p.id, label: p.label, effect: p.effect, consumer: p.consumer, kind: "added", source: p.source });
            else if (canon(cleanPolicy(o)) !== canon(p)) policies.push({ id: p.id, label: p.label, effect: p.effect, consumer: p.consumer, kind: "changed", source: p.source });
        }
        for (const p of nowById.values()) if (!nextById.has(p.id)) policies.push({ id: p.id, label: p.label, effect: p.effect, consumer: p.consumer, kind: "removed", source: p.source });
        policies.sort((x, y) => (x.effect === "allow" ? 0 : 1) - (y.effect === "allow" ? 0 : 1) || x.label.localeCompare(y.label));
    }
    return { changes, sites, policies, dropped: up.dropped, notes: up.notes, unchanged, apiKeyIncluded: up.apiKeyIncluded };
}

/** Parse, upgrade and preview in one call. */
export function planRestore(raw: unknown, current: StorageSnapshot): RestorePlan {
    return previewRestore(upgradeSettings(parseSettings(raw)), current);
}

// --- applying ---

/** Where a restore writes: `chrome.storage`'s `sync` and `local`, or a map in a test. */
export interface StorageWriter {
    set(area: "sync" | "local", items: Rec): Promise<void>;
}

/** `chrome.storage` as a writer. */
export function chromeStorageWriter(storage: { sync: { set(items: Rec): Promise<void> }; local: { set(items: Rec): Promise<void> } }): StorageWriter {
    return { set: (area, items) => storage[area].set(items) };
}

/**
 * Write the plan's changes: one `set` per area, so the site lists and their layout marker land together, exactly the keys
 * and values the preview showed and no others. Run in the service worker after the site-access migration has settled
 * (`siteSchemaReady`), so a later migration cannot undo it.
 * @returns the keys written
 */
export async function applyRestore(plan: RestorePlan, writer: StorageWriter): Promise<{ sync: string[]; local: string[] }> {
    const done = { sync: [] as string[], local: [] as string[] };
    for (const area of ["sync", "local"] as const) {
        const items: Rec = {};
        for (const c of plan.changes) if (c.area === area) items[c.key] = clone(c.after);
        if (!Object.keys(items).length) continue;
        await writer.set(area, items);
        done[area] = Object.keys(items);
    }
    return done;
}
