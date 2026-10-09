// Region LEGEND — a textual index of the DOM inside a screenshot's crop, appended to `look` and every
// verify crop. It bridges vision→DOM: the model SEES the pixels and gets the SELECTORS (and boundary
// flags) to act on them — no second round-trip — and for a verify crop it names what just APPEARED.
// Pure DOM enumeration over a viewport box; testable standalone. Grouped lines, omitted when empty.
import { clickSelector, viewportRect, frameOffsetOf, sameOriginFrameDoc, deepQueryAll, truncate } from "./dom";
import { INTERACTIVE_SEL, accessibleName, roleOf, styleHidden, isFaded } from "./a11y";

export interface Box { left: number; top: number; right: number; bottom: number; }

// Caps — keep the legend a scannable heuristic, never a DOM dump.
const MAX_CONTROLS = 10, MAX_MEDIA = 5, MAX_TEXT = 5, MAX_FRAMES = 3, TOTAL_BUDGET = 10;
// Text anchoring targets the on-screen strings models misread (values, labels, headings, cells). The
// anchor is CLIPPED to the crop (see visibleText) and capped at PROSE_LEN with a trailing …; a run shorter
// than MIN_ANCHOR (once … is stripped) is too cut off to bother with. The whole group is skipped on a WIDE
// crop (a viewport/orientation shot — "everything is in the box" would anchor the entire page).
// PROSE_LEN caps a single anchor's displayed length (a long visible run truncates with …). PROSE_MAX skips
// an element whose FULL text is clearly a paragraph — anchoring even a clipped slice of prose is noise; the
// model reads prose from the image. MIN_ANCHOR drops a run too short to bother with (an edge sliver).
// MIN_VERT: a word must be at least this fraction inside the crop VERTICALLY to count. Horizontally we keep
// a word on any overlap (to complete a cut word), but a line the crop clips top/bottom — only a sliver of the
// letters showing — isn't readable, so it's dropped (the "only the bottom of the heading is in the crop" case).
const PROSE_LEN = 80, PROSE_MAX = 160, MIN_ANCHOR = 4, WIDE_FRAC = 0.55, MIN_VERT = 0.5;

const boxIntersects = (r: { left: number; top: number; right: number; bottom: number } | null, box: Box): boolean =>
    !!r && r.right > r.left && r.bottom > r.top && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
const rectOf = (el: Element): Box | null => { try { const r = viewportRect(el); return (r.width > 0 || r.height > 0) ? r : null; } catch { return null; } };
const shown = (el: Element): boolean => { try { return !styleHidden(el) && !isFaded(el); } catch { return true; } };

/**
 * The words of `text` whose glyphs fall inside `box`, joined — so an anchor quotes what's ACTUALLY IN the
 * crop, not the whole element. Word-granular: a word whose rect intersects the box is kept ENTIRE (completing
 * one the box cut through). A leading/trailing … marks text that spills past the crop; none when fully
 * contained. Case + spacing collapsed but PRESERVED (a value is case-sensitive). Pure (rects supplied) →
 * unit-testable without a layout engine. "" if nothing is in the box.
 */
export function clipVisibleText(text: string, words: { start: number; end: number; rect: Box }[], box: Box, maxLen = PROSE_LEN): string {
    // Kept if it overlaps horizontally (any — complete a cut word) AND is ≥ MIN_VERT inside vertically (a
    // line clipped top/bottom to a sliver is unreadable → dropped).
    const kept = (r: Box): boolean => {
        if (!(r.right > box.left && r.left < box.right)) return false;
        const h = r.bottom - r.top;
        return h > 0 && (Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) / h) >= MIN_VERT;
    };
    const inIdx = words.map((w, i) => (kept(w.rect) ? i : -1)).filter(i => i >= 0);
    if (!inIdx.length) return "";
    const first = inIdx[0], last = inIdx[inIdx.length - 1];
    let core = text.slice(words[first].start, words[last].end).replace(/\s+/g, " ").trim();
    let pre = first > 0, suf = last < words.length - 1;   // words exist before / after the visible span
    if (core.length > maxLen) { core = core.slice(0, maxLen).replace(/\s+\S*$/, "").trimEnd(); suf = true; }
    return (pre ? "…" : "") + core + (suf ? "…" : "");
}

/** clipVisibleText over an ELEMENT: builds a flat word list from ALL descendant text nodes (crosses inline
 *  spans, so no word is dropped) with each word's rendered rect (Range.getBoundingClientRect), then clips. */
