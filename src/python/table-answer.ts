// table-answer.ts — an `ml.table` wire answer made ready for the sandbox: a stored table's bytes or a /files/ file's,
// carried beside the answer's JSON, which the worker binds into the cell (docs/spec/ML_TABLE.md, "What a Python cell gets").

import { binaryKind } from "../sw/body-read";
import { hasHeaderRow, looksArrowFile, looksParquet, parseDelimited, sniffDelimiter } from "../table/table-data";
import type { TableSource } from "../contract";
import { WireError } from "../sw/ml-wire-serve";

type Cell = string | number | boolean | null;

/** What an `ml.table` call answers the sandbox, before this document reads any bytes: where the table came from, and its
 *  data as rows, as a page's HTML table, as a stored value's key, or as a `/files/` path. `preview` and `rowCount` are
 *  for the run's log (a stored table's first rows and its size), and never cross to the cell. */
export interface TableAnswer {
    source: TableSource | { kind: "file"; label: string };
    data:
        | { kind: "rows"; columns: string[]; rows: Cell[][] }
        | { kind: "html"; html: string }
        | { kind: "value"; key: string; label: string; columns: string[]; delimiter?: string; headerless?: boolean }
        | { kind: "file"; path: string; raw?: boolean; delimiter?: string; header?: boolean };
    preview?: Cell[][];
    rowCount?: number;
}

/** A page-started cell's hoisted read of one literal: the answer, or why the page could not read it. */
export type HoistedAnswer = TableAnswer | { error: string };

/** The largest file `ml.table` reads from `/files/`, in bytes: the cap `pd.read_csv` reads under inside the dialect. */
export const ML_TABLE_FILE_MAX = 64 * 1024 * 1024;

/** How much of a file's head decides its delimiter and header: enough lines for `sniffDelimiter` and `hasHeaderRow`. */
const HEAD_BYTES = 64 * 1024;

/** What the relay needs of the offscreen document: a stored value's bytes and format, and a whole `/files/` file. */
export interface TableAnswerDeps {
    stored(key: string): Promise<{ format: string; buffer: ArrayBuffer }>;
    file(path: string): Promise<ArrayBuffer>;
}

type Answer = { seq?: number; value?: { source?: unknown; data?: Record<string, unknown> } & Record<string, unknown>; error?: unknown } & Record<string, unknown>;

/**
 * Make an `ml.table` answer ready for the worker. A `value` table (a stored pointer's) gets its bytes and format and
 * loses its key; a `file` table (a `/files/` path, or the `@file:` pointer the service worker resolved to one) is read
 * here through the run's reader, so the hide rule and the secret mask apply as they do to the mount, and its format,
 * delimiter and header are decided by the JS reader's own rules (table-data.ts), then handed over as a `value`. Any
 * other answer passes unchanged. A read that fails becomes the answer's error, with the reader's errno as its code.
 * @param answer the service worker's answer to the call
 * @param deps the stored-value and file reads
 * @returns the answer to post, and the bytes to transfer beside it
 */
export async function tableAnswerBytes(answer: unknown, deps: TableAnswerDeps): Promise<{ answer: unknown; buffer?: ArrayBuffer }> {
    const a = answer as Answer | null;
    const data = a?.value?.data;
    if (!a || !data || (data.kind !== "value" && data.kind !== "file")) return { answer };
    const fail = (code: string, message: string) => ({ answer: { seq: a.seq, error: { code, message } } });
    if (data.kind === "value") {
        try {
            const { format, buffer } = await deps.stored(String(data.key));
            const { key: _key, ...rest } = data;
            return { answer: { ...a, value: { ...a.value, data: { ...rest, format } } }, buffer };
        } catch (e) {
            return fail("Failed", `ml.table could not read the stored table: ${(e as Error)?.message ?? e}`);
        }
    }
    const path = String(data.path ?? "");
    let buffer: ArrayBuffer;
    try { buffer = await deps.file(path.replace(/^\/files\//, "")); }
    catch (e) {
        const err = e as { code?: unknown; message?: unknown };
        return fail(typeof err?.code === "string" ? err.code : "Failed", `ml.table(${JSON.stringify(path)}): ${String(err?.message ?? e)}`);
    }
    const bytes = new Uint8Array(buffer);
    const { path: _path, kind: _kind, ...opts } = data;
    const value = (d: Record<string, unknown>) => ({ answer: { ...a, value: { ...a.value, data: { ...opts, kind: "value", ...d } } }, buffer });
    if (looksParquet(buffer)) return value({ format: "parquet" });
    if (looksArrowFile(buffer)) return value({ format: "arrow-file" });
    // A binary file is never decoded as text (the wire-format trap): it is not a table, whatever its name says.
    const binary = binaryKind(bytes.subarray(0, HEAD_BYTES));
    const head = binary ? null : new TextDecoder().decode(bytes.subarray(0, HEAD_BYTES));
    const given = typeof data.delimiter === "string" ? data.delimiter : null;
    const delimiter = given ?? (head === null ? null : sniffDelimiter(head));
    if (head === null || delimiter === null) return fail("NotATable", `ml.table(${JSON.stringify(path)}): this file is not delimited text, Parquet or Arrow, so it is not a table. Read it with ml.dereference, or open it in the cell.`);
    // The head's last line may be cut mid-row, so it is left out of the header decision.
    const rows = parseDelimited(head.slice(0, Math.max(head.lastIndexOf("\n"), 0)) || head, delimiter, 200).rows;
    const header = typeof data.header === "boolean" ? data.header : hasHeaderRow(rows);
    return value({ format: "csv", delimiter, ...(header ? {} : { headerless: true }) });
}

/** The sentence a page-started cell gets for a source the page did not read before it (ML_TABLE.md, "Page callers"). */
export const UNHOISTED_TABLE = "a cell started from a page reads only the sources written in its code as a literal, ml.table(\"<source>\") with the source in quotes, which the page reads before the cell runs. Write this source that way, or read it in an agent run's python_exec, where any source is read when the cell calls it.";

/**
 * The key a hoisted table is held under: its source and its options, so a call with other options is not answered
 * with a read it did not ask for.
 * @param src the source as the code wrote it
 * @param opts the call's options
 */
export function hoistKey(src: string, opts: TableReadOpts): string {
    return JSON.stringify([src.trim(), !!opts.raw, opts.delimiter ?? null, opts.header ?? null]);
}

/**
 * The options of one call, as the wire carried them: `raw`, `delimiter` (one character) and `header`, each optional.
 * @param o the trailing options object, if any
 * @returns the options
 * @throws BadRequest for anything else
 */
export function tableOpts(o: unknown): TableReadOpts {
    if (o === undefined || o === null) return {};
    if (typeof o !== "object" || Array.isArray(o)) throw new WireError("BadRequest", "ml.table's options are raw, delimiter and header");
    const out: TableReadOpts = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k === "raw" && typeof v === "boolean") out.raw = v;
        else if (k === "delimiter" && typeof v === "string" && v.length === 1) out.delimiter = v;
        else if (k === "header" && typeof v === "boolean") out.header = v;
        else throw new WireError("BadRequest", `ml.table: ${k === "delimiter" ? "delimiter is one character" : `${JSON.stringify(k)} is not an option; it takes raw, delimiter and header`}`);
    }
    return out;
}

/** What `ml.table` takes beside its source, as the wire carries them. */
export interface TableReadOpts { raw?: boolean; delimiter?: string; header?: boolean }
