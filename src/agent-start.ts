// agent-start.ts — the pure rules of a SITE starting the extension's agent: the refusals it sees, what an approval is
// bound to, the start card's tool lines, and how a page-sent turn is marked for the model.
//
// docs/spec/SITE_ACCESS_SLICE3.md, PR 2. The worker's half (the asks, the approvals in storage, the timers) is
// `sw/sw-start-approval.ts`; the card is `sidebar/card/card-start.tsx`. Everything here is pure and shared by both, so
// the worker and the card cannot word or count a thing differently.

import { GATED_BUILTINS, cardLine, isBuiltinTool } from "./tools/tool-registry";

/** The refusals a page sees (and the model, when its `exec` calls `ml.agent`), SITE_ACCESS_SLICE3.md 1.7. */
export const START_REFUSED = {
    /** `ml.agent` without `host: "page"` (a START_RUN) from a site without the agent level (Q1). */
    noLevelStart: (origin: string): string => `Refused: ${origin} may use window.ml but not start agents. Pass \`host: "page"\` to run the loop in the page, or ask with \`ml.requestAccess({ agents: true })\`.`,
    /** RESUME_RUN or INJECT_MESSAGE from a site without the agent level. */
    noLevel: (origin: string): string => `Refused: ${origin} may use window.ml but not start agents. Ask with \`ml.requestAccess({ agents: true })\`, or allow it from the extension's toolbar button.`,
    denied: (origin: string): string => `Refused: ${origin} is not allowed to start agents.`,
    declined: "Refused: the person declined to start this agent. Nothing ran.",
    unanswered: "Refused: nobody answered the request to start this agent. Nothing ran.",
    waiting: "Refused: this site already has an agent start waiting for an answer on this tab.",
    quieted: "Refused: this site's agent starts were declined. It may ask again after the browser restarts.",
    moreDeclined: (m: number): string => `Refused: the person declined to let this site send more than ${m} messages to this agent.`,
    openedByAgent: "Refused: this page was opened by a running agent, which cannot be started from here.",
    otherSite: (runId: string): string => `Refused: run "${runId}" was started by another site.`,
    firstTurnHistory: "Refused: an agent's first turn cannot carry an earlier conversation.",
    /** NEEDS OWNER APPROVAL: the spec caps the asks waiting across the browser at 3 but gives no text for the refusal. */
    tooMany: "Refused: too many agent starts are waiting for an answer. Try again later.",
} as const;

/** The summary of a run cancelled because its site lost the agent level while it ran (Q9). */
export const CANCELLED_NO_LEVEL = "Cancelled: this site may no longer start agents.";

/** The quiet line a run's step list shows for a start a page it opened asked for (Q17). */
export const OPENED_BY_AGENT_NOTE = "not started: this page was opened by a running agent";

/** How long a start card waits for an answer before it counts as Deny (Q5). */
export const START_ASK_TIMEOUT_MS = 3 * 60_000;

/** At most this many start asks wait across the browser (3.1). */
export const START_ASKS_MAX = 3;

/** After this many denials or timeouts in a browser session, an origin's starts are refused without a card (Q8). */
export const START_DENIALS_QUIET = 3;

/** The page turn budget a start card grants: the messages a site may send to its agent after the start before it asks
 *  again (Q2). The worker's number, never the page's. */
export const PAGE_TURN_BUDGET = 10;

/** The step budget a turn gets when the site named none: the agent loop's own default. */
export const DEFAULT_TURN_STEPS = 10;

/**
 * A turn the PAGE sent, as the model reads it: marked as the page's, never as the person's (Q2a).
 * @param origin the sending page's origin, as the browser reported it
 * @param text what the page sent
 * @returns the marked text
 */
export function pageTurnText(origin: string, text: string): string {
    return `Message from the page (${origin}): ${text}`;
}

/** What one approval is bound to (Q3): a later turn that adds a gated builtin or a server tool, changes the model, or
 *  changes the site's instructions asks again. A smaller toolset or the same model rides. */
export interface StartBinding {
    /** The gated builtins the run has, a site tool that takes a builtin's name included. Sorted. */
    gated: string[];
    /** The server tools, as `toolId.fn`. Sorted. */
    server: string[];
    /** The model the worker resolved. */
    model: string | null;
    /** A digest of the site's own instructions (`siteInstructions`), empty when there are none. */
    instructions: string;
    /** Each tool's name with a digest of its description and parameters: text the model reads that the card never shows. */
    tools: Record<string, string>;
    /** `navigate` may cross to other sites. */
    crossOrigin: boolean;
    /** Steps a turn. */
    budget: number;
}

/** A tool descriptor as a START_RUN carries it: the fields these rules read. */
export interface ToolLike { name: string; remote?: { toolId: string; fn: string }; description?: string; parameters?: unknown }

/** What else of a turn its approval is bound to, beyond its tools and model. */
export interface BindingFacts { instructions: string; tools: Record<string, string>; crossOrigin: boolean; budget: number }

