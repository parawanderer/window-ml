// worker-answer.ts — the curated answer of a run the worker built, held by the worker so the page never holds its text.

// The answer the model curates (the `answer` tool, `ml.answer`) is what the person is handed, and its text is the
// model's: written from whatever the run read, another site included. Held in the page's realm, any script on the page
// could read it (docs/spec/SITE_ACCESS.md, slice 2 part 2). So for a run the worker built, the set lives here: the
// `answer` tool runs in the worker, asking the page only to resolve a selector; an approved exec in the page is given
// the set's SHAPE (`AnswerLog`, answer-set.ts) and reports what it changed, which is replayed here; the turn's answer is
// assembled here. Kept in session storage beside the worker's memory, so an eviction mid-turn does not lose it.

import type { AnswerMedia, MlTool } from "../contract";
import { AnswerSet, answerCall, answerShape, replayAnswerOps, type AnswerArgs, type AnswerItem, type AnswerSelection, type AnswerShapeItem } from "../pointers/answer-set";
import { defineState } from "../state-registry";

/** A run's set in memory; the stored copy is what survives an eviction. */
const sets = new Map<string, AnswerSet>();   // see the defineState below
const KEY = (runId: string): string => `ml_answer:${runId}`;

defineState({
    id: "run.answer", scope: "run", realm: "worker", audience: "model", lostOn: ["turn-end"],
    describe: "What the run will hand you as its result (`ml.answer`): elements, text and `@tool:` values, in order. Held by the worker for a run it built; cleared when a turn starts.",
    read: ({ runId }) => (runId ? sets.get(runId)?.dump() : undefined),
});

/** How a run's worker tools ask its page to resolve a selector, set by the run's host when the run is hosted (sw-run-host.ts). */
const selectors = new Map<string, (args: AnswerArgs) => Promise<AnswerSelection & { error?: string }>>();   // state: plumbing — re-set by the host each turn

/** Let a run's `answer` tool ask its page for a selector's elements. */
export function setAnswerSelector(runId: string, fn: (args: AnswerArgs) => Promise<AnswerSelection & { error?: string }>): void { selectors.set(runId, fn); }

/** The run's set: in memory, else restored from session storage (after an eviction), else a new one. */
export async function answerFor(runId: string): Promise<AnswerSet> {
    let set = sets.get(runId);
    if (set) return set;
    set = new AnswerSet();
    try {
        const got = await chrome.storage.session.get(KEY(runId));
        const items = got?.[KEY(runId)];
        if (Array.isArray(items)) for (const it of items as AnswerItem[]) set.items.push(it.kind === "element" ? { ...it, nodes: [] } : it);
    } catch { /* no storage: starts empty */ }
    if (!sets.has(runId)) sets.set(runId, set);
    return sets.get(runId)!;
}

/** Store the run's set as it is now (elements without their nodes, which never left the page). */
async function save(runId: string, set: AnswerSet): Promise<void> {
    try { await chrome.storage.session.set({ [KEY(runId)]: set.items.map((it) => (it.kind === "element" ? { ...it, nodes: [] } : it)) }); } catch { /* best effort: memory still holds it */ }
}

/** Start the run's set empty, at the start of a turn: the answer is each turn's own. In memory at once (so nothing
 *  later in the turn reads a stored set from before it); the stored copy follows, and later saves are written after it. */
export function resetAnswer(runId: string): void {
    const set = new AnswerSet();
    sets.set(runId, set);
    void save(runId, set);
}

/** The most crops the page's own resolution makes (injected.ts `captureAnswer`), and the longest one we keep. */
const MAX_MEDIA = 6, MAX_IMAGE = 4_000_000;

/**
 * What the page answered for a selector, as its own resolution could have made it: a whole count, a preview of the
 * size it builds, and at most six crops, each an image data URL (or none, when its capture failed), rebuilt field by
 * field. The page may still lie about its DOM, as it can by changing the DOM; it cannot make the answer larger or
 * point the HUD card at a remote image.
 * @returns the selection, or null when any part is malformed
 */
