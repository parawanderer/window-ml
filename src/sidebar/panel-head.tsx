// panel-head.tsx — where a panel's HEADER ROW goes: in place, or into the tab bar of the dock that holds the panel.
//
// A panel that is docked beside other panels would otherwise get two bars — the dock's tabs, and under them its own
// row of controls — which is the double header JetBrains' new UI removed and the chat page does not want either. So a
// panel wraps its header row in `PanelHead`, and a dock that holds it provides the element its tab bar keeps for that
// panel. Anywhere that is not a dock (the DevTools panel, the sidebar) provides nothing, and the row renders exactly
// where it always has.
//
// The portal is Preact's own `render` into the slot, not `preact/compat`'s `createPortal`: importing compat installs
// its global option hooks for the whole bundle, and one of them rewrites `onChange` on text inputs to `onInput` — which
// silently changed when every settings field in the DevTools panel saves.
import { createContext, render, type VNode } from "preact";
import { useContext, useEffect, useLayoutEffect } from "preact/hooks";

/**
 * The dock's slot for this panel's header row: `undefined` outside a dock, `null` inside one whose bar has not
 * mounted yet (the row waits a frame rather than flashing in place), or the element to render into.
 */
export const DockBarSlot = createContext<HTMLElement | null | undefined>(undefined);

/** Is this panel inside a dock? A panel uses it to leave out what the dock already draws (a title, a close button). */
export function useDocked(): boolean {
    return useContext(DockBarSlot) !== undefined;
}

/** A panel's header row: rendered in place, or into its dock's tab bar when it is docked. */
export function PanelHead({ children }: { children: VNode }) {
    const slot = useContext(DockBarSlot);
    if (slot === undefined) return children;
    return slot ? <IntoSlot slot={slot}>{children}</IntoSlot> : null;
}

/** Render `children` into `slot`, re-rendering with every render of this component and clearing the slot when it
 *  unmounts or the slot changes. Context does not cross it, which a header row does not need: its state is signals
 *  and props. */
function IntoSlot({ slot, children }: { slot: HTMLElement; children: VNode }) {
    useLayoutEffect(() => { render(children, slot); });
    useEffect(() => () => render(null, slot), [slot]);
    return null;
}
