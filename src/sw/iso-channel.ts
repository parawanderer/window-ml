// iso-channel.ts — what the worker answers an isolated exec that asks for more while it runs: a re-pipe of a pointer the
// approved source named, or a stored table's columns sent with the call. Pure apart from the deps it is handed.

// An isolated exec (sw-isolated-exec.ts) is sent its named reads with the call (named-reads.ts). A value's `.pipe()` and
// a stored table's `col`/`select`/`records`/long `head` need the worker mid-script, so the world asks over a channel
// only it holds (a user-script world's `runtime.sendMessage`, a CDP binding named for that world), checked by the caller
// against the call's tab, document, world and nonce. This module decides what such a request may reach, with the same
// entitlement `VALUE_COLUMNS` applies in the page's world: only what the approved source named, only while that call
// is in flight, a bounded number of times (docs/dev/site-access.md, "Where an approved exec of a worker-built run runs").

import type { PreRead } from "../pointers/named-reads";
import type { DerefRead, DerefMeta } from "../contract/contract-pointers";
import type { TableLike } from "../contract/contract-fetch";
import { pipeStages } from "../pointers/token-pipe";

/** How many requests one isolated exec may send. Past it every request is refused without any work. */
export const ISO_ASK_MAX = 256;

/** The most stages one re-pipe may carry, and the longest stage; the most columns one read may name. */
const MAX_STAGES = 32, MAX_STAGE_CHARS = 4096, MAX_NAMES = 4096;

/** What a request is answered with: the data, or the error the world throws. */
export type IsoAnswer = { ok: unknown } | { error: string };

/** What the server reads through: the run's pointer resolver, and the value store. */
export interface IsoDeps {
    /** The run's pointer resolver now (undefined once the turn has ended). */
    deref: () => ((ref: string, pipe?: string | string[]) => DerefRead) | undefined;
    /** Which sessions hold a stored value (null: unknown to the store). */
    holders: (key: string) => Promise<string[] | null>;
    /** Read named columns of a stored value. */
    columns: (key: string, names: string[], opts: { delimiter?: string; headerless?: boolean }) => Promise<{ rowCount: number; columns: Record<string, unknown[]> }>;
}

/** The sentence a refused request throws in the world. */
export const ISO_REFUSED = {
    budget: `This exec asked the worker for pointer reads more than ${ISO_ASK_MAX} times, so the rest are refused. Read what you need in fewer calls (one .pipe() with all its stages, one t.select([...]) for several columns).`,
    malformed: "The isolated exec sent a request the worker does not answer.",
    unnamed: "That pointer was not named in the script, so the worker does not read it for this exec. Write the pointer as a literal (`@tool:<id>`) and run it again.",
    table: "That stored table was not named by the running script.",
    held: "That stored table is not held by this run.",
    ended: "The run's pointers are gone (the turn ended), so this read was not answered.",
} as const;

/**
 * The server for one isolated exec: answers only requests about the reads sent with that call.
 * @param runId the run, which a stored table must be held by
 * @param reads the named reads sent with the call, in the order the world indexes them
 * @param deps what it reads through
 * @returns one function per request; the caller has already checked who sent it
 */
export function isoServer(runId: string, reads: readonly PreRead[], deps: IsoDeps): (req: unknown) => Promise<IsoAnswer> {
    let left = ISO_ASK_MAX;
    // The stored tables this call may read: those sent with it, and those its own re-pipes were answered with (the worker
    // handed them to this world itself). A key with the table it belongs to, whose delimiter is the worker's, never the world's.
    const tables = new Map<string, TableLike>();
    const entitle = (meta: DerefMeta | undefined) => { if (meta?.table && typeof meta.value === "string" && meta.value) tables.set(meta.value, meta.table); };
    for (const r of reads) if (r.error === undefined) entitle(r.meta);
    const strings = (a: unknown, max: number, chars: number): a is string[] =>
        Array.isArray(a) && a.length <= max && a.every((s) => typeof s === "string" && s.length <= chars);
    return async (req) => {
        if (left <= 0) return { error: ISO_REFUSED.budget };
        left--;
        const q = req as { op?: unknown; i?: unknown; stages?: unknown; key?: unknown; names?: unknown } | null;
        if (!q || typeof q !== "object") return { error: ISO_REFUSED.malformed };
        if (q.op === "pipe") {
            const stages = typeof q.stages === "string" ? (q.stages.length <= MAX_STAGES * MAX_STAGE_CHARS ? pipeStages(q.stages) : null) : strings(q.stages, MAX_STAGES, MAX_STAGE_CHARS) ? pipeStages(q.stages) : null;
            if (!stages || stages.length > MAX_STAGES) return { error: ISO_REFUSED.malformed };
            const read = Number.isInteger(q.i) ? reads[q.i as number] : undefined;
            if (!read || read.error !== undefined) return { error: ISO_REFUSED.unnamed };
            const fn = deps.deref();
            if (!fn) return { error: ISO_REFUSED.ended };
            try {
                const r = fn(read.ref, stages);
                entitle(r.meta);
                return { ok: { value: r.value, ...(r.warning ? { warning: r.warning } : {}), ...(r.meta ? { meta: r.meta } : {}) } };
            } catch (e) { return { error: (e as Error)?.message || String(e) }; }
        }
        if (q.op === "cols") {
            if (typeof q.key !== "string" || !strings(q.names, MAX_NAMES, MAX_STAGE_CHARS)) return { error: ISO_REFUSED.malformed };
            const table = tables.get(q.key);
            if (!table) return { error: ISO_REFUSED.table };
            const holders = await deps.holders(q.key);
            if (holders && !holders.includes(runId)) return { error: ISO_REFUSED.held };
            try {
                return { ok: await deps.columns(q.key, q.names, { ...(table.delimiter ? { delimiter: table.delimiter } : {}), ...(table.headerless ? { headerless: true } : {}) }) };
            } catch (e) { return { error: (e as Error)?.message || String(e) }; }
        }
        return { error: ISO_REFUSED.malformed };
    };
}
