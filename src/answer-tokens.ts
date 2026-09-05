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
import { TOKEN_HEX_SRC, TOOL_NAME_SRC, isTokenShape } from "./token-id";

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
const tokenLinkRe = (): RegExp => new RegExp(`(!?)\\[([^\\]]*)\\]\\(@tool:(${TOKEN_HEX_SRC}|${TOOL_NAME_SRC})(?::(in|out))?(?:\\s*\\|\\s*([a-z][a-z0-9]*))?\\)`, "g");
const isHex6 = (s: string): boolean => isTokenShape(s);

/** The character ranges of markdown CODE — fenced blocks and inline `` ` `` spans.
 *
 *  A citation inside code is being MENTIONED, not used: the model writes ``` `![example](@tool:abc1234)` ```
 *  to EXPLAIN the syntax, and rendering it swallows the explanation and shows the thing being described in
 *  place of the description. It is the rule the `@tool:` macro already follows in `exec` — a C macro does
 *  not expand inside a string or a comment — arrived at here from the other direction.
 *
 *  Fences are matched FIRST and their interior is skipped wholesale, because a fenced block may contain an
 *  odd number of backticks and pairing them across it would mark half the document as code. Inline spans
 *  honour the CommonMark run rule: a span opened with N backticks closes on the next run of exactly N.
 *
 *  A 4-SPACE INDENTED BLOCK IS DELIBERATELY NOT CODE HERE, because it is not code in the renderer either —
 *  `markdown()` emits an ordinary paragraph for it. This function exists to keep the citation parser and the
 *  text renderer agreeing about what code is, so calling an indented block code would leave an unexpanded
 *  `![x](@tool:…)` sitting in plain prose, which reads as a BROKEN citation rather than as an explanation.
 *  If the renderer ever grows indented-code support, this has to grow with it — `tests/answer-tokens` pins
 *  both halves of that coupling so the decision surfaces instead of drifting. */
export function codeRanges(md: string): [number, number][] {
    const out: [number, number][] = [];
    const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
    let m: RegExpExecArray | null;
    let openAt = -1, marker = "";
    while ((m = fence.exec(md))) {
        if (openAt < 0) { openAt = m.index; marker = m[1][0].repeat(3); }
        else if (m[1][0].repeat(3) === marker) { out.push([openAt, m.index + m[0].length]); openAt = -1; }
    }
    if (openAt >= 0) out.push([openAt, md.length]);   // an UNCLOSED fence runs to the end — as markdown renders it
    const inFence = (i: number) => out.some(([a, b]) => i >= a && i < b);
    const tick = /`+/g;
    while ((m = tick.exec(md))) {
        if (inFence(m.index)) continue;
        const run = m[0].length, from = m.index;
        const close = new RegExp("(?<!`)`{" + run + "}(?!`)", "g");
        close.lastIndex = from + run;
        const c = close.exec(md);
        if (!c || inFence(c.index)) continue;         // unterminated → not a span; leave the rest alone
        out.push([from, c.index + run]);
        tick.lastIndex = c.index + run;
    }
    return out;
}

/** Is this offset inside markdown code? Shared by every pointer parser, so a citation the ANSWER renderer
 *  refuses to expand is one the PROSE renderer refuses to link — the two disagreeing would be worse than
 *  either behaviour on its own. */
export const inCode = (ranges: [number, number][], at: number): boolean =>
    ranges.some(([a, b]) => at >= a && at < b);

/**
 * Split answer markdown into prose + token segments. A 6-hex token always splits; a non-hex TOOL-NAME alias splits
 * only when `isAlias(name)` confirms that tool ran (accommodating `@tool:python_exec`). Everything else — a
 * malformed id with no such tool, a bare `@tool:`, a normal link — stays `prose`. No tokens → one prose segment.
 */