function visibleText(el: Element, box: Box): string {
    const doc = el.ownerDocument;
    if (!doc) return "";
    // Range.getBoundingClientRect returns coords in the ELEMENT's OWN document — iframe-LOCAL for a
    // same-origin frame — but `box` is top-viewport. Add the frame offset (the same one viewportRect folds
    // in) so an iframe's text is measured against the crop correctly. {0,0} for a top-doc element.
    let ox = 0, oy = 0;
    try { ({ dx: ox, dy: oy } = frameOffsetOf(el)); } catch { /* detached — leave uncomposed */ }
    const range = doc.createRange();
    const words: { start: number; end: number; rect: Box }[] = [];
    let flat = "";
    const walk = (n: Node): void => {
        for (const c of Array.from(n.childNodes)) {
            if (c.nodeType === 3) {
                const txt = c.textContent || "", off = flat.length, re = /\S+/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(txt))) {
                    try { range.setStart(c, m.index); range.setEnd(c, m.index + m[0].length); } catch { continue; }
                    const r = range.getBoundingClientRect();
                    words.push({ start: off + m.index, end: off + m.index + m[0].length, rect: { left: r.left + ox, top: r.top + oy, right: r.right + ox, bottom: r.bottom + oy } });
                }
                flat += txt;
            } else if (c.nodeType === 1 && shown(c as Element)) walk(c);
        }
    };
    walk(el);
    return clipVisibleText(flat, words, box);
}

const TEXT_SEL = "p, h1, h2, h3, h4, h5, h6, li, td, th, dt, dd, blockquote, figcaption, label, caption, summary, code, pre, span, a, div";
const boundaryEl = (el: Element): boolean => el.tagName === "IFRAME" || el.tagName === "CANVAS";
// Guillemets « » (not " ) delimit a page LABEL so it's unambiguous when the text itself contains " or ' —
// e.g. «await ml.agent("…")». Selectors get backticks (they contain () like :nth-of-type(1) but never `).
/** The longest a legend label is, before its quotes: forty characters and an ellipsis. */
export const LEGEND_NAME_MAX = 41;
/** The longest a text anchor is: {@link PROSE_LEN} and an ellipsis at each end. */
export const LEGEND_TEXT_MAX = PROSE_LEN + 2;
/** What stands in for each delimiter a tool's result quotes page text with. */
const STAND_IN: Record<string, string> = { "«": "‹", "»": "›", "`": "'", "\"": "'" };

/**
 * A page string made safe to put between a tool result's own delimiters: each character of `delims` that appears in it
 * is replaced by a look-alike (« » by ‹ ›, ` and " by '), so the string cannot close its quote and write an entry, a
 * selector or a pick of its own. The one folding every result that quotes page text uses.
 * @param s the page's string
 * @param delims the delimiters the result quotes with (the legend's « » and `, by default)
 * @returns the string with those characters replaced
 */
export function foldDelimiters(s: string, delims = "«»`"): string {
    let out = "";
    for (const ch of s) out += delims.includes(ch) ? STAND_IN[ch] ?? " " : ch;
    return out;
}

/** A page string as it sits between the legend's own delimiters (« » and `). */
const inQuotes = (s: string): string => foldDelimiters(s);
const quote = (s: string): string => (s ? `«${inQuotes(s)}»` : "");
const imgName = (el: Element): string => { const src = el.getAttribute("src") || ""; const m = src.split("?")[0].split("/").pop() || ""; return m && !m.startsWith("data:") ? m : ""; };
/** A control as data: its accessible name cut to forty characters ("" for none), and the role (or tag) shown instead
 *  when it has no name. The legend quotes the name itself ({@link formatLegend}), never the page. */
const controlOf = (el: Element): { name: string; role: string } => {
    const n = accessibleName(el);
    return { name: n ? truncate(n, 40) : "", role: roleOf(el) || el.tagName.toLowerCase() };
};
/** The frames a boundary line names: at most three selectors, and "…" when there were more (`count`). */
const framesList = (sels: string[], count: number): string => sels.slice(0, MAX_FRAMES).map(s => `\`${s}\``).join(", ") + (count > Math.min(sels.length, MAX_FRAMES) ? ", …" : "");

/** The most a legend lists of each kind (and the most frame selectors one boundary names), which is also the most a
 *  page's legend may carry when the worker checks it (geometry-check.ts). */
