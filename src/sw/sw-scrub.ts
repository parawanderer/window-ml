// sw-scrub.ts — the worker's one crossing for error text: what a page is answered and what a run's model reads, with the config's secrets taken out.

import { getConfig } from "./sw-llm";
import { scrubErrors, scrubSecrets, secretsOf, type SecretSub } from "../secret-scrub";

/** The secrets in the stored config now, read at the crossing so a URL changed a moment ago is the one scrubbed. */
async function configSecrets(): Promise<SecretSub[]> {
    return secretsOf(await getConfig());
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
