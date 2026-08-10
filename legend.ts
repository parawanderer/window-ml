// Region LEGEND — a textual index of the DOM inside a screenshot's crop, appended to `look` and every
// verify crop. It bridges vision→DOM: the model SEES the pixels and gets the SELECTORS (and boundary
// flags) to act on them — no second round-trip — and for a verify crop it names what just APPEARED.
// Pure DOM enumeration over a viewport box; testable standalone. Grouped lines, omitted when empty.
import { clickSelector, viewportRect, sameOriginFrameDoc, deepQueryAll, truncate } from "./dom";
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
                    words.push({ start: off + m.index, end: off + m.index + m[0].length, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
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
const quote = (s: string): string => (s ? `«${truncate(s, 40)}»` : "");
const imgName = (el: Element): string => { const src = el.getAttribute("src") || ""; const m = src.split("?")[0].split("/").pop() || ""; return m && !m.startsWith("data:") ? m : ""; };
const labelFor = (el: Element): string => { const n = accessibleName(el); if (n) return quote(n); const r = roleOf(el); return r || el.tagName.toLowerCase(); };
const framesList = (sels: string[]): string => sels.slice(0, MAX_FRAMES).map(s => `\`${s}\``).join(", ") + (sels.length > MAX_FRAMES ? ", …" : "");

export interface RegionLegend {
    controls: { name: string; selector: string }[];
    media: { name: string; selector: string }[];
    boundaries: string[];   // pre-phrased hint lines, each naming the actual selector(s)
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
    const controls = controlsF.slice(0, MAX_CONTROLS).map(el => ({ name: labelFor(el), selector: clickSelector(el) }));

    // ---- media (img / canvas) ----
    const mediaEls = deepQueryAll("img, canvas", root).filter(el => shown(el) && boxIntersects(rectOf(el), box));
    const media = mediaEls.slice(0, MAX_MEDIA).map(el => ({
        name: el.tagName === "CANVAS" ? "canvas" : (`img ${quote(el.getAttribute("alt") || imgName(el) || "")}`).trim(),
        selector: clickSelector(el),
    }));

    // ---- boundaries: iframes (same/cross-origin) with their ACTUAL selectors — for a cross-origin frame
    // this line is the ONLY place its selector appears (it contributes nothing to controls/text) ----
    const boundaries: string[] = [];
    const framed = deepQueryAll("iframe", root).filter(el => boxIntersects(rectOf(el), box)).map(el => ({ same: !!sameOriginFrameDoc(el), sel: clickSelector(el) }));
    const cross = framed.filter(f => !f.same).map(f => f.sel), same = framed.filter(f => f.same).map(f => f.sel);
    if (cross.length) boundaries.push(`⚠ ${cross.length} cross-origin iframe${cross.length > 1 ? "s" : ""} (${framesList(cross)}) — no selector reaches inside; locate that selector → click the @pt`);
    if (same.length) boundaries.push(`${same.length} same-origin iframe${same.length > 1 ? "s" : ""} (${framesList(same)}) — reach inside with \`<selector> >>> …\``);
    // Shadow boundary — a byproduct of the collected items' roots (no extra full-DOM scan). The controls
    // already carry `>>>` refs, so this is just a "there's shadow here" flag, counted by mode.
    const shadowHosts = new Set<Element>(); let closed = false;
    for (const el of [...controlsF, ...mediaEls]) { const rn = el.getRootNode(); if (rn instanceof ShadowRoot) { shadowHosts.add(rn.host); if (rn.mode === "closed") closed = true; } }
    if (shadowHosts.size) boundaries.push(`${shadowHosts.size} ${closed ? "" : "open "}shadow root${shadowHosts.size > 1 ? "s" : ""} — refs use \`host >>> …\``);

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

/** Render a RegionLegend as grouped lines for the model — "" when there's nothing notable (suppress-empty). */
export function formatLegend(lg: RegionLegend): string {
    const lines: string[] = [];
    if (lg.controls.length) lines.push("• controls: " + lg.controls.map(c => `${c.name} \`${c.selector}\``).join(" · ") + (lg.moreControls ? ` …+${lg.moreControls}` : ""));
    if (lg.media.length) lines.push("• media: " + lg.media.map(m => `${m.name} \`${m.selector}\``).join(" · ") + (lg.moreMedia ? ` …+${lg.moreMedia}` : ""));
    if (lg.text.length) lines.push("• text: " + lg.text.map(t => `«${t.text}» \`${t.selector}\``).join(" · "));
    if (lg.boundaries.length) lines.push("• boundaries: " + lg.boundaries.join(" · "));
    return lines.length ? "\n\nDOM in view (use these selectors with click/type/findByText):\n" + lines.join("\n") : "";
}
