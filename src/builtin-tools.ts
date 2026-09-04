// The built-in side-effecting interaction tools for ml.agent: `look` (vision),
// `click`, and `type`. Factored out of the window.ml object literal — each takes
// the live `ml` (for defineTool/screenshot/chat) plus imported dom helpers, and
// window.ml keeps thin delegating method wrappers. Not in the default read-only
// domTools; opt in via extraTools, gated by the approval flow.

import type { MlApi, MlTool, LocateSubstep, ToolResult, RenderDescriptor, VisionMemory, ToolContext, ServerTool, JsonSchema } from "./contract";
import { DEFAULT_GROUNDING_RANGE, resolveOutputCap, outputCapPrecheck, UI_OUT_CAP } from "./contract";
import { PY_PACKAGE_LABELS } from "./python-env";
import { truncate, clipOut, errText, elLine, queryAll, selectorError, googleSheetCsvUrl, nonEmptyTables, capturedClosedRoot, isElement, viewportRect, boxIntersectsText, firstHopSealed, clickSelector } from "./dom";
import { accessibleName } from "./a11y";
import { regionLegend, formatLegend, type Box as LegendBox } from "./legend";

// python_exec output (stdout / value / error) fed to the model is capped per slot — default bigger than
// exec's 500 (data output legitimately runs longer), the model can raise it per-call (gated). See run().
import { settle, VISION_NUM_CTX, cropDataUrl, MIN_SHOT_PX, POINT_RE, PT_LOOK_RADIUS, mintPoint, resolvePoint, nearbyPoint, markSeen, seenNearby, BOX_RE, mintBox, resolveBox, projectShotPoint, projectShotBox } from "./util";
import { collectCandidates, buildMarks, annotate, formatBox, letterboxToSquare, projectFromSquare, drawGrid, gridDims, validateCells, cellsBox, collectInBox, elementAtPoint, viewportBox, colorWordHues, pickOverlayColor, pickAccentColor, withHiddenSidebar, regionBox, REGION_NAMES, adjacentCells, type RegionName, type MarkFilter, type Box, type Mark } from "./locate";

// CDP-trusted-input flag, set per run from config (like setPierceClosedShadow, threaded in injected.ts). When
// ON, click/type route canvas / @pt / @focus / sealed targets through the debugger for REAL (isTrusted) events
// a WebGL / remote-desktop / canvas app honours; OFF → synthetic (fine for most 2D-DOM canvases, but keys don't
// register in games and some streams drop untrusted clicks). Background-gated too — this only picks the path.
let cdpEnabled = false;
export const setCdpEnabled = (on: boolean): void => { cdpEnabled = on; };

/** Is this element a plausible KEYBOARD target — something typing into would actually register? A text field
 *  (input/textarea/select), a contenteditable, a <canvas> (WebGL/game/stream reading keydown), or any element
 *  the author made focusable with `tabindex` (a custom widget). NOT the body/documentElement (= nothing
 *  focused) or a plain button/link/div. Used by `type`'s precheck for `@focus` (fail fast, no approval, when
 *  nothing typeable is focused) and by the whole-element verify. */
export const isTypeableEl = (el: Element | null): boolean => {
    if (!el || (typeof document !== "undefined" && (el === document.body || el === document.documentElement))) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "CANVAS") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return el.hasAttribute("tabindex");   // a focusable custom widget / game surface
};

