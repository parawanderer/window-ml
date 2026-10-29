// pdf-measure.ts — what one PDF page holds, as numbers: usable text, how much of the page images and drawn paths cover,
// invisible text.
//
// Pure: it reads pdf.js's `textContent` items and operator list (`fnArray`/`argsArray`) and returns a `PageMeasure`;
// it imports nothing from pdf.js (the operator numbers come in as a table), so it runs in node tests on made-up lists.
// `pdf-classify.ts` turns the numbers into a verdict; `pdf-read.ts` calls both.

/** pdf.js's `OPS` table, by name. Only the entries this file reads are looked up; a name the build lacks is skipped. */
export type OpsTable = Readonly<Record<string, number>>;

/** A text item as pdf.js's `getTextContent()` returns it (marked-content items carry no `str`). */
export interface TextItemLike { str?: string; hasEOL?: boolean }

/** The numbers measured on one page. Shares are 0..1 of the page's area; counts are of non-whitespace characters. */
export interface PageMeasure {
    /** Characters of the text layer that are neither whitespace nor broken. */
    usableChars: number;
    /** Characters of the text layer that are broken: U+FFFD, private use, C0/C1 controls. */
    brokenChars: number;
    /** `brokenChars` over both, 0 when the layer is empty. */
    brokenRatio: number;
    /** Share of the page area covered by the union of every drawn image, clipped to the page. */
    imageCover: number;
    /** Share of the page the single largest image covers on its own. */
    largestImage: number;
    /** Whether one image alone covers `FULL_PAGE_COVER` of the page. */
    fullPageImage: boolean;
    /** How many image paints were counted. */
    images: number;
    /** Share of the page covered by the union of every filled or stroked path's box: vector drawing (charts, diagrams,
     *  rules, shaded cells). A path whose box alone covers `FULL_PAGE_COVER` is a page background and is left out. */
    pathCover: number;
    /** Share of the page covered by images and paths together: the union of both. */
    drawnCover: number;
    /** How many path paints were counted (page backgrounds included). */
    paths: number;
    /** Glyphs shown with a visible text render mode (0 to 2, 4 to 6) and with an invisible one (3 and 7). */
    visibleGlyphs: number;
    invisibleGlyphs: number;
    /** `invisibleGlyphs` over both, 0 when no glyph was shown. */
    invisibleShare: number;
    /** Operators in the page's list, and whether the walk stopped at `OP_CAP`. */
    ops: number;
    opsCapped: boolean;
}

/** The walk reads at most this many operators of a page: a crafted page cannot make it run for ever. */
export const OP_CAP = 200_000;
/** At most this many image paints are rasterised into the union; the rest are counted and ignored. */
export const IMAGE_CAP = 2_000;
/** At most this many path paints are rasterised into the union; the rest are counted and ignored. */
export const PATH_CAP = 2_000;
/** At most this many glyph objects are visited when telling visible text from invisible. */
export const GLYPH_CAP = 2_000_000;
/** At most this many characters of text are examined for broken ones; a page past it is judged on its first part. */
export const TEXT_SCAN_CAP = 2_000_000;
/** The union is computed on a GRID x GRID sample of the page: 1/128 of the page is the resolution, under 1% per edge. */
export const GRID = 128;
/** One image alone covering this share of the page is "a full-page image": scanners crop a little, so not 1. */
export const FULL_PAGE_COVER = 0.9;

/** Control characters, U+FFFD and private use (BMP and both supplementary planes); whitespace controls are not broken. */
const BROKEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F�-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
const BROKEN_G = new RegExp(BROKEN.source, "gu");
const PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/** The usable and broken character counts of the text items (non-whitespace characters only). */
export function measureText(items: readonly TextItemLike[]): { usableChars: number; brokenChars: number; brokenRatio: number } {
    let usable = 0, broken = 0, seen = 0;
    for (const it of items) {
        const s = it.str;
        if (!s) continue;
        const nonSpace = s.replace(/\s/gu, "");
        const b = nonSpace.match(BROKEN_G)?.length ?? 0;
        // Characters, not UTF-16 units: a surrogate pair is one.
        const chars = nonSpace.length - (nonSpace.match(PAIR)?.length ?? 0);
        broken += b;
        usable += chars - b;
        seen += s.length;
        if (seen > TEXT_SCAN_CAP) break;
    }
    return { usableChars: usable, brokenChars: broken, brokenRatio: usable + broken ? broken / (usable + broken) : 0 };
}

