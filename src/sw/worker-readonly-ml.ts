// worker-readonly-ml.ts — the read-only `ml` a survey sees when the service worker evaluates it (sw-readonly.ts).

// The same members `window.ml` offers a survey, answered by the worker's own functions: the pure ones (`pipe`,
// `jsonPath`, `schema`, `range`) are the page's own modules, the box and config reads go straight to the backend, and
// `dereference` reads the run's pointer store, which lives here. What reads the PAGE (`queryAll`, `a11y`, the fetch
// cache, the answer set) is absent, so a survey that reaches for it is handed to the page (NeedsPage) instead
// (docs/spec/SITE_ACCESS.md, slice 2; docs/spec/CURRENT_CONTEXT.md).

import type { DerefRead, DerefValue } from "../contract/contract-pointers";
import { DerefText } from "../tools/deref-read";
import { pipeStages, derefPipe, TokenStore } from "../pointers/token-pipe";
import { mlPipe, type PipeLimits } from "../pointers/text-pipe";
import { mlJsonPath } from "../json-path";
import { mlSchema } from "../ml/ml-schema";
import { mlRange } from "../util";
import { workerMl } from "./worker-ml";
import { getConfig, listLoadedModels, fetchOllamaInfo } from "./sw-llm";
import { valueHolders, readStoredColumns, readStoredText } from "./sw-values";
import { workerFetchCached } from "./worker-tools";
import type { StoredColumnReader } from "../table/table-data";

/** A run's pointer resolver, as the loop hands it to the host (`tokenSink`). */
export type RunDeref = (ref: string, pipe?: string | string[], limits?: PipeLimits) => DerefRead;

/**
 * Read a pointer through the run's resolver, over the WHOLE of a stored text when its row names one (fetch_url past its
 * preview; docs/spec/POINTER_VALUES.md, slice 9) and over what the row holds otherwise. The resolver is synchronous and
 * holds only the preview, so the whole is read here, where the caller can wait. A whole that is gone throws the store's
 * reason, never the preview.
 * @param runId the run, which must hold the stored value
 * @param deref the run's pointer resolver
 * @param ref the pointer
 * @param stages the pipe, as stages
 * @param limits the caller's budget for the pipe's line stages (text-pipe.ts `PipeLimits`), or none; with no stages it
 *   is charged the size of the text read (`charge`), since nothing else would charge that copy
 * @returns what the resolver answers, with the whole text in place of the preview
 */
export async function derefWhole(runId: string, deref: RunDeref, ref: string, stages: string[], limits?: PipeLimits): Promise<DerefRead> {
    const base = deref(ref);
    const key = base.meta?.value, meta = base.meta;
    if (!key || !meta || meta.table || meta.kind === "table" || TokenStore.slotOf(ref) === "in") {
        if (stages.length) return deref(ref, stages, limits);
        limits?.charge?.(base.value.length);
        return base;
    }
    // An unpiped read copies the whole text with no stage to charge it, so the caller's budget is charged its size
    // here, before the copy (the blob's byte count, which is the character count for the ASCII a megabyte usually is).
    const whole = await readStoredText(key, runId, !stages.length && limits?.charge ? limits.charge : undefined);
    return { ...base, value: derefPipe({ id: meta.id, tool: meta.tool, kind: meta.kind, out: whole, t: 0, step: meta.step }, "out", stages, limits) };
}

/** A stored table's columns, read from the worker's value store for the run that holds it: what `VALUE_COLUMNS` answers
 *  a page, without the round trip. A key the run does not hold reads nothing. */
function columnsFor(runId: string, read: DerefRead): StoredColumnReader | undefined {
    const key = read.meta?.table ? read.meta.value : undefined;
    const table = read.meta?.table;
    if (!key || !table) return undefined;
    return async (names) => {
        const holders = await valueHolders(key);
        if (holders && !holders.includes(runId)) throw new Error("That stored table is not held by this run.");
        return await readStoredColumns(key, names, { ...(table.delimiter ? { delimiter: table.delimiter } : {}), ...(table.headerless ? { headerless: true } : {}) }) as Awaited<ReturnType<StoredColumnReader>>;
    };
}

/**
 * Build the read-only `ml` for one survey of one run.
 * @param tabUrl the run's tab as the browser reports it, for `config()`'s one page-dependent field
 * @param deref the run's pointer resolver; absent before the loop has handed it over, and then `dereference` is absent
 *   too, so a survey naming a pointer is decided by the page leg, which refuses it
 * @param runId the run, which a stored table's column read must be held by
 * @returns the members the dialect's worker facade picks from
 */
export function workerReadonlyMl(tabUrl: string, deref?: RunDeref, runId = ""): Record<string, unknown> {
    const base = workerMl(tabUrl);
    const ml: Record<string, unknown> = {
        getModel: async () => (await getConfig()).model,
        config: base.config,
        models: base.models,
        capabilities: base.capabilities,
        serverTools: base.serverTools,
        ps: () => listLoadedModels(),
        info: () => fetchOllamaInfo(),
        pipe: mlPipe,
        jsonPath: mlJsonPath,
        schema: mlSchema,
        range: mlRange,
        // The run's own fetches, made by its `fetch_url` in the worker: a re-read is free and never egresses. Only the
        // default mode is cached; any other misses, and the dialect defers it to the page.
        _fetchCached: (url: unknown, mode?: { credentials?: boolean; rendered?: boolean; format?: string }) =>
            mode?.credentials || mode?.rendered || mode?.format === "html" ? undefined : workerFetchCached(runId, String(url)),
    };
    if (deref) {
        // The page's `ml.dereference`, with the store read in-process. Its advisory has
        // nowhere to go: the dialect's console is the script's, and a warning written into it would read as output.
        const dereference = async (ref: unknown, opts: { pipe?: string | string[] | null } = {}): Promise<DerefValue> => {
            const read = await derefWhole(runId, deref, String(ref ?? ""), pipeStages(opts?.pipe ?? null));
            const again = (stages: string | string[]): Promise<DerefValue> => dereference(ref, { pipe: stages });
            return new DerefText(read.value, read.meta, again, read.readColumns ?? columnsFor(runId, read));
        };
        ml.dereference = dereference;
    }
    return ml;
}
