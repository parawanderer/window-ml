// stream-sender.ts — the PRODUCER's side of live tool output: merges a tool's stream into one post per beat, and never
// sends more than the panel can show.

import { UI_OUT_CAP } from "../contract/contract-chat";

/** How often a sender posts: the stream fan's own cadence (agent-loop.ts), so merging here costs no liveness there. */
export const SEND_EVERY_MS = 90;

/** One post: the text, when its first part was produced, and how many characters were left out just BEFORE it. */
export type SendChunk = (text: string, ts: number, skipped: number) => void;

/**
 * Wrap a post channel so a tool's live output crosses it in bounded posts. A tool streams a line at a time, and on the
 * background-hosted path every post is a message copied across three hops (page, content script, service worker), so a
 * survey printing 200 lines of 9 MB each was 1.8 GB of messages for a panel that keeps 12,000 characters.
 *
 * Text is held and posted at most once per {@link SEND_EVERY_MS}, the first post at once. The first `cap` characters of
 * the whole stream are always forwarded whole (the panel keeps the start); past them, a post carries at most the
 * LATEST `cap` characters and counts the rest as `skipped`, which the receiving fan adds to what it dropped. `flush`
 * posts what is held; call it before the tool's result, so the last lines arrive before the step lands.
 */
export function makeStreamSender(post: SendChunk, cap: number = UI_OUT_CAP): { push(text: string, ts?: number): void; flush(): void } {
    let sent = 0;            // characters of the stream accounted for (posted or skipped)
    let held = "", heldTs = 0, skipped = 0, last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!held && !skipped) return;
        const text = held, ts = heldTs, gap = skipped;
        held = ""; skipped = 0; last = Date.now();
        sent += gap + text.length;
        post(text, ts, gap);
    };
    return {
        push(text: string, ts?: number): void {
            const s = String(text ?? "");
            if (!s) return;
            if (!held) heldTs = ts ?? Date.now();
            held += s;
            // Bound what is held: the part still inside the stream's first `cap` characters goes out whole, now; past
            // it, only the latest `cap` characters are worth sending.
            const protectedLeft = Math.max(0, cap - (sent + skipped));
            if (held.length > protectedLeft + cap) {
                if (protectedLeft > 0) {
                    const head = held.slice(0, protectedLeft);
                    held = held.slice(protectedLeft);
                    const rest = held, restTs = heldTs;
                    held = head; flush();
                    held = rest; heldTs = restTs;
                }
                if (held.length > cap) { skipped += held.length - cap; held = held.slice(-cap); }
            }
            if (Date.now() - last >= SEND_EVERY_MS) flush();
            else if (!timer) timer = setTimeout(flush, SEND_EVERY_MS);
        },
        flush,
    };
}
