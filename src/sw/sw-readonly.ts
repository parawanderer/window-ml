// sw-readonly.ts — evaluating a read-only `exec` survey in the SERVICE WORKER, where the run's own context
// (`ml.current`, `@tool:` pointers) can be read without it ever entering the page.
//
// A delegated `exec` used to be evaluated in the page's main world, so anything it read about the run — another
// origin's content, the system prompt, a credentialed fetch's body — landed in a realm a hostile page controls, and a
// read-only survey AUTO-APPROVES, so a prompt-injected one would hand it over with no human asked. The fix is two
// realms with DISJOINT capabilities (docs/spec/CURRENT_CONTEXT.md, docs/spec/SITE_ACCESS.md slice 2):
//
//   worker: the run's context, and no page. Reaching for the page (`document`, `ml.queryAll`, `ml.answer`, …) raises
//           NeedsPage, and nothing is left behind.
//   page:   the DOM, and no run context.
//
// The host tries the worker FIRST and delegates to the page only on NeedsPage. A survey needing both trips here and is
// refused there, so it reaches the human whatever order it touches things in, and no lexical guess about the script
// decides anything: an alias (`const m = ml; m.current`) cannot add a capability a realm does not have.
//
// Not wired in this change: the call site is the host's `tryReadonly` (sw-run-host.ts), which the site-access work
// owns and wires in its slice 2.

import { evalReadonly, NeedsPage, NotInDialect, Denied } from "../readonly-exec";
import { expandPointers, execCodeIn } from "../pointer-macro";
import { formatReadonlyExec } from "../approval";
import { descriptorFor } from "../render-descriptor";
import { outputCapEscalated } from "../contract/contract-pointers";
import { errText } from "../dom";
import type { CurrentSnapshot } from "../current-context";
import type { MlTool } from "../contract/contract-agent";
import type { RenderDescriptor } from "../contract/contract-render";

/** What the worker holds for one run, handed in by the host so this module stays testable without one. */
export interface WorkerReadonlyDeps {
    /** The run's context at this instant (the loop's `contextSink`). Called only when the script mentions `current`,
     *  so a survey that never reads it copies nothing. */
    current?: () => CurrentSnapshot;
    /** The read-only `ml` members the worker can answer (`config`, `models`, `ps`, `info`, `pipe`, …). A member it
     *  does not carry defers the survey to the page rather than failing it. That includes `dereference` until the
     *  host gives it one: pointer reads in the worker are the site-access slice 2's, and until then a survey naming
     *  `@tool:` goes to the page exactly as it did before. */
    ml?: Record<string, unknown>;
    /** The run's `exec` tool, whose `render` draws the step's In. Absent: the same code view the page's `exec` draws
     *  (`execCodeIn`), so a step answered here looks like one answered there. */
    tool?: MlTool;
}

/** The outcome. `answered`: auto-approved, with the result the page path would have produced. `needs-page`: delegate
 *  it to the page as before. `refused`: out of dialect, so it goes to the human gate. */
export type WorkerReadonlyOutcome =
    | { kind: "answered"; result: string; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor }
    | { kind: "needs-page" }
    | { kind: "refused" };

/** Evaluate one `exec` call's script in the worker. */
export async function evalReadonlyInWorker(args: Record<string, unknown>, deps: WorkerReadonlyDeps): Promise<WorkerReadonlyOutcome> {
    if (typeof args.js !== "string") return { kind: "refused" };
    const codeIn = execCodeIn(args.js);
    // A raised output cap is a request the human has to grant, wherever the script would run.
    if (outputCapEscalated("exec", args)) return { kind: "refused" };
    // `@tool:` is not JavaScript, so the macro expands it to `ml.dereference(…)` before the tokenizer sees it. Without a
    // `dereference` on the worker's `ml` that read defers to the page, as it did before this module existed.
    const { code } = expandPointers(args.js);
    // The snapshot is a copy of the whole context, so it is made only for a script that says `current`. A cost
    // decision, never a security one: a script that reaches `current` without the word (a computed key) finds no
    // such member, which in the worker defers to the page, where there is none either, so it reaches the human.
    const current = deps.current && /\bcurrent\b/.test(code) ? deps.current() : undefined;
    try {
        const ro = await evalReadonly(code, null, deps.ml ?? {}, undefined, { realm: "worker", current });
        const { result, render } = formatReadonlyExec(ro.value, ro.logs, ro.prints);
        const { in: renderIn, out: renderOut } = descriptorFor(deps.tool, { result, render, ...(deps.tool ? {} : { renderIn: codeIn }) }, args);
        return { kind: "answered", result, renderIn, renderOut };
    } catch (e) {
        if (e instanceof NeedsPage) return { kind: "needs-page" };
        if (e instanceof NotInDialect || e instanceof Denied) return { kind: "refused" };
        // A runtime error in the script is the model's to fix, reported with its line, exactly as the page path does.
        const at = (e as { mlLine?: number })?.mlLine ?? null;
        const error = `${errText(e)}${at ? ` (line ${at})` : ""}`;
        const { in: renderIn } = descriptorFor(deps.tool, { result: `Error: ${error}`, ...(deps.tool ? {} : { renderIn: codeIn }) }, args);
        return { kind: "answered", result: `Error: ${error}`, renderIn, renderOut: { type: "exec-out", error: errText(e), ...(at ? { errorLine: at } : {}) } };
    }
}