export const LEGEND_CAPS = { controls: MAX_CONTROLS, media: MAX_MEDIA, text: MAX_TEXT, frames: MAX_FRAMES } as const;

/**
 * A structural boundary inside a legend's box, as DATA: the cross-origin iframes, the same-origin iframes (each with
 * how many there are and the first three selectors), or the shadow roots the listed controls and media sit in (how
 * many, and whether any is closed). {@link boundaryLine} phrases it; the page sends only this, so the sentence the
 * model reads in the tool's voice is always the extension's own.
 */
export type LegendBoundary =
    | { kind: "cross-frames"; count: number; selectors: string[] }
    | { kind: "same-frames"; count: number; selectors: string[] }
    | { kind: "shadow"; count: number; closed: boolean };

/** The sentence the model reads for one legend boundary: the one wording, wherever the legend was formatted. */
export function boundaryLine(b: LegendBoundary): string {
    const s = b.count > 1 ? "s" : "";
    if (b.kind === "cross-frames") return `⚠ ${b.count} cross-origin iframe${s} (${framesList(b.selectors, b.count)}) — no selector reaches inside; locate that selector → click the @pt`;
    if (b.kind === "same-frames") return `${b.count} same-origin iframe${s} (${framesList(b.selectors, b.count)}) — reach inside with \`<selector> >>> …\``;
    return `${b.count} ${b.closed ? "" : "open "}shadow root${s} — refs use \`host >>> …\``;
}

export interface RegionLegend {
    /** Each control's bare name ("" for none: its `role` is shown instead) and a selector. */
    controls: { name: string; role: string; selector: string }[];
    /** Each image or canvas: which it is, an image's bare alt text or file name ("" for none), and a selector. */
    media: { kind: "img" | "canvas"; name: string; selector: string }[];
    /** Structural notices (iframes, shadow roots), as data; {@link boundaryLine} phrases each. */
    boundaries: LegendBoundary[];
    text: { text: string; selector: string }[];
    moreControls: number;
    moreMedia: number;
}

/** Enumerate the notable DOM inside `box` (viewport coords). Cheap targeted queries + box-intersection,
 *  capped. Pierces OPEN/captured-CLOSED shadow (deepQueryAll) so shadow controls get their `>>>` refs. */
