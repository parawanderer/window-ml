// geometry-check.ts — what the worker accepts from a run page's answer to a geometry question: every reply rebuilt field by field, or refused whole.

// A worker vision host (worker-vision-host.ts) asks the run's page where things are (vision-host.ts `Geometry`), and the
// page's answer is the page's word: a hostile page writes whatever it likes into it. Nothing in a reply is read as
// sent. Each op's reply is REBUILT here from the fields that op has, each checked: numbers finite and clamped, sizes not
// negative, enums one of theirs, text cut to its cap with control characters folded to a space, selectors and tokens
// refused rather than cut (a shortened selector is another selector), lists no longer than their cap, mark ids
// renumbered in the order given. A part that is malformed refuses the WHOLE reply: a body is never handed half of one.
// What a page can still do is lie within those bounds, as it can by changing its DOM.

import type { GeoBox, GeoMark, GeoOpaque, GeoPoint, GeoRect, GeoView, MarksReply, MintReply, SnapReply, CellReply, StitchBegin, StitchTile, TargetReply } from "../tools/vision-host";
import { LEGEND_CAPS, LEGEND_NAME_MAX, LEGEND_TEXT_MAX, type LegendBoundary, type RegionLegend } from "../dom/legend";
import { POINT_RE, BOX_RE } from "../util";

/** The ops a worker may ask a page, exactly the `Geometry` interface's members. */
export const GEOMETRY_OPS = ["view", "target", "marks", "snap", "cell", "mint", "legend", "crossesText", "focus", "stitchBegin", "stitchTile", "stitchEnd"] as const;

/** One geometry op's name. */
export type GeoOp = typeof GEOMETRY_OPS[number];

/** The largest magnitude a coordinate or count may have; past it the value is clamped. */
export const GEO_MAX = 1e5;
/** The largest viewport side (CSS px) a page may report. */
export const VIEW_MAX = 16384;
/** The largest device pixel ratio a page may report. */
export const DPR_MAX = 8;
/** The most marks one reply may carry, per op: a Set-of-Marks sweep, a snapped grounding box, a grid cell. */
export const MARK_CAPS = { marks: 150, snap: 12, cell: 20 } as const;
/** The longest a page string may be once cut, by what it is. Selectors are refused past theirs, not cut. */
export const TEXT_CAPS = { name: 200, role: 50, selector: 1000, msg: 300, line: 200, legendName: LEGEND_NAME_MAX, legendText: LEGEND_TEXT_MAX } as const;
/** The most screens a full-page stitch covers (the page caps itself at eight; the worker holds it to that). */
export const STITCH_SCREENS = 8;

/** The most tiles a full-page stitch takes: eight screens, and one more for a scroll that lands short. */
export const STITCH_TILES = 9;

/** The most tiles a full-page stitch takes when the capture is shorter than the viewport: it steps by what a capture
 *  shows, never less than half a screen (ml-vision.ts `stitchVia`), so twice the screens, and one more. */
export const STITCH_TILES_SHORT = 2 * STITCH_SCREENS + 1;

/** The fixed sentence for a reply the worker would not read. Never says what was wrong: that is the page's to learn. */
export const GEOMETRY_REFUSED = "The page's answer about its layout was malformed, so it was not used.";
/** The sentence for a page that did not answer a layout question in time. */
export const GEOMETRY_SLOW = "The page did not answer a question about its layout in time, so nothing from it was used. Retry once the page settles.";
/** The sentence for a vision call whose page went away or changed document under it. */
export const GEOMETRY_MOVED = "The page changed while it was being looked at (it navigated, or was reloaded), so nothing from it was used. Look again.";
/** The sentence for a page that could not be reached at all. */
export const GEOMETRY_UNREACHABLE = "The page could not be asked about its layout, so nothing from it was used. Retry once the page settles.";

/** Thrown inside a rebuild to refuse the whole reply. */
class Malformed extends Error {}
const no = (): never => { throw new Malformed(); };

/** A finite number, clamped to ±{@link GEO_MAX}. */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(-GEO_MAX, Math.min(GEO_MAX, v)) : no());
/** A finite number that is not negative, clamped. */
const size = (v: unknown): number => { const n = num(v); return n < 0 ? no() : n; };
/** A whole number that is not negative, clamped. */
const count = (v: unknown): number => (Number.isInteger(v) ? size(v) : no());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : no());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : no());
const list = (v: unknown, cap: number): unknown[] => (Array.isArray(v) && v.length <= cap ? v : no());

