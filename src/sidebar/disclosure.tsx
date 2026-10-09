// disclosure.tsx — the one fold the panel opens a section with (and the bench pages too), apart from ui-kit so a page
// with no panel can import it.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { IconChevron } from "./icons";

/** THE DISCLOSURE — one fold, everywhere something opens. There were three, written three ways, and all
 *  three were a pill button that injected a box into the layout on click: that reads as content appearing
 *  rather than a section opening, and shoves whatever is below it. Slides. The panel had three of these written three different ways, all of them a pill
 *  button that injected a box into the layout on click — which reads as something appearing rather than as a
 *  section opening, gives no hint that the thing can be closed again, and jumps whatever is below it.
 *
 *  One component so the next one is free, and so all of them agree about what a chevron means. The slide is
 *  `grid-template-rows: 0fr → 1fr`: a height nobody knows in advance cannot be animated any other way, since
 *  `height: auto` does not transition at all.
 *
 *  `onOpen` is for a section whose content has to be FETCHED (the server-tool list) — it fires on the
 *  opening edge only, so re-opening does not re-request, and the caller decides whether a refresh is offered
 *  separately. `note` is a short status that rides on the header, where a count or a "loading…" belongs.
 *
 *  `aside` is the same idea for CONTROLS rather than text: it renders BESIDE the header button instead of
 *  inside it, because a button cannot legally contain buttons. That is what lets a section's own toggles
 *  (the event lane's kind filters) share the header line instead of costing a row of their own below it. */
export function Disclosure({ label, note, aside, open: controlled, onOpen, onToggle, defaultOpen = false, children }: {
    label: ComponentChildren;
    note?: ComponentChildren;
    /** Controls for the header LINE, drawn outside the header button (which may not nest buttons). */
    aside?: ComponentChildren;
    /** Controlled open state. With `onToggle` the caller owns it entirely (the lane's is persisted). */
    open?: boolean;
    /** Fires on the OPENING edge only — for a section whose content has to be fetched. */
    onOpen?: () => void;
    /** Fires on every change, with the new state. Present ⇒ the caller owns `open` in both directions. */
    onToggle?: (open: boolean) => void;
    defaultOpen?: boolean;
    children?: ComponentChildren;
}) {
    const [uncontrolled, setUncontrolled] = useState(defaultOpen);
    const open = controlled ?? uncontrolled;
    const toggle = () => {
        const next = !open;
        if (controlled == null) setUncontrolled(next);
        onToggle?.(next);
        if (next) onOpen?.();
    };
    return (
        <div class={`disc${open ? " open" : ""}`}>
            <div class={`disc-headrow${aside ? " has-aside" : ""}`}>
                <button class="disc-head" aria-expanded={open} onClick={toggle}>
                    <span class="tri" aria-hidden="true"><IconChevron /></span>
                    <span class="disc-label">{label}</span>
                    {note ? <span class="disc-note">{note}</span> : null}
                </button>
                {aside}
            </div>
            {/* The wrapper is ALWAYS rendered — there has to be something to slide, and a body that only
                exists once open can only appear. Its content is still mounted while closed, so a fetch that
                landed stays landed and reopening is instant. */}
            <div class="disc-body" aria-hidden={!open}><div>{children}</div></div>
        </div>
    );
}
