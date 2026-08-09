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
#${SB_HIGHLIGHT}.ml-hl-approve { background: rgba(34, 197, 94, .26); outline: 3px solid rgba(34, 197, 94, 1);
  border-radius: 3px; animation: ml-hl-pulse 1.25s ease-in-out infinite; }
#${SB_HIGHLIGHT}.ml-hl-approve .ml-hl-label { background: #16a34a; font-size: 11px; padding: 2px 7px; }
@keyframes ml-hl-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, .6); } 50% { box-shadow: 0 0 0 13px rgba(34, 197, 94, 0); } }
`;

// The off-mode approval CARD: a macOS-notification-style acrylic panel in the bottom-right corner,
// hosting the SAME sidebar.html iframe (so SET_APPROVAL stays unforgeable) but in the app's curated
// "card" surface. It's the ONLY thing off mode ever draws, and only while a background-hosted run has
// something to show. The iframe is transparent so the acrylic (a blurred translucent surface here in
// the shell's shadow root) shows through; the app draws its content over it. Three states drive the
// size/reveal, transitioned for a soft expand: hidden (gone) · toast (collapsed) · expanded.
const CARD_CSS = `
#${SB_CARD}-wrap {
  position: fixed; z-index: 2147483000;
  box-sizing: border-box; overflow: hidden; border-radius: 15px;
  background: rgba(250, 250, 252, .72);
  /* saturate() is the AMPLIFIER of page colour bleeding through — high (180%) means a yellow page tints
     the panel light/yellow. Keeping it near 100% (a touch of desaturation) makes the bleed NEUTRAL
     regardless of page colour, so a lower background opacity (more blur/translucency) no longer tints.
     Tune the two independently: 'saturate' = colour-neutrality, background alpha = how much shows through. */
  -webkit-backdrop-filter: blur(30px) saturate(102%); backdrop-filter: blur(30px) saturate(102%);
  border: 1px solid rgba(0, 0, 0, .10);
  box-shadow: 0 14px 46px rgba(0, 0, 0, .26), 0 3px 10px rgba(0, 0, 0, .14);
  /* Two-layer motion: the shell morphs the CONTAINER (position + size in px — see layoutCard), the app
     fades its content (a cross-origin iframe can't be FLIP-measured). POSITION springs (a little
     overshoot) so it FLIES between corner ↔ centre ↔ a drag; SIZE decels smoothly (overshoot would clip
     content mid-bounce); BORDER-RADIUS overshoots (the liquid "squish" as it balls up into the orb);
     opacity/transform give the reveal pop. '.no-anim' = instant (during a drag). */
  transform-origin: center;
  /* left/top AND width/height MUST share the SAME timing — otherwise 'left+width' (the corner-anchored
     edge) only matches at the endpoints and WOBBLES across the pointer mid-transition, firing a spurious
     pointerleave → the hover-capsule flicker. Same bezier ⇒ left(t)+width(t) is constant ⇒ the anchored
     edge stays put the whole time. No under/overshoot on size (that dips the edge past the pointer too).
     border-radius keeps its own bouncy curve — it doesn't affect the layout box, so it can't cross a pointer. */
  transition: left .40s cubic-bezier(.3,.85,.3,1), top .40s cubic-bezier(.3,.85,.3,1),
              width .40s cubic-bezier(.3,.85,.3,1), height .40s cubic-bezier(.3,.85,.3,1),
              border-radius .44s cubic-bezier(.5,-0.3,.2,1.5),
              opacity .24s ease, transform .40s cubic-bezier(.34,1.32,.5,1);
}
/* TEXT cards (toast/expanded) do NOT transition WIDTH — an animating width reflows the assistant text
   (tall while narrow, short when wide) and the height chases it, so the card opened 2-3× too tall then
   shrank. Width snaps to final immediately → the text is laid out at its final width from frame 1 → the
   height is stable; HEIGHT still transitions (a reflow-free grow for streaming / Show-work). The reveal is
   an opacity + corner-aware slide (below), not a size morph. Orb/composer keep the liquid width morph. */
#${SB_CARD}-wrap[data-state="toast"], #${SB_CARD}-wrap[data-state="expanded"] {
  transition: left .40s cubic-bezier(.3,.85,.3,1), top .40s cubic-bezier(.3,.85,.3,1),
              height .40s cubic-bezier(.3,.85,.3,1),
              border-radius .44s cubic-bezier(.5,-0.3,.2,1.5),
              opacity .24s ease, transform .34s cubic-bezier(.34,1.2,.5,1);
}
/* MATERIALIZE: the acrylic frosts IN — backdrop blur ramps 0→full over .8s while the card fades/slides in
   (opacity/transform, above) — so a fresh HUD condenses into existence rather than popping. Driven by a
   one-shot class the shell adds on the hidden→visible transition (a backdrop-filter *transition* is
   unreliable — it needs the blur(0) frame painted first, which a same-frame mount→reveal skips). */
/* Ramp BOTH the blur AND the background alpha (transparent→opaque) over 1.1s — blur alone is barely visible
   on a 78%-opaque card (only ~22% backdrop shows), so the acrylic looked like it popped. Theme-aware (the
   bg colour differs) so the 'to' matches the resting acrylic exactly. Slower + the alpha ramp = you SEE it
   condense: sharp+see-through → frosted+solid. */
