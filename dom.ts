// Pure DOM / string utilities used across injected.js — path building, the
// jQuery-tolerant query engine, skeleton descriptions, text normalization. No
// dependency on injected's closure state; only args + browser globals.
import { roleOf, accessibleName } from "./a11y";   // for the `role=` / `label=` selector engines (a11y has no dom import → no cycle)
import type { ElementContext } from "./contract";

/**
 * Collapse whitespace, then truncate to a max length with a trailing ellipsis.
 *
 * @param {string} str The value to normalize (coerced; null/undefined → "").
 * @param {number} n Max length before truncating.
 * @returns {string} The collapsed string, ellipsized if it exceeded n.
 */
export const truncate = (str: string, n: number): string => {
    str = String(str == null ? "" : str).replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
};

/**
 * Length-only truncate: cap to n chars with a trailing ellipsis, PRESERVING
 * whitespace — newlines included. Use for multi-line output (e.g. exec's console
 * capture) where {@link truncate}'s `\s+`→" " collapse would flatten the line
 * breaks into spaces.
 *
 * @param {string} str The value to cap (coerced; null/undefined → "").
 * @param {number} n Max length before truncating.
 * @returns {string} The string, ellipsized if it exceeded n, whitespace intact.
 */
export const clip = (str: string, n: number): string => {
    str = String(str == null ? "" : str);
    return str.length > n ? str.slice(0, n) + "…" : str;
};

/** Like {@link clip}, but for TOOL OUTPUT fed back to the model: it reports HOW MANY chars
 *  were dropped, so the model knows it's seeing a prefix (and a runaway result — e.g. a
 *  string-concat blowup — can't silently flood the context). */
export const clipOut = (str: string, n: number): string => {
    str = String(str == null ? "" : str);
    return str.length > n ? `${str.slice(0, n)}… [+${str.length - n} chars truncated]` : str;
};

/** Context window (num_ctx) for the fetch_url `ask` reader sub-call — a SUMMARISER over a possibly-large
 *  fetched page, so it needs a window sized to the CONTENT, not the tiny utility default (tuned for titles,
 *  e.g. 4096). Sized to the clipped body (~3 chars/token, JSON/code-safe) plus headroom for the prompt
 *  wrapper and the answer, floored at a sane summariser minimum and rounded to a 2K boundary. The background's
 *  residency guard then REUSES an already-loaded bigger model for free (no reload) — this only bounds a
 *  genuinely fresh load, and forces a reload only when the content truly needs more than what's resident.
 *  Pure/tested. */
export function askReaderNumCtx(contentChars: number): number {
    const MIN = 8192;
    const est = Math.ceil(Math.max(0, contentChars) / 3) + 1024;   // content tokens + wrapper/answer headroom
    return Math.max(MIN, Math.ceil(est / 2048) * 2048);
}

/** True when an exec eval error is a page CSP / Trusted-Types BLOCK — main-world `eval`/`new Function` refused
 *  at COMPILE time (nothing ran), not a genuine code error. On such a page the (already-approved) exec can be
 *  re-run via CDP `Runtime.evaluate` (the debugger is CSP/TT-exempt). Matches Chrome's messages for a
 *  missing `'unsafe-eval'` and for `require-trusted-types-for 'script'`. Pure/tested. */
export function isCspEvalBlocked(msg: string): boolean {
    return /unsafe-eval|Content Security Policy|blocked by CSP|call to Function\(\) blocked|TrustedScript|Trusted ?Type|require-trusted-types/i.test(String(msg || ""));
}

/**
 * Extract error text from a caught throw. Background tasks reject with a plain
 * STRING (not an Error), so `e.message` would be undefined — fall back to String.
 *
 * @param {unknown} e The caught value (Error or bare string).
 * @returns {string} A human-readable message.
 */
export const errText = (e: unknown): string => (e && (e as Error).message) ? (e as Error).message : String(e);

/** Resolve a navigation target for the `navigate` tool: the absolute destination when `url` is a valid
 *  http(s) SAME-ORIGIN target (relative URLs resolve against `currentHref`), else `{ error }` explaining the
 *  refusal. Cross-origin is refused here (v1) — continuing a run on another origin is a trust escalation
 *  (per-origin consent) that isn't wired yet, so the caller relays the message to the model rather than
 *  silently failing. Pure, so it's unit-testable without a live document. */
export const navTarget = (url: string, currentHref: string, opts: { allowCrossOrigin?: boolean } = {}): { dest: string; crossOrigin: boolean } | { error: string } => {
    if (typeof url !== "string" || !url.trim()) return { error: "navigate needs a non-empty URL." };
    let here: URL, dest: URL;
    try { here = new URL(currentHref); } catch { return { error: "Could not read the current page URL." }; }
    try { dest = new URL(url, currentHref); } catch { return { error: `"${url}" is not a valid URL.` }; }
    if (dest.protocol !== "http:" && dest.protocol !== "https:") return { error: `navigate only supports http(s) URLs (got "${dest.protocol}").` };
    const crossOrigin = dest.origin !== here.origin;
    // Cross-origin (a different SITE) is a scope escalation — the run carries its history onto another
    // origin. Allowed only when the run opted in (`crossOrigin: true`); otherwise refused, same-site only.
    if (crossOrigin && !opts.allowCrossOrigin) return { error: `Cross-origin navigation (to ${dest.origin}) is not enabled for this session — this run wasn't started with { crossOrigin: true }, so you can't leave ${here.origin}. Tell the user.` };
    return { dest: dest.href, crossOrigin };
};

/**
 * Escape an id/class token so it's a VALID CSS identifier. Tailwind classes are
 * full of chars that are illegal unescaped in a selector — `/` (opacity, bg-black/5),
 * `:` (variants, hover:bg-…), `[` `]` (arbitrary values, text-[10px]), `.` (size-8.5),
 * `!` (important). Prefers the platform CSS.escape; falls back to a minimal escaper
 * (backslash-prefix anything outside [A-Za-z0-9_-]) for environments without it
 * (e.g. jsdom in the tests).
 *
 * @param {string} s The raw id or class token.
 * @returns {string} The token, escaped so it's safe to splice into a selector.
 */
export const cssEsc = (s: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, m => "\\" + m);

/**
 * Build one `tag#id.class.class` selector segment for an element, with id +
 * classes escaped so the segment is ALWAYS valid CSS. Shared by elPath / elLine
 * so every path we hand the model is copy-paste-clickable, not a Tailwind-class
 * string that throws in querySelector.
 *
 * @param {Element} el The element to describe.
 * @param {number} maxClasses Cap on classes appended (keeps segments readable).
 * @returns {string} A valid single-element selector segment.
 */
export const cssSegment = (el: Element, maxClasses: number): string => {
    let seg = el.tagName.toLowerCase();
    if (el.id) seg += "#" + cssEsc(el.id);
    if (el.classList && el.classList.length) {
        seg += "." + [...el.classList].slice(0, maxClasses).map(cssEsc).join(".");
    }
    return seg;
};

/**
 * Compact structural path for an element: body > div#main > div.card > h2.title —
 * tag + id + up to 4 classes per ancestor, capped at 8 hops. A DESCRIPTION (shows
 * classes so the model sees structure) that is ALSO a valid selector (segments are
 * escaped) — though a shorter clickSelector is preferred where brevity matters.
 *
 * @param {Element} el The leaf element to trace up from.
 * @returns {string} A `>`-joined root→leaf selector path.
 */
export const elPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Node | null = el, hops = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && hops < 8) {
        parts.unshift(cssSegment(node as Element, 4));
        node = node.parentElement;
        hops++;
    }
    return parts.join(" > ");
};

/** A copy-pasteable JS reference to the element a selector path (as elPath produces) locates:
 *  `document.querySelector('<path>')`, or `document.querySelectorAll('<path>')[i]` for a non-zero
 *  index. Backslashes (CSS escapes elPath emits, e.g. Tailwind `\/`) and single quotes are escaped for
 *  the JS string literal, so the emitted line evaluates to the right selector. Pure. */
