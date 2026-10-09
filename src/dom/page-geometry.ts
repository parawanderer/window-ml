// page-geometry.ts — the page's side of the vision seam: what the DOM answers about where things are, its capture, and the page's VisionHost.

// A vision body (look, locate, the verify after an action) asks a `Geometry` where a target is, which candidates sit
// in a box, what the legend under a crop says, and it asks for a capture and a model call. `pageVisionHost` answers all
// of it here, with the DOM, CAPTURE_TAB and `ml.chat`, exactly as the bodies did before the seam. Every reply is plain
// data, so a worker host can later ask the same questions of this page over a message (tools/vision-host.ts).

import { capturedClosedRoot, queryAll, isElement, viewportRect, boxIntersectsText, classifyOverlay, elLine, errText } from "./dom";
import { type Box, withHiddenSidebar, collectCandidates, collectInBox, elementAtPoint, buildMarks, type MarkFilter } from "./locate";
import { regionLegend } from "./legend";
import { POINT_RE, BOX_RE, resolvePoint, resolveBox, mintPoint, mintBox, nearbyPoint } from "../util";
import { makeBackgroundTaskPromise, hideSidebarForShot } from "../bridge";
import { pageRaster } from "../raster";
import type { MlApi } from "../contract";
import type { VisionMemory } from "../contract/contract-render";
import type { Geometry, GeoMark, GeoRect, TargetQuery, TargetReply, VisionHost, Shot, ShotTarget, ElementRef } from "../tools/vision-host";

// --- Coordinate targets (canvas / WebGL) -----------------------------------
// A <canvas> has NO sub-node to snap to, so `locate` mints an OPAQUE `@pt:` token (see
// util.ts) that `click` resolves and `look`/`screenshot` can crop+mark. These helpers add
// the DOM-side detection + the synthetic click.
/** The <canvas> at a viewport point, if the topmost element there is one (or inside one). */
export const canvasAt = (x: number, y: number): Element | null => {
    let el: Element | null = null;
    try { el = document.elementFromPoint(x, y); } catch { return null; }
    return el ? el.closest("canvas") : null;
};

/** A "RESERVED" surface at a viewport point: one a SYNTHETIC click can't activate, so it needs a real,
 *  hit-tested CDP click (docs/spec/CDP_CLICK.md). Two cases: (1) an `<iframe>` — its content is a separate
 *  document, and dispatching on the `<iframe>` element never reaches inside (cross-origin especially, but a
 *  synthetic click can't reach a same-origin frame's inner control either, since we don't cross frames); and
 *  (2) an un-pierceable CLOSED shadow host — `elementFromPoint` retargets to the host, and a dispatch on the
 *  host can't reach the sealed inner control. NOT reserved: a `<canvas>` (its listener is ON the canvas
 *  element → synthetic works) or an OPEN / pierce-CAPTURED shadow root (selector-reachable). Returns the kind
 *  (+ the iframe's origin, for the approval label), or null for a normally-clickable target. */
export const reservedSurfaceAt = (x: number, y: number): { kind: "iframe" | "shadow"; origin?: string; crossOrigin?: boolean } | null => {
    let el: Element | null = null;
    try { el = document.elementFromPoint(x, y); } catch { return null; }
    if (!el) return null;
    const iframe = el.closest("iframe") as HTMLIFrameElement | null;
    if (iframe) {
        let origin: string | undefined;
        try { origin = new URL(iframe.getAttribute("src") || "", location.href).origin; } catch { /* opaque/srcdoc → no origin label */ }
        // CROSS-ORIGIN is the only real security boundary (SOP + the user's ambient session with that third
        // party). A cross-origin frame's contentDocument is null; same-origin / srcdoc / blank is accessible.
        // Only this warrants a privileged-click warning in the approval — same-origin iframes and shadow roots
        // don't (a shadow root isn't even a security feature). Err toward "cross" if we can't tell.
        let crossOrigin = false;
        try { crossOrigin = iframe.contentDocument === null; } catch { crossOrigin = true; }
        return { kind: "iframe", origin, crossOrigin };
    }
    // Un-pierceable closed-shadow host (same heuristic as dom.ts closedShadowHosts): a hyphenated custom
    // element with no light children, no OPEN root, and not captured by the pierce patch.
    if (!el.shadowRoot && !capturedClosedRoot(el) && el.tagName.includes("-") && !el.children.length) return { kind: "shadow" };
    return null;
};

