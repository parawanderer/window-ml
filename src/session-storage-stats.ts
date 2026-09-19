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
    /** `toolOutput`, by the tool that produced it: which tool is the bloat */
    byTool: Record<string, number>;
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
    const out = emptyBytes();
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
        if (tool) {
            const name = ev.kind === "agent-step" && typeof (ev as { tool?: unknown }).tool === "string" ? (ev as { tool: string }).tool.slice(0, 64) : "other";
            out.byTool[name] = (out.byTool[name] ?? 0) + tool;
        }
        out.other += Math.max(0, size - images - tool);
    }
    return out;
}

/** Nothing measured yet. */
export function emptyBytes(): SessionBytes {
    return { total: 0, images: 0, imageCount: 0, toolOutput: 0, other: 0, byTool: {} };
}

/** Two measurements added, `byTool` included: a session's running total as its events are written. */
export function addBytes(a: SessionBytes, b: SessionBytes): SessionBytes {
    const byTool = { ...a.byTool };
    for (const [k, v] of Object.entries(b.byTool)) byTool[k] = (byTool[k] ?? 0) + v;
    return { total: a.total + b.total, images: a.images + b.images, imageCount: a.imageCount + b.imageCount, toolOutput: a.toolOutput + b.toolOutput, other: a.other + b.other, byTool };
}

/** Fold per-session measurements into the store's picture. */
export function summarizeStore(rows: readonly ({ hash: string; title?: string; events: number } & SessionBytes)[], seen: ReadonlyMap<string, number>, top = 10): StoreBytes {
    const sum = (k: Exclude<keyof SessionBytes, "byTool">) => rows.reduce((n, r) => n + r[k], 0);
    return {
        byTool: rows.reduce((acc, r) => addBytes({ ...emptyBytes(), byTool: acc }, { ...emptyBytes(), byTool: r.byTool }).byTool, {} as Record<string, number>),
        sessions: rows.length,
        events: rows.reduce((n, r) => n + r.events, 0),
        total: sum("total"), images: sum("images"), imageCount: sum("imageCount"), toolOutput: sum("toolOutput"), other: sum("other"),
        imagesIfDeduplicated: [...seen.values()].reduce((n, b) => n + b, 0),
        top: [...rows].sort((a, b) => b.total - a.total).slice(0, top),
    };
}

/**
 * One day's picture of the store, with no session hashes in it: what the Storage page draws over time. `unmeasured` is
 * bytes written before sessions kept a running breakdown, which shrinks as those sessions age out.
 */
export interface StorageSnapshot extends SessionBytes {
    /** epoch ms */
    t: number;
    sessions: number;
    events: number;
    pinned: number;
    unmeasured: number;
}

/** A snapshot from the store's rows alone: their running breakdowns summed, never a read of the events. */
export function snapshotRows(rows: readonly { bytes: number; count: number; split?: SessionBytes; summary: { pinned?: boolean } }[], t: number): StorageSnapshot {
    let split = emptyBytes(), unmeasured = 0, events = 0, pinned = 0, total = 0;
    for (const r of rows) {
        total += r.bytes;
        events += r.count;
        if (r.summary.pinned) pinned++;
        if (r.split) { split = addBytes(split, r.split); unmeasured += Math.max(0, r.bytes - r.split.total); }
        else unmeasured += r.bytes;
    }
    return { ...split, byTool: topTools(split.byTool), total, t, sessions: rows.length, events, pinned, unmeasured };
}

/** The tools that produced most, the rest folded into one entry: tool names come from outside (MCP, custom tools),
 *  and a snapshot kept for a year must not grow with them. */
export function topTools(byTool: Record<string, number>, keep = 20): Record<string, number> {
    const sorted = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
    const out = Object.fromEntries(sorted.slice(0, keep));
    const rest = sorted.slice(keep).reduce((n, [, v]) => n + v, 0);
    if (rest) out["(other tools)"] = (out["(other tools)"] ?? 0) + rest;
    return out;
}

/** The store as it is now: today's snapshot, the largest sessions, and the history the page draws. */
export interface StorageReport {
    history: StorageSnapshot[];
    now: StorageSnapshot;
    /** the biggest saved sessions, from their rows' sizes */
    largest: { hash: string; title?: string; bytes: number; pinned?: true }[];
    /** the long-term archive, when it is on: its sessions, their original size, and its images stored once */
    archive?: { sessions: number; events: number; bytes: number; images: number; imageBytes: number };
}

/** How many daily snapshots are kept: a year, a few hundred bytes each. */
export const HISTORY_MAX = 366;

/** Add a snapshot to the history when the newest is at least `everyMs` old; bounded to {@link HISTORY_MAX}. */
export function appendSnapshot(history: readonly StorageSnapshot[], next: StorageSnapshot, everyMs: number): StorageSnapshot[] | null {
    const last = history.at(-1);
    if (last && next.t - last.t < everyMs) return null;
    return [...history, next].slice(-HISTORY_MAX);
}
