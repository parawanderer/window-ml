// output-clip.ts — the panel's copy of a tool's long streamed output: the start and the LATEST, with the gap counted.

import { UI_OUT_CAP } from "../contract/contract-chat";

/** The line that replaces what the panel dropped from the middle of a long output. One line of its own, so it never
 *  reads as part of the output around it, and it counts only what is gone: the total is not known while a stream is
 *  still running, and a live note that changed its total on every chunk would differ from the settled one. */
export const gapNote = (dropped: number): string => `\n… [${dropped} chars dropped here] …\n`;

/** How much of the START the panel keeps: the part the model was sent (its cut, `seen`), so what the model read
 *  stays on screen, but never more than half the cap, so the latest output always has the other half. */
export const panelHead = (seen: number | undefined, cap: number = UI_OUT_CAP): number =>
    Math.max(0, Math.min(seen ?? 0, Math.floor(cap / 2)));

/**
 * The kept tail of a long output, from the window of its last characters: starts at the first LINE start inside the
 * window, like a terminal's scrollback, so the panel never opens on half a line. The live stream ends each line with
 * a newline and the settled copy does not, so their windows differ by one character; starting both at a line start is
 * what makes them keep the same lines (the one exception: a line starting exactly on the settled copy's boundary,
 * which the live view, its window one character later, drops). A window with no line start in it (one giant line) is
 * kept from its first character.
 *
 * @param prevNewline whether the character just before the window is a newline, i.e. the window starts a line.
 * @returns the offset inside `win` where the kept tail begins.
 */
export function tailStart(win: string, prevNewline: boolean): number {
    if (prevNewline) return 0;
    const nl = win.indexOf("\n");
    return nl >= 0 && nl + 1 < win.length ? nl + 1 : 0;
}

/**
 * The panel's copy of `text` when it is longer than `cap`: its first `head` characters, a {@link gapNote}, and the
 * latest output from a line start ({@link tailStart}), at most `cap` characters kept in all. Unchanged when it fits.
 * The live stream (agent-loop.ts `makeStreamFan`) builds the same text a chunk at a time, so a step's output keeps
 * its shape when it lands.
 */
export function clipHeadTail(text: string, cap: number = UI_OUT_CAP, head: number = 0): string {
    text = String(text ?? "");
    if (text.length <= cap) return text;
    const h = Math.max(0, Math.min(head, cap));
    const winAt = text.length - (cap - h);
    const win = text.slice(winAt);
    const from = winAt + tailStart(win, text[winAt - 1] === "\n");
    return text.slice(0, h) + gapNote(from - h) + text.slice(from);
}
