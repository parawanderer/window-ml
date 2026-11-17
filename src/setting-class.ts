// setting-class.ts — what each setting is to the model: its class (secret, gate, guarded or ordinary), the values the
// model may give it, which change of it widens, and the sentence a card and a restore show (docs/spec/MODEL_SETTINGS.md).
//
// Pure, so the worker, the restore preview and the tests read one table. Every key of DEFAULT_CONFIG is in it, by type.

import { DEFAULT_CONFIG, LEXICAL_METRICS, SETTING_PLACES, type MlConfig, type SettingPlace } from "./contract/contract-config";

type Rec = Record<string, unknown>;
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The settings that are one of a few words, which a restore holds to the words (the types in contract-config.ts; a test holds each default to its list). */
export const CONFIG_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    apiFormat: ["openai", "ollama"], theme: ["auto", "dark", "light"], agentHud: ["progress", "quiet"], debugMode: ["off", "overlay", "devtools"],
    cardCorner: ["bottom-right", "bottom-left", "top-right", "top-left"], labelMatch: LEXICAL_METRICS, defaultModelVision: ["", "yes", "no"],
    execDefaultWorld: ["", "page", "isolated"], protoStream: ["off", "auto", "on"],
});

/** Whether `v` has the type of the key's default: the config is typed, and a restore must not write a string where a flag goes. */
export function configTypeOk(key: string, v: unknown): boolean {
    const d = (DEFAULT_CONFIG as unknown as Rec)[key];
    if (own(CONFIG_ENUMS, key)) return typeof v === "string" && CONFIG_ENUMS[key].includes(v);
    if (Array.isArray(d)) return Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof d === "number") return typeof v === "number" && Number.isFinite(v);
    return typeof v === typeof d;
}

/** The four classes of setting, from one the model never touches to one it changes by asking like any other call. */
export type SettingClass = "secret" | "gate" | "guarded" | "ordinary";

/**
 * The values the model may give an ordinary setting: a closed set, so no ordinary key takes free text. A new kind is a
 * change to this type, which a reviewer sees.
 */
export type SettingDomain =
    | { kind: "boolean" }
    | { kind: "enum"; words: readonly string[] }
    | { kind: "number"; min: number; max?: number; integer?: true }
    | { kind: "model" }
    | { kind: "hours" }
    | { kind: "currency" };

/** The kinds a domain may be, for a test that checks a declaration built at run time. */
export const DOMAIN_KINDS: readonly SettingDomain["kind"][] = ["boolean", "enum", "number", "model", "hours", "currency"];

/** One setting's declaration. A guarded key with no `widens` is guarded in both directions, so a missing one fails closed. */
export type SettingDecl =
    | { class: "secret"; reason: string }
    | { class: "gate"; reason: string }
    | { class: "guarded"; reason: string; widens?: (from: unknown, to: unknown) => boolean }
    | { class: "ordinary"; domain: SettingDomain };

const on = (from: unknown, to: unknown): boolean => to === true && from !== true;
const off = (from: unknown, to: unknown): boolean => to === false && from !== false;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** An entry of `to` that `from` lacks. */
const added = (from: unknown, to: unknown): boolean => { const f = new Set(list(from)); return list(to).some((x) => !f.has(x)); };
/** An entry added, or the entries both share in another order: for a lookup path, where order decides what runs. */
const addedOrReordered = (from: unknown, to: unknown): boolean => {
    if (added(from, to)) return true;
    const t = new Set(list(to)), kept = list(from).filter((x) => t.has(x));
    return kept.join("\n") !== list(to).join("\n");
};
/** A smaller number, where 0 means no limit at all. */
const tighter = (from: unknown, to: unknown): boolean => to !== 0 && (from === 0 || (to as number) < (from as number));

const bool: SettingDomain = { kind: "boolean" };
const model: SettingDomain = { kind: "model" };
const words = (key: string): SettingDomain => ({ kind: "enum", words: CONFIG_ENUMS[key] });

