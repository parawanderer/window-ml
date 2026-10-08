// fetch-result.ts — what every caller of ml.fetch gets on top of the bytes: Markdown for HTML, a parsed table for CSV.

import type { FetchResult } from "../contract";
import { isTable } from "../table/table-brand";
import { tableFromDelimited, asTable } from "../table/table-data";

/**
 * Attach what a caller would otherwise derive from the bytes, in place: `.markdown` for an HTML body (scripts, nav and
 * page chrome stripped; `.text` keeps the raw HTML), and `.table` for a CSV/TSV one (its separator discovered, numeric
 * columns cast), as the read-only table facade. The page and the worker both call it on what `FETCH_URL` answered.
 * @param r the result, changed in place
 * @param opts `markdown` converts HTML (it needs a DOM: the page's own, or the offscreen document's for the worker);
 *   `python` says whether the run has `python_exec`, which a table's pandas-shaped refusals may then point at
 */
export function derivedFetchFields(r: FetchResult, opts: { markdown: (html: string) => string | undefined; python: boolean }): void {
    if (r && r.type === "html" && typeof r.text === "string" && r.markdown === undefined) {
        try { r.markdown = opts.markdown(r.text); } catch { /* leave undefined — callers fall back to .text */ }
    }
    // Same move for a CSV/TSV body: attach the PARSED table, with its separator discovered and
    // numeric columns cast, so no caller has to re-split the text (and get the separator wrong —
    // the reason this exists is that they did).
    if (r && r.type === "csv" && typeof r.text === "string" && r.table === undefined) {
        try {
            const parsed = tableFromDelimited(r.text);
            // A body clipped at the size cap ends mid-row, so that row is a fragment rather than
            // data. Drop it and say the table is a prefix — silently keeping it would put a
            // half-parsed record into a DataFrame. BEFORE wrapping: the facade is read-only, and
            // trimming through it threw halfway, leaving the fragment dropped but the shape wrong.
            if (r.truncated && parsed.rows.length) {
                parsed.rows.pop();
                parsed.shape = [parsed.rows.length, parsed.columns.length];
                parsed.truncated = true;
                // …unless the worker read the whole body (it is stored), in which case its real length is
                // known: the preview is a prefix of a table this big, not the whole of a table this small.
                const whole = typeof r.bodyLines === "number" ? r.bodyLines - (parsed.headerless ? 0 : 1) : 0;
                if (whole > parsed.rows.length) parsed.shape = [whole, parsed.columns.length];
            }
            r.table = parsed;
        } catch { /* leave undefined — callers fall back to .text */ }
    }
    // Every table a caller receives is a FACADE, not the bare data — a Parquet one decoded in the
    // worker as much as a CSV parsed here: the description is pandas-shaped, so the object has to
    // answer a pandas reach with a message rather than `undefined`. Whether the message may point
    // at python_exec is read from the running run's toolset.
    if (r && r.table && !isTable(r.table)) r.table = asTable(r.table, { python: opts.python });
}
