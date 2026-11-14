// py-held-results.ts — the offscreen document's last few leased-cell results, kept for a service worker started since (PY_RESULT).

/** The most results of leased cells kept for a service worker that comes back for them, and for how long. */
export const HELD_RESULTS_MAX = 8, HELD_RESULT_MS = 10 * 60_000;

/** A leased cell's result, kept so a service worker started since it was sent can fetch it (`PY_RESULT`): the last few,
 *  dropped after ten minutes, forgotten once handed over. The oldest goes first. */
const heldResults = new Map<string, { at: number; result: unknown }>();   // state: plumbing — bounded by HELD_RESULTS_MAX and HELD_RESULT_MS

/** Keep a leased cell's result. */
export function holdResult(cell: string, result: unknown): void {
    pruneResults();
    heldResults.delete(cell);
    heldResults.set(cell, { at: Date.now(), result });
    while (heldResults.size > HELD_RESULTS_MAX) heldResults.delete(heldResults.keys().next().value!);
}

/** Drop what is older than HELD_RESULT_MS. */
function pruneResults(): void {
    const now = Date.now();
    for (const [k, v] of heldResults) if (now - v.at > HELD_RESULT_MS) heldResults.delete(k);
}

/** A held result, once: null when there is none (never held, handed over already, or too old). */
export function takeResult(cell: string): unknown {
    pruneResults();
    const h = heldResults.get(cell);
    if (!h) return null;
    heldResults.delete(cell);
    return h.result;
}