export function checkSelection(got: unknown): AnswerSelection | null {
    const g = got as { count?: unknown; preview?: unknown; media?: unknown } | null;
    if (!g || typeof g !== "object" || !Number.isSafeInteger(g.count) || (g.count as number) < 0) return null;
    if (g.preview !== undefined && typeof g.preview !== "string") return null;
    if (g.media !== undefined && (!Array.isArray(g.media) || g.media.length > MAX_MEDIA)) return null;
    const media: AnswerMedia[] = [];
    for (const m of (g.media as unknown[] | undefined) ?? []) {
        const x = m as Record<string, unknown> | null;
        if (!x || typeof x.image !== "string" || x.image.length > MAX_IMAGE || (x.image && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(x.image))) return null;
        if (x.selector !== undefined && (typeof x.selector !== "string" || x.selector.length > 1_000)) return null;
        if (x.kind !== undefined && x.kind !== "image" && x.kind !== "element") return null;
        if (x.mode !== undefined && x.mode !== "inline" && x.mode !== "highlight") return null;
        media.push({ image: x.image, ...(x.selector ? { selector: x.selector as string } : {}), ...(x.kind ? { kind: x.kind as AnswerMedia["kind"] } : {}), ...(x.mode ? { mode: x.mode as AnswerMedia["mode"] } : {}) });
    }
    return { count: g.count as number, ...(typeof g.preview === "string" ? { preview: g.preview.slice(0, 1_000) } : {}), ...(media.length ? { media } : {}) };
}

/** Forget every run's set and selector in memory: what an eviction does (the eviction test hook). */
export function dropAllAnswerMemory(): void { sets.clear(); selectors.clear(); }

/** Forget a run's set, when the run is deleted. */
export function dropAnswer(runId: string): void {
    sets.delete(runId);
    try { void chrome.storage.session.remove(KEY(runId)); } catch { /* nothing stored */ }
}

/** The shape an approved exec in the page is given (no text content), for its `AnswerLog`. */
export async function answerShapeFor(runId: string): Promise<AnswerShapeItem[]> { return answerShape(await answerFor(runId)); }

/**
 * Replay what a page-side script reported it changed. The report is the page's, so it is checked (answer-set.ts).
 * @returns the reason it was refused, or undefined when it was applied
 */
export async function applyAnswerOps(runId: string, ops: unknown): Promise<string | undefined> {
    const set = await answerFor(runId);
    const r = replayAnswerOps(set, ops);
    if ("refused" in r) return r.refused;
    if (r.applied) await save(runId, set);
    return undefined;
}

/**
 * The `answer` tool for a run the worker built: the page's descriptor (what the model is shown), run here.
 * @param runId the run
 * @param page the page's own `answer` tool, for its name, description and parameters
 */
export function workerAnswerTool(runId: string, page: MlTool): MlTool {
    return {
        ...page,
        run: async (args: AnswerArgs = {}) => {
            const set = await answerFor(runId);
            const r = await answerCall(set, args, async (selector, index, note, show) => {
                const ask = selectors.get(runId);
                if (!ask) throw new Error("the page cannot be asked for elements right now");
                // The note is the model's, so it stays here: the page resolves the selector without it, and the crops are
                // labelled with it after (the page's own resolution used it only as that label).
                const got = await ask({ selector, index, show });
                if (got.error) throw new Error(String(got.error).slice(0, 500));
                const clean = checkSelection(got);
                if (!clean) throw new Error("the page returned a malformed selection");
                return { ...clean, ...(clean.media ? { media: clean.media.map((m) => ({ ...m, ...(note ? { label: note } : {}) })) } : {}) };
            });
            await save(runId, set);
            return r.media ? { content: r.content, answerMedia: r.media, answerManaged: true } : r.content;
        },
    } as MlTool;
}
