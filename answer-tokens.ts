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

// The ONE shape treated as a token: an OPTIONAL leading `!` (embed) + `[label](@tool:<6hex>[:in|:out][ | <fmt>])`.
// A 6-hex id (matching util.toolToken), an optional slot, an optional piped format. Anything else — a non-hex id,
// a bare `@tool:`, a normal link — does NOT match, so it renders as plain markdown. `g` for matchAll; built fresh
// each call so no shared lastIndex state.
const tokenLinkRe = (): RegExp => /(!?)\[([^\]]*)\]\(@tool:([0-9a-f]{6})(?::(in|out))?(?:\s*\|\s*([a-z][a-z0-9]*))?\)/g;

/**
 * Split answer markdown into prose + token segments. Only exact token-grammar links become `token` segments;
 * everything else (including malformed `@tool:` links) stays `prose`. An answer with no tokens → one prose segment.
 */
export function splitAnswer(md: string): AnswerSegment[] {
    const out: AnswerSegment[] = [];
    let last = 0;
    for (const m of md.matchAll(tokenLinkRe())) {
        const [full, bang, label, id, slot, fmt] = m;
        const at = m.index ?? 0;
        if (at > last) out.push({ kind: "prose", text: md.slice(last, at) });
        out.push({ kind: "token", embed: bang === "!", label: label || "", id, slot: (slot as "in" | "out") || "out", ...(fmt ? { fmt } : {}) });
        last = at + full.length;
    }
    if (last < md.length) out.push({ kind: "prose", text: md.slice(last) });
    return out.length ? out : [{ kind: "prose", text: md }];
}

/** Does this answer contain at least one real `@tool` token? (Lets a surface skip the split/toggle entirely.) */
export const hasTokens = (md: string): boolean => tokenLinkRe().test(md);

/** The set of tool-output ids referenced in a piece of markdown (the model's final answer) — EMBED or LINK form.
 *  Used to DEDUP the bottom-of-answer render (an output already shown inline shouldn't also be appended). */
export function tokenIdsIn(md: string): Set<string> {
    const ids = new Set<string>();
    for (const m of (md || "").matchAll(tokenLinkRe())) ids.add(m[3]);
    return ids;
}

/**
 * Find the step a token id refers to by the token the loop MINTED onto that step (`st.token`). The loop stores the
 * exact id it handed the model, so this is a direct equality match — no re-derivation, so it can't drift from what
 * was minted (a runHash mismatch or a hash collision used to resolve the WRONG step). Run-scoped (only this run's
 * steps are passed in). Returns null when nothing matches — a hallucinated or foreign id → an "unresolved" chip.
 */
export function resolveTokenStep<T extends { token?: string }>(id: string, steps: readonly T[]): T | null {
    for (const st of steps) if (st.token === id) return st;
    return null;
}
