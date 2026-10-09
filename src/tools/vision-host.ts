// vision-host.ts — the seam under look, locate and the verify after an action: where a capture, a question about the page's layout, a model call and the image drawing come from.

// One set of tool bodies serves every host. A body never reaches the page, the tab or the model directly: it asks its
// `VisionHost`. The page host (`pageVisionHost`, page-geometry.ts) answers from the DOM, CAPTURE_TAB and `ml.chat`, as
// the bodies always did. A worker host answers the same questions with the worker's capture and model call, and sends
// only the GEOMETRY to the page, as a message. That is why every `Geometry` reply is plain JSON-able data (no DOM node,
// no function): it will cross a message, where the worker checks it field by field before a body reads it.

import type { Raster } from "../raster";
import type { VisionMemory } from "../contract/contract-render";
import type { MarkFilter } from "../dom/locate";
import type { RegionLegend } from "../dom/legend";

/** A viewport capture: the PNG data URL, and its size in pixels when the host measured it (the page host does not). */
export interface Shot {
    dataUrl: string;
    w?: number;
    h?: number;
}

/** A box in viewport CSS px, with both its edges and its size, as `getBoundingClientRect` reports one. */
export interface GeoRect { left: number; top: number; right: number; bottom: number; width: number; height: number; }

/** A box in viewport CSS px by its edges. */
export interface GeoBox { left: number; top: number; right: number; bottom: number; }

/** A viewport point in CSS px. */
export interface GeoPoint { x: number; y: number; }

/** The kind of OPAQUE surface at a point: one with no inner DOM node to snap a selector onto. */
export type GeoOpaqueKind = "canvas" | "iframe" | "shadow";

/** The opaque-surface point nearest a box's centre, and which kind of surface it is. */
export interface GeoOpaque extends GeoPoint { kind: GeoOpaqueKind; }

/** The viewport: its size in CSS px, the device pixel ratio, and the scroll offset. */
export interface GeoView { w: number; h: number; dpr: number; sx: number; sy: number; }

/**
 * What to find: the `index`th match of a CSS `selector`, an `@pt`/`@box` `token`, or the element that has focus.
 * `scroll` brings an element to the viewport's centre and waits for the scroll to paint before measuring; `measure`
 * picks the top-viewport box (default, composing same-origin iframe offsets) or the element's own client box.
 */
export type TargetQuery =
    | { selector: string; index?: number; scroll?: boolean; measure?: "viewport" | "client" }
    | { token: string }
    | { focus: true; scroll?: boolean };

/**
 * Where a target is: an element's `rect`, a point token's `point`, a box token's `box`, or why there is none: an
 * invalid selector (`msg` is the engine's own message), no `index`th match (`count` is how many there were), a token
 * that resolves to nothing, or no focused element.
 */
export type TargetReply =
    | { rect: GeoRect }
    | { point: GeoPoint }
    | { box: GeoBox }
    | { err: "selector"; msg: string }
    | { err: "nomatch"; count: number }
    | { err: "token" }
    | { err: "nofocus" };

/**
 * A candidate element, as locate shows it to a reader: its 1-based badge `id`, role, accessible name, a selector a
 * click can use, and its viewport box. `ref` names the live element to the host that found it, for the debug-only
 * `elements` side channel; it means nothing anywhere else.
 */
export interface GeoMark { ref: number; id: number; role: string; name: string; selector: string; rect: GeoRect; }

/** The Set-of-Marks sweep: how many candidates there were in all, the first `badge` of them as marks, whether every one
 *  of those sits on an opaque surface, and the opaque surface under the search box, if any. */
export interface MarksReply { total: number; marks: GeoMark[]; allOpaque: boolean; opaque: GeoOpaque | null; }

/** A grounding box snapped to the DOM: the opaque surface under it (and then no marks), else the element at its centre
 *  first and the others in it after, at most 12. No marks means nothing is there. */
export interface SnapReply { opaque: GeoOpaque | null; marks: GeoMark[]; }

/** A grid cell snapped to the DOM: the non-opaque elements in it (at most 20), and the opaque surface under it when
 *  there are none. */
export interface CellReply { marks: GeoMark[]; opaque: GeoOpaque | null; }

/** A freshly minted token, and the earlier point token that is essentially the same spot, if any. */
export interface MintReply { token: string; dup?: { token: string; x: number; y: number }; }

/** The full-page stitch's start: the height to cover (capped at eight screens), the viewport height, the scroll
 *  offset to restore, and the pixel ratio the tiles are captured at. */
export interface StitchBegin { total: number; vh: number; startY: number; dpr: number; }

