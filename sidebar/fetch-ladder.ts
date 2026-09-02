// The Markdown ladder's presentation, in ONE place: the rung names, the glyphs, and the ASCII form.
//
// The sidebar draws a DOM tree and both export sinks emit an ASCII one, and they must agree — the export is
// how a run is read back later, so a rung that reads differently there is a rung you can't trust. Same reason
// `timestamps.ts` is shared by the gutter and the sinks, and the same lesson as PIPE_CMDS: a second copy of a
// label list is a copy that will drift.
//
// Pure — no DOM, no preact. Unit-tested.
import type { FetchAttempt } from "../contract";

/** What each rung MEANS. A row shows the URL when it has one, but a `.md` URL and a declared one look
 *  identical, so the meaning has to be carried separately. */
export const RUNG_LABEL: Record<FetchAttempt["strategy"], string> = {
    accept: "Accept: text/markdown",
    declared: "declared by the page",
    sibling: "derived .md URL",
    convert: "convert HTML → Markdown",
};

/** How the winning rung is named in the footer. `convert` says whose Markdown it is: a reader who can't tell
 *  the site's authored text from our reduction can't judge whether a missing detail was cut or never there. */
export const RESOLVED_LABEL: Record<FetchAttempt["strategy"], string> = {
    accept: "content negotiation",
    declared: "the version the page declares",
    sibling: "its .md URL",
    convert: "local conversion — OUR reduction, not the site's own text",
};

export const GLYPH: Record<FetchAttempt["outcome"], string> = {
    hit: "✓", "not-markdown": "✗", error: "✗", skipped: "·",
};

/** Byte counts at a glance; the exact number is never the point here. */
export function bytes(n?: number): string {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

/** The row's headline: the URL for the rungs that fetched a DIFFERENT one, else the rung's name. `accept`
 *  refetches nothing new (it is the same URL) and `convert` fetches nothing at all, so both read better named. */
export function rungLabel(a: FetchAttempt): string {
    return a.url && a.strategy !== "accept" && a.strategy !== "convert" ? a.url : RUNG_LABEL[a.strategy];
}

/** status · content-type · size · duration, omitting whatever the rung didn't produce. */
export function rungMeta(a: FetchAttempt): string {
    return [
        a.status != null ? String(a.status) : "",
        a.contentType ? a.contentType.split(";")[0].trim() : "",
        bytes(a.bytes),
        a.ms != null ? `${a.ms} ms` : "",
    ].filter(Boolean).join(" · ");
}

/** The ladder as ASCII lines — the export form, and the shape the sidebar's DOM version mirrors. Every rung is
 *  emitted including the unused ones, so the protocol is legible from a single render instead of having to be
 *  inferred across several. Empty array when negotiation didn't run. */
export function ladderLines(attempts: FetchAttempt[] | undefined, resolvedBy?: FetchAttempt["strategy"]): string[] {
    if (!attempts?.length) return [];
    const out = attempts.map((a, i) => {
        const rail = i === attempts.length - 1 ? "└─" : "├─";
        const meta = rungMeta(a);
        return `${rail} ${GLYPH[a.outcome] || "·"}  ${rungLabel(a)}${meta ? `   ${meta}` : ""}${a.note ? `   ${a.note}` : ""}`;
    });
    if (resolvedBy) out.push(`      resolved by  ${RESOLVED_LABEL[resolvedBy] || resolvedBy}`);
    return out;
}
