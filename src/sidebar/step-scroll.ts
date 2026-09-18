// step-scroll.ts — scrolling to the step a citation names, and to the right cell inside it.
//
// Its own module for a structural reason rather than a tidiness one: it was declared in answer-render.tsx and
// called from render-panel.tsx, while answer-render.tsx imports three components back from render-panel.tsx.
// That is an import cycle, and one function reaching the wrong way was the whole of it. Nothing here renders,
// so neither side needs to own it.
//
// `visibleAnchor` came with it because only this uses it: a citation can name a SLOT rather than a step, and
// the thing worth scrolling to is then the cell the slot is about, not the top of the step containing it.

import { atBottom, cardShowWorkHash, revealSeq } from "./store";

/** Fired on `document` when a citation sends the reader to a step. A transcript that FOLLOWS its newest event
 *  has to stop following when it does: opening the step grows the content, the surface's own resize handler
 *  pins back to the bottom, and the scroll that was already under way is overwritten — so the first click
 *  appeared to open the step and go nowhere, and only a second one (with the step already open, so no resize)
 *  seemed to work. Each surface keeps its own follow state, so this says what happened rather than reaching
 *  into any of them. */
export const STEP_JUMP_EVENT = "ml-step-jump";

/** The anchor for a slot, chosen by what is actually ON SCREEN. Both the rendered and the raw view of a step
 *  are in the DOM at once (the rendered⇄raw toggle switches which is shown), and a collapsed disclosure keeps
 *  its content mounted — so the first `[data-cite]` match can easily be one nobody can see, and scrolling to
 *  it lands the reader on blank space. Zero-sized is the test that catches all of those at once: a hidden
 *  branch, a collapsed grid row, a `display: none` sibling.
 *
 *  A renderer declares its own anchor when one of its sections IS the answer (python-in's code, not the input
 *  table; python-out's value, not the console). Everything else falls back to the slot's section, and then to
 *  the step — neither of which is a failure, just a coarser answer. */
export function visibleAnchor(root: Element, slot: "in" | "out"): Element | null {
    const seen = [...root.querySelectorAll(`[data-cite="${slot}"]`)];
    const shown = seen.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
    // Nothing visible does NOT mean fall through to something hidden: it means this step has no on-screen
    // cell for that slot right now, and the step itself is the honest place to land.
    return shown ?? null;
}

/** Scroll to a cited step — and, when the citation named a SLOT, to the cell inside it that the slot is
 *  actually about. A `python-in` step renders a source block AND the input dataframes; a `python-out` renders
 *  stdout AND the returned value. Landing on the step container means the reader still has to find the part
 *  they clicked, which on a tall step can be off screen entirely.
 *
 *  The anchor is declared by the RENDERER (`data-cite` on its primary cell), because only the renderer knows
 *  which of its sections is the answer — the code, not the input table; the value, not the console. A
 *  descriptor that declares none falls back to the step, which is where this always landed. */
