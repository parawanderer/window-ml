// table-decode-cache.ts — the service worker's decode of each stored table, kept once as Arrow columns, so a stored
// table's reads stop re-parsing its whole body (docs/spec/ML_TABLE.md, "Views of a stored table in JS", slice A).
//
// The stored bytes do not change: the value store keeps them as they arrived (POINTER_VALUES slice 7). This is a CACHE
// of their decode, derived from the store, so losing it (the worker's ~30 s idle eviction) loses nothing but time. It
// is keyed by the blob and the decode options, so one session's options never change what another sharing the blob
// reads.
//
// Each column is built with `makeData` straight from typed arrays. apache-arrow's builders (`vectorFromArray`,
// `tableFromArrays`) compile their null check with `new Function`, which the worker's CSP refuses; `makeData` and a
// vector's `get` compile nothing. A column whose cells are not all of one kind (numbers, booleans or strings, with
// nulls) is kept as the cells themselves, so every cell reads back exactly as the decode made it.

import { decodeStored, columnIndexes, storedReadRows, type TableCell } from "./table-data";
import { type StoredReadPlan } from "./table-plan";

/** The most bytes of decoded columns the cache keeps at once, least recently read first out. A decode larger than this
 *  serves its one read and is not kept. Measured (notebooks/tables/decode-cache.ipynb): a 64 MB CSV, the largest a fetch
 *  stores, decodes to 58 to 90 MB, so this holds two to four of those. */
export const TABLE_DECODE_CACHE_BYTES = 256 * 1024 * 1024;

/** One decoded column: its cell at a row, and what it costs the cache. */
interface DecodedColumn { get(row: number): TableCell; bytes: number }

/** A stored table's decode, every row. */
interface Decoded { columns: string[]; rowCount: number; cols: DecodedColumn[]; bytes: number }

/** Decodes by blob and options, in the order they were last read (a Map keeps insertion order; a hit moves to the end). */
const decodes = new Map<string, Decoded>();   // state: cache
/** A decode in flight, so two reads of one table at once parse it once. */
const pending = new Map<string, Promise<Decoded>>();   // state: cache
/** What the cache holds, in bytes. */
let held = 0;   // state: cache
/** How many decodes ran: the measure of "once", for tests and the measurement script. */
let decodeCount = 0;   // state: cache

/** The bytes a fallback column is charged: a slot per cell, and two bytes a character for a string. An estimate; an
 *  Arrow column is charged its buffers exactly. */
function cellsBytes(cells: TableCell[]): number {
    let b = cells.length * 8;
    for (const c of cells) if (typeof c === "string") b += c.length * 2;
    return b;
}

/** A UTF-16 half with no other half, which TextEncoder would replace. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A column kept as its cells. Its own function, so the closure holds only `cells`. */
function cellsColumn(cells: TableCell[]): DecodedColumn {
    return { get: (r) => cells[r], bytes: cellsBytes(cells) };
}

/** A column read from an Arrow vector. Its own function, so the closure holds only the vector: a getter made inside
 *  `column` would share that function's context, and keep the parser's cells alive beside the vector. */
function vectorColumn(v: { get(row: number): unknown }, bytes: number): DecodedColumn {
    return { get: (r) => v.get(r) as TableCell, bytes };
}

/** A column's cells as an Arrow vector when they are all one kind, or the cells themselves. */
async function column(cells: TableCell[]): Promise<DecodedColumn> {
    let kind: "number" | "boolean" | "string" | null = null, nulls = 0;
    for (const c of cells) {
        if (c == null) { nulls++; continue; }
        const k = typeof c as "number" | "boolean" | "string";
        if (kind === null) kind = k;
        else if (kind !== k) return cellsColumn(cells);
        // A lone surrogate does not survive UTF-8, so a column holding one keeps its cells.
        if (k === "string" && LONE_SURROGATE.test(c as string)) return cellsColumn(cells);
    }
    const n = cells.length;
    const { makeData, makeVector, Float64, Bool, Utf8 } = await import("apache-arrow");
    const bitmap = nulls ? new Uint8Array((n + 7) >> 3) : undefined;
    if (bitmap) cells.forEach((c, r) => { if (c != null) bitmap[r >> 3] |= 1 << (r & 7); });
    let v: { get(row: number): unknown }, bytes: number;
    if (kind === "boolean") {
        const bits = new Uint8Array((n + 7) >> 3);
        cells.forEach((c, r) => { if (c === true) bits[r >> 3] |= 1 << (r & 7); });
        const data = makeData({ type: new Bool(), length: n, nullCount: nulls, data: bits, nullBitmap: bitmap });
        v = makeVector(data); bytes = data.byteLength;
    } else if (kind === "string") {
        const enc = new TextEncoder();
        const parts = cells.map((c) => (c == null ? null : enc.encode(c as string)));
        const total = parts.reduce((s, p) => s + (p ? p.length : 0), 0);
        // Utf8's offsets are 32-bit; a column past them keeps its cells.
        if (total > 0x7fffffff) return cellsColumn(cells);
        const offsets = new Int32Array(n + 1), utf8 = new Uint8Array(total);
        let at = 0;
        parts.forEach((p, r) => { if (p) { utf8.set(p, at); at += p.length; } offsets[r + 1] = at; });
        const data = makeData({ type: new Utf8(), length: n, nullCount: nulls, valueOffsets: offsets, data: utf8, nullBitmap: bitmap });
        v = makeVector(data); bytes = data.byteLength;
    } else {
        // Numbers, or a column of nulls only. A double keeps NaN and -0 as they are; null is the bitmap's.
        const values = new Float64Array(n);
        cells.forEach((c, r) => { if (c != null) values[r] = c as number; });
        const data = makeData({ type: new Float64(), length: n, nullCount: nulls, data: values, nullBitmap: bitmap });
        v = makeVector(data); bytes = data.byteLength;
    }
    return vectorColumn(v, bytes);
}

