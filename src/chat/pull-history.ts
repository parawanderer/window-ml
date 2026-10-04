// pull-history.ts — FETCH THE REST OF A SESSION, so something that needs the whole of it has the whole of it.
//
// A transcript is paged: what a client holds is the end of a long session, and `earlier.from` says where that end
// begins. Everything built on top reads what is held — which is right for reading, and wrong for an EXPORT, where a
// file quietly holding the last tenth of a conversation is read as the conversation.
//
// This is a loop over `ChatStore.loadEarlier`, which is the one way a page comes in, so nothing here knows about the
// wire. What it adds is the three things a loop over someone else's history needs: a number to show, a way to stop,
// and a guarantee that it ends.

import type { ChatStore } from "./chat-store";
import type { SessionKey } from "../session-host";

/** How a pull is going: `done` of `total` events, both counted in history positions. */
export interface PullProgress { done: number; total: number }

/** Why a pull stopped, which decides what the caller may claim about what it has. */
export type PullOutcome =
    /** every event the runtime still has is held: an export from here is the whole session */
    | { kind: "complete" }
    /** the reader asked it to stop; what is held is a prefix of the end, and honest only if it says so */
    | { kind: "cancelled"; done: number; total: number }
    /** the runtime stopped answering, or stopped making progress */
    | { kind: "failed"; done: number; total: number; why: string };

/**
 * Page a session back to its first event.
 *
 * `total` is read once, at the start: it is `earlier.from`, the position of the oldest event held, which is exactly
 * how many precede it. That makes the progress DETERMINATE rather than a spinner — the one number a reader wants
 * from a wait is how much of it is left, and this is the rare case where it is knowable up front.
 *
 * IT MUST BE ABLE TO END. A runtime that answers every request with the same page — a bug, a truncated history
 * reported wrongly — would otherwise spin forever on a progress bar that never moves, which is worse than an error
 * because nobody interrupts a bar that looks like it is working. So a page that does not move `from` stops it.
 *
 * IT REDUCES ONCE, NOT PER PAGE. `loadEarlier` normally rebuilds the session from everything held, which is right
 * for the one page a reader asked for (about 12ms at 25,600 events) and quadratic for the six hundred this asks
 * for: a pull of that size spent 5.3 seconds of CPU on replays of a transcript nobody was watching. `defer` fetches
 * without reducing and {@link ChatStore.applyEarlier} does it once. That call is in a `finally`, because a session
 * left deferred shows the tail it had before the pull with the rest fetched and invisible — so every way out of the
 * loop, including the two failures and the cancel, has to pass through it.
 */
export async function pullAllHistory(
    store: ChatStore,
    key: SessionKey,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgress) => void } = {},
): Promise<PullOutcome> {
    const at = () => store.earlier.value.get(key);
    const total = at()?.from ?? 0;
    const done = () => total - (at()?.from ?? 0);
    const report = () => opts.onProgress?.({ done: done(), total });

    report();
    try {
        while (at()?.more) {
            if (opts.signal?.aborted) return { kind: "cancelled", done: done(), total };
            const before = at()?.from ?? 0;
            await store.loadEarlier(key, { defer: true });
            const now = at();
            if (now?.error) return { kind: "failed", done: done(), total, why: now.error };
            // No movement and still claiming more: the runtime is not going to finish this, and a bar that never
            // moves is the one failure a reader will wait out rather than interrupt.
            if ((now?.from ?? 0) >= before && now?.more) {
                return { kind: "failed", done: done(), total, why: "the runtime stopped sending earlier events" };
            }
            report();
        }
        return { kind: "complete" };
    } finally {
        store.applyEarlier(key);
    }
}
