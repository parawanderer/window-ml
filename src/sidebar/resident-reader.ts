// resident-reader.ts — "is this model loaded on that runtime's box right now?", answered only where it honestly can be.
//
// The answer decides whether a waiting run says "Awakening…" (tens of GiB going into VRAM, the longest wait a run has)
// or "Waiting for the model…". Saying the first when it is not true reads as a hang explained wrongly, so the rule is
// narrow: answer for a runtime whose `/api/ps` this device reads, from a reading young enough to be about NOW, and
// otherwise say NOT KNOWN (`undefined`), which every caller renders as the plainer of the two.
//
// Kept apart from the extension entry that wires it, with its inputs injected, so the freshness rule is tested
// with a fake clock rather than trusted.

import type { RuntimeId } from "../session/session-host";

/** What the reader is built from. Every input is a function, read at the moment of asking. */
export interface ResidentSources {
    /** Is this a runtime whose box this device can read? */
    mine(runtime: RuntimeId): boolean;
    /** Ask for a new reading. Fire and forget: its answer lands in `readAt`/`resident` later. */
    read(): void;
    /** When the last SUCCESSFUL reading arrived, or null when none has. */
    readAt(): number | null;
    /** Did the last attempt fail? A failure is not news that nothing is loaded. */
    failed(): boolean;
    /** The answer from the reading in hand: true, false, or undefined when it cannot say. */
    resident(model: string): boolean | undefined;
    now?(): number;
}

/** A reading older than this is not trusted to say what is loaded now. */
export const RESIDENT_FRESH_MS = 15_000;
/** How often asking may trigger a new reading. */
export const RESIDENT_ASK_MS = 5_000;

/**
 * Build the `modelResident(runtime, model)` answer. Asking also asks for a fresh reading, at most every
 * {@link RESIDENT_ASK_MS}, so a run someone is watching keeps one current with no resource panel open; the answer
 * that reading brings arrives on the asker's next tick.
 */
export function residentReader(src: ResidentSources): (runtime: RuntimeId, model?: string | null) => boolean | undefined {
    let askedAt = -Infinity;
    const now = src.now ?? Date.now;
    return (runtime, model) => {
        if (!model || !src.mine(runtime)) return undefined;
        const t = now();
        if (t - askedAt >= RESIDENT_ASK_MS) { askedAt = t; src.read(); }
        const at = src.readAt();
        if (at == null || t - at > RESIDENT_FRESH_MS || src.failed()) return undefined;
        return src.resident(model);
    };
}
