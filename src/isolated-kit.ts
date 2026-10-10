// isolated-kit.ts — the pointer value an isolated exec's `ml.dereference` returns, built inside that world.

// It is the page's own `DerefText` (deref-read.ts), so a value reads the same in every world: `.text`, `.json`,
// `.schema()`, a table's facade and its errors. What needs the worker while the script runs (a re-pipe, a stored
// table's columns) is asked over the call's channel (`ask`, bound by the wrapper in sw-isolated-exec.ts and answered by
// iso-channel.ts). Bundled into one source string at build time (scripts/gen-isolated-kit.mjs, isolated-kit.gen.ts) and
// spliced into the wrapper, where its `var` is a local of the wrapper's function: nothing of it is a global of the world.

import { DerefText } from "./tools/deref-read";
import type { DerefMeta, DerefValue } from "./contract/contract-pointers";

/** One request an isolated exec sends the worker: re-read named read `i` through `stages`, or read named columns of the
 *  stored table `key`. The worker decides what either may reach (iso-channel.ts). */
export type IsoRequest = { op: "pipe"; i: number; stages: string | string[] } | { op: "cols"; key: string; names: string[] };

/** The call's channel to the worker: resolves with the answer's data, rejects with the worker's error. */
export type IsoAsk = (req: IsoRequest) => Promise<unknown>;

/** What a read that needs the worker throws when the call has no channel (a CDP world whose binding could not be added). */
const NO_CHANNEL = {
    pipe: "A pointer's .pipe() is not available in this isolated exec: it could not reach the worker. Name the pipe as a literal instead (ml.dereference(\"@tool:<id>\", { pipe: \"<stages>\" })), which is sent with the call.",
    table: "A pointer's stored table is not available in this isolated exec: it could not reach the worker. Read its columns in a read-only exec, which reads stored tables in the worker.",
};

/**
 * The value `ml.dereference` returns for one read sent with the call.
 * @param read the read: its text and metadata
 * @param i which of the call's named reads it came from, the pointer a `.pipe()` re-reads
 * @param ask the call's channel, or undefined when it has none
 * @returns the page's pointer value
 */
export function isoValue(read: { value?: string; meta?: DerefMeta }, i: number, ask?: IsoAsk): DerefValue {
    // `.pipe()` re-reads the SAME pointer with new stages, as the page's `ml.dereference` does (injected.ts).
    const again = async (stages: string | string[]): Promise<DerefValue> => {
        if (!ask) throw new Error(NO_CHANNEL.pipe);
        const r = await ask({ op: "pipe", i, stages: Array.isArray(stages) ? stages.map(String) : String(stages ?? "") }) as { value?: string; warning?: string; meta?: DerefMeta };
        if (r?.warning) { try { console.warn(r.warning); } catch { /* no console */ } }
        return isoValue(r ?? {}, i, ask);
    };
    const key = read.meta?.table ? read.meta.value : undefined;
    const readColumns = key && ask
        ? (names: string[]) => ask({ op: "cols", key, names: names.map(String) }) as Promise<{ rowCount: number; columns: Record<string, (string | number | boolean | null)[]> }>
        : key ? () => Promise.reject(new Error(NO_CHANNEL.table)) : undefined;
    return new DerefText(read.value ?? "", read.meta, again, readColumns);
}