/** Every setting's class, by type every key of the config. Reasons carried from the restore preview are word for word. */
export const SETTING_CLASSES: Readonly<{ [K in keyof MlConfig]: SettingDecl }> = Object.freeze({
    chatUrl: { class: "secret", reason: "requests, and the saved API key, go to this address" },
    apiKey: { class: "secret", reason: "replaces this browser's saved API key" },
    modelFilter: { class: "secret", reason: "the whitelist of models a page or run may use; clearing it allows every model the server offers" },
    priceSnapshotUrl: { class: "secret", reason: "the price list is fetched from this address" },
    pageApprovalDomains: { class: "secret", reason: "the old self-approval whitelist: its sites are migrated into the self-approval list, which grants use" },

    autoApproveReadonly: { class: "gate", reason: "runs read-only page surveys without asking" },
    autoApprovePython: { class: "gate", reason: "runs Python without asking" },
    autoApproveSelfSource: { class: "gate", reason: "reads the agent's own source without asking" },

    shellEnabled: { class: "guarded", reason: "lets ml.sh run programs on this machine", widens: on },
    shellRoots: { class: "guarded", reason: "the folders ml.sh may reach", widens: added },
    shellPath: { class: "guarded", reason: "the directories ml.sh finds programs in", widens: addedOrReordered },
    shellSandbox: { class: "guarded", reason: "whether ml.sh runs inside a sandbox", widens: off },
    pierceClosedShadow: { class: "guarded", reason: "lets runs read closed shadow roots", widens: on },
    cdp: { class: "guarded", reason: "lets runs use trusted clicks and typing through the debugger", widens: on },
    execDefaultWorld: { class: "guarded", reason: "which world page scripts run in" },
    agentStartPage: { class: "guarded", reason: "the page a blank agent run starts on" },
    apiFormat: { class: "guarded", reason: "changes how requests to the server are written" },
    // serverToolsOff lists bundles turned OFF: one leaving the list is one turned on.
    serverToolsOff: { class: "guarded", reason: "which server-side tools runs are given", widens: (from, to) => added(to, from) },
    commanderServerTools: { class: "guarded", reason: "the server-side tools every run started from the Commander bar gets", widens: added },
    agentSeesFocus: { class: "guarded", reason: "tells the agent where you are when it is not on its own tab", widens: on },
    selfIntrospection: { class: "guarded", reason: "lets the agent read its own run as ml.current", widens: on },
    debugMode: { class: "guarded", reason: "decides whether a page's ml.agent runs in the extension's loop or the page's" },
    siteRequests: { class: "guarded", reason: "lets sites that may not use window.ml ask for access", widens: on },
    listPageSessions: { class: "guarded", reason: "wakes each page's debug bus to list its sessions", widens: on },
    persistUiRuns: { class: "guarded", reason: "keeps the sessions this browser's own UI starts", widens: off },
    sessionArchive: { class: "guarded", reason: "moves an evicted session to the archive instead of deleting it", widens: off },
    sessionRetentionDays: { class: "guarded", reason: "how long a saved session is kept", widens: tighter },
    sessionStoreBudgetMB: { class: "guarded", reason: "how much disk saved sessions may use before the oldest go", widens: tighter },
    valueStoreBudgetMB: { class: "guarded", reason: "how much disk the bodies of large fetched tables may use", widens: (from, to) => (to as number) < (from as number) },
    exportToolDefs: { class: "guarded", reason: "whether an export carries the full tool definitions", widens: off },
    taskNotifyOnly: { class: "guarded", reason: "whether a finished task starts the run's next turn with no message from you", widens: off },
    taskTurnChainMax: { class: "guarded", reason: "how many turns finished tasks may start in a row with no message from you", widens: (from, to) => (to as number) > (from as number) },

    model: { class: "ordinary", domain: model },
    ocrModel: { class: "ordinary", domain: model },
    ocrNumCtx: { class: "ordinary", domain: { kind: "number", min: 512, integer: true } },
    defaultModelVision: { class: "ordinary", domain: words("defaultModelVision") },
    labelMatch: { class: "ordinary", domain: words("labelMatch") },
    embeddingModel: { class: "ordinary", domain: model },
    embeddingKeepAlive: { class: "ordinary", domain: bool },
    embeddingForceCpu: { class: "ordinary", domain: bool },
    theme: { class: "ordinary", domain: words("theme") },
    cardCorner: { class: "ordinary", domain: words("cardCorner") },
    agentHud: { class: "ordinary", domain: words("agentHud") },
    agentHudInDevtools: { class: "ordinary", domain: bool },
    pythonIdleMinutes: { class: "ordinary", domain: { kind: "number", min: 0, integer: true } },
    detachedTaskMaxMin: { class: "ordinary", domain: { kind: "number", min: 1, max: 60, integer: true } },
    agentStepMaxTokens: { class: "ordinary", domain: { kind: "number", min: 0, integer: true } },
    electricityPerKwh: { class: "ordinary", domain: { kind: "number", min: 0 } },
    electricityCurrency: { class: "ordinary", domain: { kind: "currency" } },
    electricityOffPeakPerKwh: { class: "ordinary", domain: { kind: "number", min: 0 } },
    electricityOffPeakHours: { class: "ordinary", domain: { kind: "hours" } },
    electricityOffPeakWeekends: { class: "ordinary", domain: bool },
    utilityModel: { class: "ordinary", domain: model },
    utilityNumCtx: { class: "ordinary", domain: { kind: "number", min: 512, integer: true } },
    utilityForceCpu: { class: "ordinary", domain: bool },
    autoTitles: { class: "ordinary", domain: bool },
    protoStream: { class: "ordinary", domain: words("protoStream") },
    groundingEnabled: { class: "ordinary", domain: bool },
    groundingModel: { class: "ordinary", domain: model },
    groundingRange: { class: "ordinary", domain: { kind: "number", min: 1, integer: true } },
});

