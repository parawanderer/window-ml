// bring-here.ts — the HUD's "bring a session here": which sessions it offers, and bringing one (MOVE_RUN.md).

import { bgRuns, runControllers, startingControllers } from "./sw-runs";
import { moveRun, type MoveOutcome } from "./move-run";
import { localRuntimeId, runSessionCommand, sessionServer } from "./sw-sessions";
import { THIS_BROWSER } from "../session/session-commands";
import { BRING_HERE_ORDER, originOf, type BringableSession } from "./bring-order";

/**
 * Every agent session of this browser that may be brought to a tab: settled, and either held in memory on another tab
 * or saved. Not one already on this tab, and not one with a turn running or starting.
 * @param tabId the tab the HUD sits in
 * @param tabUrl its URL, as the browser reports it
 * @returns the sessions, in {@link BRING_HERE_ORDER}
 */
export function bringableSessions(tabId: number, tabUrl: string): BringableSession[] {
    const out: BringableSession[] = [];
    for (const s of sessionServer.index.list()) {
        if (s.kind !== "agent" || s.status === "running" || s.status === "waiting") continue;
        const hash = s.id.hash;
        if (runControllers.has(hash) || startingControllers.has(hash)) continue;
        const held = bgRuns.get(hash);
        if (held ? held.tabId === tabId : !s.saved) continue;
        const url = (held ? held.p.pageUrl : undefined) ?? s.page?.url ?? "";
        out.push({ hash, title: s.title || s.task || hash, url, lastTs: s.lastTs, held: !!held });
    }
    return out.sort(BRING_HERE_ORDER(originOf(tabUrl)));
}

/**
 * Bring a session to a tab: a run this worker holds is moved ({@link moveRun}); a saved one is resumed there, as the
 * chat page's `session.resume` does.
 * @param hash the session
 * @param tabId the tab the HUD sits in
 * @returns moved, or why not
 */
export async function bringHere(hash: string, tabId: number): Promise<MoveOutcome> {
    if (bgRuns.has(hash)) return moveRun(hash, tabId);
    const r = await runSessionCommand({ type: "session.resume", session: { runtime: localRuntimeId(), hash }, target: { kind: "tab", tabId } }, THIS_BROWSER);
    return r.ok ? { moved: true } : { refused: r.error.message };
}
