// shell-shot.ts — keeping the extension's own UI out of a screenshot: the page's hide handshake, bounded, and the rects the worker masks out of a shot it takes itself.

// Two kinds of shot. A page-hosted vision tool hides the sidebar with the window handshake (`__mlSidebarShot:
// "hide"|"show"`) and captures through CAPTURE_TAB. A shot the WORKER takes (worker-vision.ts `workerShot`) changes
// nothing on the page: it asks this shell, over chrome.runtime (`SHOT_RECTS`, which no page reaches), where the
// extension's UI sits in the viewport, and paints over those rects in the capture itself. A hide would be a DOM write
// the page can see (when each shot happens), override (a stylesheet beats an inline style) or outwait (it holds the
// ack); a read of rects is none of those.

/** What the shell hides for the page's own shot and brings back after: the sidebar, the off-mode card, the lightbox, the hover box. */
export interface ShotSurface {
    /** Hide everything that would land in a capture (called again while already hidden: must be idempotent). */
    hide(): void;
    /** Bring it back. */
    show(): void;
}

/** How long the page's hide is held with no "show": past the longest page-hosted capture (the quota retries, about
 *  3 s), so a page cannot hide the sidebar and the approval card for as long as it likes by never saying show. */
export const PAGE_SHOT_HOLD_MS = 5000;

/** The two frames a hide waits before it is acknowledged, so the hidden state has painted before the capture fires. */
const afterTwoFrames = (fn: () => void): void => { requestAnimationFrame(() => requestAnimationFrame(fn)); };

/**
 * Whether a chrome.runtime message to this content script came from the extension's worker: this extension's id and
 * no tab. A page has no way onto this channel; the sidebar's own frame and the extension's pages have a tab.
 * @param sender the message's sender, as the browser reports it
 * @returns true for the worker
 */
export function fromWorker(sender: chrome.runtime.MessageSender | undefined): boolean {
    return !!sender && sender.id === chrome.runtime.id && !sender.tab;
}

/** The page's hide handshake, from {@link pageShotGate}. */
export interface PageShotGate {
    /** The page's `__mlSidebarShot: "hide"`: hide, then `ack` after two frames; lifted by show or after the hold. */
    pageHide(ack: () => void): void;
    /** The page's `__mlSidebarShot: "show"`. */
    pageShow(): void;
}

/**
 * The page's hide handshake over the elements it hides, bounded by `holdMs`.
 * @param surface what to hide and show
 * @param holdMs how long a hide is held without its show ({@link PAGE_SHOT_HOLD_MS})
 * @returns the handlers the shell's window listener calls
 */
export function pageShotGate(surface: ShotSurface, holdMs = PAGE_SHOT_HOLD_MS): PageShotGate {
    let hold: ReturnType<typeof setTimeout> | undefined;   // state: ui — the page's hide in progress, lifted by its show or this timer
    const lift = (): void => { clearTimeout(hold); hold = undefined; surface.show(); };
    return {
        pageHide(ack) { clearTimeout(hold); hold = setTimeout(lift, holdMs); surface.hide(); afterTwoFrames(ack); },
        pageShow: lift,
    };
}

/** What paints a rect: names the surface in a refusal, and says how the worker masks it. */
export type ShotRectKind = "sidebar" | "card" | "lightbox" | "highlight" | "frame";

/** One rect of the extension's UI in viewport CSS pixels. */
export interface ShotRect { x: number; y: number; w: number; h: number; kind: ShotRectKind; }

/** The shell's answer to `SHOT_RECTS`: the viewport it measured in, and the rects. */
export interface ShotRects { vw: number; vh: number; rects: ShotRect[]; }

/** Where the extension's UI lives on the page, as the shell holds it at the moment of asking. */
export interface ShotRoots {
    /** Each shadow host the shell mounted, with the kind of surface its contents are. */
    hosts: { host: Element | null; kind: ShotRectKind }[];
    /** The id of the full-viewport image viewer, wherever it is mounted. */
    lightboxId: string;
    /** The id of the hover highlight box, an outline over a page element. */
    highlightId: string;
    /** The extension's own URL prefix (`chrome-extension://<id>/`): a page may embed one of its frames itself. */
    extensionOrigin: string;
}

/** The most rects one answer carries; past it, each kind's rects are merged into their bounding box. */
const MAX_RECTS = 400;
/** The ring a highlight is reported as, in CSS px either side of its edge: its outline is 1 px (3 px when approving). */
const HL_RING = 4;

/**
 * The viewport rects of everything the extension paints over the page: every element inside the shell's shadow roots
 * (the sidebar and its tab, the run card and its menu, tooltips, the image viewer), and any frame of the extension's
 * own pages in the document. Read with getBoundingClientRect, so a transform the page put on any of them is included,
 * and nothing is written: no node, no style, nothing a MutationObserver sees. The highlight box is an outline over a
 * page element, so it is reported as four strips round its edge (its label as a box), not as the element it outlines,
 * which masking would blank.
 * @param roots where the shell's UI is mounted
 * @returns the viewport size and the rects
 */
