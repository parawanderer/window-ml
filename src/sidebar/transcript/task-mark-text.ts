// task-mark-text.ts — the words of a run's background-task mark on the HUD card, as one pure function.

import type { TaskBackground } from "../../contract";

/**
 * What the card says of a run's background tasks: "1 running in background", "2 running · 1 result waiting", "1 result
 * waiting". Null when there is nothing to say (no tasks, or both counts 0).
 * @param bg the run's tasks as the worker last said
 * @returns the mark's text, or null for no mark
 */
export function taskMarkText(bg: Pick<TaskBackground, "running" | "waiting"> | null | undefined): string | null {
    if (!bg) return null;
    const running = Math.max(0, Math.floor(bg.running) || 0), waiting = Math.max(0, Math.floor(bg.waiting) || 0);
    const parts: string[] = [];
    if (running > 0) parts.push(waiting > 0 ? `${running} running` : `${running} running in background`);
    if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? "result" : "results"} waiting`);
    return parts.length ? parts.join(" · ") : null;
}

/** What the mark's tooltip says: a detached call's result is read by the run at its next turn, not shown as it lands. */
export const TASK_MARK_TIP = "Calls this run started and left running. A finished one's result is read by the run at its next turn.";
