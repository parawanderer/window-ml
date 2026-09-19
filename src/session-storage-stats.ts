// session-storage-stats.ts — where the bytes of the saved-session store go: images, tool output, and everything else,
// per session and in total. A MEASUREMENT, taken before deciding how to make room (docs/spec/CHAT_PAGE.md, the
// storage asks): content-hashed images and compression are each worth building only if the numbers say so.
//
// Pure over events, so it is tested without a database. Sizes are serialized lengths, the same measure the store
// budgets with (`sizeOf`), so the split adds up to what the budget sees.
import type { MlDebugEvent } from "./contract-debug";

/** Where one session's bytes go. */
export interface SessionBytes {
    /** everything, as the store's budget counts it */
    total: number;
    /** `data:image/*` strings, wherever they sit in an event */
    images: number;
    imageCount: number;
    /** what an agent step's tool produced (its result and live output), images excluded */
    toolOutput: number;
    /** the rest: prompts, answers, arguments, envelopes */
    other: number;
}

/** The whole store, and the sessions that cost most. */
export interface StoreBytes extends SessionBytes {
    sessions: number;
    events: number;
    /** image bytes if each distinct image were stored once, keyed by its content */
    imagesIfDeduplicated: number;
    /** the largest sessions, biggest first */
    top: ({ hash: string; title?: string; events: number } & SessionBytes)[];
}

const TOOL_KEYS = new Set(["result", "streamOutput", "output"]);

/** A cheap identity for an image: equal images give equal keys, and a collision needs equal length AND both ends. */
const fingerprint = (s: string): string => `${s.length}:${s.slice(22, 86)}:${s.slice(-64)}`;

/** Measure one session's events. `seen` collects image fingerprints across sessions, for the dedupe estimate. */
export function measureEvents(events: readonly MlDebugEvent[], seen?: Map<string, number>): SessionBytes {
    const out: SessionBytes = { total: 0, images: 0, imageCount: 0, toolOutput: 0, other: 0 };
    for (const ev of events) {
        let size: number;
        try { size = JSON.stringify(ev).length; } catch { size = 1024; }
        out.total += size;
        let images = 0, tool = 0;
        const walk = (v: unknown, inTool: boolean, depth: number): void => {
            if (depth > 12 || v == null) return;
            if (typeof v === "string") {
                if (v.startsWith("data:image/")) {
                    images += v.length;
                    out.imageCount++;
                    seen?.set(fingerprint(v), v.length);
                } else if (inTool) tool += v.length;
                return;
            }
            if (typeof v !== "object") return;
            if (Array.isArray(v)) { for (const x of v) walk(x, inTool, depth + 1); return; }
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, inTool || (ev.kind === "agent-step" && depth === 0 && TOOL_KEYS.has(k)), depth + 1);
        };
        walk(ev, false, 0);
        out.images += images;
        out.toolOutput += tool;
        out.other += Math.max(0, size - images - tool);
    }
    return out;
}

/** Fold per-session measurements into the store's picture. */
export function summarizeStore(rows: readonly ({ hash: string; title?: string; events: number } & SessionBytes)[], seen: ReadonlyMap<string, number>, top = 10): StoreBytes {
    const sum = (k: keyof SessionBytes) => rows.reduce((n, r) => n + r[k], 0);
    return {
        sessions: rows.length,
        events: rows.reduce((n, r) => n + r.events, 0),
        total: sum("total"), images: sum("images"), imageCount: sum("imageCount"), toolOutput: sum("toolOutput"), other: sum("other"),
        imagesIfDeduplicated: [...seen.values()].reduce((n, b) => n + b, 0),
        top: [...rows].sort((a, b) => b.total - a.total).slice(0, top),
    };
}
