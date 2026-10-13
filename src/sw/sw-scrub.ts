// sw-scrub.ts — the worker's one crossing for error text: what a page is answered and what a run's model reads, with the config's secrets taken out.

import { getConfig } from "./sw-llm";
import { mergeSecrets, scrubErrors, scrubSecrets, secretsOf, type SecretSub } from "../secret-scrub";
import type { MlConfig } from "../contract/contract-config";
import type { NeutralMessage } from "../contract/contract-chat";

/** The settings `secretsOf` reads. */
const SECRET_KEYS = ["chatUrl", "apiKey", "modelFilter", "priceSnapshotUrl"] as const;
/** How many replaced settings are remembered. */
const RETIRED_MAX = 8;

/** The values of secret settings replaced since the worker started, newest first: an error written under the old URL
 *  (a request in flight when the setting changed) reaches a crossing after the change, and is scrubbed by them too. */
const retired: Partial<MlConfig>[] = [];   // state: cache
chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "sync") return;
    const old: Record<string, string> = {};
    for (const k of SECRET_KEYS) {
        const v = changes[k]?.oldValue;
        if (typeof v === "string" && v.trim()) old[k] = v;
    }
    if (Object.keys(old).length) { retired.unshift(old as Partial<MlConfig>); retired.length = Math.min(retired.length, RETIRED_MAX); }
});

/** The secrets in the stored config now, read at the crossing so a URL changed a moment ago is the one scrubbed, and
 *  those of the settings it replaced. */
async function configSecrets(): Promise<SecretSub[]> {
    return mergeSecrets([secretsOf(await getConfig()), ...retired.map(secretsOf)]);
}

/**
 * A response bound for a page, with every `error` string scrubbed (`scrubErrors`). Applied by the router to every
 * answer to a page-started message and to the streaming port's error. Fails closed: a config that cannot be read
 * leaves an error carrying nothing but that the request failed.
 * @param response what the handler answered
 * @returns the response a page may read
 */
export async function forPage<T>(response: T): Promise<T> {
    try { return scrubErrors(response, await configSecrets()); }
    catch { return (response && typeof response === "object" && "error" in response ? { error: "The request failed." } : response) as T; }
}

/**
 * A tool result bound for a run's model, scrubbed (`scrubSecrets`). The caller keeps the text as the tool wrote it
 * where only the person reads it (the run log's `key`).
 * @param text the tool's result
 * @returns the text the model may read, and whether it differs from `text`
 */
export async function forModel(text: string): Promise<{ text: string; changed: boolean }> {
    let secrets: SecretSub[];
    try { secrets = await configSecrets(); } catch { return { text: "Error: the tool failed (its message could not be checked).", changed: true }; }
    const out = scrubSecrets(text, secrets);
    return { text: out, changed: out !== text };
}

/**
 * A history a run resumes from, scrubbed in place: the tool results and the model's own replies of a session saved
 * before the scrub existed (or under another config) carry the raw text, and the model reads them again on resume.
 * @param messages the history, as the loop will send it
 * @returns how many messages changed
 */
export async function forModelHistory(messages: NeutralMessage[]): Promise<number> {
    let changed = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if ((m.role !== "tool" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) continue;
        const r = await forModel(m.content);
        if (r.changed) { messages[i] = { ...m, content: r.text }; changed++; }
    }
    return changed;
}