export function extensionRects(roots: ShotRoots): ShotRects {
    const rects: ShotRect[] = [];
    const add = (x: number, y: number, w: number, h: number, kind: ShotRectKind): void => {
        if (w > 0 && h > 0) rects.push({ x, y, w, h, kind });
    };
    // An element whose own style paints nothing (hidden, or fully transparent with everything inside it) is left out:
    // a closed tooltip would otherwise blank the page under it. Anything else counts, faded or not.
    const styleOf = (el: Element): CSSStyleDeclaration | null => { try { return getComputedStyle(el); } catch { return null; } };
    for (const { host, kind } of roots.hosts) {
        const root = host?.isConnected ? host.shadowRoot : null;
        if (!root) continue;
        for (const el of root.querySelectorAll("*")) {
            if (el.tagName === "STYLE") continue;
            const cs = styleOf(el);
            if (cs && (cs.visibility === "hidden" || cs.opacity === "0")) continue;
            const r = el.getBoundingClientRect();
            if (el.id === roots.highlightId) {
                const o = HL_RING;
                add(r.left - o, r.top - o, r.width + 2 * o, 2 * o, "highlight");
                add(r.left - o, r.bottom - o, r.width + 2 * o, 2 * o, "highlight");
                add(r.left - o, r.top - o, 2 * o, r.height + 2 * o, "highlight");
                add(r.right - o, r.top - o, 2 * o, r.height + 2 * o, "highlight");
                continue;
            }
            const o = cs ? paintsBeyond(cs) : 0;
            add(r.left - o, r.top - o, r.width + 2 * o, r.height + 2 * o, el.closest(`#${roots.lightboxId}`) ? "lightbox" : el.closest(`#${roots.highlightId}`) ? "highlight" : kind);
        }
    }
    for (const f of document.querySelectorAll("iframe")) {
        if (f.src.startsWith(roots.extensionOrigin)) { const r = f.getBoundingClientRect(); add(r.left, r.top, r.width, r.height, "frame"); }
    }
    return { vw: window.innerWidth, vh: window.innerHeight, rects: rects.length <= MAX_RECTS ? rects : boundingPerKind(rects) };
}

/** The most a shadow, an outline or a filter is taken to paint past an element's box, in CSS px. */
const MAX_BEYOND = 64;

/**
 * How far past its border box an element paints: every length in its box-shadow and filter added up (offset, blur and
 * spread together, an overestimate on purpose), plus its outline, capped at {@link MAX_BEYOND}.
 * @param cs the element's computed style
 * @returns CSS px to add on every side
 */
function paintsBeyond(cs: CSSStyleDeclaration): number {
    const lengths = (v: string | undefined): number => [...String(v ?? "").matchAll(/(-?\d*\.?\d+)px/g)].reduce((a, m) => a + Math.abs(Number(m[1])), 0);
    const shadow = cs.boxShadow && cs.boxShadow !== "none" ? lengths(cs.boxShadow) : 0;
    const filter = cs.filter && cs.filter !== "none" ? lengths(cs.filter) : 0;
    const outline = cs.outlineStyle && cs.outlineStyle !== "none" ? lengths(cs.outlineWidth) + lengths(cs.outlineOffset) : 0;
    return Math.min(MAX_BEYOND, shadow + filter + outline);
}

/** Each kind's rects merged into one bounding box. */
function boundingPerKind(rects: ShotRect[]): ShotRect[] {
    const by = new Map<ShotRectKind, { x0: number; y0: number; x1: number; y1: number }>();
    for (const r of rects) {
        const b = by.get(r.kind);
        if (!b) by.set(r.kind, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
        else { b.x0 = Math.min(b.x0, r.x); b.y0 = Math.min(b.y0, r.y); b.x1 = Math.max(b.x1, r.x + r.w); b.y1 = Math.max(b.y1, r.y + r.h); }
    }
    return [...by].map(([kind, b]) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, kind }));
}

/**
 * A `SHOT_RECTS` from chrome.runtime: answered with {@link extensionRects} for the worker, ignored for anyone else.
 * @param sender the message's sender
 * @param roots where the shell's UI is mounted now
 * @param sendResponse the reply
 * @returns whether it answered
 */
export function answerShotRects(sender: chrome.runtime.MessageSender | undefined, roots: () => ShotRoots, sendResponse: (r: ShotRects) => void): boolean {
    if (!fromWorker(sender)) return false;
    // A throw would reach the worker as a failed send, which it must not mistake for "no UI here": answer something it refuses.
    try { sendResponse(extensionRects(roots())); } catch { sendResponse({ vw: 0, vh: 0, rects: [] }); }
    return true;
}