// --- Coordinate targets (canvas / WebGL) -----------------------------------
// A <canvas> has NO sub-node to snap to, so `locate` mints an OPAQUE `@pt:` token (see
// util.ts) that `click` resolves and `look`/`screenshot` can crop+mark. These helpers add
// the DOM-side detection + the synthetic click.
/** The <canvas> at a viewport point, if the topmost element there is one (or inside one). */
const canvasAt = (x: number, y: number): Element | null => {
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
const reservedSurfaceAt = (x: number, y: number): { kind: "iframe" | "shadow"; origin?: string; crossOrigin?: boolean } | null => {
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
type OpaqueKind = "canvas" | "iframe" | "shadow";
/** Any OPAQUE surface at a point: a `<canvas>` (synthetic-clickable — its listener is on the canvas element)
 *  or a "reserved" surface (cross-origin iframe / sealed closed shadow — CDP-clickable). NONE has an inner
 *  DOM node to snap a selector onto, so `locate` mints an `@pt` and the `click` tool routes it by kind
 *  (canvas → synthetic dispatch; reserved → CDP). This is why a GROUNDING box over a sealed shadow / iframe
 *  must NOT fall through to Set-of-Marks (which can't badge inside it) — it should mint the coordinate. */
const opaqueSurfaceAt = (x: number, y: number): OpaqueKind | null => {
    if (canvasAt(x, y)) return "canvas";
    const r = reservedSurfaceAt(x, y);
    return r ? r.kind : null;
};
/** Is this ELEMENT an opaque surface (no inner DOM node to snap to)? A `<canvas>`, an `<iframe>`, or an
 *  un-pierceable closed-shadow host. Used to DROP such elements from SoM candidate sets so a cell/box over
 *  one falls to a coordinate `@pt` rather than a useless SoM pick of the container itself. */
const isOpaqueEl = (el: Element): boolean =>
    el.tagName === "CANVAS" || el.tagName === "IFRAME" ||
    (!el.shadowRoot && !capturedClosedRoot(el) && el.tagName.includes("-") && !el.children.length);
/** The opaque-surface point nearest the box centre (samples a grid like canvasPointIn), + which KIND.
 *  Generalises canvasPointIn from `<canvas>` to any opaque surface, so grounding/grid can mint an `@pt`
 *  for an iframe / sealed shadow target the DOM can't snap to. */
const opaquePointIn = (box: Box): { x: number; y: number; kind: OpaqueKind } | null => withHiddenSidebar(() => {
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
/** Human noun for an opaque-surface kind (messaging). */
const surfaceNoun = (kind: OpaqueKind): string =>
    kind === "iframe" ? "a cross-origin <iframe>" : kind === "shadow" ? "a sealed (declarative/native) closed shadow root" : "a <canvas>";
/** For a RESERVED kind, a one-line note that the click needs CDP (canvas clicks plainly). */
const reservedClickNote = (kind: OpaqueKind): string =>
    kind === "canvas" ? "" : ` This needs a debugger (CDP) click — turn on "reserved-element clicking" in window.ml Settings → Advanced (a normal click can't reach ${kind === "iframe" ? "into a cross-origin frame" : "a sealed shadow root"}).`;
/** Synthesize a real click at a viewport coordinate (for canvas surfaces): the full
 *  pointer/mouse sequence at (x,y) on the topmost element there. */
const clickAt = (x: number, y: number): Element | null => {
    // Ignore the debug sidebar overlay so a click under the panel reaches the canvas/page.
    const el = withHiddenSidebar(() => canvasAt(x, y) || (() => { try { return document.elementFromPoint(x, y); } catch { return null; } })());
    if (!el) return null;
    const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    const hasPointer = typeof PointerEvent === "function";
    if (hasPointer) el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (hasPointer) el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
    return el;
};

// The In render for a tool that TARGETS one element/coordinate (click / look): its `selector` — a CSS
// selector OR an @pt/@box token — as a hoverable ref, so the sidebar outlines it on the page. No
// selector (a viewport/page look) → null (raw args). The sidebar picks element- vs point/box-highlight
// by the path shape, so this stays agnostic.
// The element's human NOUN for an approval intent ("Click the button …"). Tag/role-based, page-side.
const nounFor = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || el.getAttribute("role") === "button") return "button";
    if (tag === "input" || tag === "textarea" || tag === "select" || (el as HTMLElement).isContentEditable) return "field";
    return "element";
};
// A tool's INTENT descriptor for the user-facing approval card: the verb + the element's human
// label/noun + the selector to HIGHLIGHT. Page-side (resolves the DOM). @pt/@box tokens (canvas
// targets) carry no DOM label — just a point/region kind. A tool returns this from its `render` so the
// card describes it deterministically (custom approval-gated tools included); see contract's `action`.
export const actionRender = (verb: string, args: Record<string, unknown>, extra?: { input?: string; note?: string }): RenderDescriptor | null => {
    let sel = typeof args.selector === "string" ? args.selector.trim() : "";
    // @focus: resolve to the element that CURRENTLY has focus, so the approval card + the green pulsing
    // highlight box target the REAL element (a bare "@focus" isn't a selector → no box, which is why the user
    // never saw the highlight). Nothing focusable → a plain "focus" intent with no highlight. (Only the explicit
    // token — an EMPTY selector stays null below, so `click` with no target is unaffected.)
    if (sel === "@focus") {
        const ae = typeof document !== "undefined" ? document.activeElement : null;
        if (ae && ae !== document.body && ae !== document.documentElement) {
            const n = accessibleName(ae) || (ae.textContent || "").trim();
            return { type: "action", verb, kind: nounFor(ae), target: n ? truncate(n.replace(/\s+/g, " "), 80) : undefined, selector: clickSelector(ae), input: extra?.input, note: extra?.note };
        }
        return { type: "action", verb, kind: "focus", input: extra?.input, note: extra?.note };
    }
    if (!sel) return null;
    const idx = typeof args.index === "number" ? args.index : 0;
    let kind: string | undefined; let target: string | undefined; let crossOrigin: string | undefined;
    if (/^@pt:/.test(sel)) {
        kind = "point";
        // Flag a click landing in a CROSS-ORIGIN iframe — the one privileged case, so the approval can warn
        // BEFORE you approve (Chrome's debug banner only shows AFTER). Same-origin frames / shadow roots don't.
        const pt = resolvePoint(sel);
        const r = pt ? reservedSurfaceAt(pt.x, pt.y) : null;
        if (r && r.kind === "iframe" && r.crossOrigin) crossOrigin = r.origin || "an embedded cross-origin frame";
    }
    else if (/^@box:/.test(sel)) kind = "region";
    else {
        try {
            const el = queryAll(sel)[idx];
            if (el) {
                const n = accessibleName(el) || (el.textContent || "").trim();
                if (n) target = truncate(n.replace(/\s+/g, " "), 80);
                kind = nounFor(el);
            }
        } catch { /* bad selector — no label */ }
    }
    return { type: "action", verb, kind, target, selector: sel, input: extra?.input, note: extra?.note, crossOrigin };
};

export const targetRender = (args: Record<string, unknown>): RenderDescriptor | null => {
    const sel = typeof args.selector === "string" ? args.selector.trim() : "";
    if (!sel) return null;
    const idx = typeof args.index === "number" ? args.index : undefined;
    // Resolve the element's HUMAN label (accessible name → visible text) so an approval card can show
    // "Click «Show the giant scrolling table»" instead of the raw selector. Page-side (render runs
    // here), best-effort — a selector that doesn't resolve, or an @pt/@box token, just carries no text.
    let text: string | undefined;
    try {
        const el = queryAll(sel)[idx || 0];
        if (el) { const n = accessibleName(el) || (el.textContent || "").trim(); if (n) text = truncate(n.replace(/\s+/g, " "), 80); }
    } catch { /* bad selector / point token — no label */ }
    return { type: "elements", items: [{ path: sel, ...(idx ? { index: idx } : {}), ...(text ? { text } : {}) }] };
};

// A marked-point crop has a coloured box + "click point" label drawn ON it BY THE TOOL — VLMs keep
// mistaking that annotation for a real UI control ("the green square is a toggle"). Every prompt over such a
// crop appends this so the reader looks THROUGH the mark at the page content beneath it. Shared by the
// standalone `look` (@pt) and the `locate → look` snap-feedback describe, and shown in both debug renders.
export const CLICK_MARK_NOTE = "\n\nIMPORTANT: the box and its \"click point\" label were added to this image BY THE TOOL, only to mark where a click would land — they are NOT part of the page and NOT a real UI control. Do not describe them as elements. Describe what is UNDERNEATH the box: the actual page content at that spot (its colour, shape, and any text).";

// Appended when the click-point box is DETECTED to sit on page text (boxIntersectsText) — a targeted nudge,
// not an always-on note, since it only matters when the overlay actually hides something you must read.
export const BOX_OVER_TEXT_TIP = "\n\n⚠ The click-point box is sitting ON page text here — it may hide characters you need. For a clean read, call look again with views:[\"no-overlay\"] (or views:[\"overlay\",\"no-overlay\"] to get both the marked crop AND a clean copy).";

// The shared `views` parameter for both look tools (native + delegated). Only meaningful for a marked
// @pt/@box target — for a plain selector/viewport there's no overlay to drop.
export const VIEWS_PARAM = { type: "array", items: { type: "string", enum: ["overlay", "no-overlay"] }, description: "For an @pt:/@box: target only: which crop(s) to return. \"overlay\" (default) draws the click-point box so you see WHERE a click lands; \"no-overlay\" is a clean copy so you can READ text the box would cover. Pass both — [\"overlay\",\"no-overlay\"] — when you need to do both at once." } as const;

/** Produce the requested crop VIEWS of a MARKED @pt/@box token from ONE viewport capture (no re-screenshot):
 *  `views` ⊆ ["overlay","no-overlay"], default ["overlay"]. Returns each as a labelled image (the caller
 *  injects them natively or hands them to a reader) plus whether the click-point box crosses page text. */
export async function lookViews(ml: MlApi, token: string, margin: number, views?: string[]): Promise<{ images: { image: string; label: string }[]; crossesText: boolean }> {
    const m = typeof margin === "number" ? margin : 0;
    const isPt = POINT_RE.test(token.trim());
    const wantClean = Array.isArray(views) && views.includes("no-overlay");
    const wantMarked = !Array.isArray(views) || views.length === 0 || views.includes("overlay");
    // ONE capture when BOTH views are wanted (each crop reuses it); a single view captures once internally.
    const cap = (wantClean && wantMarked) ? await ml.screenshot(null, {}) : null;
    const images: { image: string; label: string }[] = [];
    if (wantMarked) images.push({ image: await ml.screenshot(token, { margin: m, capture: cap }), label: isPt ? "with click-point box" : "with region outline" });
    if (wantClean) images.push({ image: await ml.screenshot(token, { margin: m, noOverlay: true, capture: cap }), label: "clean — no box (read text here)" });
    // Targeted warning: does the 24px marker box (an @pt only) cross page text? Same-origin DOM only.
    let crossesText = false;
    if (isPt) { const p = resolvePoint(token); if (p) crossesText = boxIntersectsText({ left: p.x - 12, top: p.y - 12, width: 24, height: 24 }); }
    return { images, crossesText };
}

/** The viewport box a screenshot of `target` cropped — viewport (null), an @pt neighbourhood, an @box
 *  region, or an element's rect — so the DOM legend enumerates the SAME area the image shows. */
function boxForTarget(target: string | null, margin: number): LegendBox | null {
    if (!target) return typeof window !== "undefined" ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : null;
    const t = target.trim();
    if (POINT_RE.test(t)) { const p = resolvePoint(t); if (!p) return null; const R = margin > 0 ? margin : PT_LOOK_RADIUS; return { left: p.x - R, top: p.y - R, right: p.x + R, bottom: p.y + R }; }
    if (BOX_RE.test(t)) { const b = resolveBox(t); if (!b) return null; return { left: b.left - 16, top: b.top - 16, right: b.right + 16, bottom: b.bottom + 16 }; }
    const el = queryAll(target)[0]; if (!isElement(el)) return null; const r = viewportRect(el); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** The formatted DOM legend for a screenshot target ("" when nothing notable / on any failure). Defensive:
 *  a legend is a NICE-TO-HAVE annotation — it must never break a look/verify. */
export function legendFor(target: string | null, margin = 0, seen?: Set<string>): string {
    try { const box = boxForTarget(target, margin); return box ? formatLegend(regionLegend(box), seen) : ""; } catch { return ""; }
}
/** Same, for a caller that already has the viewport box (verify crops). */
export function legendForBox(box: LegendBox | null, seen?: Set<string>): string {
    try { return box ? formatLegend(regionLegend(box), seen) : ""; } catch { return ""; }
}

export const buildLookTool = (ml: MlApi, { model = null, maxTokens = 512, memory = null }: { model?: string | null; maxTokens?: number; memory?: VisionMemory | null } = {}): MlTool => {
    return ml.defineTool({
        name: "look",
        summary: "Screenshots the page so the agent can see it.",
        capabilities: ["vision"],
        description: "See the page (or one element) visually. No selector → screenshot the viewport " +
            "to orient. A selector → inspect that element; iterate `index` (0,1,2,…) to judge items in " +
            "a grid/list one sharp crop at a time. scope:'page' stitches the whole page (downscaled — " +
            "layout only, not small text). An `@pt:…` token from locate → a marked crop of that canvas " +
            "click point, to VERIFY before clicking.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of an element, an `@pt:…` point token from locate, or an `@tool:<id>` pointer to a screenshot this run already captured (to ask a NEW question about the SAME pixels instead of re-shooting a page that may have changed); omit to see the page." },
                question: { type: "string", description: "What to determine (optional)." },
                scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" },
                margin: { type: "number", description: "For an @pt: token only — the crop RADIUS in px around the point (bigger = more context). Ignored for CSS selectors." },
                views: VIEWS_PARAM
            }
        },
        // In: the target as a hoverable ref (hover → outline it on the page). No selector (viewport/page) → raw args.
        render: (_input, args) => targetRender(args),
        run: async ({ selector, question, scope, index, margin, views, _image, _imageLabel }: { selector?: string; question?: string; scope?: "viewport" | "page"; index?: number; margin?: number; views?: string[]; _image?: string; _imageLabel?: string } = {}) => {
            // An `@tool:<id>` image pointer: the LOOP resolved it and handed the captured screenshot down (it
            // owns the pointer store). Re-examining an image the run already has is not a page operation, so
            // there is nothing to screenshot — skip straight to asking the reader about those pixels.
            if (_image) {
                const q = question || "Describe this image concisely — what is shown and what stands out.";
                const note = `\n\nThis is a screenshot captured EARLIER in this run (${_imageLabel || "an earlier step"}), not the page as it is now.`;
                try {
                    const desc = await ml.chat(q + note, { images: [_image], model, maxTokens, numCtx: VISION_NUM_CTX }) as string;
                    return { content: desc, image: _image, imageLabel: _imageLabel || "captured earlier" };
                } catch (e) { return `Error: ${errText(e)}`; }
            }
            const fullPage = scope === "page" && !selector;
            // An @pt point token → screenshot returns a cropped, MARKED view of the click spot
            // (canvas verification): tailor the prompt to "what's at the mark", not page text.
            const isPoint = !!selector && POINT_RE.test(selector.trim());
            const isMarked = !!selector && (isPoint || BOX_RE.test(selector.trim()));
            // Looking at an @pt marks that spot SEEN, so locate's snap-feedback won't later re-inject a
            // near-identical crop of it (the shared near-area dedup).
            if (isPoint) { const p = resolvePoint(selector!); if (p) markSeen(memory, p.x, p.y); }
            // A marked target honours `views` (overlay / no-overlay / both, one capture); everything else is
            // the usual single shot. `shots` carries what the reader sees; `shot` is the primary (for render).
            let shots: { image: string; label: string }[], shot: string, crossesText = false;
            try {
                if (isMarked) { const v = await lookViews(ml, selector!, margin as number, views); shots = v.images; crossesText = v.crossesText; shot = shots[0].image; }
                else { shot = await ml.screenshot(selector || null, { fullPage, index: index || 0, margin: typeof margin === "number" ? margin : 0 }); shots = [{ image: shot, label: "screenshot" }]; }
            }
            catch (e) { return `Error: ${errText(e)}`; }
            const subject = isPoint ? `the point marked on the canvas (${selector})`
                : selector ? `the element "${selector}"${index ? ` (match #${index})` : ""}`
                : (fullPage ? "the whole page" : "the current page");
            const base = question || (isPoint
                ? `Describe what is at the marked spot — its colour, shape, and any text — and whether it matches what I'm after, so I don't click the wrong thing.`
                : `Describe ${subject} concisely — what is shown and what stands out.`);
            // A full-page stitch is downscaled — the vision model's patches get
            // too coarse to read small text, so frame it as layout/orientation
            // and DON'T ask for verbatim anchors (those are confidently wrong at
            // that zoom). Viewport/element shots are sharp enough to quote text.
            const guidance = isPoint
                ? CLICK_MARK_NOTE   // clarify the box+label are a tool annotation, not page UI (appended even when a question is passed)
                : fullPage
                ? "\n\nThis is a DOWNSCALED full-page overview: report the overall layout and " +
                  "roughly where sections/items are. Do NOT try to read small text verbatim — " +
                  "say so if it's illegible, and use sampleText/findByText (or look at a specific " +
                  "element) to read exact details."
                : "\n\nThen list a few EXACT on-screen text strings (quoted, verbatim — labels, " +
                  "badges, prices, delivery text) I could search for with findByText to locate " +
                  "the key items.";
            // Multi-view (overlay + no-overlay): the reader sees BOTH crops — mention which is which so it
            // can read the clean copy and still reason about where the box lands.
            const viewNote = shots.length > 1 ? `\n\nTwo crops of the SAME spot follow: (1) ${shots[0].label}, (2) ${shots[1].label}. Read the clean one for text; use the marked one only to judge WHERE the click lands.` : "";
            const description = await ml.chat(base + guidance + viewNote, { images: shots.map(s => s.image), model, maxTokens, numCtx: VISION_NUM_CTX }) as string;
            // Progressive-disclosure tip, @pt targets ONLY (irrelevant for a DOM look):
            // the verify step is exactly where the model can see the point grazing the
            // target — steer it to snap with grid-grounding rather than click a near-miss.
            const pointTip = isPoint
                ? `\n\n(Verify before clicking. If the target IS visible in this preview but the mark isn't on it, re-locate just this area to snap onto it: locate({ description: "…", selector: "${selector}", strategy: "grounding" }) — searches only this box (add margin: 40–120 if the target is partly cut off at the edge). If the target ISN'T in this preview at all, it's the wrong spot: change \`region\`/description, don't re-verify here.)`
                : "";
            // Targeted no-overlay nudge — only when the box was DETECTED over text AND a clean copy wasn't already sent.
            const overTextTip = crossesText && shots.length === 1 ? BOX_OVER_TEXT_TIP : "";
            // Attach the inspected element on the side-channel (debug-only,
            // never to the model). Guarded so a stub-DOM/bad selector no-ops.
            let elements;
            if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
            // A `look` Out render: the EXACT image the reader saw, WHICH model read it, and its output —
            // so a delegated look reads like a locate substep, not the weird auto-derived element text.
            // (`model` is the resolved reader passed at wiring; `output` is the raw model reply, no tip.)
            const render: RenderDescriptor = { type: "look", image: shot, model, output: description, label: subject, prompt: base + guidance };
            // DOM legend of what's IN this crop (controls/media/boundaries/text with selectors) — bridges the
            // vision reply back to actionable selectors. Skipped for a downscaled full-page overview.
            const legend = fullPage ? "" : legendFor(selector || null, margin as number, memory?.boundariesSeen);
            return { content: description + pointTip + overTextTip + legend, render, ...(elements ? { elements } : {}) };
        }
    });
};

// A coordinate baked into a locate `description` — "(664, 280)", "664, 280", "x=664, y=280".
// The vision reader localizes by PIXELS, not numbers, so it's dead weight; and it's a tell that
// the model already knows roughly WHERE the target is (usually from a prior @pt it located) and is
// re-guessing with grounding instead of reusing that. The parenthesised form and the x=/y= form are
// unmistakable; the bare pair requires a SPACE after the comma so a thousands separator ("12,345")
// doesn't trip it.
const COORD_IN_DESC = /\(\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)|\b[xy]\s*[=:]\s*-?\d{2,4}\b|\b\d{2,4}\s*,\s+\d{2,4}\b/i;

// Delegated Set-of-Marks locator (see docs/spec + locate.ts). Screenshots the
// viewport, hit-test-sweeps for candidate elements (works on non-semantic UIs),
// draws numbered badges in memory, and asks a VISION model which badge matches the
// caller's description. Delegated like buildLookTool: the badged image is seen only
// by this sub-call + shown in the sidebar (via the `render` envelope) — it never
// enters the driver's history, so a text-only driver can still use it. Returns the
// chosen element's selector (stateless currency) for click/type/answer.
export const buildLocateTool = (ml: MlApi, { model = null, groundingModel = null, groundingRange = DEFAULT_GROUNDING_RANGE, maxTokens = 64, memory = null }: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number; memory?: VisionMemory | null } = {}): MlTool => {
    const listOf = (marks: { id: number; role: string; name: string; selector: string }[]) =>
        marks.map(m => `#${m.id} [${m.role}] ${m.name ? `"${truncate(m.name, 50)}"` : "(no accessible name)"}  →  ${m.selector}`).join("\n");
    // Per-run cache of the grounding call (undefined = not asked; null = it errored).
    // The tool lives for one ml.agent run, so a `margin` retry reuses the cached
    // coords + prompt/image and re-runs only the cheap DOM sweep — no 2nd VLM call.
    type GroundCache = { nums: number[] | null; square: string; prompt: string; answer: string };
    const groundCache = new Map<string, GroundCache | null>();
    return ml.defineTool({
        name: "locate",
        summary: "Finds an on-screen element by describing how it looks.",
        capabilities: ["vision"],
        description: "Find an on-screen control by DESCRIBING how it looks — for unlabelled icons, " +
            "custom widgets, canvas, or any UI you can't reach by text or a guessed selector. Returns a " +
            "CSS selector (or an `@pt:…` coordinate, for canvas) to pass to click/type/answer. Sees only " +
            "the current viewport (scroll the target into view first). " +
            "If the target sits on a <canvas> (a game/drawing surface — no DOM nodes inside it), FIRST " +
            "identify the canvas and pass ITS selector as `selector` so the search is cropped to it; the " +
            "result is an `@pt:…` coordinate token (there's no element to select), which you verify with " +
            "look({ selector: \"@pt:…\" }) and then click. On a busy canvas UI, zoom in with `container: " +
            "true` — the grounding model outlines a panel/card/toolbar and returns an `@box:…` region " +
            "token; scope back into it (selector: \"@box:…\") to find a control, recursing box→sub-box→@pt.",
        parameters: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "What to find, described by its APPEARANCE — colour, shape, icon, and any " +
                        "visible text — NOT by a name, brand, or role the vision model can't see (it reads " +
                        "pixels, not names). Good: \"a red heart icon\", \"a round blue button with a " +
                        "magnifying glass\", \"the star/favourite icon next to the chat title\". Bad: \"Big Pete\", " +
                        "\"the delete handler\", \"the submit button\" (say what it LOOKS like instead)."
                },
                filter: {
                    type: "string",
                    enum: ["clickables", "inputs", "images", "all"],
                    description: "Which elements to consider (default 'clickables')."
                },
                selector: {
                    type: "string",
                    description: "Optional CONTAINER selector to crop scanning to (a modal, a list row) — better for a small target in a busy area. For a target on a <canvas>, pass the canvas's selector here. For iframes or shadow roots, pass a selector to the iframe or shadow root parent element here! NOT the target's own selector. An `@pt:…` token also works: re-searches the box around that point with ANY strategy (e.g. grid inside a point)."
                },
                index: {
                    type: "integer",
                    description: "Which match of `selector` to scope to (0-based); default 0."
                },
                margin: {
                    type: "integer",
                    description: "For 'grounding': grow the predicted box by N px (try 40–120) and re-match — when a box snapped to the WRONG element. Reuses the cached box (no 2nd vision call)."
                },
                strategy: {
                    type: "string",
                    enum: ["auto", "grounding", "marks", "grid", "grid-grounding"],
                    description: "Default 'auto'. 'grounding' = a coordinate model points at it (needs one configured; best for a clear spot). 'marks' = numbered badges, model picks by number (robust when cluttered). 'grid' = a numbered grid, model picks the CELL (any vision model; zoom with `cells` or raise `gridSize`). 'grid-grounding' = grid narrows to a cell, THEN grounding points precisely inside it (needs a grounding model; best for a small target on a busy page or canvas, where a plain grid centre only grazes). 'auto' = grounding then marks."
                },
                region: {
                    type: "string",
                    enum: ["left", "right", "top", "bottom", "center", "top-left", "top-right", "bottom-left", "bottom-right"],
                    description: "Coarse pre-crop by rough position BEFORE the grid — for a dense scene where the grid has too many near-identical cells to pick from (you can vaguely tell 'left'/'bottom' even when you can't read a cell number). Bands are full-length ('left' = left side, full height); corners are quadrants. Halves overlap, so if unsure which side, guess one and try the opposite on a miss. Composes with any strategy."
                },
                gridSize: {
                    type: "integer",
                    description: "For 'grid': base cell count (default 4, 2–8; the grid maxes out ~60 cells). To go FINER, don't raise this — zoom with `cells` (a fresh grid inside a cell) or pre-crop with `region`."
                },
                cells: {
                    type: "array",
                    items: { type: "integer" },
                    description: "A previously-returned cell selection (1, 2 adjacent, or a 2×2 block of 4). 'grid' draws a fresh grid inside it (recursive zoom); 'grid-grounding' grounds directly inside it (reuses the pick — no re-roll)."
                },
                container: {
                    type: "boolean",
                    description: "Set true to OUTLINE a sub-area rather than pick a control — the grounding model boxes a container (a panel, card, toolbar, dialog) and returns an `@box:…` region token instead of a click point. Use it on a busy <canvas> UI to zoom in: get the container box, then locate({ selector: \"@box:…\", description: \"…\" }) to find a control INSIDE it (recurse as needed), and click the final `@pt:…`. Needs a grounding model."
                },
                verify: {
                    type: "boolean",
                    description: "This is an 'inline look()' option that saves you a turn. For a grounding result that resolves to a DOM element or an `@box:…` region: also return the marked crop for confirmation — structurally the same as calling look() on the result right after locating, but folded into THIS call (one turn, one screenshot; no extra round-trip). A point/`@pt:…` result ALWAYS returns one (you always verify a coordinate). Default false: a DOM element selector usually needs no visual check. Set true to eyeball a grounded element/region before acting."
                },
            },
            required: ["description"],
        },
        run: async ({ description, filter = "clickables", margin = 0, strategy = "auto", selector, index = 0, gridSize, cells, region: regionName, container = false, verify = false }: { description: string; filter?: MarkFilter; margin?: number; strategy?: "auto" | "grounding" | "marks" | "grid" | "grid-grounding"; selector?: string; index?: number; gridSize?: number; cells?: number[]; region?: RegionName; container?: boolean; verify?: boolean }, ctx?: ToolContext) => {
            if (!description) return "Provide a `description` of the element to find.";
            // Does the DRIVER see the injected crop natively? Resolved ONCE in the auto-wire, read here off ctx
            // (the same answer that chose native vs delegated `look`) — snap-feedback injects an image vs a description.
            const driverSees = !!ctx?.driverSees;
            // Coordinates in the description mean the model already knows roughly where the target is
            // and is re-guessing with grounding — steer it to REUSE that knowledge. Skip when already
            // scoped to an @pt/@box (then it's doing the right thing; the coords are just noise).
            const alreadyScoped = typeof selector === "string" && (POINT_RE.test(selector.trim()) || BOX_RE.test(selector.trim()));
            if (COORD_IN_DESC.test(description) && !alreadyScoped) {
                return `Your \`description\` contains COORDINATES — the vision model localizes by pixels, not numbers, so they're ignored. But it means you already know roughly WHERE the target is; use that instead of re-guessing with grounding:\n` +
                    `• If those coordinates came from an \`@pt:…\` token you located earlier, RE-SEARCH the box around it: locate({ description: "<appearance only, drop the coordinates>", selector: "@pt:…", strategy: "grounding", margin: 100 }) — the point IS the scope; \`margin\` (40–120) grows the box if the target sits near its edge. This reuses the verified point instead of guessing a fresh coordinate.\n` +
                    `• If you have NO such token, narrow by rough area: locate({ description: "<appearance only>", region: "center", strategy: "grid" }) — pick the \`region\` (left/right/top-left/center/…) nearest that spot. Then remove the coordinates from the description.`;
            }
            const dpr = window.devicePixelRatio || 1;
            const RED = "#ff2d55", YELLOW = "#eab308";
            const rectOf = (b: Box) => ({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top });
            const pickedStr = (m: { role: string; name: string; selector: string }) => `[${m.role}]${m.name ? ` "${m.name}"` : ""} → ${m.selector}`;
            // One phrasing for the Set-of-Marks substep, whether it's the primary mechanism
            // or the grid hand-off's second stage.
            const somLabel = (n: number, chosen?: Mark) => `Set-of-Marks · ${n} candidate${n === 1 ? "" : "s"}${chosen ? ` · model chose #${chosen.id}` : ""}`;
            let shot: string | undefined;   // captured once, shared between mechanisms
            const avoidHues = colorWordHues(description);   // don't overlay the target's own colour

            // Draw numbered badges over `marks` — full-frame, or translated onto a crop of
            // `crop` (a scoped/grid-cell view, for a tighter, more legible image). The badge
            // colour contrasts with the page (and avoids the target's colour). Shared by
            // strategy 'marks' and grid's in-cell disambiguation.
            const badgeMarks = async (marks: Mark[], crop?: { left: number; top: number; width: number; height: number }): Promise<string> => {
                if (!shot) shot = await ml.screenshot(null, {});
                const src = crop ? await cropDataUrl(shot, crop, dpr) : shot;
                const color = await pickOverlayColor(src, avoidHues);
                const box = (m: Mark) => crop ? { left: m.rect.left - crop.left, top: m.rect.top - crop.top, width: m.rect.width, height: m.rect.height } : m.rect;
                return annotate(src, marks.map(m => ({ rect: box(m), color, badge: m.id })), dpr);
            };
            // Ask the vision reader which badge matches; returns the chosen mark (or none),
            // the raw answer, and the prompt sent (for the substep's In/Out debug view).
            const askMarks = async (marks: Mark[], badged: string, reader: string | null, note = ""): Promise<{ chosen?: Mark; answer: string; prompt: string }> => {
                const prompt = `The screenshot has numbered badges (#1–#${marks.length}) drawn over candidate ` +
                    `elements. Which single badge number best matches this element: "${description}"${note}? ` +
                    `Reply with ONLY the number, or "NONE" if none match.`;
                const answer = String(await ml.chat(prompt, { images: [badged], model: reader, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                const pick = (answer.match(/\d+/) || [])[0];
                return { chosen: pick ? marks.find(m => m.id === Number(pick)) : undefined, answer, prompt };
            };
            // Draw a green ring on the chosen badge — the human "visualise" view of a
            // Set-of-Marks pick (the model saw the plain badged `raw` image).
            const highlightPick = async (badged: string, mark: Mark, crop?: { left: number; top: number; width: number; height: number }): Promise<string> => {
                const rect = crop ? { left: mark.rect.left - crop.left, top: mark.rect.top - crop.top, width: mark.rect.width, height: mark.rect.height } : mark.rect;
                // Sample the BADGED image (not the shot) so the highlight avoids the badge
                // colour too — otherwise both can land in the page's emptiest hue and clash.
                return annotate(badged, [{ rect, color: await pickAccentColor(badged, avoidHues), label: `#${mark.id}` }], dpr);
            };
            // Substeps accumulated by an EARLIER mechanism (an 'auto' grounding attempt that
            // missed) so the Set-of-Marks fallback still shows what grounding saw.
            const priorSubsteps: LocateSubstep[] = [];
            // Set when a plain `strategy:"grid"` cell landed on a canvas and a grounding model
            // is available — we auto-upgrade to grid-grounding (grounding pinpoints inside the
            // cell) instead of returning the imprecise cell centre. Noted in the result.
            let autoUpgraded = false;
            // The cell-CENTRE @pt to fall back to if the auto-upgraded grounding whiffs (no box
            // / error): the upgrade must never be WORSE than the plain-grid cell centre it
            // replaced. Stashed in the grid block (holds its cell-scoped advice strings).
            let autoUpFallback: { x: number; y: number; cellBox: Box; cellNote: string; offAdvice: string } | null = null;

            if (strategy === "grounding" && !groundingModel) {
                return "No grounding model is configured — use strategy 'marks' (or leave it 'auto').";
            }

            // Optional `selector` scoping: crop and search a container's region on its own.
            // Scrolls it into view first (like look/click), then clips to the viewport so the
            // cropped pixels and the coordinate projection stay in lockstep.
            let region = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            let scopeSel = "";
            // True once the search region is narrowed (a `selector` container, or a
            // grid-grounding cell) — so the marks fallback scans that region, not the viewport.
            let scoped = false;
            if (selector && BOX_RE.test(selector.trim())) {
                // `@box:` scope — search INSIDE a previously-outlined canvas container
                // (from locate({ container: true })). Just a coordinate crop; no DOM node.
                const bx = resolveBox(selector);
                if (!bx) return `Unknown container token "${selector}" — re-run locate({ container: true }) for a fresh one.`;
                const m = margin > 0 ? margin : 0;   // grow the box on a margin retry (cut-off target)
                const left = Math.max(0, bx.left - m), top = Math.max(0, bx.top - m);
                region = { left, top, width: Math.min(window.innerWidth, bx.right + m) - left, height: Math.min(window.innerHeight, bx.bottom + m) - top };
                if (region.width < MIN_SHOT_PX || region.height < MIN_SHOT_PX) return `The container ${selector} is too small or off-screen to search within. Re-locate it, or drop the scope.`;
                scopeSel = selector;
                scoped = true;
            } else if (selector && POINT_RE.test(selector.trim())) {
                // `@pt:` scope ("snap around point") — search the SAME neighborhood box
                // that look() showed around a canvas point. The model re-locates an area it
                // just VISUALLY CONFIRMED holds the target, so grounding inside that ~200px
                // box snaps precisely — the finest zoom tier, seeded by a verified view. No
                // DOM node / scroll; just crop around the coordinate (clipped to viewport).
                const pt = resolvePoint(selector);
                if (!pt) return `Unknown point token "${selector}" — re-run locate for a fresh one.`;
                // `margin` grows the crop so a target cut off at the box edge comes into frame.
                const R = PT_LOOK_RADIUS + (margin > 0 ? margin : 0);
                const left = Math.max(0, pt.x - R), top = Math.max(0, pt.y - R);
                region = { left, top, width: Math.min(window.innerWidth, pt.x + R) - left, height: Math.min(window.innerHeight, pt.y + R) - top };
                if (region.width < MIN_SHOT_PX || region.height < MIN_SHOT_PX) return `The area around ${selector} is too small to search (the point is at the viewport edge). Scroll it toward centre, or locate on the canvas selector instead.`;
                scopeSel = selector;
                scoped = true;
            } else if (selector) {
                let matches: Element[];
                try { matches = queryAll(selector); } catch (e) { return selectorError(selector, e as Error); }
                const el = matches[index];
                if (!isElement(el)) return `No element matches "${selector}"${index ? ` at index ${index}` : ""}${matches.length ? ` (only ${matches.length} match${matches.length === 1 ? "" : "es"})` : ""}. Scroll it into view or refine the selector, then call locate again.`;
                try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* detached/older engine */ }
                // Let the scroll paint before we measure/capture (guarded for non-visual envs).
                await new Promise<void>(res => typeof requestAnimationFrame === "function"
                    ? requestAnimationFrame(() => requestAnimationFrame(() => res()))
                    : res());
                const r = el.getBoundingClientRect();
                if (r.width < MIN_SHOT_PX || r.height < MIN_SHOT_PX) {
                    return `The container "${selector}"${index ? ` (match #${index})` : ""} is ${Math.round(r.width)}×${Math.round(r.height)}px — too small to search within (hidden, collapsed, or a sliver?). Target a larger container, or drop \`selector\` to search the whole viewport.`;
                }
                const left = Math.max(0, r.left), top = Math.max(0, r.top);
                region = { left, top, width: Math.min(window.innerWidth, r.right) - left, height: Math.min(window.innerHeight, r.bottom) - top };
                scopeSel = selector;
                scoped = true;
            }
            // Optional `region` pre-crop: the level-0 coarse split. Narrows the search
            // to a named directional area (of the container, or the viewport) BEFORE any
            // mechanism runs — so every strategy inherits it, like `selector` does. The
            // model names it from rough position ("left") when a dense grid has too many
            // near-identical cells to pick a number from.
            let regionCrop = "";
            if (regionName) {
                // Tolerate natural/British variants; reject anything else with the valid
                // list (else regionBox would destructure undefined and throw cryptically —
                // and the model does guess plausible-but-unlisted names like "center-left").
                const REGION_ALIASES: Record<string, RegionName> = { centre: "center", middle: "center", mid: "center" };
                const rn = (REGION_ALIASES[String(regionName).toLowerCase()] || regionName) as RegionName;
                if (!REGION_NAMES.includes(rn)) {
                    return `Invalid region "${regionName}". Use exactly one of: ${REGION_NAMES.join(", ")}. Bands are full-length ("left" = the whole left side); for a finer area, pick the nearest of these and then zoom with grid \`cells\`.`;
                }
                const rb = regionBox(rn, region);
                region = { left: rb.left, top: rb.top, width: rb.right - rb.left, height: rb.bottom - rb.top };
                if (region.width < MIN_SHOT_PX || region.height < MIN_SHOT_PX) {
                    return `The "${regionName}" region${scopeSel ? ` of "${scopeSel}"` : ""} is only ${Math.round(region.width)}×${Math.round(region.height)}px — too small to search. Drop \`region\`, or scope to a larger container first.`;
                }
                scoped = true;
                regionCrop = ` (${rn})`;
            }
            let regionAsBox: Box = { left: region.left, top: region.top, right: region.left + region.width, bottom: region.top + region.height };
            const scopeNote = (scopeSel ? ` within "${scopeSel}"${index ? ` (#${index})` : ""}` : "") + regionCrop;
            // Tips disclosed IN the results (kept out of the tool description, which the model
            // half-reads) so each fires exactly when it applies.
            const actHint = "(verify it with look() first, then click/type/answer with this selector)";
            const canvasScopeTip = scopeSel ? "" : " For tighter coordinates, first scope to the canvas by passing its selector to locate.";
            // Mint an @pt AND detect a re-locate loop: if this spot ~matches one already
            // located this run, warn (each mint is a fresh token, so the model otherwise
            // can't tell it keeps landing on the same wrong coordinate — a real failure
            // mode on a hard canvas). Check before minting so it can't match itself.
            const mintPointWarned = (x: number, y: number): { token: string; dupWarn: string } => {
                const dup = nearbyPoint(x, y);
                const token = mintPoint(x, y);
                const dupWarn = dup ? ` ⚠ This is essentially the SAME spot as ${dup.token} (${dup.x}, ${dup.y}) you already located and it didn't work — do NOT re-verify it. Change approach: a different \`region\`, a re-worded description, or another strategy.` : "";
                return { token, dupWarn };
            };

            // Feed a GROUNDING SNAP back into the driver's context so it can confirm in-turn and skip the
            // separate look() → click round-trip (only fires here, where grounding actually located
            // something — never the grid cell-CENTRE fallback, which stays manual by design). A point/@pt
            // ALWAYS injects (the model always verifies a coordinate); a DOM element / @box only when the
            // caller passed `verify` (a selector rarely needs an eyeball). A vision driver gets the marked
            // crop as an inline IMAGE; a text-only driver gets a delegated DESCRIPTION of it (the same
            // native/delegated split look() uses) with a clarification. Near-area dedup: if the model was
            // already shown this spot (a prior look()/inject), skip re-injecting the near-identical crop.
            const feedBack = async (base: ToolResult, o: { kind: "pt" | "selector" | "box"; target: string; label: string; x?: number; y?: number }): Promise<ToolResult> => {
                if (o.kind !== "pt" && !verify) return base;   // selector/@box are opt-in
                // Why the crop entered the model's context — surfaced in the debug render + export.
                const reason = o.kind === "pt"
                    ? "point located — fed back automatically (you always verify a coordinate)"
                    : `you set verify: true (equivalent to a follow-up look() on the ${o.kind === "box" ? "region" : "element"}, folded into this call)`;
                if (o.kind === "pt" && o.x != null && o.y != null) {
                    // Near-area dedup: if the model was already shown this spot, skip re-injecting the
                    // near-identical crop (the re-snap-loop case) — UNLESS it EXPLICITLY asked (verify:true),
                    // in which case the explicit request wins (it clearly wants a fresh look here). The dedup
                    // path carries a `feedback` too, so "Sent to the model" says plainly that NO image went in
                    // (otherwise the only visible image is the grounding debug viz, which reads as "it saw this").
                    if (seenNearby(memory, o.x, o.y) && !verify) {
                        markSeen(memory, o.x, o.y);
                        return { ...base, content: base.content + "\n\n(You've already been shown this spot — not re-injecting the crop; act on what you saw, or change approach.)",
                            feedback: { reason: "near a spot you were already shown — crop NOT re-injected (dedup)", via: "text", text: "No new image was sent — you'd already been shown this spot. Act on the earlier crop, or change approach." } };
                    }
                    markSeen(memory, o.x, o.y);
                }
                // The image the model RECEIVES is the SAME tight crop look({@pt}/selector) gives by default —
                // a ~200px marked crop of the point (or the element/region), NOT the full annotated viewport
                // (that stays in the debug Out render): too much screen to send. Regenerate via screenshot;
                // if it fails, skip the inject rather than dump the whole page on the model.
                let sent: string;
                try { sent = await ml.screenshot(o.target, {}); } catch { return base; }
                // For an @pt the crop carries a box labelled "click point" at the EXACT landing spot (its colour is
                // contrast-picked, so name it by LABEL not colour). Steer the model to confirm the target sits under
                // its MIDDLE and, if not, re-snap this SAME point (grounding around it) instead of clicking a
                // near-miss — the re-locate loop, now with an explicit trigger tied to the image it's looking at.
                const reSnap = o.kind === "pt"
                    ? ` If the target is NOT centred under it, do NOT click — if you can see the element in the image then you can directly re-snap this **SAME** point using this **EXACT** call (which is more precise than doing a new 'locate' call from scratch!!!): locate({ selector: "${o.target}", strategy: "grounding", margin: 60, description: "<the target's appearance>" }), then verify again.`
                    : "";
                // DOM legend of the located area — for a canvas/cross-origin @pt this flags "no DOM here /
                // cross-origin iframe, use @pt"; for a DOM target it names the controls/text around it.
                const legend = legendFor(o.target, 0, memory?.boundariesSeen);
                if (driverSees) return { ...base, content: base.content + `\n\n Marked crop shown in the next prompt.${o.kind === "pt" ? ` Confirm "${truncate(description, 50)}" sits under the MIDDLE of the box labelled "click point".` : ""} If it's on target, act now (no need to look() first).${reSnap}${legend}`, image: sent, imageLabel: o.label, feedback: { reason, via: "image", image: sent, label: o.label } };
                // Text-only driver: the reader describes the crop; the driver gets words, not the image.
                const describePrompt = `Describe concisely what is at the marked spot on this crop — its colour, shape, and any text — so I can tell whether it's the "${truncate(description, 60)}" I asked for.${CLICK_MARK_NOTE}`;
                let desc: string;
                try { desc = String(await ml.chat(describePrompt, { images: [sent], model, maxTokens: 256, numCtx: VISION_NUM_CTX })).trim(); }
                catch { return base; }   // describe failed → leave the manual look() nudge intact
                return { ...base, content: base.content + `\n\n👁 Target preview — you can't see images, so this is ${model || "the reader"}'s description of what's under the "click point" mark (NOT the image itself). Judge whether that's "${truncate(description, 50)}", then act or re-locate:\n${desc}${reSnap}${legend}`, feedback: { reason, via: "text", text: desc, prompt: describePrompt, image: sent, label: o.label } };
            };

            // grid-grounding needs a grounding model on BOTH its paths (fresh pick and the
            // cells-reuse shortcut below) — check once here so the reuse path can't silently
            // fall through to marks when no grounder is configured.
            if (strategy === "grid-grounding" && !groundingModel) return "strategy 'grid-grounding' needs a grounding model configured — use 'grid' instead, or configure one in the popup.";
            // Container mode outlines a region via grounding, so it needs a grounder and
            // must run the grounding mechanism (route a 'marks'/'grid' strategy through it).
            if (container) {
                if (!groundingModel) return "container mode (outlining an @box region) needs a grounding model — configure one in the popup, or narrow with `region` / grid `cells` instead.";
                if (strategy === "marks" || strategy === "grid") strategy = "grounding";
            }

            // grid-grounding + `cells` → REUSE a prior grid pick. Skip the (nondeterministic)
            // grid vision re-pick entirely: narrow the region to the given cell(s) here and
            // let the grounding mechanism pinpoint inside it. This makes "reuse cell 15"
            // deterministic — re-rolling the pick could return NONE on the same target.
            let ggReuse = false;
            if (strategy === "grid-grounding" && cells && cells.length) {
                const base = Math.max(2, Math.min(8, Math.round(gridSize || 4)));
                const prev = gridDims(region, base);
                const v = validateCells(cells, prev.cols, prev.rows);
                if (!v.ok) return `Invalid \`cells\` ${JSON.stringify(cells)} — ${v.reason}. (Cells map to the grid at gridSize ${base}; pass the same gridSize the pick used.)`;
                const cb = cellsBox(cells, prev.cols, prev.rows, region);
                const w = cb.right - cb.left, h = cb.bottom - cb.top;
                if (w < MIN_SHOT_PX || h < MIN_SHOT_PX) return `Cell ${cells.join(",")} is too small to ground within. Drop \`cells\`, or re-pick a coarser one.`;
                region = { left: cb.left, top: cb.top, width: w, height: h };
                regionAsBox = cb;
                scoped = true;
                ggReuse = true;
            }

            // Mechanism #3 — grid: draw an aspect-matched numbered grid, ask which CELL(S)
            // hold the target (multiple-choice → no coordinate hallucination). The model may
            // pick 1, 2 (adjacent), or 4 (a 2×2 block) cells so a target straddling a grid
            // line is fully covered; we union them, sweep the DOM, and — when the region
            // still holds several candidates — hand off to marks WITHIN it rather than
            // guessing the first. `cells` zooms into a prior selection (hierarchical refine).
            //
            // 'grid-grounding' shares this cell-pick, then narrows `region` to the chosen
            // cell and falls through to the grounding mechanism below — the grid coarsely
            // localizes, then grounding places a PRECISE point inside the small cell (where
            // a plain grid's cell centre only grazes an off-centre target, esp. on canvas).
            // (Skipped when ggReuse already narrowed to a caller-supplied cell.)
            if (!ggReuse && (strategy === "grid" || strategy === "grid-grounding")) {
                const reader = model || groundingModel;
                if (!reader) return "No vision model is available to read the grid.";   // grid-grounding's grounding-model guard already fired above
                const base = Math.max(2, Math.min(8, Math.round(gridSize || 4)));
                // A driver zoom: narrow to a previously-returned, validated cell selection.
                let gRegion = region;
                if (cells && cells.length) {
                    const prev = gridDims(region, base);
                    const v = validateCells(cells, prev.cols, prev.rows);
                    if (!v.ok) return `Invalid \`cells\` ${JSON.stringify(cells)} — ${v.reason}.`;
                    gRegion = rectOf(cellsBox(cells, prev.cols, prev.rows, region));
                }
                if (gRegion.width < MIN_SHOT_PX || gRegion.height < MIN_SHOT_PX) {
                    return `That region is too small to subdivide further. Use the returned selectors, or switch strategy.`;
                }
                const { cols, rows } = gridDims(gRegion, base);   // aspect-matched — no wasted rows
                if (!shot) shot = await ml.screenshot(null, {});
                let gridded: string;
                try { gridded = await drawGrid(await cropDataUrl(shot, gRegion, dpr), cols, rows, dpr, avoidHues); }
                catch (e) { return `Error drawing the grid: ${errText(e)}`; }
                const gprompt = `This image is divided into a ${cols}×${rows} numbered grid (cells 1–${cols * rows}, numbered left-to-right, top-to-bottom). ` +
                    `Which cell contains ${description}${scopeNote}? If the target sits ON a grid line or spans more than one cell, reply with the 2 adjacent cells (or a 2×2 block of 4) that cover it; otherwise the single cell. ` +
                    `Reply with ONLY the cell number(s), comma-separated, or "NONE".`;
                const ans = String(await ml.chat(gprompt, { images: [gridded], model: reader, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                const sel = [...new Set((ans.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= cols * rows))].slice(0, 4);
                const gmodel = String(reader);
                const cellLabel = (chose: string) => `Cell pick · grid ${cols}×${rows} · ${chose}`;
                const gridResult = (substeps: LocateSubstep[], extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                    ({ type: "locate" as const, mode: "grid" as const, model: gmodel, substeps, ...extra });
                if (!sel.length) {
                    // Dense scene → a 60-cell grid of near-identical items is impossible to
                    // pick from. Steer to the level-0 coarse split (`region`) first; only offer
                    // "raise gridSize" while it's still below the ~60-cell cap.
                    const steer = regionName
                        ? ` You already cropped to "${regionName}" — the target may be elsewhere; try the opposite side or another region.`
                        : ` If the scene is too dense to pick one cell, narrow by rough position FIRST: region: "left"/"right"/"top"/"bottom"/a corner/"center" (unsure? guess a side, try the opposite on a miss) — the grid then runs inside just that area.`;
                    const alt = `${groundingModel ? " Or strategy 'grid-grounding'." : ""}${base < 8 ? " Or raise gridSize for finer cells." : ""}`;
                    return { content: `The model matched no grid cell for "${description}"${scopeNote} (replied "${truncate(ans, 40)}").${steer} Or refine the description / switch to 'marks'.${alt}`, render: gridResult([{ label: cellLabel("no cell matched"), prompt: gprompt, output: ans, image: gridded }]) };
                }
                const valid = validateCells(sel, cols, rows);
                if (!valid.ok) {
                    return { content: `The model selected cells ${JSON.stringify(sel)}, not a valid pick (${valid.reason}). Ask it again, or switch strategy.`, render: gridResult([{ label: cellLabel(`chose cells ${sel.join(",")} (invalid)`), prompt: gprompt, output: ans, image: gridded }]) };
                }
                const cellNote = `cell${sel.length > 1 ? "s" : ""} ${sel.join(",")}`;
                // Concrete reuse calls (so the model knows `cells` is a locate arg, not a bare
                // fragment). `cells` only map back under the SAME gridSize, so carry it whenever
                // it's non-default — the compact form of that caveat.
                const dsc = truncate(description, 50);
                const cellsArg = sel.join(",");
                const gsArg = base !== 4 ? `, gridSize: ${base}` : "";
                const gridZoomCall = `locate({ description: "${dsc}", strategy: "grid", cells: [${cellsArg}]${gsArg} })`;
                // Name the real neighbour cells by direction (+ an example) — the driver never
                // sees the grid, so "try an adjacent cell" is a dangling reference otherwise.
                const adj = adjacentCells(sel, cols, rows);
                const adjEntries = Object.entries(adj) as [string, number][];
                const neighbourHint = adjEntries.length
                    ? ` If it's actually in a neighbouring cell, try — ${adjEntries.map(([d, n]) => `${d} ${n}`).join(", ")} — e.g. locate({ description: "${dsc}", strategy: "grid", cells: [${adjEntries[0][1]}]${gsArg} }).`
                    : "";
                // The "zoom in" line for DOM results (a fresh grid recurses inside the cell).
                const refineHint = `zoom in — ${gridZoomCall} draws a fresh grid inside that cell.${neighbourHint}`;
                // Highlight the selection on the grid the model saw (crop-local coords) — the
                // human "visualise" view; the model saw the plain `gridded` (rawImage).
                const localBox = cellsBox(sel, cols, rows, { left: 0, top: 0, width: gRegion.width, height: gRegion.height });
                const griddedImage = await annotate(gridded, [{ rect: rectOf(localBox), color: await pickAccentColor(gridded, avoidHues), label: cellNote }], dpr);
                const cellStep: LocateSubstep = { label: cellLabel(`model chose ${cellNote}`), prompt: gprompt, output: ans, rawImage: gridded, image: griddedImage };
                // Snap the unioned selection to the DOM. A <canvas> is NOT a real target (no
                // sub-node) — drop it (esp. under filter:"all", which returns the canvas itself)
                // so a canvas cell falls to a coordinate point, never a SoM hand-off over pixels.
                const cellBox = cellsBox(sel, cols, rows, gRegion);
                // Snap the unioned selection to the DOM. A <canvas> is NOT a real target (no
                // sub-node) — drop it so a canvas cell falls to a coordinate, never a SoM pick.
                const found = collectInBox(cellBox, filter, { max: 20 }).filter(el => !isOpaqueEl(el));
                const cpt = found.length ? null : opaquePointIn(cellBox);
                // AUTO-UPGRADE: a plain-grid canvas cell with a grounder available → treat it
                // like grid-grounding (grounding pinpoints inside the cell) rather than returning
                // the imprecise cell centre. On a canvas the snap can't hurt (no element to
                // mis-snap), so it's a free precision win.
                autoUpgraded = strategy === "grid" && !!cpt && !!groundingModel;
                if (strategy === "grid-grounding" || autoUpgraded) {
                    // Narrow the region to the chosen cell and fall through to the grounding
                    // mechanism (it handles the DOM snap / canvas @pt / marks fallback). `cellStep`
                    // rides along as the first debug substep.
                    region = rectOf(cellBox);
                    regionAsBox = cellBox;
                    scoped = true;
                    priorSubsteps.push(cellStep);
                    // If the cell is on a canvas (`cpt` set), stash the cell centre so a
                    // grounding whiff returns THAT, not the marks-on-canvas dead end ("no
                    // clickables in the cell"). Applies to BOTH the auto-upgrade and an
                    // EXPLICIT grid-grounding — marks can never work inside a canvas cell.
                    if (cpt) autoUpFallback = { x: cpt.x, y: cpt.y, cellBox, cellNote, offAdvice: ` If it lands OFF the target, ${refineHint}` };
                } else {
                if (!found.length) {
                    // No real DOM element → a canvas coordinate at the cell CENTRE (no grounder
                    // here, else we'd have auto-upgraded above), else empty. The centre can graze
                    // an off-centre target, so steer off-target to zoom + the real neighbour cells.
                    if (cpt) {
                        const { token, dupWarn } = mintPointWarned(cpt.x, cpt.y);
                        const ptImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }, { rect: { left: cpt.x - 11, top: cpt.y - 11, width: 22, height: 22 }, color: RED, label: "point" }], dpr);
                        return {
                            content: `Grid ${cellNote}${scopeNote} is on ${surfaceNoun(cpt.kind)} — no DOM element, so this is a COORDINATE: ${token} at (${Math.round(cpt.x)}, ${Math.round(cpt.y)}). First verify, then click: look({ selector: "${token}" }) → click({ selector: "${token}" }).${reservedClickNote(cpt.kind)}${dupWarn} If it lands OFF the target, ${refineHint}${canvasScopeTip}`,
                            render: gridResult([cellStep, { label: `${cpt.kind === "canvas" ? "Canvas" : cpt.kind === "iframe" ? "Iframe" : "Sealed-shadow"} point · in the cell`, image: ptImg }], { picked: `${token} @ (${Math.round(cpt.x)}, ${Math.round(cpt.y)})`, pickedBy: "snap" }),
                        };
                    }
                    const snapImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }], dpr);
                    return { content: `Grid ${cellNote} for "${description}"${scopeNote} has no ${filter} element under it. Re-pick, raise gridSize, or switch strategy.`, render: gridResult([cellStep, { label: "DOM snap · no element under the cell", image: snapImg }]) };
                }
                const marks = buildMarks(found);
                if (found.length === 1) {
                    // Exactly one element under the cell → snap to it directly (no 2nd call).
                    const picked = marks[0], pk = pickedStr(picked);
                    const snapImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }, { rect: picked.rect, color: RED, badge: 1 }], dpr);
                    return {
                        content: `Grid ${cellNote}${scopeNote} → ${pk}\n${actHint}\n\n${refineHint}\n\nCandidates in that region:\n${listOf(marks)}`,
                        elements: [picked.el, ...found.filter(e => e !== picked.el)].slice(0, 50),
                        render: gridResult([cellStep, { label: "DOM snap · single element in the cell", image: snapImg }], { picked: pk, pickedBy: "snap" }),
                    };
                }
                // Several candidates → a SECOND vision sub-call picks by badge (Set-of-Marks on
                // just the selected cells), instead of snapping to the first.
                const raw = await badgeMarks(marks, rectOf(cellBox));
                const { chosen, answer, prompt: somPrompt } = await askMarks(marks, raw, reader, scopeNote);
                const handoffNote = `The cell held ${found.length} elements, so they were re-badged and a second vision call picked one (Set-of-Marks).`;
                if (!chosen) {
                    // NONE from the hand-off means the target isn't among this cell's elements
                    // → the CELL was likely wrong. Do NOT zoom into it (futile); re-pick or switch.
                    return { content: `None of ${cellNote}'s ${found.length} candidates matched "${description}" (model replied "${truncate(answer, 40)}") — the target is probably NOT in that cell, so do NOT zoom into it. Re-run grid for a fresh cell pick (optionally a larger gridSize), or switch to strategy 'marks'. You can also look() at these to double-check:\n${listOf(marks)}`, elements: found.slice(0, 50), render: gridResult([cellStep, { label: somLabel(found.length), note: handoffNote, prompt: somPrompt, output: answer, rawImage: raw, image: raw }]) };
                }
                const pk = `#${chosen.id} ${pickedStr(chosen)}`;   // the badge the model chose
                const viz = await highlightPick(raw, chosen, rectOf(cellBox));
                return {
                    content: `Grid ${cellNote}${scopeNote} → badged ${found.length} candidates → model picked ${pk}\n${actHint}\n\n${refineHint}\n\nCandidates in that region:\n${listOf(marks)}`,
                    elements: [chosen.el, ...found.filter(e => e !== chosen.el)].slice(0, 50),
                    render: gridResult([cellStep, { label: somLabel(found.length, chosen), note: handoffNote, prompt: somPrompt, output: answer, rawImage: raw, image: viz }], { picked: pk, pickedBy: "model" }),
                };
                }
            }

            // A note carried onto the Set-of-Marks substep when 'auto' tried grounding and
            // it missed (the grounding attempt's own substeps are in priorSubsteps).
            let fallbackNote: string | undefined;

            // Mechanism #1 — grounding VLM: ask for a box, snap it to the DOM by
            // hit-testing. Sent as a 1000×1000 square so `coord/groundingRange` is a
            // per-axis fraction for ANY convention.
            if (groundingModel && strategy !== "marks") {
                // Key the cache on the region too, so a grid-grounding pass (region = a picked
                // cell) doesn't collide with the full-viewport prediction — while a `margin`
                // retry (same region) still hits.
                const rk = `${Math.round(region.left)},${Math.round(region.top)},${Math.round(region.width)},${Math.round(region.height)}`;
                const key = `${filter}\x00${scopeSel}\x00${index}\x00${rk}\x00${description}`;
                let cached = groundCache.get(key);   // reuse this run's prediction (for a margin retry)
                if (cached === undefined) {
                    try {
                        shot = await ml.screenshot(null, {});
                        // Crop to the scoped region (the whole viewport when unscoped), then
                        // LETTERBOX to a square — aspect-preserving, so an arbitrary-shaped crop
                        // isn't distorted the way a stretch mangles it.
                        const cropped = await cropDataUrl(shot, region, dpr);
                        const square = await letterboxToSquare(cropped, DEFAULT_GROUNDING_RANGE);
                        const gp = `Locate "${description}"${scopeNote} in this image. Reply with ONLY its bounding box as four numbers ` +
                            `x1,y1,x2,y2 — top-left then bottom-right corner, each from 0 to ${groundingRange} ` +
                            `(x: 0=left→${groundingRange}=right; y: 0=top→${groundingRange}=bottom). If it isn't visible, reply "NONE".`;
                        const ans = String(await ml.chat(gp, { images: [square], model: groundingModel, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                        const parsed = (ans.match(/\d+(?:\.\d+)?/g) || []).map(Number);
                        cached = { nums: parsed.length >= 4 ? parsed.slice(0, 4) : null, square, prompt: gp, answer: ans };
                        groundCache.set(key, cached);
                    } catch { cached = null; }   // transient failure → leave uncached, fall through
                }
                // 'grid-grounding' entered here via the grid cell-pick — label the render so
                // the sidebar shows it as the two-stage mechanism, and prepend the grid's
                // cellStep (carried in priorSubsteps) as the first substep. For plain grounding
                // priorSubsteps is empty, so this is a no-op there.
                const groundMode = (strategy === "grid-grounding" || autoUpgraded) ? "grid-grounding" as const : "grounding" as const;
                // For a grid→grounding CHAIN the two stages run on DIFFERENT models — the grid cell-pick
                // on the reader (the agent's own vision model, `model || groundingModel`) and the snap on
                // the grounding model — so show both, matching the substeps (e.g. "gemma4:31b → qwen2.5vl:7b").
                const gridReader = String(model || groundingModel);
                const headModel = (groundMode === "grid-grounding" && gridReader !== String(groundingModel))
                    ? `${gridReader} → ${groundingModel}` : String(groundingModel);
                const groundResult = (substeps: LocateSubstep[], extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                    ({ type: "locate" as const, mode: groundMode, model: headModel, substeps: [...priorSubsteps, ...substeps], ...extra });
                // When an AUTO-UPGRADED grounding whiffs, don't degrade to marks-on-canvas —
                // return the plain-grid cell CENTRE we stashed (the upgrade must never regress).
                const returnAutoUpFallback = async (extra: LocateSubstep[] = []) => {
                    const f = autoUpFallback!;
                    if (!shot) shot = await ml.screenshot(null, {});
                    const { token, dupWarn } = mintPointWarned(f.x, f.y);
                    const ptImg = await annotate(shot, [{ rect: rectOf(f.cellBox), color: YELLOW, label: f.cellNote }, { rect: { left: f.x - 11, top: f.y - 11, width: 22, height: 22 }, color: RED, label: "point" }], dpr);
                    return {
                        content: `Grid ${f.cellNote}${scopeNote}: grounding couldn't refine inside the cell, so this is the cell-CENTRE COORDINATE (may graze an off-centre target): ${token} at (${Math.round(f.x)}, ${Math.round(f.y)}). First verify, then click: look({ selector: "${token}" }) → click({ selector: "${token}" }).${dupWarn}${f.offAdvice}${canvasScopeTip}`,
                        render: groundResult([...extra, { label: "Canvas point · cell centre (grounding fallback)", image: ptImg }], { picked: `${token} @ (${Math.round(f.x)}, ${Math.round(f.y)})`, pickedBy: "snap" }),
                    };
                };
                if (cached) {
                    const { nums, square, prompt, answer } = cached;
                    const R = groundingRange || DEFAULT_GROUNDING_RANGE;
                    // Two (x,y) pairs — "(x1, y1) → (x2, y2)" text + per-corner overlay labels.
                    const fb = nums ? formatBox(nums) : null;
                    // The square the model saw, annotated with ITS box (visualise view; the
                    // model saw the plain `square` = rawImage).
                    const groundingImage = nums && fb
                        ? await annotate(square, [{ rect: rectOf(viewportBox(nums, R, DEFAULT_GROUNDING_RANGE, DEFAULT_GROUNDING_RANGE)), color: RED, corners: fb.corners }], 1)
                        : square;
                    const boxStep: LocateSubstep = { label: `Grounding${nums && fb ? ` · box ${fb.text}` : " · no box returned"}`, prompt, output: answer, rawImage: nums ? square : undefined, image: groundingImage };
                    // Invert the letterbox back to the scoped region (uniform scale + offset).
                    const box = nums ? projectFromSquare(nums, R, region) : null;
                    if (box) {
                        const b: Box = margin > 0 ? { left: box.left - margin, top: box.top - margin, right: box.right + margin, bottom: box.bottom + margin } : box;
                        // Container mode: return the grounded region as a scopable @box token
                        // (a coordinate CONTAINER to operate within), not a click point. The
                        // driver copies the token and recurses INTO it — box → sub-box → @pt.
                        if (container) {
                            if (!shot) shot = await ml.screenshot(null, {});
                            const token = mintBox(b);
                            const boxImg = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: "container" }], dpr);
                            return feedBack({
                                content: `Outlined a container for "${description}"${scopeNote}: ${token} — a ${Math.round(b.right - b.left)}×${Math.round(b.bottom - b.top)}px region. Operate WITHIN it: verify with look({ selector: "${token}" }), then locate({ selector: "${token}", description: "…" }) to find a control inside (or container:true again to narrow further), then click the final @pt. Copy the token verbatim — it's a coordinate region, not a selector.`,
                                render: groundResult([boxStep, { label: "Container region (@box)", image: boxImg }], { picked: token, pickedBy: "snap" }),
                            }, { kind: "box", target: token, label: "grounded container region" });
                        }
                        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
                        // OPAQUE surface (canvas / cross-origin iframe / sealed closed shadow) → no DOM node to
                        // snap to, so return a point token at the surface-hit nearest the box centre (robust to a
                        // box straddling page chrome above it). Grounding gives a PRECISE box — its strength — so
                        // a sealed-shadow / iframe target still yields a clickable @pt instead of failing to SoM.
                        const cpt = opaquePointIn(b);
                        if (cpt) {
                            if (!shot) shot = await ml.screenshot(null, {});
                            const { token, dupWarn } = mintPointWarned(cpt.x, cpt.y);
                            const dot = { left: cpt.x - 11, top: cpt.y - 11, width: 22, height: 22 };
                            const ptImg = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: "grounded region" }, { rect: dot, color: RED, label: "click point" }], dpr);
                            const upNote = autoUpgraded ? ` ('grid' was auto-upgraded to 'grid-grounding' in this call — grounding pinpointed inside the cell)` : "";
                            const noun = surfaceNoun(cpt.kind);
                            // Off-target: snap around THIS point (re-ground its neighborhood); a
                            // `margin` grows that search box if the target is cut off at its edge.
                            const snapHint = ` If it lands OFF the target but you can see it nearby, snap onto it: locate({ selector: "${token}", strategy: "grounding", description: "${truncate(description, 50)}" }) — re-searches just around this point (add margin: 40–120 if it's partly cut off at the edge).`;
                            return feedBack({
                                content: `Grounded "${description}"${scopeNote} on ${noun} — no DOM element, so this is a COORDINATE: ${token} at (${Math.round(cpt.x)}, ${Math.round(cpt.y)}).${upNote} First verify, then click: look({ selector: "${token}" }) → click({ selector: "${token}" }).${reservedClickNote(cpt.kind)}${dupWarn}${snapHint}${canvasScopeTip}`,
                                render: groundResult([boxStep, { label: `${cpt.kind === "canvas" ? "Canvas" : cpt.kind === "iframe" ? "Iframe" : "Sealed-shadow"} point (no DOM element)`, image: ptImg }], { picked: `${token} @ (${Math.round(cpt.x)}, ${Math.round(cpt.y)})`, pickedBy: "snap" }),
                            }, { kind: "pt", target: token, label: `located point on ${noun}`, x: cpt.x, y: cpt.y });
                        }
                        const primary = elementAtPoint(cx, cy, filter);
                        const nearby = collectInBox(b, filter);
                        const chosen = primary || nearby[0];
                        const ordered = chosen ? [chosen, ...nearby.filter(e => e !== chosen)].slice(0, 12) : nearby.slice(0, 12);
                        const marks = buildMarks(ordered);
                        if (!shot) shot = await ml.screenshot(null, {});   // a cache-hit skipped the capture
                        // Element-location pass: the search area in YELLOW, candidates in RED.
                        const snapImg = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: margin ? `search +${margin}px` : "search area" }, ...marks.map(m => ({ rect: m.rect, color: RED, badge: m.id }))], dpr);
                        const snapStep: LocateSubstep = { label: `DOM snap${margin ? ` · +${margin}px search margin` : " · nearest element in the box"}`, image: snapImg };
                        if (chosen) {
                            const picked = pickedStr(marks[0]);
                            return feedBack({
                                content: `Grounded "${description}"${scopeNote}${margin ? ` (margin ${margin}px)` : ""} → ${picked}\n${actHint}\n\nOther elements in that region:\n${listOf(marks)}`,
                                elements: ordered.slice(0, 50),
                                render: groundResult([boxStep, snapStep], { picked, pickedBy: "snap" }),
                            }, { kind: "selector", target: marks[0].selector, label: "grounded element" });
                        }
                        // A box was returned but nothing interactive sits under it — here a
                        // larger `margin` genuinely helps (it expands a real box).
                        if (autoUpFallback) return returnAutoUpFallback([boxStep, { ...snapStep, label: "DOM snap · no element in the box" }]);
                        if (strategy === "grounding") {
                            return { content: `Grounding located a region for "${description}" but no ${filter} element is under it. Retry with a larger \`margin\` (e.g. 40–120) — cheap, it reuses this box with no 2nd vision call — or use strategy 'marks'.`, render: groundResult([boxStep, { ...snapStep, label: "DOM snap · no element in the box" }]) };
                        }
                        priorSubsteps.push(boxStep, { ...snapStep, label: "DOM snap · no element in the box" });
                        fallbackNote = `Grounding found a region but no ${filter} element under it — fell back to Set-of-Marks.`;
                    } else {
                        // No box at all — a `margin` can't expand what doesn't exist, so say so
                        // explicitly rather than let the model waste a step retrying with one.
                        if (autoUpFallback) return returnAutoUpFallback([boxStep]);
                        if (strategy === "grounding") {
                            const m = margin ? " A `margin` can't help without a box — " : " ";
                            return { content: `The grounding model returned no box for "${description}".${m}It may not be visible: scroll it into view, re-describe it, or use strategy 'marks'.`, render: groundResult([boxStep]) };
                        }
                        priorSubsteps.push(boxStep);
                        fallbackNote = "Grounding returned no box — fell back to Set-of-Marks.";
                    }
                } else {
                    if (autoUpFallback) return returnAutoUpFallback();
                    if (strategy === "grounding") {
                        return `Grounding failed for "${description}" (the vision call errored). Try again, or use strategy 'marks'.`;
                    }
                    fallbackNote = "The grounding vision call errored — fell back to Set-of-Marks.";
                }
                // strategy 'auto' → fall through to Set-of-Marks (carrying priorSubsteps).
            }

            // Mechanism #2 — Set-of-Marks (default, and the 'auto' grounding fallback).
            const somReader = model || groundingModel;   // a grounding model can read badges too
            // A MISS still deserves a debug render: when grounding was attempted (auto fallback), its
            // substeps (the model, the prompt, the screenshot it saw, the box/answer it returned) are in
            // priorSubsteps — surface them + a closing "what SoM found" line, so the DevTools/export Out is a
            // legible record of what was tried, not just a bare failed-state string. No prior attempt (pure
            // SoM that found nothing to even badge) → nothing visual to show, so leave it as the raw string.
            const missRender = (finalLabel: string): RenderDescriptor | undefined =>
                priorSubsteps.length
                    ? { type: "locate", mode: "marks", model: String(somReader || "default"), substeps: [...priorSubsteps, { label: finalLabel }] }
                    : undefined;
            // Scan wider than we'll badge, so we can report the TRUE candidate count and cap
            // the badges at a legible number (badging 100 elements overlaps into mush).
            const SOM_BADGE_CAP = 40, SOM_DENSE = 30;
            const allCands = scoped ? collectInBox(regionAsBox, filter, { max: 150 }) : collectCandidates(filter, { max: 150 });
            const cands = allCands.slice(0, SOM_BADGE_CAP);
            const prefix = fallbackNote ? "(Grounding missed — used Set-of-Marks.) " : "";
            // A <canvas>/WebGL surface (WebGL is just a <canvas> to the DOM) has no
            // sub-elements to badge — Set-of-Marks can't pick inside it. Steer to the
            // coordinate mechanisms. Shared by the no-candidates path (a canvas yields
            // ZERO clickables, so it hits `!cands.length` first) and the all-canvas path.
            // On a canvas SoM never ran (there was nothing to badge), so DON'T use the
            // "used Set-of-Marks" prefix here — it reads as nonsense on a canvas ("why is
            // it using SoM on the canvas"). Say plainly that grounding missed and SoM
            // doesn't apply.
            const canvasLead = fallbackNote ? "Grounding missed, and Set-of-Marks doesn't apply here: " : "";
            const canvasAlts = groundingModel
                ? "Use strategy 'grid-grounding' (grid narrows the region, then a grounding model pinpoints an exact spot inside it — best for a small target), or 'grounding', or 'grid' and zoom in"
                : "Use strategy 'grid' and zoom in";
            const onOpaque = opaquePointIn(regionAsBox);   // is the search area itself an opaque surface?
            if (!cands.length) {
                if (onOpaque) return { content: `${canvasLead}${scopeSel ? `"${scopeSel}"` : "that area"} is ${surfaceNoun(onOpaque.kind)} — nothing to badge (no sub-elements). ${canvasAlts} — each returns an @pt coordinate token to click.${reservedClickNote(onOpaque.kind)}`, render: missRender(`Set-of-Marks · ${onOpaque.kind} region, nothing to badge`) };
                return { content: `${prefix}No ${filter} candidates visible${scopeNote || " in the viewport"}. Scroll the target into view, widen the filter (try 'all'), then call again.`, render: missRender(`Set-of-Marks · no ${filter} candidates to badge`) };
            }
            if (cands.every(c => opaqueSurfaceAt((c.getBoundingClientRect().left + c.getBoundingClientRect().right) / 2, (c.getBoundingClientRect().top + c.getBoundingClientRect().bottom) / 2))) {
                const k = opaquePointIn(regionAsBox)?.kind ?? "canvas";
                return { content: `${canvasLead}"${description}" is on ${surfaceNoun(k)} — nothing to badge (it has no sub-elements). ${canvasAlts} — it returns an @pt coordinate token to click.${reservedClickNote(k)}`, render: missRender(`Set-of-Marks · target is ${k}, nothing to badge`) };
            }
            // Dense pages break Set-of-Marks (badges overlap, the model misreads) AND we
            // only badge the first SOM_BADGE_CAP — say both, and steer to a better tool.
            const densityWarn = allCands.length > SOM_DENSE
                ? `\n\n⚠ ${allCands.length}${allCands.length >= 150 ? "+" : ""} ${filter} candidates${allCands.length > SOM_BADGE_CAP ? ` (only the first ${SOM_BADGE_CAP} are badged/pickable here)` : ""} — Set-of-Marks is unreliable at this density: badges overlap and the wrong one is easily picked. Prefer strategy 'grid' (it narrows the region first), or scope with a \`selector\`. Before acting on any pick from here, verify it with look({ selector: "…" }).`
                : "";
            const marks = buildMarks(cands);
            let badged: string;
            try {
                // Badge full-frame, or on a crop of the scoped region (badgeMarks picks a
                // page-contrasting colour that avoids the target's own colour).
                badged = await badgeMarks(marks, scopeSel ? region : undefined);
            } catch (e) { return `Error capturing/marking the screenshot: ${errText(e)}`; }
            const { chosen, answer, prompt: somPrompt } = await askMarks(marks, badged, somReader, scopeNote);
            const marksStep: LocateSubstep = {
                label: somLabel(marks.length, chosen),
                note: fallbackNote, prompt: somPrompt, output: answer, rawImage: badged,
                image: chosen ? await highlightPick(badged, chosen, scopeSel ? region : undefined) : badged,
            };
            const marksResult = (extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                ({ type: "locate" as const, mode: "marks" as const, model: String(somReader || "default"), substeps: [...priorSubsteps, marksStep], ...extra });
            if (!chosen) {
                return { content: `${prefix}No badge matched "${description}" (model replied "${truncate(answer, 40)}"). Candidates:\n${listOf(marks)}${densityWarn}`, elements: cands.slice(0, 50), render: marksResult() };
            }
            return {
                content: `${prefix}Matched "${description}" → #${chosen.id} ${pickedStr(chosen)}\n${actHint}\n\nAll candidates:\n${listOf(marks)}${densityWarn}`,
                elements: [chosen.el],
                render: marksResult({ picked: `#${chosen.id} ${pickedStr(chosen)}`, pickedBy: "model" }),
            };
        },
    });
};