/** Characters a page could use to start a line of its own in a tool's result, or to make one text read as another:
 *  every control character (C0, DEL, C1 with NEL), every format character (bidi overrides and isolates, zero-width
 *  joiners and spaces, the BOM) and the two Unicode line separators. */
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;
/** Display text: a string, control and format characters folded to one space, cut to `cap`. */
const text = (v: unknown, cap: number): string => (typeof v === "string" ? v.replace(CONTROL, " ").slice(0, cap) : no());
/** A selector: a string with no control or format character and no backtick (the legend's own code quote), refused
 *  past its cap. Refused rather than folded: a changed selector is another selector. */
const selector = (v: unknown): string => (typeof v === "string" && v.length <= TEXT_CAPS.selector && !/[\p{Cc}\p{Cf}\u2028\u2029`]/u.test(v) ? v : no());
/** What an ARIA role (or a tag name) looks like. */
const ROLE = /^[a-z][a-z0-9-]{0,49}$/;
/** A role, printed bare as `[role]` in locate's result: held to a role token, lower-cased; anything else (a page's free
 *  text in its role attribute) is shown as "generic", ARIA's word for no particular role. */
const role = (v: unknown): string => { const r = text(v, TEXT_CAPS.role + 1).toLowerCase(); return ROLE.test(r) ? r : "generic"; };
/** A token matching `re` exactly. */
const token = (v: unknown, re: RegExp): string => (typeof v === "string" && re.test(v) ? v : no());

/** A rect: six finite numbers, sizes not negative, and its edges agreeing with its size to a pixel. */
function rect(v: unknown): GeoRect {
    const r = obj(v);
    const out = { left: num(r.left), top: num(r.top), right: num(r.right), bottom: num(r.bottom), width: size(r.width), height: size(r.height) };
    if (Math.abs(out.right - out.left - out.width) > 1 || Math.abs(out.bottom - out.top - out.height) > 1) no();
    return out;
}
/** A box by its edges, right of its left and below its top. */
function box(v: unknown): GeoBox {
    const b = obj(v);
    const out = { left: num(b.left), top: num(b.top), right: num(b.right), bottom: num(b.bottom) };
    return out.right < out.left || out.bottom < out.top ? no() : out;
}
function point(v: unknown): GeoPoint { const p = obj(v); return { x: num(p.x), y: num(p.y) }; }
/** An opaque surface's point and kind, or null. */
function opaque(v: unknown): GeoOpaque | null {
    if (v === null) return null;
    const o = obj(v);
    const kind = o.kind === "canvas" || o.kind === "iframe" || o.kind === "shadow" ? o.kind : no();
    return { x: num(o.x), y: num(o.y), kind };
}
/** A mark list, at most `cap` long, ids renumbered 1..n in the order given and the page's `ref` dropped (it names a
 *  page element, which means nothing here). */
function marks(v: unknown, cap: number): GeoMark[] {
    return list(v, cap).map((m, i) => {
        const x = obj(m);
        return { ref: 0, id: i + 1, role: role(x.role), name: text(x.name, TEXT_CAPS.name), selector: selector(x.selector), rect: rect(x.rect) };
    });
}

function view(v: unknown): GeoView {
    const r = obj(v);
    const side = (n: unknown): number => (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= VIEW_MAX ? n as number : no());
    const dpr = typeof r.dpr === "number" && Number.isFinite(r.dpr) && r.dpr > 0 && r.dpr <= DPR_MAX ? r.dpr : no();
    return { w: side(r.w), h: side(r.h), dpr, sx: num(r.sx), sy: num(r.sy) };
}

function target(v: unknown): TargetReply {
    const r = obj(v);
    if ("rect" in r) return { rect: rect(r.rect) };
    if ("point" in r) return { point: point(r.point) };
    if ("box" in r) return { box: box(r.box) };
    if (r.err === "selector") return { err: "selector", msg: text(r.msg, TEXT_CAPS.msg) };
    if (r.err === "nomatch") return { err: "nomatch", count: count(r.count) };
    if (r.err === "token" || r.err === "nofocus") return { err: r.err };
    return no();
}

function legendBoundary(v: unknown): LegendBoundary {
    const b = obj(v);
    const n = count(b.count);
    if (n < 1) no();
    if (b.kind === "shadow") return { kind: "shadow", count: n, closed: bool(b.closed) };
    if (b.kind !== "cross-frames" && b.kind !== "same-frames") no();
    // The page names the first three of `count` frames: exactly that many, so "…" is never steered by the list's length.
    const sels = list(b.selectors, LEGEND_CAPS.frames).map(selector);
    if (sels.length !== Math.min(n, LEGEND_CAPS.frames)) no();
    return { kind: b.kind as "cross-frames" | "same-frames", count: n, selectors: sels };
}

function legend(v: unknown): RegionLegend {
    const r = obj(v);
    const controls = list(r.controls, LEGEND_CAPS.controls).map((x) => { const o = obj(x); return { name: text(o.name, TEXT_CAPS.legendName), role: role(o.role), selector: selector(o.selector) }; });
    const media = list(r.media, LEGEND_CAPS.media).map((x) => {
        const o = obj(x);
        const kind: "img" | "canvas" = o.kind === "img" || o.kind === "canvas" ? o.kind : no();
        return { kind, name: kind === "canvas" ? "" : text(o.name, TEXT_CAPS.legendName), selector: selector(o.selector) };
    });
    const boundaries = list(r.boundaries, 3).map(legendBoundary);
    if (new Set(boundaries.map((b) => b.kind)).size !== boundaries.length) no();
    return {
        controls,
        media,
        boundaries,
        text: list(r.text, LEGEND_CAPS.text).map((x) => { const o = obj(x); return { text: text(o.text, TEXT_CAPS.legendText), selector: selector(o.selector) }; }),
        moreControls: count(r.moreControls),
        moreMedia: count(r.moreMedia),
    };
}

/** What the worker knows of the op it asked, for the replies bounded by the question: the badge count of a `marks`
 *  sweep, whether a `mint` was of a point or a box, and the current stitch's height for a tile. */
export interface GeoAsked { badge?: number; mint?: "pt" | "box"; total?: number }

/**
 * Rebuild one geometry reply from the page, or refuse it.
 * @param op the op that was asked
 * @param reply what the page answered
 * @param asked what bounds the reply by the question (see {@link GeoAsked})
 * @returns `{ ok: true, value }` with the rebuilt reply (extra fields dropped), or `{ ok: false }` when any part of it
 *   was malformed
 */
export function checkGeometry(op: GeoOp, reply: unknown, asked: GeoAsked = {}): { ok: true; value: unknown } | { ok: false } {
    try { return { ok: true, value: rebuild(op, reply, asked) }; }
    catch (e) { if (e instanceof Malformed) return { ok: false }; throw e; }
}

function rebuild(op: GeoOp, reply: unknown, asked: GeoAsked): unknown {
    switch (op) {
        case "view": return view(reply);
        case "target": return target(reply);
        case "marks": {
            const r = obj(reply);
            const ms = marks(r.marks, Math.min(MARK_CAPS.marks, asked.badge ?? MARK_CAPS.marks));
            const total = count(r.total);
            const out: MarksReply = { total: total < ms.length ? no() : total, marks: ms, allOpaque: bool(r.allOpaque), opaque: opaque(r.opaque) };
            return out;
        }
        case "snap": { const r = obj(reply); const out: SnapReply = { opaque: opaque(r.opaque), marks: marks(r.marks, MARK_CAPS.snap) }; return out; }
        case "cell": { const r = obj(reply); const out: CellReply = { marks: marks(r.marks, MARK_CAPS.cell), opaque: opaque(r.opaque) }; return out; }
        case "mint": {
            const r = obj(reply);
            if (asked.mint === "box") { if (r.dup !== undefined) no(); return { token: token(r.token, BOX_RE) } satisfies MintReply; }
            const out: MintReply = { token: token(r.token, POINT_RE) };
            if (r.dup !== undefined) { const d = obj(r.dup); out.dup = { token: token(d.token, POINT_RE), x: num(d.x), y: num(d.y) }; }
            return out;
        }
        case "legend": return legend(reply);
        case "crossesText": return bool(reply);
        case "focus": {
            if (reply === null) return null;
            const r = obj(reply);
            return { rect: rect(r.rect), line: text(r.line, TEXT_CAPS.line) };
        }
        case "stitchBegin": {
            const r = obj(reply);
            const vh = Number.isInteger(r.vh) && (r.vh as number) >= 1 && (r.vh as number) <= VIEW_MAX ? r.vh as number : no();
            const total = size(r.total);
            if (total < 1 || total > STITCH_SCREENS * vh) no();
            const dpr = typeof r.dpr === "number" && Number.isFinite(r.dpr) && r.dpr > 0 && r.dpr <= DPR_MAX ? r.dpr : no();
            const out: StitchBegin = { total, vh, startY: num(r.startY), dpr };
            return out;
        }
        case "stitchTile": {
            const r = obj(reply);
            const actualY = size(r.actualY);
            if (asked.total === undefined || actualY > asked.total) no();
            const out: StitchTile = { actualY, isLast: bool(r.isLast) };
            return out;
        }
        case "stitchEnd": return reply === undefined || reply === null ? undefined : no();
        default: return no();
    }
}
