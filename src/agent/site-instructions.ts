// site-instructions.ts — what of a page-built run's system prompt the SITE wrote, for the start card to show.

import { AGENT_SYSTEM, CALL_TITLE_CLAUSE, VISION_CLAUSE, tooltokensClause, DEREF_CLAUSE, shadowClause, IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE, PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, UNATTENDED_CLAUSE, NAV_OFF_CLAUSE, currentClause } from "./prompts";

/** The marker `assembleRun` writes before a run's `systemAppend`. */
const NOTES_MARKER = "\n\nTask-specific notes:\n";

/** The marker `withPageContext` writes before the page's own context lines. */
const CONTEXT_MARKER = "\n\nCurrent page context:\n";

/** The exact shapes of the lines `pageContext()` (util.ts) writes. A context block holding any other line, or one of these
 *  with words of the site's in it, is the site's writing, not the page's description of itself. Only the URL and the title
 *  are free text, and the title is cut at 80 characters there: page data the model reads, as it reads the page. Change
 *  these with `pageContext()`. */
const CONTEXT_LINES: readonly RegExp[] = [
    /^URL: \S{1,2100}$/,
    /^Title: [^\n]{0,81}$/,
    /^Page language: [\w-]{1,40}$/,
    /^Now: [^\n—]{1,60} — ISO \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    /^Locale: [\w-]{1,40}$/,
    /^Browser: [A-Za-z][A-Za-z ]{0,30}( [\d.]{1,20})?$/,
    /^Shadow DOM: \d+ open\/captured shadow roots?( \(the DOM tools pierce these — reference with `host >>> inner`\))?((; |, )~\d+ custom elements? expose no light DOM \(mostly EMPTY — unopened menus\/outlets; a few may seal content — reach any visible one with locate\/@pt\))?\.$/,
    /^Markdown: this page declares a Markdown version at \S{1,2100}( — fetch_url it \(same-origin, so no approval\) rather than surveying the DOM)?\.$/,
    /^Markdown: not declared, but the page offers a copy-as-Markdown control — fetch_url on this URL may still return one\.$/,
    /^Iframes: (\d+ same-origin \(the DOM tools cross these — references look like `iframe >>> inner`\))?(; )?(\d+ cross-origin \(walled off by SOP — reach a control visually via locate\/@pt \+ reserved-element clicking\))?\.$/,
];

/**
 * The text a page-built run's system prompt carries that the extension did not write: what a site passed as `system`
 * or `systemAppend`, or wrote into the prompt by hand. The page assembles a run's prompt itself and sends it whole, so
 * the worker cannot take the site's word for which part is its own. It removes what it can recognise as the
 * extension's (the stock preamble, every clause `assembleRun` adds for this toolset, the notes marker, and a page
 * context block made only of lines shaped as `pageContext()` writes them), and whatever is left is the site's.
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
        if (lines.every((l) => CONTEXT_LINES.some((re) => re.test(l)))) rest = rest.slice(0, at);
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
