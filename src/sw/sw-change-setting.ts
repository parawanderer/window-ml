// sw-change-setting.ts — `change_setting` in the worker: the checks before a card, the facts a `setting` policy judges,
// the card's content, the compare-and-set write, and the run's memory of a declined guarded change.

// The order is the spec's (docs/spec/MODEL_SETTINGS.md, "The surface"): a change that cannot be made is refused with no
// card; a declined guarded key is refused for the rest of the run; then the `setting` consumer judges it, where a `deny`
// refuses, an `allow` frees only an ordinary change, and anything else is a card. What is written is the value the
// card showed, over the value it showed as current, or nothing.

import { DEFAULT_CONFIG, SETTING_PLACES, modelFilterAllows, type MlConfig, type SettingPlace } from "../contract/contract-config";
import type { EffectsData } from "../effects";
import { configTypeOk, domainAllows, modelWritable, settingDecl, settingWidens, type SettingClass } from "../setting-class";
import { SETTING_TEXT } from "../setting-text";
import { defineState } from "../state-registry";
import { judgeCall, navigateFacts } from "./sw-policies";
import { getConfig, listAvailableModels } from "./sw-llm";
import { recordRunLog } from "./sw-run-log";

/** The longest string a setting takes from the model: a URL, a path, a model name. */
export const SETTING_STRING_MAX = 2048;
/** The most entries a list setting takes from the model (folders, program directories, server tools). */
export const SETTING_LIST_MAX = 64;
/** The longest `why` the card shows, in characters. */
export const SETTING_WHY_MAX = 280;

/** One change the checks let through: the key, the value now and the value asked for, and what the change is. */
export interface SettingChange {
    key: keyof MlConfig & string;
    from: unknown;
    to: unknown;
    class: Exclude<SettingClass, "secret" | "gate">;
    widens: boolean;
}