/** The kind of OPAQUE surface at a point: a `<canvas>`, an `<iframe>`, or a sealed closed shadow host. */
export type OpaqueKind = "canvas" | "iframe" | "shadow";

/** Any OPAQUE surface at a point: a `<canvas>` (synthetic-clickable — its listener is on the canvas element)
 *  or a "reserved" surface (cross-origin iframe / sealed closed shadow — CDP-clickable). NONE has an inner
 *  DOM node to snap a selector onto, so `locate` mints an `@pt` and the `click` tool routes it by kind
 *  (canvas → synthetic dispatch; reserved → CDP). This is why a GROUNDING box over a sealed shadow / iframe
 *  must NOT fall through to Set-of-Marks (which can't badge inside it) — it should mint the coordinate. */
export const opaqueSurfaceAt = (x: number, y: number): OpaqueKind | null => {
    if (canvasAt(x, y)) return "canvas";
    const r = reservedSurfaceAt(x, y);
    return r ? r.kind : null;
};

/** Is this ELEMENT an opaque surface (no inner DOM node to snap to)? A `<canvas>`, an `<iframe>`, or an
 *  un-pierceable closed-shadow host. Used to DROP such elements from SoM candidate sets so a cell/box over
 *  one falls to a coordinate `@pt` rather than a useless SoM pick of the container itself. */
export const isOpaqueEl = (el: Element): boolean =>
    el.tagName === "CANVAS" || el.tagName === "IFRAME" ||
    (!el.shadowRoot && !capturedClosedRoot(el) && el.tagName.includes("-") && !el.children.length);

/** The opaque-surface point nearest the box centre (samples a grid like canvasPointIn), + which KIND.
 *  Generalises canvasPointIn from `<canvas>` to any opaque surface, so grounding/grid can mint an `@pt`
 *  for an iframe / sealed shadow target the DOM can't snap to. */
export const opaquePointIn = (box: Box): { x: number; y: number; kind: OpaqueKind } | null => withHiddenSidebar(() => {
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    const w = box.right - box.left, h = box.bottom - box.top;
    const F = [0.15, 0.35, 0.5, 0.65, 0.85];
    let best: { x: number; y: number; d: number; kind: OpaqueKind } | null = null;
    for (const gy of F) for (const gx of F) {
        const x = box.left + gx * w, y = box.top + gy * h;
        const k = opaqueSurfaceAt(x, y);
        if (k) { const d = Math.hypot(x - cx, y - cy); if (!best || d < best.d) best = { x, y, d, kind: k }; }
    }
    return best ? { x: best.x, y: best.y, kind: best.kind } : null;
});

/** A box as plain data: the six numbers of a DOMRect (or of `viewportRect`), nothing else. */
const plainRect = (r: { left: number; top: number; right: number; bottom: number; width: number; height: number }): GeoRect =>
    ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });

/** Wait two animation frames, so a scroll has painted before anything measures or captures it (no-op without rAF). */
const paint = (): Promise<void> => new Promise<void>(res => typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => requestAnimationFrame(() => res()))
    : res());

/**
 * Bring `el` to the viewport's centre when `scroll` is set, let it paint, and measure it: its top-viewport box (across
 * same-origin iframes), or its own client box for `measure: "client"`. Shared by the `target` op and `ml.screenshot`'s
 * Element target, which is the one target that cannot be named in plain data.
 */
export async function measureElement(el: Element, scroll: boolean, measure: "viewport" | "client" = "viewport"): Promise<GeoRect> {
    if (scroll) {
        try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* detached/older engine */ }
        await paint();
    }
    return plainRect(measure === "client" ? el.getBoundingClientRect() : viewportRect(el));
}

/** The page's Geometry, plus `nodes`: the live elements behind the marks it handed out (the page's debug side channel). */
export type PageGeometry = Omit<Geometry, "stitchBegin" | "stitchTile" | "stitchEnd"> & {
    nodes(refs: ElementRef[]): Element[];
    /** Geometry's stitch ops, each for the stitch `id` (the worker's; 0 for the page's own), several open at once. */
    stitchBegin(id?: number): ReturnType<Geometry["stitchBegin"]>;
    stitchTile(q: { y: number }, id?: number): ReturnType<Geometry["stitchTile"]>;
    stitchEnd(id?: number): ReturnType<Geometry["stitchEnd"]>;
};

