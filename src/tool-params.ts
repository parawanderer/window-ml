// SHARED TOOL PARAMETERS — the ones several tools offer, described in ONE place.
//
// These were copy-pasted per tool, and the cost was NOT the tokens (they are short); it was that the copies
// disagreed. `token` was declared three times in three different wordings, one of them with a different TYPE
// — a model told the same parameter is `string` here and `boolean | string` there has been given a reason to
// get it wrong. `maxChars`/`revises` differed only in two interpolated values and were otherwise identical,
// which is exactly the shape that drifts silently: nothing fails when one copy is edited and the others are
// not, so the divergence is only ever noticed by a model acting on the stale one.
//
// So each builder takes what genuinely varies — the default cap, the tool's own name for an example — and
// nothing else. NOT a general "param library": a parameter belongs here once a SECOND tool needs it, because
// a shared description written for one caller is how the wording gets vague enough to fit both and useful to
// neither.
import type { JsonSchema } from "./contract";

/** The output-truncation pair. `defaultChars` and `max` differ per tool (an exec slot is smaller than a
 *  python one), and `advice` is the tool's own suggestion for what to do instead of raising the cap. */
export function outputCapParams(defaultChars: number, max: number, advice: string): Record<string, JsonSchema> {
    return {
        maxChars: { type: "number", description: `Raise the per-slot output truncation for THIS call (default ${defaultChars}, max ${max}). A raise needs human approval + \`maxCharsReason\`. ${advice}` },
        maxCharsReason: { type: "string", description: `Why this call needs more than the default ${defaultChars} chars — required when \`maxChars\` exceeds it; shown to the human on the approval card.` },
    };
}

/** The retry pair: which earlier call this revises, and the model's own one-line claim about what it altered.
 *  `toolName` only supplies the example pointer, so each tool shows its own alias rather than another's. */
export function retryParams(toolName: string): Record<string, JsonSchema> {
    return {
        revises: { type: "string", description: `If this is a RETRY of an earlier call, its pointer (\`@tool:abc1234\`, \`@tool:${toolName}\`, or \`@tool:"a label"\`). The panel then shows the human a diff of what changed. Changes nothing about how this runs.` },
        changed: { type: "string", description: "One line on what you changed, shown beside that diff. Only with `revises`." },
    };
}

/** OPT IN TO KEEPING A HANDLE on this call's output — `true`, or better a short label you will recognise
 *  later. Note this is NOT `dereference`'s `token`, which despite the name is the opposite direction: a
 *  reference you READ. Two parameters, one name; merging them would have been the wrong fix.
 *
 *  `example` is the label a caller suggests, so a server tool can say "the weather results" where a generic
 *  tool says "the pricing table". `withBoolean` is false for a tool whose token is a label only. */
export function citeParam(example: string, withBoolean = true): JsonSchema {
    const type = withBoolean ? (["boolean", "string"] as const) : "string";
    const lead = withBoolean
        ? "Keep a handle to this call's output. `true`, or better a SHORT LABEL for yourself"
        : "Optional: a SHORT LABEL for this output";
    return {
        type: type as unknown as JsonSchema["type"],
        description: `${lead} ("${example}") — the label is how you'll recognise it a dozen steps later, and you can find it by that name. The result then ends with an @tool:<id>: embed it in your answer with \`![caption](@tool:<id>:out)\`, and/or read it back with \`dereference\`. Opt in whenever the output is worth keeping — to show OR to reuse; off for exploratory steps.`,
    };
}
