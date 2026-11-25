// code-links.ts — http(s) links and `@tool:` pointers made clickable INSIDE syntax-highlighted code: cut out of
// highlight.js's token HTML so a link keeps the colour of the token it sits in, with the same `a.out-link` look and the
// same rules (output-links.ts) as plain tool output.

import { h, Fragment } from "preact";
import type { ComponentChildren } from "preact";
import { outputLinks, outputLinkTip } from "./output-links";
import { TOKEN_HEX_SRC, TOOL_NAME_SRC } from "../pointers/token-id";

/** What a surface lends a code block so its links work: which step a pointer names, how a click opens an address or
 *  jumps to a step, and the panel's tooltip. Absent, the block draws no links, as a page with no panel does. */
export interface CodeLinks {
    /** the step a `@tool:<id>` names in this run, with the sentence its tip says; null when it names none */
    step(id: string): { seq: number; tip: string } | null;
    /** open an http(s) address in a new tab; the panel itself never navigates */
    open(url: string): void;
    /** scroll to and reveal a step (`slot` is the cited half) */
    jump(seq: number, slot?: "in" | "out"): void;
    /** the cursor-following tip handlers for a piece of JSX (`cursorTipOn`) */
    tip(content: ComponentChildren): { onPointerMove?: unknown; onPointerLeave?: unknown };
}

// A pointer in code: not glued to a word before it, and not run on into a longer word after it.
const POINTER = new RegExp(`(?<![A-Za-z0-9_])@tool:(${TOKEN_HEX_SRC}|${TOOL_NAME_SRC})(?::(in|out))?(?![A-Za-z0-9_])`, "g");
/** The entities highlight.js writes for the characters it escapes, and what each stands for. */
const ENTITY: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
/** One character of highlighted text: an entity as a whole, or any single character. */
const UNIT = /&(?:amp|lt|gt|quot|#x27|#39);|[\s\S]/g;
/** Escape a value for an HTML attribute or text. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Hit { start: number; end: number; open: string; }
interface Piece { raw: string; tag: boolean; skip: boolean; at: number; link?: number }

/**
 * Cut every qualifying http(s) address and resolvable `@tool:` pointer out of highlight.js's token HTML as an
 * `a.out-link`, INSIDE the token span it sits in so it keeps that token's colour; an address spanning several tokens
 * becomes one anchor per token, all opening the same address. What qualifies is `outputLinks`' rule, never a second
 * matcher. A pointer that names no step (`step` says null) stays text. A markdown link target (`hljs-link`) that holds no
 * link is marked `hljs-link-dead`, so the theme's underline does not suggest a click that does nothing. Text inside a
 * `tt-pop` tooltip is left alone. Nothing to link or mark returns the very string.
 * @param html highlight.js output (spans and escaped text only)
 * @param step resolves a pointer id to whether this run has that step; absent, pointers stay text
 */
export function linkifyHtml(html: string, step?: (id: string) => boolean): string {
    if (!html.includes("://") && !html.includes("@tool:") && !html.includes("hljs-link")) return html;
    // Pass 1: the tags and the text between them; the decoded text of the whole, and where each piece starts in it.
    const pieces: Piece[] = [];
    const stack: { piece: number; link: boolean; at: number }[] = [];
    const linkSpans: { piece: number; start: number; end: number }[] = [];
    let plain = "", skip = 0;
    for (const raw of html.match(/<[^>]*>|[^<]+/g) || []) {
        if (raw[0] === "<") {
            const p: Piece = { raw, tag: true, skip: skip > 0, at: plain.length };
            if (raw.startsWith("<span")) {
                const cls = (/class="([^"]*)"/.exec(raw)?.[1] ?? "").split(/\s+/);
                if (skip > 0 || cls.includes("tt-pop")) skip++;
                stack.push({ piece: pieces.length, link: cls.includes("hljs-link"), at: plain.length });
            } else if (raw === "</span>") {
                const top = stack.pop();
                if (skip > 0) skip--;
                if (top?.link) linkSpans.push({ piece: top.piece, start: top.at, end: plain.length });
            }
            pieces.push(p);
        } else {
            pieces.push({ raw, tag: false, skip: skip > 0, at: plain.length });
            if (!skip) for (const u of raw.match(UNIT)!) plain += ENTITY[u] ?? u;
        }
    }
    // Pass 2: where the links are, in the decoded text.
    const hits: Hit[] = [];
    let off = 0;
    for (const seg of outputLinks(plain)) {
        if (typeof seg === "string") { off += seg.length; continue; }
        hits.push({ start: off, end: off + seg.text.length,
            open: `<a class="out-link" href="${esc(seg.url)}" target="_blank" rel="noopener noreferrer" data-raw="${esc(seg.text)}">` });
        off += seg.text.length;
    }
    if (step && plain.includes("@tool:")) {
        const urls = hits.length;
        for (const m of plain.matchAll(POINTER)) {
            const s = m.index!, e = s + m[0].length;
            if (hits.slice(0, urls).some((u) => s < u.end && e > u.start) || !step(m[1])) continue;
            hits.push({ start: s, end: e, open: `<a class="out-link" role="link" tabindex="0" data-ptr="${esc(m[1])}"${m[2] ? ` data-slot="${m[2]}"` : ""}>` });
        }
        hits.sort((a, b) => a.start - b.start);
    }
    const dead = new Set(linkSpans.filter((s) => !hits.some((h) => h.start < s.end && h.end > s.start)).map((s) => s.piece));
    if (!hits.length && !dead.size) return html;
    // Pass 3: write it out, one anchor per run of a hit's characters inside one text piece.
    let out = "", hi = 0;
    pieces.forEach((p, i) => {
        if (p.tag) { out += dead.has(i) ? p.raw.replace(/class="([^"]*)"/, 'class="$1 hljs-link-dead"') : p.raw; return; }
        if (p.skip || !hits.length) { out += p.raw; return; }
        let at = p.at, cur: Hit | null = null;
        for (const u of p.raw.match(UNIT)!) {
            while (hi < hits.length && hits[hi].end <= at) hi++;
            const here = hi < hits.length && hits[hi].start <= at ? hits[hi] : null;
            if (here !== cur) { if (cur) out += "</a>"; if (here) out += here.open; cur = here; }
            out += u;
            at += (ENTITY[u] ?? u).length;
        }
        if (cur) out += "</a>";
    });
    return out;
}