/** The most stitches one page geometry keeps open; a new one past it ends the oldest first. */
const MAX_STITCHES = 4;

/** How many live elements a page geometry remembers for `nodes`; older refs resolve to nothing. */
const MAX_REFS = 500;

/**
 * The page's answers to a vision body's layout questions, from the DOM. One instance per host: it holds the elements
 * behind the marks it returned (for `nodes`) and, between `stitchBegin` and `stitchEnd`, the pinned overlays it hid.
 */
export function pageGeometry(): PageGeometry {
    const refs = new Map<number, Element>();
    let nextRef = 1;
    const marksOf = (els: Element[]): GeoMark[] => buildMarks(els).map((m) => {
        const ref = nextRef++;
        refs.set(ref, m.el);
        if (refs.size > MAX_REFS) { const k = refs.keys().next().value; if (k !== undefined) refs.delete(k); }
        return { ref, id: m.id, role: m.role, name: m.name, selector: m.selector, rect: plainRect(m.rect) };
    });
    type Stitch = { total: number; vh: number; startY: number; overlays: { el: HTMLElement; anchor: "top" | "bottom"; vis: string }[] };
    // Open stitches by id. Two vision calls may stitch at once (each its own id); one that was never ended (its call was
    // refused, its worker evicted) stays here, so a later stitch reads an overlay's OWN visibility from it rather than
    // the "hidden" that stitch left behind.
    const stitches = new Map<number, Stitch>();
    /** Restore a stitch's overlays and the scroll it started from, and forget it. */
    const endStitch = (id: number): void => {
        const s = stitches.get(id);
        stitches.delete(id);
        if (!s) return;
        // Restore every overlay's visibility (even on a capture throw) and the scroll position.
        for (const o of s.overlays) o.el.style.visibility = o.vis;
        window.scrollTo(0, s.startY);
    };
    /** An overlay's own visibility: what an open stitch recorded for it, else what it has now. */
    const ownVisibility = (el: HTMLElement): string => {
        for (const s of stitches.values()) { const o = s.overlays.find((x) => x.el === el); if (o) return o.vis; }
        return el.style.visibility;
    };
    const geo: PageGeometry = {
        view: async () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, sx: window.scrollX, sy: window.scrollY }),
        target: async (q: TargetQuery): Promise<TargetReply> => {
            if ("token" in q) {
                const t = q.token.trim();
                if (POINT_RE.test(t)) { const p = resolvePoint(t); return p ? { point: { x: p.x, y: p.y } } : { err: "token" }; }
                if (BOX_RE.test(t)) { const b = resolveBox(t); return b ? { box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } } : { err: "token" }; }
                return { err: "token" };
            }
            if ("focus" in q) {
                const ae = typeof document !== "undefined" ? document.activeElement : null;
                if (!ae || ae === document.body || ae === document.documentElement) return { err: "nofocus" };
                return { rect: await measureElement(ae, q.scroll !== false) };
            }
            let matches: Element[];
            try { matches = queryAll(q.selector); } catch (e) { return { err: "selector", msg: errText(e) }; }
            const el = matches[q.index || 0];
            if (!isElement(el)) return { err: "nomatch", count: matches.length };
            return { rect: await measureElement(el, q.scroll !== false, q.measure) };
        },
        marks: async ({ filter, box, scoped, max, badge }) => {
            const all = scoped ? collectInBox(box, filter, { max }) : collectCandidates(filter, { max });
            const cands = all.slice(0, badge);
            const opaque = opaquePointIn(box);
            const centre = (c: Element) => { const r = c.getBoundingClientRect(); return opaqueSurfaceAt((r.left + r.right) / 2, (r.top + r.bottom) / 2); };
            const allOpaque = cands.length > 0 && cands.every(centre);
            return { total: all.length, marks: marksOf(cands), allOpaque, opaque };
        },
        snap: async ({ box, cx, cy, filter }) => {
            const opaque = opaquePointIn(box);
            if (opaque) return { opaque, marks: [] };
            const primary = elementAtPoint(cx, cy, filter);
            const nearby = collectInBox(box, filter);
            const chosen = primary || nearby[0];
            const ordered = chosen ? [chosen, ...nearby.filter(e => e !== chosen)].slice(0, 12) : nearby.slice(0, 12);
            return { opaque: null, marks: marksOf(ordered) };
        },
        cell: async ({ box, filter }: { box: Box; filter: MarkFilter }) => {
            const found = collectInBox(box, filter, { max: 20 }).filter(el => !isOpaqueEl(el));
            return { marks: marksOf(found), opaque: found.length ? null : opaquePointIn(box) };
        },
        mint: async (q) => {
            if ("box" in q) return { token: mintBox(q.box) };
            const dup = nearbyPoint(q.pt.x, q.pt.y);
            const token = mintPoint(q.pt.x, q.pt.y);
            return dup ? { token, dup } : { token };
        },
        legend: async ({ box }) => regionLegend(box),
        crossesText: async ({ box }) => boxIntersectsText(box),
        focus: async () => {
            const ae = typeof document !== "undefined" ? document.activeElement : null;
            if (!ae || ae === document.body || ae === document.documentElement) return null;
            return { rect: plainRect(viewportRect(ae)), line: elLine(ae) };
        },
        // Detect PINNED overlays (position:fixed, or a currently-STUCK sticky) so we can stop
        // them being stamped into every tile: a fixed nav bar / footer is on screen in every
        // viewport, so a naive scroll+stitch repeats it down the whole image. We probe each
        // candidate's viewport rect at two scroll positions — an invariant top ⇒ pinned
        // (classifyOverlay) — and later show it on exactly ONE tile (a top header on the first,
        // a bottom footer on the last), hiding it on the rest so the content behind shows
        // through. Skipped for a single-viewport page (nothing can repeat). getComputedStyle
        // over the DOM is a one-time cost, negligible beside the paced 600ms/tile captures.
        stitchBegin: async (id = 0) => {
            // A reused id is a stitch that never ended: end it first. Past the cap, the oldest goes the same way.
            endStitch(id);
            while (stitches.size >= MAX_STITCHES) endStitch(stitches.keys().next().value as number);
            const dpr = window.devicePixelRatio || 1;
            const vh = window.innerHeight;
            // Cap at ~8 screens so the image stays sane
            const total = Math.min(document.documentElement.scrollHeight, vh * 8);
            const startY = window.scrollY;
            const overlays: { el: HTMLElement; anchor: "top" | "bottom"; vis: string }[] = [];
            if (total > vh) {
                const cands = ([...document.querySelectorAll("*")] as HTMLElement[])
                    .filter(el => { const p = getComputedStyle(el).position; return p === "fixed" || p === "sticky"; });
                window.scrollTo(0, 0); await paint();
                const r0 = cands.map(el => el.getBoundingClientRect());
                window.scrollTo(0, Math.min(vh, Math.max(1, total - vh))); await paint();
                cands.forEach((el, i) => {
                    const c = classifyOverlay(r0[i], el.getBoundingClientRect(), vh);
                    if (c.pinned) overlays.push({ el, anchor: c.anchor, vis: ownVisibility(el) });
                });
            }
            stitches.set(id, { total, vh, startY, overlays });
            return { total, vh, startY, dpr };
        },
        stitchTile: async ({ y }, id = 0) => {
            const s = stitches.get(id);
            if (!s) throw new Error("stitchTile before stitchBegin");
            window.scrollTo(0, y);
            // Wait for the browser to actually paint the new scroll position
            await paint();
            // Record where we ACTUALLY landed, not where we asked to go: scrollTo clamps at the
            // page's max scroll, so the last step captures the bottom viewport (which overlaps the
            // previous tile) but at a SMALLER offset than `y`. Drawing at the requested `y` painted
            // that overlap band twice — the duplicated "Ridiculous mode"/torn-row seam. Drawing at
            // the real scrollY makes the clamped tile overwrite the overlap with identical pixels.
            const actualY = window.scrollY;
            const isLast = actualY + s.vh >= s.total;
            // Show each pinned overlay on ONLY its home tile (header→first, footer→last), hidden
            // elsewhere. Drawn at actualY, the header lands at y≈0 and the footer at ≈page-bottom —
            // each appearing exactly once instead of on every tile.
            for (const o of s.overlays) o.el.style.visibility = (o.anchor === "top" ? y === 0 : isLast) ? o.vis : "hidden";
            return { actualY, isLast };
        },
        stitchEnd: async (id = 0) => endStitch(id),
        nodes: (list) => list.flatMap((r) => {
            if (typeof r === "number") { const el = refs.get(r); return el ? [el] : []; }
            try { const el = queryAll(r.selector)[r.index]; return el ? [el] : []; } catch { return []; }
        }),
    };
    return geo;
}