#${SB_CARD}-wrap[data-theme="dark"].ml-materialize { animation: ${SB_CARD}-frost-dark 1.1s cubic-bezier(.25,.6,.25,1) backwards; }
#${SB_CARD}-wrap[data-theme="light"].ml-materialize, #${SB_CARD}-wrap.ml-materialize:not([data-theme="dark"]) { animation: ${SB_CARD}-frost-light 1.1s cubic-bezier(.25,.6,.25,1) backwards; }
@keyframes ${SB_CARD}-frost-dark {
  from { -webkit-backdrop-filter: blur(1px) saturate(102%); backdrop-filter: blur(1px) saturate(102%); background: rgb(24 24 27 / 0%); }
  to   { -webkit-backdrop-filter: blur(30px) saturate(102%); backdrop-filter: blur(30px) saturate(102%); background: rgb(24 24 27 / 78%); }
}
@keyframes ${SB_CARD}-frost-light {
  from { -webkit-backdrop-filter: blur(1px) saturate(102%); backdrop-filter: blur(1px) saturate(102%); background: rgba(250, 250, 252, 0); }
  to   { -webkit-backdrop-filter: blur(30px) saturate(102%); backdrop-filter: blur(30px) saturate(102%); background: rgba(250, 250, 252, .72); }
}
@media (prefers-reduced-motion: reduce) { #${SB_CARD}-wrap.ml-materialize { animation: none; } }
#${SB_CARD}-wrap.no-anim { transition: none; }
/* The acrylic tracks the APP's resolved theme (set on the wrap by the shell from config.theme), NOT
   the OS — otherwise a user who forces Light while the OS is dark gets dark text on a dark acrylic. */
#${SB_CARD}-wrap[data-theme="dark"] { background: rgb(24 24 27 / 71%); border-color: rgba(255, 255, 255, .12);
  box-shadow: 0 14px 46px rgba(0, 0, 0, .5), 0 3px 10px rgba(0, 0, 0, .34); }
/* left/top/width/height are all set in px by the shell (layoutCard). data-state drives reveal
   (opacity/transform), the orb's roundness, and the composer's deeper shadow; data-corner only places
   the resize handle. */
#${SB_CARD}-wrap { left: 20px; top: 20px; height: 84px; }
/* Reveal: fade + a small slide IN FROM the attached corner's side (right corners slide from the right, left
   from the left) — the slide is a transform, so it never reflows the text (unlike the old width morph). */
#${SB_CARD}-wrap[data-state="hidden"] { opacity: 0; pointer-events: none; transform: translateX(18px) scale(.98); }
#${SB_CARD}-wrap[data-corner$="left"][data-state="hidden"] { transform: translateX(-18px) scale(.98); }
#${SB_CARD}-wrap[data-state="orb"], #${SB_CARD}-wrap[data-state="orblabel"], #${SB_CARD}-wrap[data-state="orbprose"],
#${SB_CARD}-wrap[data-state="toast"], #${SB_CARD}-wrap[data-state="expanded"], #${SB_CARD}-wrap[data-state="composer"] { opacity: 1; transform: none; }
/* Both pill states — the hover capsule (orblabel, spelling out the current tool) and the live-caption pill
   (orbprose, the model's between-step narration) — are the same computing stage, just stretched. Both stay
   ALIVE, wobbling their cap radii on both axes like the orb (border-radius only, so it can't move the box /
   re-trip the hover). border-radius ≈ half the height so the ends stay round. The width itself is set in px
   by the shell — for orbprose it FITS the text (up to a max, then the label ellipsizes). */
#${SB_CARD}-wrap[data-state="orblabel"], #${SB_CARD}-wrap[data-state="orbprose"] {
  border-radius: 27px; box-shadow: 0 12px 34px rgba(0, 0, 0, .30), 0 3px 10px rgba(0, 0, 0, .18);
  animation: ${SB_CARD}-jelly 2.6s ease-in-out infinite; }
@keyframes ${SB_CARD}-jelly {
  0%, 100% { border-radius: 27px 27px 27px 27px / 27px 27px 27px 27px; }
  25%      { border-radius: 33px 21px 33px 21px / 14px 27px 14px 27px; }
  50%      { border-radius: 21px 33px 21px 33px / 27px 14px 27px 14px; }
  75%      { border-radius: 31px 23px 31px 23px / 18px 27px 18px 27px; }
}
@media (prefers-reduced-motion: reduce) {
  #${SB_CARD}-wrap[data-state="orblabel"], #${SB_CARD}-wrap[data-state="orbprose"] { animation: none; } }
/* The liquid ORB — the working state balled up into a circle (the emoji tool icon lives in the iframe).
   While computing it WOBBLES like a water droplet: the border-radius morphs between organic asymmetric
   values (a 2D metaball, done on the acrylic container itself — no SVG goo filter to muddy the backdrop
   blur). The .3s delay lets the squish-in transition round it off first, then the wobble takes over. */
#${SB_CARD}-wrap[data-state="orb"] { border-radius: 50%;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .30), 0 2px 8px rgba(0, 0, 0, .18);
  animation: ${SB_CARD}-droplet 3s ease-in-out .3s infinite; }
/* ONLY border-radius wobbles — NOT transform. A scale/rotate would move the orb's box out from under the
   pointer, and the hover→capsule (transform:none) snap-back would fire pointerleave → collapse → re-enter
   → a flickering oscillation. border-radius doesn't affect layout, so the hover target stays put. */