export const elementReference = (path: string, index?: number): string => {
    const q = `'${String(path).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    return typeof index === "number" && index > 0
        ? `document.querySelectorAll(${q})[${index}]`
        : `document.querySelector(${q})`;
};

/**
 * Fold typographic punctuation + whitespace to ASCII so a search for
 * "web-browser" matches a page that rendered "web‑browser" (non-breaking
 * hyphen) — plus curly quotes, non-breaking spaces, ellipsis, full-width
 * forms (NFKC). A model's own fancy hyphen in its output otherwise defeats its
 * own later findByText/:contains search. Also lowercases for case-insensitivity.
 *
 * @param {string|null|undefined} s The text to normalize.
 * @returns {string} The normalized, lowercased text.
 */
export const normalizeText = (s: string | null | undefined): string => (s || "")
    .normalize("NFKC")
    .replace(/[‐-―−⁃﹘﹣－]/g, "-")   // hyphens/dashes/minus → -
    .replace(/[‘’‚‛′]/g, "'")               // curly / prime single quotes → '
    .replace(/[“”„‟″]/g, '"')               // curly / prime double quotes → "
    .replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Shortest VALID, unique CSS selector for an element — for lists whose selectors
 * are meant to be CLICKED (interactives). Prefers a unique id (own or ancestor);
 * else `tag:nth-of-type(n)` walking UP only until unique. Avoids elPath's giant,
 * un-escapable Tailwind-class chains. Falls through to a best-effort path.
 *
 * @param {Element} target The element to build a selector for.
 * @returns {string} A unique (where resolvable), valid selector.
 */
export const clickSelector = (target: Element): string => {
    const root = target.getRootNode() as ShadowRoot;
    // Inside an OPEN shadow root → a shadow-CROSSING reference: `<host path> >>> <inner path>`. queryAll
    // parses `>>>` back (stepping into each host's shadowRoot), so click/type/describeElement re-find it.
    // Duck-type (nodeType 11 + a `host`) rather than `instanceof ShadowRoot` — the latter breaks across
    // realms (e.g. the vm/jsdom test harness) and when ShadowRoot isn't a global.
    if (root && root.nodeType === 11 && root.host) {
        return `${clickSelector(root.host)} >>> ${selectorWithin(target, root)}`;
    }
    // Inside a SAME-ORIGIN <iframe> → cross the frame boundary with the SAME `>>>` notation. Recurses for
    // nested frames / shadow-in-frame.
    const frame = frameHostOf(target);
    if (frame && frame !== target) {
        return `${clickSelector(frame)} >>> ${selectorWithin(target, target.ownerDocument!)}`;
    }
    return selectorWithin(target, document);
};
/** The `<iframe>` element hosting `el`'s document, or null if `el` is in the TOP document. Prefers the
 *  standard `window.frameElement` (same-origin), falling back to a frame-tree search by contentDocument
 *  identity (jsdom doesn't populate frameElement; the search also covers browsers). */
export const frameHostOf = (el: Element): Element | null => {
    const owner = el.ownerDocument;
    if (!owner || owner === document) return null;   // top document → not in a frame
    try { const fe = owner.defaultView?.frameElement; if (fe) return fe as Element; } catch { /* cross-origin */ }
    // Fallback: find which iframe's document === owner. Recurse frame docs so a nested frame's host is found.
    const search = (root: ParentNode): Element | null => {
        for (const f of root.querySelectorAll("iframe")) {
            const doc = sameOriginFrameDoc(f as Element);
            if (!doc) continue;
            if (doc === owner) return f as Element;   // f directly hosts owner
            const deeper = search(doc);
            if (deeper) return deeper;   // owner is hosted by a frame nested inside f → that direct host
        }
        return null;
    };
    return search(document);
};

/** The page-relative offset of a (possibly same-origin-iframe-nested) element: how much to ADD to a
 *  frame-LOCAL coordinate to get the TOP document's viewport coordinate. `{0,0}` for a top-document element.
 *  This is the coordinate twin of `deepQueryAll` — the single answer to "this thing is nested in frames,
 *  give me its page offset", reusable for ANY frame-local measurement (an element rect, a `Range` rect, a
 *  DOMPoint, a canvas hit-test), not just the element's own box (which `viewportRect` wraps). Walk the frame
 *  chain, adding each host `<iframe>`'s position + its border (the frame's content origin). */
export const frameOffsetOf = (el: Element): { dx: number; dy: number } => {
    let dx = 0, dy = 0;
    for (let host = frameHostOf(el); host; host = frameHostOf(host)) {
        const fr = host.getBoundingClientRect();   // the <iframe>'s box in its own parent viewport
        let bl = 0, bt = 0;
        try { const cs = (host.ownerDocument.defaultView || window).getComputedStyle(host); bl = parseFloat(cs.borderLeftWidth) || 0; bt = parseFloat(cs.borderTopWidth) || 0; } catch { /* no view */ }
        dx += fr.left + bl; dy += fr.top + bt;
    }
    return { dx, dy };
};

/** An element's bounding box in the TOP document's viewport, composing offsets across same-origin iframe
 *  boundaries. An element INSIDE a frame reports getBoundingClientRect relative to the FRAME's viewport, so a
 *  top-level overlay (the approve-highlight, drawn in the top document) would place it at the frame-local
 *  position — wrong. `frameOffsetOf` does the frame walk; this just shifts the local rect by it. For a
 *  top-document element this is just getBoundingClientRect. */
export const viewportRect = (el: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number } => {
    const r = el.getBoundingClientRect();
    const { dx, dy } = frameOffsetOf(el);
    return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy, width: r.width, height: r.height };
};
// The shortest-unique-selector logic, scoped to a root (document OR a shadow root) so uniqueness is checked
// within that tree and the walk-up stops at the root's boundary (a shadow tree's top element has no parent).
const selectorWithin = (target: Element, scope: Document | ShadowRoot): string => {
    const esc = cssEsc;
    const uniq = (sel: string): boolean => { try { const m = scope.querySelectorAll(sel); return m.length === 1 && m[0] === target; } catch { return false; } };
    const idUnique = (el: Element) => !!el.id && (() => { try { return scope.querySelectorAll("#" + esc(el.id)).length === 1; } catch { return false; } })();
    if (idUnique(target)) return "#" + esc(target.id);
    const top = scope.nodeType === 9 ? (scope as Document).documentElement : null;   // stop here (or at a null parent in a shadow root)
    const parts: string[] = [];
    let el: Element | null = target, hops = 0;
    while (el && el.nodeType === 1 && el !== top && hops < 12) {
        if (idUnique(el)) parts.unshift("#" + esc(el.id));
        else {
            let seg = el.tagName.toLowerCase();
            const p = el.parentElement;
            if (p) { const sibs = [...p.children].filter(c => c.tagName === el!.tagName); if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(el) + 1})`; }
            parts.unshift(seg);
        }
        if (uniq(parts.join(" > "))) return parts.join(" > ");
        el = el.parentElement; hops++;
    }
    return parts.join(" > ") || target.tagName.toLowerCase();
};

// --- Closed-shadow-root piercing (opt-in `pierceClosedShadow`) ---------------------------------------
// The document_start patch (shadow-patch.ts, main world) stashes every CLOSED shadow root in
// window.__mlClosedRoots as it's created. We CONSULT that map only when the user turned the flag on —
// injected.ts calls setPierceClosedShadow() with the run's config before the DOM tools execute. Off (the
// default) → capturedClosedRoot always returns null and every closed root stays unreachable, exactly as
// before. This is the single seam; all traversal (deepQueryAll, `>>>` resolution, describeSkeleton, the
// stats/host scans) reads closed roots through traversableRoot/capturedClosedRoot so the feature is on or
// off uniformly.
// The flag and the captured-roots map both live on `window` (the main world, where `window === globalThis`)
// — the map because shadow-patch.js sets it there at document_start, the flag so the same lives beside it and
// stays reachable from the one `window` both this module and the patch share.
/** Enable/disable closed-shadow-root piercing for subsequent DOM-tool calls (set per agent run from config). */
export const setPierceClosedShadow = (on: boolean): void => {
    (window as unknown as Record<string, unknown>).__mlPierceClosed = on;
};

/** The CLOSED shadow root the document_start patch captured for `el`, IF piercing is enabled and it grabbed
 *  it. null when the flag is off, the patch is absent (shadow-patch.js didn't run), or the root is one it
 *  can't see (a declarative `shadowrootmode="closed"` or native root). */
export const capturedClosedRoot = (el: Element): ShadowRoot | null => {
    const w = window as unknown as { __mlPierceClosed?: boolean; __mlClosedRoots?: WeakMap<Element, ShadowRoot> };
    if (!w.__mlPierceClosed) return null;
    return w.__mlClosedRoots?.get(el) ?? null;
};

/** The shadow root the DOM tools should TRAVERSE for `el`: its OPEN root, or — when piercing is on — a
 *  captured CLOSED root. Makes captured closed roots first-class selector targets while the flag is set. */
export const traversableRoot = (el: Element): ShadowRoot | null => el.shadowRoot ?? capturedClosedRoot(el);

/** Cross-realm "is this an Element?" — checks `nodeType === 1`, NOT `instanceof Element`: an element resolved
 *  across a same-origin iframe boundary (`iframe >>> inner`) belongs to the FRAME's realm, so the top window's
 *  `Element` constructor doesn't recognise it (the same gotcha as `instanceof ShadowRoot`). A TYPE GUARD, so
 *  callers narrow to `Element` (no `as Element` casts). */
export const isElement = (n: unknown): n is Element => !!n && (n as Node).nodeType === 1;

/** The reachable inner Document of a SAME-ORIGIN `<iframe>` (SOP lets the top page read/act in it — `exec`
 *  can already), or null for a non-iframe or a CROSS-ORIGIN frame (whose contentDocument is null / throws —
 *  those stay selector-unreachable and need locate/@pt + reserved-element (CDP) clicking). This is what lets
 *  the `>>>` dialect cross a same-origin frame boundary, exactly like a shadow boundary. */
export const sameOriginFrameDoc = (el: Element): Document | null => {
    if (el.tagName !== "IFRAME") return null;
    try { return (el as HTMLIFrameElement).contentDocument; } catch { return null; }
};

/** Does rendered TEXT intersect this viewport box? Powers a TARGETED warning when `look`/verify's
 *  click-point overlay box sits ON text the model may need to read — so we nudge it to re-look with
 *  views:['no-overlay'] ONLY when the box actually crosses text, not on every marked crop. Samples caret
 *  positions across the box and confirms a real glyph rect overlaps it. Descends into SAME-ORIGIN iframes
 *  (coords translated); a CROSS-ORIGIN iframe's DOM is unreachable from this frame (SOP) — reaching it
 *  would need that frame's own content script — and a canvas @pt has no DOM text, so both simply don't
 *  trigger the warning (the manual no-overlay option still covers them). `doc`/`offset` are the recursion
 *  handles; callers pass a viewport box. */
