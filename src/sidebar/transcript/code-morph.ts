// code-morph.ts — the reformat of a streamed script drawn as its glyphs MOVING, not the block vanishing and returning.
//
// The model streams its code packed (fewer tokens); the step that replaces the live call shows it beautified. Beautifying
// only ever changes whitespace, so the non-whitespace characters are the same sequence in both: character i of the live
// block is character i of the new one, and no diff is needed. The live block hands over where each character sat as it
// unmounts; the new block, on mount, draws one flying copy of each from there to its place (a FLIP) while the real text
// is hidden for the length of it. Anything that does not line up exactly (the live text is not a prefix of the new one,
// too many characters, reduced motion, nothing moved) draws nothing: the block simply appears, as before.

import { HANDOFF_MS } from "./just-arrived";

/** Most characters morphed; a longer script appears without it (one animated element per character). */
export const MORPH_MAX_CHARS = 1500;
/** How long a character takes to reach its place. */
export const MORPH_MS = 260;

/** One non-whitespace character of a drawn block: where its box sits in the viewport, its colour, whether it was in view. */
export interface Glyph { ch: string; x: number; y: number; color: string; vis: boolean }

/** What each new character does: travel `dx`,`dy` from where it was, or `fade` in place (it was not on screen before). */
export type MorphStep = { dx: number; dy: number; fade: boolean };

/**
 * How each character of the new block gets there from the old one, or null when there is nothing to draw: the old
 * characters must be exactly the first ones of the new (the reveal may still be mid-text when the call lands), and
 * something must actually move.
 */
export function planMorph(old: Glyph[], neu: Pick<Glyph, "ch" | "x" | "y">[]): MorphStep[] | null {
    if (!old.length || old.length > neu.length) return null;
    for (let i = 0; i < old.length; i++) if (old[i].ch !== neu[i].ch) return null;
    let moved = false;
    const steps = neu.map((g, i): MorphStep => {
        const o = old[i];
        if (!o || !o.vis) return { dx: 0, dy: 0, fade: true };
        const dx = o.x - g.x, dy = o.y - g.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved = true;
        return { dx, dy, fade: false };
    });
    return moved ? steps : null;
}

/** Every non-whitespace character under `root` with its box, in reading order; null when there are too many. Line numbers are not code. */
export function glyphsOf(root: Element, clip?: Element): Glyph[] | null {
    const out: Glyph[] = [];
    const colors = new Map<Element, string>();
    const view = clip?.getBoundingClientRect();
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || parent.closest(".lno")) continue;
        const text = n.nodeValue || "";
        for (let i = 0; i < text.length; i++) {
            if (/\s/.test(text[i])) continue;
            if (out.length >= MORPH_MAX_CHARS) return null;
            range.setStart(n, i); range.setEnd(n, i + 1);
            const r = range.getBoundingClientRect();
            let color = colors.get(parent);
            if (color === undefined) { color = getComputedStyle(parent).color; colors.set(parent, color); }
            out.push({ ch: text[i], x: r.left, y: r.top, color, vis: !view || (r.bottom > view.top && r.top < view.bottom) });
        }
    }
    return out;
}

// state: plumbing — the live block's glyphs for the step about to replace it, gone after HANDOFF_MS or on the first take
let held: { at: number; glyphs: Glyph[]; height: number } | null = null;

/** The live call is unmounting: remember where each of its characters is, for the step that takes over. */
export function noteLiveGlyphs(root: Element, now = Date.now()): void {
    const glyphs = glyphsOf(root, root);
    held = glyphs?.length ? { at: now, glyphs, height: (root.querySelector("pre") ?? root).getBoundingClientRect().height } : null;
}

/** A reformatted block has just mounted: if a live call handed over its glyphs, fly them to their new places. */
export function morphInto(pre: HTMLElement, now = Date.now()): void {
    const old = held; held = null;
    if (!old || now - old.at > HANDOFF_MS) return;
    try { if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return; } catch { /* no matchMedia: draw it */ }
    const neu = glyphsOf(pre);
    const plan = neu && planMorph(old.glyphs, neu);
    if (!neu || !plan) return;
    const code = pre.querySelector("code") ?? pre;
    const cs = getComputedStyle(code);
    const box = pre.getBoundingClientRect();
    const layer = document.createElement("span");
    layer.className = "code-morph";
    layer.setAttribute("aria-hidden", "true");
    layer.style.font = cs.font;
    layer.style.lineHeight = cs.lineHeight;
    neu.forEach((g, i) => {
        const s = document.createElement("span");
        s.textContent = g.ch;
        s.style.left = `${g.x - box.left + pre.scrollLeft}px`;
        s.style.top = `${g.y - box.top + pre.scrollTop}px`;
        s.style.color = g.color;
        layer.append(s);
        const p = plan[i];
        s.animate(p.fade ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: `translate(${p.dx}px, ${p.dy}px)` }, { transform: "none" }],
            { duration: MORPH_MS, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "backwards" });
    });
    // The block's own box eases from the live block's height to its new one, on the glyphs' curve.
    const to = pre.getBoundingClientRect().height;
    if (old.height > 0 && Math.abs(old.height - to) > 1) {
        pre.style.overflow = "hidden";
        pre.animate([{ height: `${old.height}px` }, { height: `${to}px` }], { duration: MORPH_MS, easing: "cubic-bezier(.4, 0, .2, 1)" })
            .finished.then(() => { pre.style.overflow = ""; }, () => { pre.style.overflow = ""; });
    }
    pre.classList.add("morphing");
    pre.append(layer);
    setTimeout(() => { layer.remove(); pre.classList.remove("morphing"); }, MORPH_MS + 60);
}
