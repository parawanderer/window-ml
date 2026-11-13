// bring-order.ts — the order the HUD's "bring a session here" lists sessions in, apart so it is tested without a worker.

/** A session the HUD offers to bring to its tab. */
export interface BringableSession {
    hash: string;
    /** its title, else its task */
    title: string;
    /** the page it is on now */
    url: string;
    lastTs: number;
    /** true when this worker holds it in memory (a move); false for a saved session (a resume) */
    held: boolean;
}

/** The order the HUD lists sessions in: this tab's site first, then the most recent (Shane, 2026-11-12). */
export const BRING_HERE_ORDER = (site: string) => (a: BringableSession, b: BringableSession): number => Number(originOf(b.url) === site) - Number(originOf(a.url) === site) || b.lastTs - a.lastTs;

/**
 * A URL's origin.
 * @param url the URL
 * @returns its origin, or "" for one that does not parse
 */
export function originOf(url: string): string {
    try { return new URL(url).origin; } catch { return ""; }
}