/** A key's declaration, or null for a name that is not a setting. */
export function settingDecl(key: string): SettingDecl | null {
    return own(SETTING_CLASSES, key) ? (SETTING_CLASSES as unknown as Record<string, SettingDecl>)[key] : null;
}

/**
 * Whether the model may change this setting: classified, neither secret nor gate, and with a row in DevTools Settings.
 * The one rule `ml.settings()` and `change_setting` read.
 * @param key the setting
 * @param places where each setting lives in the panel; a parameter so a test can give a key a row
 */
export function modelWritable(key: string, places: Readonly<Partial<Record<string, SettingPlace>>> = SETTING_PLACES): boolean {
    const d = settingDecl(key);
    return !!d && d.class !== "secret" && d.class !== "gate" && own(places, key);
}

/**
 * Whether this change of a guarded setting is in its guarded direction, so it always asks. False for every other
 * class. A guarded key that declares no direction widens both ways.
 * @param key the setting
 * @param from the value now
 * @param to the value asked for
 */
export function settingWidens(key: string, from: unknown, to: unknown): boolean {
    const d = settingDecl(key);
    if (d?.class !== "guarded") return false;
    return d.widens ? d.widens(from, to) : true;
}

/** The ISO 4217 codes this runtime knows, read on first use. */
let currencies: ReadonlySet<string> | null = null; // state: cache

/** Whether `v` is an off-peak span of whole hours on a 24-hour clock, "23-7" style, two different hours. */
export function hoursOk(v: unknown): boolean {
    const m = typeof v === "string" ? /^(\d{1,2})-(\d{1,2})$/.exec(v) : null;
    if (!m) return false;
    const a = Number(m[1]), b = Number(m[2]);
    return a <= 23 && b <= 23 && a !== b;
}

/**
 * Whether `v` is in an ordinary setting's domain. Null for kind `model`, which needs the server's list: the caller
 * checks a model name as `setModel` does.
 * @param d the domain
 * @param v the value asked for
 */
export function domainAllows(d: SettingDomain, v: unknown): boolean | null {
    switch (d.kind) {
        case "boolean": return typeof v === "boolean";
        case "enum": return typeof v === "string" && d.words.includes(v);
        case "number": return typeof v === "number" && Number.isFinite(v) && v >= d.min && (d.max === undefined || v <= d.max) && (!d.integer || Number.isInteger(v));
        case "hours": return hoursOk(v);
        case "currency":
            currencies ??= new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : []);
            return typeof v === "string" && currencies.has(v);
        case "model": return null;
    }
}

/** What a restore says of a setting it lists apart (every guarded, gate or secret one), or null for an ordinary one. */
export function restoreListsApart(key: string): string | null {
    const d = settingDecl(key);
    return d && d.class !== "ordinary" ? d.reason : null;
}
