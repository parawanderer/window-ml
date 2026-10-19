// frames-lib.mjs — the pure parts of the frame recorder (scripts/frames.mjs): which frames a contact sheet shows, its grid, and the one-line-per-change summary.

/**
 * Pick up to `max` indices out of `n`, evenly spaced, always including the first and the last.
 * @param {number} n how many frames exist
 * @param {number} max the most to pick
 * @returns {number[]} ascending, distinct indices
 */
export function pickEvenly(n, max) {
    if (n <= 0 || max <= 0) return [];
    if (n <= max) return Array.from({ length: n }, (_, i) => i);
    if (max === 1) return [0];
    return [...new Set(Array.from({ length: max }, (_, i) => Math.round((i * (n - 1)) / (max - 1))))];
}

/**
 * The columns and rows of a contact sheet for `count` frames: wide frames (desktop) get fewer columns than tall ones (phone), so the sheet stays readable at a glance.
 * @param {number} count
 * @param {number} frameW
 * @param {number} frameH
 * @returns {{ cols: number, rows: number }}
 */
export function gridFor(count, frameW, frameH) {
    if (count <= 0) return { cols: 0, rows: 0 };
    const cols = Math.min(count, frameW >= frameH ? 4 : 8);
    return { cols, rows: Math.ceil(count / cols) };
}

/**
 * @typedef {{ t: number, scrollTop: number, scrollHeight: number, msgs: number, anims: { name: string, target: string }[], watch?: Record<string, { rect: number[], opacity: string, transform: string }[]> }} FrameRow
 */

/** A stable key for the set of running animations, so two frames with the same ones compare equal. */
const animKey = (/** @type {FrameRow} */ r) => (r.anims || []).map((a) => `${a.name}@${a.target}`).sort().join(",");
const watchKey = (/** @type {FrameRow} */ r) => JSON.stringify(r.watch || {});

/**
 * The frames worth a line: the first, and each where the message count, the scroller's position or height, the set of running animations, or a watched element changed against the frame before.
 * @param {FrameRow[]} rows
 * @returns {string[]} one line per changed frame, naming what changed
 */
export function summarize(rows) {
    const out = [];
    let prev = null;
    for (const r of rows) {
        const what = [];
        if (!prev) what.push("first");
        else {
            if (r.msgs !== prev.msgs) what.push(`msgs ${prev.msgs}->${r.msgs}`);
            if (r.scrollTop !== prev.scrollTop) what.push(`scrollTop ${prev.scrollTop}->${r.scrollTop}`);
            if (r.scrollHeight !== prev.scrollHeight) what.push(`scrollHeight ${prev.scrollHeight}->${r.scrollHeight}`);
            if (animKey(r) !== animKey(prev)) what.push(`anims [${animKey(r)}]`);
            if (watchKey(r) !== watchKey(prev)) what.push("watch " + watchKey(r));
        }
        if (what.length) out.push(`t=${String(Math.round(r.t)).padStart(5)}ms  ${what.join("  ")}`);
        prev = r;
    }
    return out;
}
