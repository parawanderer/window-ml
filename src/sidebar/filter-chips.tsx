// filter-chips.tsx — a row of SHOW/HIDE chips: one per thing a view can leave out, each with its count, struck out
// while hidden. The event lane filters its kinds with it, and the bench's sweep timeline its runs by dimension value.

import type { ComponentChildren } from "preact";

/** One chip: what it hides (`key`), what it says, how many there are, and its tooltip. */
export interface FilterChip { key: string; label: ComponentChildren; count?: number; tip?: string }

/**
 * Chips that hide and show: a click toggles `key` (the caller keeps the hidden set, and decides what hiding means).
 * Each is a toggle button (`aria-pressed` while shown) with the panel's tooltip; `children` follow the chips.
 */
export function FilterChips({ items, hidden, toggle, children }: { items: FilterChip[]; hidden: ReadonlySet<string>; toggle: (key: string) => void; children?: ComponentChildren }) {
    return (
        <div class="rc-lane-filter">
            {items.map((c) => {
                const off = hidden.has(c.key);
                return (
                    <button key={c.key} class={`rc-lane-chip${off ? " off" : ""}${c.tip ? " tt" : ""}`} aria-pressed={!off}
                        {...(c.tip ? { "data-tip": c.tip } : {})} onClick={() => toggle(c.key)}>
                        {c.label}{c.count != null ? ` ${c.count}` : ""}
                    </button>
                );
            })}
            {children}
        </div>
    );
}