/** One stitch tile's scroll: where the page actually landed, and whether that reached the bottom. */
export interface StitchTile { actualY: number; isLast: boolean; }

/**
 * The questions a vision body asks the page about layout, each answered asynchronously and in plain data. The page
 * answers them from the DOM; a worker host forwards them to the page. Nothing here sees an image, a prompt or a reply.
 */
export interface Geometry {
    /** The viewport's size, pixel ratio and scroll. */
    view(): Promise<GeoView>;
    /** Resolve a selector, a token or the focus to where it is (scrolling it into view first when asked). */
    target(q: TargetQuery): Promise<TargetReply>;
    /** Set-of-Marks: sweep the viewport (or `box`, when `scoped`) for `filter` candidates, at most `max`, badge `badge`. */
    marks(q: { filter: MarkFilter; box: GeoBox; scoped: boolean; max: number; badge: number }): Promise<MarksReply>;
    /** Snap a grounding box to the DOM: the opaque surface in it, else the element at (`cx`, `cy`) and the others in it. */
    snap(q: { box: GeoBox; cx: number; cy: number; filter: MarkFilter }): Promise<SnapReply>;
    /** Snap a grid cell to the DOM. */
    cell(q: { box: GeoBox; filter: MarkFilter }): Promise<CellReply>;
    /** Mint an `@pt` token for a point (reporting a near-identical earlier one) or an `@box` token for a box. */
    mint(q: { pt: GeoPoint } | { box: GeoBox }): Promise<MintReply>;
    /** The DOM legend of what is inside `box`: controls, media, text and boundaries, with selectors. */
    legend(q: { box: GeoBox }): Promise<RegionLegend>;
    /** Whether the page has text under `box` (where a click-point marker would hide it). */
    crossesText(q: { box: { left: number; top: number; width: number; height: number } }): Promise<boolean>;
    /** The focused element's box and one-line description, or null when nothing is focused. */
    focus(): Promise<{ rect: GeoRect; line: string } | null>;
    /** Start a full-page stitch: measure the page and find the pinned overlays to show only once. */
    stitchBegin(): Promise<StitchBegin>;
    /** Scroll to `y` for the next tile, and show each pinned overlay only on its own tile. */
    stitchTile(q: { y: number }): Promise<StitchTile>;
    /** End a stitch: restore the overlays and the scroll position. */
    stitchEnd(): Promise<void>;
}

/** What `shoot` points at: the viewport (null), a CSS selector or an `@pt`/`@box` token, or the focused element. */
export type ShotTarget = string | null | { focus: true };

/** `ml.screenshot`'s options, which `shoot` takes as they are. */
export interface ShotOpts {
    scroll?: boolean;
    fullPage?: boolean;
    index?: number;
    raw?: boolean;
    margin?: number;
    noOverlay?: boolean;
    /** A viewport capture already taken, to crop from instead of capturing again. */
    capture?: string | null;
}

/** A model call's options: the images it reads, which model, the generation cap and the context size. */
export interface VisionChatOpts { images: string[]; model: string | null; maxTokens: number; numCtx: number; }

/** A reference to a live element for the debug side channel: a mark's `ref`, or the `index`th match of a selector. */
export type ElementRef = number | { selector: string; index: number };

/**
 * Everything a vision body may reach. `shoot` is `ml.screenshot`'s crop of a target from a capture, which
 * `shootVia` (ml-vision.ts) builds from `geo`, `capture` and `raster`; the page host answers it with `ml.screenshot`
 * itself. `elements` is the page-only debug side channel (the live nodes a result names, never sent to a model); a host
 * without a DOM leaves it out.
 */
export interface VisionHost {
    /** A capture of the viewport, with the debug sidebar hidden around it. */
    capture(): Promise<Shot>;
    /** The page's answers about layout. */
    geo: Geometry;
    /** A screenshot of a target, cropped (and marked, for a token) as `ml.screenshot` does. */
    shoot(target: ShotTarget, opts: ShotOpts): Promise<string>;
    /** One model call over images; the reply text. */
    chat(prompt: string, o: VisionChatOpts): Promise<string>;
    /** Where images and canvases come from. */
    raster: Raster;
    /** The spots and boundary notes this run's driver was already shown, shared by look and locate. */
    memory: VisionMemory | null;
    /** The live elements behind `refs` (debug only). */
    elements?(refs: ElementRef[]): Element[];
}

/** What `shootVia` needs of a host: its capture, its geometry and its raster. */
export type ShotHost = Pick<VisionHost, "capture" | "geo" | "raster">;