/** What the worker needs to check a change: the config as stored, and the server's model ids for a model-name key. */
export interface SettingCheckDeps {
    config: MlConfig;
    /** The ids the server lists, or null when it cannot be read. Only called for a model-name key. */
    modelIds(): Promise<string[] | null>;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** A value as the model reads it in a result: JSON, so a list and a string are told apart. */
const shown = (v: unknown): string => JSON.stringify(v);
const settingLink = (key: string): string => `[${SETTING_TEXT[key as keyof MlConfig]?.name ?? key}](window-ml:setting/${key})`;
const NON_NEGATIVE_INT = new Set(["sessionRetentionDays", "sessionStoreBudgetMB", "valueStoreBudgetMB"]);

/**
 * Whether a value is one a guarded key's own control would hold, beyond its type. A guarded key has no closed domain;
 * these are its bounds, so no free text and no huge list reaches `sync`.
 * @param key the key
 * @param v the value, of the key's type
 * @returns the reason it is refused, or null
 */
function guardedBounds(key: string, v: unknown): string | null {
    if (NON_NEGATIVE_INT.has(key) && !(Number.isInteger(v) && (v as number) >= 0)) return "a whole number, 0 or more";
    if (Array.isArray(v)) {
        if (v.length > SETTING_LIST_MAX) return `at most ${SETTING_LIST_MAX} entries`;
        if (v.some((x) => typeof x !== "string" || !x.trim() || x.length > SETTING_STRING_MAX)) return `entries that are not empty and at most ${SETTING_STRING_MAX} characters`;
        if (new Set(v).size !== v.length) return "no entry twice";
        if ((key === "shellRoots" || key === "shellPath") && v.some((x) => !/^(\/|[A-Za-z]:[\\/])/.test(x as string))) return "absolute paths";
    }
    if (key === "agentStartPage" && v !== "") {
        let u: URL;
        try { u = new URL(v as string); } catch { return "an http(s) address, or \"\" for the default"; }
        if (u.protocol !== "https:" && u.protocol !== "http:") return "an http(s) address, or \"\" for the default";
        if (u.username || u.password) return "an address with no user name or password in it";
    }
    return null;
}

/**
 * Check a `change_setting` call before any card: the key is one the model may change, and the value is one its control
 * in Settings would hold. A refusal is one sentence the model reads; nothing is shown to the person.
 * @param args the model's arguments
 * @param deps the stored config and the server's model list
 * @returns the change, or the refusal
 */
export async function checkSettingChange(args: Record<string, unknown>, deps: SettingCheckDeps): Promise<{ change: SettingChange } | { error: string }> {
    const key = args.key;
    if (typeof key !== "string" || !key) return { error: "Error: change_setting needs `key`, the name of a setting (see ml.settings())." };
    const decl = settingDecl(key);
    if (!decl) return { error: `Error: there is no setting "${key.slice(0, 64)}". ml.settings() lists them.` };
    if (decl.class === "secret") return { error: `Error: ${key} is a secret setting: it can be neither read nor changed by a run.` };
    if (decl.class === "gate") return { error: `Error: ${key} decides which calls run without asking, so a run cannot change it. The person can, in Settings: ${settingLink(key)}.` };
    if (!modelWritable(key, SETTING_PLACES)) return { error: `Error: ${key} has no control in Settings, so a run cannot change it.` };
    if (!("value" in args)) return { error: `Error: change_setting needs \`value\`, the new value of ${key}.` };
    const to = args.value;
    const k = key as keyof MlConfig & string;
    if (!configTypeOk(k, to)) return { error: `Error: ${key} takes ${shown(DEFAULT_CONFIG[k]).length > 40 ? typeof DEFAULT_CONFIG[k] : `a value like ${shown(DEFAULT_CONFIG[k])}`}; ${shown(to)?.slice(0, 80)} is not one.` };
    if (typeof to === "string" && to.length > SETTING_STRING_MAX) return { error: `Error: ${key} takes at most ${SETTING_STRING_MAX} characters.` };
    if (decl.class === "ordinary") {
        const ok = domainAllows(decl.domain, to);
        if (ok === false) return { error: `Error: ${shown(to).slice(0, 80)} is not a value ${key} takes.` };
        if (ok === null && !(to === "" && DEFAULT_CONFIG[k] === "")) {
            const ids = await deps.modelIds().catch(() => null);
            if (!ids) return { error: `Error: the server's model list could not be read, so ${key} cannot be checked. Nothing was changed.` };
            if (!ids.includes(to as string) || !modelFilterAllows(to as string, deps.config.modelFilter)) return { error: `Error: "${String(to).slice(0, 80)}" is not a model the server offers here (ml.models() lists them).` };
        }
    } else {
        const bad = guardedBounds(key, to);
        if (bad) return { error: `Error: ${key} takes ${bad}.` };
    }
    const from = (deps.config as unknown as Record<string, unknown>)[key] ?? DEFAULT_CONFIG[k];
    if (sameValue(from, to)) return { error: `Error: ${key} is already ${shown(to)}. Nothing was changed.` };
    return { change: { key: k, from, to, class: decl.class, widens: settingWidens(k, from, to) } };
}

/**
 * The facts a `setting` policy sees (POLICIES.md): the key, both values, the class, whether this change widens, and an
 * effect nobody resolved, so the built-in default frees nothing.
 * @param c the checked change
 */
export function settingFacts(c: SettingChange): Record<string, unknown> & { effects: EffectsData } {
    return { kind: "setting", key: c.key, from: c.from, to: c.to, class: c.class, widens: c.widens, effects: "unknown" };
}

// --- a declined guarded change, for the rest of the run ---

/** The guarded keys the person declined in each run: only ever a refusal, never an answer. Kept in session storage as
 *  well, so a worker that wakes mid-run still refuses. */
const declined = new Map<string, Set<string>>();
const DECLINED_KEY = "ml_setting_declined";
/** Runs kept in the stored copy; past it the oldest go. */
const DECLINED_RUNS_MAX = 200;
defineState({
    id: "run.settings-declined", scope: "run", realm: "worker", audience: "model", lostOn: ["browser-restart"],
    describe: "The settings whose change you declined in this run: a change to any of them is refused for the rest of the run without asking you again.",
    read: ({ runId }) => { const s = runId ? declined.get(runId) : undefined; return s?.size ? [...s] : undefined; },
});

async function storedDeclined(): Promise<Record<string, string[]>> {
    try { const got = await chrome.storage.session.get(DECLINED_KEY); const v = got?.[DECLINED_KEY]; return v && typeof v === "object" ? v as Record<string, string[]> : {}; }
    catch { return {}; }
}

/**
 * Whether the person declined a change of this key earlier in the run.
 * @param runId the run
 * @param key the setting
 */
export async function settingDeclined(runId: string, key: string): Promise<boolean> {
    if (declined.get(runId)?.has(key)) return true;
    const keys = (await storedDeclined())[runId];
    if (!Array.isArray(keys)) return false;
    declined.set(runId, new Set([...(declined.get(runId) ?? []), ...keys.filter((k) => typeof k === "string")]));
    return declined.get(runId)!.has(key);
}

/**
 * Note that the person declined a guarded change: the key is refused for the rest of the run.
 * @param runId the run
 * @param key the setting
 */
export async function noteSettingDeclined(runId: string, key: string): Promise<void> {
    declined.set(runId, new Set([...(declined.get(runId) ?? []), key]));
    const all = await storedDeclined();
    const next = { ...all, [runId]: [...declined.get(runId)!] };
    const runs = Object.keys(next);
    for (const r of runs.slice(0, Math.max(0, runs.length - DECLINED_RUNS_MAX))) delete next[r];
    try { await chrome.storage.session.set({ [DECLINED_KEY]: next }); } catch { /* the worker's copy still refuses */ }
}

// --- reading: ml.settings() ---

/** One entry of `ml.settings()`: a secret's has no `value` field at all, so it does not say whether it is set. */
export type SettingEntry =
    | { value: unknown; mode: "read" | "read-write"; class: "gate" | "guarded" | "ordinary" }
    | { mode: "hidden"; class: "secret" };

/**
 * What `ml.settings()` returns: one entry per classified key with a row in DevTools Settings, in the panel's order, read
 * from `config` each time it is called (docs/spec/MODEL_SETTINGS.md, "Reading").
 * @param config the stored config
 * @param places where each setting lives; a parameter so a test can pass another table
 */
export function settingEntries(config: MlConfig, places: Readonly<Partial<Record<keyof MlConfig, SettingPlace>>> = SETTING_PLACES): Record<string, SettingEntry> {
    const out: Record<string, SettingEntry> = {};
    for (const key of Object.keys(places)) {
        const d = settingDecl(key);
        if (!d) continue;
        if (d.class === "secret") { out[key] = { mode: "hidden", class: "secret" }; continue; }
        const value = (config as unknown as Record<string, unknown>)[key] ?? DEFAULT_CONFIG[key as keyof MlConfig];
        out[key] = { value, mode: modelWritable(key, places) ? "read-write" : "read", class: d.class };
    }
    return out;
}

// --- judging, before a card ---

/** What judging a checked change decided: refused (the model reads why), freed by a policy, or a card. */
export type SettingVerdict = { refused: string } | { allow: string } | null;

/**
 * Judge a checked change as the `setting` consumer. A `deny` refuses, whatever the class. An `allow` frees an ordinary
 * change only: a guarded one always asks. A declined guarded key is refused first. `agentStartPage` is judged as the
 * navigation it causes too, so a `fetch` deny of its host refuses it.
 * @param runId the run
 * @param c the checked change
 * @returns the verdict; null for a card
 */
export async function judgeSettingChange(runId: string, c: SettingChange): Promise<SettingVerdict> {
    if (c.class === "guarded" && await settingDeclined(runId, c.key))
        return { refused: `Not changed: the person declined a change to ${c.key} earlier in this run, so it is not asked again. Do not retry it.` };
    if (c.key === "agentStartPage" && typeof c.to === "string" && c.to) {
        const nav = judgeCall(runId, "fetch", navigateFacts(c.to));
        if (nav.decision === "deny" && nav.by && nav.by !== "builtin")
            return { refused: `Refused by the policy "${nav.by.label}", without asking: every blank run would open that page. Do not retry it; the person set this rule.` };
    }
    const j = judgeCall(runId, "setting", settingFacts(c));
    if (j.decision === "deny" && j.by && j.by !== "builtin") return { refused: `Refused by the policy "${j.by.label}", without asking: ${c.key} was not changed. Do not retry it; the person set this rule.` };
    if (j.decision === "allow" && j.by && j.by !== "builtin" && c.class === "ordinary") return { allow: j.by.label };
    return null;
}

// --- what the run host calls: before a card, and the card ---

/** The worker's own deps for {@link checkSettingChange}: the stored config, and the server's model ids. */
export async function settingDeps(): Promise<SettingCheckDeps> {
    return { config: await getConfig(), modelIds: () => listAvailableModels().then((r) => r.ids, () => null) };
}

/** What a `setting` proposal is measured over (policy-proposal.ts): the stored config, and the server's model ids, read once. */
export async function settingMeasureDeps(): Promise<{ config: MlConfig; modelIds: string[] | null }> {
    const d = await settingDeps();
    return { config: d.config, modelIds: await d.modelIds().catch(() => null) };
}

/**
 * Everything before a card, in the spec's order: check, then judge. A change a policy frees is held for the write.
 * @param runId the run
 * @param args the model's arguments
 * @returns refused (the model reads why), allowed by the named policy, or undefined for a card
 */
export async function settingBeforeCard(runId: string, args: Record<string, unknown>): Promise<{ refused: string } | { allow: string } | undefined> {
    const c = await checkSettingChange(args, await settingDeps());
    if ("error" in c) return { refused: c.error };
    const v = await judgeSettingChange(runId, c.change);
    if (v && "allow" in v) {
        holdSettingChange(runId, c.change, "policy");
        recordRunLog(runId, { subsystem: "policy", kind: "allow", reason: v.allow, detail: { tool: "change_setting", key: c.change.key } });
    }
    return v ?? undefined;
}

/** The card's In render for a change (`type: "setting"`, contract-render.ts). */
export type SettingCardIn = Extract<import("../contract").RenderDescriptor, { type: "setting" }>;

/**
 * The card for a call that reached one: checked again (a setting may have changed since `settingBeforeCard`), its
 * content from the facts and the Settings text, never from the model's words except `why`, and the change held as the
 * one the person answers.
 * @param runId the run
 * @param args the model's arguments
 * @returns the change and its card, or the refusal the model reads
 */
export async function settingCard(runId: string, args: Record<string, unknown>): Promise<{ change: SettingChange; card: SettingCardIn } | { error: string }> {
    const r = await checkSettingChange(args, await settingDeps());
    if ("error" in r) return r;
    const c = r.change;
    const text = SETTING_TEXT[c.key];
    const decl = settingDecl(c.key);
    const why = typeof args.why === "string" && args.why.trim() ? args.why.trim().slice(0, SETTING_WHY_MAX) : undefined;
    let host: string | undefined;
    if (c.key === "agentStartPage" && typeof c.to === "string" && c.to) try { host = new URL(c.to).hostname; } catch { /* checked above */ }
    holdSettingChange(runId, c, "person");
    return { change: c, card: {
        type: "setting", key: c.key, name: text?.name ?? c.key, ...(text?.tip ? { tip: text.tip } : {}),
        ...(decl && decl.class === "guarded" ? { reason: decl.reason } : {}),
        class: c.class, from: c.from, to: c.to, ...(why ? { why } : {}), synced: true, ...(host ? { host } : {}),
    } };
}

/**
 * What the model reads when its card closed because the setting changed elsewhere first: the key, never a value (a
 * shell key's card shows its values verbatim; the model's text does not repeat them).
 * @param key the setting
 */
export const settingChangedElsewhere = (key: string): string =>
    `${key} changed while the card was showing, so nothing was written. Read it again with ml.settings() before asking for another change.`;

// --- what the card and the write agree on ---

/** The change each run's call was judged on, which the write holds the stored value to: `${runId}\n${key}`. */
const judged = new Map<string, { from: unknown; to: unknown; by: "person" | "policy" }>();
defineState({
    id: "run.setting-judged", scope: "run", realm: "worker", audience: "human", lostOn: ["worker-eviction"],
    describe: "The setting change this run is about to write, with the value it was judged against: the write lands only if the setting still holds that value.",
    read: ({ runId }) => { const out = [...judged].filter(([k]) => k.startsWith(`${runId}\n`)).map(([k, v]) => ({ key: k.slice(k.indexOf("\n") + 1), ...v })); return out.length ? out : undefined; },
});

/**
 * Hold the change a card shows, or a policy freed, as the one the write may make.
 * @param runId the run
 * @param c the checked change
 * @param by who answers it
 */
export function holdSettingChange(runId: string, c: SettingChange, by: "person" | "policy"): void {
    judged.set(`${runId}\n${c.key}`, { from: c.from, to: c.to, by });
}

/** Drop a held change: the card was declined, closed or cancelled. */
export function releaseSettingChange(runId: string, key: string): void {
    judged.delete(`${runId}\n${key}`);
}

/** What the write did, which the tool's result says. */
export type SettingWrite =
    | { ok: true; key: string; from: unknown; to: unknown; by: "person" | "policy" }
    | { ok: false; text: string };

/**
 * Write the held change: compare-and-set against the stored value, so a change from anywhere else since the card was
 * drawn (the person in Settings, another browser through `sync`) is never written over.
 * @param runId the run
 * @param args the call's arguments, which must be the change held
 */
export async function writeSettingChange(runId: string, args: Record<string, unknown>): Promise<SettingWrite> {
    const key = typeof args.key === "string" ? args.key : "";
    const held = judged.get(`${runId}\n${key}`);
    judged.delete(`${runId}\n${key}`);
    if (!held || !sameValue(held.to, args.value)) return { ok: false, text: `Not changed: ${key || "the setting"} was not the change that was approved. Call change_setting again.` };
    const k = key as keyof MlConfig;
    const now = (await chrome.storage.sync.get({ [k]: DEFAULT_CONFIG[k] }))[k];
    if (!sameValue(now, held.from)) return { ok: false, text: `Not changed: ${key} changed while this was being decided, so nothing was written. Read it again with ml.settings() before asking for another change.` };
    await chrome.storage.sync.set({ [k]: held.to });
    return { ok: true, key, from: held.from, to: held.to, by: held.by };
}

/**
 * The tool's result for a write: the old value, so the model can say how to undo it.
 * @param w what the write did
 */
export function settingWriteText(w: SettingWrite): string {
    if (!w.ok) return w.text;
    return `Changed ${w.key} from ${shown(w.from)} to ${shown(w.to)}. It applies to every browser signed in to this profile. To undo it, set it back to ${shown(w.from)}.`;
}

/**
 * The tool's `run` in the worker: make the approved write, record it in the run's execution log, and say what it did.
 * @param runId the run
 * @param args the call's arguments
 * @returns the text the model reads
 */
export async function changeSettingApproved(runId: string, args: Record<string, unknown>): Promise<string> {
    const w = await writeSettingChange(runId, args).catch((): SettingWrite => ({ ok: false, text: "Not changed: the setting could not be written." }));
    if (w.ok) recordRunLog(runId, { subsystem: "setting", kind: "changed", reason: w.by, detail: { key: w.key, from: shown(w.from), to: shown(w.to) } });
    else recordRunLog(runId, { level: "warn", subsystem: "setting", kind: "not-changed", detail: { key: typeof args.key === "string" ? args.key.slice(0, 64) : "" } });
    return settingWriteText(w);
}

/**
 * Call `onChange` when the stored value of `key` changes, from anywhere: an open card closes on it.
 * @param key the setting
 * @param onChange the listener
 * @returns the call that stops listening
 */
export function watchSetting(key: string, onChange: () => void): () => void {
    const f = (changes: Record<string, unknown>, area: string): void => { if (area === "sync" && Object.prototype.hasOwnProperty.call(changes, key)) onChange(); };
    try { chrome.storage.onChanged.addListener(f); } catch { return () => {}; }
    return () => { try { chrome.storage.onChanged.removeListener(f); } catch { /* gone with the worker */ } };
}
