// sw-files-hide.ts — the worker's half of the hide rule for a session's files: the resolved list the offscreen reader asks for, and the word that it changed.

import { addGlobalPolicy, addRunPolicy, filesHideEntries, globalPolicies, onPoliciesChanged, policiesReady, removeFromSession, runPolicies, sessionPolicies } from "./sw-policies";
import { isOffscreenSender } from "./sw-offscreen";
import { HIDE_ENTRIES_MAX, patternRefusal, type HideEffect, type HideEntry } from "../files-hide";

/**
 * FILES_HIDE_LIST: the offscreen document's `/files` reader asks for one session's hiding rules (POLICIES.md, "Every reader
 * of a root is bound by it"). Answered to the offscreen document only, after every saved policy is read; a store that
 * could not be read answers `{ entries: null }`, which the reader turns into "hidden" for every path.
 * @param message `{ session }`, the session's hash
 * @param sender who sent it
 */
export async function filesHideList(message: unknown, sender: chrome.runtime.MessageSender): Promise<{ entries: HideEntry[] | null }> {
    const session = (message as { session?: unknown } | null)?.session;
    if (!isOffscreenSender(sender) || typeof session !== "string" || !session) return { entries: null };
    await policiesReady;
    return { entries: filesHideEntries(session) ?? null };
}

/** How many listed sessions' rules are kept to compare against; past it the oldest listed is dropped, and a change to
 *  its rules sends no hint until it is listed again. */
export const LISTED_RULES_MAX = 256;

/** Each listed session's resolved hiding rules when its files were last listed, as JSON: what a policy change is compared
 *  against, so only a session whose `hidden` marks can have changed is told (`files-changed`). */
const listedRules = new Map<string, string>();   // state: cache — re-read at every files.list; lost with the worker, as the page's subscription is

const rulesOf = (hash: string): string => JSON.stringify(filesHideEntries(hash) ?? null);

/**
 * Note that a session's files were listed, so a later change to its hiding rules sends it a `files-changed` hint.
 * @param hash the session
 */
export function noteFilesListed(hash: string): void {
    listedRules.delete(hash);
    listedRules.set(hash, rulesOf(hash));
    if (listedRules.size > LISTED_RULES_MAX) listedRules.delete(listedRules.keys().next().value!);
}

/**
 * Whenever a policy changes: tell the offscreen reader to drop the lists it holds, so a new `hide` binds the next read,
 * then hint each listed session whose resolved rules changed (SESSION_CONTRACT.md, `files-changed`). A session rule
 * changes one session's, a global rule every listed session's; a policy of another consumer changes none. No receiver
 * (no offscreen document open) is not an error: the reader asks afresh when it starts.
 * Called once, at the worker's load: the listed sessions' rules are one record, so a second listener would find each
 * change already taken in by the first.
 * @param hint sends one session a `files-changed` with no `dirs`
 * @returns the unsubscribe
 */
export function signalFilesHideChanges(hint: (hash: string) => void = () => {}): () => void {
    return onPoliciesChanged(() => {
        chrome.runtime.sendMessage({ type: "FILES_HIDE_CHANGED" }).catch(() => { /* no reader open */ });
        for (const [hash, was] of listedRules) {
            const now = rulesOf(hash);
            if (now === was) continue;
            listedRules.set(hash, now);
            hint(hash);
        }
    });
}

/**
 * Add one hiding rule, from the `policy.files` command (POLICIES.md, "One command to change it"). A pattern the rule
 * refuses, and a scope already holding {@link HIDE_ENTRIES_MAX} rules, are refused with the reason; the same rule added
 * twice to a session is the one already there. A global rule is the person's (`origin: "person"`), as every global is.
 * @param hash the session the command names
 * @param r the effect, the pattern and the scope
 */
export function addFilesRule(hash: string, r: { effect: HideEffect; source: string; scope: "session" | "global" }): { id: string } | { refused: string } {
    const why = patternRefusal(r.source, r.effect);
    if (why) return { refused: why };
    const held = (r.scope === "global" ? globalPolicies() : runPolicies(hash)).filter((p) => p.consumer === "files");
    const same = held.find((p) => p.effect === r.effect && p.source === r.source);
    if (same) return { id: same.id };
    if (held.length >= HIDE_ENTRIES_MAX) return { refused: `this scope already holds ${HIDE_ENTRIES_MAX} hiding rules` };
    const p = { consumer: "files" as const, effect: r.effect, source: r.source, label: `${r.effect} ${r.source}` };
    return { id: (r.scope === "global" ? addGlobalPolicy(p) : addRunPolicy(hash, { ...p, origin: "person" })).id };
}

/**
 * Remove one hiding rule seen from a session: removing a `show` narrows and is done; removing a `hide` widens and waits for
 * `confirmed`, answering the ids of the rows that would decide instead. A rule that is not a `files` row of this session's
 * view is unknown, so this command cannot remove another consumer's policy.
 * @param hash the session whose view the removal is made from
 * @param id the rule
 * @param confirmed whether the renderer showed a widening removal's effect
 */
export function removeFilesRule(hash: string, id: string, confirmed: boolean): { removed: true } | { removed: false; why: "unknown" | "confirm"; exposes?: string[] } {
    const row = sessionPolicies(hash).rows.find((x) => x.consumer === "files" && x.layer !== "default" && x.entry.id === id);
    if (!row) return { removed: false, why: "unknown" };
    const r = removeFromSession(hash, id, confirmed);
    if (r.removed) return { removed: true };
    return r.why === "confirm" ? { removed: false, why: "confirm", exposes: (r.row?.removal?.exposes ?? []).map((e) => e.id) } : { removed: false, why: "unknown" };
}