export const boxIntersectsText = (box: { left: number; top: number; width: number; height: number }, doc: Document = document, offset: { x: number; y: number } = { x: 0, y: 0 }): boolean => {
    type CaretDoc = Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const d = doc as CaretDoc;
    const caretNodeAt = (x: number, y: number): Node | null => {
        if (typeof d.caretPositionFromPoint === "function") { const c = d.caretPositionFromPoint(x, y); return c ? c.offsetNode : null; }
        if (typeof d.caretRangeFromPoint === "function") { const r = d.caretRangeFromPoint(x, y); return r ? r.startContainer : null; }
        return null;
    };
    const w = box.width, h = box.height;
    // Centre + 4 inset corners — a filled marker box is small, so these span it.
    const pts: [number, number][] = [
        [box.left + w / 2, box.top + h / 2],
        [box.left + 2, box.top + 2], [box.left + w - 2, box.top + 2],
        [box.left + 2, box.top + h - 2], [box.left + w - 2, box.top + h - 2],
    ];
    for (const [vx, vy] of pts) {
        const lx = vx - offset.x, ly = vy - offset.y;   // top-viewport point → this doc's local coords
        let el: Element | null = null;
        try { el = doc.elementFromPoint(lx, ly); } catch { el = null; }
        if (el && el.tagName === "IFRAME") {
            const inner = sameOriginFrameDoc(el);   // cross-origin → null → its text is undetectable here
            if (!inner) continue;
            const fr = el.getBoundingClientRect();
            if (boxIntersectsText(box, inner, { x: offset.x + fr.left, y: offset.y + fr.top })) return true;
            continue;
        }
        const node = caretNodeAt(lx, ly);
        if (!node || node.nodeType !== 3 || !((node.textContent || "").trim())) continue;
        // A caret can resolve to a text node whose VISIBLE glyphs are elsewhere on the line — confirm a
        // real character rect overlaps the box before warning.
        let rects: DOMRectList;
        try { const rr = doc.createRange(); rr.selectNodeContents(node); rects = rr.getClientRects(); } catch { continue; }
        for (const r of Array.from(rects)) {
            if (r.width < 1 || r.height < 1) continue;
            const rl = r.left + offset.x, rt = r.top + offset.y;   // back to top-viewport coords
            if (rl < box.left + w && rl + r.width > box.left && rt < box.top + h && rt + r.height > box.top) return true;
        }
    }
    return false;
};

/**
 * One compact line for an element: tag#id.classes [data-*] "own text" (own text
 * only — never descendants' text or innerHTML). Shared by describeSkeleton and
 * the ancestors tool.
 *
 * @param {Element} el The element to describe.
 * @returns {string} A single descriptive line.
 */
export const elLine = (el: Element): string => {
    let seg = cssSegment(el, 6);
    const dataAttrs = [...el.attributes]
        .filter(a => a.name.startsWith("data-"))
        .slice(0, 6)
        .map(a => `${a.name}="${truncate(a.value, 20)}"`);
    if (dataAttrs.length) seg += " [" + dataAttrs.join(" ") + "]";
    const ownText = [...el.childNodes]
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent)
        .join(" ")
        .trim();
    if (ownText) seg += ` "${truncate(ownText, 60)}"`;
    return seg;
};

/**
 * Skeleton tree of an element + descendants to a depth: elLine per node, indented.
 *
 * @param {Element} el The root element.
 * @param {number} depth How many descendant levels to expand.
 * @param {string} [indent=""] Current indentation prefix (used in recursion).
 * @returns {string} A newline-joined, indented skeleton.
 */
// `canLocate` tailors the CLOSED-shadow-root steer: true → suggest locate()/@pt; false → say it can't be
// reached (no locate tool); undefined → a natural-language "IF you have a locate tool" (safe default when the
// caller doesn't pass a ToolContext). Propagated through the recursion.
export const describeSkeleton = (el: Element, depth: number, indent = "", canLocate?: boolean): string => {
    let out = indent + elLine(el);
    if (el.children.length && depth > 0) {
        for (const k of [...el.children].slice(0, 12)) {
            out += "\n" + describeSkeleton(k, depth - 1, indent + "  ", canLocate);
        }
        if (el.children.length > 12) out += "\n" + indent + `  …(${el.children.length - 12} more)`;
    } else if (el.children.length) {
        // Depth exhausted here — flag that children exist so the model knows to
        // describeElement deeper instead of mistaking this for a leaf.
        out += ` › ${el.children.length} child${el.children.length === 1 ? "" : "ren"}`;
    }
    // Shadow root handling. `el.shadowRoot` is the OPEN root, or null for BOTH "closed" and "none" (there's
    // no non-destructive API to distinguish them). So: an OPEN root → flag it + show the tree (its contents
    // are the element's real content, not the empty light children — reachable via `<sel> >>> <inner>`). A
    // custom element (hyphenated tag) with NO open root and NO light children almost certainly has a CLOSED
    // root — steer to visual navigation, since selectors can't reach in.
    // OPEN root, or — when piercing is on — a CLOSED root the document_start patch captured. Both are
    // traversable and referenced with `>>>`, so they render the same tree; only the label differs.
    const sr = el.shadowRoot ?? capturedClosedRoot(el);
    if (sr) {
        const label = el.shadowRoot ? "(OPEN)" : "(CLOSED, pierced) — captured at page load, so it's reachable;";
        out += "\n" + indent + `  #shadow-root ${label} its contents are shown below; reference them with \`>>> <inner selector>\`.`;
        const shadowKids = [...sr.children];
        if (depth > 0) {
            for (const k of shadowKids.slice(0, 12)) out += "\n" + describeSkeleton(k, depth - 1, indent + "    ", canLocate);
            if (shadowKids.length > 12) out += "\n" + indent + `    …(${shadowKids.length - 12} more)`;
        } else if (shadowKids.length) {
            out += `\n${indent}  › ${shadowKids.length} element${shadowKids.length === 1 ? "" : "s"} inside the shadow root (describeElement deeper to expand)`;
        }
    } else if (el.tagName.includes("-") && !el.children.length) {
        const hostSel = clickSelector(el);   // the host is a light-DOM element → a normal selector
        const base = `\n${indent}  #shadow-root (CLOSED) — this Web Component has no light children and no OPEN ` +
            "root, so any controls it renders are in a CLOSED shadow root that selectors CANNOT reach. ";
        // Tailor the workaround to whether `locate` is actually wired this run (ctx.hasTool → canLocate).
        out += base + (canLocate === false
            ? "You have no `locate` tool, so you can't interact with a closed shadow root — say so rather than guessing a selector."
            : (canLocate === true ? "Find them visually scoped to this element — " : "IF you have a `locate` tool, ") +
              `locate({ description: "<how the control looks>", selector: "${hostSel}" }) — then click the @pt it returns.`);
    } else if (el.tagName === "IFRAME") {
        // An <iframe> is a separate document. SAME-ORIGIN → the DOM tools cross it (like a shadow root):
        // descend + reference with `>>>`. CROSS-ORIGIN → SOP walls it off from selectors; reach it visually.
        const doc = sameOriginFrameDoc(el);
        if (doc) {
            out += "\n" + indent + "  #document (SAME-ORIGIN iframe) — its contents are shown below; reference them with `>>> <inner selector>`.";
            const kids = [...((doc.body || doc.documentElement)?.children || [])];
            if (depth > 0) {
                for (const k of kids.slice(0, 12)) out += "\n" + describeSkeleton(k, depth - 1, indent + "    ", canLocate);
                if (kids.length > 12) out += "\n" + indent + `    …(${kids.length - 12} more)`;
            } else if (kids.length) {
                out += `\n${indent}  › ${kids.length} element${kids.length === 1 ? "" : "s"} inside the iframe (describeElement deeper to expand)`;
            }
        } else {
            const sel = clickSelector(el);
            out += "\n" + indent + "  #document (CROSS-ORIGIN iframe) — a different origin, so selectors CANNOT reach inside (SOP). " +
                (canLocate === false
                    ? "You have no `locate` tool — say you can't interact with it rather than guessing a selector."
                    : `Reach a control visually: locate({ description: "<how it looks>", selector: "${sel}" }) → click the @pt (needs "reserved-element clicking" enabled for the debugger/CDP click).`);
        }
    } else if (!el.children.length && !indent) {
        // No child elements and no shadow root. Say so at the ROOT (not every leaf of an expanded tree) so an
        // empty container — e.g. a collapsed/lazily-rendered table like #bigsales — reads as "empty" instead
        // of a bare, useless single line.
        out += " (no child elements)";
    }
    return out;
};

// The jQuery/Sizzle/Playwright predicates the model reaches for but native `querySelectorAll` lacks are
// handled by the queryAll engine (evalExtHop / extractStepPseudos, combinator-aware): the `text=Foo`
// engine, `:contains("x")`/`:has-text("x")` text match, and `:eq(n)` positional pick. The one predicate
// that stays a REGEX here is the `:nth-of-type/child(n)` FALLBACK: it IS native, but the model habitually
// writes `.foo:nth-of-type(2)` meaning "the 2nd .foo"; native nth-of-type is per-TAG and usually matches
// nothing, so queryAll runs the literal selector first and ONLY when it finds nothing reinterprets a
// trailing nth as the 1-based nth match of the base set. Correct native uses (non-empty) are never touched.
const TRAILING_NTH_NATIVE = /^([\s\S]*):nth-(?:of-type|child)\(\s*(\d+)\s*\)\s*$/i;

