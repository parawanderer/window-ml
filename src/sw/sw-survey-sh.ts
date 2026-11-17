// sw-survey-sh.ts — `ml.sh` for the worker's read-only survey: bound to the step it runs in, and the rule that a script which has started a program is never run again.

// docs/dev/readonly-exec.md, "ml.sh in the worker's survey"; docs/spec/SHELL.md, "Approval". The survey is the worker's FIRST try at an
// exec; what it cannot answer falls through to the page leg or the person, which RUNS THE SCRIPT AGAIN from the top. A script that
// has already started a program must not be: the program would run twice. So the survey keeps a count of the calls it started
// (before the judge or the ask, not after the answer), and `stoppedAfterCalls` turns every exit that would have fallen through into
// the step's final result.

import type { ToolRunResult } from "../agent/agent-loop";
import type { ShAnswer, ShCallContext } from "./sw-shell-call";
import { shRead, shRun } from "./sw-shell-call";
import { forModel } from "./sw-scrub";
import type { WorkerReadonlyOutcome } from "./sw-readonly";

/** One `ml.sh` call a survey started: the program (`argv[0]`, as the script wrote it) and how it went so far. */
export interface SurveyShCall { program: string; outcome: "running" | "ok" | "denied" | "refused" | "aborted" | "error" }

/** The survey's `ml.sh` and the record of the calls it started. */
export interface SurveySh {
    /** Handed to the dialect as `ml.sh`: `run` and `read`, each judged by the sh gate when it is made. */
    host: { run: (...a: unknown[]) => Promise<unknown>; read: (...a: unknown[]) => Promise<unknown> };
    /** The calls started so far, in the order they were started. */
    started: SurveyShCall[];
}

/**
 * Bind `ml.sh` to one step for a survey. Each call is judged when it is made (a policy or the built-in default lets it run, no
 * opinion raises a nested ask on the running step, a deny throws), and a failure throws an error carrying the wire's `code`.
 * @param ctx the step, as the worker knows it
 * @param via the two calls, the worker's own unless a test stands in
 * @returns the host object for the dialect and the record of what it started
 */
export function surveySh(ctx: ShCallContext, via: { run: typeof shRun; read: typeof shRead } = { run: shRun, read: shRead }): SurveySh {
    const started: SurveyShCall[] = [];
    const call = (member: "run" | "read", via: (c: ShCallContext, a: readonly unknown[]) => Promise<ShAnswer>) => async (...a: unknown[]): Promise<unknown> => {
        // Counted BEFORE the judge: a call waiting on the person's answer already blocks the re-run.
        const first = Array.isArray(a[0]) ? a[0][0] : a[0];
        const rec: SurveyShCall = { program: member === "run" && typeof first === "string" ? first : member, outcome: "running" };
        started.push(rec);
        let r: ShAnswer;
        try { r = await via(ctx, a); } catch (e) { rec.outcome = ctx.signal.aborted ? "aborted" : "error"; throw e; }
        if ("ok" in r) { rec.outcome = "ok"; return r.ok; }
        rec.outcome = ctx.signal.aborted ? "aborted" : r.code === "Denied" ? "denied" : r.code === "Refused" ? "refused" : "error";
        // The text goes back to the model through the script's result: scrubbed as every error the model reads is.
        const err = new Error((await forModel(r.error)).text) as Error & { code?: string; task?: string };
        err.code = r.code;
        if ("task" in r) err.task = r.task;
        throw err;
    };
    return { host: { run: call("run", via.run), read: call("read", via.read) }, started };
}

/**
 * The step's final result for a survey that started program calls and then reached something outside the worker's dialect.
 * Names each call by program and outcome only: no output, which has not been through the bounds a result goes through.
 * @param started the calls the survey started
 * @param why what it reached: `needs-page`, `refused` or `threw`
 * @returns the error result, with no render descriptors of its own (the caller adds the code it renders)
 */
export function stoppedAfterCalls(started: readonly SurveyShCall[], why: "needs-page" | "refused" | "threw"): ToolRunResult {
    const n = started.length;
    const list = started.map((c) => `${c.program.split("/").pop() || c.program}: ${c.outcome}`).join("; ");
    const where = why === "needs-page" ? "reached for the page" : why === "refused" ? "reached something outside the worker's dialect" : "failed outside the script's own code";
    return { result: `Error: this script started ${n} ml.sh call${n === 1 ? "" : "s"} (${list}) and then ${where}. It was stopped there and NOT run again, because running it again would make those calls twice. Put the page work in its own exec.` };
}

/** What {@link guardSurvey} answers when the survey started a program and then could not finish in the worker. */
export interface SurveyStopped { kind: "stopped"; why: "needs-page" | "refused" | "threw"; result: ToolRunResult }

/**
 * Run one survey and turn every exit that would send the script on to another leg (the page, the person's approval, an isolated
 * world: each RUNS IT AGAIN) into the step's final result, once it has started an `ml.sh` call. A survey that started none keeps the
 * fall-through, which is safe because nothing ran. An answered survey, including one whose script threw its own error, is final already.
 * @param sh the survey's `ml.sh`, or undefined when the script names none
 * @param survey the evaluation
 * @returns its outcome, or the stop
 */
export async function guardSurvey(sh: SurveySh | undefined, survey: () => Promise<WorkerReadonlyOutcome>): Promise<WorkerReadonlyOutcome | SurveyStopped> {
    let w: WorkerReadonlyOutcome;
    try { w = await survey(); } catch (e) {
        if (!sh?.started.length) throw e;
        return { kind: "stopped", why: "threw", result: stoppedAfterCalls(sh.started, "threw") };
    }
    if (!sh?.started.length || w.kind === "answered") return w;
    const why = w.kind === "needs-page" ? "needs-page" : "refused";
    return { kind: "stopped", why, result: stoppedAfterCalls(sh.started, why) };
}