// STUCK-LOOP guard for @pt clicks. A model that re-clicks the SAME point token is almost always OFF-TARGET:
// the click LANDS (dispatch/CDP succeeds) but misses the control, because locate's coordinate is
// grounding-accuracy-bound and can sit on an edge. So on a repeat, nudge toward the SELF-CORRECTING RE-SNAP —
// locate({ selector: <token>, strategy: "grounding", margin, description }) re-searches AROUND this point for a
// better-centred @pt — instead of re-clicking the dead coordinate. Non-blocking (a legit repeat still clicks);
// keyed by token, so a fresh locate (new token) resets the count.
const ptClickCounts = new Map<string, number>();
const repeatPointHint = (token: string): string => {
    const n = (ptClickCounts.get(token) || 0) + 1;
    ptClickCounts.set(token, n);
    if (ptClickCounts.size > 300) { const k = ptClickCounts.keys().next().value; if (k) ptClickCounts.delete(k); }
    if (n < 2) return "";
    const resnap = `locate({ selector: "${token}", strategy: "grounding", margin: ${n === 2 ? 40 : 80}, description: "<the target>" })`;
    return n === 2
        ? ` ⚠ You've clicked this point before — if nothing changed it's almost certainly OFF-TARGET (the click lands but misses the control). Don't re-click it; RE-SNAP for a better-centred point: ${resnap}, then click the NEW @pt it returns.`
        : ` ⚠ "${token}" clicked ${n}× with no effect — it's off-target; STOP re-clicking it. RE-SNAP: ${resnap} (or a fresh locate({ description: "…" })), then click the new @pt.`;
};