/**
 * Capture the tab's viewport from the page: hide the debug sidebar (waiting for the shell to say it painted that),
 * send CAPTURE_TAB, and post "show" whatever the capture did.
 */
export async function pageCapture(): Promise<Shot> {
    await hideSidebarForShot();
    try { return { dataUrl: await makeBackgroundTaskPromise<string>("CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", {}) }; }
    finally { window.postMessage({ __mlSidebarShot: "show" }, "*"); }
}

/**
 * The page's VisionHost: today's page for look, locate and verify. `shoot` and `chat` go through `ml.screenshot` and
 * `ml.chat`, looked up at call time, so the requests are the ones the page always sent (and a test's stub of either
 * still takes effect).
 * @param ml the page's `window.ml`
 * @param memory the run's near-area memory shared by look and locate, or null
 */
export function pageVisionHost(ml: MlApi, memory: VisionMemory | null = null): VisionHost {
    const geo = pageGeometry();
    return {
        capture: pageCapture,
        geo,
        shoot: (target: ShotTarget, opts) => {
            if (target && typeof target === "object") {
                const ae = typeof document !== "undefined" ? document.activeElement : null;
                return ml.screenshot(ae, opts);
            }
            return ml.screenshot(target, opts);
        },
        chat: (prompt, { images, model, maxTokens, numCtx }) => ml.chat(prompt, { images, model, maxTokens, numCtx }) as Promise<string>,
        raster: pageRaster,
        memory,
        elements: (list) => geo.nodes(list),
    };
}

