// Content-script shell for the debug sidebar. It hosts the app in an <iframe>
// that loads an extension page (sidebar.html) — a chrome-extension:// origin the
// host web page can't read across, so the app may safely hold secrets (unlike a
// shadow-root panel injected into the page DOM, which the page can walk into).
//
// This shell owns the slide-out container, tab, and resize handle, and relays the page's
// `__mlDebug` stream (from injected.js, main world) into the iframe AND up to the background
// (for the DevTools panel). Config `debugMode` picks the surface: `overlay` mounts this
// shell; `devtools` attaches the forwarder only (no overlay drawn) and — since there's no
// iframe app to hand back the `__mlSidebar:"ready"` handshake — posts `ready` itself so
// injected.js goes live; `off` attaches nothing. injected.js announces `hello` when it loads
// and we re-send the handshake on it, so a page-load race (our handshake landing before
// injected's async <script> is listening — which stranded the devtools panel on Ctrl+R)
// can't leave it un-live.
import { SB_ROOT, SB_HOST, SB_TAB, SB_FRAME, SB_LIGHTBOX, SB_LIGHTBOX_X, SB_HIGHLIGHT, SB_CARD } from "../ids";
import type { DebugMode } from "../contract";

const WIDTH_KEY = "ml_debug_width";
const MIN_W = 280, TAB_W = 34, DEFAULT_W = 400;

// The hover-highlight box + its label. Pulled out of SHELL_CSS so the devtools-mode
// highlight-only host (which mounts NO overlay) can reuse the exact same styling.
const HIGHLIGHT_CSS = `
/* DevTools-style hover highlight — a positioned box OVER a page element (never mutating it). Sits
   below the panel (z-index) and is pointer-events:none so it can't intercept clicks. */
#${SB_HIGHLIGHT} { position: fixed; z-index: 2147482999; pointer-events: none; box-sizing: border-box;
  background: rgba(89,131,246,.28); outline: 1px solid rgba(89,131,246,.95); border-radius: 1px; }
#${SB_HIGHLIGHT} .ml-hl-label { position: absolute; top: 100%; left: 0; margin-top: 2px; padding: 1px 6px;
  background: #5983f6; color: #fff; font: 500 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  border-radius: 3px; white-space: nowrap; max-width: 50vw; overflow: hidden; text-overflow: ellipsis; }
/* Approval variant: a pulsing GREEN spotlight (vs the blue hover box) so the element awaiting your
   approval is unmistakable on the page. */
#${SB_HIGHLIGHT}.ml-hl-approve { background: rgba(34, 197, 94, .22); outline: 2px solid rgba(34, 197, 94, .95);
  animation: ml-hl-pulse 1.3s ease-in-out infinite; }
#${SB_HIGHLIGHT}.ml-hl-approve .ml-hl-label { background: #16a34a; }
@keyframes ml-hl-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, .5); } 50% { box-shadow: 0 0 0 7px rgba(34, 197, 94, 0); } }
`;