// Radius of the post-action `verify` crop — a GENERAL AREA around where the action happened (bigger than a
// tight element crop) so the result (a menu that opened, a value that filled, a nav) is visible.
const VERIFY_MARGIN = 150;
// Optional `verify` on click/type: after the action, feed back a general-area crop centred on where it
// happened — so a "do-the-task-then-look" chain is ONE turn instead of two. Same native/delegated split as
// locate's snap-inject (vision driver → inline image; text-only → delegated description + the click-mark
// note). `mutated` = the target vanished after the action (the page changed) → the crop is centred on the
// element's PRE-action spot and annotated as such. Never automatic — only when the caller sets verify:true.
// A passed-in verify capability (built with `ml` where it's available) so the PURE domTools (wait, in
// tools.ts, which have no `ml`) can verify too — without depending on ml directly.
export type VerifyArea = (ctx: ToolContext | undefined, center: { x: number; y: number } | null, verb: string, mutated?: boolean) => Promise<Partial<ToolResult>>;
export async function captureVerify(ml: MlApi, ctx: ToolContext | undefined, center: { x: number; y: number } | null, verb: string, mutated = false): Promise<Partial<ToolResult>> {
    const driverSees = !!ctx?.driverSees;
    const reader = ctx?.visionModel || null;
    if (!driverSees && !reader) return { content: "\n\n(verify was requested, but no vision model is available to capture the result — read it with look/findByText next.)" };
    // An element/point action → a CLEAN crop of the general AREA around it, the target dead-CENTRE (NO
    // click-mark overlay by default: the model almost always looked at the target before acting, so it
    // doesn't need re-marking — and a marker box can occlude the very result it's meant to confirm, which
    // makes the VLM confabulate the hidden characters). A `wait` (center null) → the whole viewport. The
    // point token is still minted so the model can look() it to see EXACTLY where the click landed if needed.
    const tok = center ? mintPoint(center.x, center.y) : null;
    let crop: string;
    try { crop = tok ? await ml.screenshot(tok, { margin: VERIFY_MARGIN, noOverlay: true }) : await ml.screenshot(null, {}); }
    catch { return {}; }   // capture failed → no verify, base result stands
    // The target is at the crop's centre — say so instead of drawing a box on it. Need the precise landing
    // spot (the click box)? a follow-up look() on the token draws it, without occluding this verify crop.
    const clickPoint = tok ? ` The target you ${verb} is at the CENTRE of this crop; to see the exact click point, look({ selector: "${tok}" }).` : "";
    const areaNote = mutated
        ? `The element you ${verb} is GONE — the page changed. This crop is centred where it was.`
        : center ? `Here's the area where you ${verb}.`
            : `The page settled — here's the current viewport.`;
    const reason = mutated ? "after the action — target changed" : center ? "after the action" : "after wait";
    // DOM legend of the verify area — names what just APPEARED (a menu that opened, a filled value) with
    // selectors, so the model acts on the DOM instead of re-reading the pixels. Same box the crop shows.
    const legend = legendForBox(center ? { left: center.x - VERIFY_MARGIN, top: center.y - VERIFY_MARGIN, right: center.x + VERIFY_MARGIN, bottom: center.y + VERIFY_MARGIN } : boxForTarget(null, 0));
    if (driverSees) return { content: `\n\n ${areaNote}${clickPoint} Read the result and continue — no need to look() first.${legend}`, image: crop, imageLabel: reason, feedback: { reason, via: "image", image: crop } };
    // Text-only driver: the reader describes the crop (no marker to explain — it's a plain crop).
    const question = center
        ? `The image is a crop of the page just AFTER a "${verb}" action; the target is at the exact CENTRE. Describe what is now shown there and around it — especially anything that CHANGED (a menu/panel/result that appeared, a new field value, a navigation).`
        : `The image is a screenshot of the page after it settled following a wait. Describe the current state — especially anything that just finished loading or changed.`;
    let desc: string;
    try { desc = String(await ml.chat(question, { images: [crop], model: reader, maxTokens: 256, numCtx: VISION_NUM_CTX })).trim(); }
    catch { return {}; }
    return { content: `\n\n👁 ${areaNote} You can't see images, so this is ${reader || "the reader"}'s description:\n${desc}${clickPoint}${legend}`, feedback: { reason, via: "text", text: desc, prompt: question, image: crop } };
}
/** Verify by cropping the WHOLE target element (not a fixed-radius point crop) — what `type` wants: a picture
 *  of the field/canvas it typed into. `target` is a selector or an Element; `ml.screenshot` crops it to its
 *  bounding box. Same native (inline image) / delegated (reader describes) split + feedback shape as
 *  captureVerify. Only `type` into an `@pt` keeps the point crop (captureVerify) — there's no element there. */