/** Decode a stored table's bytes once into columns; the rows the parser made are dropped when this returns. */
async function decode(bytes: ArrayBuffer, format: string, opts: { delimiter?: string; headerless?: boolean }): Promise<Decoded> {
    decodeCount++;
    const t = await decodeStored(bytes, format, opts);
    const cols: DecodedColumn[] = [];
    for (let c = 0; c < t.columns.length; c++) cols.push(await column(t.rows.map((r) => r[c])));
    return { columns: t.columns, rowCount: t.rows.length, cols, bytes: cols.reduce((s, c) => s + c.bytes, 0) };
}

/** Keep a decode, evicting the least recently read until it fits; one larger than the cache is not kept. */
function keep(id: string, d: Decoded, cap: number): void {
    if (d.bytes > cap) return;
    while (held + d.bytes > cap && decodes.size) {
        const [oldest, o] = decodes.entries().next().value as [string, Decoded];
        decodes.delete(oldest);
        held -= o.bytes;
    }
    decodes.set(id, d);
    held += d.bytes;
}

/**
 * NAMED COLUMNS OF A STORED TABLE, every row up to the plan's limit, read from the worker's decode of it: decoded on the
 * first read of the blob with these options, and from memory after. Throws on an unknown name (listing the real ones),
 * on a read past `MAX_STORED_READ_CELLS`, and on a format that is not a table.
 * @param blob the blob's id (its SHA-256, or the row's key for a row older than shared blobs)
 * @param bytes the stored bytes, read only when there is no decode to use
 * @param format the stored format
 * @param names the columns to return
 * @param opts the preview's delimiter and header decisions
 * @param plan the view's limit
 * @param cap the cache's size in bytes (a test seam)
 */
export async function cachedStoredColumns(blob: string, bytes: () => Promise<ArrayBuffer>, format: string, names: string[],
    opts: { delimiter?: string; headerless?: boolean }, plan: StoredReadPlan = {}, cap = TABLE_DECODE_CACHE_BYTES): Promise<{ rowCount: number; columns: Record<string, TableCell[]> }> {
    const id = JSON.stringify([blob, format, opts.delimiter ?? null, !!opts.headerless]);
    let d = decodes.get(id);
    if (d) { decodes.delete(id); decodes.set(id, d); }
    else {
        let p = pending.get(id);
        if (!p) {
            p = bytes().then((b) => decode(b, format, opts));
            pending.set(id, p);
            void p.then((got) => keep(id, got, cap), () => {}).finally(() => pending.delete(id));
        }
        d = await p;
    }
    const idx = columnIndexes(d.columns, names);
    const n = storedReadRows(d.rowCount, names, plan);
    const got = d;
    return { rowCount: n, columns: Object.fromEntries(names.map((name, j) => [name, Array.from({ length: n }, (_, r) => got.cols[idx[j]].get(r))])) };
}

/** What the cache holds now: entries, bytes, and how many decodes have run. For tests and the measurement. */
export function decodeCacheStats(): { entries: number; bytes: number; decodes: number } {
    return { entries: decodes.size, bytes: held, decodes: decodeCount };
}

/** Empty the cache, as a worker restart does. For tests. */
export function clearDecodeCache(): void {
    decodes.clear();
    pending.clear();
    held = 0;
    decodeCount = 0;
}
