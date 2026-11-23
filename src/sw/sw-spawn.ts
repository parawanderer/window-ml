// sw-spawn.ts — the one way the worker asks the process host to spawn a call: with the session's hiding rules on it.

import { hostTakesHideList, type HostFacts, type HostSpawn } from "../shell/host-protocol";
import { ShRefused } from "../shell/sh-call";
import { hostHideList } from "../files-hide";
import { filesHideEntries, policiesReady } from "./sw-policies";
import type { ShellHost } from "./sw-shell";

/** What a call is refused with when the host is older than the hiding rules and a `hide` would bind it. */
export const HIDE_HOST_TOO_OLD = "The process host does not apply hiding rules, and this session has a hide rule: update the process host in Settings, then run the command again.";

/** What a call is refused with when the saved policies could not be read, so a `hide` may be missing. */
export const HIDE_LIST_UNREAD = "The hiding rules could not be read, so this command was not started: a hidden file could have been read.";

/**
 * The words of each of a session's hiding rules by id (`hide <pattern>`), for the card line of a path a `hide` holds.
 * @param session the session's hash
 */
export function hideRuleWords(session: string): Record<string, string> {
    return Object.fromEntries((filesHideEntries(session) ?? []).map((e) => [e.id, `${e.effect} ${e.source}`]));
}

/**
 * Spawn a call with the session's hiding rules (POLICIES.md, "What the host gets"). Every spawn the worker makes goes
 * through here (tests/spawn-hide-list.test.mjs enumerates them), so no call reaches the host without the list. The rules
 * are read at each call, so a change applies from the next one. A host whose hello says it takes the list gets it in
 * ascending precedence (`hostHideList`); an older host, which would ignore it, is not sent a call while any `hide`
 * applies, and gets the call unchanged when there are only `show` entries, which then hold more, not less. A store that
 * could not be read refuses the call.
 * @param h the connected host
 * @param session the session's hash (the run id policies are stored under); undefined applies the global rules alone
 * @param s the spawn's arguments, without `hideList`
 */
export async function spawnBound(h: ShellHost, session: string | undefined, s: Omit<HostSpawn, "hideList">): Promise<HostFacts> {
    await policiesReady;
    const entries = filesHideEntries(session ?? "");
    if (entries === undefined) throw new ShRefused("Refused", HIDE_LIST_UNREAD);
    const list = hostHideList(entries);
    if (!hostTakesHideList(h.hello)) {
        if (list.some((e) => e.effect === "hide")) throw new ShRefused("Refused", HIDE_HOST_TOO_OLD);
        return h.client.spawn(s);
    }
    return h.client.spawn(list.length ? { ...s, hideList: list } : s);
}
