// Small page-side utilities: the "where/when am I" context string, a settle beat,
// and element-rect screenshot cropping. Pure-ish (args + browser globals); bundled
// into injected.js.

import { truncate, shadowRootStats, iframeStats } from "./dom";
import type { ShotBox, VisionMemory } from "./contract";

/**
 * The agent's persistent JS scratchpad — a plain object injected into every `exec` body as the lexical
 * `state` variable, and exposed read-only as `ml.state`. Because the page has a live JS heap, an agent can
 * stash reusable functions/results here and pick them up on a later `exec` call — the Jupyter/kernel
 * paradigm, versus stateless one-shot tool calls. PAGE-LIFETIME + shared across runs (a run can be resumed
 * by hash at any time, so there's no clean per-run clear point — this is the honest model). It's the same
 * object everywhere; `ml.state` is a getter (unassignable) so an agent can't clobber the binding itself.
 */
export const agentState: Record<string, unknown> = {};

/** A Chromium flavour: its display name, major version, and the internal URL scheme its
 *  settings pages live under (`brave://extensions/shortcuts` etc.). */
export interface BrowserInfo { name: string; version: string | null; scheme: string; }

// Chromium forks that rebrand the internal scheme. Everything else (including plain
// Chromium builds) answers to chrome://.
const SCHEMES: Record<string, string> = {
    "Microsoft Edge": "edge", "Brave": "brave", "Opera": "opera", "Vivaldi": "vivaldi",
    "Arc": "arc", "Yandex": "yandex",
};
// UA-string fallbacks, most specific first — Chrome's own token appears in all of them.
const UA_BRANDS: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, "Microsoft Edge"], [/OPR\/([\d.]+)/, "Opera"],
    [/Vivaldi\/([\d.]+)/, "Vivaldi"], [/YaBrowser\/([\d.]+)/, "Yandex"], [/Chrome\/([\d.]+)/, "Google Chrome"],
];

/**
 * Identify the browser, for two purposes: telling the user where their settings live
 * (the shortcuts page is `chrome://` on Chrome but `edge://`/`brave://` on forks — the
 * wrong scheme is a dead link), and letting the model tailor browser-specific advice.
 *
 * Prefers `navigator.userAgentData.brands` (Brave and Edge announce themselves there
 * while impersonating Chrome in the UA string), falling back to UA sniffing.
 *
 * @param {object} [nav] Navigator-like object; defaults to the real `navigator` (injectable for tests).
 * @returns {BrowserInfo} Name, major version (null when undeterminable), and URL scheme.
 */
export const browserInfo = (nav?: {
    userAgentData?: { brands?: { brand: string; version: string }[] };
    userAgent?: string;
    brave?: unknown;
}): BrowserInfo => {
    const n = nav ?? (typeof navigator !== "undefined" ? navigator as never : undefined);
    let name: string | null = null, version: string | null = null;
    const brands = n?.userAgentData?.brands;
    if (Array.isArray(brands)) {
        // Skip Chromium itself and the deliberate "Not)A;Brand" GREASE entry — what's left
        // is the actual product (e.g. "Brave", "Microsoft Edge", "Google Chrome").
        const real = brands.find(b => b && b.brand && !/^Chromium$/i.test(b.brand) && !/not.*brand/i.test(b.brand));
        if (real) { name = real.brand; version = real.version || null; }
        else if (brands.length) { name = "Chromium"; version = brands.find(b => /^Chromium$/i.test(b.brand))?.version || null; }
    }
    if (!name) {
        // Brave strips itself from the UA string entirely; `navigator.brave` is the giveaway.
        if (n?.brave) name = "Brave";
        for (const [re, brand] of UA_BRANDS) {
            const m = n?.userAgent ? re.exec(n.userAgent) : null;
            if (!m) continue;
            if (!name) name = brand;
            version = (m[1] || "").split(".")[0] || null;
            break;
        }
    }
    name = name || "an unknown Chromium browser";
    return { name, version, scheme: SCHEMES[name] || "chrome" };
};