/**
 * The binding of one turn.
 * @param tools the turn's tool descriptors
 * @param model the model the worker resolved for the turn
 * @param facts the digests of the site's instructions and tool texts, `crossOrigin`, and the steps a turn
 * @returns the binding
 */
export function bindingOf(tools: readonly ToolLike[], model: string | null, facts: BindingFacts): StartBinding {
    const gated = new Set<string>(), server = new Set<string>();
    for (const t of tools) {
        if (!t || typeof t.name !== "string") continue;
        if (t.remote && typeof t.remote.toolId === "string" && typeof t.remote.fn === "string") server.add(`${t.remote.toolId}.${t.remote.fn}`);
        else if (GATED_BUILTINS.has(t.name)) gated.add(t.name);
    }
    return { gated: [...gated].sort(), server: [...server].sort(), model, ...facts };
}

/** What a turn changes against its approval: each field true when it widens or changes. Null when it rides. */
export interface Widening { gated: string[]; server: string[]; model: boolean; instructions: boolean; crossOrigin: boolean; budget: boolean }

/**
 * Whether a turn asks for more than its approval allowed (Q3).
 * @param approved the approval's binding
 * @param next the turn's binding
 * @returns what it adds or changes, or null when the turn rides on the approval
 */
export function widening(approved: StartBinding, next: StartBinding): Widening | null {
    const gated = next.gated.filter((n) => !approved.gated.includes(n));
    const server = next.server.filter((n) => !approved.server.includes(n));
    const model = next.model !== approved.model;
    // A tool's description is instructions the model reads, as the system prompt is.
    // A tool the approval did not have, or one whose text changed, is new text the model reads. One left out rides.
    const was = approved.tools ?? {};
    const toolText = Object.entries(next.tools ?? {}).some(([name, d]) => was[name] !== d);
    const instructions = next.instructions !== approved.instructions || toolText;
    const crossOrigin = next.crossOrigin && !approved.crossOrigin;
    const budget = next.budget > approved.budget;
    return gated.length || server.length || model || instructions || crossOrigin || budget ? { gated, server, model, instructions, crossOrigin, budget } : null;
}

/** One line under "It can:", and whether it is new on a widening turn. */
export interface CardToolLine { text: string; isNew?: boolean }

/**
 * The start card's tool lines (SITE_ACCESS_SLICE3.md 1.1): one fixed sentence per builtin the run has, each once, in
 * the registry's order; the server tools by name; and the site's own tools counted, never described.
 * @param tools the run's tool descriptors
 * @param facts the run's `crossOrigin`
 * @param added on a widening turn, the names it adds (their lines get the "new" chip)
 * @returns the lines
 */
export function cardToolLines(tools: readonly ToolLike[], facts: { crossOrigin?: boolean }, added: { gated?: string[]; server?: string[] } = {}): CardToolLine[] {
    const lines: CardToolLine[] = [];
    const seen = new Map<string, CardToolLine>();
    const server: string[] = [];
    let site = 0;
    for (const t of tools) {
        if (!t || typeof t.name !== "string") continue;
        if (t.remote && typeof t.remote.toolId === "string" && typeof t.remote.fn === "string") { server.push(`${t.remote.toolId}.${t.remote.fn}`); continue; }
        if (!isBuiltinTool(t.name)) { site++; continue; }
        const text = cardLine(t.name, facts);
        if (!text) continue;
        const isNew = !!added.gated?.includes(t.name);
        const had = seen.get(text);
        if (had) { if (isNew) had.isNew = true; continue; }
        const line: CardToolLine = { text, ...(isNew ? { isNew } : {}) };
        seen.set(text, line);
        lines.push(line);
    }
    if (server.length) lines.push({ text: `Use server tools: ${[...new Set(server)].join(", ")}. Their arguments leave this machine`, ...(added.server?.length ? { isNew: true } : {}) });
    if (site) lines.push({ text: site === 1 ? "Use 1 tool the site defined. It runs as the site's own code" : `Use ${site} tools the site defined. They run as the site's own code` });
    return lines;
}

/**
 * The text of each of a turn's tools the model reads (its description and parameters), digested by `digest`, by name.
 * @param tools the turn's tool descriptors
 * @param digest the digest to apply
 * @returns name → digest
 */
export function toolTexts(tools: readonly ToolLike[], digest: (s: string) => string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of tools) {
        if (!t || typeof t.name !== "string") continue;
        let text: string;
        try { text = JSON.stringify([t.description ?? null, t.parameters ?? null]); } catch { text = String(Math.random()); }
        out[t.name] = digest(text);
    }
    return out;
}

/** Bidi controls and zero-width characters, which can make a quote read other than it is. */
const INVISIBLE = /[؜​-‏‪-‮⁠-⁩﻿]/g;

/**
 * A site's text with every bidi control and zero-width character made visible as `⟨U+202E⟩`, so a quote reads as it
 * is (3.2).
 * @param text the site's text
 * @returns the same text, with those characters shown
 */
export function visibleControls(text: string): string {
    return text.replace(INVISIBLE, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

/** The heading's `{host}`: the origin with its scheme dropped (1.1, "Placeholders"). */
export function hostOf(origin: string): string {
    return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}