// The off-mode approval CARD: a macOS-notification-style acrylic panel in the bottom-right corner,
// hosting the SAME sidebar.html iframe (so SET_APPROVAL stays unforgeable) but in the app's curated
// "card" surface. It's the ONLY thing off mode ever draws, and only while a background-hosted run has
// something to show. The iframe is transparent so the acrylic (a blurred translucent surface here in
// the shell's shadow root) shows through; the app draws its content over it. Three states drive the
// size/reveal, transitioned for a soft expand: hidden (gone) · toast (collapsed) · expanded.
const CARD_CSS = `
#${SB_CARD}-wrap {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  box-sizing: border-box; overflow: hidden; border-radius: 15px;
  background: rgba(250, 250, 252, .72);
  -webkit-backdrop-filter: blur(26px) saturate(180%); backdrop-filter: blur(26px) saturate(180%);
  border: 1px solid rgba(0, 0, 0, .10);
  box-shadow: 0 14px 46px rgba(0, 0, 0, .26), 0 3px 10px rgba(0, 0, 0, .14);
  transform-origin: bottom right;
  transition: width .30s cubic-bezier(.2,.8,.2,1), height .30s cubic-bezier(.2,.8,.2,1),
              opacity .22s ease, transform .30s cubic-bezier(.2,.8,.2,1);
}
/* The acrylic tracks the APP's resolved theme (set on the wrap by the shell from config.theme), NOT
   the OS — otherwise a user who forces Light while the OS is dark gets dark text on a dark acrylic. */
#${SB_CARD}-wrap[data-theme="dark"] { background: rgb(41 30 13 / 8%); border-color: rgba(255, 255, 255, .12);
  box-shadow: 0 14px 46px rgba(0, 0, 0, .5), 0 3px 10px rgba(0, 0, 0, .34); }
/* The HEIGHT is set in px by the shell (sizeCard): the app reports its content height (a cross-origin
   iframe can't auto-size), capped, or the user's dragged height. An explicit px means it animates. */
#${SB_CARD}-wrap { height: 84px; }
#${SB_CARD}-wrap[data-state="hidden"] { width: 340px; opacity: 0; pointer-events: none; transform: translateY(14px) scale(.96); }
#${SB_CARD}-wrap[data-state="toast"] { width: 340px; opacity: 1; transform: none; }
#${SB_CARD}-wrap[data-state="expanded"] { width: 384px; opacity: 1; transform: none; }
#${SB_CARD}-frame { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
/* Drag the top edge to resize the expanded card vertically (double-click → back to auto-fit). */
#${SB_CARD}-resize { position: absolute; top: 0; left: 0; right: 0; height: 9px; cursor: ns-resize; z-index: 3; }
#${SB_CARD}-resize::after { content: ""; position: absolute; top: 3px; left: 50%; transform: translateX(-50%);
  width: 34px; height: 3px; border-radius: 2px; background: currentColor; opacity: 0; transition: opacity .15s; color: var(--fg-faint, #888); }
#${SB_CARD}-resize:hover::after { opacity: .5; }
#${SB_CARD}-wrap[data-state="toast"] #${SB_CARD}-resize, #${SB_CARD}-wrap[data-state="hidden"] #${SB_CARD}-resize { display: none; }
@media (prefers-reduced-motion: reduce) { #${SB_CARD}-wrap { transition: opacity .12s ease; } }
`;

const SHELL_CSS = `
#${SB_HOST} { position: fixed; top: 0; right: 0; height: 100vh; display: flex;
  z-index: 2147483000; transform: translateX(calc(100% - ${TAB_W}px)); transition: transform .22s ease; }
#${SB_HOST}.open { transform: translateX(0); }
#${SB_TAB} { width: ${TAB_W}px; flex: 0 0 ${TAB_W}px; cursor: pointer; border: none;
  background: #4f46e5; color: #fff; writing-mode: vertical-rl; text-orientation: mixed;
  letter-spacing: .08em; font: 600 12px system-ui, sans-serif; padding: 10px 0;
  border-radius: 6px 0 0 6px; align-self: center; height: 150px; box-shadow: -2px 0 8px rgba(0,0,0,.35); }
#${SB_TAB}:hover { background: #6366f1; }
#ml-sb-body { position: relative; flex: 1; min-width: 0; height: 100%; box-shadow: -4px 0 20px rgba(0,0,0,.4); }
#ml-sb-resize { position: absolute; left: -3px; top: 0; width: 7px; height: 100%; cursor: ew-resize; z-index: 1; }
#ml-sb-resize:hover, #ml-sb-resize.drag { background: #6366f1; opacity: .5; }
#${SB_FRAME} { display: block; width: 100%; height: 100%; border: 0; }
/* Full-window image lightbox (a sibling of the panel, so no transformed
   ancestor — position:fixed maps to the whole viewport). */
#${SB_LIGHTBOX} { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.82);
  display: flex; align-items: center; justify-content: center; padding: 28px; cursor: zoom-out; }
#${SB_LIGHTBOX} img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 10px 50px rgba(0,0,0,.6); cursor: default; }
#${SB_LIGHTBOX_X} { position: fixed; top: 12px; right: 16px; width: 32px; height: 32px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,.35); background: rgba(0,0,0,.5); color: #fff; font: 16px system-ui; cursor: pointer; }
#${SB_LIGHTBOX_X}:hover { background: rgba(0,0,0,.85); }
${HIGHLIGHT_CSS}
/* Tooltip primitive — a copy of the app's (sidebar.css), because this shell lives in
   its own shadow root in the PAGE and shares no stylesheet with the iframe. Same rule
   applies: size and typography are pinned absolutely, never inherited — the tab is
   writing-mode: vertical-rl, which would otherwise render its tooltip sideways. */
.ml-tt { position: relative; }
.ml-tt-pop {
    position: absolute; z-index: 1; background: #1f2937; color: #f3f4f6;
    border: 1px solid rgba(255,255,255,.16); border-radius: 5px; padding: 4px 7px;
    box-shadow: 0 2px 8px rgba(0,0,0,.45); opacity: 0; pointer-events: none;
    transition: opacity .12s; white-space: nowrap;
    font: 400 11px/1.35 system-ui, -apple-system, sans-serif;
    writing-mode: horizontal-tb; text-orientation: mixed; letter-spacing: normal;
    text-transform: none; font-style: normal;
}
.ml-tt:hover .ml-tt-pop { opacity: 1; }
/* The tab sits at the panel's left edge, vertically centred — put its pop to the left. */
#${SB_TAB} .ml-tt-pop { right: calc(100% + 8px); top: 50%; transform: translateY(-50%); }
#ml-sb-resize .ml-tt-pop { right: calc(100% + 8px); top: 50%; transform: translateY(-50%); }
#${SB_LIGHTBOX_X} .ml-tt-pop { top: calc(100% + 6px); right: 0; }
`;

