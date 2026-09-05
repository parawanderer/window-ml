// LINE DIFF — what changed between two versions of the same script.
//
// The commonest loop in a run is: a code tool fails, the model retries with a tweak, and the reader diffs
// two twenty-line blocks BY EYE to find the one line that moved. This computes it instead.
//
// WE compute it, never the model. A model asked "what did you change" answers from memory of what it MEANT
// to change, which is a different thing from what it sent — and the two disagree exactly when the diff is
// most worth reading. Its claim rides BESIDE this, never instead of it (the same rule a `token:` label
// follows).
//
// Pure, so it unit-tests directly, and shared: whatever computes a diff should be one thing.

/** One row of a rendered diff. `gap` stands in for a run of unchanged lines nobody needs to read. */
export type DiffRow =
    | { kind: "same"; text: string; a: number; b: number }
    | { kind: "del"; text: string; a: number }
    | { kind: "add"; text: string; b: number }
    | { kind: "gap"; skipped: number };

/** Above this many lines on either side the quadratic table stops being free. A diff of two 600-line
 *  scripts is also not something anyone reads as a diff, so the honest answer is to say it is too big
 *  rather than to spend a second computing something nobody wanted. */
export const DIFF_MAX_LINES = 400;
/** Unchanged lines kept either side of a change, so a hunk has somewhere to stand. */
export const DIFF_CONTEXT = 2;

/** The longest common subsequence of two line arrays, as pairs of indices. Plain O(n·m) dynamic
 *  programming: the inputs are code blocks, bounded above by DIFF_MAX_LINES, and a cleverer algorithm here
 *  would be complexity spent on a case that cannot arise. */
function lcs(a: string[], b: string[]): [number, number][] {
    const n = a.length, m = b.length;
    // (n+1)·(m+1) of lengths. Rows are Int32Array so a 400×400 table is 640KB rather than a megabyte of
    // boxed numbers.
    const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: [number, number][] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
    }
    return out;
}

/** The full row-by-row alignment of two texts — every line, nothing elided. `collapse` is what turns this
 *  into something readable; kept apart so the elision is testable on its own. */
export function diffLines(before: string, after: string): DiffRow[] {
    const a = before.split("\n"), b = after.split("\n");
    const keep = lcs(a, b);
    const rows: DiffRow[] = [];
    let i = 0, j = 0;
    for (const [ai, bj] of keep) {
        // Deletions before additions, so a REPLACED line reads as the old one struck out and the new one
        // under it — which is what a replacement looks like, and it is by far the common case here.
        while (i < ai) { rows.push({ kind: "del", text: a[i], a: i + 1 }); i++; }
        while (j < bj) { rows.push({ kind: "add", text: b[j], b: j + 1 }); j++; }
        rows.push({ kind: "same", text: a[ai], a: ai + 1, b: bj + 1 });
        i = ai + 1; j = bj + 1;
    }
    while (i < a.length) { rows.push({ kind: "del", text: a[i], a: i + 1 }); i++; }
    while (j < b.length) { rows.push({ kind: "add", text: b[j], b: j + 1 }); j++; }
    return rows;
}

/** Replace long runs of unchanged lines with a `gap`. A diff of two thirty-line scripts that differ in one
 *  place must SHOW that place, not bury it in twenty-nine rows the reader has already read once. A run only
 *  collapses when it is longer than the context it would leave behind — eliding two lines to say "2 lines
 *  skipped" is strictly worse than printing them. */
export function collapse(rows: DiffRow[], context = DIFF_CONTEXT): DiffRow[] {
    const changed = rows.map((r) => r.kind === "add" || r.kind === "del");
    const keep = rows.map((_, i) =>
        changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
    const out: DiffRow[] = [];
    let run = 0;
    for (let i = 0; i < rows.length; i++) {
        if (keep[i]) {
            if (run) { out.push({ kind: "gap", skipped: run }); run = 0; }
            out.push(rows[i]);
        } else run++;
    }
    if (run) out.push({ kind: "gap", skipped: run });
    // A gap that saves nothing is noise. Undo any that stand for fewer lines than they cost to say.
    return out.flatMap((r, k) => {
        if (r.kind !== "gap" || r.skipped > 1) return [r];
        // Recover the lines this gap replaced, in order, from the original rows.
        const before = out.slice(0, k).reduce((n, x) => n + (x.kind === "gap" ? x.skipped : 1), 0);
        return rows.slice(before, before + r.skipped);
    });
}

/** What a diff amounts to, for a header that has to say it in a few words before anyone reads the rows. */
export const diffStat = (rows: DiffRow[]): { added: number; removed: number } => ({
    added: rows.filter((r) => r.kind === "add").length,
    removed: rows.filter((r) => r.kind === "del").length,
});

/** The whole thing: align, then elide. Null when there is nothing to show — identical texts, or a pair too
 *  big to be worth diffing — so a caller renders NOTHING rather than an empty panel implying it looked and
 *  found nothing when it never looked. */
export function codeDiff(before: string, after: string, context = DIFF_CONTEXT): DiffRow[] | null {
    if (before === after) return null;
    const a = before.split("\n").length, b = after.split("\n").length;
    if (a > DIFF_MAX_LINES || b > DIFF_MAX_LINES) return null;
    return collapse(diffLines(before, after), context);
}
