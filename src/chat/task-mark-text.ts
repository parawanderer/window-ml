// task-mark-text.ts — the words of a run's background-task mark, as one pure function: the HUD card, the chat page's list and the phone's list. In src/chat so the phone's bundler reaches it.

import { backgroundOf, type TaskBackground } from "../contract/contract-debug";

/**
 * What the card says of a run's background tasks: "1 running in background", "2 running · 1 result waiting", "1 result
 * waiting". Null when there is nothing to say (no tasks, or both counts 0: a lone `noTab` or `releaseAt` is not a count, so the card does not draw it).
 * @param bg the run's tasks as the worker last said
 * @returns the mark's text, or null for no mark
 */
export function taskMarkText(bg: Pick<TaskBackground, "running" | "waiting"> | null | undefined): string | null {
    const held = backgroundOf({ running: bg?.running ?? 0, waiting: bg?.waiting ?? 0 });
    if (!held) return null;
    const { running, waiting } = held;
    const parts: string[] = [];
    if (running > 0) parts.push(waiting > 0 ? `${running} running` : `${running} running in background`);
    if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? "result" : "results"} waiting`);
    return parts.length ? parts.join(" · ") : null;
}

/** What the mark's tooltip says: a detached call's result is read by the run at its next turn, not shown as it lands. */
export const TASK_MARK_TIP = "Calls this run started and left running. A finished one's result is read by the run at its next turn.";
