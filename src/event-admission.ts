// event-admission.ts — which session events a page may add to a session the worker also speaks for.

/** What a receiver knows about the session a page's event names: the worker has not spoken for it (`none`), it hosts
 *  a run the page built (`hosts`), or it built the run or emits its whole lifecycle itself (`owns`). */
export type WorkerClaim = "none" | "hosts" | "owns";

/** The events the page side of a page-built run emits itself while the worker hosts the loop: the start, a follow-up
 *  the page's handle sends, and the result it assembles from the page's own run record. Every other event about such
 *  a run (a step, a gate, a stream, a turn) is produced only by the worker. */
const PAGE_LIFECYCLE: ReadonlySet<string> = new Set(["agent", "agent-say", "agent-result"]);

/**
 * Whether a page-sent event may enter a session. A page that could write into a run the worker hosts could draw a step
 * the run never took, rewrite the call an approval prompt shows, or finish a run that is still waiting
 * (docs/spec/SITE_ACCESS.md, attacks 15 and 16). The shell asks this before an event reaches the card or the sidebar,
 * and the worker before one reaches the session index or a DevTools panel; each answers `claim` from what it saw.
 * @param kind the event's `kind`
 * @param claim what the receiver knows about the worker's part in the session
 * @returns true when the page may add it
 */
export function pageMayWrite(kind: unknown, claim: WorkerClaim): boolean {
    if (claim === "owns") return false;
    if (claim === "hosts") return typeof kind === "string" && PAGE_LIFECYCLE.has(kind);
    return true;
}

/** The session an event belongs to: its `session.hash`, or its `id` for an event that carries no session. */
export function eventSession(ev: unknown): string | undefined {
    const e = ev as { id?: unknown; session?: { hash?: unknown } } | null;
    const h = e?.session?.hash ?? e?.id;
    return typeof h === "string" ? h : undefined;
}