@keyframes ${SB_CARD}-droplet {
  0%,  100% { border-radius: 50% 50% 50% 50% / 50% 50% 50% 50%; }
  25%       { border-radius: 68% 32% 62% 38% / 55% 66% 34% 45%; }
  50%       { border-radius: 34% 66% 40% 60% / 64% 38% 62% 36%; }
  75%       { border-radius: 60% 40% 34% 66% / 40% 62% 38% 60%; }
}
@media (prefers-reduced-motion: reduce) { #${SB_CARD}-wrap[data-state="orb"] { animation: none; } }
#${SB_CARD}-wrap[data-state="composer"] { box-shadow: 0 24px 70px rgba(0, 0, 0, .34), 0 6px 18px rgba(0, 0, 0, .18); }
#${SB_CARD}-frame { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
/* Resize handle on the FREE edge (bottom corner → drag the top up; top corner → drag the bottom down). */
#${SB_CARD}-resize { position: absolute; left: 0; right: 0; height: 9px; cursor: ns-resize; z-index: 3; }
#${SB_CARD}-wrap[data-corner^="bottom"] #${SB_CARD}-resize { top: 0; }
#${SB_CARD}-wrap[data-corner^="top"] #${SB_CARD}-resize { bottom: 0; }
#${SB_CARD}-resize::after { content: ""; position: absolute; top: 3px; left: 50%; transform: translateX(-50%);
  width: 34px; height: 3px; border-radius: 2px; background: currentColor; opacity: 0; transition: opacity .15s; color: var(--fg-faint, #888); }
#${SB_CARD}-resize:hover::after { opacity: .5; }
#${SB_CARD}-wrap:not([data-state="expanded"]) #${SB_CARD}-resize { display: none; }
/* Right-click corner menu (drawn HERE in the shell, not the pill iframe which would clip it). */
#${SB_CARD}-menu { position: fixed; z-index: 2147483002; min-width: 150px; padding: 4px;
  background: rgba(38, 38, 44, .96); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,.14); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.4);
  font: 12px system-ui, -apple-system, sans-serif; color: #e7e7ea; }
#${SB_CARD}-menu button { display: flex; width: 100%; align-items: center; gap: 8px; background: transparent;
  border: none; color: inherit; text-align: left; padding: 6px 9px; border-radius: 5px; cursor: pointer; font: inherit; }
#${SB_CARD}-menu button:hover { background: rgba(255,255,255,.10); }
#${SB_CARD}-menu button .tick { width: 12px; opacity: .9; }
#${SB_CARD}-menu button.danger { color: #ff8a8a; }
#${SB_CARD}-menu button.danger:hover { background: rgba(255,90,90,.16); }
#${SB_CARD}-menu .menu-div { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.12); }
#${SB_CARD}-menu .menu-head { padding: 4px 9px 5px; color: #9a9aa2; font-size: 11px; }
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
let cardAutoH = 200;
let cardManualH: number | null = null;   // transient drag override (discarded when content changes / on unmount)
let cardProseW: number | null = null;    // the caption pill's measured content width (app-reported), clamped for orbprose
let cardDrag: { left: number; top: number } | null = null;   // live grab-drag position (px); null when resting
// The cursor's live page position + the fraction of the card it grabbed, tracked so a mid-drag SIZE change
// (the pill collapsing to the orb) keeps that grabbed point under the cursor — instead of pinning the old
// top-left, which flung the tiny orb to the edge with a gap. Both null when not dragging.
let dragCursor: { x: number; y: number } | null = null;
let dragFrac: { fx: number; fy: number } | null = null;

// Snap the dragged card to the nearest corner and clear the drag. Called by the app's drop message AND by
// the window-level safety net below. Idempotent (no cardDrag → just tidy up). Tells the app to drop its own
// drag listeners too, since its in-iframe pointerup may never have fired (the escaped-flick case).
function finalizeCardDrag(): void {
    window.removeEventListener("pointermove", onWinDragMove, true);
    window.removeEventListener("pointerup", onWinDragEnd, true);
    window.removeEventListener("pointercancel", onWinDragEnd, true);
    frame?.contentWindow?.postMessage({ __mlSidebarCardEndDrag: true }, "*");
    if (!cardDrag || !cardWrap) { cardDrag = null; dragCursor = null; dragFrac = null; return; }
    const w = cardWrap.offsetWidth, h = cardWrap.offsetHeight;
    const cx = cardDrag.left + w / 2, cy = cardDrag.top + h / 2;   // nearest corner by the card's centre
    const corner = (cy < window.innerHeight / 2 ? "top-" : "bottom-") + (cx < window.innerWidth / 2 ? "left" : "right");
    cardDrag = null; dragCursor = null; dragFrac = null;
    cardWrap.classList.remove("no-anim");
    cardCorner = corner;
    applyCardCorner();                                  // data-corner + layoutCard → animates to the snapped corner
    chrome.storage.sync.set({ cardCorner: corner });    // persist (the storage listener re-applies; harmless)
}
// SAFETY NET for a fast flick: when the pointer outruns the tiny iframe, capture is lost and the iframe
// stops getting events — the drag would stick mid-page (never snapping) and a re-grab "runs away". These
// fire on the PAGE window, which now sees the escaped pointer: keep following it by ABSOLUTE coords and
// finalize on release. While the pointer is over the iframe these never fire (the iframe captures those).
function onWinDragMove(ev: PointerEvent): void {
    if (!cardDrag || !dragFrac || !cardWrap) return;
    const w = cardWrap.offsetWidth, h = cardWrap.offsetHeight;
    dragCursor = { x: ev.clientX, y: ev.clientY };
    cardDrag.left = Math.max(6, Math.min(window.innerWidth - w - 6, ev.clientX - dragFrac.fx * w));
    cardDrag.top = Math.max(6, Math.min(window.innerHeight - h - 6, ev.clientY - dragFrac.fy * h));
    layoutCard();
}
function onWinDragEnd(): void { finalizeCardDrag(); }
let materializeTimer = 0;          // clears the one-shot .ml-materialize (frost-in) class after the reveal
let cardCorner = "bottom-right";   // config.cardCorner (set from storage) → which corner the card anchors to
let agentHud = "progress";         // config.agentHud → "progress" shows the working pill, "quiet" hides it
let agentHudInDevtools = false;    // config → also show the corner card/pill alongside the DevTools panel
// The corner HUD (card/pill) is active in OFF mode, and in DEVTOOLS when the coexist toggle is on
// (OVERLAY never uses it — the slide-out already covers the page).
const hudActive = (): boolean => mode === "off" || (mode === "devtools" && agentHudInDevtools);
// Background-run events buffered while the card iframe loads (off mode feeds the card ONLY from the
// background stream, tagged __mlFromBg — the page's bus stays dormant — so no cross-source ordering).
const CARD_RING_MAX = 200;
const bgRing: MessageEvent["data"][] = [];