/**
 * Query the document with the jQuery-tolerant selector dialect described above
 * (`:contains`/`:has-text`/`:eq`, plus the dead-`:nth-of-type` reinterpretation).
 *
 * @param {string} selector The (possibly predicate-carrying) selector.
 * @returns {Element[]} Matching elements, after peeling + applying predicates.
 */
/** querySelectorAll that PIERCES open shadow roots. Chrome's native querySelectorAll stops at shadow
 *  boundaries, so web-component content (Gemini's editor, many design systems) is invisible to a selector.
 *  Collects matches at `root` + recursively inside every OPEN shadowRoot (closed roots are unreachable by
 *  design), deduped. Reads the live DOM. */
export const deepQueryAll = (selector: string, root: ParentNode = document): Element[] => {
    const out: Element[] = [];
    const seen = new Set<Element>();
    const visit = (r: ParentNode): void => {
        try { for (const e of r.querySelectorAll(selector || "*")) if (!seen.has(e)) { seen.add(e); out.push(e); } } catch { /* invalid selector in this scope */ }
        for (const host of r.querySelectorAll("*")) {
            const sr = traversableRoot(host as Element);   // open root, or (when piercing is on) a captured closed root
            if (sr) { visit(sr); continue; }
            const doc = sameOriginFrameDoc(host as Element);   // a SAME-ORIGIN <iframe> → cross into its document
            if (doc) visit(doc);
        }
    };
    visit(root);
    return out;
};

/** A hyphenated custom element with NO light content (no element children, no text) that nonetheless PAINTS a
 *  visible box — so its content lives behind a boundary a selector can't enter (a genuine closed/declarative
 *  shadow root, or CSS-painted content). This is the SEALED set worth reporting. The naive "hyphenated + no
 *  children" heuristic over-counts wildly: on an Angular app it flags every EMPTY emulated-encapsulation
 *  component (an unopened `mat-menu`/`gem-popover`, a `router-outlet`) — those have no shadow root and no
 *  content right now, so they're NOT barriers. Requiring a rendered box drops that noise (a probe of real
 *  pages: Shoelace is 344/344 OPEN roots — 0 sealed; a "103 closed" count is almost all empty emulated hosts). */
const isSealedHost = (e: Element): boolean => {
    if (!e.tagName.includes("-") || e.children.length || (e.textContent || "").trim()) return false;
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
};
/** Count shadow roots for ORIENTATION — a model scanning the DOM may not realise shadow roots exist at all.
 *  `open` = REACHABLE roots (recursive, incl. nested) — open roots, PLUS captured closed roots when piercing
 *  is on (the DOM tools reach both). `closed` = a heuristic for Web Components whose content is an UNREACHABLE
 *  closed root (hyphenated tag, no light children). This is a quick upper bound (it also catches EMPTY
 *  emulated-encapsulation hosts — the message says "closed/empty"); `ml.shadowRoots()` splits sealed vs empty
 *  honestly for the ones that actually paint content. */
export const shadowRootStats = (root: ParentNode = document): { open: number; closed: number } => {
    let open = 0, closed = 0;
    const visit = (r: ParentNode): void => {
        for (const el of r.querySelectorAll("*")) {
            const e = el as Element;
            if (e.shadowRoot) { open++; visit(e.shadowRoot); continue; }
            const captured = capturedClosedRoot(e);   // piercing on + patch grabbed it → now reachable
            if (captured) { open++; visit(captured); continue; }
            if (e.tagName.includes("-") && !e.children.length) closed++;   // unreachable (upper bound; ml.shadowRoots() refines)
        }
    };
    visit(root);
    return { open, closed };
};

/** Count iframes for ORIENTATION: `same` = SAME-ORIGIN frames the DOM tools CROSS (via `>>>`, recursive);
 *  `cross` = CROSS-ORIGIN frames the SOP walls off (selector-unreachable → locate/@pt + reserved-element/CDP). */
export const iframeStats = (root: ParentNode = document): { same: number; cross: number } => {
    let same = 0, cross = 0;
    const visit = (r: ParentNode): void => {
        for (const el of r.querySelectorAll("iframe")) {
            const doc = sameOriginFrameDoc(el as Element);
            if (doc) { same++; visit(doc); } else cross++;
        }
    };
    visit(root);
    return { same, cross };
};

/** The HOST selectors of UNREACHABLE closed-root Web Components — the ones a selector scan can't enter EVEN
 *  with piercing on (a captured closed root is reachable, so it's excluded here). A scanning tool appends
 *  these so the model knows a target it can't find may be sealed inside one (and can fall back to visual
 *  `locate`/@pt scoped to the host). Uses the same heuristic as shadowRootStats.closed. */
export const closedShadowHosts = (root: ParentNode = document, limit = 8): string[] => {
    const hosts: string[] = [];
    const visit = (r: ParentNode): void => {
        for (const el of r.querySelectorAll("*")) {
            const e = el as Element;
            if (e.shadowRoot) { visit(e.shadowRoot); continue; }
            const captured = capturedClosedRoot(e);
            if (captured) { visit(captured); continue; }   // pierced → reachable, don't nag; recurse for nested sealed ones
            if (e.tagName.includes("-") && !e.children.length && hosts.length < limit) hosts.push(clickSelector(e));
        }
    };
    visit(root);
    return hosts;
};

/** A shadow-root host for the `ml.shadowRoots()` diagnostic: WHERE a shadow root is + whether the tools can
 *  enter it. `open` = a normal open root (reachable); `pierced` = a closed root the load-time attachShadow
 *  capture grabbed (reachable when piercing is on); `sealed` = a SEALED closed root that PAINTS content we
 *  can't enter (reach it visually with locate/@pt); `empty` = a hyphenated element with no light content that
 *  renders nothing right now — probably just an empty slot/outlet (a router-outlet, an unopened menu), NOT a
 *  barrier. The sealed/empty split is what the raw "N closed roots" count conflates. */
export interface ShadowHost { selector: string; tag: string; state: "open" | "pierced" | "sealed" | "empty"; }
/** List every shadow-root host in the page (recursing through reachable roots + same-origin frames), so a
 *  user can SEE where the "N closed shadow roots" pageInfo counts actually are — and, crucially, tell a real
 *  SEALED root (content we can't reach) from a host that's just EMPTY right now. The raw count is a heuristic
 *  (hyphenated tag + no light children) that can't distinguish the two; here a rendered box > 0 promotes it to
 *  `sealed`, else `empty`. Returns host SELECTORS so you can inspect/locate them. Read-only; capped at `limit`. */
export const shadowHostReport = (root: ParentNode = document, limit = 500): { open: number; pierced: number; sealed: number; empty: number; hosts: ShadowHost[] } => {
    let open = 0, pierced = 0, sealed = 0, empty = 0;
    const hosts: ShadowHost[] = [];
    const add = (e: Element, state: ShadowHost["state"]): void => { if (hosts.length < limit) hosts.push({ selector: clickSelector(e), tag: e.tagName.toLowerCase(), state }); };
    const visit = (r: ParentNode): void => {
        for (const el of r.querySelectorAll("*")) {
            const e = el as Element;
            if (e.shadowRoot) { open++; add(e, "open"); visit(e.shadowRoot); continue; }
            const captured = capturedClosedRoot(e);
            if (captured) { pierced++; add(e, "pierced"); visit(captured); continue; }
            // Hyphenated custom element with NO light content — its content, if any, is behind a boundary a
            // selector can't enter. Split it honestly: does it actually PAINT a box (a real sealed root / CSS
            // content) or render nothing (an empty emulated host — an unopened menu/popover, an outlet)?
            if (e.tagName.includes("-") && !e.children.length && !(e.textContent || "").trim()) {
                if (isSealedHost(e)) { sealed++; add(e, "sealed"); }   // renders content we can't reach
                else { empty++; add(e, "empty"); }                     // nothing there now — not a barrier
                continue;
            }
            const doc = sameOriginFrameDoc(e);
            if (doc) visit(doc);
        }
    };
    visit(root);
    return { open, pierced, sealed, empty, hosts };
};

/** Text/positional filters peeled from a selector step. `texts` = ALL must be a visible-text substring
 *  (case-insensitive); `eqIndex` = jQuery `:eq(n)` positional pick; `deepest` = `text=` leaf narrowing. */
interface Hop { css: string; texts: string[]; eqIndex: number | null; deepest: boolean; }

/** Apply a step's peeled pseudos to its raw CSS matches: text substring filter, then `text=`-only deepest
 *  narrowing (drop matching ancestors so a click lands on the leaf), then a positional `:eq(n)` pick. */
const applyHopFilters = (els: Element[], hop: Hop): Element[] => {
    let out = els;
    if (hop.texts.length) {
        const wanted = hop.texts.map(normalizeText);
        out = out.filter(el => { const tc = normalizeText(el.textContent); return wanted.every(w => tc.includes(w)); });
    }
    if (hop.deepest && out.length > 1) out = out.filter(el => !out.some(o => o !== el && el.contains(o)));
    if (hop.eqIndex !== null) return out[hop.eqIndex] ? [out[hop.eqIndex]] : [];
    return out;
};

