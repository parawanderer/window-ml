// format.ts — HOW THE APP WORDS A SESSION: its status in a list, when it last moved, and how the list groups it. The
// words are the chat page's (src/chat/chat-app.tsx `STATUS_LABEL`, `DOT`), so the phone and the page never disagree.

import type { RuntimeInfo, SessionStatus, SessionSummary } from "../../src/session-host";

/** What each status says in a list, where the dot alone would not tell a waiting run from a working one. */
export const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
    waiting: "waiting on you", capped: "stopped at its step cap", cancelled: "cancelled", interrupted: "interrupted", error: "failed",
};

/** A status as a tone: working, finished, or stopped short. */
export const STATUS_TONE: Record<SessionStatus, "busy" | "ok" | "err"> = {
    running: "busy", waiting: "busy", done: "ok", capped: "err", error: "err", cancelled: "err", interrupted: "err",
};

/** "now", "5m", "3h", "Tue", "12 Sep": when something last moved, as short as a list row can hold. */
export function ago(ts: number, now = Date.now()): string {
    const s = Math.max(0, (now - ts) / 1000);
    if (s < 45) return "now";
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86_400) return `${Math.round(s / 3600)}h`;
    const d = new Date(ts);
    if (s < 6 * 86_400) return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** How far back the list reaches; a session running or waiting on you is recent however old it is. */
const RECENT_MS = 30 * 86_400_000;

/** Where a runtime sits in the list: those you can drive, then those you only watch, then those offline. */
function rank(r: RuntimeInfo): number {
    if (!r.online) return 2;
    return r.grants.some((g) => g.scope !== "view") ? 0 : 1;
}

/** One runtime's section of the list: the runtime, and its recent sessions newest first. */
export interface Section { runtime: RuntimeInfo; data: SessionSummary[]; older: number }

/** Group the index by runtime (drivable, then watched, then offline), each newest first and cut to the recent month. */
export function sections(runtimes: RuntimeInfo[], sessions: SessionSummary[], now = Date.now()): Section[] {
    const by = new Map<string, SessionSummary[]>();
    for (const s of sessions) (by.get(s.id.runtime) ?? by.set(s.id.runtime, []).get(s.id.runtime)!).push(s);
    return [...runtimes]
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
        .map((runtime) => {
            const all = (by.get(runtime.id) ?? []).sort((a, b) => b.lastTs - a.lastTs);
            const recent = all.filter((s) => s.status === "running" || s.status === "waiting" || now - s.lastTs < RECENT_MS);
            return { runtime, data: recent, older: all.length - recent.length };
        });
}
