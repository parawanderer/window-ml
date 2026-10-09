// worker-answer.ts — the curated answer of a run the worker built, held by the worker so the page never holds its text.

// The answer the model curates (the `answer` tool, `ml.answer`) is what the person is handed, and its text is the
// model's: written from whatever the run read, another site included. Held in the page's realm, any script on the page
// could read it (docs/spec/SITE_ACCESS.md, slice 2 part 2). So for a run the worker built, the set lives here: the
// `answer` tool runs in the worker, asking the page only to resolve a selector; an approved exec in the page is given
// the set's SHAPE (`AnswerLog`, answer-set.ts) and reports what it changed, which is replayed here; the turn's answer is
// assembled here. Kept in session storage beside the worker's memory, so an eviction mid-turn does not lose it.

import type { MlTool } from "../contract";
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
                const got = await ask({ selector, index, note, show });
                if (got.error) throw new Error(got.error);
                return got;
            });
            await save(runId, set);
            return r.media ? { content: r.content, answerMedia: r.media, answerManaged: true } : r.content;
        },
    } as MlTool;
}
