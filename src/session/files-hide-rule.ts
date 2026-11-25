// files-hide-rule.ts — the `/files` reader's hide rule in the offscreen document: the worker's resolved list for a session, asked for and kept briefly.

import { resolveHidden, type HideEntry } from "../files-hide";
import type { HideRule } from "./ranged-reader";

/** How long one session's list is reused before it is asked for again: the backstop when a change's signal is missed. */
export const HIDE_LIST_TTL_MS = 1_000;

/**
 * A hide rule over the worker's list (POLICIES.md, "Hiding files"). Each session's list is asked for once and reused for
 * {@link HIDE_LIST_TTL_MS}, or until `forget` (the worker's FILES_HIDE_CHANGED). A list that cannot be had rejects, so the
 * reader hides the path (ranged-reader.ts, `HideRule`); a failed ask is not kept, and the next read asks again.
 * @param ask the session's entries, or null when the worker cannot read its policies
 * @param now the clock, for tests
 */
export function makeHideRule(ask: (session: string) => Promise<HideEntry[] | null>, now: () => number = Date.now): { rule: HideRule; forget(): void } {
    const lists = new Map<string, { at: number; entries: Promise<HideEntry[]> }>();   // state: cache — the worker's list, refetched after the TTL or a change
    const listOf = (session: string): Promise<HideEntry[]> => {
        const had = lists.get(session);
        if (had && now() - had.at < HIDE_LIST_TTL_MS) return had.entries;
        const entries = ask(session).then((e) => { if (!Array.isArray(e)) throw new Error("the hiding rules could not be read"); return e; });
        entries.catch(() => { if (lists.get(session)?.entries === entries) lists.delete(session); });
        lists.set(session, { at: now(), entries });
        return entries;
    };
    return {
        // The reader's paths are relative to the volume (`attached/h1/.env`); the rules are written as `/files/...`.
        rule: async (session, path) => resolveHidden(path === "" ? "/files" : `/files/${path}`, await listOf(session)).hidden,
        forget: () => lists.clear(),
    };
}
