// MODEL PROSE, rendered — a margin note, a retry's claim, any short run of text the model wrote about its
// own work. Two things happen to it, and the split is the point:
//
//   · MARKDOWN, inline and escaped (`code`, *emphasis*, math), via the same `mdInline` every other prose
//     surface uses. The text is not ours, so it is escaped first and rendered second.
//   · POINTER LINKS resolved IN-RUN: `[the totals](@tool:abc1234)` becomes a control that goes to the step
//     that produced it, the same gesture (and the same green pulse) a citation makes.
//
// AND NOTHING ELSE. Deliberately:
//   · No IMAGES. These surfaces are gutters and tooltips — places with no room — and a tool result could
//     put pixels in one.
//   · No EXTERNAL links. A model-authored link out of a debug panel is a one-click egress the reader did
//     not ask for, in chrome they trust, chosen by a model a prompt-injected page can steer — and markdown
//     lets the text and the destination disagree. An http link stays the text it was written as.
// A pointer we cannot resolve also stays TEXT: a link that goes nowhere is worse than the words.
import type { AgentStep } from "./store";
import { resolveTokenStep } from "../answer-tokens";
import { mdInline } from "./format";
import { scrollToStepSeq } from "./answer-render";
import { cursorTipOn } from "./ui-kit";

/** `[label](@tool:<id>)` — the LINK form of a citation. The id charset matches the pointer forms elsewhere
 *  (a hex id, a bare tool name); an unresolvable one is left as text by the renderer below rather than
 *  refused here, since "the model named something that is not there" is a fact about the run, not a parse
 *  error. */
// The leading `(?<!!)` is load-bearing: `![x](@tool:…)` is the EMBED syntax the answer renderer honours, and
// without it the `[x](…)` inside an image matched and the `!` was left behind as text — turning an image
// into a link, in the one surface that must never render one.
const POINTER_LINK = /(?<!!)\[([^\]\n]+)\]\(@tool:([A-Za-z0-9_]+)(?::(in|out))?\)/g;

/** Split prose into text runs and pointer links, in order. Pure, so the parsing is testable without a DOM. */
export function splitProse(md: string): ({ text: string } | { label: string; id: string; slot?: "in" | "out" })[] {
    const out: ({ text: string } | { label: string; id: string; slot?: "in" | "out" })[] = [];
    let at = 0;
    for (const m of md.matchAll(POINTER_LINK)) {
        if (m.index! > at) out.push({ text: md.slice(at, m.index) });
        out.push({ label: m[1], id: m[2], ...(m[3] ? { slot: m[3] as "in" | "out" } : {}) });
        at = m.index! + m[0].length;
    }
    if (at < md.length) out.push({ text: md.slice(at) });
    return out;
}

/** Render model prose: inline markdown, with `@tool:` links resolved to the step that produced them.
 *  Without a run (`steps`) every pointer stays text — which is what the export and any
 *  context-free surface correctly want, rather than a link with nowhere to go. */
export function Prose({ md, steps, hash }: { md: string; steps?: readonly AgentStep[]; hash?: string }) {
    const parts = splitProse(md);
    if (parts.length === 1 && "text" in parts[0])
        return <span dangerouslySetInnerHTML={{ __html: mdInline(md) }} />;
    return <span>{parts.map((p, i) => {
        if ("text" in p) return <span key={i} dangerouslySetInnerHTML={{ __html: mdInline(p.text) }} />;
        const step = steps ? resolveTokenStep(p.id, steps) : null;
        // Unresolved → the label, plainly. The model naming a pointer that is not there is worth showing as
        // what it wrote, not as a dead control or an error chip in the middle of a sentence.
        if (!step?.seq && step?.seq !== 0)
            return <span key={i} dangerouslySetInnerHTML={{ __html: mdInline(p.label) }} />;
        return (
            <button key={i} class="tok-link prose-link"
                onClick={() => scrollToStepSeq(step.seq, hash, p.slot)}
                {...cursorTipOn(`Go to step ${step.localStep ?? step.step} · ${step.tool || "tool"} — the call that produced this.`)}
                dangerouslySetInnerHTML={{ __html: mdInline(p.label) }} />
        );
    })}</span>;
}
