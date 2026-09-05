// The off-mode HUD "card" surface + the Spotlight composer. When debug is OFF but a privileged ml.agent
// run must be gated, the run routes through the background and streams here into a small acrylic corner
// card (mounted by the shell) — a CURATED view of the same session data (approval + answer), hiding the
// debug detail. It reuses the exact run-render components (ToolStep / AgentTurn / ReplyBubble). Also hosts
// the multi-run tab strip, the working orb + drag, and the Commander composer. Extracted from app.tsx —
// the top of the view tree (imports the run/composer/summary layers; nothing imports it but app).
import { useState, useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { isBackendUnreachable } from "../contract";
import { sessionMap, rev, view, config, backendError, cardShowWorkHash, surface } from "./store";
import type { Session, AgentStep } from "./store";
import { truncate, markdown } from "./format";
import { residentNow } from "./vram";
import { orbStatus } from "./orb-status";   // the orb's live status projection (humanized tool phase + live token count + stall heartbeat)
import { exportSession, printSession } from "./export";
import { IconChevron, IconWarn, IconSend } from "./icons";
import { AnswerMediaGallery, ContextMenu, clearHighlight, decideGate, decidedSteps, stepKey } from "./ui-kit";
import { ReplyBubble } from "./reply";
import { AgentTurn, ToolStep, GrantCard, hasPersistGrants, KEEP_HINT } from "./agent-detail";
import { AnswerBody, ResultBlock } from "./answer-render";
import { useImageAttach, ThumbStrip } from "./composer";
import {
    cardSelectedHash, cardDetail, cardSteerHash, cardMaximizedHash, isCardCollapsed, setCardCollapsed, dismissCardRun,
    composerOpen, composerElement, composerTarget, composerStarting,
    orbHover, isPendingGate, runIsDone, runIsPending, cardRuns, selectedRun, ensureCardTitle,
} from "./card-state";
import { ApprovalBody } from "./card-approval";
import { ShowWork } from "./card-showwork";
import { ComposerCard } from "./card-composer";

/* ------------------------------ off-mode card ----------------------------
 * The "card" surface. When debug is OFF but a privileged ml.agent run must be
 * gated, the run routes through the background and streams here into a small
 * acrylic corner CARD (mounted by the shell). It's a CURATED view of the SAME
 * session data — the approval to act on and the final answer — hiding the debug
 * detail (thinking, auto-approved steps, options, VRAM/polling). It reuses the
 * exact render components (ToolStep, ReplyBubble, markdown), so a decision here is
 * identical to the sidebar's and rides the same unforgeable SET_APPROVAL path
 * (this IS the extension iframe). The shell tells us we're the card via
 * `__mlSidebarSurface`; we tell the shell our size/reveal via `__mlSidebarCard`.
 */


// Right-click the card/pill → ask the shell to draw the "move to corner" menu (drawn shell-side so the
// tiny pill iframe can't clip it). Coords are iframe-local; the shell offsets by the frame's position.
// Carry the run hash (for Copy run id / Cancel) + whether it's still live (Cancel only shows then).
export const cardCtxMenu = (e: any) => {
    e.preventDefault();
    const run = selectedRun();
    const live = !!run && run.summary == null && !run.error;
    window.parent.postMessage({ __mlSidebarCornerMenu: { x: e.clientX, y: e.clientY, hash: run?.hash || "", live } }, "*");
    armMenuDismiss();
};
// Grab-drag the HUD: stream movement DELTAS to the shell, which moves the container and snaps to the
// nearest corner on release. A click (movement below a small threshold) is left alone, so buttons /
// toast-expand still fire. CRITICAL: capture + listen on a STABLE element (documentElement), NOT the
// grab element — the orb/pill/head re-renders on every agent event mid-drag, and a capture/listener bound
// to it would be orphaned the instant it's swapped (the "stuck, can't grab, mouse-is-a-magnet" bug: the
// drop never fires so it never snaps). documentElement is never re-rendered; capture keeps the moves
// flowing even when the pointer leaves the tiny orb iframe.
// Heartbeat: a 1s tick that advances the orb's elapsed "· Ns" liveness readout during a stall (a run that's
// gone quiet — no events to re-render it otherwise). Holds the latest tick timestamp; CardApp reads it (so a
// tick re-renders the orb) and gates the interval to only run while the orb is up, so no timer leaks/spins
// when idle. The 90ms-throttled stream deltas already re-render fast enough on their own; this covers silence.
const nowTick = signal(0);

let orbDragging = false;   // true during an active drag → suppress the hover-capsule so it can't resize mid-drag
// Cleanup for the CURRENT card drag (removes its listeners + resets orbDragging/orbHover). Held at module
// scope so a new drag can force-end a prior stuck one, and the shell's window-level safety net can end it
// via __mlSidebarCardEndDrag when a fast flick escaped the iframe and the in-iframe pointerup never fired.
export let endActiveCardDrag: (() => void) | null = null;
// Hover the orb → stretch to the labelled capsule. Only collapse on a REAL leave: resizing the container
// under a stationary pointer makes the browser fire a SPURIOUS pointerleave (the pointer is still
// physically inside the box), which was closing the capsule the instant it opened. So on leave we check
// the pointer's actual position against the element's box and IGNORE it when it's still inside; a small
// hysteresis timer on genuine leaves lets a quick re-enter cancel the collapse.
let orbLeaveTimer = 0;
// Hover-to-capsule is DISARMED right after a drag: the orb must land as a plain CIRCLE, not snap open just
// because the cursor happens to be sitting on it where it landed. A genuine leave+re-enter re-arms it, so a
// deliberate hover still expands. (Set false in the drag cleanup; set true on a real pointerleave.)
let orbHoverArmed = true;
/** Pointer entered the orb — expand it, unless a drag is in progress or hover is disarmed. */
export const orbEnter = () => { if (orbDragging || !orbHoverArmed) return; clearTimeout(orbLeaveTimer); orbHover.value = true; };
/** Pointer left the orb — collapse it after a grace period, so crossing a gap does not close it. */
export const orbLeave = (e: any) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;   // spurious (resize) — pointer still inside
    orbHoverArmed = true;   // a real leave → the next enter is a deliberate hover, allow it to expand again
    clearTimeout(orbLeaveTimer);
    orbLeaveTimer = window.setTimeout(() => { orbHover.value = false; }, 140);
};
/** Begin dragging the HUD card — it snaps to whichever corner you let go nearest. */
export const startCardDrag = (e: any) => {
    if (e.button != null && e.button !== 0) return;                                          // left / touch only
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .seg")) return;       // not on a control
    // Clean up any PRIOR drag whose pointerup never reached us (a fast flick escapes the tiny iframe before
    // it catches up → capture is lost → `up` never fires). Without this, its `move` listener stays attached
    // and the NEXT drag posts DOUBLE moves → the orb "runs away". The shell's window-level safety net (below)
    // also force-ends it, but starting fresh is the belt to that suspenders.
    endActiveCardDrag?.();
    const cap = document.documentElement;
    const startX = e.clientX, startY = e.clientY, pid = e.pointerId;
    let dragging = false;
    const cleanup = () => {
        cap.removeEventListener("pointermove", move);
        cap.removeEventListener("pointerup", up);
        cap.removeEventListener("pointercancel", up);
        if (endActiveCardDrag === cleanup) endActiveCardDrag = null;
        if (dragging) { dragging = false; orbDragging = false; }
        // Settle the orb back to the CIRCLE after a drag AND disarm hover-expand: it must LAND as a circle,
        // not immediately re-expand because the cursor is sitting on where it landed (the "lands expanded
        // then collapses" jank). A real leave+re-enter re-arms it, so a deliberate hover still opens it.
        orbHover.value = false;
        orbHoverArmed = false;
    };
    const move = (ev: any) => {
        if (!dragging) {
            if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;   // threshold → still a click
            dragging = true; orbDragging = true; orbHover.value = false;                      // no hover-resize mid-drag
            try { cap.setPointerCapture(pid); } catch { /* older engines */ }
            // Send WHERE in the card the grab landed (iframe-local ≈ offset from the card's top-left, since
            // the iframe fills the wrap). The shell keeps that fractional point under the cursor across a
            // mid-drag size change (pill→orb) so the collapsed orb lands UNDER the cursor, not at the edge.
            window.parent.postMessage({ __mlSidebarCardGrab: { gx: ev.clientX, gy: ev.clientY } }, "*");
        }
        window.parent.postMessage({ __mlSidebarCardMove: { dx: ev.movementX, dy: ev.movementY } }, "*");
    };
    const up = () => {
        const wasDragging = dragging;
        cleanup();
        if (!wasDragging) return;
        window.parent.postMessage({ __mlSidebarCardDrop: true }, "*");
        // A drag must CANCEL the click that fires after pointerup — otherwise dropping a dragged toast
        // also triggers its onClick (expand). Swallow the next click in the CAPTURE phase (before the
        // element's handler); a timeout clears it if no click follows (some engines skip it after capture).
        const swallow = (ce: Event) => { ce.stopPropagation(); clear(); };
        const clear = () => window.removeEventListener("click", swallow, true);
        window.addEventListener("click", swallow, true);
        setTimeout(clear, 350);
    };
    endActiveCardDrag = cleanup;
    cap.addEventListener("pointermove", move);
    cap.addEventListener("pointerup", up);
    cap.addEventListener("pointercancel", up);
};
// The corner menu is drawn in the SHELL (top document), but the right-click that opened it happened
// inside THIS iframe — so the page window was already blurred and a later in-card click fires no new
// blur, nor does its pointerdown reach the shell's outside-click handler. So the NEXT pointerdown in the
// card tells the shell to dismiss the menu. Single-armed so repeated right-clicks don't stack listeners.
let menuDismissArmed = false;
/** Close the card's menu on the next click outside it. */
export function armMenuDismiss(): void {
    if (menuDismissArmed) return;
    menuDismissArmed = true;
    window.addEventListener("pointerdown", () => {
        menuDismissArmed = false;
        window.parent.postMessage({ __mlSidebarCornerMenuDismiss: true }, "*");
    }, { once: true, capture: true });
}