export function regionLegend(box: Box): RegionLegend {
    const root = document.body || document;
    // ---- controls (semantic + ARIA), deduped against nested controls, reading order ----
    const ctrlEls = deepQueryAll(INTERACTIVE_SEL, root).filter(el => shown(el) && boxIntersects(rectOf(el), box));
    const ctrlSet = new Set(ctrlEls);
    const controlsF = ctrlEls
        .filter(el => { for (let p = el.parentElement; p; p = p.parentElement) if (ctrlSet.has(p)) return false; return true; })
        .sort((a, b) => { const ra = rectOf(a)!, rb = rectOf(b)!; return (ra.top - rb.top) || (ra.left - rb.left); });
    const controls = controlsF.slice(0, MAX_CONTROLS).map(el => ({ ...controlOf(el), selector: clickSelector(el) }));

    // ---- media (img / canvas) ----
    const mediaEls = deepQueryAll("img, canvas", root).filter(el => shown(el) && boxIntersects(rectOf(el), box));
    const media = mediaEls.slice(0, MAX_MEDIA).map(el => ({
        ...(el.tagName === "CANVAS" ? { kind: "canvas" as const, name: "" } : { kind: "img" as const, name: truncate(el.getAttribute("alt") || imgName(el) || "", 40) }),
        selector: clickSelector(el),
    }));

    // ---- boundaries: iframes (same/cross-origin) with their ACTUAL selectors — for a cross-origin frame
    // this line is the ONLY place its selector appears (it contributes nothing to controls/text) ----
    const boundaries: LegendBoundary[] = [];
    const framed = deepQueryAll("iframe", root).filter(el => boxIntersects(rectOf(el), box)).map(el => ({ same: !!sameOriginFrameDoc(el), sel: clickSelector(el) }));
    const cross = framed.filter(f => !f.same).map(f => f.sel), same = framed.filter(f => f.same).map(f => f.sel);
    if (cross.length) boundaries.push({ kind: "cross-frames", count: cross.length, selectors: cross.slice(0, MAX_FRAMES) });
    if (same.length) boundaries.push({ kind: "same-frames", count: same.length, selectors: same.slice(0, MAX_FRAMES) });
    // Shadow boundary — a byproduct of the collected items' roots (no extra full-DOM scan). The controls
    // already carry `>>>` refs, so this is just a "there's shadow here" flag, counted by mode.
    const shadowHosts = new Set<Element>(); let closed = false;
    for (const el of [...controlsF, ...mediaEls]) { const rn = el.getRootNode(); if (rn instanceof ShadowRoot) { shadowHosts.add(rn.host); if (rn.mode === "closed") closed = true; } }
    if (shadowHosts.size) boundaries.push({ kind: "shadow", count: shadowHosts.size, closed });

    // ---- text FILLER: short, mostly-visible strings only, and never on a wide/orientation crop ----
    const vwArea = typeof window !== "undefined" ? window.innerWidth * window.innerHeight : 0;
    const boxArea = Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
    const wide = vwArea > 0 && boxArea >= WIDE_FRAC * vwArea;
    const notable = controls.length + media.length + boundaries.length;
    const text: { text: string; selector: string }[] = [];
    if (!wide && notable < TOTAL_BUDGET) {
        const room = Math.min(MAX_TEXT, TOTAL_BUDGET - notable);
        const emitted = new Set<Element>();
        for (const el of deepQueryAll(TEXT_SEL, root)) {
            if (text.length >= room) break;
            if (!shown(el) || ctrlSet.has(el) || boundaryEl(el)) continue;
            if (!boxIntersects(rectOf(el), box)) continue;
            if ((el.textContent || "").replace(/\s+/g, " ").trim().length > PROSE_MAX) continue;   // a paragraph — read it from the image
            let nested = false; for (let p = el.parentElement; p; p = p.parentElement) if (emitted.has(p)) { nested = true; break; }
            if (nested) continue;
            // The VISIBLE text — flattened across inline spans (so no word is dropped), CLIPPED to the crop
            // (a … marks where it continues past the edge), case preserved. So it reads what's actually on
            // screen — cut where the image cuts — and a copy (sans …) into findByText still matches (it's a
            // contiguous substring of the flattened textContent, which is what findByText compares).
            const t = visibleText(el, box);
            if (t.replace(/…/g, "").length < MIN_ANCHOR) continue;   // empty / too little visible — too cut off
            text.push({ text: t, selector: clickSelector(el) });
            emitted.add(el);
        }
    }

    return { controls, media, boundaries, text, moreControls: Math.max(0, controlsF.length - MAX_CONTROLS), moreMedia: Math.max(0, mediaEls.length - MAX_MEDIA) };
}

/** Render a RegionLegend as grouped lines for the model — "" when there's nothing notable (suppress-empty).
 *  `seen` (a per-run set) dedups the BOUNDARIES line only: iframe/shadow notices are stable page facts, so
 *  re-appending the identical warning on every look/locate crop is noise — controls/media/text are
 *  crop-specific and never deduped. A genuinely new boundary (a different frame) still shows. */
export function formatLegend(lg: RegionLegend, seen?: Set<string>): string {
    const lines: string[] = [];
    const control = (c: RegionLegend["controls"][number]): string => (c.name ? quote(c.name) : c.role);
    const medium = (m: RegionLegend["media"][number]): string => (m.kind === "canvas" ? "canvas" : m.name ? `img ${quote(m.name)}` : "img");
    if (lg.controls.length) lines.push("• controls: " + lg.controls.map(c => `${control(c)} \`${c.selector}\``).join(" · ") + (lg.moreControls ? ` …+${lg.moreControls}` : ""));
    if (lg.media.length) lines.push("• media: " + lg.media.map(m => `${medium(m)} \`${m.selector}\``).join(" · ") + (lg.moreMedia ? ` …+${lg.moreMedia}` : ""));
    if (lg.text.length) lines.push("• text: " + lg.text.map(t => `«${inQuotes(t.text)}» \`${t.selector}\``).join(" · "));
    const all = lg.boundaries.map(boundaryLine);
    const boundaries = seen ? all.filter(b => !seen.has(b)) : all;
    if (seen) boundaries.forEach(b => seen.add(b));
    if (boundaries.length) lines.push("• boundaries: " + boundaries.join(" · "));
    return lines.length ? "\n\nDOM in view (use these selectors with click/type/findByText):\n" + lines.join("\n") : "";
}