// Does a hop use an EXTENDED pseudo (:contains/:has-text/:eq) or the `text=` engine? Only those route
// through the combinator-aware evaluator; a plain-CSS hop stays on the fast native path (deepQueryAll /
// querySelectorAll), so common selectors are byte-for-byte unchanged and keep full shadow crossing.
const EXT_PSEUDO = /:(?:contains|has-text|eq)\(/i;
const hasExtPseudo = (seg: string): boolean => EXT_PSEUDO.test(seg) || /^\s*(?:text|role|label)=/i.test(seg);

/** Pull EVERY `:contains(...)`/`:has-text(...)`/`:eq(n)` out of ONE simple selector (a compound with no
 *  combinators — those are split out first) from ANYWHERE in it, leaving native CSS. Respects quotes +
 *  nested parens so `:contains("a (b)")` / a native `:nth-child(2n)` aren't mis-cut. */
const extractStepPseudos = (simple: string): { css: string; texts: string[]; eqIndex: number | null } => {
    const texts: string[] = [];
    let eqIndex: number | null = null, css = "", i = 0;
    while (i < simple.length) {
        const mm = /^:(contains|has-text|eq)\(/i.exec(simple.slice(i));
        if (mm) {
            const open = i + mm[0].length - 1;   // index of the "("
            let depth = 0, j = open, quote = "";
            for (; j < simple.length; j++) {
                const c = simple[j];
                if (quote) { if (c === quote) quote = ""; continue; }
                if (c === '"' || c === "'") { quote = c; continue; }
                if (c === "(") depth++;
                else if (c === ")" && --depth === 0) break;
            }
            const inner = simple.slice(open + 1, j).trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
            if (mm[1].toLowerCase() === "eq") { const n = parseInt(inner, 10); if (!Number.isNaN(n) && eqIndex === null) eqIndex = n; }
            else texts.push(inner);
            i = j + 1;
            continue;
        }
        css += simple[i++];
    }
    return { css: css.trim() || "*", texts, eqIndex };
};

/** Split a hop into combinator-joined STEPS: [{ combinator, simple }] — combinator is " "|">"|"+"|"~"
 *  (the first step's is ignored). Respects quotes / () / [] so a combinator INSIDE `:contains("a > b")`
 *  or `[data-x="a b"]` never splits the compound. */
const splitSteps = (hop: string): { combinator: string; simple: string }[] => {
    const steps: { combinator: string; simple: string }[] = [];
    let cur = "", nextComb = " ", started = false, gap = false, dP = 0, dB = 0, quote = "";
    const flush = () => { const s = cur.trim(); cur = ""; if (!s) return; steps.push({ combinator: started ? nextComb : " ", simple: s }); started = true; nextComb = " "; gap = false; };
    for (const c of hop) {
        if (quote) { cur += c; if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if (c === "(") { dP++; cur += c; continue; }
        if (c === ")") { dP--; cur += c; continue; }
        if (c === "[") { dB++; cur += c; continue; }
        if (c === "]") { dB--; cur += c; continue; }
        if (dP || dB) { cur += c; continue; }
        if (c === " " || c === "\t" || c === "\n") { if (cur.trim()) gap = true; continue; }
        if (c === ">" || c === "+" || c === "~") { flush(); nextComb = c; gap = false; continue; }
        if (gap) { flush(); nextComb = " "; gap = false; }   // whitespace was a descendant combinator
        cur += c;
    }
    flush();
    return steps;
};

/** Evaluate ONE extended hop (has :contains/:eq/text=) within `scopes`, COMBINATOR-AWARE: resolve each
 *  step's native CSS by its combinator (descendant/`>`/`+`/`~`) against the previous step's matches, then
 *  filter that step by its own text/eq. So `div:contains("foo") span:contains("bar")` = spans-with-bar
 *  inside divs-with-foo. The FIRST step searches with deepQueryAll (single hop → crosses OPEN shadow
 *  roots) or scoped querySelectorAll (multi-hop). Invalid CSS THROWS (the tool reports it) — never a
 *  silent [], which is what let a model confabulate a cause when `:contains`+`>>>` quietly failed. */
// Strip one layer of matching surrounding quotes from an engine argument (`"Foo"` → `Foo`).
const unquote = (s: string): string => s.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");

// ARIA boolean state for `role=…[checked]` / `[disabled]` / `[selected]` / `[expanded]` / `[pressed]`:
// presence (`[checked]`) or `[checked=true|false]`. Reads aria-* first, then the native property/attribute.
const ariaBool = (el: Element, key: string, val: string): boolean => {
    const want = val === "" || /^true$/i.test(val);
    const aria = el.getAttribute(`aria-${key}`);
    let actual: boolean;
    if (aria != null) actual = /^true$/i.test(aria);
    else if (key === "checked") actual = !!(el as HTMLInputElement).checked;
    else if (key === "disabled") actual = !!(el as HTMLInputElement).disabled || el.hasAttribute("disabled");
    else if (key === "selected") actual = !!(el as HTMLOptionElement).selected;
    else actual = el.hasAttribute(key);
    return actual === want;
};
// Heading level for `role=heading[level=N]` — <h1..6> or an explicit aria-level.
const headingLevel = (el: Element): number | null => {
    const m = /^h([1-6])$/i.exec(el.tagName);
    if (m) return parseInt(m[1], 10);
    const al = el.getAttribute("aria-level");
    return al ? parseInt(al, 10) : null;
};

// Implicit ARIA roles roleOf() leaves as the raw tag (it targets interactives) — heading, landmarks,
// lists. Combined with roleOf (button/link/textbox/checkbox/…) this covers what `role=` is asked for.
const IMPLICIT_ROLE: Record<string, string> = {
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    nav: "navigation", main: "main", aside: "complementary", header: "banner", footer: "contentinfo",
    ul: "list", ol: "list", li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader",
    article: "article", dialog: "dialog", form: "form", img: "img",
};
const roleMatches = (el: Element, role: string): boolean => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase() === role;
    return roleOf(el) === role || IMPLICIT_ROLE[el.tagName.toLowerCase()] === role;
};

/** Playwright `role=button[name="Save"][checked]` / `role=heading[level=1]` — match by ARIA role (explicit,
 *  roleOf, or implicit-tag), optional accessible-NAME substring (case-insensitive), heading level, and
 *  boolean states. Stable when class names are auto-generated; works for `<div role="button">` widgets. */
const matchRole = (pool: Element[], arg: string): Element[] => {
    const head = /^\s*([a-z-]+)([\s\S]*)$/i.exec(arg);
    if (!head) return [];
    const role = head[1].toLowerCase();
    const filters = [...head[2].matchAll(/\[\s*([a-z-]+)\s*(?:=\s*(['"]?)([\s\S]*?)\2\s*)?\]/gi)];
    return pool.filter(el => {
        if (!roleMatches(el, role)) return false;
        for (const f of filters) {
            const key = f[1].toLowerCase(), val = f[3] ?? "";
            if (key === "name") { if (!normalizeText(accessibleName(el)).includes(normalizeText(unquote(val)))) return false; }
            else if (key === "level") { if (headingLevel(el) !== parseInt(val, 10)) return false; }
            else if (!ariaBool(el, key, val)) return false;
        }
        return true;
    });
};

// Elements that carry a label (form controls + their ARIA equivalents) — the `label=` engine's candidates.
const LABELABLE = 'input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"], ' +
    '[role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="spinbutton"], [role="slider"], [role="searchbox"]';
/** Playwright `label="Username"` — a form control whose ACCESSIBLE NAME (accessibleName already resolves a
 *  `<label for>`, a wrapping `<label>`, and aria-label) contains the text (case-insensitive). */
const matchLabel = (pool: Element[], text: string): Element[] => {
    const want = normalizeText(text);
    return pool.filter(el => { try { return el.matches(LABELABLE) && normalizeText(accessibleName(el)).includes(want); } catch { return false; } });
};

const evalExtHop = (seg: string, scopes: ParentNode[], deepFirst: boolean): Element[] => {
    // Whole-hop ENGINE prefixes (Playwright-style): text= / role= / label=. Each scans every element in
    // scope (piercing shadow/iframe on the first hop) and filters by its own predicate.
    const eng = /^\s*(text|role|label)=([\s\S]+)$/i.exec(seg);
    if (eng) {
        const kind = eng[1].toLowerCase(), arg = eng[2];
        const pool: Element[] = [];
        for (const sc of scopes) pool.push(...(deepFirst && sc === document ? deepQueryAll("*") : Array.from(sc.querySelectorAll("*"))));
        const uniq = Array.from(new Set(pool));
        if (kind === "text") return applyHopFilters(uniq, { css: "*", texts: [unquote(arg)], eqIndex: null, deepest: true });
        if (kind === "role") return matchRole(uniq, arg);
        return matchLabel(uniq, unquote(arg));
    }
    const steps = splitSteps(seg);
    let current: Element[] = [];
    for (let s = 0; s < steps.length; s++) {
        const { css, texts, eqIndex } = extractStepPseudos(steps[s].simple);
        let matched: Element[] = [];
        if (s === 0) {
            for (const sc of scopes) {
                if (deepFirst && sc === document) { document.querySelectorAll(css); matched.push(...deepQueryAll(css)); }   // validate (deepQueryAll swallows throws) then merge shadow
                else matched.push(...Array.from(sc.querySelectorAll(css)));
            }
        } else {
            const comb = steps[s].combinator;
            for (const p of current) {
                if (comb === ">") { for (const ch of Array.from(p.children)) if (ch.matches(css)) matched.push(ch); }
                else if (comb === "+") { const n = p.nextElementSibling; if (n && n.matches(css)) matched.push(n); }
                else if (comb === "~") { for (let n = p.nextElementSibling; n; n = n.nextElementSibling) if (n.matches(css)) matched.push(n); }
                else matched.push(...Array.from(p.querySelectorAll(css)));   // descendant
            }
        }
        current = applyHopFilters(Array.from(new Set(matched)), { css, texts, eqIndex, deepest: false });
        if (!current.length) return [];
    }
    return current;
};

export const queryAll = (selector: string): Element[] => {
    // Parse into `>>>` HOPS first, so each hop's pseudos are evaluated in that hop's own scope.
    const segs = String(selector).trim().split(">>>").map(s => s.trim()).filter(Boolean);
    if (!segs.length) return [];
    // MULTI-HOP (`>>>`): explicit boundary crossing. Resolve each hop in its current scope(s), then descend
    // into each match's OPEN shadow root / same-origin iframe document for the next hop.
    if (segs.length > 1) {
        let scopes: ParentNode[] = [document];
        for (let i = 0; i < segs.length; i++) {
            let matched: Element[];
            if (hasExtPseudo(segs[i])) matched = evalExtHop(segs[i], scopes, false);
            else { const raw: Element[] = []; for (const sc of scopes) { try { raw.push(...sc.querySelectorAll(segs[i])); } catch { /* skip a bad segment */ } } matched = raw; }
            if (i === segs.length - 1) return matched;
            // Descend into each match's OPEN shadow root / same-origin iframe for the next hop. If a host has
            // NEITHER — a plain element, or a custom element using Angular-style EMULATED encapsulation (light
            // DOM with _nghost/_ngcontent attrs that only LOOKS like a web component) — fall back to the
            // element's own LIGHT subtree. So `a >>> b` means "b anywhere under a, crossing a real boundary if
            // there is one" — a strict superset of the old shadow-only behaviour, so a model that reaches for
            // `>>>` on emulated-encapsulation markup still finds the descendant instead of a silent [].
            scopes = matched.map(e => traversableRoot(e) ?? sameOriginFrameDoc(e) ?? (e as ParentNode));
            if (!scopes.length) return [];
        }
        return [];
    }
    // SINGLE HOP with an extended pseudo → the combinator-aware evaluator.
    if (hasExtPseudo(segs[0])) return evalExtHop(segs[0], [document], true);
    // SINGLE HOP, plain CSS → the fast native path (unchanged): merge light DOM + open shadow roots
    // (deepQueryAll, light matches first in document order), with a native `:nth-of-type/child(n)` fallback.
    const seg = segs[0];
    document.querySelectorAll(seg);   // validate — an INVALID selector must throw, not silently return 0
    const els = deepQueryAll(seg);
    if (els.length) return els;
    const m = seg.match(TRAILING_NTH_NATIVE);
    if (m) {
        const pool = deepQueryAll(m[1].trim() || "*");
        const i = parseInt(m[2], 10) - 1;   // CSS nth-* is 1-based
        return pool[i] ? [pool[i]] : [];
    }
    return els;
};

/**
 * Turn a querySelector failure into a useful message. The DOM tools (and `ml.queryAll`) understand the
 * extended pseudos `:contains`/`:has-text`/`:eq` ANYWHERE in a selector — so if the failed selector still
 * carries one, the caller almost certainly ran it through RAW `document.querySelector` (which doesn't),
 * and the fix is to route it through the tools instead. Otherwise the throw is a genuine CSS error (e.g.
 * an unescaped Tailwind `/` in a class) — surface it raw rather than misdiagnosing.
 *
 * @param {string} selector The selector that failed.
 * @param {Error} err The caught querySelector error.
 * @returns {string} A `Invalid selector: …` message to hand back to the model.
 */
export const selectorError = (selector: string, err: Error): string => {
    // Gate on the ERROR MESSAGE, not the selector: only when querySelector actually choked ON the pseudo
    // (a raw document.querySelector call — the tools use queryAll, which handles it) is the hint right.
    // A native CSS error elsewhere (an unescaped Tailwind `/`, a bad combinator) surfaces raw — the
    // pseudos are supported anywhere now, so they're never the cause when the message is about something else.
    if (/:has-text\s*\(|:contains\s*\(|:eq\s*\(/i.test(err.message)) {
        return "Invalid selector: the extended pseudos :contains()/:has-text()/:eq() are NOT native CSS, " +
            "so raw document.querySelector can't run them. Use `ml.queryAll(selector)` (or the DOM tools), " +
            'which understand them anywhere — e.g. `ml.queryAll(\'div:contains("x") button\')`.';
    }
    return `Invalid selector: ${err.message}`;
};

// ------------------------------------------------- right-click "ask about this" context container ---
// Resolve the semantic CONTENT container around a right-clicked leaf node — the whole tweet/comment/card
// around the avatar or timestamp you actually clicked — so "ask window.ml about this" sends the coherent
// unit, not a bare <span>. Deterministic (no model, <1ms): (1) a semantic/ARIA ancestor if there is one;
// else (2) a Readability-style text/link-density climb (real content is text-dense + low link-density);
// with (3) a feed-item short-circuit for div-soup feeds and (4) a geometry cap so it never returns the
// whole-page/column wrapper. Pure; the density + feed + semantic paths are unit-tested (jsdom's
// getBoundingClientRect is 0, so the geometry cap simply no-ops there — it's a defensive browser guard).
// Deliberately EXCLUDES <main>/[role="main"] — that's the PAGE wrapper, not the localized unit a
// right-click wants (a centered content column may not even trip the geometry cap). A too-coarse
// <section>/[role="region"] is still caught by spansViewport below.
const CONTAINER_SEL = 'article, [role="article"], [role="listitem"], [role="comment"], [role="region"], ' +
    'section, blockquote, figure';

/** Does `el` cover ~the whole viewport (a page/column wrapper, not a content unit)? 0-rects (jsdom) → false. */
const spansViewport = (el: Element): boolean => {
    try {
        const r = el.getBoundingClientRect();
        const w = typeof window !== "undefined" ? window.innerWidth : 0;
        const h = typeof window !== "undefined" ? window.innerHeight : 0;
        return !!w && !!h && r.width >= w * 0.9 && r.height >= h * 0.9;
    } catch { return false; }
};

/** Readability-style content score: reward text volume + sentence punctuation, penalise link density
 *  (navbars/footers are link-dense). -Infinity for a too-small or link-dominated block (never a content unit). */
const contentScore = (el: Element): number => {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    const textLen = text.length;
    if (textLen < 25) return -Infinity;
    let linkLen = 0;
    try { for (const a of el.querySelectorAll("a")) linkLen += (a.textContent || "").length; } catch { /* ignore */ }
    const linkDensity = linkLen / textLen;
    if (linkDensity > 0.5) return -Infinity;
    const punct = (text.match(/[,.!?;:]/g) || []).length * 10;
    return (textLen - linkLen) * (1 - linkDensity) + punct;
};

/** Is `el` ONE item in a repeating feed? (div-soup feeds: ≥3 structurally-similar siblings with real text.) */
const isFeedItem = (el: Element): boolean => {
    const p = el.parentElement;
    if (!p) return false;
    const sibs = [...p.children].filter(c => c.tagName === el.tagName);
    return sibs.length >= 3 && (el.textContent || "").replace(/\s+/g, " ").trim().length >= 25;
};

/** Is `el` a PAGE-LEVEL region (holds MULTIPLE content units / section headings), not a single content
 *  unit? The signal we've climbed TOO FAR: a tweet/comment/card holds one coherent thing; a page column
 *  or a whole feed holds many. This catches the narrow-but-tall <main> that a purely GEOMETRIC cap misses
 *  (a centered 760px column never hits width ≥90% of the viewport). Cheap: two shallow querySelectorAll. */
const isPageLevel = (el: Element): boolean => {
    try {
        return el.querySelectorAll('article, section, [role="article"], [role="listitem"]').length >= 2
            || el.querySelectorAll("h1, h2, h3").length >= 2;
    } catch { return false; }
};

/** Resolve the semantic content container for a right-clicked node. @see the section comment. */
export const resolveContextContainer = (target: Element): Element => {
    // (1) Nearest semantic/ARIA container — unless it's the whole viewport or a page-level region (a
    // <section> wrapping a whole feed, say) rather than a single content unit.
    const semantic = target.closest(CONTAINER_SEL);
    if (semantic && !spansViewport(semantic) && !isPageLevel(semantic)) return semantic;
    // (2) Climb, scoring by content density; short-circuit on a feed ITEM; stop at the page wrapper (by
    // geometry OR because it holds multiple units — the fix for a link click climbing all the way to <main>).
    let current: Element | null = target.parentElement;
    let best: Element = target, bestScore = -Infinity;
    while (current && current !== document.body && current !== document.documentElement) {
        if (spansViewport(current) || isPageLevel(current)) break;   // (4) geometry / page-level cap
        if (isFeedItem(current)) return current;   // (3) a repeating-feed item is the unit
        const score = contentScore(current);
        if (score > bestScore) { bestScore = score; best = current; }
        current = current.parentElement;
    }
    return best;
};

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE"]);
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "ARTICLE",
    "SECTION", "HEADER", "FOOTER", "BR", "TR", "UL", "OL", "PRE", "FIGCAPTION"]);

/** Visible text with block boundaries preserved as newlines (jsdom lacks innerText). Skips script/style/svg. */
const blockText = (el: Element): string => {
    let out = "";
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3) out += node.textContent || "";                 // text node
        else if (node.nodeType === 1) {
            const e = node as Element;
            if (SKIP_TAGS.has(e.tagName)) continue;
            out += blockText(e);
            if (BLOCK_TAGS.has(e.tagName)) out += "\n";
        }
    }
    return out;
};

/** Extract a resolved container into a clean {@link ElementContext}. Pure. */
export const domToContext = (container: Element, anchor?: Element | null, maxText = 2000): ElementContext => {
    const raw = blockText(container).replace(/[ \t]+/g, " ").replace(/\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const text = raw.length > maxText ? raw.slice(0, maxText) + `\n… [+${raw.length - maxText} chars]` : raw;
    const media: { src: string; alt: string }[] = [];
    try {
        for (const m of container.querySelectorAll("img[src], video[src], video source[src]")) {
            const src = m.getAttribute("src") || "";
            if (src && !src.startsWith("data:")) media.push({ src, alt: m.getAttribute("alt") || "" });
            if (media.length >= 12) break;
        }
    } catch { /* ignore */ }
    const links: { text: string; href: string }[] = [];
    const seen = new Set<string>();
    try {
        for (const a of container.querySelectorAll("a[href]")) {
            const href = a.getAttribute("href") || "";
            const t = (a.textContent || "").replace(/\s+/g, " ").trim();
            if (!href || href.startsWith("javascript:") || seen.has(href)) continue;
            seen.add(href); links.push({ text: t, href });
            if (links.length >= 20) break;
        }
    } catch { /* ignore */ }
    return {
        selector: clickSelector(container),
        role: roleOf(container),
        text,
        anchorText: anchor ? (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) || undefined : undefined,
        media, links,
    };
};

/** A page table → a structured `{ columns, rows }` for a pandas DataFrame, or `null` when the
 *  element isn't a clean table (no recognizable table/ARIA-grid, or it uses col/rowspans — the
 *  caller then falls back to pandas.read_html on its outerHTML). Case-preserving (unlike
 *  normalizeText): cell VALUES must survive verbatim for the df. Rows/cols capped so a wrong
 *  selector can't extract a runaway grid. Native `<table>` and ARIA `role=table/grid/treegrid`. */
const MAX_TABLE_ROWS = 5000, MAX_TABLE_COLS = 200;

/** Page `<table>`s that actually hold data — at least one `<td>` (a data cell), so a collapsed /
 *  header-only / lazily-rendered table (e.g. the empty `#bigsales`) is excluded. Shared by the
 *  python_exec `current` shorthand (which resolves to the SINGLE non-empty table when the page isn't
 *  a Google Sheet) and the tool description (which only advertises `current` when there's exactly one,
 *  or the page is a Sheet). Pure over the given root. */
export const nonEmptyTables = (root: Document | Element): HTMLTableElement[] =>
    (root && typeof root.querySelectorAll === "function")
        ? [...root.querySelectorAll("table")].filter(t => t.querySelector("td")) as HTMLTableElement[]
        : [];

/** Classify a candidate fixed/sticky element for the full-page stitch, from its viewport rect at
 *  two scroll positions. PINNED = the rect's top is invariant to scroll — a `position:fixed`
 *  element, or a `position:sticky` one that's currently STUCK — so it repeats in every captured
 *  tile and must be shown exactly ONCE. (A sticky element still flowing with content moves between
 *  the two probes, so it's NOT pinned and is left alone — it legitimately appears in one tile.)
 *  ANCHOR = which end of the stitch it belongs at (a top header vs a bottom footer), by its
 *  vertical centre. Pure (no DOM) so it's unit-testable; the rect-measuring + scroll probing +
 *  visibility toggling stay in injected.ts's browser-only `_stitchFullPage`. */
export function classifyOverlay(
    r0: { top: number; height: number },
    r1: { top: number },
    vh: number,
): { pinned: boolean; anchor: "top" | "bottom" } {
    return {
        pinned: Math.abs(r1.top - r0.top) < 2,                       // top unchanged across a scroll ⇒ pinned
        anchor: r0.top + r0.height / 2 < vh / 2 ? "top" : "bottom",  // centre in the top half ⇒ header, else footer
    };
}

const cellText = (c: Element): string => (c.textContent || "").replace(/\s+/g, " ").trim();
const hasSpans = (t: Element): boolean =>
    [...t.querySelectorAll("td,th,[role='cell'],[role='gridcell'],[role='columnheader']")]
        .some(c => parseInt(c.getAttribute("colspan") || "1", 10) > 1 || parseInt(c.getAttribute("rowspan") || "1", 10) > 1);

export function extractTable(el: Element): { columns: string[]; rows: string[][] } | null {
    const GRID = '[role="table"],[role="grid"],[role="treegrid"]';
    const table = el.matches("table") ? el
        : el.matches(GRID) ? el
        : el.querySelector("table") || el.querySelector(GRID);
    if (!table) return null;
    if (hasSpans(table)) return null;   // col/rowspans misalign a flat walk → let read_html handle it

    const cap = (rows: string[][]): { columns: string[]; rows: string[][] } | null => {
        if (!rows.length) return null;
        return { columns: [], rows: rows.slice(0, MAX_TABLE_ROWS).map(r => r.slice(0, MAX_TABLE_COLS)) };
    };

    if (table.matches("table")) {
        const trs = [...table.querySelectorAll("tr")];
        if (!trs.length) return null;
        let headerRow = table.querySelector("thead tr");
        let bodyRows = [...table.querySelectorAll("tbody tr")];
        if (!headerRow && trs[0].querySelector("th")) { headerRow = trs[0]; bodyRows = trs.slice(1); }
        if (!bodyRows.length) bodyRows = headerRow ? trs.filter(t => t !== headerRow) : trs;
        const out = cap(bodyRows.map(tr => [...tr.querySelectorAll("th,td")].map(cellText)));
        if (!out) return null;
        if (headerRow) out.columns = [...headerRow.querySelectorAll("th,td")].map(cellText).slice(0, MAX_TABLE_COLS);
        return out;
    }

    // ARIA grid: role=row holds columnheader / cell / gridcell.
    const rowEls = [...table.querySelectorAll('[role="row"]')];
    if (!rowEls.length) return null;
    const heads = (r: Element) => [...r.querySelectorAll('[role="columnheader"]')];
    const cells = (r: Element) => [...r.querySelectorAll('[role="cell"],[role="gridcell"]')];
    const hdr = rowEls.find(r => heads(r).length);
    const bodyEls = hdr ? rowEls.filter(r => r !== hdr) : rowEls;
    const out = cap(bodyEls.map(r => { const c = cells(r); return (c.length ? c : [...r.children]).map(cellText); }));
    if (!out) return null;
    if (hdr) out.columns = heads(hdr).map(cellText).slice(0, MAX_TABLE_COLS);
    return out;
}

/** Parse a table cell as a number, tolerating corporate formatting — thousands commas,
 *  currency ($€£¥), a trailing %, whitespace, and accounting parens ((150) → -150). Returns
 *  null when it isn't a clean int/decimal (names, alphanumeric IDs, blanks). Pure. */
export function parseNumericCell(v: string): number | null {
    let s = String(v == null ? "" : v).trim();
    if (!s) return null;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) s = "-" + paren[1];
    s = s.replace(/[,$€£¥%\s]/g, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;   // int/decimal only — no "1e3"/"421A"/leading-word
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Auto-cast the NUMERIC columns of an extracted table so pandas infers int64/float64 (else
 *  every cell is a string and df.sum() string-CONCATENATES). Per column: if ≥90% of non-empty
 *  cells parse as numbers, coerce the whole column to number|null (blank/stray → null, pandas
 *  NaN); otherwise leave it as strings (names, and IDs/ZIPs where a leading zero would drop —
 *  pass tableRaw to skip casting for those). Returns a NEW rows array. Pure. */
export function castTableColumns(columns: string[], rows: string[][]): (string | number | null)[][] {
    const width = Math.max(columns.length, ...rows.map(r => r.length), 0);
    const out: (string | number | null)[][] = rows.map(r => r.slice());
    for (let c = 0; c < width; c++) {
        let nonEmpty = 0, numeric = 0;
        for (const r of rows) {
            const s = r[c] == null ? "" : String(r[c]).trim();
            if (!s) continue;
            nonEmpty++;
            if (parseNumericCell(s) != null) numeric++;
        }
        if (nonEmpty === 0 || numeric / nonEmpty < 0.9) continue;   // not a numeric column
        for (const r of out) {
            const s = r[c] == null ? "" : String(r[c]).trim();
            r[c] = s ? parseNumericCell(s) : null;   // non-numeric outlier → null (pandas NaN)
        }
    }
    return out;
}

/** A Google Sheets URL → its spreadsheet id (the stable `/d/<id>` key), or null if it isn't a
 *  Sheets URL. Used to cache a per-session access approval by the SPREADSHEET (its tabs share it). */
export const googleSheetId = (url: string): string | null => {
    const m = /^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(String(url || ""));
    return m ? m[1] : null;
};

/** Every EXTERNAL Google Sheet (a Sheets URL that isn't 'current') a python_exec call touches —
 *  whether its `tables` arg is a single source string OR a map of them — as spreadsheet ids. Reading
 *  arbitrary Google data the user didn't navigate to is privileged, so these drive the approval
 *  escalation + the auto-approve decision. Pure; shared by the page loop and the (design-A) background
 *  auto-approve so both agree on "which sheets need consent". */
export const externalSheetIds = (args: unknown): string[] => {
    const t = (args as { tables?: unknown } | null)?.tables;
    const vals: unknown[] = typeof t === "string" ? [t] : (t && typeof t === "object") ? Object.values(t as Record<string, unknown>) : [];
    return vals
        .filter((v): v is string => typeof v === "string" && v !== "current")
        .map(v => googleSheetId(v))
        .filter((id): id is string => !!id);
};

/** A Google Sheets URL → its CSV export URL (fetched credentialed → the user's own data),
 *  or null if it isn't a Sheets URL. Pulls the spreadsheet id + the gid (the specific tab,
 *  default 0). Pure — the CSV then flows through the same parse→auto-cast→df path as `table`. */
export const googleSheetCsvUrl = (url: string): string | null => {
    const id = googleSheetId(url);
    if (!id) return null;
    const gid = /[#?&]gid=([0-9]+)/.exec(url);
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid ? gid[1] : "0"}`;
};

/** Parse RFC-4180 CSV → an array of rows (each an array of string cells). Handles quoted
 *  fields with embedded commas, newlines, and doubled "" quotes. Pure. */
export function parseCsv(text: string): string[][] {
    const s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const rows: string[][] = []; let row: string[] = [], field = "", inQ = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQ) {
            if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/** Does the head of a body look like CSV? ≥2 non-empty lines that each split on commas into the SAME
 *  number of columns (≥2). A light heuristic for when the Content-Type is generic (text/plain). */
function looksCsv(head: string): boolean {
    const lines = head.split(/\r?\n/).filter(l => l.trim()).slice(0, 6);
    if (lines.length < 2) return false;
    const cols = lines.map(l => l.split(",").length);
    return cols[0] >= 2 && cols.every(c => c === cols[0]);
}

export type ContentKind = "json" | "csv" | "html" | "xml" | "markdown" | "code" | "text";

/** Classify by the Content-Type HEADER alone. Returns null for a GENERIC/absent header (text/plain,
 *  octet-stream, empty) — the signal to let the other cues decide (a server can mislabel: raw.github
 *  serves .json/.csv/.ts as text/plain). A declared-but-other text/* is "text". Pure. */
export function typeFromHeader(contentType: string): ContentKind | null {
    const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (ct === "application/json" || ct.endsWith("+json")) return "json";
    if (ct === "text/csv" || ct === "application/csv") return "csv";
    if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
    if (ct === "text/xml" || ct === "application/xml" || ct.endsWith("+xml")) return "xml";
    if (ct === "text/markdown") return "markdown";
    if (ct === "application/javascript" || ct === "text/javascript" || ct === "application/typescript") return "code";
    if (ct === "" || ct === "text/plain" || ct === "application/octet-stream") return null;   // generic → other cues decide
    return "text";
}

/** Classify by the body CONTENT alone (a light STRUCTURAL sniff — json/html/xml/csv). Returns "text" when it
 *  finds no structure (prose OR code — the extension then distinguishes those). Pure. */
export function typeFromContent(body: string): ContentKind {
    const head = String(body || "").slice(0, 2048).replace(/^﻿/, "").trimStart();
    if (/^<\?xml[\s>]/i.test(head)) return "xml";
    if (/^<(?:!doctype\s+html|html[\s>])/i.test(head)) return "html";
    if (head.startsWith("{") || head.startsWith("[")) { try { JSON.parse(body); return "json"; } catch { /* not JSON after all */ } }
    if (looksCsv(head)) return "csv";
    return "text";
}

// URL path extension → its kind + (for source) a language label. The strong cue for code files a server
// serves as text/plain (a raw .ts is TypeScript, not "raw text").
const EXT_LANG: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", sh: "shell", bash: "shell", zsh: "shell", pl: "perl", lua: "lua",
    r: "r", scala: "scala", dart: "dart", ex: "elixir", clj: "clojure", sql: "sql",
    css: "css", scss: "css", less: "css", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
};
const EXT_KIND: Record<string, ContentKind> = {
    json: "json", jsonl: "json", ndjson: "json",
    csv: "csv", tsv: "csv",
    html: "html", htm: "html", xhtml: "html",
    xml: "xml", svg: "xml", rss: "xml", atom: "xml",
    md: "markdown", markdown: "markdown", mdx: "markdown",
    txt: "text", text: "text", log: "text",
};
/** Classify by the URL's file EXTENSION (path only — query/hash stripped). Returns the kind + a `language`
 *  for source files, or null when the URL has no telling extension (an API endpoint, a bare path). Pure. */
export function typeFromExtension(url: string): { type: ContentKind; language?: string } | null {
    let path = String(url || "");
    try { path = new URL(url).pathname; } catch { path = path.split(/[?#]/)[0]; }
    const m = /\.([A-Za-z0-9]+)$/.exec(path);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (ext in EXT_LANG) return { type: "code", language: EXT_LANG[ext] };
    if (ext in EXT_KIND) return { type: EXT_KIND[ext] };
    return null;
}

/** A compact, LLM-legible SHAPE of a parsed JSON value — a TypeScript-like type skeleton, NOT a JSONSchema
 *  object (models read TS types natively). Leaves become their type; an array collapses to `T[]` with an item
 *  count; object shapes are MERGED across a sample of an array's elements so varying/optional keys surface as
 *  `key?`, and differing leaf types union (`string | number`). Bounded by depth / keys / sample so even a huge
 *  payload reduces to a few lines — the schema a model needs to write code against a response WITHOUT seeing
 *  the whole thing. Pure + deterministic. e.g. `{ version: number, servers: { name: string, port?: number }[] }`. */
export function jsonShape(value: unknown, opts: { maxDepth?: number; maxKeys?: number; sample?: number } = {}): string {
    const maxDepth = opts.maxDepth ?? 6, maxKeys = opts.maxKeys ?? 40, sample = opts.sample ?? 25;
    const keyStr = (k: string): string => /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);

    const shape = (v: unknown, depth: number): string => {
        if (v === null) return "null";
        if (Array.isArray(v)) {
            const n = v.length;
            if (!n) return "unknown[]";
            if (depth >= maxDepth) return "unknown[]";
            const es = elemShape(v.slice(0, sample), depth + 1);
            // Parenthesise a top-level UNION element so `(number | string)[]` reads unambiguously (an object
            // shape `{ … }` is already delimited, so it doesn't need it).
            const el = es.includes(" | ") && !es.startsWith("{") ? `(${es})` : es;
            return `${el}[] /* ${n} item${n === 1 ? "" : "s"} */`;
        }
        if (typeof v === "object") return depth >= maxDepth ? "object" : objShape(v as Record<string, unknown>, depth);
        return typeof v;   // string / number / boolean / (undefined shouldn't occur in JSON)
    };

    // Merge array-element shapes: all-objects → union of keys (optional where absent); else union of leaf shapes.
    const elemShape = (elems: unknown[], depth: number): string => {
        const objs = elems.filter(e => e !== null && typeof e === "object" && !Array.isArray(e)) as Record<string, unknown>[];
        if (objs.length === elems.length && objs.length) {
            const present = new Map<string, number>(), shapes = new Map<string, Set<string>>();
            for (const e of objs) for (const k of Object.keys(e)) {
                present.set(k, (present.get(k) ?? 0) + 1);
                if (!shapes.has(k)) shapes.set(k, new Set());
                shapes.get(k)!.add(shape(e[k], depth + 1));
            }
            const keys = [...present.keys()].slice(0, maxKeys);
            const parts = keys.map(k => `${keyStr(k)}${present.get(k)! < objs.length ? "?" : ""}: ${[...shapes.get(k)!].join(" | ")}`);
            return `{ ${parts.join(", ")}${present.size > keys.length ? `, …+${present.size - keys.length}` : ""} }`;
        }
        return [...new Set(elems.map(e => shape(e, depth)))].join(" | ") || "unknown";
    };

    const objShape = (o: Record<string, unknown>, depth: number): string => {
        const all = Object.keys(o), keys = all.slice(0, maxKeys);
        const parts = keys.map(k => `${keyStr(k)}: ${shape(o[k], depth + 1)}`);
        return `{ ${parts.join(", ")}${all.length > keys.length ? `, …+${all.length - keys.length}` : ""} }`;
    };

    return shape(value, 0);
}

/** Resolve a fetched body's kind from THREE cues — header, content, and URL extension — and pick a final
 *  `type` (+ a `language` for code). Precedence: a SPECIFIC header wins; else STRUCTURED content (json/html/
 *  xml/csv, which is unambiguous); else the extension (catches code/markdown a server sent as text/plain);
 *  else plain text. Surfaces every cue so the agent sees a mislabel and can still chain. Pure — unit-tested. */
export function classifyContent(contentType: string, body: string, url = ""): {
    type: ContentKind; language?: string; byHeader: ContentKind | null; byContent: ContentKind; byExtension: { type: ContentKind; language?: string } | null;
} {
    const byHeader = typeFromHeader(contentType);
    const byContent = typeFromContent(body);
    const byExtension = typeFromExtension(url);
    const structured = byContent === "json" || byContent === "html" || byContent === "xml" || byContent === "csv";
    const type = byHeader ?? (structured ? byContent : (byExtension?.type ?? byContent));
    const language = type === "code" ? byExtension?.language : undefined;
    return { type, language, byHeader, byContent, byExtension };
}
