// pin-order.ts — the rules for ordering pinned sessions, shared by the chat page and the phone app: which order the
// Pinned section draws in, how a new order is stored, and where a dragged row lands. Pure, with no imports, so the
// phone's Metro bundle can take it from here (mobile/metro.config.js watches src/chat).

/**
 * The Pinned section's rows in this device's order: the stored order first, then any pin this device never placed
 * (one the RUNTIME holds, from another device) after them, keeping the order they came in, which is recency.
 *
 * The stored array IS the order. A pin made here goes on the end, the way a pinned tab does, and stays where it was
 * put until it is dragged; the section used to follow recency, which moved a pin every time its chat was used.
 */
export function pinnedInOrder<T>(rows: readonly T[], keyOf: (r: T) => string, order: Iterable<string>): T[] {
    const at = new Map([...order].map((k, i) => [k, i]));
    const placed = rows.filter((r) => at.has(keyOf(r))).sort((a, b) => at.get(keyOf(a))! - at.get(keyOf(b))!);
    return [...placed, ...rows.filter((r) => !at.has(keyOf(r)))];
}

/**
 * The stored pin order once the pins a section SHOWS are put in this order (`shown`, after a drag or Alt+arrow).
 *
 * A stored pin the section is not showing (its runtime offline, its row up in "Needs you") keeps its slot, so it
 * comes back where it was; the shown ones fill the other slots in their new order. A key never stored, a pin the
 * runtime holds, is adopted, because placing it is this device saying where it goes.
 */
export function placePins(stored: Iterable<string>, shown: readonly string[]): string[] {
    const on = new Set(shown);
    const next = [...shown];
    const out: string[] = [];
    for (const k of stored) out.push(on.has(k) ? next.shift()! : k);
    return [...out, ...next];
}

/** One row's place in the section when the drag began. */
export interface Slot { top: number; height: number }

/**
 * Where the dragged row would land, from how far it has moved: it passes a row once its LEADING edge (the top going
 * up, the bottom going down) crosses that row's middle. Its own middle was the first rule, and the drag is clamped to
 * the section, so a row a pixel taller than the first one could never pass it. `slots` are the rows' places at the
 * start of the drag, top to bottom.
 */
export function dropIndex(slots: readonly Slot[], from: number, dy: number): number {
    const top = slots[from].top + dy, bottom = top + slots[from].height;
    const mid = (i: number) => slots[i].top + slots[i].height / 2;
    let to = from;
    for (let i = from + 1; i < slots.length && bottom > mid(i); i++) to = i;
    for (let i = from - 1; i >= 0 && top < mid(i); i--) to = i;
    return to;
}

/**
 * How far each row stands from its own slot while the dragged one is headed for `to`: the rows between move one
 * dragged-row pitch the other way, and the dragged row itself is where the slot it is landing in starts.
 */
export function shifts(slots: readonly Slot[], from: number, to: number): number[] {
    const pitch = (i: number) => (i + 1 < slots.length ? slots[i + 1].top - slots[i].top : slots[i].height + (slots.length > 1 ? slots[1].top - slots[0].top - slots[0].height : 0));
    const out = slots.map(() => 0);
    if (to > from) {
        for (let i = from + 1; i <= to; i++) out[i] = -pitch(from);
        out[from] = slots[to].top + slots[to].height - (slots[from].top + slots[from].height);
    } else if (to < from) {
        for (let i = to; i < from; i++) out[i] = pitch(from);
        out[from] = slots[to].top - slots[from].top;
    }
    return out;
}

/** `keys` with the one at `from` moved to `to`. */
export function moved<T>(keys: readonly T[], from: number, to: number): T[] {
    const out = [...keys];
    out.splice(to, 0, ...out.splice(from, 1));
    return out;
}
