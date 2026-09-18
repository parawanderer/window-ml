// table-summary.ts — one row per COLUMN instead of one per record (docs/spec/TABLE_VIEW.md, "Per-column statistics"):
// what the table view shows by default once a table is larger than the rows the panel can draw.
//
// Pure, and computed over whatever values it is handed, which is why its caller must say what they are: the whole table
// when the value store holds it, or the preview when it does not. A summary of a 200-row prefix presented as the
// table's is the sample-as-the-whole bug this codebase keeps meeting.

import type { TableCell } from "./contract-fetch";

/** Buckets in a numeric column's histogram. Coarse on purpose: a glance, not a chart. */
export const HIST_BINS = 12;
/** How many of an object column's most frequent values are named. */
export const TOP_VALUES = 3;

/** One column, summarised. */
export interface ColumnSummary {
    name: string;
    dtype: string;
    /** values that are not null (null, undefined and the empty string are null, as pandas reads an empty CSV field) */
    count: number;
    nulls: number;
    distinct: number;
    /** for a numeric column: its range, mean and a histogram of `HIST_BINS` counts */
    numeric?: { min: number; max: number; mean: number; hist: number[] };
    /** for any other column: the most frequent values, most first, and the share of non-null values they cover */
    top?: { value: string; count: number }[];
    topShare?: number;
    /** for a boolean column: the split */
    bool?: { true: number; false: number };
}

const isNull = (v: TableCell | undefined): boolean => v == null || v === "";

/**
 * Summarise columns given as VALUE ARRAYS (`values[i]` is column `names[i]`, every row). `dtypes` decides the kind of
 * summary (the frame's own dtype, not a guess made here); a column with no dtype is numeric when every non-null value is a
 * number. Pure.
 */
export function summarizeColumns(names: string[], values: TableCell[][], dtypes?: Record<string, string>): ColumnSummary[] {
    return names.map((name, i) => {
        const col = values[i] ?? [];
        const present = col.filter((v) => !isNull(v));
        const dtype = dtypes?.[name] ?? (present.length && present.every((v) => typeof v === "number") ? "float64" : "object");
        const base: ColumnSummary = { name, dtype, count: present.length, nulls: col.length - present.length, distinct: new Set(present.map((v) => String(v))).size };
        if (/^(u?int|float)/.test(dtype)) {
            const nums = present.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
            if (!nums.length) return base;
            let min = Infinity, max = -Infinity, sum = 0;
            for (const n of nums) { if (n < min) min = n; if (n > max) max = n; sum += n; }
            const hist = new Array(HIST_BINS).fill(0);
            const span = max - min;
            for (const n of nums) hist[span ? Math.min(HIST_BINS - 1, Math.floor(((n - min) / span) * HIST_BINS)) : 0]++;
            return { ...base, numeric: { min, max, mean: sum / nums.length, hist } };
        }
        if (dtype === "bool") {
            let t = 0, f = 0;
            for (const v of present) { if (v === true || v === "true" || v === "True") t++; else f++; }
            return { ...base, bool: { true: t, false: f } };
        }
        const counts = new Map<string, number>();
        for (const v of present) { const k = String(v); counts.set(k, (counts.get(k) ?? 0) + 1); }
        const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_VALUES).map(([value, count]) => ({ value, count }));
        return { ...base, top, topShare: present.length ? top.reduce((n, t) => n + t.count, 0) / present.length : 0 };
    });
}

/** The same, over ROWS (a preview in hand): column `i` is `rows.map(r => r[i])`. */
export function summarizeRows(names: string[], rows: TableCell[][], dtypes?: Record<string, string>): ColumnSummary[] {
    return summarizeColumns(names, names.map((_, i) => rows.map((r) => r[i])), dtypes);
}