// The tallest the card may be dragged / expanded to — the "Show work" open target too.
function maxCardH(): number { return Math.round(window.innerHeight * 0.92); }
// Per-state target WIDTH (px). Height is content-driven (cardAutoH) or the user's drag (cardManualH);
// the ORB is a fixed circle (width === height).
const CARD_MARGIN = 20;
const CARD_BORDER = 2;   // the wrap's 1px top+bottom border (box-sizing: border-box), added back to the content height
const ORB_SIZE = 54;
const CARD_W: Record<string, number> = { orb: ORB_SIZE, orblabel: 230, orbprose: 360, toast: 340, expanded: 384, composer: 560, hidden: 340 };
const PROSE_MIN_W = 150;   // never narrower than the icon + a couple of words (a 1-word caption still reads as a pill)
const cardW = (state: string): number => {
    // orbprose FITS its caption: the app measures the text's natural width and posts it; we clamp to
    // [PROSE_MIN_W, orbprose max] so a short line hugs the text and a long one caps + ellipsizes. The width
    // change animates via the wrap's CSS transition, so the pill smoothly grows/shrinks as new prose lands.
    if (state === "orbprose" && cardProseW != null) {
        return Math.min(Math.max(cardProseW, PROSE_MIN_W), CARD_W.orbprose, window.innerWidth - 2 * CARD_MARGIN);
    }
    return Math.min(CARD_W[state] ?? 340, window.innerWidth - 2 * CARD_MARGIN);
};
const cardH = (state: string): number => {
    if (state === "orb" || state === "orblabel" || state === "orbprose") return ORB_SIZE;   // circle / capsule /
                                                                    // caption — SAME height (a vertical shift would flicker the pointerenter/leave)
    const cap = Math.max(120, window.innerHeight - 2 * CARD_MARGIN);   // never past the fold; body scrolls
    // cardAutoH is the CONTENT height the app measured. The wrap is box-sizing:border-box with a 1px border,
    // so that 2px eats into the height — without adding it back the iframe is 2px shorter than its content and
    // card-body shows a spurious scrollbar. A manual drag already sized the whole wrap, so it needs no add.
    const desired = (state === "expanded" && cardManualH) ? cardManualH : (cardAutoH + CARD_BORDER);
    return Math.max(56, Math.min(desired, cap));
};
// Where the card rests for a given state+size: the composer CENTRES (Spotlight); everything else sits at
// the configured corner (top-left of the box computed from the corner + size + margin). A live drag wins.
function cardPos(state: string, w: number, h: number): { left: number; top: number } {
    if (cardDrag) return cardDrag;
    if (state === "composer") return { left: Math.round((window.innerWidth - w) / 2), top: Math.max(CARD_MARGIN, Math.round(window.innerHeight * 0.4 - h / 2)) };
    const left = cardCorner.endsWith("right") ? window.innerWidth - CARD_MARGIN - w : CARD_MARGIN;
    const top = cardCorner.startsWith("top") ? CARD_MARGIN : window.innerHeight - CARD_MARGIN - h;
    return { left, top };
}
// Set the card's position AND size in px so the container can spring between corner/centre/drag. The
// bottom/right corners compute `top`/`left` from the size, so a height change grows AWAY from the anchored
// edge for free (no separate anchoring). An explicit px is what lets the CSS transitions animate.
function layoutCard(): void {
    if (!cardWrap) return;
    const state = cardWrap.dataset.state || "hidden";
    const w = cardW(state), h = cardH(state);
    const { left, top } = cardPos(state, w, h);
    cardWrap.style.width = `${w}px`;
    cardWrap.style.height = `${h}px`;
    cardWrap.style.left = `${left}px`;
    cardWrap.style.top = `${top}px`;
}
// Drag the free edge to resize (bottom corner → drag the top up; top corner → drag the bottom down).
// layoutCard recomputes the anchored edge so it grows the right way. Double-click resets to auto-fit.
function startCardResize(e: PointerEvent): void {
    if (!cardWrap) return;
    e.preventDefault();
    if (frame) frame.style.pointerEvents = "none";   // let the drag cross the iframe
    cardWrap.classList.add("no-anim");               // track the pointer 1:1 (no spring lag while dragging)
    const rect = cardWrap.getBoundingClientRect();
    const topAnchored = (cardWrap.dataset.corner || "").startsWith("top");
    const anchor = topAnchored ? rect.top : rect.bottom;   // the fixed edge; height grows from it
    const onMove = (ev: PointerEvent) => {
        const raw = topAnchored ? ev.clientY - anchor : anchor - ev.clientY;
        cardManualH = Math.max(120, Math.min(maxCardH(), Math.round(raw)));
        layoutCard();
    };
    const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (frame) frame.style.pointerEvents = "";
        cardWrap?.classList.remove("no-anim");
        // Not persisted — a drag is a momentary override that the next event snaps back to content.
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}