/** A geometry question as it crosses from the worker (worker-vision-host.ts): the op, its arguments, the worker's
 *  sequence number for the call, and for a stitch op the stitch it belongs to. */
export type GeometryRequest = { seq: number; op: string; stitch?: number } & Record<string, unknown>;

/** The page's answer to one geometry question: the op's reply with the request's `seq` (and `stitch`) echoed, or
 *  `error` when the op threw (its message stays here: the worker refuses it with its own sentence). */
export type GeometryAnswer = { seq: number; stitch?: number; reply?: unknown; error?: true };

/**
 * Answer one geometry question from the worker with this page's `Geometry`. Each op is called with the arguments that
 * op takes, read from the request by name, so nothing else in the request reaches it. An op the interface does not have
 * (`nodes`, the page-only debug channel, included) is not answered.
 * @param geo the run's page geometry (one per run, so a stitch's state and the marks' refs carry between questions)
 * @param req the question
 * @returns the answer, or null for an unknown op
 */
export async function answerGeometry(geo: PageGeometry, req: GeometryRequest): Promise<GeometryAnswer | null> {
    const q = req as Record<string, any>;
    const stitchId = Number.isSafeInteger(q.stitch) ? q.stitch as number : 0;
    const ops: Record<string, () => Promise<unknown>> = {
        view: () => geo.view(),
        target: () => geo.target("token" in q ? { token: String(q.token) } : "focus" in q ? { focus: true, scroll: q.scroll } : { selector: String(q.selector), index: q.index, scroll: q.scroll, measure: q.measure }),
        marks: () => geo.marks({ filter: q.filter, box: q.box, scoped: !!q.scoped, max: q.max, badge: q.badge }),
        snap: () => geo.snap({ box: q.box, cx: q.cx, cy: q.cy, filter: q.filter }),
        cell: () => geo.cell({ box: q.box, filter: q.filter }),
        mint: () => geo.mint("box" in q ? { box: q.box } : { pt: q.pt }),
        legend: () => geo.legend({ box: q.box }),
        crossesText: () => geo.crossesText({ box: q.box }),
        focus: () => geo.focus(),
        stitchBegin: () => geo.stitchBegin(stitchId),
        stitchTile: () => geo.stitchTile({ y: q.y }, stitchId),
        stitchEnd: () => geo.stitchEnd(stitchId),
    };
    if (typeof req.op !== "string" || !Object.prototype.hasOwnProperty.call(ops, req.op)) return null;
    const echo = { seq: req.seq, ...(typeof req.stitch === "number" ? { stitch: req.stitch } : {}) };
    try { return { ...echo, reply: await ops[req.op]() }; }
    catch { return { ...echo, error: true }; }
}
