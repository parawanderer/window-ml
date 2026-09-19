// menu.tsx — the chat page's ONE popup menu look: a rounded sheet of rows, a glyph and a label each, and a tick on
// a row that is a toggle. The row menu (pin, delete) and the gear's menu (calm view, the box, the bench, settings)
// both draw with it, so the two can never drift into two styles of the same thing.
import type { ComponentChildren } from "preact";
import { IconCheck } from "../sidebar/icons";

/** One row. A toggle (`on` given) says its state with a tick rather than by changing its words. */
export function MenuItem({ icon, label, on, onPick }: { icon: ComponentChildren; label: string; on?: boolean; onPick: () => void }) {
    return (
        <button class="chat-menu-item" role={on === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={on} onClick={onPick}>
            <span class="chat-menu-ico" aria-hidden="true">{icon}</span>
            <span class="chat-menu-label">{label}</span>
            {on ? <span class="chat-menu-on" aria-hidden="true"><IconCheck /></span> : null}
        </button>
    );
}
