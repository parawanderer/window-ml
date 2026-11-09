// task-tool.ts — the `task` tool: await, cancel or tail one of this run's detached calls (docs/spec/ASYNC_CALLS.md, mode 1).

// The actions on a task are effects on the handle, so they are a tool and never methods on `ml.current.tasks`, which is
// read-only. Only the worker runs it: the run it acts for is the loop's, never anything in the arguments (sw-tasks.ts).

import type { MlTool } from "../contract/contract-agent";
import type { defineTool } from "../ml/ml-tool-factories";

/** What the tool needs of the worker. Absent: the descriptor alone, whose run refuses (only the worker runs it). */
export interface TaskToolDeps {
    /** The action's answer (a tail cut to its ceiling names the stored whole in `textValue`), for the run the worker built this tool for. */
    act(args: Record<string, unknown>): Promise<string | { content: string; textValue: string }>;
}

/**
 * Build `task`.
 * @param define the tool factory
 * @param deps the worker's action; absent for the descriptor a run's assembly lists
 * @returns the tool
 */
export function taskTool(define: typeof defineTool, deps?: TaskToolDeps): MlTool {
    return define({
        name: "task",
        summary: "Await, cancel or tail a call that outran its lease and was detached.",
        description: "Act on a detached call by its task id (ml.current.tasks). await: wait up to timeout_ms (your estimate) for its result; " +
            "if it is still running then, you are told so and it runs on. cancel: stop it; the answer says what happened. " +
            "tail: its latest output lines (a stream past 8 KiB is cut to its end; a pointer reads every line the peek returned). A task ends with this turn; its result also arrives on its own as a [task <id> …] message.",
        parameters: {
            type: "object",
            properties: {
                op: { type: "string", enum: ["await", "cancel", "tail"] },
                id: { type: "string", description: "The task id, e.g. t1a2b3c." },
                timeout_ms: { type: "number", description: "await: how long you expect it still to take." },
                lines: { type: "number", description: "tail: how many lines (default 20)." },
            },
            required: ["op", "id"],
        },
        run: async (args: Record<string, unknown>) => {
            if (!deps) return "Error: task runs only in a run the extension started for you.";
            return deps.act(args);
        },
    });
}
