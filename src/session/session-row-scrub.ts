// session-row-scrub.ts — a session row as it leaves the worker: every registered value in its text replaced by its marker.

// A row (SessionSummary) is the most widely sent copy of a session: the chat page's list, the hub's sinks to every
// paired phone, the HUD's bring-here list, a `session.list` page. Its text (the task the person typed, the title made
// from it, the page's URL and title, a device's name) is built from what the browser and the person gave, so it can hold
// a registered value (docs/spec/SECRET_HANDLES.md, "A session row leaves the worker scrubbed"). Every string in the row
// is scrubbed but the identifiers below, so a text field added later is scrubbed without being named here. The rows are
// kept as they are and scrubbed at each exit, so a value registered later, and a row an older build stored, leave
// scrubbed too.

import { scrubRegistry, type RegistrySub } from "../secret-registry";
import type { SessionSummary } from "./session-host";

/** The row's identifiers, by path: no person or page wrote them, and a client keys or routes by them. Every other string
 *  in a row is text. */
export const ROW_IDENTIFIERS: ReadonlySet<string> = new Set([
    "id.runtime", "id.hash", "kind", "status", "model", "startedBy.id", "startedBy.kind",
    "lineage.parent.runtime", "lineage.parent.hash", "lineage.request",
]);   // state: fixed

/**
 * A row with every registered value in its text replaced by `[REDACTED:<NAME>]`. Fails closed: with no substitutions to
 * trust (`subs` null, a registry not yet read), each text field is withheld, which a client already reads as absent (a
 * list falls back from the title to the task, then to the hash), and a page whose URL is withheld is dropped whole.
 * @param row the row as the index holds it
 * @param subs the registry's substitutions, or null when they cannot be trusted
 * @returns the row, copied where a field changed
 */
export function rowForEgress<T extends SessionSummary>(row: T, subs: readonly RegistrySub[] | null): T {
    if (subs && !subs.length) return row;
    return scrubLeaves(row, "", subs, 4) as T;
}

/**
 * One text of a row's, as {@link rowForEgress} sends it: for a text the worker reads beside a row (a held run's page URL).
 * @param text the text
 * @param subs the substitutions, or null to withhold
 * @returns the text, or undefined when it is withheld
 */
export function textForEgress(text: string, subs: readonly RegistrySub[] | null): string | undefined {
    return subs ? scrubRegistry(text, subs).text : undefined;
}

/** Whether a string is anywhere under `value`. */
function holdsText(value: unknown): boolean {
    if (typeof value === "string") return true;
    return value != null && typeof value === "object" && Object.values(value).some(holdsText);
}

/**
 * Every string under `value` that is not an identifier, scrubbed or (with no `subs`) dropped.
 * @param value the value
 * @param path its dotted path in the row
 * @param subs the substitutions, or null to withhold
 * @param depth how much deeper to look
 */
function scrubLeaves(value: unknown, path: string, subs: readonly RegistrySub[] | null, depth: number): unknown {
    if (typeof value === "string") {
        if (ROW_IDENTIFIERS.has(path)) return value;
        return subs ? scrubRegistry(value, subs).text : undefined;
    }
    if (value == null || typeof value !== "object") return value;
    // Deeper than any row's text goes today, so unread: withheld rather than sent as it is when it holds any text.
    if (depth < 0) return holdsText(value) ? undefined : value;
    if (Array.isArray(value)) return value.map((v) => scrubLeaves(v, path, subs, depth - 1)).filter((v) => v !== undefined);
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
        const s = scrubLeaves(v, path ? `${path}.${k}` : k, subs, depth - 1);
        if (s !== v) changed = true;
        if (s !== undefined) out[k] = s;
    }
    // A page whose URL was withheld is no page: a client reads `url` as present wherever the object is. An object the
    // scrub emptied (a search's `match`) is nothing to send.
    if (typeof (value as { url?: unknown }).url === "string" && out.url === undefined) return undefined;
    if (changed && !Object.keys(out).length) return undefined;
    return changed ? out : value;
}