export async function captureVerifyElement(ml: MlApi, ctx: ToolContext | undefined, target: string | Element, verb: string, label?: string): Promise<Partial<ToolResult>> {
    const driverSees = !!ctx?.driverSees;
    const reader = ctx?.visionModel || null;
    if (!driverSees && !reader) return { content: "\n\n(verify was requested, but no vision model is available to capture the result — read it with look/findByText next.)" };
    let crop: string;
    try { crop = await ml.screenshot(target as string, { noOverlay: true }); }
    catch { return {}; }   // the element vanished / can't be shot → no verify, base result stands
    const what = label || (typeof target === "string" ? `"${target}"` : "the element");
    const reason = "after the action";
    if (driverSees) return { content: `\n\n Here's ${what} after you ${verb} it. Read the result and continue — no need to look() first.`, image: crop, imageLabel: reason, feedback: { reason, via: "image", image: crop } };
    const question = `The image is a screenshot of ${what} just AFTER a "${verb}" action. Describe what it now shows — especially anything that CHANGED (a new value, text that appeared on it).`;
    let desc: string;
    try { desc = String(await ml.chat(question, { images: [crop], model: reader, maxTokens: 256, numCtx: VISION_NUM_CTX })).trim(); }
    catch { return {}; }
    return { content: `\n\n👁 Here's ${what} after you ${verb} it. You can't see images, so this is ${reader || "the reader"}'s description:\n${desc}`, feedback: { reason, via: "text", text: desc, prompt: question, image: crop } };
}
// The viewport CENTRE of an element (composing iframe offsets), for a verify crop. null if it has no box.
const elementCenter = (el: Element): { x: number; y: number } | null => {
    const r = viewportRect(el);
    return (r.width || r.height) ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : null;
};

