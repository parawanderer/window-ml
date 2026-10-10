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

/**
 * The shell's answer to `SHOT_RECTS`: the viewport it measured in, and the rects. The flags say what the worker cannot
 * see in the rects: `tampered`, the page has done something to the extension's UI that leaves where it paints unknown
 * (the shot is refused); `restyled`, the page has resized or moved it with styles of its own (a refusal for covering
 * too much then must not tell the person to narrow it); `moved`, it was not in one place for the whole shot (the rects
 * are the union of every place it was seen).
 */
export interface ShotRects { vw: number; vh: number; rects: ShotRect[]; tampered?: boolean; restyled?: boolean; moved?: boolean; }

/** One shadow host the shell mounted: the host, its root, the one stylesheet the shell put in it and that sheet's rules
 *  as they were when the shell mounted it ({@link sheetText}). */
export interface ShotHost {
    host: Element | null;
    kind: ShotRectKind;
    /** The root the shell attached (the host's `shadowRoot` when omitted). */
    root?: ShadowRoot | null;
    /** The shell's own <style> in that root: any other stylesheet there is the page's. */
    style?: Element | null;
    /** {@link sheetText} of `style` at mount: a rule the page edited or inserted since differs. */
    sheet?: string;
}

/** Where the extension's UI lives on the page, as the shell holds it at the moment of asking. */
export interface ShotRoots {
    /** Each shadow host the shell mounted, with the kind of surface its contents are. */
    hosts: ShotHost[];
    /** Elements the shell made inside its roots (the sidebar's panel and frame, the card, the image viewer, the
     *  highlight): one the page carried out of them paints where no root is measured. */
    owned?: (Element | null)[];
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
 * The rules of a stylesheet the shell owns, serialised: what the shell records at mount and compares at every shot,
 * so a rule the page inserted into it or edited through the CSSOM (neither of which is a DOM mutation) is seen.
 * @param style the shell's <style> element
 * @returns the rules' text, or "" when it has no sheet
 */
export function sheetText(style: Element | null | undefined): string {
    const sheet = (style as HTMLStyleElement | null)?.sheet;
    if (!sheet) return "";
    try { return [...sheet.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; }
}

/** A computed property read by its CSS name, "" when the style has none (a test's fake, an old engine). */
const prop = (cs: CSSStyleDeclaration | null, name: string): string => {
    if (!cs) return "";
    try { return String((typeof cs.getPropertyValue === "function" ? cs.getPropertyValue(name) : "") || (cs as unknown as Record<string, string>)[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] || ""); } catch { return ""; }
};
const set = (v: string): boolean => !!v && v !== "none" && v !== "normal";

/**
 * The viewport rects of everything the extension paints over the page: every element inside the shell's shadow roots
 * (the sidebar and its tab, the run card and its menu, tooltips, the image viewer), and any frame of the extension's
 * own pages in the document. Read with getBoundingClientRect, so a transform the page put on any of them is included,
 * and nothing is written: no node, no style, nothing a MutationObserver sees. The highlight box is an outline over a
 * page element, so it is reported as four strips round its edge (its label as a box), not as the element it outlines,
 * which masking would blank.
 *
 * The page shares the DOM with these roots (they are open, and the hosts sit in its document), so before any rect is
 * trusted the answer checks the page has not put its own paint into them: a host moved out of where the shell mounted
 * it (into a frame of the page's, say: its rects would be in that frame's viewport), an element the shell made carried
 * out of its root, a stylesheet in a root that is not the shell's or a rule of the shell's that changed, and a reflection,
 * a filter or a text shadow on the UI (the shell's own styles use none: each paints copies of the UI where no box says).
 * Any of them is `tampered`. A filter on the root element (the only ancestor of the hosts) is bounded and added round
 * every rect; a reflection or an SVG filter there is `tampered` too.
 * @param roots where the shell's UI is mounted
 * @returns the viewport size, the rects and the flags
 */
export function extensionRects(roots: ShotRoots): ShotRects {
    const rects: ShotRect[] = [];
    let tampered = false, restyled = false;
    const add = (x: number, y: number, w: number, h: number, kind: ShotRectKind): void => {
        if (w > 0 && h > 0) rects.push({ x, y, w, h, kind });
    };
    // An element whose own style paints nothing (hidden, or fully transparent with everything inside it) is left out:
    // a closed tooltip would otherwise blank the page under it. Anything else counts, faded or not.
    const styleOf = (el: Element): CSSStyleDeclaration | null => { try { return getComputedStyle(el); } catch { return null; } };
    // Paint the shell's styles never use, so the page's: a copy of the UI (a reflection, a filter's shadow or blur, a
    // text shadow) somewhere no box says.
    const foreignPaint = (cs: CSSStyleDeclaration | null): boolean => set(prop(cs, "-webkit-box-reflect")) || set(prop(cs, "filter")) || set(prop(cs, "text-shadow"));
    // Sizing and moving the shell's styles never use: what makes a refusal the page's doing rather than the person's.
    const pageSized = (cs: CSSStyleDeclaration | null): boolean => (!!prop(cs, "zoom") && prop(cs, "zoom") !== "1") || ["scale", "translate", "rotate"].some((p) => set(prop(cs, p)));
    const docEl = document.documentElement as Element | undefined;
    const rootStyle = docEl ? styleOf(docEl) : null;
    const rootFilter = prop(rootStyle, "filter");
    if (set(prop(rootStyle, "-webkit-box-reflect")) || /url\(/i.test(rootFilter)) tampered = true;
    if (prop(rootStyle, "zoom") && prop(rootStyle, "zoom") !== "1") restyled = true;
    const around = set(rootFilter) ? filterReach(rootFilter) : 0;
    const roots_: ShadowRoot[] = [];
    for (const entry of roots.hosts) {
        const { host, kind } = entry;
        if (!host?.isConnected) continue;
        const root = entry.root ?? host.shadowRoot;
        if (!root) continue;
        roots_.push(root);
        // Mounted on the document's root element and nowhere else: a host the page moved (into one of its frames, its
        // own shadow root, or any element whose effects would apply to ours) paints where these rects do not say.
        if (docEl && host.parentNode !== docEl) tampered = true;
        const hcs = styleOf(host);
        if (foreignPaint(hcs)) tampered = true;
        if (pageSized(hcs) || set(prop(hcs, "transform")) || set(prop(hcs, "perspective"))) restyled = true;
        if (entry.style !== undefined) {
            for (const s of root.querySelectorAll("style, link")) if (s !== entry.style) tampered = true;
            if ((root as ShadowRoot & { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets?.length) tampered = true;
            if (entry.sheet !== undefined && sheetText(entry.style) !== entry.sheet) tampered = true;
        }
        for (const el of root.querySelectorAll("*")) {
            if (el.tagName === "STYLE" || el.tagName === "LINK") continue;
            const cs = styleOf(el);
            if (foreignPaint(cs)) tampered = true;
            if (pageSized(cs)) restyled = true;
            if (cs && (cs.visibility === "hidden" || cs.opacity === "0")) continue;
            const r = el.getBoundingClientRect();
            if (el.id === roots.highlightId) {
                // The interior is the outlined page element and stays; the band covers the outline wherever its offset
                // puts it (inside the edge for a negative one) and whatever the box's own shadow pulse reaches.
                const inner = HL_RING + around + Math.max(0, -px(prop(cs, "outline-offset")));
                const outer = HL_RING + around + paintsBeyond(el, cs);
                const t = inner + outer;
                add(r.left - outer, r.top - outer, r.width + 2 * outer, t, "highlight");
                add(r.left - outer, r.bottom - inner, r.width + 2 * outer, t, "highlight");
                add(r.left - outer, r.top - outer, t, r.height + 2 * outer, "highlight");
                add(r.right - inner, r.top - outer, t, r.height + 2 * outer, "highlight");
                continue;
            }
            const o = around + paintsBeyond(el, cs);
            add(r.left - o, r.top - o, r.width + 2 * o, r.height + 2 * o, el.closest(`#${roots.lightboxId}`) ? "lightbox" : el.closest(`#${roots.highlightId}`) ? "highlight" : kind);
        }
    }
    // An element the shell made, carried out of every root it mounted, is measured by nothing above.
    for (const el of roots.owned ?? []) {
        if (el?.isConnected && !roots_.includes(el.getRootNode() as ShadowRoot)) tampered = true;
    }
    for (const f of document.querySelectorAll("iframe")) {
        if (f.src.startsWith(roots.extensionOrigin)) { const r = f.getBoundingClientRect(); add(r.left - around, r.top - around, r.width + 2 * around, r.height + 2 * around, "frame"); }
    }
    const out: ShotRects = { vw: window.innerWidth, vh: window.innerHeight, rects: rects.length <= MAX_RECTS ? rects : boundingPerKind(rects) };
    if (tampered) out.tampered = true;
    if (restyled) out.restyled = true;
    return out;
}

/** A CSS px length's number, 0 for anything else. */
const px = (v: string): number => { const m = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)px$/i.exec(String(v).trim()); return m ? Number(m[1]) : 0; };
/** Every length in a value, in order: px, or a bare number (a keyframe's `0`), with any colour taken out first. */
const lengths = (v: string): number[] => String(v ?? "").replace(/[a-z-]+\([^()]*\)|#[0-9a-f]+/gi, " ").split(/\s+/)
    .map((t) => /^(-?\d*\.?\d+(?:e[-+]?\d+)?)(px)?$/i.exec(t)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
/** A value's comma-separated layers, commas inside parentheses (a colour's) kept. */
const layers = (v: string): string[] => String(v).split(/,(?![^(]*\))/);

/**
 * How far a filter paints past the box it applies to, in CSS px: a blur's three standard deviations, and a drop shadow's
 * offset plus three of its blur. Functions that only recolour reach nowhere.
 * @param filter a computed `filter`
 * @returns CSS px on every side
 */
export function filterReach(filter: string): number {
    let reach = 0;
    for (const m of String(filter).matchAll(/(blur|drop-shadow)\(((?:[^()]|\([^()]*\))*)\)/gi)) {
        const l = lengths(m[2]);
        reach += m[1].toLowerCase() === "blur" ? 3 * Math.abs(l[0] ?? 0) : Math.abs(l[0] ?? 0) + Math.abs(l[1] ?? 0) + 3 * Math.abs(l[2] ?? 0);
    }
    return reach;
}

/** How far a `box-shadow` paints past the box: the furthest outer layer's offset, one and a half blurs and its spread. */
const shadowReach = (v: string | undefined): number => {
    if (!v || v === "none") return 0;
    let reach = 0;
    for (const layer of layers(v)) {
        if (/\binset\b/.test(layer)) continue;
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths(layer);
        reach = Math.max(reach, Math.abs(x) + Math.abs(y) + 1.5 * Math.abs(blur) + Math.max(0, spread));
    }
    return reach;
};

/**
 * How far past its border box an element paints: its box shadow's reach and its outline's width plus offset, each at the
 * largest any of its running animations or transitions takes them to (a pulse is read at one instant, and the capture
 * lands at another). Not capped: an element that reaches far is masked far, and a mask past the refusal share refuses.
 * @param el the element
 * @param cs its computed style
 * @returns CSS px to add on every side
 */
function paintsBeyond(el: Element, cs: CSSStyleDeclaration | null): number {
    const outlineOn = set(prop(cs, "outline-style"));
    const reachOf = (shadow: string | undefined, ow: string | undefined, oo: string | undefined, on: boolean): number =>
        shadowReach(shadow) + (on ? Math.max(0, px(ow ?? "") + px(oo ?? "")) : 0);
    let reach = reachOf(prop(cs, "box-shadow"), prop(cs, "outline-width"), prop(cs, "outline-offset"), outlineOn);
    let anims: Animation[] = [];
    try { anims = typeof (el as Element & { getAnimations?: () => Animation[] }).getAnimations === "function" ? el.getAnimations() : []; } catch { anims = []; }
    for (const a of anims) {
        let frames: Record<string, unknown>[] = [];
        try { frames = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? []; } catch { frames = []; }
        for (const k of frames) {
            const s = (n: string): string | undefined => (typeof k[n] === "string" ? (k[n] as string) : undefined);
            reach = Math.max(reach, reachOf(s("boxShadow") ?? prop(cs, "box-shadow"), s("outlineWidth") ?? prop(cs, "outline-width"), s("outlineOffset") ?? prop(cs, "outline-offset"), outlineOn || set(s("outlineStyle") ?? "")));
        }
    }
    return reach;
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

/** How long a watch keeps looking with no "end": past the worker's longest capture (the debugger's 5 s bound, then the
 *  own-tab quota retries), after which its answer is one the worker refuses as unreadable. */
export const SHOT_WATCH_MS = 20000;

/** A worker shot in progress, watched from its "begin" to its "end": every place the UI was seen in between. */
interface ShotWatch {
    union: Map<string, ShotRect>;
    first: string;
    vw: number; vh: number;
    tampered: boolean; restyled: boolean; moved: boolean; broken: boolean;
    stop(): void;
}

const watches = new Map<string, ShotWatch>();   // state: plumbing — the worker's shots in progress on this page, each ended by its "end" or SHOT_WATCH_MS

/** How long a watch's begin waits for two frames before answering anyway: a tab in the background paints no frames, and
 *  the debugger's capture of it renders a fresh one, which the watch already covers. */
const BEGIN_PAINT_MS = 200;

/** Run `fn` after two animation frames (the second runs once the first frame's paint is done), or after `ms`. */
function afterPaint(fn: () => void, ms: number): void {
    let done = false;
    const once = (): void => { if (!done) { done = true; clearTimeout(t); fn(); } };
    const t = setTimeout(once, ms);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(once));
}

/** A watch's rects, one per place seen, merged per kind past {@link MAX_RECTS}. */
const unionOf = (w: ShotWatch): ShotRect[] => { const all = [...w.union.values()]; return all.length <= MAX_RECTS ? all : boundingPerKind(all); };

/**
 * Start watching where the extension's UI is, for a capture the worker is about to take: one read now, another on every
 * animation frame, and another right after any change the page makes to the shell's hosts, roots or the root element (a
 * MutationObserver runs before the next paint, so a write the page undoes between two frames is still seen). Nothing is
 * written to the page. Ended by {@link endWatch}, or by itself after `maxMs`.
 * @param id the worker's id for this shot
 * @param roots where the shell's UI is mounted now
 * @param maxMs the bound ({@link SHOT_WATCH_MS})
 * @returns the first read
 */
export function beginWatch(id: string, roots: () => ShotRoots, maxMs = SHOT_WATCH_MS): ShotRects {
    watches.get(id)?.stop();
    const firstRead = extensionRects(roots());
    const w: ShotWatch = { union: new Map(), first: JSON.stringify(firstRead.rects), vw: firstRead.vw, vh: firstRead.vh, tampered: false, restyled: false, moved: false, broken: false, stop: () => {} };
    const take = (r: ShotRects): void => {
        if (r.tampered) w.tampered = true;
        if (r.restyled) w.restyled = true;
        if (r.vw !== w.vw || r.vh !== w.vh) w.broken = true;   // a resize mid-shot: the reads are in two scales
        if (JSON.stringify(r.rects) !== w.first) w.moved = true;
        for (const x of r.rects) w.union.set(`${x.kind}:${x.x},${x.y},${x.w},${x.h}`, x);
    };
    const sample = (): void => { try { take(extensionRects(roots())); } catch { w.broken = true; } };
    take(firstRead);
    let raf = 0, live = true;
    const tick = (): void => { if (!live) return; sample(); raf = requestAnimationFrame(tick); };
    raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : 0;
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver === "function") {
        mo = new MutationObserver(() => { if (live) sample(); });
        const r = roots();
        const opts = { subtree: true, childList: true, attributes: true, characterData: true };
        if (document.documentElement) mo.observe(document.documentElement, { attributes: true, childList: true });
        for (const h of r.hosts) {
            if (h.host) mo.observe(h.host, { attributes: true });
            const root = h.root ?? h.host?.shadowRoot;
            if (root) mo.observe(root, opts);
        }
    }
    const timer = setTimeout(() => { w.broken = true; w.stop(); }, maxMs);
    w.stop = () => { live = false; if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf); mo?.disconnect(); clearTimeout(timer); };
    watches.set(id, w);
    return firstRead;
}

/**
 * End a watch: one last read, then everything seen since its begin, with `moved` when the UI was ever anywhere else.
 * A watch that ran out, saw a resize or failed a read answers a viewport of 0, which the worker refuses as unreadable;
 * an id with no watch (the shell reloaded) answers the read alone.
 * @param id the worker's id for the shot
 * @param roots where the shell's UI is mounted now
 * @returns the union of the watch
 */
export function endWatch(id: string, roots: () => ShotRoots): ShotRects {
    const w = watches.get(id);
    if (!w) return extensionRects(roots());
    watches.delete(id);
    let last: ShotRects | null = null;
    try { last = extensionRects(roots()); } catch { w.broken = true; }
    w.stop();
    if (last) {
        if (last.vw !== w.vw || last.vh !== w.vh) w.broken = true;
        if (last.tampered) w.tampered = true;
        if (last.restyled) w.restyled = true;
        if (JSON.stringify(last.rects) !== w.first) w.moved = true;
        for (const x of last.rects) w.union.set(`${x.kind}:${x.x},${x.y},${x.w},${x.h}`, x);
    }
    if (w.broken) return { vw: 0, vh: 0, rects: [] };
    const out: ShotRects = { vw: w.vw, vh: w.vh, rects: unionOf(w) };
    if (w.tampered) out.tampered = true;
    if (w.restyled) out.restyled = true;
    if (w.moved) out.moved = true;
    return out;
}

/**
 * A `SHOT_RECTS` from chrome.runtime: answered with {@link extensionRects} for the worker, ignored for anyone else. With
 * `watch: "begin"` it also starts watching for the shot `id`, and `watch: "end"` answers what that watch saw.
 * @param sender the message's sender
 * @param roots where the shell's UI is mounted now
 * @param sendResponse the reply
 * @param msg the message (`watch`, `id`)
 * @returns whether it answered
 */
export function answerShotRects(sender: chrome.runtime.MessageSender | undefined, roots: () => ShotRoots, sendResponse: (r: ShotRects) => void, msg: { watch?: unknown; id?: unknown } = {}): boolean {
    if (!fromWorker(sender)) return false;
    // A throw would reach the worker as a failed send, which it must not mistake for "no UI here": answer something it refuses.
    try {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (id && msg.watch === "begin") {
            // Answered once a frame has been painted under the watch: until then the screen may still show a frame painted
            // before it began, with the UI wherever the page had it then, which no read saw.
            const first = beginWatch(id, roots);
            afterPaint(() => sendResponse(first), BEGIN_PAINT_MS);
        }
        else if (id && msg.watch === "end") sendResponse(endWatch(id, roots));
        else sendResponse(extensionRects(roots()));
    } catch { sendResponse({ vw: 0, vh: 0, rects: [] }); }
    return true;
}