let shellHost: HTMLElement | null = null;   // shadow host in the page's light DOM
let shadowRoot: ShadowRoot | null = null;
let panel: HTMLElement | null = null;       // the sliding container, inside the shadow root
let frame: HTMLIFrameElement | null = null;
let lightbox: HTMLElement | null = null;

// --- off-mode approval card (see CARD_CSS) ---
let cardHost: HTMLElement | null = null;    // separate shadow host for the corner card
let cardWrap: HTMLElement | null = null;    // the acrylic container (its data-state drives size/reveal)
let cardReady = false;                       // the card iframe app has handshaked (safe to post events)
// Height: the card fits its CONTENT (a cross-origin iframe can't auto-size, so the app reports its
// height → cardAutoH), capped at 72vh, UNLESS the user dragged the top edge (cardManualH, persisted).
const CARD_H_KEY = "ml_card_height";
let cardAutoH = 200;
let cardManualH: number | null = null;
// Background-run events buffered while the card iframe loads (off mode feeds the card ONLY from the
// background stream, tagged __mlFromBg — the page's bus stays dormant — so no cross-source ordering).
const CARD_RING_MAX = 200;
const bgRing: MessageEvent["data"][] = [];

// Set the card's height in px: fixed for the toast, else the user's dragged height or the app-reported
// content height (capped). An explicit px value is what lets the CSS height transition animate.
function sizeCard(): void {
    if (!cardWrap) return;
    const state = cardWrap.dataset.state;
    if (state === "hidden") return;   // keep the current height while it fades out
    const cap = Math.round(window.innerHeight * 0.72);
    // Fit the reported content height (capped); the user's dragged height applies to the EXPANDED card only.
    const h = (state === "expanded" && cardManualH) ? cardManualH : Math.min(cardAutoH, cap);
    cardWrap.style.height = `${Math.max(56, h)}px`;
}
// Drag the top edge (the card is bottom-anchored, so dragging up grows it upward). Double-click resets
// to auto-fit. Persisted so the size sticks across runs.
function startCardResize(e: PointerEvent): void {
    if (!cardWrap) return;
    e.preventDefault();
    if (frame) frame.style.pointerEvents = "none";   // let the drag cross the iframe
    const bottom = cardWrap.getBoundingClientRect().bottom;
    const onMove = (ev: PointerEvent) => {
        cardManualH = Math.max(120, Math.min(Math.round(window.innerHeight * 0.92), Math.round(bottom - ev.clientY)));
        if (cardWrap) cardWrap.style.height = `${cardManualH}px`;
    };
    const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (frame) frame.style.pointerEvents = "";
        if (cardManualH) chrome.storage.local.set({ [CARD_H_KEY]: cardManualH });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}

/** A hover tooltip bubble for the shell's own chrome (see .ml-tt in SHELL_CSS). */
function tip(text: string): HTMLElement {
    const t = document.createElement("span");
    t.className = "ml-tt-pop";
    t.setAttribute("role", "tooltip");
    t.textContent = text;
    return t;
}

