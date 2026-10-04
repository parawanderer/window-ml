// menu.tsx — the chat page's ONE popup menu look: a rounded sheet of rows, a glyph and a label each, and a tick on
// a row that is a toggle. The row menu (pin, delete) and the gear's menu (calm view, the box, the bench, settings)
// both draw with it, so the two can never drift into two styles of the same thing.
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { IconCheck, IconChevron } from "../sidebar/icons";

/** One row. A toggle (`on` given) says its state with a tick rather than by changing its words. `detail` is a quiet
 *  word at the right — WHICH thing the row acts on, where the label alone would not say. It is the slot the theme
 *  row already used for its current choice (`.chat-menu-val`), so a row that must name a device says it the same
 *  way rather than growing the label into a sentence. */
export function MenuItem({ icon, label, detail, note, on, sub, off, onPick }: { icon: ComponentChildren; label: string; detail?: string;
    /** a dim second LINE under the label. Where `off` is set this is the reason, which is the whole point of showing
     *  a row that cannot be used: a tooltip would be pointer-only, and a disabled control is not hoverable anyway. */
    note?: string; on?: boolean;
    /** drawn as a child of an open `MenuGroup`: `i` is its place in the stagger, `open` whether it can be reached */
    sub?: { i: number; open: boolean };
    /** cannot be used from here. `aria-disabled` rather than `disabled`, so it keeps its place in the tab order and
     *  a reader still hears the row and its reason instead of meeting a hole where an option used to be. */
    off?: boolean; onPick: () => void }) {
    return (
        <button class={`chat-menu-item${sub ? " chat-menu-sub" : ""}${off ? " off" : ""}`} role={on === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={on}
            {...(sub ? { style: `--i:${sub.i}`, tabIndex: sub.open ? 0 : -1 } : {})} aria-disabled={off || undefined}
            aria-label={detail ? `${label} — ${detail}` : undefined} onClick={off ? undefined : onPick}>
            {/* A child row carries no glyph: its group's own row above it already said what these are, and an icon
                there pushed the label 30px past every other child's. */}
            {icon ? <span class="chat-menu-ico" aria-hidden="true">{icon}</span> : null}
            <span class="chat-menu-label">{label}{note ? <span class="chat-menu-note">{note}</span> : null}</span>
            {detail ? <span class="chat-menu-val">{detail}</span> : null}
            {on ? <span class="chat-menu-on" aria-hidden="true"><IconCheck /></span> : null}
        </button>
    );
}

/**
 * A row that opens into its own rows, in place rather than as a flyout.
 *
 * The theme row had this to itself; the gear's panels needed the same thing, and a second copy of a disclosure is
 * how a menu ends up with two of them that animate differently. `children` is given the open state because a closed
 * group's rows must be unreachable by TAB while still being in the DOM — they are always mounted, so that CLOSING
 * animates too, and `inert` is what keeps them out of reach.
 */
export function MenuGroup({ icon, label, detail, children }: { icon: ComponentChildren; label: string; detail?: string;
    children: (open: boolean) => ComponentChildren }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button class="chat-menu-item" role="menuitem" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                <span class="chat-menu-ico" aria-hidden="true">{icon}</span>
                <span class="chat-menu-label">{label}</span>
                {detail ? <span class="chat-menu-val">{detail}</span> : null}
                <span class={`chat-menu-caret${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
            </button>
            <div class={`chat-menu-subs${open ? " open" : ""}`} role="group" aria-label={label} aria-hidden={!open} inert={!open}>
                <div class="chat-menu-subs-in">{children(open)}</div>
            </div>
        </>
    );
}
