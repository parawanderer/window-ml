// sw-housekeeping.ts — the service worker's one housekeeping log (see housekeeping.ts) and its two messages:
// HOUSEKEEPING_REPORT (another context says what it decided) and DUMP_HOUSEKEEPING (`ml.__housekeeping()`, the
// DevTools panel). Kept out of background.ts, which only routes to it.
import { HousekeepingLog, eventsForReader, type HousekeepingOrigin, type HousekeepingReport, type SessionArea } from "./housekeeping";

/** storage.session when the browser has it; an in-memory stand-in otherwise (a test harness without it), which
 *  still logs but cannot outlive the worker. */
function sessionArea(): SessionArea {
    const real = globalThis.chrome?.storage?.session;
    if (real) return real as unknown as SessionArea;
    const mem: Record<string, unknown> = {};
    return {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in mem).map((k) => [k, mem[k]])),
        set: async (items) => { Object.assign(mem, items); },
    };
}

export const housekeeping = new HousekeepingLog(sessionArea());

/** Records something the worker itself decided. */
export const recordHousekeeping = (report: HousekeepingReport): void => housekeeping.record(report);

/**
 * Who sent a message, from what the BROWSER stamped on it — a page can put anything in a payload but not in
 * `sender`. The offscreen document and our own pages (popup, DevTools panel, the overlay's iframe, which does
 * sit in a tab) have extension URLs; a content script carries its page's.
 */
export function senderOrigin(sender: chrome.runtime.MessageSender): HousekeepingOrigin {
    const base = chrome.runtime.getURL("");
    const url = sender.url || "";
    if (url.startsWith(base)) return url.startsWith(chrome.runtime.getURL("offscreen.html")) ? "offscreen" : "extension";
    return sender.tab ? "page" : "extension";
}

/** HOUSEKEEPING_REPORT: store what another context reported, stamped with who it really was. */
export function handleHousekeepingReport(payload: unknown, sender: chrome.runtime.MessageSender): { data: boolean } {
    const origin = senderOrigin(sender);
    return { data: housekeeping.report(payload, origin, sender.tab?.id) };
}

/** DUMP_HOUSEKEEPING: the log, oldest first, as this sender may see it. Only our own contexts may clear it — a
 *  page erasing the record of what happened to its own values is exactly the case the log is for. */
export async function handleHousekeepingDump(payload: unknown, sender: chrome.runtime.MessageSender): Promise<{ data?: unknown; error?: string }> {
    const origin = senderOrigin(sender);
    const events = await housekeeping.all();
    if ((payload as { clear?: boolean } | undefined)?.clear) {
        if (origin === "page") return { error: "Refused: a page cannot clear the housekeeping log." };
        await housekeeping.clear();
    }
    return { data: eventsForReader(events, origin === "page" ? (sender.tab?.id ?? -1) : null) };
}