export const buildClickTool = (ml: MlApi): MlTool => {
    // Side-effect-free resolution → an ERROR STRING if the click is doomed (an @box region, a stale
    // @pt, an invalid selector, or no match), else null. The loop uses it to SKIP the approval prompt
    // for an action that would only fail; run() calls it first so the two can't drift.
    const clickPrecheck = ({ selector, index = 0 }: { selector: string; index?: number }): string | null => {
        const s = (selector || "").trim();
        if (BOX_RE.test(s)) return `"${selector}" is an @box container region, not a clickable point. Locate a control INSIDE it first: locate({ selector: "${selector}", description: "…" }) → click the @pt it returns.`;
        if (POINT_RE.test(s)) return resolvePoint(selector) ? null : `Unknown point token "${selector}" — it may be stale (from an earlier page/run). Re-run locate to get a fresh one.`;
        let el: Element | undefined;
        try { el = queryAll(selector)[index]; } catch (e) { return selectorError(selector, e as Error); }
        // A `>>>` path into a SEALED (closed/declarative) shadow root finds nothing HERE, but the background can
        // still reach it via CDP — so it's NOT doomed. run() emits a cdpShadowClick signal; keep the gate open.
        if (!el && firstHopSealed(selector)) return null;
        return el ? null : `No element matches "${selector}"${index ? ` at index ${index}` : ""}.`;
    };
    return ml.defineTool({
        name: "click",
        summary: "Clicks a link, button, or element on the page.",
        requiresApproval: true,
        precheck: clickPrecheck,
        description: "Click an element (link, button, tab, search result). REAL SIDE EFFECTS — " +
            "may navigate, submit a form, or expand/collapse. Pass a CSS selector (supports " +
            ":contains()/:has-text()/:eq()); `index` picks the Nth match (0-based). It also accepts " +
            "an `@pt:…` point token returned by locate for a CANVAS/WebGL target (no DOM node) — " +
            "pass it VERBATIM to click that coordinate. Orient with scroll/look/findByText FIRST so " +
            "you click the right thing. Returns the resulting URL/title so you can confirm what happened.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the element to click, or an `@pt:…` point token from locate (canvas targets)." },
                index: { type: "integer", description: "Which match to click (0-based); default 0." },
                verify: { type: "boolean", description: "This is an 'inline look()' option that saves you a turn. Set true if you'd call look() right after — it returns a screenshot of the AREA around where you clicked in THIS call (a menu that opened, a nav, whatever changed), so you skip the separate look and see the result immediately. If the clicked element vanished (the page changed), you get the area where it was, flagged." }
            },
            required: ["selector"]
        },
        // In: a tool-provided INTENT (verb + human target + highlight selector) — the approval card reads
        // it deterministically, and the debug In slot renders it as a hoverable ref (outlines the element).
        render: (_input, args) => actionRender("Click", args),
        run: async ({ selector, index = 0, verify = false }: { selector: string; index?: number; verify?: boolean }, ctx?: ToolContext): Promise<string | ToolResult> => {
            const doomed = clickPrecheck({ selector, index });   // @box / stale @pt / bad selector / no match
            if (doomed) return doomed;
            // A point token from locate → click that coordinate.
            if (POINT_RE.test((selector || "").trim())) {
                const token = (selector || "").trim();
                const pt = resolvePoint(selector)!;   // precheck confirmed it resolves
                // A RESERVED surface (cross-origin iframe / sealed closed shadow) can't be reached by a
                // synthetic dispatch — hand the executor a CDP-click signal at this coordinate instead. The
                // executor (page loop / background) gates it on the `cdpClick` flag + permission + approval.
                const reserved = reservedSurfaceAt(pt.x, pt.y);
                // A RESERVED surface ALWAYS needs CDP (a synthetic dispatch can't reach it). A plain canvas @pt
                // goes CDP too WHEN the run enabled it (cdpEnabled) — a TRUSTED click registers in a WebGL /
                // remote-desktop / game canvas where synthetic clicks are dropped; without CDP it falls to the
                // synthetic clickAt below (fine for most 2D-DOM canvases).
                if (reserved || cdpEnabled) {
                    const what = reserved
                        ? `inside ${reserved.kind === "iframe" ? `a${reserved.origin ? ` ${reserved.origin}` : "n embedded cross-origin"} iframe` : "a sealed closed shadow root"} — a normal click can't reach it, so this needs a debugger (CDP) click`
                        : `on a canvas/opaque surface — clicking it with a TRUSTED debugger (CDP) event so it registers in a WebGL / remote-desktop / game canvas`;
                    const hint = repeatPointHint(token);   // the CDP result is built background-side → thread the nudge
                    // verify rides the cdpClick signal: the click is deferred to the background (CDP), so it does
                    // the verify capture AFTER the click (round-trips back to the page's captureVerify at this point).
                    return { content: `The target at (${pt.x}, ${pt.y}) is ${what}.`, cdpClick: { x: pt.x, y: pt.y, hint: hint || undefined, verify: verify || undefined } };
                }
                // A canvas point token → synthesize a click at that coordinate.
                const before = (typeof location !== "undefined" && location.href) || "";
                const hit = clickAt(pt.x, pt.y);
                if (!hit) return `Nothing is at point (${pt.x}, ${pt.y}) — it may have scrolled off-screen. Re-run locate.`;
                await settle(80);
                const after = (typeof location !== "undefined" && location.href) || "";
                const nav = after && after !== before ? ` Navigated to ${after}.` : "";
                const base = `Clicked at (${pt.x}, ${pt.y}) on ${elLine(hit)}.${nav} Page title: ${truncate(document.title || "", 80)}.${repeatPointHint(token)}`;
                if (verify) { const v = await captureVerify(ml, ctx, { x: pt.x, y: pt.y }, "clicked"); return { content: base + (v.content || ""), image: v.image, imageLabel: v.imageLabel, feedback: v.feedback }; }
                return `${base} Re-run look to see the result.`;
            }
            const el0 = queryAll(selector)[index];
            if (!el0) {
                // No page-reachable element, but precheck let this through because a genuinely SEALED
                // (closed/declarative) shadow host is in the `>>>` path. The page can't enter it, so hand the
                // background a cdpShadowClick signal — it CDP-resolves the selector (piercing the closed root) and
                // clicks the resolved coordinate. Gated background-side on the `cdp` flag + the same approval.
                if (firstHopSealed(selector)) return { content: `"${selector}" targets content inside a sealed (closed/declarative) shadow root a page selector can't enter — resolving and clicking it via the debugger.`, cdpShadowClick: { selector, index, verify: verify || undefined } };
                return `No element matches "${selector}"${index ? ` at index ${index}` : ""}.`;
            }
            const el = el0;
            // A <canvas> (WebGL / remote-desktop / game screen) has no DOM child to target, and a trusted-only
            // canvas IGNORES a synthetic `el.click()` (it isn't even a real `mousedown`, so it never focuses the
            // canvas either — the reason a following @focus type lands nowhere). With trusted input enabled,
            // click its CENTRE via CDP: a real event the canvas honours AND that focuses it. cdp off → the
            // synthetic path below (fine for a 2D canvas that accepts synthetic clicks).
            if (el.tagName === "CANVAS" && cdpEnabled) {
                const c = elementCenter(el);
                if (c) return { content: `Clicking the <canvas> ${elLine(el)} at its centre (${Math.round(c.x)}, ${Math.round(c.y)}) with a TRUSTED (CDP) event — a canvas ignores a synthetic click.`, cdpClick: { x: Math.round(c.x), y: Math.round(c.y), verify: verify || undefined } };
            }
            const preCenter = elementCenter(el);   // captured BEFORE the click, in case it removes/replaces the element
            const before = (typeof location !== "undefined" && location.href) || "";
            try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
            (el as HTMLElement).click();
            await settle(80);   // let navigation / DOM updates begin
            const after = (typeof location !== "undefined" && location.href) || "";
            const nav = after && after !== before ? ` Navigated to ${after}.` : "";
            const base = `Clicked ${elLine(el)}.${nav} Page title: ${truncate(document.title || "", 80)}.`;
            if (verify) {
                // Re-resolve: center on the element's CURRENT spot if it survived, else its pre-action spot (mutated).
                let center = preCenter, mutated = false;
                try { const now = queryAll(selector)[index]; const c = (now && isElement(now)) ? elementCenter(now) : null; if (c) center = c; else mutated = true; } catch { mutated = true; }
                if (center) { const v = await captureVerify(ml, ctx, center, "clicked", mutated); return { content: base + (v.content || ""), image: v.image, imageLabel: v.imageLabel, feedback: v.feedback }; }
            }
            return `${base} Re-run look/findByText to see the result.`;
        }
    });
};

