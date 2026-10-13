// current-client.ts — `ml.current.client`: who sent a user message and what they can do and see from there, read
// from the channel the message came over (docs/spec/CURRENT_CONTEXT.md, "The runtime and the client").

import type { PromptOrigin, PromptSurface } from "../contract/contract-run";
import { SCOPE_NAMES, type Scope } from "../session/session-host";
import { seesPage } from "./prompt-surface";

/** The sender of a user message, as `ml.current.client` and `ml.current.meta[i].client` give it. Nothing here grants
 *  anything: every gate is still decided by the scope the transport checked. */
export interface CurrentClient {
    /** `this browser` for the local port, the panel and the HUD; `hub` for a device that reached this runtime through
     *  the hub, which is somewhere else. */
    via: "this browser" | "hub";
    /** Where the message was typed. */
    surface: PromptSurface;
    /** Whether the sender can see the page the run is working on. */
    seesPage: boolean;
    /** What the sender's channel lets it do, one boolean per scope: `drive` (send, start, cancel), `approve` (answer a
     *  gate), `screen` (take a screenshot), `admin` (manage devices), … Absent when the channel did not say. */
    may?: { [scope in Scope]?: boolean };
    /** What the sender says it can show (`printDoc`, `pairing`, …): the client's own claim, absent from an older one. */
    ui?: string[];
}

/** A name a client may report in `ui`: a short identifier, so nothing longer or stranger (an id, a URL) can ride it. */
const UI_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
/** The most `ui` names kept from one message. */
const UI_MAX = 16;

/**
 * Keep only what a `ui` claim may hold: short identifier names, deduplicated, at most {@link UI_MAX}.
 * @param raw the field as it arrived in a command
 * @returns the names, or undefined when none survive
 */
export function clientUiOf(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const names = [...new Set(raw.filter((n): n is string => typeof n === "string" && UI_NAME.test(n)))].slice(0, UI_MAX);
    return names.length ? names : undefined;
}

/**
 * The client record for a message typed at `origin`, by one rule: `via` from `remote`, `seesPage` from the function
 * the prose note uses, `may` from the channel's scopes (every scope for this browser), `ui` as the client claimed it.
 * @param origin where the message came from, as the channel recorded it
 * @returns the record, or null for an unknown origin (history, an older runtime), never a guess
 */
export function clientOf(origin: PromptOrigin | null | undefined): CurrentClient | null {
    if (!origin?.surface) return null;
    const hub = origin.surface === "chat" && !!origin.remote;
    const granted = hub ? origin.scopes : SCOPE_NAMES;
    const ui = clientUiOf(origin.ui);
    return {
        via: hub ? "hub" : "this browser",
        surface: origin.surface,
        seesPage: seesPage(origin),
        ...(granted ? { may: Object.fromEntries(SCOPE_NAMES.map((s) => [s, granted.includes(s)])) } : {}),
        ...(ui ? { ui } : {}),
    };
}
