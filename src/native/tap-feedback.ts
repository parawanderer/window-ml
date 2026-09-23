// tap-feedback.ts — WHICH PRESSES INSIDE THE WEBVIEW DESERVE A TICK, and how firm it should be.
//
// The app's own controls answer a finger (`Haptics`, mobile/src/ui.tsx); the page's could not, because a WebView
// cannot vibrate a phone. So the page says a control was pressed and the app does it (`tap`, native/bridge.ts).
//
// Its own module, with no imports, because the decision is the part that can be wrong and the page entry that uses it
// pulls in the whole client — a test of this should not have to boot one.
//
// The rule to keep in mind while editing: a phone that buzzes when a thumb goes down to SCROLL is worse than one that
// never buzzes at all, and a control that is refusing the press must stay silent, or the tick says something happened
// when nothing did.

/** Anything a finger can press. A control is found by walking UP from what was touched, because what a thumb lands
 *  on is almost always a label or a glyph inside the button rather than the button. */
const CONTROLS = 'button, a[href], [role="button"], [role="option"], [role="menuitem"], [role="tab"], summary, input[type="checkbox"], label';

/** The controls that START something rather than choose it — send, stop, carry on, resume, fix. Those get the
 *  heavier tick, so the press that commits you feels different from the one that browses. */
const HEAVY = ".csend, .cstop, .continue-run, .chat-resume, .btn.primary, .chat-att-fix";

/** How a press on `target` should feel, or null for no tick at all. */
export function tapKind(target: Element | null): "select" | "impact" | null {
    const hit = target?.closest?.(CONTROLS);
    if (!hit || hit.getAttribute("aria-disabled") === "true" || (hit as HTMLButtonElement).disabled) return null;
    return hit.matches(HEAVY) ? "impact" : "select";
}