export const buildTypeTool = (ml: MlApi): MlTool => {
    // Side-effect-free: an error if the field can't resolve (bad selector / no match), else null. Lets
    // the loop skip the approval prompt for a doomed type; run() calls it first so they can't drift.
    const typePrecheck = ({ selector, index = 0 }: { selector: string; index?: number }): string | null => {
        const s = (selector || "").trim();
        // @focus: type into whatever the page has focused — but FAIL FAST (doomed → no approval prompt) when
        // there's nothing focused, or the focused thing isn't typeable (a button/link/body), so a pointless
        // trusted-keyboard round-trip is skipped.
        if (s === "@focus" || s === "") {
            const ae = typeof document !== "undefined" ? document.activeElement : null;
            if (!ae || (typeof document !== "undefined" && (ae === document.body || ae === document.documentElement)))
                return "Nothing is focused — there's no @focus target to type into. Click the field/canvas first (so it gains focus), or type into a specific selector / @pt.";
            if (!isTypeableEl(ae))
                return `The focused element (${elLine(ae)}) isn't a text field or canvas, so typing into it won't register. Focus a field/canvas first, or type into a specific selector / @pt.`;
            return null;
        }
        if (BOX_RE.test(s)) return `"${selector}" is an @box region, not a field. Locate a control inside it, or type into an @pt / @focus.`;
        if (POINT_RE.test(s)) return resolvePoint(selector) ? null : `Unknown point token "${selector}" — it may be stale. Re-run locate.`;
        let el: Element | undefined;
        try { el = queryAll(selector)[index]; } catch (e) { return selectorError(selector, e as Error); }
        if (!el && firstHopSealed(selector)) return null;                     // sealed `>>>` field → the debugger types it
        return el ? null : `No element matches "${selector}"${index ? ` at index ${index}` : ""}.`;
    };
    return ml.defineTool({
        name: "type",
        summary: "Types text into a field or search box.",
        requiresApproval: true,
        precheck: typePrecheck,
        description: "Type text into a field (text input, textarea, or contenteditable) — e.g. a " +
            "search box. Pass `selector` and the `text`; `index` picks the Nth match. By default " +
            "it REPLACES the field's value; set append:true to add to it. Set submit:true to press " +
            "Enter after (submit a search/form). Fires input/change events so the page reacts. " +
            "Returns the field's resulting value.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the field. Also accepts an `@pt:…` point token from locate (types into a canvas/WebGL target after clicking it to focus), or the literal `@focus` to type into whatever the page currently has focused (a remote-desktop / canvas stream) — both need trusted keyboard (CDP)." },
                text: { type: "string", description: "Text to type in." },
                index: { type: "integer", description: "Which match (0-based); default 0." },
                append: { type: "boolean", description: "Append instead of replacing the value." },
                submit: { type: "boolean", description: "Press Enter afterwards (submit)." },
                verify: { type: "boolean", description: "This is an 'inline look()' option that saves you a turn. Set true if you'd call look() right after — it returns a screenshot of the AREA around the field in THIS call (autocomplete/suggestions that appeared, a validation message, or — with submit — the result), so you skip the separate look. If the field vanished after submit (navigation), you get the area where it was, flagged." }
            },
            required: ["selector", "text"]
        },
        // In: a tool-provided INTENT — "Type «…» into «Search»" + highlight the field, like click.
        // No `note: "then submit"` here — the approval sentence renders submit itself, as a styled
        // "and submit it" clause (read from args.submit); a note would duplicate it ("…submit it · then submit").
        render: (_input, args) => actionRender("Type", args, {
            input: typeof args.text === "string" ? args.text : undefined,
        }),
        run: async ({ selector, text = "", index = 0, append = false, submit = false, verify = false }: { selector: string; text?: string; index?: number; append?: boolean; submit?: boolean; verify?: boolean }, ctx?: ToolContext): Promise<string | ToolResult> => {
            const doomed = typePrecheck({ selector, index });
            if (doomed) return doomed;
            const s = (selector || "").trim();
            // TRUSTED KEYBOARD (canvas / WebGL / remote desktop / sealed field): hand the background a cdpType
            // signal — it types real (isTrusted) key events synthetic KeyboardEvents can't. `@focus`/empty →
            // the page's current focus; an `@pt` → click that point to focus, then type; a sealed `>>>` → resolve
            // + focus + type. Background-gated on the `cdp` flag (it returns an actionable note when off).
            // verify TARGET (the picture verify shows): the WHOLE element for a selector/@focus (verifyElement /
            // verifyFocus), the POINT crop only for an @pt (there's no element there). Rides the cdpType signal;
            // the background rings the page back to capture it after the trusted action.
            if (s === "@focus" || s === "") return { content: `Typing "${truncate(text, 60)}" into the page's current focus via trusted keyboard (CDP).`, cdpType: { text, submit: submit || undefined, verify: verify || undefined, verifyFocus: verify || undefined } };
            if (POINT_RE.test(s)) { const pt = resolvePoint(s)!; return { content: `Typing "${truncate(text, 60)}" into the target at (${pt.x}, ${pt.y}) via trusted keyboard (CDP).`, cdpType: { x: pt.x, y: pt.y, text, submit: submit || undefined, verify: verify || undefined } }; }
            const sealed0 = queryAll(selector)[index];
            if (!sealed0 && firstHopSealed(selector)) return { content: `Typing "${truncate(text, 60)}" into "${selector}" inside a sealed shadow root via the debugger.`, cdpType: { selector, index, text, submit: submit || undefined, verify: verify || undefined } };
            const el = queryAll(selector)[index]!;   // precheck confirmed it matches
            // A <canvas> has no value / contenteditable — the normal path below would set a meaningless
            // `textContent` and falsely report "Value now: …". Route it to trusted keyboard instead: CDP-click its
            // CENTRE to focus it (a canvas keydown handler only fires on the focused canvas), then type real key
            // events. verify shows the WHOLE canvas (verifyElement). Background gates on the cdp flag.
            if (el.tagName === "CANVAS") {
                const c = elementCenter(el);
                if (c) return { content: `Typing "${truncate(text, 60)}" into the <canvas> ${elLine(el)} via trusted keyboard (CDP) — clicking its centre to focus first.`, cdpType: { x: Math.round(c.x), y: Math.round(c.y), text, submit: submit || undefined, verify: verify || undefined, verifyElement: verify ? selector : undefined } };
            }
            const preCenter = elementCenter(el);   // BEFORE typing/submit, in case submit navigates the field away
            const input = el as HTMLInputElement;
            const editable = "value" in el;
            const cur = editable ? input.value : (el.textContent || "");
            const next = append ? cur + text : text;
            if (editable) input.value = next; else el.textContent = next;
            // Fire the events frameworks listen for so the field isn't "empty" to them.
            try { (el as HTMLElement).focus(); } catch {}
            for (const type of ["input", "change"]) {
                try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch {}
            }
            let note = "";
            if (submit) {
                for (const type of ["keydown", "keyup"]) {
                    try { el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })); } catch {}
                }
                if (input.form && typeof input.form.requestSubmit === "function") { try { input.form.requestSubmit(); } catch {} }
                await settle(80);
                note = " Submitted (Enter).";
            }
            const shown = editable ? input.value : (el.textContent || "");
            const base = `Typed into ${elLine(el)}. Value now: "${truncate(shown, 100)}".${note}`;
            if (verify) {
                // If the field SURVIVED, verify shows the WHOLE field (a picture of what you typed into), not a
                // fixed-radius point crop. If it VANISHED after submit (navigation), fall back to a point crop of
                // where it was, flagged as mutated.
                let now: Element | undefined; try { now = queryAll(selector)[index]; } catch { /* gone */ }
                if (now && isElement(now)) {
                    const v = await captureVerifyElement(ml, ctx, now, "typed", `the field ${elLine(now)}`);
                    if (v.content || v.image || v.feedback) return { content: base + (v.content || ""), image: v.image, imageLabel: v.imageLabel, feedback: v.feedback };
                }
                if (preCenter) { const v = await captureVerify(ml, ctx, preCenter, "typed", true); return { content: base + (v.content || ""), image: v.image, imageLabel: v.imageLabel, feedback: v.feedback }; }
            }
            return `${base} Re-run look/findByText to see the result.`;
        }
    });
};

// --- python_exec: a sandboxed Python (Pyodide/WASM) tool for pixel/array work ---
// The value the script returns is interpreted into the SAME coordinate currency as
// locate: a point → @pt, a box → @box, a data-URL → an image render. The model only
// describes/computes; we mint the token (delegation-safe — no coordinates authored here).
const asPoint = (v: unknown): { x: number; y: number } | null => {
    if (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === "number")) return { x: v[0], y: v[1] };
    if (v && typeof v === "object" && typeof (v as any).x === "number" && typeof (v as any).y === "number") return { x: (v as any).x, y: (v as any).y };
    return null;
};
const asBoxVal = (v: unknown): Box | null => {
    if (Array.isArray(v) && v.length === 4 && v.every(n => typeof n === "number")) return { left: v[0], top: v[1], right: v[2], bottom: v[3] };
    if (v && typeof v === "object" && ["left", "top", "right", "bottom"].every(k => typeof (v as any)[k] === "number")) return v as Box;
    return null;
};
// A LIST of points/boxes — the model keeps finding new ways to hand back coordinates (here:
// [[666,529],[697,529]], multiple candidates). A single [x,y]/4-array is NOT a list (its members
// are numbers, not points/boxes), so these don't clash with asPoint/asBoxVal above.
const asPointList = (v: unknown): { x: number; y: number }[] | null =>
    Array.isArray(v) && v.length > 0 && v.every(it => asPoint(it)) ? v.map(it => asPoint(it)!) : null;
const asBoxList = (v: unknown): Box[] | null =>
    Array.isArray(v) && v.length > 0 && v.every(it => asBoxVal(it)) ? v.map(it => asBoxVal(it)!) : null;