// Right-click corner menu. Drawn in the CARD's shadow root (not the pill iframe, which would clip it).
// A pick writes config.cardCorner; the storage listener repositions the card. The menu coords arrive
// iframe-local from the app and are offset by the frame's page position.
const CARD_CORNERS: [string, string][] = [["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"], ["top-right", "Top right"], ["top-left", "Top left"]];
let cornerMenuEl: HTMLElement | null = null;
function hideCornerMenu(): void {
    cornerMenuEl?.remove(); cornerMenuEl = null;
    window.removeEventListener("pointerdown", onCornerMenuOutside, true);
    window.removeEventListener("keydown", onCornerMenuKey, true);
    window.removeEventListener("blur", hideCornerMenu);
}
// Any click that isn't on one of the menu's own buttons dismisses it (a click on a button runs its own
// handler, which hides the menu anyway) — so clicking the header/padding closes it too, not just an
// outside click.
function onCornerMenuOutside(e: Event): void {
    if (!cornerMenuEl) return;
    const onButton = e.composedPath().some(n => n instanceof HTMLElement && n.tagName === "BUTTON" && cornerMenuEl!.contains(n));
    if (!onButton) hideCornerMenu();
}
function onCornerMenuKey(e: KeyboardEvent): void { if (e.key === "Escape") hideCornerMenu(); }

// Copy text to the clipboard from the content-script world. Try the async Clipboard API (needs the
// page's clipboard-write permission + this click's transient activation); fall back to a hidden
// textarea + execCommand("copy"), which works even when the page's Permissions-Policy blocks the API.
function copyText(text: string): void {
    try {
        if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text).catch(() => execCopy(text)); return; }
    } catch { /* fall through */ }
    execCopy(text);
}
function execCopy(text: string): void {
    try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
        document.body.append(ta); ta.select();
        document.execCommand("copy"); ta.remove();
    } catch { /* best-effort */ }
}

