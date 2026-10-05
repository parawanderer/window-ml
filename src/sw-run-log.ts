// sw-run-log.ts — the service worker's one execution log (run-log.ts) and its message, DUMP_RUN_LOG: the
// mechanics under a run, read by the chat page's Execution log panel. Kept out of background.ts, which routes.
//
// EXTENSION PAGES ONLY. A page may report into the housekeeping log and read it back, because nothing there
// identifies anyone but the reporter; this ring holds every run's records, and a record's `key` can be another
// tab's URL. Letting the MODEL read its own run's mechanics is a deliberate later step behind its own approval
// (idea-right-dock-run-panels), and the records come first so the surface is shaped around real ones.
import { RunLog, eventsForRun, runsInLog, type RunLogEvent } from "./run-log";
import { sessionArea, senderOrigin } from "./sw-housekeeping";
import type { HousekeepingReport } from "./housekeeping";

/** This worker's one execution log: every run's mechanics in one ring, in storage.session so an evicted worker
 *  does not take a run's history with it (the eviction is itself one of the things worth knowing about). */
export const runLog = new RunLog(sessionArea());

/** Records something the machinery did on one run's behalf, where the caller knows whose run it is. */
export const recordRunLog = (run: string, report: HousekeepingReport): void => runLog.record(run, report);

/** What a DUMP_RUN_LOG answers with: one run's records when a run was named, and what else the ring holds — so
 *  a panel opened on a session with no mechanics of its own can say which runs do. */
export interface RunLogDump {
    events: RunLogEvent[];
    runs: { run: string; count: number; last: number }[];
}

/** DUMP_RUN_LOG: one run's mechanics (or every run's, with no `run`), oldest first. `clear` empties that run's
 *  records, or the whole ring when it is `true` with no run named. */
export async function handleRunLogDump(payload: unknown, sender: chrome.runtime.MessageSender): Promise<{ data?: RunLogDump; error?: string }> {
    if (senderOrigin(sender) === "page") return { error: "Refused: the execution log is for extension pages." };
    const p = (payload || {}) as { run?: unknown; clear?: unknown };
    const run = typeof p.run === "string" && p.run ? p.run : null;
    if (p.clear) await runLog.clear(run ?? undefined);
    const all = await runLog.all();
    return { data: { events: run ? eventsForRun(all, run) : all, runs: runsInLog(all) } };
}
