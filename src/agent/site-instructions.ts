// site-instructions.ts — what of a page-built run's system prompt the SITE wrote, for the start card to show.

import { AGENT_SYSTEM, CALL_TITLE_CLAUSE, VISION_CLAUSE, tooltokensClause, DEREF_CLAUSE, shadowClause, IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE, PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, UNATTENDED_CLAUSE, NAV_OFF_CLAUSE, currentClause } from "./prompts";

/** The marker `assembleRun` writes before a run's `systemAppend`. */
const NOTES_MARKER = "\n\nTask-specific notes:\n";

/** The marker `withPageContext` writes before the page's own context lines. */
const CONTEXT_MARKER = "\n\nCurrent page context:\n";

/** The labels `pageContext()` (util.ts) starts its lines with. A context block holding any other line is the site's
 *  writing, not the page's description of itself. */
const CONTEXT_LABELS = /^(URL|Title|Page language|Now|Locale|Browser|Shadow DOM|Markdown|Iframes): /;

/** The longest context line `pageContext()` writes (a long URL), with room to spare; a longer one is the site's. */
const CONTEXT_LINE_MAX = 2200;

/**
 * The text a page-built run's system prompt carries that the extension did not write: what a site passed as `system`
 * or `systemAppend`, or wrote into the prompt by hand. The page assembles a run's prompt itself and sends it whole, so
 * the worker cannot take the site's word for which part is its own. It removes what it can recognise as the
 * extension's (the stock preamble, every clause `assembleRun` adds for this toolset, the notes marker, and a page
 * context block made only of the lines `pageContext()` writes), and whatever is left is the site's.
 * @param systemPrompt the system prompt the page sent
 * @param toolNames the run's tool names (the shadow clause names them)
 * @returns the site's text, trimmed; empty when the prompt is the extension's alone
 */
export function siteInstructions(systemPrompt: unknown, toolNames: readonly string[]): string {
    let rest = typeof systemPrompt === "string" ? systemPrompt : "";
    // The page's context block, only when every line of it is one `pageContext()` writes.
    const at = rest.lastIndexOf(CONTEXT_MARKER);
    if (at >= 0) {
        const lines = rest.slice(at + CONTEXT_MARKER.length).split("\n");
        if (lines.every((l) => CONTEXT_LABELS.test(l) && l.length <= CONTEXT_LINE_MAX)) rest = rest.slice(0, at);
    }
    const clauses = [
        CALL_TITLE_CLAUSE, VISION_CLAUSE, tooltokensClause(true), tooltokensClause(false), DEREF_CLAUSE,
        shadowClause(toolNames, true), shadowClause(toolNames, false), IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE,
        PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, currentClause(true), currentClause(false), UNATTENDED_CLAUSE,
        NAV_OFF_CLAUSE,
    ].filter((c) => c.length > 0).sort((a, b) => b.length - a.length);
    if (rest.startsWith(AGENT_SYSTEM)) rest = rest.slice(AGENT_SYSTEM.length);
    for (const c of clauses) rest = rest.split(c).join("\n");
    rest = rest.split(NOTES_MARKER).join("\n");
    return rest.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A short, stable fingerprint of a text, for telling whether a later turn changed a run's instructions without
 * keeping the text itself in the approval (cyrb53).
 * @param text the text
 * @returns a hex digest
 */
export function textDigest(text: string): string {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
