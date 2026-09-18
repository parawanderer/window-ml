// vram-focus.ts — what the keyboard is currently pointing at in the resource panel, and how deep it has gone.
//
// The panel is navigable without a pointer, which means something has to hold WHICH model or pool has focus
// (`kbFocus`, `kbPool`), how far into it the user has stepped (`focusDepth`, capped by MAX_FOCUS_DEPTH) and the
// order to walk in (`focusOrder`). That is shared state: the chart draws the focus ring, the rows react to it
// and the key handler moves it, so it cannot live inside any one of them.
//
// `hoverModel` moved here with it, and not for tidiness. The focus functions read it to decide what a step
// means when the pointer and the keyboard disagree, so leaving it behind made vram.tsx and this file import
// each other. Pointer hover and keyboard focus are two answers to one question — what is the user attending to.

import { signal } from "@preact/signals";

/** The model a chart band is being hovered on, so the band and its legend row highlight together. Module-level
 *  because the chart and the rows are different components either side of the panel. */
export const hoverModel = signal<string | null>(null);

/**
 * READING THE CHART FROM THE KEYBOARD — which band, and how deep.
 *
 * The chart jams two questions onto one pointer: x asks WHEN, y asks WHAT AM I READING. You cannot move one
 * without disturbing the other, and the y targets are hostile — a 10px hit stroke on a pool line, a band that
 * may be three pixels tall. So the second question moves to its own input, and the two axes of the data get
 * the two axes of the arrow keys:
 *
 *   UP / DOWN     — along the LIST: the models drawn at this instant, wrapping through "everything" at 0.
 *   LEFT / RIGHT  — along the DEPTH: summary → what that model's memory is holding.
 *
 * That is the tree convention (and ARIA's `tree` keyboard model), and separating the axes is what stops one
 * key meaning "next sibling" at the top level and "descend" once you are on a model — a key whose meaning
 * depends on where you are reads as a mode you cannot predict. It also buys a property the single-axis
 * version could not have: DEPTH PERSISTS ACROSS UP/DOWN, so drilled into one model you can step to the next
 * and stay drilled in, which is the actual task ("what are these two cards each holding").
 *
 * `model: null` is the overview — the row nothing is picked out on. Depth is 0 there and cannot be anything
 * else: an overview has no single model to decompose, so RIGHT refuses rather than inventing one.
 *
 * NON-NULL MEANS THE KEYBOARD OWNS THE FOCUS, and it holds until the pointer actually MOVES (a pointermove,
 * not a boundary event a re-layout raised under a parked pointer) or Escape. Without that rule a band sliding
 * under a still cursor as samples arrive would fire `pointerenter` and silently steal a selection the reader
 * made with the keys.
 */
export const kbFocus = signal<{ model: string | null; depth: number } | null>(null);

/**
 * THE SAME AXIS, IN THE OVERLAID VIEW — which LINE you are reading.
 *
 * Overview draws pools rather than models, so the noun differs; the question the key answers does not. Its
 * own signal rather than a shared "focusable", because the two views focus genuinely different kinds of
 * thing and unifying them would be a wrapper over two two-element enums.
 *
 * DEPTH DOES NOT EXIST HERE, and left/right deliberately do nothing: a pool has no memory breakdown of its
 * own — the decomposition is per MODEL — so there is nothing to descend into, and the hint on that view
 * offers only the one pair of keys it can honour.
 *
 * `{ id: null }` is "nothing picked out", the row the list wraps through; a bare `null` means the POINTER
 * owns the focus, exactly as it does for {@link kbFocus}.
 */
export const kbPool = signal<{ id: string | null } | null>(null);

/** How deep the keyboard can go: 0 = the model, 1 = what its memory is holding. */
export const MAX_FOCUS_DEPTH = 1;

/** The focused model's depth, or 0 whenever the pointer owns the focus — the hover has no depth of its own. */
export const focusDepth = (): number => kbFocus.value?.depth ?? 0;

/**
 * Hand the focus back to the pointer. Called from the plot's own `pointermove`, which is the one event that
 * means the reader actually moved — and from nothing else, so a re-layout cannot do it.
 *
 * `hoverModel` is cleared only when the pointer is NOT over a band: the keyboard may have focused a model the
 * pointer was never on, and no `pointerleave` will ever arrive for a band that was never entered.
 */
export function releaseFocus(target: EventTarget | null): void {
    if (!kbFocus.value) return;
    kbFocus.value = null;
    const el = target as Element | null;
    if (!el?.closest?.(".rc-band")) hoverModel.value = null;
}

/**
 * The models the keys step through, in the order the panel LISTS them — published from the render that draws
 * those rows, because the key handler runs outside render and "which models are on screen" is a fact about
 * what was just drawn. A plain ref rather than a signal for the same reason `liveRuns` is one: it is written
 * during render, and a signal written during render re-enters rendering.
 */
let focusOrder: string[] = [];

/** Publish the models the arrow keys step through — call it from the render that DRAWS those rows. */
export const noteFocusOrder = (names: string[]): void => { focusOrder = names; };

/** Step the focus along the list, wrapping. `dir` is +1 for DOWN (further down the list) and -1 for UP. */
export function stepFocus(dir: number): void {
    const list: (string | null)[] = [null, ...focusOrder];
    const cur = kbFocus.value ? kbFocus.value.model : hoverModel.value;
    // A CURRENT POSITION THAT IS NO LONGER IN THE LIST starts from the overview rather than from wherever
    // index -1 happens to land: a model can leave the list under you — switched off, or evicted out of the
    // window — and stepping "one on" from something that is not there is not a move anyone asked for.
    const at = list.indexOf(cur ?? null);
    const next = list[((at < 0 ? 0 : at) + dir + list.length) % list.length];
    // DEPTH SURVIVES the move, except onto the overview, which has none to survive into.
    kbFocus.value = { model: next, depth: next ? (kbFocus.value?.depth ?? 0) : 0 };
    hoverModel.value = next;
}

/**
 * Step the focus deeper (+1) or back out (-1). Refuses at both ends rather than wrapping: a no-op boundary is
 * how a tree says you are at the root, where wrapping would silently jump you somewhere else.
 *
 * IT ADOPTS WHAT THE POINTER IS ON. Pressing right while hovering a band means "this one, in detail", and
 * requiring a keyboard focus to exist first made that do nothing — while the tip sat there naming the key.
 * A hint that advertises a key which silently does nothing is worse than no hint, and this is the seam
 * between the two ways of reading the chart: pointing at a thing and pressing the key should be the same as
 * having arrived at it with the keys.
 */
export function stepDepth(dir: number): boolean {
    const cur = kbFocus.value ?? (hoverModel.value ? { model: hoverModel.value, depth: 0 } : null);
    if (!cur?.model) return false;            // the overview has nothing to open
    const depth = Math.min(MAX_FOCUS_DEPTH, Math.max(0, cur.depth + dir));
    if (depth === cur.depth) return false;
    kbFocus.value = { ...cur, depth };
    return true;
}
