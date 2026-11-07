// task-line.tsx — a detached call's result as the calm surfaces draw it: one quiet line in the run's flow, which opens to
// the exact text the model got (docs/spec/ASYNC_CALLS.md, mode 1).

import { Disclosure } from "../disclosure";

/** How a task ended, as `agent-task-say` carries it. */
export interface TaskEndView { status: string; ms: number; code: number | null }

/** The line's words: a mark, the task, how it ended, how long it ran, and the exit code when there is one. */
export function taskLineText(task: string, end?: TaskEndView): string {
    if (!end) return `task ${task} finished`;
    const mark = end.status === "done" ? "✓" : end.status === "failed" ? "✗" : "–";
    const verb = end.status === "done" ? "finished" : end.status;
    // Under a second reads "<1 s", never "0 s": a task that detached with a small expectMs can end that soon.
    return [`${mark} task ${task} ${verb}`, end.ms < 1000 ? "<1 s" : `${Math.round(end.ms / 1000)} s`, ...(end.code !== null ? [`exit ${end.code}`] : [])].join(" · ");
}

/** A DETACHED CALL'S RESULT on the calm surfaces (the chat page's calm view, the HUD card): one quiet line in the style
 *  of the worker's notes, never a bubble on the person's side, with no Copy or Edit. It opens to the exact text the run
 *  inbox gave the model. The dev view draws the labelled `UserBubble` instead; CSS hides one of the two (`.task-line`,
 *  sidebar.css).
 *  @group sidebar/transcript
 *  @gallery done {"task": "t1a2b3c", "text": "[task t1a2b3c done after 47 s: ml.sh exit 0, ok; stdout empty; stderr empty]", "end": {"status": "done", "ms": 47000, "code": 0}}
 *  @gallery failed {"task": "t9f8e7d", "text": "[task t9f8e7d failed after 3 s: Failed: ml.sh: the host went away]", "end": {"status": "failed", "ms": 3000, "code": null}}
 *  @gallery cancelled {"task": "t4c5d6e", "text": "[task t4c5d6e cancelled after 12 s: ml.sh exit SIGTERM, not ok; stdout empty; stderr empty]", "end": {"status": "cancelled", "ms": 12000, "code": null}} */
export function TaskResultLine({ task, text, end }: { task: string; text: string; end?: TaskEndView }) {
    return (
        <div class="arun-note task-line" data-task={task}>
            <Disclosure label={taskLineText(task, end)}>
                <pre class="task-line-raw">{text}</pre>
            </Disclosure>
        </div>
    );
}
