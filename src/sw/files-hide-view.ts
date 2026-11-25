// files-hide-view.ts — a session's hiding rules as the policy view's rows: which entry decides over which, and what removing one does.

import { DEFAULT_HOLDS, beats, overlapsDefault, patternRefusal, patternsOverlap, type HideEntry } from "../files-hide";
import type { PolicyLayer, PolicyRow } from "./sw-policy-view";

/** The limit of a `hide` on a Linux host, which masks what it matches when a command starts (window-ml-host PROTOCOL.md,
 *  "The hide list"): one line of a `hide` row's label, only when the connected host reports Linux. */
export const HIDE_LIMIT_LINUX_LATE = "A hide does not cover a file that appears while a command is already running (Linux).";

/** The limit of a `hide` on every host: it holds paths, and a hard link is another path to the same file. One line of every
 *  `hide` row's label. */
export const HIDE_LIMIT_HARD_LINK = "A hide follows names: a second hard link made earlier under another name still opens the file.";

/** The limit lines a `hide` row's label ends with, one per line: in the label, since a row carries no field beyond what the
 *  policy page already reads. */
export function hideLimits(platform: string | undefined): string {
    return (platform === "linux" ? [HIDE_LIMIT_LINUX_LATE, HIDE_LIMIT_HARD_LINK] : [HIDE_LIMIT_HARD_LINK]).map((l) => "\n" + l).join("");
}

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
 * A `hide` row's label ends with its limits (`hideLimits`), the Linux one only when the connected host reports Linux.
 * @param globals the person's global `files` entries
 * @param session the session's own `files` entries
 * @param platform the connected host's `hello.platform`, or undefined when none is connected
 */
export function filesViewRows(globals: readonly ViewedHideEntry[], session: readonly ViewedHideEntry[], platform?: string): PolicyRow[] {
    const placed: Placed[] = [
        ...DEFAULT_HOLDS.map((d): Placed => ({ layer: "default", entry: { id: d.id, layer: "default", effect: "hide", source: d.id }, label: d.label })),
        ...[...globals, ...session].map((e): Placed => ({ layer: e.layer, entry: e, label: e.label ?? `${e.effect} ${e.source}`, ...(e.origin ? { origin: e.origin } : {}), ...(e.created !== undefined ? { created: e.created } : {}) })),
    ];
    const words = (p: Placed): string => p.label + (p.layer !== "default" && p.entry.effect === "hide" ? hideLimits(platform) : "");
    const live = (p: Placed): boolean => p.layer === "default" || patternRefusal(p.entry.source, p.entry.effect) === undefined;
    return placed.map((r) => {
        const broken = live(r) ? undefined : patternRefusal(r.entry.source, r.entry.effect);
        const rivals = broken ? [] : placed.filter((o) => o !== r && live(o) && o.entry.effect !== r.entry.effect && overlap(r, o));
        const overrides = rivals.filter((o) => beats(r.entry, o.entry)).map((o) => o.entry.id);
        const overriddenBy = rivals.filter((o) => beats(o.entry, r.entry)).map((o) => o.entry.id);
        const row: PolicyRow = {
            consumer: "files", layer: r.layer,
            entry: { id: r.entry.id, label: words(r), source: r.entry.source, effect: r.entry.effect, ...(r.origin ? { origin: r.origin } : {}), ...(r.created !== undefined ? { created: r.created } : {}), ...(broken ? { broken } : {}) },
            wins: overriddenBy.length === 0, overrides, overriddenBy,
        };
        if (r.layer !== "default") {
            const reach = r.layer === "global" ? "all" : "session";
            row.removal = r.entry.effect === "show"
                ? { class: "narrows", exposes: [], reach }
                : { class: "widens", exposes: rivals.filter((o) => overrides.includes(o.entry.id)).map((o) => ({ id: o.entry.id, label: words(o), effect: o.entry.effect })), reach };
        }
        return row;
    });
}