/** The page's text, one line per `hasEOL`, with the broken characters dropped and cut to `cap` characters. */
export function pageText(items: readonly TextItemLike[], cap: number): { text: string; truncated: boolean } {
    const out: string[] = [];
    let n = 0;
    for (const it of items) {
        if (typeof it.str !== "string") continue;
        const piece = it.str.replace(BROKEN_G, "") + (it.hasEOL ? "\n" : "");
        if (n + piece.length > cap) { out.push(piece.slice(0, cap - n)); return { text: out.join(""), truncated: true }; }
        out.push(piece);
        n += piece.length;
    }
    return { text: out.join("").trim(), truncated: false };
}

/** A PDF matrix `[a b c d e f]`, row-vector convention: a point `(x, y)` maps to `(a x + c y + e, b x + d y + f)`. */
export type Matrix = readonly [number, number, number, number, number, number];
/** The matrix that moves nothing: where every page's walk starts. */
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n`: the matrix that applies `m` first (what `cm` does to the current matrix: `multiply(cm, ctm)`). */
export function multiply(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
}

/** An arguments array (plain, typed, or pdf.js's array-like) as a matrix, or null if it is not six finite numbers. */
function asMatrix(a: unknown): Matrix | null {
    if (!a || typeof a !== "object") return null;
    const m = [0, 1, 2, 3, 4, 5].map((i) => Number((a as ArrayLike<number>)[i]));
    return m.every(Number.isFinite) ? (m as unknown as Matrix) : null;
}

/** The corners of the unit square through `m`, the shape an image paint draws. */
export function unitSquareThrough(m: Matrix): [number, number][] {
    return ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as [number, number]);
}

/** An axis-aligned box `[x0, y0, x1, y1]` (pdf.js's path `minMax`) as the matrix that maps the unit square onto it. */
export function boxMatrix(b: ArrayLike<number>): Matrix | null {
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => Number(b[i]));
    return [x0, y0, x1, y1].every(Number.isFinite) ? [x1 - x0, 0, 0, y1 - y0, x0, y0] : null;
}

/** The cells of a GRID x GRID sample of `view` that the unit square through `m` covers (indices into the grid). */
function coveredCells(m: Matrix, view: readonly [number, number, number, number]): number[] {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return [];
    const [x0, y0, x1, y1] = view;
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 0) || !(h > 0)) return [];
    const corners = unitSquareThrough(m);
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const i0 = Math.max(0, Math.floor(((Math.min(...xs) - x0) / w) * GRID)), i1 = Math.min(GRID - 1, Math.ceil(((Math.max(...xs) - x0) / w) * GRID));
    const j0 = Math.max(0, Math.floor(((Math.min(...ys) - y0) / h) * GRID)), j1 = Math.min(GRID - 1, Math.ceil(((Math.max(...ys) - y0) / h) * GRID));
    // Cell centre -> page point -> back through the inverse into the unit square: inside it iff 0..1 on both axes.
    const ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det;
    const ie = (m[2] * m[5] - m[3] * m[4]) / det, iff = (m[1] * m[4] - m[0] * m[5]) / det;
    const cells: number[] = [];
    for (let j = j0; j <= j1; j++) {
        const py = y0 + ((j + 0.5) / GRID) * h;
        for (let i = i0; i <= i1; i++) {
            const px = x0 + ((i + 0.5) / GRID) * w;
            const u = ia * px + ic * py + ie, v = ib * px + id * py + iff;
            if (u >= 0 && u <= 1 && v >= 0 && v <= 1) cells.push(j * GRID + i);
        }
    }
    return cells;
}

/** What the operator walk finds: the image and path unions, and the glyphs by visibility. */
export interface OpsMeasure {
    imageCover: number; largestImage: number; fullPageImage: boolean; images: number;
    pathCover: number; drawnCover: number; paths: number;
    visibleGlyphs: number; invisibleGlyphs: number; invisibleShare: number;
    ops: number; opsCapped: boolean;
}

/** Whether a text render mode draws nothing: 3 (neither fill nor stroke) and 7 (clip only). */
const invisibleMode = (mode: number): boolean => mode === 3 || mode === 7;

/** How many glyphs a show operator's argument holds (a glyph array, or the spaced form mixing numbers in). */
function glyphCount(arg: unknown, budget: { left: number }): number {
    if (!arg || typeof arg !== "object") return 0;
    const list = arg as ArrayLike<unknown>;
    let n = 0;
    for (let i = 0; i < list.length && budget.left > 0; i++, budget.left--) {
        const g = list[i];
        if (g && typeof g === "object" && !(g as { isSpace?: boolean }).isSpace) n++;
    }
    return n;
}

/**
 * Walk a page's operator list: track the current matrix and text render mode through `save`/`restore`, `transform` and
 * form XObjects, rasterise every image paint's box (the unit square through the matrix) into one coverage grid clipped
 * to `view`, every filled or stroked path's box into a second, and count glyphs shown under each render mode. Stops at
 * `OP_CAP` operators.
 *
 * Paths are read as pdf.js 6 emits them: one `constructPath` per painted path, `[paintOp, [buffer], minMax]`, the box
 * in the current user space. A path's BOX is what counts, so a stroked frame covers what it encloses and a straight
 * rule (a box of no area) covers nothing. `endPath` paints nothing (a clip) and is skipped. A `shadingFill` (`sh`, a
 * gradient) paints the current clip, so the box of the last clip path is tracked through `save`/`restore` and counted as
 * one path; with no clip it is the whole page, a background.
 *
 * Not tracked: clip paths (an image clipped small still counts whole), a form's own /BBox, fill colour (a white
 * rectangle counts), and `paintSolidColorImageMask` (a filled rectangle, not a picture).
 */
export function measureOps(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, OPS: OpsTable, view: readonly [number, number, number, number]): OpsMeasure {
    const total = fnArray.length;
    const n = Math.min(total, OP_CAP);
    const grid = new Uint8Array(GRID * GRID), pathGrid = new Uint8Array(GRID * GRID);
    let ctm: Matrix = IDENTITY, mode = 0, images = 0, largest = 0, covered = 0, visible = 0, invisible = 0;
    let paths = 0, pathCovered = 0;
    let clipBox: Matrix | null = null, clipping = false;
    const stack: { ctm: Matrix; mode: number; clipBox: Matrix | null }[] = [];
    const budget = { left: GLYPH_CAP };
    const is = (name: string) => OPS[name];
    const save = is("save"), restore = is("restore"), transform = is("transform"), formBegin = is("paintFormXObjectBegin"), formEnd = is("paintFormXObjectEnd");
    const tr = is("setTextRenderingMode");
    const imageOps = new Set(["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject"].map(is));
    const repeatOp = is("paintImageXObjectRepeat"), maskRepeatOp = is("paintImageMaskXObjectRepeat");
    const maskGroupOp = is("paintImageMaskXObjectGroup"), inlineGroupOp = is("paintInlineImageXObjectGroup");
    const showOps = new Set(["showText", "showSpacedText", "nextLineShowText"].map(is));
    const showOpsSpaced = is("nextLineSetSpacingShowText");
    const pathOp = is("constructPath"), clipOps = new Set(["clip", "eoClip"].map(is)), shadingOp = is("shadingFill");
    const pathPaints = new Set(["fill", "eoFill", "stroke", "closeStroke", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"].map(is));
    const background = FULL_PAGE_COVER * GRID * GRID;

    /** Rasterise one box into the union. */
    const paint = (m: Matrix) => {
        images++;
        if (images > IMAGE_CAP) return;
        const cells = coveredCells(m, view);
        if (cells.length > largest) largest = cells.length;
        for (const c of cells) if (!grid[c]) { grid[c] = 1; covered++; }
    };
    /** Rasterise one path's box into the path union, unless it is the page's background. */
    const paintPath = (m: Matrix) => {
        paths++;
        if (paths > PATH_CAP) return;
        const cells = coveredCells(m, view);
        if (cells.length >= background) return;
        for (const c of cells) if (!pathGrid[c]) { pathGrid[c] = 1; pathCovered++; }
    };

    for (let i = 0; i < n; i++) {
        const fn = fnArray[i], args = argsArray[i] as unknown[] | undefined;
        if (fn === save) stack.push({ ctm, mode, clipBox });
        else if (fn === restore) { const s = stack.pop(); if (s) { ctm = s.ctm; mode = s.mode; clipBox = s.clipBox; } clipping = false; }
        else if (fn === transform) { const m = asMatrix(args); if (m) ctm = multiply(m, ctm); }
        else if (fn === formBegin) { stack.push({ ctm, mode, clipBox }); const m = asMatrix(args?.[0]); if (m) ctm = multiply(m, ctm); }
        else if (fn === formEnd) { const s = stack.pop(); if (s) { ctm = s.ctm; mode = s.mode; clipBox = s.clipBox; } clipping = false; }
        else if (fn === tr) mode = Number(args?.[0]) || 0;
        else if (imageOps.has(fn)) paint(ctm);
        else if (clipOps.has(fn)) clipping = true;
        else if (fn === pathOp && args) {
            // The path a clip operator precedes becomes the clip, whatever paints it (`W n` is the usual form).
            const b = args[2] ? boxMatrix(args[2] as ArrayLike<number>) : null;
            if (clipping) { clipping = false; if (b) clipBox = multiply(b, ctm); }
            if (b && pathPaints.has(Number(args[0]))) paintPath(multiply(b, ctm));
        } else if (fn === shadingOp) paintPath(clipBox ?? [view[2] - view[0], 0, 0, view[3] - view[1], view[0], view[1]]);
        else if (fn === repeatOp && args) {
            const [, sx, sy, pos] = args as [unknown, number, number, ArrayLike<number>];
            for (let k = 0; pos && k + 1 < pos.length && k < 2 * IMAGE_CAP + 2; k += 2) paint(multiply([sx, 0, 0, sy, pos[k], pos[k + 1]], ctm));
        } else if (fn === maskRepeatOp && args) {
            const [, sx, kx, ky, sy, pos] = args as [unknown, number, number, number, number, ArrayLike<number>];
            for (let k = 0; pos && k + 1 < pos.length && k < 2 * IMAGE_CAP + 2; k += 2) paint(multiply([sx, kx || 0, ky || 0, sy, pos[k], pos[k + 1]], ctm));
        } else if (fn === maskGroupOp && args) {
            const imgs = args[0] as ArrayLike<{ transform?: unknown }> | undefined;
            for (let k = 0; imgs && k < imgs.length && k < IMAGE_CAP + 1; k++) { const m = asMatrix(imgs[k]?.transform); if (m) paint(multiply(m, ctm)); }
        } else if (fn === inlineGroupOp && args) {
            const map = args[1] as ArrayLike<{ transform?: unknown }> | undefined;
            for (let k = 0; map && k < map.length && k < IMAGE_CAP + 1; k++) { const m = asMatrix(map[k]?.transform); if (m) paint(multiply(m, ctm)); }
        } else if (showOps.has(fn) || fn === showOpsSpaced) {
            const g = glyphCount(fn === showOpsSpaced ? args?.[2] : args?.[0], budget);
            if (invisibleMode(mode)) invisible += g; else visible += g;
        }
    }
    const shown = visible + invisible;
    let drawn = 0;
    for (let c = 0; c < GRID * GRID; c++) if (grid[c] || pathGrid[c]) drawn++;
    return {
        imageCover: covered / (GRID * GRID), largestImage: largest / (GRID * GRID), fullPageImage: largest / (GRID * GRID) >= FULL_PAGE_COVER,
        images, pathCover: pathCovered / (GRID * GRID), drawnCover: drawn / (GRID * GRID), paths,
        visibleGlyphs: visible, invisibleGlyphs: invisible, invisibleShare: shown ? invisible / shown : 0,
        ops: total, opsCapped: total > OP_CAP,
    };
}

/** Everything measured about one page: its text layer and its operator list. */
export function measurePage(input: { items: readonly TextItemLike[]; fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown>; OPS: OpsTable; view: readonly [number, number, number, number] }): PageMeasure {
    return { ...measureText(input.items), ...measureOps(input.fnArray, input.argsArray, input.OPS, input.view) };
}