// "Show work" — the audit trail under a finished card. The card already HAS the whole trace (run.steps),
// it just hides it; this re-renders it with the SAME components the debug sidebar uses (AgentTurn →
// ToolStep). Collapsed by default; a finished run has no awaiting gate, so no approve buttons appear.


// The liquid tool ORB — the working HUD balled into a circle showing the active-tool emoji. On HOVER it
// RESHAPES: the blob stretches into a capsule that spells out what it's doing ("👁 Looking at the
// screen…") — the shell springs the container wider, the label fades in. Draggable + right-click move
// like every HUD state. (Emoji for now; a looping custom SVG per tool slots into `.card-orb-ic` later.)
export function Orb({ icon, label, suffix, wide, prose }: { icon: string; label: string; suffix?: string; wide: boolean; prose?: boolean }) {
    return (
        <div class="card-app" data-rev={rev.value}>
            <div class={`card-orb${wide ? " wide" : ""}${prose ? " prose" : ""}`}
                onPointerEnter={orbEnter} onPointerLeave={orbLeave}
                onPointerDown={startCardDrag} onContextMenu={cardCtxMenu}
                title={prose ? label + (suffix || "") : undefined}>
                <span class="card-orb-ic" aria-hidden="true">{icon}</span>
                {/* The label ellipsizes; the live readout does NOT. Two spans rather than one string because
                    the pill cuts on width, and concatenated it cut the number — the one part still saying
                    something — leaving "· 1…" where "· 10s" was the whole point. */}
                {wide ? <span class="card-orb-label">{label}</span> : null}
                {wide && suffix ? <span class="card-orb-live">{suffix}</span> : null}
            </div>
        </div>
    );
}