function hideLightbox(): void {
    lightbox?.remove(); lightbox = null;
    window.removeEventListener("keydown", onLightboxKey);
}
function onLightboxKey(e: KeyboardEvent): void { if (e.key === "Escape") hideLightbox(); }
// Full-window image lightbox (from the app's ClickableImg → __mlLightbox). Lives
// in the shell so it fills the whole browser, not the ~sidebar-width iframe.
function showLightbox(src: string): void {
    if (!shadowRoot) return;
    hideLightbox();
    lightbox = document.createElement("div");
    lightbox.id = SB_LIGHTBOX;
    lightbox.addEventListener("click", hideLightbox);   // click anywhere (incl. the image) closes
    const img = document.createElement("img");
    img.src = src;
    const x = document.createElement("button");
    x.id = SB_LIGHTBOX_X; x.textContent = "✕";
    x.setAttribute("aria-label", "Close (Esc)");   // icon-only: keep the accessible name
    x.classList.add("ml-tt");
    x.append(tip("Close (Esc)"));
    x.addEventListener("click", hideLightbox);
    lightbox.append(x, img);
    shadowRoot.append(lightbox);
    window.addEventListener("keydown", onLightboxKey);
}

// DevTools-style hover highlight: the app (over a rendered element reference) asks us to outline a
// page element. We draw a positioned box OVER it in our shadow root — never touching the element, so
// no page-DOM mutation, no layout thrash, no MutationObserver noise. The shell shares the page DOM (a
// content script), so it can resolve the selector + rect itself. Off-target / not-found → just hide.
let highlightEl: HTMLElement | null = null;
let hlSeq = 0;   // monotonic — a later hover/clear invalidates a still-pending async token resolve
// The root the highlight box is drawn into. In OVERLAY mode that's the full shell's shadow root.
// In DEVTOOLS mode no overlay is mounted, so lazily create a highlight-ONLY shadow host (same
// isolation, just the highlight CSS) the first time a remote highlight arrives — so the panel's
// hover can still outline the page. Torn down with everything else in teardown().
let hlHost: HTMLElement | null = null;
let hlRoot: ShadowRoot | null = null;
function hlContainer(): ShadowRoot {
    if (shadowRoot) return shadowRoot;
    if (hlRoot) return hlRoot;
    hlHost = document.createElement("div");
    hlHost.id = `${SB_ROOT}-hl`;
    hlHost.style.cssText = "all: initial;";
    hlRoot = hlHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = HIGHLIGHT_CSS;
    hlRoot.append(style);
    (document.documentElement || document.body).append(hlHost);
    return hlRoot;
}
let hlKind: "" | "approve" = "";   // "approve" → the pulsing-green variant + report the on-page position
// The 3×3 on-page position of a box centre ("top-left" / "bottom" / "centre"), told to the card so the
// approval can name where to look.
function posLabel(cx: number, cy: number): string {
    const W = window.innerWidth, H = window.innerHeight;
    const parts: string[] = [];
    if (cy < H / 3) parts.push("top"); else if (cy > H * 2 / 3) parts.push("bottom");
    if (cx < W / 3) parts.push("left"); else if (cx > W * 2 / 3) parts.push("right");
    return parts.length ? parts.join("-") : "centre";
}
function drawHighlight(left: number, top: number, width: number, height: number, label: string): void {
    const root = hlContainer();
    if (!highlightEl) { highlightEl = document.createElement("div"); highlightEl.id = SB_HIGHLIGHT; root.append(highlightEl); }
    highlightEl.className = hlKind === "approve" ? "ml-hl-approve" : "";
    Object.assign(highlightEl.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    const lab = document.createElement("div");
    lab.className = "ml-hl-label";
    lab.textContent = label;
    highlightEl.replaceChildren(lab);
    // Tell the card where on the page the approval target sits (the card is the frame in off mode).
    if (hlKind === "approve" && frame) frame.contentWindow?.postMessage({ __mlHighlightPos: posLabel(left + width / 2, top + height / 2) }, "*");
}
function hideHighlight(): void { hlSeq++; hlKind = ""; if (highlightEl) { highlightEl.remove(); highlightEl = null; } }
// Highlight a page target on hover. ELEMENT mode (`selector`): the shell shares the page DOM, so it
// resolves the rect itself. POINT/BOX mode (`token`, an @pt/@box): only the main world knows the
// coords, so ask injected to resolve (ML_HL_RESOLVE → ML_HL_AT) and draw on the reply.
function showHighlight(ref: { selector?: string; index?: number; token?: string; kind?: string } | null): void {
    if (!ref) return hideHighlight();
    hlKind = ref.kind === "approve" ? "approve" : "";
    const seq = ++hlSeq;
    if (ref.selector) {
        let el: Element | null = null;
        try { el = document.querySelectorAll(ref.selector)[ref.index || 0] || null; } catch { el = null; }
        if (!el) return hideHighlight();
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return hideHighlight();   // hidden/collapsed — nothing to show
        drawHighlight(r.left, r.top, r.width, r.height, `${el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`);
    } else if (ref.token) {
        window.postMessage({ type: "ML_HL_RESOLVE", token: ref.token, seq }, "*");   // injected replies with the coords
    } else hideHighlight();
}

// While the overlay is hidden for a shot it stops being a hit-test target, so a wheel
// gesture you were mid-scroll on falls through to the page and moves it — corrupting the
// very shot we're taking (and leaving the page scrolled). Pin the page scroll for the
// hide→show window: snapshot the position and snap back on any scroll until we restore.
let scrollPin: { x: number; y: number; onScroll: () => void } | null = null;

function onWindowMessage(e: MessageEvent): void {
    const d = e.data;
    if (!d) return;
    // injected.js just loaded and is listening (a page-load race: it may have missed the
    // handshake we posted before its <script> ran). Re-send it. `mode` is never "off" while
    // this listener is attached; guard anyway.
    if (d.__mlSidebar === "hello" && e.source === window) { if (mode !== "off") handshake(); return; }
    // injected.js asks us to hide the overlay for a screenshot (so the sidebar
    // isn't captured into the agent's `look`). Hide, then ack after two frames so
    // the hidden state has painted before the capture fires.
    if (d.__mlSidebarShot === "hide") {
        if (!scrollPin) {
            const x = window.scrollX, y = window.scrollY;
            const onScroll = () => window.scrollTo(x, y);
            window.addEventListener("scroll", onScroll, { passive: true });
            scrollPin = { x, y, onScroll };
        }
        if (shellHost) shellHost.style.visibility = "hidden";
        if (cardHost) cardHost.style.visibility = "hidden";   // the off-mode card, if it's showing
        if (lightbox) lightbox.style.visibility = "hidden";   // full-viewport overlay — MUST hide too, else the shot is all backdrop
        hideHighlight();   // a hover box would otherwise land in the capture
        requestAnimationFrame(() => requestAnimationFrame(() => window.postMessage({ __mlSidebarShot: "hidden" }, "*")));
        return;
    }
    if (d.__mlSidebarShot === "show") {
        if (shellHost) shellHost.style.visibility = "";
        if (cardHost) cardHost.style.visibility = "";
        if (lightbox) lightbox.style.visibility = "";
        if (scrollPin) {
            window.removeEventListener("scroll", scrollPin.onScroll);
            window.scrollTo(scrollPin.x, scrollPin.y);   // final restore in case one slipped through
            scrollPin = null;
        }
        return;
    }
    // The iframe app asks to open an image full-window (ClickableImg).
    if (typeof d.__mlLightbox === "string" && frame && e.source === frame.contentWindow) { showLightbox(d.__mlLightbox); return; }
    // The iframe app asks to highlight a page element on hover (a rendered element ref). Draw the
    // overlay box; null clears it. Origin-checked (only the real iframe), like the lightbox.
    if ("__mlHighlight" in d && frame && e.source === frame.contentWindow) { showHighlight(d.__mlHighlight); return; }
    // injected resolved an @pt/@box token to viewport coords → draw a point marker / box outline (unless
    // a newer hover superseded it, or the token was stale and didn't resolve).
    if (d.type === "ML_HL_AT" && e.source === window) {
        if (d.seq !== hlSeq) return;
        if (d.point) drawHighlight(d.point.x - 10, d.point.y - 10, 20, 20, `point · ${Math.round(d.point.x)}, ${Math.round(d.point.y)}`);
        else if (d.box) drawHighlight(d.box.left, d.box.top, d.box.right - d.box.left, d.box.bottom - d.box.top, `box · ${Math.round(d.box.right - d.box.left)}×${Math.round(d.box.bottom - d.box.top)}`);
        else hideHighlight();
        return;
    }
    // injected.js (page main world) → the active surface ONLY (the debugMode surfaces are
    // exclusive): `overlay` relays into the iframe app (frame is null in devtools mode →
    // no-op); `devtools` forwards to the background so the panel receives it (a panel can't
    // read these window-messages). Fire-and-forget; harmless when no panel is open.
    if (d.__mlDebug && e.source === window) {
        // OFF mode: the corner card is fed ONLY by the BACKGROUND stream (tagged __mlFromBg by
        // content.ts) — the page's own bus is dormant here, so injected events never arrive live. The
        // first such event brings up the card lazily; until its iframe app handshakes we buffer, then
        // flush in order (see the app-ready branch below). This keeps off mode zero-cost until a run.
        if (mode === "off") {
            if (!d.__mlFromBg) return;
            if (!cardHost) mountCard();
            if (cardReady) frame?.contentWindow?.postMessage(d, "*");
            else { bgRing.push(d); if (bgRing.length > CARD_RING_MAX) bgRing.shift(); }
            return;
        }
        frame?.contentWindow?.postMessage(d, "*");
        if (mode === "devtools") {
            try { void chrome.runtime.sendMessage({ type: "ML_DEBUG_EVENT", event: d.__mlDebug }).catch(() => {}); } catch { /* context gone */ }
        }
        return;
    }
    // Design A: the iframe app's approve/deny for a background-hosted run's pending gate. We forward it
    // to the background as SET_APPROVAL — but ONLY because we can prove it came from the real extension
    // iframe (e.source === frame.contentWindow), which the page cannot forge. THIS is what makes the
    // approval unforgeable: a page-set window.confirm or a spoofed window-message can't reach here.
    if (d.__mlSidebarApp === "approval" && frame && e.source === frame.contentWindow
        && typeof d.hash === "string" && typeof d.seq === "number") {
        try {
            void chrome.runtime.sendMessage({ type: "SET_APPROVAL", payload: { runId: d.hash, seq: d.seq, decision: !!d.decision } }).catch(() => {});
        } catch { /* extension context gone */ }
        return;
    }
    // The off-mode card app tells us its desired visual state (hidden / toast / expanded) — it alone
    // knows whether there's a pending approval or a final answer worth showing. We drive the container's
    // size + reveal (a CSS transition). Origin-checked: only the real card iframe.
    if (typeof d.__mlSidebarCard === "string" && frame && e.source === frame.contentWindow) {
        if (cardWrap) { cardWrap.dataset.state = d.__mlSidebarCard; sizeCard(); }
        return;
    }
    // The card app reports its content height (a cross-origin iframe can't auto-size) → fit the card to
    // it, capped, unless the user dragged a manual height.
    if (typeof d.__mlSidebarCardH === "number" && frame && e.source === frame.contentWindow) {
        cardAutoH = d.__mlSidebarCardH; sizeCard();
        return;
    }
    // The iframe app is listening. OVERLAY: handshake injected.js so it starts emitting, and tell the
    // app the current open state (it gates polling on this). OFF (the card): we do NOT handshake injected
    // (its bus stays dormant — the card is fed by the background stream); instead tell the app it's the
    // card surface and flush the events buffered while its iframe loaded, in order.
    if (d.__mlSidebarApp === "ready" && frame && e.source === frame.contentWindow) {
        if (mode === "off") {
            cardReady = true;
            frame.contentWindow?.postMessage({ __mlSidebarSurface: "card" }, "*");
            for (const ev of bgRing) frame.contentWindow?.postMessage(ev, "*");
            bgRing.length = 0;
            return;
        }
        window.postMessage({ __mlSidebar: "ready" }, "*");
        frame.contentWindow?.postMessage({ __mlSidebarOpen: panel?.classList.contains("open") ?? false }, "*");
    }
}

// Tell the iframe app when the panel slides open/closed (it gates polling on this).
function toggleOpen(): void {
    const open = panel?.classList.toggle("open") ?? false;
    frame?.contentWindow?.postMessage({ __mlSidebarOpen: open }, "*");
}

const setWidth = (w: number): void => { if (panel) panel.style.width = `${Math.round(w)}px`; };

function startResize(e: PointerEvent): void {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("drag");
    if (frame) frame.style.pointerEvents = "none";   // let drag events cross the iframe
    const onMove = (ev: PointerEvent) =>
        setWidth(Math.max(MIN_W, Math.min(window.innerWidth * 0.95, window.innerWidth - ev.clientX)));
    const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        handle.classList.remove("drag");
        if (frame) frame.style.pointerEvents = "";
        const w = panel ? parseInt(panel.style.width, 10) : 0;
        if (w) chrome.storage.local.set({ [WIDTH_KEY]: w });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}

// Tell injected.js debug is on: `present` (start buffering), plus — in devtools mode, which
// has no iframe app to hand back `ready` — `ready` right away so it goes live. Re-sent on
// injected's `hello` too, so a page-load race (injected's async <script> not yet listening
// when we first post) can't strand it un-live. Idempotent (bus guards a double replay).
function handshake(): void {
    window.postMessage({ __mlSidebar: "present" }, "*");
    if (mode === "devtools") window.postMessage({ __mlSidebar: "ready" }, "*");
}

// Start listening on the page window. `handshakeInjected` is true for the overlay/devtools surfaces
// (bring injected.js live + clear the stale DevTools-panel buffer); false for OFF mode, whose card is
// fed by the background stream, not injected's bus — so injected stays dormant and off keeps its
// near-zero footprint (just this idle listener, waiting for a background run).
function attach(handshakeInjected: boolean): void {
    window.addEventListener("message", onWindowMessage);
    if (handshakeInjected) {
        try { void chrome.runtime.sendMessage({ type: "ML_DEBUG_RESET" }).catch(() => {}); } catch { /* context gone */ }
        handshake();
    }
}

function mountOverlay(): void {
    if (shellHost) return;
    // Host the shell's chrome (container/tab/resize/iframe) inside a shadow root
    // so the page's CSS can't bleed into it (e.g. a global `div { opacity: .8 }`,
    // as example.com actually ships). `all: initial` on the shadow host blocks
    // page rules that target the host element itself. Secrets still live in the
    // iframe (its own extension origin), not in this shell.
    shellHost = document.createElement("div");
    shellHost.id = SB_ROOT;
    shellHost.style.cssText = "all: initial;";
    const root = shellHost.attachShadow({ mode: "open" });
    shadowRoot = root;

    const style = document.createElement("style");
    style.textContent = SHELL_CSS;
    root.append(style);

    panel = document.createElement("div");
    panel.id = SB_HOST;

    const tab = document.createElement("button");
    tab.id = SB_TAB;
    tab.textContent = "ml · debug";
    tab.classList.add("ml-tt");
    tab.append(tip("window.ml debug"));
    tab.addEventListener("click", toggleOpen);

    const body = document.createElement("div");
    body.id = "ml-sb-body";
    const resize = document.createElement("div");
    resize.id = "ml-sb-resize";
    resize.classList.add("ml-tt");
    resize.append(tip("Drag to resize"));
    resize.addEventListener("pointerdown", startResize);
    frame = document.createElement("iframe");
    frame.id = SB_FRAME;
    frame.allow = "clipboard-write";   // delegate the Clipboard API into the extension iframe
    frame.src = chrome.runtime.getURL("sidebar.html");
    body.append(resize, frame);

    panel.append(tab, body);
    root.append(panel);
    (document.documentElement || document.body).append(shellHost);

    chrome.storage.local.get({ [WIDTH_KEY]: DEFAULT_W }, (d: any) => setWidth(d[WIDTH_KEY] || DEFAULT_W));
}

// Lazily bring up the off-mode approval card: a separate shadow host holding the acrylic container +
// the SAME sidebar.html iframe (so SET_APPROVAL stays unforgeable — it's the real extension origin).
// Called on the first background-run event; starts hidden and is revealed by the app posting a state.
function mountCard(): void {
    if (cardHost) return;
    cardHost = document.createElement("div");
    cardHost.id = SB_CARD;
    cardHost.style.cssText = "all: initial;";
    const root = cardHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    root.append(style);

    cardWrap = document.createElement("div");
    cardWrap.id = `${SB_CARD}-wrap`;
    cardWrap.dataset.state = "hidden";
    applyCardTheme();   // acrylic follows the app's resolved theme, not the OS
    frame = document.createElement("iframe");
    frame.id = `${SB_CARD}-frame`;
    frame.allow = "clipboard-write";
    frame.src = chrome.runtime.getURL("sidebar.html");
    const handle = document.createElement("div");
    handle.id = `${SB_CARD}-resize`;
    handle.title = "Drag to resize · double-click to auto-fit";
    handle.addEventListener("pointerdown", startCardResize);
    handle.addEventListener("dblclick", () => { cardManualH = null; chrome.storage.local.remove(CARD_H_KEY); sizeCard(); });
    cardWrap.append(frame, handle);
    root.append(cardWrap);
    (document.documentElement || document.body).append(cardHost);
    chrome.storage.local.get({ [CARD_H_KEY]: null }, (d: any) => { cardManualH = d[CARD_H_KEY] || null; sizeCard(); });
}
function unmountCard(): void {
    if (!cardHost) return;
    cardHost.remove();
    cardHost = cardWrap = frame = null;   // `frame` is the card iframe in off mode
    cardReady = false;
    bgRing.length = 0;
}

// Detach everything: remove the overlay/card DOM (if any), drop the listener, and — only if we brought
// injected.js live (overlay/devtools) — tell it debug is off (stop emitting + drop its ring).
function teardown(): void {
    hideLightbox();
    hideHighlight();
    if (hlHost) { hlHost.remove(); hlHost = hlRoot = null; }   // the devtools-mode highlight-only host
    if (shellHost) { shellHost.remove(); shellHost = panel = frame = shadowRoot = null; }
    unmountCard();
    window.removeEventListener("message", onWindowMessage);
    // Only overlay/devtools handshook injected; off left its bus dormant, so there's nothing to switch
    // off. `mode` is still the OLD surface here (applyMode tears down before advancing).
    if (mode !== "off") window.postMessage({ __mlSidebar: "gone" }, "*");
}

// The single entry point for the three debug surfaces. `off` draws nothing up-front and leaves
// injected's bus dormant — it just listens for a background-hosted run and mounts the corner card
// lazily. `overlay` mounts the in-page shell (whose iframe app hands back the `ready`). `devtools`
// forwards the stream to the background (for the DevTools panel) but draws NO overlay — attach()/
// handshake() posts `ready` itself (no iframe app to wait for).
let mode: DebugMode = "off";
let started = false;   // force the first applyMode to run even when the stored mode equals the initial "off"
function applyMode(next: DebugMode): void {
    if (started && next === mode) return;
    started = true;
    teardown();
    mode = next;
    if (mode === "off") { attach(false); return; }   // listen for a background run; the card mounts lazily
    attach(true);
    if (mode === "overlay") mountOverlay();
}

// The off-mode card's acrylic must match the APP's resolved theme (config.theme, auto → OS), so a
// user who forces one theme doesn't get mismatched (e.g. dark text on a dark acrylic). We resolve the
// same way prefs.ts does and stamp it on the wrap; the CARD_CSS keys the acrylic off [data-theme].
let rawTheme = "auto";
const themeMedia = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function applyCardTheme(): void {
    const resolved = (rawTheme === "light" || rawTheme === "dark") ? rawTheme : (themeMedia?.matches ? "dark" : "light");
    if (cardWrap) cardWrap.dataset.theme = resolved;
}
themeMedia?.addEventListener("change", applyCardTheme);   // "auto" follows the OS

chrome.storage.sync.get({ debugMode: "off", theme: "auto" }, (cfg) => {
    rawTheme = (cfg.theme as string) || "auto";
    applyMode(cfg.debugMode as DebugMode);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.theme) { rawTheme = (changes.theme.newValue as string) || "auto"; applyCardTheme(); }
    if (changes.debugMode) applyMode((changes.debugMode.newValue || "off") as DebugMode);
});

// DevTools-panel hover-highlight (the reverse channel). The panel can't touch the inspected
// page, so its app's __mlHighlight is relayed panel → background → here (ML_HL_REMOTE), and we
// draw the box in this content script (which DOES share the page DOM). Only in devtools mode —
// the overlay gets highlights straight from its own iframe via window-message. Read-only (a
// pointer-events:none box, no page mutation), so even a spurious relay is harmless.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "ML_HL_REMOTE" && mode === "devtools") showHighlight(msg.ref || null);
});
