// files-hide-view.ts — a session's hiding rules as the policy view's rows: which entry decides over which, and what removing one does.

import { DEFAULT_HOLDS, beats, overlapsDefault, patternRefusal, patternsOverlap, type HideEntry } from "../files-hide";
import type { PolicyLayer, PolicyRow } from "./sw-policy-view";

/** What every `files` row's label ends with until the host applies the list to the programs it starts (POLICIES.md, "What the
 *  host gets"): in the label, since a row carries no field beyond what the policy page already reads. */
export const HIDE_NOT_ON_SPAWN = " (not applied yet to programs the shell starts: it binds /files, as Python and ml.fs read it)";

/** A row's place before it is compared: a default hold or a stored entry. */
type Placed = { layer: PolicyLayer; entry: HideEntry | { id: string; layer: "default"; effect: "hide"; source: string }; label: string; origin?: string; created?: number };

/** A stored entry as the view reads it: the rule's fields, and the words the policy page shows. */
export type ViewedHideEntry = HideEntry & { label?: string; origin?: string; created?: number };

/** Whether two rows could ever judge the same path: two patterns that can match a common path, or a pattern and a default
 *  hold it can reach. Two defaults never compete (each holds its own names). */
function overlap(a: Placed, b: Placed): boolean {
    if (a.layer === "default" && b.layer === "default") return false;
    if (a.layer === "default") return overlapsDefault(b.entry.source, a.entry.id);
    if (b.layer === "default") return overlapsDefault(a.entry.source, b.entry.id);
    return patternsOverlap(a.entry.source, b.entry.source);
}

/**
 * The `files` rows of one session's view, the four defaults first (asked for only when the session or the global list holds a
 * `files` rule, as every consumer's default row is), then the global entries and the session's (POLICIES.md,
 * "The read, for the view"). Unlike the script consumers, two rules here compete only where their patterns can match one
 * path, so `overrides` and `overriddenBy` name only overlapping rows of the OTHER effect, ordered by the hide rule's own
 * `beats` (session over global over default, then the more specific, then `hide`). Removing a `hide` widens and names the
 * rows it was overriding; removing a `show` narrows; a default cannot be removed. An entry the rule refuses (`patternRefusal`)
 * is shown broken and decides nothing.
 * @param globals the person's global `files` entries
 * @param session the session's own `files` entries
 */
export function filesViewRows(globals: readonly ViewedHideEntry[], session: readonly ViewedHideEntry[]): PolicyRow[] {
    const placed: Placed[] = [
        ...DEFAULT_HOLDS.map((d): Placed => ({ layer: "default", entry: { id: d.id, layer: "default", effect: "hide", source: d.id }, label: d.label })),
        ...[...globals, ...session].map((e): Placed => ({ layer: e.layer, entry: e, label: e.label ?? `${e.effect} ${e.source}`, ...(e.origin ? { origin: e.origin } : {}), ...(e.created !== undefined ? { created: e.created } : {}) })),
    ];
    const live = (p: Placed): boolean => p.layer === "default" || patternRefusal(p.entry.source, p.entry.effect) === undefined;
    return placed.map((r) => {
        const broken = live(r) ? undefined : patternRefusal(r.entry.source, r.entry.effect);
        const rivals = broken ? [] : placed.filter((o) => o !== r && live(o) && o.entry.effect !== r.entry.effect && overlap(r, o));
        const overrides = rivals.filter((o) => beats(r.entry, o.entry)).map((o) => o.entry.id);
        const overriddenBy = rivals.filter((o) => beats(o.entry, r.entry)).map((o) => o.entry.id);
        const row: PolicyRow = {
            consumer: "files", layer: r.layer,
            entry: { id: r.entry.id, label: r.label + HIDE_NOT_ON_SPAWN, source: r.entry.source, effect: r.entry.effect, ...(r.origin ? { origin: r.origin } : {}), ...(r.created !== undefined ? { created: r.created } : {}), ...(broken ? { broken } : {}) },
            wins: overriddenBy.length === 0, overrides, overriddenBy,
        };
        if (r.layer !== "default") {
            const reach = r.layer === "global" ? "all" : "session";
            row.removal = r.entry.effect === "show"
                ? { class: "narrows", exposes: [], reach }
                : { class: "widens", exposes: rivals.filter((o) => overrides.includes(o.entry.id)).map((o) => ({ id: o.entry.id, label: o.label + HIDE_NOT_ON_SPAWN, effect: o.entry.effect })), reach };
        }
        return row;
    });
}