// The concurrency tab strip: one tab per card-worthy run, shown only when >1 run is live (single run =
// no strip). Each tab carries a status glyph (amber-pulse dot = awaiting approval · spinner = running ·
// ✓/✗ = done/failed), the run's title, and a × to drop it from the HUD. Clicking selects (manual pick,
// which selectedRun then honours over the pending/latest default). Its own pointer handlers stopProp so
// a tab click/dismiss never starts the card drag underneath.
export function CardTabs({ runs, selected }: { runs: Session[]; selected?: string }) {
    return (
        <div class="card-tabs" role="tablist" onPointerDown={e => e.stopPropagation()}>
            {runs.map(s => {
                const pend = runIsPending(s), fin = runIsDone(s);
                const bad = !!s.error || !!s.cancelled;
                const glyph = pend ? <span class="card-tab-dot pend" aria-hidden="true" />
                    : fin ? <span class={`card-tab-fin${bad ? " bad" : ""}`} aria-hidden="true">{bad ? "✗" : "✓"}</span>
                        : <span class="card-tab-spin" aria-hidden="true" />;
                return (
                    <div class={`card-tab${s.hash === selected ? " on" : ""}${pend ? " pend" : ""}`} role="tab"
                        aria-selected={s.hash === selected} title={s.title || s.task || "Agent run"}
                        onClick={e => { e.stopPropagation(); cardSelectedHash.value = s.hash; }}>
                        {glyph}
                        <span class="card-tab-label">{s.title || truncate(s.task || "Run", 22)}</span>
                        <button class="card-tab-x" aria-label="Dismiss run"
                            onPointerDown={e => { e.stopPropagation(); e.preventDefault(); dismissCardRun(s.hash); }}
                            onClick={e => e.stopPropagation()}>✕</button>
                    </div>
                );
            })}
        </div>
    );
}

/** THE HUD CARD — the corner surface an off-mode run lives in: the composer, live progress, approval
 *  gates and the completion card, over the page rather than in a panel. Reuses the sidebar's own
 *  components, so what you read there is what you read here. */
