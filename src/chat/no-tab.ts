// no-tab.ts — what to say of a run that has no tab, and whether this device may bring it to one.

import type { TaskBackground } from "../contract/contract-debug";
import type { Principal, RuntimeInfo, SessionKey, SessionSummary } from "../session/session-host";
import { taskMarkText } from "./task-mark-text";
import { mayCommand } from "./grants";

/**
 * The banner's sentence for a run that has no tab: that it has none, what it still holds in the background, and when a result is read.
 * Null unless the worker said `noTab`. With `opts.composer` (the composer is drawn below the banner) it ends by saying a message
 * sent here starts the run's next turn with no page: that sentence is for a run the worker holds with no tab (#2106), where a message is a turn with no page.
 * @param bg the run's background as the worker last said
 * @param opts `composer`: the composer is drawn under the banner (default false)
 * @returns the sentence, or null for no banner
 */
export function noTabText(bg: TaskBackground | null | undefined, opts: { composer?: boolean } = {}): string | null {
    if (!bg?.noTab) return null;
    let text = "This run has no tab.";
    const held = taskMarkText(bg);
    if (held) text += ` ${held[0].toUpperCase()}${held.slice(1)}.`;
    if (bg.running + bg.waiting > 0) text += " A result is read at its next turn.";
    if (opts.composer) text += " A message sent here starts its next turn, with no page.";
    return text;
}

/**
 * May this device bring a no-tab run to a page: the runtime online, a saved agent run the worker says has no tab, and the grant to resume it?
 * Status is not asked: a run with tasks outstanding is the one that needs a tab.
 * @param rt the runtime holding the session
 * @param key the session's key
 * @param summary the session's summary
 * @param self this device's principal
 */
export function mayBringHere(rt: RuntimeInfo | undefined, key: SessionKey, summary: SessionSummary | undefined, self?: Principal): boolean {
    return !!rt?.online && summary?.kind === "agent" && !!summary.saved && !!summary.background?.noTab && mayCommand(rt, "session.resume", { key, summary }, self);
}
