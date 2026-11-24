// task-mark.tsx — the small mark on the HUD card for a run that has background tasks.

import { cursorTipOn } from "../ui-kit";
import { taskMarkText, TASK_MARK_TIP } from "../../chat/task-mark-text";
import type { TaskBackground } from "../../contract";

/**
 * The run's background tasks as one quiet line: how many calls it left running and how many results wait for its next
 * turn. Nothing when it has none.
 * @group card
 * @gallery running only {"background": {"running": 1, "waiting": 0}}
 * @gallery running and waiting {"background": {"running": 2, "waiting": 1}}
 * @gallery result waiting {"background": {"running": 0, "waiting": 1}}
 */
export function TaskMark({ background }: { background?: TaskBackground | null }) {
    const text = taskMarkText(background);
    if (!text) return null;
    return <div class="card-task-mark" {...cursorTipOn(TASK_MARK_TIP)}>{text}</div>;
}
