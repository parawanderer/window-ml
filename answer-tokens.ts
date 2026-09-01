// Parsing + resolving `@tool:<id>` references embedded in an agent's final answer (see docs/spec/TOOL_TOKENS.md).
//
// The model cites a tool output it saw with a markdown link whose URL is the token — `[label](@tool:e7ed9f:out)`
// (`:in` for the call, `| fmt` for a render override). This module is the PURE core that every surface (the HUD
// card, the sidebar, the export sinks) shares:
//   • splitAnswer  — cut the answer markdown into prose + token segments, GRAMMAR-GATED so only a real token is
//                    ever special-cased (a garbled / hallucinated-looking link just stays prose = ordinary markdown).
//   • resolveTokenStep — map a token id back to THIS run's step (re-derive each step's deterministic id), or null
//                    for an id that matches nothing (a hallucinated / foreign token → the caller shows an
//                    "unresolved" chip; never a crash, never a silent drop).
// The descriptor picking + actual rendering (RenderPanel / mdSink) live in the surfaces; this stays DOM-free.

import { toolToken } from "./util";

/** One piece of a split answer: literal markdown, or a resolved-later token reference. */
export type AnswerSegment =
    | { kind: "prose"; text: string }
    | { kind: "token"; label: string; id: string; slot: "in" | "out"; fmt?: string };

// The ONE shape treated as a token: `[label](@tool:<6hex>[:in|:out][ | <fmt>])`. A 6-hex id (matching the
// util.toolToken output), an optional slot, an optional piped format. Anything else — a non-hex id, a bare
// `@tool:`, a normal link — does NOT match, so it renders as plain markdown. `g` for matchAll; built fresh each
// call so no shared lastIndex state.
const tokenLinkRe = (): RegExp => /\[([^\]]*)\]\(@tool:([0-9a-f]{6})(?::(in|out))?(?:\s*\|\s*([a-z][a-z0-9]*))?\)/g;

/**
 * Split answer markdown into prose + token segments. Only exact token-grammar links become `token` segments;
 * everything else (including malformed `@tool:` links) stays `prose`. An answer with no tokens → one prose segment.
 */
export function splitAnswer(md: string): AnswerSegment[] {
    const out: AnswerSegment[] = [];
    let last = 0;
    for (const m of md.matchAll(tokenLinkRe())) {
        const [full, label, id, slot, fmt] = m;
        const at = m.index ?? 0;
        if (at > last) out.push({ kind: "prose", text: md.slice(last, at) });
        out.push({ kind: "token", label: label || "", id, slot: (slot as "in" | "out") || "out", ...(fmt ? { fmt } : {}) });
        last = at + full.length;
    }
    if (last < md.length) out.push({ kind: "prose", text: md.slice(last) });
    return out.length ? out : [{ kind: "prose", text: md }];
}

/** Does this answer contain at least one real `@tool` token? (Lets a surface skip the split/toggle entirely.) */
export const hasTokens = (md: string): boolean => tokenLinkRe().test(md);

/**
 * Find the step a token id refers to: re-derive each step's deterministic `hash(runHash:seq)` and match. Run-scoped
 * (a token can only resolve to THIS run's steps). Returns null when nothing matches — a hallucinated or foreign id.
 */
export function resolveTokenStep<T extends { seq?: number }>(id: string, steps: readonly T[], runHash: string): T | null {
    for (const st of steps) if (st.seq != null && toolToken(runHash, st.seq) === id) return st;
    return null;
}
