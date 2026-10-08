// worker-readonly-ml.ts — the read-only `ml` a survey sees when the service worker evaluates it (sw-readonly.ts).

// The same members `window.ml` offers a survey, answered by the worker's own functions: the pure ones (`pipe`,
// `jsonPath`, `schema`, `range`) are the page's own modules, the box and config reads go straight to the backend, and
// `dereference` reads the run's pointer store, which lives here. What reads the PAGE (`queryAll`, `a11y`, the fetch
// cache, the answer set) is absent, so a survey that reaches for it is handed to the page (NeedsPage) instead
// (docs/spec/SITE_ACCESS.md, slice 2; docs/spec/CURRENT_CONTEXT.md).

import type { DerefRead, DerefValue } from "../contract/contract-pointers";
import { DerefText } from "../tools/deref-read";
import { pipeStages } from "../pointers/token-pipe";
import { mlPipe } from "../pointers/text-pipe";
import { mlJsonPath } from "../json-path";
import { mlSchema } from "../ml/ml-schema";
import { mlRange } from "../util";
import { workerMl } from "./worker-ml";
import { getConfig, listLoadedModels, fetchOllamaInfo } from "./sw-llm";
import { valueHolders, readStoredColumns } from "./sw-values";
import type { StoredColumnReader } from "../table/table-data";

/** A run's pointer resolver, as the loop hands it to the host (`tokenSink`). */
export type RunDeref = (ref: string, pipe?: string | string[]) => DerefRead;

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
    };
    if (deref) {
        // The page's `ml.dereference`, with the store read in-process instead of over DEREF_TOKEN. Its advisory has
        // nowhere to go: the dialect's console is the script's, and a warning written into it would read as output.
        const dereference = async (ref: unknown, opts: { pipe?: string | string[] | null } = {}): Promise<DerefValue> => {
            const read = deref(String(ref ?? ""), pipeStages(opts?.pipe ?? null));
            const again = (stages: string | string[]): Promise<DerefValue> => dereference(ref, { pipe: stages });
            return new DerefText(read.value, read.meta, again, read.readColumns ?? columnsFor(runId, read));
        };
        ml.dereference = dereference;
    }
    return ml;
}