// What each fork CALLS private browsing — the extension toggle is labelled with it, and it differs across
// Chromium forks (Chrome "Incognito", Edge "InPrivate", Brave "Private", Opera "private"). Default: Incognito.
const INCOGNITO_TERM: Record<string, string> = {
    "Microsoft Edge": "InPrivate", "Brave": "Private", "Opera": "private", "Vivaldi": "Incognito", "Yandex": "Incognito",
};
/** The extension's own details page — deep-links straight to where "Allow in Incognito" lives — in the fork's
 *  internal scheme. Pass `chrome.runtime.id` for `extId`; without it, falls back to the extensions list URL. */
export const extensionDetailsUrl = (info: BrowserInfo, extId?: string): string =>
    extId ? `${info.scheme}://extensions/?id=${extId}` : `${info.scheme}://extensions`;
/**
 * Exact, browser-SPECIFIC steps to turn on the extension's "Allow in Incognito" (the private-browsing
 * permission a session-less `rendered` fetch needs). Chrome doesn't let an extension request it, so the model
 * relays these to the user. Uses the fork's own scheme (chrome:// vs brave:///edge://…), its own word for
 * private browsing ("InPrivate" on Edge, "Private" on Brave), AND — given the extension id — a link straight
 * to THIS extension's details page (…/extensions/?id=<id>), so the user lands right on the toggle.
 *
 * @param {BrowserInfo} [info] Defaults to the detected browser (injectable for tests).
 * @param {string} [extId] The extension id (chrome.runtime.id) → a direct details-page link.
 * @returns {string} A one-line, ready-to-relay instruction.
 */
export const incognitoEnableSteps = (info?: BrowserInfo, extId?: string): string => {
    const b = info ?? browserInfo();
    const term = INCOGNITO_TERM[b.name] ?? "Incognito";
    const url = extensionDetailsUrl(b, extId);
    const where = extId ? `open ${url} (window.ml's own details page)` : `open ${url} , find "window.ml", click "Details"`;
    return `In ${b.name}: ${where}, then turn ON the "Allow in ${term}" toggle (${b.name}'s name for private browsing is "${term}").`;
};

/**
 * Compact "where and when am I" snapshot: URL, title, page language, and the
 * current date/time + locale/timezone. ml.agent injects this by default (so the
 * model is oriented — knows what "today" is, and that amazon.nl implies Dutch),
 * and the pageInfo tool exposes it on demand. Guarded so it degrades when a global
 * is missing (e.g. in tests).
 */
