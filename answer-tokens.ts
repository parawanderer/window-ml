// Parsing + resolving `@tool:<id>` references embedded in an agent's final answer (see docs/spec/TOOL_TOKENS.md).
//
// The model references a tool output it saw with one of two markdown forms whose URL is the token:
//   • `![label](@tool:e7ed9f:out)` — IMAGE syntax = EMBED: the output EXPANDS IN PLACE (a table/image/value).
//     We use image syntax deliberately: the model already knows `![](…)` means "insert this content here", so
//     the macro is self-evident — no need to keep telling it "this isn't a clickable link".
//   • `[label](@tool:e7ed9f:out)` — LINK syntax = LINK: renders as a clickable link that jumps to the output
//     (the source step), showing `label` as the link text rather than expanding the output inline.
// (`:in` cites the call/code, `:out` the result; `| fmt` is a render override, e.g. `latex`.) This module is the
// PURE core every surface (HUD card, sidebar, export sinks) shares; rendering lives in the surfaces (DOM-free here).
//   • splitAnswer  — cut the answer markdown into prose + token segments, GRAMMAR-GATED so only a real token is
//                    ever special-cased (a garbled / hallucinated-looking link just stays prose = ordinary markdown).
//   • resolveTokenStep — map a token id back to THIS run's step by the token the loop MINTED onto it.

/** One piece of a split answer: literal markdown, or a resolved-later token reference. `embed` = image form
 *  (`![…]`, expand in place); else the link form (`[…]`, a clickable jump to the output). */
export type AnswerSegment =
    | { kind: "prose"; text: string }
    | { kind: "token"; embed: boolean; label: string; id: string; slot: "in" | "out"; fmt?: string };

// The shape treated as a token: an OPTIONAL leading `!` (embed) + `[label](@tool:<id>[:in|:out][ | <fmt>])`. The id
// is EITHER a 6-hex minted token (util.toolToken) OR a TOOL-NAME ALIAS (`python_exec`, `exec`, …) the model wrote
// instead — models routinely reference "the last python_exec output" by NAME, never having seen the hex id (a
// citable builtin mints its token silently, without opting in). A 6-hex id is always a token; a NON-hex alias is a
// token ONLY when a caller-supplied `isAlias(name)` confirms that tool actually ran (else it's ordinary markdown,
// left as prose — the grammar gate). A bare `@tool:`, a normal link, etc. never match. `g` for matchAll; built
// fresh each call so no shared lastIndex state.
const tokenLinkRe = (): RegExp => /(!?)\[([^\]]*)\]\(@tool:([0-9a-f]{6}|[a-z][a-z0-9_]*)(?::(in|out))?(?:\s*\|\s*([a-z][a-z0-9]*))?\)/g;
const isHex6 = (s: string): boolean => /^[0-9a-f]{6}$/.test(s);

/**
 * Split answer markdown into prose + token segments. A 6-hex token always splits; a non-hex TOOL-NAME alias splits
 * only when `isAlias(name)` confirms that tool ran (accommodating `@tool:python_exec`). Everything else — a
 * malformed id with no such tool, a bare `@tool:`, a normal link — stays `prose`. No tokens → one prose segment.
 */
export function splitAnswer(md: string, isAlias?: (name: string) => boolean): AnswerSegment[] {
    const out: AnswerSegment[] = [];
    let last = 0;
    for (const m of md.matchAll(tokenLinkRe())) {
        const [full, bang, label, id, slot, fmt] = m;
        // A non-hex id is only a token when the caller confirms it's a real tool that ran — otherwise leave the
        // whole span as ordinary markdown (don't advance `last`, so it flows into the surrounding prose verbatim).
        if (!isHex6(id) && !(isAlias?.(id))) continue;
        const at = m.index ?? 0;
        if (at > last) out.push({ kind: "prose", text: md.slice(last, at) });
        out.push({ kind: "token", embed: bang === "!", label: label || "", id, slot: (slot as "in" | "out") || "out", ...(fmt ? { fmt } : {}) });
        last = at + full.length;
    }
    if (last < md.length) out.push({ kind: "prose", text: md.slice(last) });
    return out.length ? out : [{ kind: "prose", text: md }];
}

/** Does this answer contain at least one real `@tool` token? (Lets a surface skip the split/toggle entirely.)
 *  Same alias gate as `splitAnswer` — pass `isAlias` so a tool-name alias counts. */
export const hasTokens = (md: string, isAlias?: (name: string) => boolean): boolean =>
    splitAnswer(md, isAlias).some(s => s.kind === "token");

/** The set of tool-output ids referenced in a piece of markdown (the model's final answer) — EMBED or LINK form,
 *  hex OR tool-name alias. Used to DEDUP the bottom-of-answer render (an output shown inline shouldn't also be
 *  appended) and to drive `res.outputs`; an alias that resolves to no render is harmlessly skipped downstream. */
export function tokenIdsIn(md: string): Set<string> {
    const ids = new Set<string>();
    for (const m of (md || "").matchAll(tokenLinkRe())) ids.add(m[3]);
    return ids;
}

/**
 * Resolve a token ref to its item: an EXACT minted-id match first (`idOf(it) === ref`), else a TOOL-NAME ALIAS →
 * the LAST item that tool produced with a minted id (`toolOf(it) === ref`). The alias accommodates the model
 * naming `@tool:python_exec` = "the last python_exec output" — a friendly reference whose intent is unambiguous
 * (it never saw the hex id). Returns null when nothing matches — a hallucinated ref → an "unresolved" chip.
 */
export function resolveToken<T>(ref: string, items: readonly T[], idOf: (t: T) => string | undefined, toolOf: (t: T) => string | undefined): T | null {
    for (const it of items) if (idOf(it) === ref) return it;   // exact minted id
    let alias: T | null = null;
    for (const it of items) if (idOf(it) && toolOf(it) === ref) alias = it;   // LAST tool-name match that has a token
    return alias;
}

/**
 * Find the step a token id refers to by the token the loop MINTED onto that step (`st.token`), or — for a
 * tool-name alias — the LAST step of that tool. Run-scoped (only this run's steps are passed in). Returns null
 * when nothing matches. (See {@link resolveToken}.)
 */
export function resolveTokenStep<T extends { token?: string; tool?: string }>(id: string, steps: readonly T[]): T | null {
    return resolveToken(id, steps, s => s.token, s => s.tool);
}
