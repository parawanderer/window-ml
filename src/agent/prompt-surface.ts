// prompt-surface.ts — WHAT IT MEANS that a prompt came from where it did, in the words the model reads.
//
// One table, two readers: the `chat_metadata` tool (which reports the surface of the LAST prompt) and the run's
// system-prompt provenance clause. They used to be one hard-coded sentence that said "the in-page HUD, not the
// devtools console" — binary, and fixed at run start, so it was simply wrong for a chat-app run and could not
// change when a follow-up arrived from somewhere else.
//
// Each entry says the IMPLICATION rather than the name. "Came from the chat app" is trivia the model can do
// nothing with; "the person is reading in a separate tab and may not be looking at the page you are working on"
// decides whether to describe what changed on screen. It composes with the `user focus` line (user-focus.ts),
// which says where the user is now: surface is where they typed, focus is where they are, and neither implies
// the other.
import type { PromptOrigin, PromptSurface } from "../contract/contract-run";

/** A short human name per surface, for a UI that shows provenance. Not model-facing — the model gets the
 *  sentence below, which says what the place means rather than what it is called. */
export const PROMPT_SURFACE_LABEL: Record<PromptSurface, string> = {
    hud: "Commander HUD",
    overlay: "sidebar on the page",
    devtools: "DevTools panel",
    chat: "chat app",
    console: "console",
};

/** What each surface implies, as the model reads it. Terse on purpose (cf. the other *_CLAUSE text): this rides
 *  in a system prompt or a tool result, and the useful part is the consequence, not the description. */
const MEANS: Record<PromptSurface, string> = {
    hud: "the Commander HUD, a small corner card on the page itself — they are looking at the page you are working on, and the card has room for one short line at a time",
    overlay: "the sidebar panel open over the page — they are on the page you are working on and can see your whole trace beside it",
    devtools: "the DevTools panel — they have the page's devtools open and are reading your full trace",
    chat: "the chat app in a separate tab — they are reading there and may not be looking at the page you are working on",
    console: "a direct ml.agent() call from a console or a userscript — they are scripting you",
};

/** The chat app on ANOTHER device: a stronger statement than "may not be looking", and the one case where the
 *  person cannot see the page at all however the run behaves. */
const CHAT_REMOTE = "the chat app on another device — they are not at this browser and cannot see the page you are working on";

/**
 * One sentence naming where this prompt was typed and what that means for how to answer.
 *
 * `null` for an unknown origin, so a caller appends nothing rather than claiming a surface: an older runtime
 * records none, and guessing one would be a confident statement about where a person is sitting.
 */
export function promptSurfaceNote(origin?: PromptOrigin | null): string | null {
    if (!origin?.surface || !(origin.surface in MEANS)) return null;
    const means = origin.surface === "chat" && origin.remote ? CHAT_REMOTE : MEANS[origin.surface];
    return `This instruction was typed in ${means}.`;
}

/**
 * The surface a relayed message names, if it is one a person can type into; anything else is no surface at all. The
 * one reading of a `surface` field that crossed a relay, so the places that read one cannot disagree about what counts.
 * @param s the field as it arrived
 * @returns the surface, or undefined
 */
export function promptSurfaceOf(s: unknown): PromptSurface | undefined {
    return s === "hud" || s === "overlay" || s === "devtools" || s === "chat" ? s : undefined;
}

/** The provenance clause for a run's system prompt. Replaces the HUD-only hint: every surface gets one, and the
 *  console case says so too, because "how do I invoke you?" deserves the answer they are living in. */
export function promptSurfaceClause(origin?: PromptOrigin | null): string {
    const note = promptSurfaceNote(origin);
    return note ? `\n\n${note} The window.ml console API is open to them whichever way they started you.` : "";
}