export function CardApp() {
    const r = rev.value;   // subscribe to session changes (retained via data-rev below)
    const composing = composerOpen.value;   // Spotlight bar open → the HUD morphs into the task input
    const runs = cardRuns();               // all card-worthy concurrent runs (for the tab strip)
    const run = selectedRun();             // the ONE run whose card is showing (see selectedRun: user pick, else pending, else latest)
    const hash = run?.hash;
    const showWork = !!hash && cardShowWorkHash.value === hash;   // active run's trace open? (subscribe → re-measure height on toggle)
    const pendingStep = run ? (run.steps || []).find(st => isPendingGate(run.hash, st)) : undefined;
    const pending = !!pendingStep;
    // Terminal ONLY when the run isn't mid-turn: a follow-up run() keeps the PRIOR summary set, so without
    // the status guard `done` would stay true and the card would show the stale answer instead of collapsing
    // to the working orb. status flips to "pending" on a new turn (optimistically in CardReply, and on any
    // agent-step) and back to ok/err on the next agent-result.
    const done = !!run && runIsDone(run);
    const tabs = runs.length > 1;          // >1 card-worthy run → show the tab strip (single run = today's look)
    // Is there any run with a CARD to reach (an approval or a finished answer)? When several runs are
    // merely working, we keep the bare orb (it narrates the last op across runs — selectedRun returns the
    // latest-active, so the caption already reflects whichever run just stepped); tabs only take over once
    // a run has content worth switching to, so the answer/approval is reachable.
    const anyContent = runs.some(s => runIsPending(s) || runIsDone(s));
    // BRIDGE: the composer was just sent but the run's first event hasn't surfaced yet — show a
    // "Starting…" pill immediately (so hitting Enter has an instant HUD response, like the DevTools
    // panel), overriding any older run. Cleared once the new run (createdTs ≥ the send time) appears.
    const startedAt = composerStarting.value;
    const newRunUp = !!run && (run.createdTs || 0) >= startedAt;
    const starting = startedAt > 0 && !newRunUp;
    // In flight the INSTANT the run starts (thinking, before any tool step) → the pill shows right away.
    // "quiet" HUD mode still suppresses the idle/working pill (the card only surfaces for approvals/answers).
    const running = !!run && !pending && !done;
    const quiet = config.value.agentHud === "quiet";
    // A `silent` run (ml.agent({ silent: true })) is a scripting utility: keep it OUT of the HUD — no
    // working orb, no answer card. Approvals STILL surface (privileged consent can't be silenced), so
    // `pending` below is unaffected; only the ambient orb + the finished-answer card are suppressed.
    const silent = !!run?.agentConfig?.silent;
    const showOrb = (running || starting) && !quiet && !silent;
    const hovering = orbHover.value;                           // hovering the orb → stretch to a labelled capsule
    // Live prose: the model's between-step narration (its `thought`, NOT the hidden reasoning). In PROGRESS
    // mode it auto-expands the orb into a caption pill so you see what it's doing without hovering; QUIET
    // suppresses it (the run is already !showOrb there). Not for the "Starting…" bridge (no run steps yet).
    // The orb's live status — humanized tool phase ("Running Python…" / "Thinking about the Python output…"),
    // decorated with a live token count while streaming or an elapsed heartbeat once it stalls. Reading
    // nowTick subscribes this render to the 1s heartbeat so a stall's elapsed advances; the ticker is gated
    // below to only run while the orb is up. `caption` = there's live detail worth auto-expanding for.
    // Is this run's model actually LOADED? The resource panel already polls /api/ps, so the orb can say
    // "Awakening…" instead of claiming a model that is still being read off disk is thinking. `undefined`
    // when we have no residency data at all — then it makes no claim either way.
    const orb = (showOrb && !starting) ? orbStatus(run!, nowTick.value || Date.now(), residentNow(run!.model)) : null;
    // Orb-steer: while a run is LIVE and its steer box is open, force the card OPEN (out of the orb) so the
    // input is reachable. Only meaningful for a running run — it self-clears the instant the run finishes.
    const steering = !!run && running && cardSteerHash.value === run.hash;
    // The final answer is STREAMING (stream:true) → open the card so the answer FILLS IN live, instead of the
    // orb popping the finished answer all at once. Only for the reply phase (liveStream.content) — the pure
    // thinking phase keeps the calm orb + its narration caption. Respects quiet/silent (those suppress the card).
    const streamingAnswer = !!run?.liveStream?.content && !quiet && !silent;
    const state = composing ? "composer"                       // the composer takes over — centered Spotlight bar
        : steering ? "expanded"                                // steering a live run: open the card for the inline steer box
        : pending ? "expanded"                                 // an approval: show the action directly (even for a silent run)
        : streamingAnswer ? "expanded"                         // the answer is streaming in → open the card to show it live
            : (tabs && anyContent) ? (cardDetail.value ? "expanded" : "toast")   // multi-run with content: tabbed detail ⇄ calm summary toast (one card-level toggle)
                : showOrb ? (orb?.caption ? "orbprose" : hovering ? "orblabel" : "orb")   // in flight → orb; auto-caption when there's live detail (streaming tokens / narration / stall); capsule on hover
                    : (done && !silent) ? (isCardCollapsed(run!.hash) ? "toast" : (cardMaximizedHash.value === run!.hash ? "maximized" : "expanded"))   // single finished run: the answer — MAXIMISED into a corner window when toggled
                        : "hidden";

    // Clear a STALE hover whenever we're not showing the orb — the orb can unmount while hovered (the
    // composer opens over it, an approval expands) and then no pointerleave fires, which would wrongly
    // reopen the capsule (orblabel) when the orb next appears (e.g. the "Starting…" bridge). So a fresh
    // orb always starts circular until a real pointerenter.
    useEffect(() => { if (state !== "orb" && state !== "orblabel" && state !== "orbprose") orbHover.value = false; }, [state]);
    // Heartbeat: while the orb is up, tick once a second so a STALLED run's elapsed "· Ns" advances even when
    // no events arrive to re-render it (the "did it hang?" case). Gated on showOrb + cleaned up, so no timer
    // runs — or leaks (jsdom) — when idle/done. Streaming runs already re-render on their 90ms deltas; this is
    // the silence cover. (An answer that's streaming — state "expanded" — fills in live on its own, no tick.)
    useEffect(() => {
        if (!showOrb) return;
        const id = window.setInterval(() => { nowTick.value = Date.now(); }, 1000);
        return () => clearInterval(id);
    }, [showOrb]);
    // Close the steer box once the run is no longer live (it finished / failed / was cancelled) — the box is
    // meaningless without a running loop, and this snaps the card to its finished-answer form cleanly.
    useEffect(() => { if (!running && cardSteerHash.value === run?.hash) cardSteerHash.value = ""; }, [running]);
    // A FOLLOW-UP turn just started (was done, now working again — there's prior conversation): collapse an
    // OPEN "Show work" for this run. Otherwise the prior turn's expanded trace looms over the streaming answer
    // and reflows spammily as it fills in, then snaps away when the run settles. Collapsing matches that clean
    // end-state from the start; the trace is one click away. Only fires when it was actually open on THIS run.
    useEffect(() => {
        if (running && run && cardShowWorkHash.value === run.hash && (run.answers?.length || run.says?.length)) cardShowWorkHash.value = "";
    }, [running]);
    // An approval opens the tabbed DETAIL (a multi-run summary would hide the action), and stays open through
    // the decision so the outcome is visible instead of snapping back to the calm summary.
    useEffect(() => { if (pending) cardDetail.value = true; }, [pending]);
    useEffect(() => { if (startedAt > 0 && newRunUp) composerStarting.value = 0; }, [newRunUp]);   // run surfaced → drop the bridge
    useEffect(() => { if (run) ensureCardTitle(run); }, [hash, r]);
    // No reset effect needed — show-work is keyed by hash, so a new run is collapsed by default (its hash
    // isn't the open one). "Show work" open → ask the shell to slide the card to the drag limit (room for the
    // whole trace); closed → release it (snap back to fit). Driven by the ACTIVE run's derived open state.
    useEffect(() => { window.parent.postMessage({ __mlSidebarCardExpand: showWork }, "*"); }, [showWork]);
    // Report our natural CONTENT height so the shell can FIT the card (a cross-origin iframe can't
    // auto-size). We sum the card's children — head + body(scrollHeight = full content) + foot — NOT
    // documentElement.scrollHeight: the app fills the iframe (height:100%), so measuring the container
    // would feed its own clamped height back (an oscillation). The shell caps this to the viewport and
    // the body scrolls. Measured after two frames (fonts/highlighting settle) + on later async growth.
    useEffect(() => {
        const post = () => {
            const app = document.querySelector(".card-app") as HTMLElement | null;
            if (!app) { window.parent.postMessage({ __mlSidebarCardH: Math.ceil(document.documentElement.scrollHeight) }, "*"); return; }
            // Sum each child's TRUE height. `.card-body` is flex:1, so a user drag inflates its clientHeight
            // (and thus scrollHeight) to fill the taller container — measuring that would report the dragged
            // size as "content" and the shell would snap-back-glitch (the drag looks like a content change).
            // So for card-body measure its own children + padding, which is the real content regardless of
            // how tall the container was dragged.
            let h = 0;
            for (const c of Array.from(app.children) as HTMLElement[]) {
                if (c.classList.contains("card-body")) {
                    const cs = getComputedStyle(c);
                    let inner = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth || "0") + parseFloat(cs.borderBottomWidth || "0");
                    for (const kid of Array.from(c.children) as HTMLElement[]) {
                        const ks = getComputedStyle(kid);
                        inner += kid.scrollHeight + parseFloat(ks.marginTop) + parseFloat(ks.marginBottom);
                    }
                    h += inner;
                } else h += c.offsetHeight;   // offsetHeight (NOT scrollHeight) so head/foot BORDERS count — else
                                              // the posted height is ~2px short and card-body shows a spurious scrollbar
            }
            // +2px slack: sub-pixel rounding of each child's height can still leave card-body ~1px short of its
            // content (a faint scrollbar). The pad is invisible but guarantees the content never overflows.
            window.parent.postMessage({ __mlSidebarCardH: Math.ceil(h) + 6 }, "*");
            // Caption pill: report its NATURAL width so the shell fits the pill to the text (up to a max, then
            // the label ellipsizes). Measure the label's real glyph extent with a Range — the label has
            // overflow:hidden + a flex width, so its offsetWidth/scrollWidth is clamped to the CURRENT pill and
            // wouldn't shrink for a short line; a Range over the text reports the true layout width regardless.
            const orb = app.querySelector(".card-orb.prose") as HTMLElement | null;
            const lbl = orb?.querySelector(".card-orb-label") as HTMLElement | null;
            // Guarded: Range.getBoundingClientRect is a layout call (unavailable under jsdom, and a hostile
            // environment could throw) — a measurement failure must never abort the effect and strand the
            // state post below it. The shell falls back to the fixed orbprose width when no width arrives.
            if (orb && lbl && lbl.firstChild) try {
                const range = document.createRange();
                range.selectNodeContents(lbl);
                const textW = range.getBoundingClientRect().width;
                const cs = getComputedStyle(orb);
                const ic = orb.querySelector(".card-orb-ic") as HTMLElement | null;
                const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + (parseFloat(cs.columnGap || cs.gap) || 9) + (ic?.offsetWidth || 20);
                if (textW > 0) window.parent.postMessage({ __mlSidebarCardW: Math.ceil(chrome + textW) + 4 }, "*");
            } catch { /* no layout available (jsdom) → shell uses the fixed orbprose width */ }
        };
        post();
        requestAnimationFrame(() => requestAnimationFrame(post));
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(post);
        ro.observe(document.body);
        return () => ro.disconnect();
        // `showWork`: the ResizeObserver can't catch a Show-work toggle (the iframe body is height-pinned
        // by the shell, so content growth doesn't resize body) — so re-measure explicitly on the toggle.
    }, [state, r, showWork]);
    // Post the STATE *after* the height effect (both fire on a state change; effects run in definition
    // order). So on orb→expanded the shell learns the new content's height FIRST (silently — the orb uses a
    // fixed size), then applies "expanded" with the fresh cardAutoH. Posting state first made it lay out the
    // expanded card at the STALE height (the previous run's, or the 200px default) → it opened 2-3× too tall
    // then snapped down — the "elastic jump". Height-then-state removes the overshoot.
    useEffect(() => { window.parent.postMessage({ __mlSidebarCard: state }, "*"); }, [state]);
    // Keyboard: Enter approves, Esc denies — but ONLY from a real keydown INSIDE this trusted iframe (a
    // page-side global hotkey routed in would reopen the forgery hole, so we deliberately don't do that).
    // We ask the shell to focus the card frame when an approval appears, so the keys work without a click.
    useEffect(() => {
        if (!run || !pendingStep || pendingStep.seq == null) return;
        const h = run.hash, seq = pendingStep.seq;
        const canKeep = hasPersistGrants(pendingStep.grants);
        window.parent.postMessage({ __mlSidebarCardFocus: true }, "*");
        const decideKey = (ok: boolean, persist = false) => { decidedSteps.add(stepKey(h, seq)); clearHighlight(); void decideGate(pendingStep, h, seq, ok, persist); rev.value++; };
        const onKey = (e: KeyboardEvent) => {
            // Enter approves; Esc denies; KEEP is a deliberate two-key combo (⌘/Ctrl+K) — intentionally NOT
            // Enter-adjacent, so granting a session-long fetch permission can't be a slip of the Approve key.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { if (canKeep) { e.preventDefault(); decideKey(true, true); } }
            else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); decideKey(true); }
            else if (e.key === "Escape") { e.preventDefault(); decideKey(false); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [pending, pendingStep?.seq]);

    if (composing) return <ComposerCard />;   // the blob reshapes into the task input (container morphs shell-side)
    // Backend GONE: a run that's still "starting"/"working" against a dead box would otherwise hang on the
    // "Starting…" orb with no signal (the reported bug). The proactive health probe set backendError → show it
    // plainly. A finished run keeps its own card (a completed run's error already shows via card-error-offline);
    // an approval gate stays visible too. `boDown` is exactly the in-between: not done, not gated.
    const boDown = !!backendError.value && !done && !pending;
    if (boDown) {
        if (state === "orb" || state === "orblabel") return <Orb icon="⚠" label="Backend down" wide />;
        return (
            <div class="card-app offline" data-rev={r}>
                <div class="card-head"><span class="card-head-txt">Backend unreachable</span></div>
                <div class="card-body"><div class="card-error card-error-offline"><IconWarn /> {backendError.value}</div></div>
            </div>
        );
    }
    // The just-sent "Starting…" bridge orb (before the run's first event) — the composer balled up and flew
    // back to the corner, already working. Ignores any older run underneath.
    if ((state === "orb" || state === "orblabel") && starting) return <Orb icon="💭" label="Starting…" wide={state === "orblabel"} />;
    if (!run) return <div class="card-app" data-rev={r} />;

    const title = run.title || truncate(run.task || "Agent run", 80);
    // A backend-UNREACHABLE failure gets its own headline ("Backend unreachable") so a dead box is unmistakable,
    // distinct from a generic run failure (a reachable box that errored).
    const offline = !!run.error && isBackendUnreachable(run.error);
    const failWord = offline ? "Backend unreachable" : "Run failed";
    const headline = pending ? "Approval needed" : run.error ? failWord : run.cancelled ? "Cancelled" : done ? (run.hitCap ? "Stopped" : "Task complete") : run.resumed ? "Resumed…" : "Working…";
    // Multi-run EXPANDED head: name the selected run (its title, ellipsized in CSS) rather than the generic
    // "Task complete" — the status is already carried by the tab's glyph. Keep the status word for the
    // states that matter more than a name (approval / failure / cancel).
    const headText = tabs ? (pending ? "Approval needed" : run.error ? failWord : run.cancelled ? "Cancelled" : title) : headline;
    // Multi-run COLLAPSED summary: a calm overview, not per-run detail — a generic status + a count badge,
    // no title subtitle, no tab strip. (A pending run would force the EXPANDED state, so it isn't seen here.)
    const doneN = runs.filter(runIsDone).length;
    const anyPend = runs.some(runIsPending);   // a run needs approval — must stay visible even in the summary
    const summaryHead = anyPend ? "Approval needed" : doneN === runs.length ? "All tasks complete" : doneN > 0 ? "Some tasks complete" : "Tasks running…";
    const decide = (ok: boolean, persist = false) => {
        if (!pendingStep || pendingStep.seq == null) return;
        decidedSteps.add(stepKey(run.hash, pendingStep.seq));
        clearHighlight();
        void decideGate(pendingStep, run.hash, pendingStep.seq, ok, persist);   // fetch_url: grant its host in-gesture
        rev.value++;
    };
    const onClose = (e: Event) => {
        e.stopPropagation();
        if (pendingStep) decide(false);          // × on a pending gate = a fast Deny
        else dismissCardRun(run.hash);           // × on a finished card = dismiss (drops it from the tab strip)
    };
    // Dismiss on POINTERDOWN (not click/pointerup): if the pointer wobbles between the × and the toast body,
    // the browser fires `click` on their common ANCESTOR (the toast), whose handler EXPANDS — and a pointerUP
    // that drifts off the × misses the button entirely. Dismissing on pointerDOWN sets `dismissed` before any
    // of that: the state machine then resolves to "hidden" regardless of a stray expand click, so the card
    // never flashes open. stopPropagation keeps the press from also starting the drag grab on the toast.
    const onCloseDown = (e: Event) => { e.stopPropagation(); e.preventDefault(); onClose(e); };

    // Hidden = render NOTHING (the shell fades the wrapper out by opacity). Without this branch the code
    // falls through to the full expanded card, so on dismiss the content swaps small-toast→full-card and the
    // height re-measures UP — the card visibly GREW while fading ("expands then goes opacity 0"), and closing
    // the composer over a dismissed run faded into that stale dialog. Empty content → a clean fade to nothing.
    if (state === "hidden") return <div class="card-app" data-rev={r} />;

    if (state === "orbprose") {
        // The live caption: current phase + a live token count (streaming) / narration / stall heartbeat.
        return <Orb icon={orb!.icon} label={orb!.label} suffix={orb!.suffix} wide prose />;
    }
    if (state === "orb" || state === "orblabel") {
        return <Orb icon={orb!.icon} label={orb!.label} suffix={orb!.suffix} wide={state === "orblabel"} />;
    }
    if (state === "toast") {
        // MULTI-RUN collapsed → a calm SUMMARY: 🤖 + a generic status + a count badge, no per-run title, no
        // tab strip. Click expands to the tabbed detail; × dismisses ALL runs (close the summary). SINGLE run
        // → the classic toast (headline + the task subtitle), which expands to its own answer.
        if (tabs) {
            return (
                <div class="card-app" data-rev={r}>
                    <div class="card-toast summary" role="button" title="Click to review · drag or right-click to move"
                        onPointerDown={startCardDrag}
                        onClick={e => { if (!(e.target as HTMLElement).closest(".card-x")) cardDetail.value = true; }}
                        onContextMenu={cardCtxMenu}>
                        <span class="card-bot" aria-hidden="true">🤖</span>
                        <span class={`card-toast-head${anyPend ? " pending" : ""}`}>{summaryHead}</span>
                        <span class={`card-count${anyPend ? " pend" : ""}`} title={`${runs.length} runs`}>{runs.length}</span>
                        <span class="sp" />
                        <button class="card-x" aria-label="Dismiss all" onPointerDown={e => { e.stopPropagation(); e.preventDefault(); runs.forEach(s => dismissCardRun(s.hash)); }} onClick={e => e.stopPropagation()}>✕</button>
                    </div>
                </div>
            );
        }
        return (
            <div class="card-app" data-rev={r}>
                <div class="card-toast" role="button" title="Click to review · drag or right-click to move" onPointerDown={startCardDrag} onClick={e => { if (!(e.target as HTMLElement).closest(".card-x")) setCardCollapsed(run.hash, false); }} onContextMenu={cardCtxMenu}>
                    <span class="card-bot" aria-hidden="true">🤖</span>
                    <span class="card-toast-txt">
                        <span class="card-toast-head">{headline}</span>
                        <span class="card-toast-sub">{title}</span>
                    </span>
                    <button class="card-x" aria-label="Dismiss" onPointerDown={onCloseDown} onClick={e => e.stopPropagation()}>✕</button>
                </div>
            </div>
        );
    }
    return (
        <div class="card-app" data-rev={r}>
            <ContextMenu />{/* right-click menus (e.g. a fetch/navigate URL → open in new tab) need their renderer in the HUD too, not just the panel */}
            {tabs ? <CardTabs runs={runs} selected={hash} /> : null}
            <div class="card-head" onPointerDown={startCardDrag} onContextMenu={cardCtxMenu}>
                {tabs ? null : <span class="card-bot" aria-hidden="true">🤖</span>}   {/* multi-run: the tab strip already IDs the run — drop the 🤖 to de-clutter */}
                <span class={`card-head-txt${pending ? " pending" : ""}`} title={tabs ? headText : undefined}>{headText}</span>
                <span class="sp" />
                {/* Maximise the finished-answer card into a near-full-page corner window (animated); toggles back.
                    Only for a single finished run (an approval/working card stays compact). */}
                {done && !pending && !tabs
                    ? <button class="card-icon" aria-label={cardMaximizedHash.value === run.hash ? "Minimise" : "Maximise"} title={cardMaximizedHash.value === run.hash ? "Minimise" : "Maximise"}
                        onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); cardMaximizedHash.value = cardMaximizedHash.value === run.hash ? "" : run.hash; }}>{cardMaximizedHash.value === run.hash ? "⤡" : "⤢"}</button>
                    : null}
                {pending ? null : <button class="card-icon" aria-label="Collapse" title="Collapse" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); cardMaximizedHash.value = ""; tabs ? (cardDetail.value = false) : setCardCollapsed(run.hash, true); }}>▾</button>}
                <button class="card-x" aria-label={pending ? "Deny" : "Dismiss"} onPointerDown={onCloseDown} onClick={e => { e.stopPropagation(); cardMaximizedHash.value = ""; }}>✕</button>
            </div>
            <div class="card-body">
                {pending && pendingStep
                    ? <ApprovalBody st={pendingStep} hash={run.hash} goal={title} />
                    : !done
                        // A working run browsed via a tab (multi-run detail): show a live "Working…" line + its
                        // trace, not the finished-answer branch (which would render an empty "no reply yet").
                        ? <>
                            {/* Show work sits ABOVE, exactly as in the done branch — so it doesn't JUMP from
                                bottom to top when a streaming follow-up finishes (the "spammy reflow" bug). */}
                            {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                            {run.liveStream?.content
                                // The answer is STREAMING → render it as clean markdown, EXACTLY like the
                                // finished answer (it becomes run.summary when the run settles — no reflow). The
                                // HUD is answer-first: no "Running JavaScript…" activity line and no model-chip /
                                // reply-bubble chrome (that's DevTools/sidebar detail — the LiveStream component).
                                ? <div class="card-answer md" dangerouslySetInnerHTML={{ __html: markdown(run.liveStream.content, { math: true }) }} />
                                : (() => { const o = orbStatus(run, nowTick.value || Date.now(), residentNow(run.model)); return <div class="card-answer dim card-working"><span class="card-work-ic" aria-hidden="true">{o.icon}</span>{o.label}{o.suffix ? <span class="card-orb-live">{o.suffix}</span> : null}<span class="pill-dots"><i /><i /><i /></span></div>; })()}
                          </>
                        : <>
                            {/* "Show work" sits ABOVE the answer now — the audit trail is the header, the answer
                                the payoff. Only when there's actual WORK (≥1 tool step); a pure chat answer has none. */}
                            {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                            {run.error
                                ? <div class={`card-error${offline ? " card-error-offline" : ""}`}>{offline ? <><IconWarn /> </> : null}{run.error}</div>
                                : (run.summary || "").trim()
                                    ? <AnswerBody text={run.summary || ""} run={run} />
                                    : <div class="card-answer dim card-answer-empty">{run.cancelled ? "Run cancelled — the agent returned no text." : "The run finished without a text reply."}</div>}
                            {/* answer-designated element visuals — the user-facing deliverable (HUD-only; the debug
                                sidebar deliberately doesn't render these). Click to lightbox. */}
                            {run.answerMedia && run.answerMedia.length ? <AnswerMediaGallery media={run.answerMedia} /> : null}
                            {/* The curated answer SET's tool outputs (designated + auto-appended), rendered under
                                the summary — see ResultBlock (shared with the DevTools reply for parity). */}
                            {/* `shownIn` is the same prose rendered just above, so an output the model quoted
                                inline is not appended here as well (parity with the DevTools reply). */}
                            <ResultBlock run={run} shownIn={run.summary || ""} />
                            {/* Step-capped stop → one click resumes with a fresh N-step budget (no need to type
                                a follow-up in the composer). Not shown for a cancel/error. */}
                            {run.hitCap && !run.cancelled
                                ? <button class="continue-run" title="Resume this run with more steps, continuing from where it stopped"
                                    onClick={() => window.parent.postMessage({ __mlSidebarApp: "continueRun", hash: run.hash }, "*")}>
                                    Continue <span class="continue-steps">+{run.maxSteps || 20} steps</span>
                                  </button>
                                : null}
                          </>}
            </div>
            {/* Deny/Approve as a FIXED footer — outside the scroll area, so it's always visible (a
                drag-collapse or the scrollbar appearing can never cut or shift the buttons). */}
            {pending && pendingStep
                ? (() => {
                    const showGrants = hasPersistGrants(pendingStep.grants);
                    return <div class="card-foot card-foot-appr">
                        {showGrants ? <GrantCard grants={pendingStep.grants!} /> : null}
                        <div class="card-foot-row">
                            <button class="appr-btn no" onClick={() => decide(false)}>Deny <kbd class="kb">esc</kbd></button>
                            <button class="appr-btn yes" onClick={() => decide(true)}>Approve <kbd class="kb">⏎</kbd></button>
                            {showGrants ? <button class="appr-btn yes remember" title="Approve — and let the agent fetch these URLs WITHOUT approval for the rest of this session (results are cached)" onClick={() => decide(true, true)}>Keep <kbd class="kb">{KEEP_HINT}</kbd></button> : null}
                        </div>
                    </div>;
                  })()
                : done ? <CardReply hash={run.hash} />
                    : steering ? <CardSteer hash={run.hash} onClose={() => { cardSteerHash.value = ""; }} />
                        : null}
        </div>
    );
}