function showCornerMenu(px: number, py: number, hash?: string, live?: boolean): void {
    if (!cardHost || !cardHost.shadowRoot) return;
    hideCornerMenu();
    const menu = document.createElement("div");
    menu.id = `${SB_CARD}-menu`;
    const item = (label: string, onClick: () => void, tick?: boolean, danger?: boolean): HTMLButtonElement => {
        const b = document.createElement("button");
        if (danger) b.className = "danger";
        const mark = document.createElement("span"); mark.className = "tick"; mark.textContent = tick ? "✓" : "";
        const txt = document.createElement("span"); txt.textContent = label;
        b.append(mark, txt);
        b.addEventListener("click", () => { onClick(); hideCornerMenu(); });
        return b;
    };
    // Quiet toggle: flip the working-pill visibility (agentHud) from wherever you right-clicked — off from
    // the running blob, back on from a finished report / approval. A ticked "Show working pill" = progress.
    menu.append(item("Show working pill", () => chrome.storage.sync.set({ agentHud: agentHud === "quiet" ? "progress" : "quiet" }), agentHud !== "quiet"));
    menu.append(Object.assign(document.createElement("div"), { className: "menu-div" }));
    const head = document.createElement("div"); head.className = "menu-head"; head.textContent = "Move card to…"; menu.append(head);
    for (const [val, label] of CARD_CORNERS)
        menu.append(item(label, () => chrome.storage.sync.set({ cardCorner: val }), cardCorner === val));
    // Run actions (need the live run's hash from the app): copy the id to resume/append later; cancel it.
    if (hash) {
        const div = document.createElement("div"); div.className = "menu-div"; menu.append(div);
        menu.append(item("Copy run id", () => copyText(hash)));
        if (live) menu.append(item("Cancel agent run", () => {
            try { void chrome.runtime.sendMessage({ type: "CANCEL_RUN", payload: { runId: hash } }).catch(() => {}); } catch { /* context gone */ }
        }, false, true));
    }
    // Append FIRST, then measure the REAL size and clamp so it snaps fully into the viewport — a hardcoded
    // height guess let a tall menu (many run actions) get cut off at the bottom of the page.
    cardHost.shadowRoot.append(menu);
    const mw = menu.offsetWidth || 170, mh = menu.offsetHeight || 200, M = 8;
    menu.style.left = `${Math.max(M, Math.min(px, window.innerWidth - mw - M))}px`;
    menu.style.top = `${Math.max(M, Math.min(py, window.innerHeight - mh - M))}px`;
    cornerMenuEl = menu;
    setTimeout(() => {   // defer so the opening right-click doesn't immediately dismiss it
        window.addEventListener("pointerdown", onCornerMenuOutside, true);
        window.addEventListener("keydown", onCornerMenuKey, true);
        window.addEventListener("blur", hideCornerMenu);   // clicking INTO the card iframe blurs the page window
    }, 0);
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
function hideHighlight(): void { hlSeq++; hlKind = ""; lastHlRef = null; if (highlightEl) { highlightEl.remove(); highlightEl = null; } }
// Reposition on scroll/resize: the box/@pt marker is computed from getBoundingClientRect (viewport coords)
// and drawn position:fixed, so a page scroll slides the element out from under a now-frozen box (and an @pt
// off its target). Re-run the LAST highlight — throttled to one frame — so it tracks. Capture-phase catches
// scrolls in nested containers too; a stale async ML_HL_AT reply is ignored by the hlSeq guard.
let lastHlRef: { selector?: string; index?: number; token?: string; kind?: string } | null = null;
let hlReRAF = 0, hlListenersOn = false;
function repositionHighlight(): void {
    if (!lastHlRef || hlReRAF) return;
    hlReRAF = requestAnimationFrame(() => { hlReRAF = 0; if (lastHlRef) showHighlight(lastHlRef); });
}
function ensureHlListeners(): void {
    if (hlListenersOn) return;
    hlListenersOn = true;
    window.addEventListener("scroll", repositionHighlight, true);
    window.addEventListener("resize", repositionHighlight);
}
// Highlight a page target on hover. ELEMENT mode (`selector`): the shell shares the page DOM, so it
// resolves a NATIVE-CSS selector itself. But ml's custom selectors (:contains/:has-text/:eq) throw in
// document.querySelectorAll — so when native resolution fails, fall back to asking injected (main
// world) to resolve it via ml's queryAll, exactly like the @pt/@box token path. POINT/BOX mode
// (`token`): only the main world knows the coords, so it's always resolved by injected.
function showHighlight(ref: { selector?: string; index?: number; token?: string; kind?: string } | null): void {
    if (!ref) return hideHighlight();
    lastHlRef = ref;            // remembered so scroll/resize can recompute (below)
    ensureHlListeners();
    hlKind = ref.kind === "approve" ? "approve" : "";
    const seq = ++hlSeq;
    if (ref.selector) {
        // An ml-DIALECT selector (`>>>` boundary-crossing, or a :contains/:has-text/:eq/text= pseudo)
        // must be resolved by INJECTED (queryAll + viewportRect, which crosses shadow/iframe boundaries and
        // composes the frame offset into a TOP-viewport box). document.querySelectorAll can't parse it — and
        // must not try, so a partial native match can't draw a wrong box for it. Route it straight to injected.
        const mlDialect = /(^|\s)>>>(\s|$)|:contains\(|:has-text\(|:eq\(|(^|[\s>~+])text=/.test(ref.selector);
        let el: Element | null = null;
        if (!mlDialect) try { el = document.querySelectorAll(ref.selector)[ref.index || 0] || null; } catch { el = null; }
        if (el) {
            const r = el.getBoundingClientRect();
            if (!r.width && !r.height) return hideHighlight();   // hidden/collapsed — nothing to show
            return drawHighlight(r.left, r.top, r.width, r.height, `${el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
        // A custom ml selector (or no native match) → let injected resolve it and reply ML_HL_AT.
        window.postMessage({ type: "ML_HL_RESOLVE", selector: ref.selector, index: ref.index || 0, seq }, "*");
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
        const ev = d.__mlDebug;
        // Feed the corner HUD card, when it's active: OFF mode always, DEVTOOLS when the coexist toggle
        // (agentHudInDevtools) is on. The card mounts lazily on a run START (`kind: "agent"`), then
        // buffers until its iframe app handshakes — flushed in order (see the app-ready branch). In off
        // mode the page's bus is dormant so only background-tagged events arrive; in devtools BOTH the
        // page's own injected events (agent start/result) AND the background steps flow.
        if (hudActive()) {
            if (!cardHost && ev.kind === "agent") mountCard();
            if (cardHost) {
                // A genuine new run event (step / result / start) is what discards a transient size
                // override (a user drag, or a "Show work" expand) so the card SNAPS to fit the new
                // content — NOT the noisy ResizeObserver height stream, which mustn't undo a drag.
                if (ev.kind === "agent-step" || ev.kind === "agent-result" || ev.kind === "agent") cardManualH = null;
                if (cardReady) frame?.contentWindow?.postMessage(d, "*");
                else { bgRing.push(d); if (bgRing.length > CARD_RING_MAX) bgRing.shift(); }
            }
        }
        // DEVTOOLS: forward to the panel — but NOT background-origin events (they already reached the
        // panel via relayDebugEvent), else a duplicate. OVERLAY: relay into the in-page iframe app.
        if (mode === "devtools" && !d.__mlFromBg) {
            try { void chrome.runtime.sendMessage({ type: "ML_DEBUG_EVENT", event: ev }).catch(() => {}); } catch { /* context gone */ }
        } else if (mode === "overlay") {
            frame?.contentWindow?.postMessage(d, "*");
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
    // The composer's "start this task": relay it to the PAGE so injected runs a REAL ml.agent() call —
    // a genuine session (hash, resumable, appendable), routed to the background loop in off/devtools mode.
    // Origin-checked (real iframe) for consistency, though this grants nothing the page couldn't already
    // do itself (it has window.ml.agent) — every tool still gates through the unforgeable background gate.
    if (d.__mlSidebarApp === "startRun" && frame && e.source === frame.contentWindow && typeof d.task === "string" && d.task.trim()) {
        // Pass the HUD verbosity so the page picks the right system-prompt hint: quiet → stay silent mid-run;
        // progress → keep between-step prose to one short HUD line (it shows live beside the orb). `model` is
        // the composer's per-call pick (omitted ⇒ the page uses the configured default); `vision:true` is the
        // per-call native-vision override for a non-Ollama model (omitted ⇒ default routing).
        window.postMessage({ __mlStartAgent: {
            task: d.task,
            maxSteps: typeof d.maxSteps === "number" ? d.maxSteps : undefined,
            model: typeof d.model === "string" && d.model.trim() ? d.model.trim() : undefined,
            vision: d.vision === true ? true : undefined,
            hud: agentHud,
        } }, "*");
        return;
    }
    // The session composer: drive a live createAgent session by hash. Relayed to the PAGE, which decides
    // from the handle's live state whether to STEER (say) or start a new turn (run), or cancels the run.
    // Origin-checked (real iframe); reaches only this page's own handle registry — nothing cross-origin.
    if (d.__mlSidebarApp === "sessionSend" && frame && e.source === frame.contentWindow && typeof d.hash === "string" && typeof d.text === "string" && d.text.trim()) {
        window.postMessage({ __mlSessionSend: { hash: d.hash, text: d.text } }, "*");
        return;
    }
    if (d.__mlSidebarApp === "sessionCancel" && frame && e.source === frame.contentWindow && typeof d.hash === "string") {
        window.postMessage({ __mlCancelSession: { hash: d.hash } }, "*");
        return;
    }
    // The off-mode card app tells us its desired visual state (hidden / toast / expanded) — it alone
    // knows whether there's a pending approval or a final answer worth showing. We drive the container's
    // size + reveal (a CSS transition). Origin-checked: only the real card iframe.
    if (typeof d.__mlSidebarCard === "string" && frame && e.source === frame.contentWindow) {
        if (cardWrap) {
            // Frost the acrylic IN on a hidden→visible reveal (the card popping up from nothing). Re-trigger
            // the one-shot animation cleanly: remove the class, force a reflow, re-add it, then clear it after.
            if (cardWrap.dataset.state === "hidden" && d.__mlSidebarCard !== "hidden") {
                cardWrap.classList.remove("ml-materialize");
                void cardWrap.offsetWidth;   // reflow → the animation restarts even if it just ran
                cardWrap.classList.add("ml-materialize");
                clearTimeout(materializeTimer);
                materializeTimer = window.setTimeout(() => cardWrap?.classList.remove("ml-materialize"), 900);
            }
            cardWrap.dataset.state = d.__mlSidebarCard; layoutCard();
        }
        return;
    }
    // The card app reports its TRUE content height (a cross-origin iframe can't auto-size) → fit the card
    // to it, capped. This just tracks the content size; it does NOT touch a manual override (drag /
    // Show-work expand) — that's discarded only on a genuine NEW EVENT (see the card-feed path above) so
    // the noisy ResizeObserver stream can't snap-back-glitch a drag.
    if (typeof d.__mlSidebarCardH === "number" && frame && e.source === frame.contentWindow) {
        cardAutoH = d.__mlSidebarCardH; layoutCard();
        return;
    }
    // The caption pill (orbprose) reports its natural text width so the shell can fit the pill to it (cardW
    // clamps to the max). Only re-layout when we're actually in that state — a stale measurement from a
    // just-finished caption must not resize the expanded/toast card.
    if (typeof d.__mlSidebarCardW === "number" && frame && e.source === frame.contentWindow) {
        cardProseW = d.__mlSidebarCardW;
        if ((cardWrap?.dataset.state || "") === "orbprose") layoutCard();
        return;
    }
    // "Show work" toggled: release any manual drag override and re-fit to the new content (capped) — the
    // trace appearing/disappearing changes the reported content height, so it slides to exactly fit (a
    // short trace stops at its content, a long one caps + scrolls). No forced max → no empty space.
    if (typeof d.__mlSidebarCardExpand === "boolean" && frame && e.source === frame.contentWindow) {
        cardManualH = null;
        layoutCard();
        return;
    }
    // Grab-drag the HUD: the app pointer-captures the pill/head (works for mouse AND touch) and streams
    // movement DELTAS (frame-independent — the moving iframe can't shift them under itself). We move the
    // container 1:1 (no-anim), then on drop snap to the NEAREST corner (animated) and persist it.
    if (d.__mlSidebarCardGrab && cardWrap && frame && e.source === frame.contentWindow) {
        const r = cardWrap.getBoundingClientRect();
        cardDrag = { left: r.left, top: r.top };
        // The grab landed at (gx,gy) within the card (iframe-local ≈ card-local). Remember the cursor's
        // page position and the fraction it grabbed, so `move` can keep that point under the cursor even
        // when the card resizes (pill→orb) mid-drag.
        const g = d.__mlSidebarCardGrab as { gx?: number; gy?: number };
        const gx = g && typeof g === "object" ? (g.gx || 0) : 0;
        const gy = g && typeof g === "object" ? (g.gy || 0) : 0;
        dragCursor = { x: r.left + gx, y: r.top + gy };
        dragFrac = { fx: r.width ? gx / r.width : 0.5, fy: r.height ? gy / r.height : 0.5 };
        cardWrap.classList.add("no-anim");
        // Arm the escaped-pointer safety net (see the handlers). Named fns → re-arming is idempotent.
        window.addEventListener("pointermove", onWinDragMove, true);
        window.addEventListener("pointerup", onWinDragEnd, true);
        window.addEventListener("pointercancel", onWinDragEnd, true);
        return;
    }
    if (d.__mlSidebarCardMove && cardDrag && dragCursor && dragFrac && cardWrap && frame && e.source === frame.contentWindow) {
        const w = cardWrap.offsetWidth, h = cardWrap.offsetHeight;
        // Track the true cursor by the deltas, then place the card so the grabbed FRACTION of the CURRENT
        // size sits under it. When the pill has collapsed to the orb, fx·(orb width) is tiny, so the orb
        // ends up under the cursor rather than pinned to the old wide-pill top-left.
        dragCursor.x += d.__mlSidebarCardMove.dx || 0;
        dragCursor.y += d.__mlSidebarCardMove.dy || 0;
        cardDrag.left = Math.max(6, Math.min(window.innerWidth - w - 6, dragCursor.x - dragFrac.fx * w));
        cardDrag.top = Math.max(6, Math.min(window.innerHeight - h - 6, dragCursor.y - dragFrac.fy * h));
        layoutCard();
        return;
    }
    if (d.__mlSidebarCardDrop && frame && e.source === frame.contentWindow) {
        finalizeCardDrag();   // snap to the nearest corner (shared with the window-level safety net)
        return;
    }
    // The card app asks us to focus its iframe (an approval appeared) so Enter/Esc work without a click.
    // Moving focus is harmless — the page still can't inject a trusted keypress into this cross-origin
    // extension frame — so the keyboard gate stays unforgeable.
    if (d.__mlSidebarCardFocus && frame && e.source === frame.contentWindow) {
        try { frame.focus(); } catch { /* ignore */ }
        return;
    }
    // Right-clicked the card/pill → draw the "move to corner" menu here (the iframe would clip it). The
    // coords are iframe-local; offset by the frame's page position.
    if (d.__mlSidebarCornerMenu && frame && e.source === frame.contentWindow) {
        const r = cardWrap?.getBoundingClientRect();
        const m = d.__mlSidebarCornerMenu;
        showCornerMenu((r?.left || 0) + (m.x || 0), (r?.top || 0) + (m.y || 0), typeof m.hash === "string" ? m.hash : "", !!m.live);
        return;
    }
    // The card was clicked while the menu is open (a click INSIDE the iframe can't reach the shell's own
    // outside-click handler, and the page window was already blurred by the opening right-click — so the
    // card signals the dismissal itself). Origin-checked: only the real card iframe.
    if (d.__mlSidebarCornerMenuDismiss && frame && e.source === frame.contentWindow) {
        hideCornerMenu();
        return;
    }
    // The iframe app is listening. When it's the CARD (off mode, OR devtools with the coexist toggle),
    // tell it it's the card surface and flush the events buffered while its iframe loaded — do NOT
    // re-handshake injected here (in off mode its bus is fed by the background stream; in devtools it was
    // already handshaked by attach(true)). OVERLAY: handshake injected.js + hand it the open state.
    if (d.__mlSidebarApp === "ready" && frame && e.source === frame.contentWindow) {
        if (hudActive()) {
            cardReady = true;
            frame.contentWindow?.postMessage({ __mlSidebarSurface: "card" }, "*");
            for (const ev of bgRing) frame.contentWindow?.postMessage(ev, "*");
            bgRing.length = 0;
            if (composerPendingOpen) { composerPendingOpen = false; frame.contentWindow?.postMessage({ __mlSidebarComposer: "open" }, "*"); try { frame.focus(); } catch { /* ignore */ } }
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
    applyCardTheme();    // acrylic follows the app's resolved theme, not the OS
    applyCardCorner();   // anchor to the configured corner
    frame = document.createElement("iframe");
    frame.id = `${SB_CARD}-frame`;
    frame.allow = "clipboard-write";
    frame.src = chrome.runtime.getURL("sidebar.html");
    const handle = document.createElement("div");
    handle.id = `${SB_CARD}-resize`;
    handle.title = "Drag to resize · double-click to auto-fit";
    handle.addEventListener("pointerdown", startCardResize);
    handle.addEventListener("dblclick", () => { cardManualH = null; layoutCard(); });   // back to auto-fit
    cardWrap.append(frame, handle);
    root.append(cardWrap);
    (document.documentElement || document.body).append(cardHost);
    layoutCard();   // position the (hidden) card at its corner up front, so the first reveal FLIES from there
}
function unmountCard(): void {
    if (!cardHost) return;
    hideCornerMenu();
    cardHost.remove();
    cardHost = cardWrap = frame = null;   // `frame` is the card iframe in off mode
    cardReady = false;
    composerPendingOpen = false;
    bgRing.length = 0;
}

// The Spotlight command bar: mount the HUD card on demand (even with no run) and tell its app to open
// the composer, so the user can START a run from the keyboard. Buffered until the iframe handshakes.
// Only where the HUD lives (off / devtools-coexist) — overlay has its own surface (a follow-up).
let composerPendingOpen = false;
function openComposer(): void {
    if (!hudActive()) return;
    if (!cardHost) mountCard();
    if (cardReady && frame) { frame.contentWindow?.postMessage({ __mlSidebarComposer: "open" }, "*"); try { frame.focus(); } catch { /* ignore */ } }
    else composerPendingOpen = true;   // flushed on the app's `ready`
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
function applyCardCorner(): void { if (cardWrap) { cardWrap.dataset.corner = cardCorner; layoutCard(); } }   // re-anchor + animate to it
themeMedia?.addEventListener("change", applyCardTheme);   // "auto" follows the OS
// Keep the card pinned to its corner / centred when the viewport resizes (position is computed, not CSS-anchored).
window.addEventListener("resize", () => { if (cardWrap) layoutCard(); });

chrome.storage.sync.get({ debugMode: "off", theme: "auto", cardCorner: "bottom-right", agentHud: "progress", agentHudInDevtools: false }, (cfg) => {
    rawTheme = (cfg.theme as string) || "auto";
    cardCorner = (cfg.cardCorner as string) || "bottom-right";
    agentHud = (cfg.agentHud as string) || "progress";
    agentHudInDevtools = !!cfg.agentHudInDevtools;
    applyMode(cfg.debugMode as DebugMode);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.theme) { rawTheme = (changes.theme.newValue as string) || "auto"; applyCardTheme(); }
    if (changes.cardCorner) { cardCorner = (changes.cardCorner.newValue as string) || "bottom-right"; applyCardCorner(); }
    if (changes.agentHud) agentHud = (changes.agentHud.newValue as string) || "progress";
    if (changes.agentHudInDevtools) {
        agentHudInDevtools = !!changes.agentHudInDevtools.newValue;
        // Turned OFF while a devtools card is up → drop it (turning ON takes effect on the next run).
        if (!hudActive() && cardHost) unmountCard();
    }
    if (changes.debugMode) applyMode((changes.debugMode.newValue || "off") as DebugMode);
});

// DevTools-panel hover-highlight (the reverse channel). The panel can't touch the inspected
// page, so its app's __mlHighlight is relayed panel → background → here (ML_HL_REMOTE), and we
// draw the box in this content script (which DOES share the page DOM). Only in devtools mode —
// the overlay gets highlights straight from its own iframe via window-message. Read-only (a
// pointer-events:none box, no page mutation), so even a spurious relay is harmless.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "ML_HL_REMOTE" && mode === "devtools") showHighlight(msg.ref || null);
    // The Spotlight shortcut (background `commands` → this tab). Open the HUD composer; no-op unless the
    // HUD is the active surface (off / devtools-coexist).
    else if (msg?.type === "ML_OPEN_COMPOSER") openComposer();
    // DevTools session composer (panel → background → here): relay to the PAGE, which drives the handle
    // by hash (steer/run/cancel). Any mode — the page's handle registry is what acts, not this shell.
    else if (msg?.type === "ML_SESSION_TO_PAGE") {
        if (msg.action === "send") window.postMessage({ __mlSessionSend: { hash: msg.hash, text: msg.text } }, "*");
        else if (msg.action === "cancel") window.postMessage({ __mlCancelSession: { hash: msg.hash } }, "*");
    }
});