export function splitAnswer(md: string, isAlias?: (name: string) => boolean): AnswerSegment[] {
    const out: AnswerSegment[] = [];
    const code = codeRanges(md);
    let last = 0;
    for (const m of md.matchAll(tokenLinkRe())) {
        const [full, bang, label, id, slot, fmt] = m;
        // A non-hex id is only a token when the caller confirms it's a real tool that ran — otherwise leave the
        // whole span as ordinary markdown (don't advance `last`, so it flows into the surrounding prose verbatim).
        if (!isHex6(id) && !(isAlias?.(id))) continue;
        // Inside code it is being explained, not cited. Same non-advance of `last`, so it stays verbatim.
        if (inCode(code, m.index ?? 0)) continue;
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
    const code = codeRanges(md || "");
    // Same code exclusion as `splitAnswer`, or a citation that is only MENTIONED would still dedup the
    // bottom-of-answer render — removing an output on the strength of a mention that never showed it.
    for (const m of (md || "").matchAll(tokenLinkRe())) if (!inCode(code, m.index ?? 0)) ids.add(m[3]);
    return ids;
}

/**
 * Resolve a token ref to its item: an EXACT minted-id match first (`idOf(it) === ref`), else a TOOL-NAME ALIAS →
 * the LAST item that tool produced with a minted id (`toolOf(it) === ref`). The alias accommodates the model
 * naming `@tool:python_exec` = "the last python_exec output" — a friendly reference whose intent is unambiguous
 * (it never saw the hex id). Returns null when nothing matches — a hallucinated ref → an "unresolved" chip.
 */
export function resolveToken<T>(ref: string, items: readonly T[], idOf: (t: T) => string | undefined, toolOf: (t: T) => string | undefined, aliasScope?: readonly T[]): T | null {
    // An EXACT minted id anchors ONE specific step — search the WHOLE run, since a hex id is a permanent
    // reference that a LATER turn's answer can legitimately point back at (it never drifts). Only the coarse
    // tool-name ALIAS ("that tool's latest call") is narrowed by `aliasScope` (a single turn/block's steps), so
    // a prior answer's alias resolves within its own turn instead of drifting to a later call.
    for (const it of items) if (idOf(it) === ref) return it;
    let alias: T | null = null;
    for (const it of (aliasScope ?? items)) if (idOf(it) && toolOf(it) === ref) alias = it;   // LAST tool-name match that has a token
    return alias;
}

/**
 * Find the step a token id refers to by the token the loop MINTED onto that step (`st.token`), or — for a
 * tool-name alias — the LAST step of that tool. An exact hex id is matched against ALL `steps` (it anchors a
 * specific step in any turn); a tool-name alias is narrowed to `aliasScope` when given (the citing turn's
 * steps), so it doesn't drift to a later turn's call. Returns null when nothing matches. (See {@link resolveToken}.)
 */
export function resolveTokenStep<T extends { token?: string; tool?: string }>(id: string, steps: readonly T[], aliasScope?: readonly T[]): T | null {
    return resolveToken(id, steps, s => s.token, s => s.tool, aliasScope);
}


/** Remove from an ANSWER SET anything the model already showed inline in its prose.
 *
 *  The model routinely does both: it embeds `![table](@tool:a1b2c3:out)` mid-sentence AND calls the `answer`
 *  tool with the same output. Rendering the answer set underneath then shows the table twice — once where it
 *  was quoted and once appended at the end of the turn.
 *
 *  Identity is the resolved STEP, never the raw id: the prose may cite the hex while the answer set holds the
 *  tool-NAME alias (or the other way round), and comparing the strings would miss that they are the same
 *  output. `resolve` maps an id to whatever identifies the step it points at.
 *
 *  Returns the answer markdown with the duplicated citations dropped — which may be empty, meaning the whole
 *  set was already shown inline and the block should not render at all. */
export function answerWithoutShown(
    answerMd: string,
    shownMd: string,
    resolve: (id: string) => unknown,
    isAlias?: (name: string) => boolean,
): string {
    const shown = new Set<unknown>();
    for (const id of tokenIdsIn(shownMd)) { const step = resolve(id); if (step != null) shown.add(step); }
    if (!shown.size) return answerMd;
    return splitAnswer(answerMd, isAlias)
        .filter(seg => {
            if (seg.kind !== "token") return true;
            const step = resolve(seg.id);
            return step == null || !shown.has(step);
        })
        .map(seg => (seg.kind === "prose" ? seg.text : `${seg.embed ? "!" : ""}[${seg.label}](@tool:${seg.id}:${seg.slot}${seg.fmt ? ` | ${seg.fmt}` : ""})`))
        .join("");
}