// The inline STEER box on a LIVE card (orb → right-click → "Steer this run…"). Text-only: a mid-run steer
// routes to the handle's say(), which is text-only (no images mid-flight), so offering an attach would only
// drop it. Sends via the SAME sessionSend channel as the reply; while the run is live the page routes it to
// say() → the message is queued and shows as an agent-say bubble with the "seen" indicator. Stays OPEN after
// a send so you can steer again; Escape or × closes back to the orb.
export function CardSteer({ hash, onClose }: { hash: string; onClose: () => void }) {
    const [text, setText] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { inputRef.current?.focus(); }, []);
    const send = () => {
        const t = text.trim();
        if (!t) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash, text: t }, "*");
        setText(""); inputRef.current?.focus();   // keep steering — a run often needs more than one nudge
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    const has = !!text.trim();
    return (
        <div class="card-steer">
            <div class="card-steer-field">
                <span class="card-steer-ic" aria-hidden="true" title="Steer — delivered at the agent's next step">🧭</span>
                <input ref={inputRef} class="card-steer-in" type="text" value={text} placeholder="Steer the agent — added at its next step…"
                    onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
                <button class={`card-steer-send${has ? " show" : ""}`} aria-label="Send steer" tabIndex={has ? 0 : -1}
                    onMouseDown={e => e.preventDefault()} onClick={send} disabled={!has}><IconSend /></button>
                <button class="card-steer-x" aria-label="Close steer" title="Close (Esc)" onMouseDown={e => e.preventDefault()} onClick={onClose}>✕</button>
            </div>
        </div>
    );
}