/** The delegated handlers for a block of linkified code: a click on one of its anchors opens the address or jumps to the
 *  step, the pointer over one shows the panel's tip. Both RE-CHECK what the anchor carries (the address through
 *  `outputLinks`, the pointer through `step`) rather than trusting the attribute, so markup that did not come from
 *  {@link linkifyHtml} opens nothing. Spread onto the `code` element that holds the HTML. */
export function codeLinkHandlers(links: CodeLinks) {
    const anchor = (e: Event): HTMLElement | null => (e.target as Element | null)?.closest?.("a.out-link") as HTMLElement | null ?? null;
    const addressOf = (a: HTMLElement) => {
        const raw = a.getAttribute("data-raw");
        const segs = raw ? outputLinks(raw) : [];
        const l = segs.length === 1 && typeof segs[0] !== "string" ? segs[0] : null;
        return l && l.text === raw ? l : null;
    };
    const go = (a: HTMLElement): boolean => {
        const id = a.getAttribute("data-ptr");
        if (id) {
            const s = links.step(id), slot = a.getAttribute("data-slot");
            if (s) links.jump(s.seq, slot === "in" || slot === "out" ? slot : undefined);
            return true;
        }
        const l = addressOf(a);
        if (l) links.open(l.url);
        return !!l;
    };
    let shown: Element | null = null;
    const leave = () => { if (shown) { shown = null; (links.tip("").onPointerLeave as (() => void) | undefined)?.(); } };
    return {
        onClick: (e: MouseEvent) => { const a = anchor(e); if (a && go(a)) e.preventDefault(); },
        onKeyDown: (e: KeyboardEvent) => { const a = e.key === "Enter" ? anchor(e) : null; if (a?.getAttribute("data-ptr") && go(a)) e.preventDefault(); },
        onPointerMove: (e: PointerEvent) => {
            const a = anchor(e);
            if (!a) return leave();
            const id = a.getAttribute("data-ptr");
            const tip = id ? links.step(id)?.tip : (() => { const l = addressOf(a); return l ? outputLinkTip(l) : undefined; })();
            if (!tip) return leave();
            shown = a;
            (links.tip(h(Fragment, null, tip)).onPointerMove as (e: PointerEvent) => void)?.(e);
        },
        onPointerLeave: leave,
    };
}