export const pageContext = (): string => {
    const parts = [];
    try { if (typeof location !== "undefined" && location.href) parts.push(`URL: ${location.href}`); } catch {}
    try { if (typeof document !== "undefined" && document.title) parts.push(`Title: ${truncate(document.title, 80)}`); } catch {}
    try {
        const lang = (typeof document !== "undefined" && document.documentElement && document.documentElement.getAttribute)
            ? document.documentElement.getAttribute("lang") : null;
        if (lang) parts.push(`Page language: ${lang}`);
    } catch {}
    let locale, tz;
    try { const o = Intl.DateTimeFormat().resolvedOptions(); locale = o.locale; tz = o.timeZone; } catch {}
    const now = new Date();
    parts.push(`Now: ${now.toLocaleString(locale)}${tz ? ` (${tz})` : ""} — ISO ${now.toISOString()}`);
    if (locale) parts.push(`Locale: ${locale}`);
    // The browser the user is actually in, so advice lands ("open edge://settings", not chrome://).
    try { const b = browserInfo(); parts.push(`Browser: ${b.name}${b.version ? ` ${b.version}` : ""}`); } catch {}
    // Shadow-DOM orientation: a model scanning the DOM may not realise shadow roots exist. Report the counts
    // up front (open roots the DOM tools pierce with `host >>> inner`; closed ones only reachable visually).
    try {
        const s = shadowRootStats();
        if (s.open || s.closed) {
            parts.push(`Shadow DOM: ${s.open} open/captured shadow root${s.open === 1 ? "" : "s"}` +
                (s.open ? " (the DOM tools pierce these — reference with `host >>> inner`)" : "") +
                // The closed count is a rough upper bound — mostly EMPTY custom elements (unopened menus, outlets),
                // a few may seal content behind a closed root. Don't imply N barriers; anything VISIBLE is reachable
                // via locate/@pt regardless. (ml._shadowRoots() gives the honest sealed-vs-empty split, but it's a
                // private console diagnostic — deliberately NOT named here so the model doesn't fixate on it.)
                (s.closed ? `${s.open ? "; " : ", "}~${s.closed} custom element${s.closed === 1 ? "" : "s"} expose no light DOM (mostly EMPTY — unopened menus/outlets; a few may seal content — reach any visible one with locate/@pt)` : "") + ".");
        }
    } catch {}
    // Iframe orientation: same-origin frames the DOM tools cross (`>>>`); cross-origin ones are SOP-walled.
    try {
        const f = iframeStats();
        if (f.same || f.cross) {
            parts.push(`Iframes: ${f.same ? `${f.same} same-origin (the DOM tools cross these — references look like \`iframe >>> inner\`)` : ""}` +
                (f.same && f.cross ? "; " : "") +
                (f.cross ? `${f.cross} cross-origin (walled off by SOP — reach a control visually via locate/@pt + reserved-element clicking)` : "") + ".");
        }
    } catch {}
    return parts.join("\n");
};

/**
 * Await a short beat so a click/submit's navigation or DOM update can begin
 * before we read the result. Guarded: where setTimeout is absent (the jsdom
 * test sandbox) it resolves immediately rather than throwing.
 *
 * @param {number} ms Milliseconds to wait (passed to setTimeout).
 * @returns {Promise<void>} Resolves after the delay (or immediately in test sandbox).
 */
export const settle = (ms: number): Promise<void> => new Promise(r => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));

// The largest array `ml.range` will build. A range is a FINITE list you then `.map`/`.reduce` over — the
// terminate-by-construction counter loop for read-only `exec` (no `for`/`while` needed). The cap extends
// that guarantee to allocation: `range(1e12)` can't OOM the page — over the cap it throws instead.
export const RANGE_MAX = 100_000;
/**
 * A bounded integer range, like Python's `range()`. Forms: `range(stop)`, `range(start, stop)`,
 * `range(start, stop, step)`. Returns a real array (so `.map`/`.filter`/`.reduce` iterate a finite list —
 * no unbounded loop). Throws a RangeError on non-finite args, a zero step, or a length over {@link RANGE_MAX}.
 * Pure; unit-tested. Prefer this over a hand-rolled loop in `exec` — it can't run away.
 * @param {number} a `stop` (one-arg form) or `start`.
 * @param {number} [b] `stop` when `a` is `start`.
 * @param {number} [step=1] Increment; may be negative for a descending range.
 * @returns {number[]} The integer sequence.
 */
export function mlRange(a: number, b?: number, step: number = 1): number[] {
    const start = b === undefined ? 0 : Number(a);
    const stop = b === undefined ? Number(a) : Number(b);
    const s = Number(step);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(s) || s === 0)
        throw new RangeError("ml.range: start/stop/step must be finite and step must be non-zero");
    const n = Math.max(0, Math.ceil((stop - start) / s));
    if (n > RANGE_MAX) throw new RangeError(`ml.range: too large (${n} > ${RANGE_MAX})`);
    const out: number[] = [];
    for (let i = 0, v = start; i < n; i++, v += s) out.push(v);
    return out;
}

// Smallest CSS-px width/height an element may have and still be worth
// screenshotting. Below this (a 1px spacer, a collapsed box) the crop is a
// useless sliver; ml.screenshot rejects instead of sending it. Kept tiny so
// genuinely small-but-real targets (icons, badges) still pass.
export const MIN_SHOT_PX = 4;

// Context window cap for delegated vision sub-calls — the single source of truth
// lives in contract.ts (shared with the sidebar's model-test); re-exported here so
// page-world consumers (builtin-tools) keep importing it from util.
export { VISION_NUM_CTX } from "./contract";

/**
 * Crop a full-viewport PNG data URL down to an element's rect. Runs page-side
 * because a data: image doesn't taint the canvas (the cross-origin-taint gotcha
 * only bites remote images), so pixel readback works. rect is in CSS px; the
 * captured PNG is at devicePixelRatio, so scale by dpr and clamp to the image
 * bounds (an element taller than the viewport gets clipped).
 *
 * @param {string} dataUrl The full-viewport PNG data URL.
 * @param {DOMRect} rect The element's bounding rectangle.
 * @param {number} dpr The device pixel ratio.
 * @returns {Promise<string>} The cropped image as a data URL.
 */
export const cropDataUrl = (dataUrl: string, rect: { left: number; top: number; width: number; height: number }, dpr: number): Promise<string> => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
        const sx = Math.max(0, Math.round(rect.left * dpr));
        const sy = Math.max(0, Math.round(rect.top * dpr));
        const sw = Math.max(1, Math.min(Math.round(rect.width * dpr), img.naturalWidth - sx));
        const sh = Math.max(1, Math.min(Math.round(rect.height * dpr), img.naturalHeight - sy));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("failed to load the captured screenshot"));
    img.src = dataUrl;
});

// --- Canvas coordinate targets: an OPAQUE `@pt:<hex>` token → a viewport {x,y} ------
// A <canvas> has no sub-node to snap to, so `locate` mints a point token that `click`
// resolves (and `screenshot`/`look` can crop+mark for verification). Shared here so
// injected (screenshot) and builtin-tools (locate/click) use one registry. The token is
// opaque — the model copies it verbatim, never authoring coordinates. Page-lifetime map.
const pointRegistry = new Map<string, { x: number; y: number }>();
export const POINT_RE = /^@pt:([0-9a-f]{1,12})$/;
// Half-size of the square `look({ @pt })` crops around a point (→ a 2·R box). Shared
// so `locate({ selector: "@pt:…" })` searches the EXACT box look showed — the model
// re-locates the neighborhood it just visually confirmed holds the target.
export const PT_LOOK_RADIUS = 100;
export const mintPoint = (x: number, y: number): string => {
    const id = Math.random().toString(16).slice(2, 10);
    pointRegistry.set(id, { x: Math.round(x), y: Math.round(y) });
    return `@pt:${id}`;
};
export const resolvePoint = (token: string): { x: number; y: number } | null => {
    const m = POINT_RE.exec((token || "").trim());
    return m ? pointRegistry.get(m[1]) || null : null;
};
// The most-recently-minted point within `within` px of (x,y), if any. Each mint is a
// FRESH token even for the same coordinate, so a re-locate loop that keeps landing on
// the same wrong spot can't otherwise tell it's going in circles — `locate` uses this
// to warn "you already tried here". Call BEFORE minting the new point (so it can't match
// itself). Returns the prior token + coords, or null.
export const nearbyPoint = (x: number, y: number, within = 12): { token: string; x: number; y: number } | null => {
    let best: { token: string; x: number; y: number } | null = null;
    let bestD = within * within;
    for (const [id, p] of pointRegistry) {
        const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { token: `@pt:${id}`, x: p.x, y: p.y }; }
    }
    return best;
};

// --- Near-area vision memory: which spots the DRIVER has already SEEN a crop of --------
// Distinct from `nearbyPoint` (which scans every MINTED point): this tracks only the points whose
// marked crop actually entered the model's context — a `look({@pt})` or a `locate` snap auto-inject.
// `locate` consults it before auto-injecting so a re-snap onto an already-shown spot doesn't re-inject
// a near-identical crop. Radius = PT_LOOK_RADIUS: a look/inject crop spans ~that, so a point within it
// is already visible in the prior view.
export const SEEN_RADIUS = PT_LOOK_RADIUS;
export const markSeen = (mem: VisionMemory | null | undefined, x: number, y: number): void => {
    if (mem) mem.seen.push({ x: Math.round(x), y: Math.round(y) });
};
export const seenNearby = (mem: VisionMemory | null | undefined, x: number, y: number, within = SEEN_RADIUS): boolean =>
    !!mem && mem.seen.some(p => Math.hypot(p.x - x, p.y - y) <= within);

// --- Canvas coordinate CONTAINERS: an opaque `@box:<hex>` token → a viewport box ------
// The REGION analogue of @pt. `locate({ container: true })` has the grounding model
// outline a sub-area of a canvas (a panel/card/toolbar) and mints this; then
// `locate({ selector: "@box:…" })` scopes the search INTO it, and `look({ selector:
// "@box:…" })` crops to it. Same opaque contract — the model copies the token verbatim,
// never authoring coordinates — so a text-only driver can recurse box → sub-box → @pt on
// a pure-canvas UI. Page-lifetime map, shared by injected (look) + builtin-tools (locate).
export type PtBox = { left: number; top: number; right: number; bottom: number };
const boxRegistry = new Map<string, PtBox>();
export const BOX_RE = /^@box:([0-9a-f]{1,12})$/;
export const mintBox = (b: PtBox): string => {
    const id = Math.random().toString(16).slice(2, 10);
    boxRegistry.set(id, { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) });
    return `@box:${id}`;
};
export const resolveBox = (token: string): PtBox | null => {
    const m = BOX_RE.exec((token || "").trim());
    return m ? boxRegistry.get(m[1]) || null : null;
};

// --- Screenshot coordinate transform (project image-pixel coords → viewport) -----------
// A raw element/region screenshot (ml.screenshot({ raw:true })) is CROPPED to the target's
// viewport rect and SCALED by devicePixelRatio. So a pixel (px,py) in that image maps to the
// viewport CSS coordinate `left + px/dpr`, `top + py/dpr`. python_exec analyses the image
// (np.array(img)) and returns coords in IMAGE pixels; @pt/@box click in VIEWPORT coords — so a
// cast:'pt'/'box' MUST project through this transform first, or the click lands off-target (on a
// Retina display, ~dpr× too far, plus the missing element offset). Pure.
export const projectShotPoint = (p: { x: number; y: number }, t: ShotBox): { x: number; y: number } =>
    ({ x: t.left + p.x / (t.dpr || 1), y: t.top + p.y / (t.dpr || 1) });
export const projectShotBox = (b: PtBox, t: ShotBox): PtBox => ({
    left: t.left + b.left / (t.dpr || 1), top: t.top + b.top / (t.dpr || 1),
    right: t.left + b.right / (t.dpr || 1), bottom: t.top + b.bottom / (t.dpr || 1),
});
/**
 * A stable, opaque TOOL TOKEN id for a tool step — `hash(runHash:seq)` as 6 hex. Deterministic (a
 * replay / re-render of the same run mints the same id, so a persisted transcript still resolves) yet
 * opaque to the model, so it must COPY the token from a result, not guess it (a guessed id won't match
 * the hash → a visible "unresolved" chip rather than the wrong step). The `@tool:` prefix is added by the
 * caller. FNV-1a — dependency-free, good enough for a per-run collision-resistant short id.
 */
export const toolToken = (runHash: string, seq: number): string => {
    let h = 0x811c9dc5;
    const s = `${runHash}:${seq}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
};