export function scrollToStepSeq(seq?: number, hash?: string, slot?: "in" | "out"): void {
    if (seq == null) return;
    // Stop the transcript following its own tail BEFORE anything grows: see STEP_JUMP_EVENT.
    atBottom.v = false;
    try { document.dispatchEvent(new CustomEvent(STEP_JUMP_EVENT, { detail: { seq } })); } catch { /* no DOM */ }
    if (hash) cardShowWorkHash.value = hash;   // open the HUD "Show work" so the step exists to scroll to
    revealSeq.value = seq;                      // force-open the per-task block that holds this step (if collapsed)
    // Opening the step is done by pressing its OWN opener, once, rather than through a signal the row reads:
    // subscribing a step to a signal that changes on click re-rendered the answer subtree around it and left
    // a citation without its run, which threw from inside the very click meant to navigate. Borrowing the
    // affordance also means this cannot desync from what the toggle means.
    const pulse = (el: Element): void => {
        el.classList.add("astep-pulse");
        setTimeout(() => el.classList.remove("astep-pulse"), 1400);
    };
    const doScroll = (): boolean => {
        const found = document.querySelector(`[data-astep-seq="${seq}"]`);
        if (!found) return false;
        // OPEN it FIRST, if it is collapsed. Scrolling to a row that merely pulses shows you where the step
        // is and not what it was, which is the thing you clicked for.
        //
        // Pressing the row's own opener rather than reading a signal inside the row: subscribing a step to a
        // signal that changes on click re-rendered the answer subtree around it and left a citation without
        // its run, which threw from inside the very click meant to navigate. Borrowing the affordance also
        // means this cannot desync from what the toggle means.
        //
        // Before the pulse, not after, because the toggle re-renders the row and Preact rewrites an
        // element's class list from its own vdom when it does — a class added first is wiped by it. The
        // element is then RE-QUERIED for the same reason: the node that comes back need not be the one we
        // pressed.
        const collapsed = !found.classList.contains("open");
        if (collapsed) (found.querySelector(".astep-head") as HTMLElement | null)?.click();
        const row = document.querySelector(`[data-astep-seq="${seq}"]`) ?? found;
        // The slot's own cell if the renderer declared one, else the step — the fallback is not a failure,
        // it is what a descriptor with a single cell (an image, an action) correctly wants.
        //
        // AN ALREADY-OPEN STEP is scrolled to at once. A COLLAPSED one is not: it has no visible cells yet (the
        // open we just triggered renders in a microtask), and the position it is at right now is not the one it
        // will be at. Everything it grows is above the viewport, and the browser's scroll anchoring holds the
        // visual position by adding that growth to `scrollTop` — so a scroll issued now is undone before it
        // lands, which is exactly the "it only works the second time" report: the second click finds the step
        // open, nothing grows, nothing is anchored, and the same code works.
        //
        // So WAIT FOR IT TO SETTLE and then scroll ONCE, smoothly. Settled = the row's height was the same on two
        // consecutive frames, which is also what stops a step that is still streaming from being chased forever
        // (the frame bound ends it either way). One smooth scroll rather than a correction per frame: a smooth
        // scroll restarted sixteen times a second animates nowhere, and the animation is the part that tells a
        // reader they were moved rather than teleported.
        // …where there ARE frames. A world without `requestAnimationFrame` (the jsdom sandboxes the panel's tests
        // run in) has nothing to settle for and nothing to wait on, so it gets the scroll it always got.
        const frames = typeof requestAnimationFrame === "function";
        if (!collapsed || !frames) {
            const cell = slot ? visibleAnchor(row, slot) : null;
            (cell ?? row).scrollIntoView({ block: "center", behavior: "smooth" });
        } else {
            let tries = 0, lastH = -1;
            const settle = (): void => {
                const again = document.querySelector(`[data-astep-seq="${seq}"]`);
                const h = again ? Math.round(again.getBoundingClientRect().height) : -1;
                // Height alone is not enough where the surface ANIMATES the step open: the body spends its first
                // frames at nothing, and two frames of the same nothing look exactly like a step that has
                // finished arriving. So a running animation anywhere inside it counts as not settled.
                const moving = !!again && typeof again.getAnimations === "function" && again.getAnimations({ subtree: true }).length > 0;
                const stable = !!again && !moving && h === lastH;
                lastH = h;
                if (stable || ++tries >= 24) {
                    const target = (again && slot ? visibleAnchor(again, slot) : null) ?? again ?? row;
                    target.scrollIntoView({ block: "center", behavior: "smooth" });
                    return;
                }
                requestAnimationFrame(settle);
            };
            requestAnimationFrame(settle);
        }
        // The PULSE stays on the step, whatever we scrolled to: it is the thing being identified, and a
        // flashing sub-cell inside an unmarked row reads as a glitch rather than as "this one".
        pulse(row);
        // The toggle's re-render lands in a microtask and rewrites the row's class list from its own vdom,
        // wiping the pulse we just added. So re-apply it on a MACROTASK, which runs after that — and
        // re-query, because the node that comes back need not be the one we pressed.
        if (collapsed) setTimeout(() => {
            const again = document.querySelector(`[data-astep-seq="${seq}"]`);
            if (again && !again.classList.contains("astep-pulse")) pulse(again);
        }, 0);
        return true;
    };
    // Retry across a handful of frames: expanding Show-work AND a collapsed block are async re-renders, so the
    // row may not exist on the first (or second) tick.
    let tries = 0;
    const attempt = (): void => { if (doScroll() || tries++ > 8) { return; } requestAnimationFrame(attempt); };
    attempt();
    // Release the force-open after the pulse so the user can re-collapse the block, and a RE-click of the same
    // token (same seq) re-triggers the block's open effect (a stale value would make the dep look unchanged).
    setTimeout(() => { if (revealSeq.value === seq) revealSeq.value = null; }, 1700);
}