// Inline reply on the finished HUD card — the lowest-friction "respond to the final response". Reuses the
// EXACT session-composer reverse channel the panel uses (__mlSidebarApp:"sessionSend" → shell → the page's
// handle registry → the run's run()), so a follow-up turn continues the SAME session. Sending flips the card
// back to the working orb via the normal state machine. Compact: one line + send, Enter sends.
export function CardReply({ hash }: { hash: string }) {
    // Collapsed by default to a slim GHOST affordance (icon + "Reply…", NOT a filled input) — quiet until you
    // want to reply. Click opens the real input, where the send button lives INSIDE the field and only
    // materialises once you type. Escape / empty blur collapses back to the ghost.
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const att = useImageAttach();
    const inputRef = useRef<HTMLInputElement>(null);
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash, text: t, images: att.imgs }, "*");
        // Optimistic: flip the session to WORKING now so the card morphs to the orb the instant you hit
        // Enter, instead of showing the stale answer until the follow-up's first event lands (in off/card
        // mode the page's agent-say bridge is dormant, so there'd otherwise be a visible lag).
        const s = sessionMap.get(hash);
        if (s) { s.status = "pending"; s.lastTs = Date.now(); rev.value++; }
        setText(""); att.clear(); setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.preventDefault(); setText(""); att.clear(); setOpen(false); }
    };
    useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

    if (!open) {
        return (
            <div class="card-reply collapsed">
                <button class="card-reply-open" onClick={() => setOpen(true)}>
                    <IconSend /><span>Reply to continue this run…</span>
                </button>
            </div>
        );
    }
    const has = !!text.trim() || att.imgs.length > 0;
    return (
        <div class="card-reply">
            <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
            <div class="card-reply-field">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                {/* preventDefault on mousedown so clicking ＋ doesn't blur the input (which would collapse the box). */}
                <button class="cbtn card-reply-attach" aria-label="Attach an image" onMouseDown={e => e.preventDefault()} onClick={() => att.fileRef.current?.click()}>＋</button>
                <input ref={inputRef} class="card-reply-in" type="text" value={text} placeholder="Reply to continue this run…"
                    onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} onPaste={att.onPaste}
                    onBlur={() => { if (!text.trim() && !att.imgs.length && !att.loading) setOpen(false); }} />
                <button class={`card-reply-send${has ? " show" : ""}`} aria-label="Send" tabIndex={has ? 0 : -1}
                    onMouseDown={e => e.preventDefault()} onClick={send} disabled={!has}>
                    <IconSend />
                </button>
            </div>
        </div>
    );
}
