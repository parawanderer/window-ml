// bring-here.ts — the HUD's "bring a session here": which sessions it offers, and bringing one (MOVE_RUN.md).

import { bgRuns, isWorkerRun, runControllers, runInboxes, runRebuilds, startingControllers } from "./sw-runs";
import { moveRun, type MoveOutcome } from "./move-run";
import { localRuntimeId, runSessionCommand, sessionServer } from "./sw-sessions";
import { THIS_BROWSER } from "../session/session-commands";
import { BRING_HERE_ORDER, originOf, type BringableSession } from "./bring-order";
import { forRowText } from "./sw-scrub";

/**
 * Every agent session of this browser that may be brought to a tab: settled, and either held in memory on another tab
 * or saved. Also one whose turn is RUNNING, when the worker can queue its move (`running: true`, `held: true`): a worker
 * run with a rebuild, on another tab, a turn waiting at a gate included. Not one already on this tab, one starting, or a
 * running page-built run or one with no rebuild (those move only between turns).
 * @param tabId the tab the HUD sits in
 * @param tabUrl its URL, as the browser reports it
 * @returns the sessions, in {@link BRING_HERE_ORDER}
 */
export function bringableSessions(tabId: number, tabUrl: string): BringableSession[] {
    const out: BringableSession[] = [];
    // The row is scrubbed already; a held run's own page URL crosses the same scrub, running or settled.
    const urlOf = (held: { p: { pageUrl?: string } } | undefined, s: { page?: { url?: string } }): string =>
        (held?.p.pageUrl != null ? forRowText(held.p.pageUrl) : s.page?.url) ?? "";
    for (const s of sessionServer.shownList()) {
        if (s.kind !== "agent") continue;
        const hash = s.id.hash;
        if (startingControllers.has(hash)) continue;
        // A turn waiting at a gate is running too: its move waits for the answer and the step's end, as any live move does.
        if (s.status === "running" || s.status === "waiting" || runControllers.has(hash)) {
            if (!isWorkerRun(hash) || !runRebuilds.has(hash)) continue;
            const held = bgRuns.get(hash);
            if ((runInboxes.get(hash)?.tabId ?? held?.tabId) === tabId) continue;
            out.push({ hash, title: s.title || s.task || hash, url: urlOf(held, s), lastTs: s.lastTs, held: true, running: true });
            continue;
        }
        const held = bgRuns.get(hash);
        if (held ? held.tabId === tabId : !s.saved) continue;
        out.push({ hash, title: s.title || s.task || hash, url: urlOf(held, s), lastTs: s.lastTs, held: !!held });
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
