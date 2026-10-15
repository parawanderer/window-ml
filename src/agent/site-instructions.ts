// site-instructions.ts — what of a page-built run's system prompt the SITE wrote, for the start card to show.

import { AGENT_SYSTEM, CALL_TITLE_CLAUSE, VISION_CLAUSE, tooltokensClause, DEREF_CLAUSE, shadowClause, IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE, PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, UNATTENDED_CLAUSE, NAV_OFF_CLAUSE, currentClause } from "./prompts";

/** The marker `assembleRun` writes before a run's `systemAppend`. */
const NOTES_MARKER = "\n\nTask-specific notes:\n";

/**
 * The text a page-built run's system prompt carries that the extension did not write: what a site passed as `system`
 * or `systemAppend`, or wrote into the prompt by hand. The page assembles a run's prompt itself and sends it whole, so
 * the worker cannot take the site's word for which part is its own. It removes what it can recognise as the
 * extension's (the stock preamble, every clause `assembleRun` adds for this toolset, and the notes marker), and whatever
 * is left is the site's: a "Current page context" block the page wrote included, whatever its lines look like, since the
 * worker writes the context of a site's run itself (`workerPageContext`).
 * @param systemPrompt the system prompt the page sent
 * @param toolNames the run's tool names (the shadow clause names them)
 * @returns the site's text, trimmed; empty when the prompt is the extension's alone
 */
export function siteInstructions(systemPrompt: unknown, toolNames: readonly string[]): string {
    let rest = typeof systemPrompt === "string" ? systemPrompt : "";
    const clauses = [
        CALL_TITLE_CLAUSE, VISION_CLAUSE, tooltokensClause(true), tooltokensClause(false), DEREF_CLAUSE,
        shadowClause(toolNames, true), shadowClause(toolNames, false), IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE,
        PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, currentClause(true), currentClause(false), UNATTENDED_CLAUSE,
        NAV_OFF_CLAUSE,
    ].filter((c) => c.length > 0).sort((a, b) => b.length - a.length);
    // Wherever it sits: text the site put before the preamble is then all that is left, not the preamble with it.
    rest = rest.split(AGENT_SYSTEM).join("\n");
    for (const c of clauses) rest = rest.split(c).join("\n");
    rest = rest.split(NOTES_MARKER).join("\n");
    return rest.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A fingerprint of a text, for telling whether a later turn changed what an approval covers without keeping the text
 * itself: SHA-256, since a page chooses both texts and a short non-cryptographic hash lets it find two that collide.
 * @param text the text
 * @returns the hex digest
 */
export async function textDigest(text: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The "Current page context" block of a run a SITE started, written by the worker from the browser's facts about the
 * sender: its URL, the tab's title (cut at 80 characters, as `pageContext()` cuts it), the time and the locale. The page's
 * own copy is never taken for it (a page could write anything there), so the card can call whatever the page sent the
 * site's.
 * @param url the sender's URL
 * @param title the tab's title, as the browser reports it
 * @param now the time
 * @returns the lines, joined
 */
export function workerPageContext(url: string, title: string | undefined, now = new Date()): string {
    const parts = [`URL: ${url}`];
    const t = (title || "").replace(/\s+/g, " ").trim();
    if (t) parts.push(`Title: ${t.length > 80 ? t.slice(0, 79) + "…" : t}`);
    let locale: string | undefined, tz: string | undefined;
    try { const o = Intl.DateTimeFormat().resolvedOptions(); locale = o.locale; tz = o.timeZone; } catch { /* none */ }
    parts.push(`Now: ${now.toLocaleString(locale)}${tz ? ` (${tz})` : ""} — ISO ${now.toISOString()}`);
    if (locale) parts.push(`Locale: ${locale}`);
    return parts.join("\n");
}