export const buildPythonTool = (ml: MlApi): MlTool => {
    // `current` is only advertised when it actually resolves to something — the page is a Google Sheet,
    // OR it has EXACTLY one non-empty table (then 'current' = that table). Otherwise 'current' is left
    // out of the description entirely, since it confuses models into using it where it can't work.
    const onSheet = typeof location !== "undefined" && !!googleSheetCsvUrl(location.href);
    const singleTable = !onSheet && typeof document !== "undefined" && nonEmptyTables(document).length === 1;
    const currentHint = onSheet
        ? " YOU ARE CURRENTLY ON A GOOGLE SHEET — pass `tables:'current'` to load it as `df`."
        : singleTable ? " THIS PAGE HAS ONE TABLE — pass `tables:'current'` to load it as `df`." : "";
    const currentClause = onSheet ? " Or `'current'` for THIS Google Sheet."
        : singleTable ? " Or `'current'` for the one table on this page." : "";
    const tablesDesc = "Spreadsheet/table data → pandas DataFrame(s). A SINGLE source string (a CSS selector " +
        "for a page <table>/ARIA grid, or a Google Sheets URL) → loaded as `df`." + currentClause +
        " OR a map { variable_name: source } (keys = Python identifiers) → each loaded under its name so you can " +
        "join them, e.g. {\"sales\":\"#report\",\"targets\":\"https://docs.google.com/spreadsheets/d/…\"} → use " +
        "`sales`/`targets` directly (also in a `tables` dict, tables['sales']). A Google Sheet is fetched FOR you by " +
        "the extension (credentialed) — you do NOT need mode:'full' for it; keep mode:'readonly' (an external Sheet " +
        "just asks once to approve, then loads as a normal df). " +
        "A selector loads the FIRST match. The data arrives ALREADY parsed — use the variable, don't re-load it.";
    return ml.defineTool({
        name: "python_exec",
        summary: "Runs sandboxed Python (numpy/pandas/Pillow) for data & math.",
        requiresApproval: true,
        description: "Run SANDBOXED Python (numpy/Pillow/pandas, WASM) for array/pixel/spatial/table work better " +
            "done in Python than JS — pixel-mask & centroid a target, count regions, BFS a maze, or SUM/AVG/GROUP a " +
            "table. It's ONE cell of a live Jupyter notebook: your inputs are ALREADY loaded — `image`→`img`/`img_np` " +
            "(PIL + H×W×3 uint8), `tables`→DataFrame(s) — so reference them directly, never re-open/parse/read_csv " +
            "them. `return` a value → comes back as TEXT (or set `cast` to mint a clickable @pt/@box). RETURN TYPE " +
            "auto-renders: a sympy expression → typeset LaTeX, a PIL Image (or to_base64()) → an image, a DataFrame " +
            "→ a table — so just `return sympy.diff(...)` / `return img` and cite `![…](@tool:…:out)` (no cast; add " +
            "`| raw` to force the literal text). Each call is STATELESS — a fresh namespace, nothing persists. In scope: " +
            PY_PACKAGE_LABELS + " + stdlib (io, math, collections, itertools…). `mode` 'readonly' (default) is a pure " +
            "function over the inputs (may be auto-approved); 'full' enables network but ALWAYS asks the user." +
            currentHint,
        parameters: {
            type: "object",
            properties: {
                code: { type: "string", description: "Python. Reference img/img_np/your DataFrame(s); end with a `return` OR a bare trailing expression (Jupyter-style: a last line `df` is the result). print() is captured as stdout." },
                image: { type: "string", description: "Optional CSS selector or @pt:/@box: token to load as img/img_np. An @box loads the exact container content; an @pt loads a square neighbourhood around the point." },
                cast: { type: "string", enum: ["pt", "box"], description: "Interpret the return as a clickable coordinate: 'pt' (needs [x,y]/{x,y}) or 'box' ([x1,y1,x2,y2]/{left,top,right,bottom}). Compute it in your INPUT IMAGE's pixel space — casting AUTO-projects it to on-screen VIEWPORT coordinates (dpr + crop offset), so the returned @pt/@box is the correct click point, NOT displaced. Omit for a raw text result." },
                mode: { type: "string", enum: ["readonly", "full"], description: "'readonly' (default) = isolated sandbox, no network/JS scope (auto-approvable). 'full' = network enabled; ALWAYS asks for approval. Use 'readonly' for pure compute over the inputs — including Google Sheets (the extension fetches those for you, so 'full' is NOT needed). Only pick 'full' to fetch some OTHER arbitrary URL yourself." },
                margin: { type: "number", description: "For an @pt image only: the crop RADIUS in px around the point (a bigger margin = more context). Omit for the default. Ignored for @box / CSS selectors." },
                tables: {
                    oneOf: [
                        { type: "string" },   // a single source → loaded as `df`
                        { type: "object", additionalProperties: { type: "string" }, propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },   // { python_identifier: source }
                    ],
                    description: tablesDesc,
                },
                tableRaw: { type: "boolean", description: "Load table cells as raw STRINGS (skip the default numeric/currency auto-cast). Use only for ZIP/SKU/leading-zero IDs that casting would corrupt." },
                maxChars: { type: "number", description: "Raise the per-slot output truncation for THIS call (default 2000, max 20000). A raise needs human approval + `maxCharsReason`. Prefer returning a compact result." },
                maxCharsReason: { type: "string", description: "Why this call needs more than the default 2000 chars — required when `maxChars` exceeds it; shown to the human on the approval card." },
            },
            required: ["code"],
        },
        // A maxChars raise with no justification is DOOMED (it will just ask for one) — skip the gate and
        // steer the model to supply `maxCharsReason` first (then the human sees it on the approval card).
        precheck: (args) => outputCapPrecheck("python_exec", args as Record<string, unknown>),
        // Pre-run In render — shown during the approval WAIT, when run() hasn't produced its full
        // python-in yet (the input image + DataFrame previews need the tables loaded). Show the
        // highlighted code as a notebook cell now; post-run, run()'s renderIn wins in descriptorFor.
        render: (_input, args) => {
            const code = typeof args.code === "string" ? args.code : "";
            if (!code) return null;
            const mode = args.cast === "pt" ? "pt" as const : args.cast === "box" ? "box" as const : "script" as const;
            return { type: "python-in", mode, code };
        },
        run: async ({ code, image, cast, mode, margin, tableRaw, tables, maxChars, maxCharsReason }: { code: string; image?: string; cast?: "pt" | "box"; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Record<string, string>; maxChars?: number; maxCharsReason?: string }, ctx?: import("./contract").ToolContext): Promise<string | ToolResult> => {
            // Effective per-slot output cap (default 2000). A raise past it is only reachable AFTER the human
            // gate (autoApprovePython refuses to sandbox-approve an escalated call), clamped to the ceiling.
            const { cap: PY_OUT_MAX, clamped: capClamped } = resolveOutputCap("python_exec", maxChars, maxCharsReason);
            // A DOM-table selector loads the FIRST match — warn if it's ambiguous (loading the wrong
            // table and computing on it would silently give wrong numbers). Covers a single-source
            // `tables` string AND every DOM-selector value in a `tables` map (skipping 'current' /
            // Sheets-URL entries, which aren't selectors).
            const domSelectors: [string, string][] = [];
            const addIfSelector = (name: string, src: unknown) => {
                if (typeof src === "string" && src !== "current" && !googleSheetCsvUrl(src)) domSelectors.push([name, src]);
            };
            if (typeof tables === "string") addIfSelector("df", tables);
            else if (tables) for (const [name, src] of Object.entries(tables)) addIfSelector(name, src);
            let tableNote = "";
            for (const [name, sel] of domSelectors) {
                try { const n = ml._queryAll(sel).length; if (n > 1) tableNote += `⚠ selector "${sel}" matched ${n} elements — loaded the FIRST as \`${name}\`. If the numbers look off, narrow it (an id, or :nth-of-type(N)).\n`; } catch { /* invalid selector → pythonExec/_resolveTable errors below */ }
            }
            if (tableNote) tableNote += "\n";
            const r = await ml.pythonExec(code, { image: image || null, mode: mode === "full" ? "full" : "readonly", margin: typeof margin === "number" ? margin : 0, tableRaw: !!tableRaw, tables: tables || null, onStdout: ctx?.stream });
            // Cap stdout/value/error fed back to the model so a runaway result (e.g. a
            // string-concat blowup) can't flood the context — with a "[+N truncated]" note.
            const stdoutClipped = clipOut(r.stdout || "", PY_OUT_MAX);
            // Synthetic "already loaded" log — models get confused about HOW their tables/image arrive
            // (do they read_csv? what variable?). State it plainly at the top so they infer the setup:
            // `img`/`df`/named DataFrames are PRE-loaded, reference them directly.
            const loaded: string[] = [];
            for (const t of r.inputTables || []) loaded.push(t.rows ? `a ${t.rows.length}×${(t.columns?.length || t.rows[0]?.length || 0)} DataFrame → \`${t.name}\`` : `a DataFrame → \`${t.name}\``);
            if (r.inputImage) loaded.push("the screenshot → `img` (PIL) / `img_np` (numpy)");
            const loadedNote = loaded.length ? `[loaded, reference directly] ${loaded.join(", ")}.\n\n` : "";
            const capNote = capClamped ? `(output limit clamped to ${PY_OUT_MAX} chars — the hard ceiling.)\n\n` : "";
            const pre = capNote + tableNote + loadedNote + (stdoutClipped ? `stdout:\n${stdoutClipped}\n\n` : "");
            const stringify = (x: unknown) => clipOut(typeof x === "string" ? x : JSON.stringify(x), PY_OUT_MAX);
            // The In slot: a notebook-cell header (cell mode + input image/table + source). Shared
            // by every return path. The Out slot varies (stdout + one of image/token/value/error).
            const cellMode = cast === "pt" ? "pt" as const : cast === "box" ? "box" as const : "script" as const;
            // If the input image was captured from an @pt/@box, carry the token so hovering the image in
            // the sidebar highlights that point/region back on the page.
            const imageToken = typeof image === "string" && (POINT_RE.test(image.trim()) || BOX_RE.test(image.trim())) ? image.trim() : undefined;
            const renderIn: RenderDescriptor = { type: "python-in", mode: cellMode, code,
                ...(r.inputImage ? { image: r.inputImage } : {}), ...(imageToken ? { imageToken } : {}), ...(r.inputTables && r.inputTables.length ? { tables: r.inputTables } : {}) };
            // UI keeps far more than the model's cap (PY_OUT_MAX) so a watched stream doesn't SHRINK when the
            // step lands; `seen` marks where the model-facing view ended (the surplus renders marked).
            const stdoutFull = r.stdout || "";
            const stdout = stdoutFull ? clipOut(stdoutFull, UI_OUT_CAP) : undefined;
            const seen = stdoutFull ? Math.min(stdoutFull.length, PY_OUT_MAX) : undefined;
            const done = (content: string, out: Omit<Extract<RenderDescriptor, { type: "python-out" }>, "type" | "stdout">): ToolResult =>
                ({ content, renderIn, render: { type: "python-out", stdout, seen, ...out } });

            if (!r.ok) {
                const err = clipOut(r.error || "", PY_OUT_MAX);
                // Don't fight a hallucinated load pattern with docs alone — when data was PRELOADED
                // and the code errored trying to (re)load it (read_csv/read_html/open/requests/…),
                // redirect to the preloaded var. Fires on the failure, so it covers every variant
                // instead of enumerating them. (Observed: `pd.read_csv('current')` → FileNotFound.)
                const dfNames = (r.inputTables || []).map(t => `\`${t.name}\``).join("/");
                const loaded = [dfNames, r.inputImage ? "`img`/`img_np`" : ""].filter(Boolean).join(" and ");
                const looksLikeReload = /read_csv|read_html|read_excel|read_json|open\(|FileNotFoundError|No such file|ModuleNotFound|requests|urllib|urlopen|http|fetch|ConnectionError|storage_options/i.test(err);
                const hint = loaded && looksLikeReload
                    ? `\n\nHint: the tool ALREADY loaded your data as ${loaded} (the table/sheet/image PARAMETER did it) — reference it directly; do not read_csv/read_html/open/fetch anything (the sandbox has no filesystem or network in readonly mode).`
                    : "";
                return done(`${tableNote}Python error: ${err}${hint}${stdoutClipped ? `\n\nstdout:\n${stdoutClipped}` : ""}`, { error: err });
            }
            const v = r.value;
            // An image return is unambiguous → always shown (no cast needed).
            if (typeof v === "string" && /^data:image\//.test(v)) {
                return done(`${pre}Returned an image.`, { image: v });
            }
            // Coordinates are opt-in via `cast` (auto-detecting [x,y] would mangle a general
            // script that returns two numbers). A mismatch is an honest error, not a guess.
            if (cast === "pt") {
                const raw = asPoint(v);
                if (!raw) {
                    // A common miss: the script returned a LIST of candidate points — say so specifically.
                    const list = asPointList(v);
                    const why = list ? `it's a LIST of ${list.length} points — return the SINGLE best one as [x, y]` : `the return isn't a point ([x,y] or {x,y})`;
                    return done(`${pre}cast:'pt' but ${why}: ${stringify(v)}`, { value: stringify(v) });
                }
                // The script computed the point in the input IMAGE's pixels; project it back to viewport
                // coords (crop offset + dpr) so the @pt clicks the right spot. No image → already viewport.
                const pt = r.imageBox ? projectShotPoint(raw, r.imageBox) : raw;
                const t = mintPoint(pt.x, pt.y);
                // Models keep thinking the @pt is "displaced" — they compare it to their IMAGE-space
                // coords and see a mismatch. Spell out that we already projected image px → viewport.
                const proj = r.imageBox ? ` (You passed an image and cast to @pt, so your IMAGE-pixel coordinates were AUTOMATICALLY projected to VIEWPORT space — ${t} at (${Math.round(pt.x)}, ${Math.round(pt.y)}) IS the correct on-screen click point, not a displaced one; don't re-adjust for scale/offset.)` : "";
                return done(`${pre}→ ${t} at (${Math.round(pt.x)}, ${Math.round(pt.y)}).${proj} Verify then click: look({ selector: "${t}" }) → click({ selector: "${t}" }).`, { token: t });
            }
            if (cast === "box") {
                const raw = asBoxVal(v);
                if (!raw) {
                    const list = asBoxList(v);
                    const why = list ? `it's a LIST of ${list.length} boxes — return the SINGLE best one` : `the return isn't a box ([x1,y1,x2,y2] or {left,top,right,bottom})`;
                    return done(`${pre}cast:'box' but ${why}: ${stringify(v)}`, { value: stringify(v) });
                }
                const bx = r.imageBox ? projectShotBox(raw, r.imageBox) : raw;   // image px → viewport
                const t = mintBox(bx);
                const proj = r.imageBox ? ` (You passed an image and cast to @box, so your IMAGE-pixel coordinates were AUTOMATICALLY projected to VIEWPORT space — this region is already in on-screen coordinates; don't re-adjust for scale/offset.)` : "";
                return done(`${pre}→ ${t} (a ${Math.round(bx.right - bx.left)}×${Math.round(bx.bottom - bx.top)}px region).${proj} Scope into it: locate({ selector: "${t}", description: "…" }).`, { token: t });
            }
            const text = stringify(v);
            // The return LOOKS like a coordinate but no `cast` was set, so it came back as dead TEXT the
            // model can't click. Nudge it to re-run with the matching cast → a clickable @pt/@box. Covers a
            // single point/box AND a LIST of candidates (pt for {x,y}/[x,y], box for the 4-forms).
            // GATED on an image being passed: a coordinate is only a meaningful click target when it was
            // derived from a screenshot the tool loaded (cast then projects image-px → viewport). Without an
            // image the two numbers are almost certainly just data, and nudging to cast would be wrong.
            const hadImage = typeof image === "string" && image.trim().length > 0;
            const castHint = !hadImage ? ""
                : asPoint(v)
                    ? ` — this looks like a POINT but you didn't set \`cast\`, so it's just text you can't click. Re-run this exact script with cast:"pt" to mint a clickable coordinate (returns @pt:… → look()/click() it).`
                    : asBoxVal(v)
                        ? ` — this looks like a BOX but you didn't set \`cast\`, so it's just text. Re-run this exact script with cast:"box" to mint a clickable region (returns @box:… → scope into it with locate()).`
                        : asPointList(v)
                            ? ` — this looks like a LIST of ${asPointList(v)!.length} candidate POINTS but you didn't set \`cast\`, so it's dead text. Pick the SINGLE best one and return just that ([x, y]) with cast:"pt" to get a clickable @pt:… .`
                            : asBoxList(v)
                                ? ` — this looks like a LIST of ${asBoxList(v)!.length} candidate BOXES but you didn't set \`cast\`, so it's dead text. Return the SINGLE best one with cast:"box" to get a clickable @box:… .`
                                : "";
            // A returned DataFrame/Series → render a real table (the sidebar draws PyDfTable); the model
            // still gets the text repr in `content` for reasoning. Applies to both the agent run and the bench.
            if (r.resultTable) return done(`${pre}${text}`, { value: text, df: r.resultTable });
            // Returned None but PRINTED — a common miss: the model logs to stdout but returns nothing, so the
            // result is `null` and there's nothing meaningful to CITE. Nudge it to RETURN the value (a DataFrame
            // renders as a table). Gated on stdout so a script that legitimately returns nothing isn't nagged.
            const nullWarn = (v === null || v === undefined) && stdoutClipped
                ? "\n\n⚠ Your code RETURNED null (None) — you printed to stdout but didn't RETURN a value, so there's nothing to cite. Whatever the user should SEE, RETURN it (a pandas DataFrame renders as a readable table; a dict/number is fine); stdout is just a debug log."
                : "";
            // Auto-typeset a LaTeX return, no `| latex` cast needed (`| raw` overrides). Two ways it's detected:
            // (1) python-runtime saw a sympy TYPE and set r.render; (2) the value is a LaTeX STRING — a braced
            // sub/superscript or a LaTeX command — which catches a model that returns `sympy.latex(expr)` (a
            // string) rather than the expression. The pattern is specific enough to skip ordinary text.
            const looksLatex = typeof v === "string" && /[\^_]\{|\\(frac|sqrt|left|right|cdot|times|div|sum|prod|int|sin|cos|tan|log|ln|exp|lim|infty|partial|nabla|alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|begin)\b/.test(v);
            if (r.render === "latex" || looksLatex) return done(`${pre}${text}`, { value: text, latex: true });
            return done(`${pre}${text}${castHint}${nullWarn}`, { value: text });
        },
    });
};


/**
 * A remote function's schema with an optional `token` beside its own properties, so the model can NAME the
 * output at call time instead of coming back for it.
 *
 * A remote output is minted as a pointer either way (it is citable by declaration), so this is about giving
 * it a name the model chose — `@tool:"the page summary"` rather than `@tool:<the generated tool name>`.
 */
function withToken(schema: JsonSchema | null, bundle: string): JsonSchema {
    const base = (schema && typeof schema === "object" ? schema : { type: "object", properties: {} }) as JsonSchema & { properties?: Record<string, unknown> };
    if (base.type !== "object" || !base.properties || "token" in base.properties) return base;
    return {
        ...base,
        properties: {
            ...base.properties,
            token: { type: "string", description: `Optional: a SHORT label for this output, e.g. "the ${bundle} results". The output is kept either way, but a label is what you will actually remember — cite it later as @tool:"your label" instead of re-running this.` },
        },
    } as JsonSchema;
}

/** The arguments as ONE readable line for the consent sentence. Pretty-printed JSON inside the card's
 *  quoted "what you typed" slot renders as nested quotes and wraps over three lines — for the one gate whose
 *  entire risk is the VALUES, that is worse than useless. The full, exact object is still one click away in
 *  the In block's raw view, per the raw-view rule. */
function compactArgs(args: Record<string, unknown> | undefined): string {
    const entries = Object.entries(args || {});
    if (!entries.length) return "no arguments";
    return entries
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()}`)
        .join(", ");
}

/**
 * One agent-callable tool per FUNCTION of a server-side tool bundle.
 *
 * Per function rather than one generic `run_server_tool(tool, function, args)`, because the model calls a
 * tool far better when it can see that function's own JSON Schema. A generic dispatcher would hand it an
 * opaque `arguments` object and make it guess — which is the difference between a tool it uses correctly
 * and one it fumbles.
 *
 * Always `requiresApproval`. This is the first gate in the extension where the risk is not "this might
 * change your page" but "this sends your data somewhere else", and there is no read-only version of that
 * to auto-approve.
 *
 * @param ml the API (for `execServerTool` and `ctx.stream` plumbing)
 * @param bundles the bundles to expose, from `ml.serverTools()`
 * @param wanted bundle ids the caller asked for; anything else is left out
 */
export function buildServerTools(ml: MlApi, bundles: ServerTool[], wanted: readonly string[], off: readonly string[] = []): MlTool[] {
    const want = new Set(wanted);
    // Curated OUT by the user, by the same `<bundle>__<fn>` name a run would see. Not built at all rather
    // than built and hidden: a tool the model can see is a tool it will try, and the point of curating a
    // forty-tool backend down is that the ones left out never reach the prompt.
    const disabled = new Set(off);
    const out: MlTool[] = [];
    for (const b of bundles) {
        if (!want.has(b.id)) continue;
        for (const fn of b.functions || []) {
            // A tool name must be an identifier (defineTool enforces it) and must not collide with a
            // builtin, so it is namespaced by the bundle rather than trusted to be unique. Non-identifier
            // characters in either half are flattened; the REAL identity travels in `remote`, so a mangled
            // display name cannot change what runs.
            const safe = (x: string) => String(x).replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
            const name = `${safe(b.id)}__${safe(fn.name)}`;
            if (disabled.has(name)) continue;
            out.push({
                name,
                summary: `Runs ${fn.name} on the ${b.name} server.`,
                description: `${fn.description || `The ${fn.name} function of the ${b.name} tool.`} RUNS ON THE SERVER, not in this browser — its arguments leave this machine, so it needs approval every time. ${b.description || ""}`.trim(),
                // The server's schema VERBATIM, plus `token` as a SIBLING of its own properties — never a
                // wrapper around them. `{args: {...}, token}` would nest every remote tool's arguments to add
                // one optional field, which is the same opaque-object problem that made this one tool per
                // FUNCTION rather than one generic dispatcher. Sibling also matches how the citable builtins
                // already spell it, so there is one spelling rather than two.
                //
                // Skipped when the function already HAS a `token` property: shadowing a real parameter to add
                // a convenience is worse than the model reaching for `@tool:<toolname>` instead, which works.
                parameters: withToken(fn.parameters, b.name),
                requiresApproval: true,
                capabilities: [],
                remote: { via: "openwebui", toolId: b.id, fn: fn.name },
                // The consent surface. The human is not approving "a tool call" here — they are approving
                // sending these arguments off the machine — so the sentence says the callable that will run
                // and where, and the arguments are the body of it rather than a JSON blob underneath.
                // Rendered from the SAME identity the background mints its grant from, so a friendly tool
                // name cannot make this say one thing while the grant authorises another.
                render: (_input, args) => ({
                    type: "action" as const,
                    // The sentence is "Send <these values> to <this callable>", because that is what is being
                    // approved — not "run a tool". The card composes verb + input + target in that order, so
                    // the target carries its own preposition and the whole thing reads as English.
                    verb: "Send",
                    input: compactArgs(args),
                    target: `to ${fn.name} on ${b.name}`,
                    note: "off this machine, to the configured server",
                    // Styled like a navigation or a fetch: something is leaving, and that is the part to see.
                    crossOrigin: b.id,
                }),
                async run(args: Record<string, unknown>, ctx?: ToolContext) {
                    // `token` is OURS, added above — the server never declared it and would reject or ignore
                    // it. The loop reads it off the call's own arguments, so it must be stripped here and
                    // nowhere earlier.
                    const { token: _token, ...forServer } = (args || {}) as Record<string, unknown>;
                    const r = await ml.execServerTool(b.id, fn.name, forServer, {
                        onOutput: ctx?.stream ? (text, ts) => ctx.stream!(text, ts) : undefined,
                    });
                    // A stream that could not be read is NOT a tool that returned nothing, and the model
                    // cannot tell the difference on its own — so it is said outright.
                    if (!r.ok) return `Error: the tool did not complete — ${r.transportError}. This is a transport failure, not a result: the tool may or may not have run. Do not treat it as an empty answer.`;
                    if (r.result?.error) return `Error: ${r.result.error}`;
                    const value = r.result?.result;
                    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
                    return {
                        content: text,
                        // BOTH halves, in the shared output cell exec and python already use. The streamed
                        // frames and the returned value are different things — progress the tool produced as
                        // it worked, and what it answered with — so replacing one with the other made the
                        // output you watched arrive vanish the moment the step landed. (The old descriptor
                        // also set `code`, which is not a field of the `code` render: it drew an empty block,
                        // which is why only the result survived.)
                        // `render` is the OUT slot — this returned `renderOut`, which nothing reads, so the
                        // descriptor was silently dropped and the Out fell back to the raw result every time.
                        // That is why the output you watched stream in vanished the moment the step landed.
                        ...(r.output
                            ? { render: { type: "exec-out" as const, stdout: r.output, stdoutLabel: "output", value: text } }
                            : {}),
                        // The executor's own measurement. Our wall clock around this call also contains the
                        // network and the far end's overhead, so without this the timeline charges the whole
                        // span to the tool and a slow hop is indistinguishable from a slow tool.
                        ...(r.result?.durationMs != null
                            ? { remoteMs: { durationMs: r.result.durationMs, ...(r.result.queuedMs != null ? { queuedMs: r.result.queuedMs } : {}) } }
                            : {}),
                    };
                },
            });
        }
    }
    return out;
}
