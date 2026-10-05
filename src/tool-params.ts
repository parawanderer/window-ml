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

/** The reserved name a call's own title arrives under. Reserved, so a tool that already declares it keeps its
 *  own: a name this generic WILL collide one day, and silently replacing a tool's parameter is worse than
 *  going without the title on that one tool. */
export const CALL_TITLE = "title";

/**
 * THE MODEL'S OWN ACCOUNT OF ONE CALL, offered on every tool rather than opted into per tool.
 *
 * It exists for reading a log back: the arguments say what ran and the result says what came of it, but neither
 * says what the model THOUGHT it was doing, which is the question anyone investigating a run actually has. It is
 * a CLAIM and is shown as one — quoted, never in place of the arguments it sits beside.
 *
 * Deliberately short, because this rides in EVERY tool's schema on EVERY turn: a sentence here is multiplied by
 * the toolset and re-sent for the length of the run (AGENTS.md — never pad model-facing text). The form is pinned
 * by example rather than by adjectives, which is the cheapest way to get a title instead of a paragraph.
 */
export function callTitleParam(): JsonSchema {
    return { type: "string", description: "A few words on what this call is for, e.g. \"Count the fare cards\". Shown to the human; changes nothing about how this runs." };
}

/*
 * The compile-time half of the reserved name, for a tool written in TypeScript.
 *
 * `defineTool` throws on a clash, which is the guard that actually protects everyone — `window.ml` is called from
 * a devtools console and from userscripts, where no type checker runs. This catches the same mistake earlier for
 * the callers we DO compile, and the message is a string literal so the diagnostic says what to do rather than
 * "not assignable to type never".
 *
 * Only a LITERAL schema can be checked: a `properties` typed as a wide record has `string` for its keys, so every
 * schema would look like it declares `title`. That case is passed through — the throw still covers it.
 */
type ReservedParamError = "ERROR: `title` is a reserved tool parameter — every tool is given one for the model's own short description of a call. Rename this parameter.";
/** Reject a tool whose parameter schema declares the reserved {@link CALL_TITLE}, at COMPILE time — intersect it
 *  with a tool's `parameters` type and a literal schema that declares one stops type-checking, with the reason as
 *  the diagnostic's text. See the note above for why only a literal schema can be caught. */
export type NoReservedParams<P> =
    string extends keyof P ? unknown
    : typeof CALL_TITLE extends keyof P ? { properties: { title: ReservedParamError } }
    : unknown;

/**
 * Add {@link callTitleParam} to a tool's schema. Three schemas are left exactly as they are:
 *
 * - one that already declares the name (see {@link CALL_TITLE});
 * - one with no object schema at all — there is nowhere to put it, and inventing one would change the shape the
 *   model is told to send;
 * - **one that declares NO PROPERTIES OF ITS OWN**, which is `defineTool`'s default for a tool that named none.
 *   An empty `properties` is how this codebase spells "shape not specified", and `validateArgs` reads it that
 *   way: it cannot call an argument unknown against a tool that never said what it takes. Adding ours would make
 *   that schema non-empty and so turn on unknown-property checking for every such tool — a parameterless tool
 *   would start telling the model its own arguments were wrong. The title is also worth least there, since there
 *   are no arguments for it to be explaining.
 */
export function withCallTitle<T extends JsonSchema | undefined>(parameters: T): T {
    const props = (parameters as { properties?: Record<string, JsonSchema> } | undefined)?.properties;
    if (!parameters || !props || !Object.keys(props).length || CALL_TITLE in props) return parameters;
    return { ...parameters, properties: { ...props, [CALL_TITLE]: callTitleParam() } } as T;
}

/**
 * Split a call's title off its arguments, for the moment of dispatch.
 *
 * The title is OURS, not the tool's: a tool handed an argument its own code never declared is one `Object.keys`
 * away from behaving differently, and the DOM tools iterate their args. The event keeps the model's arguments
 * WHOLE either way — the log's standing promise is that what the model actually sent is recoverable — so this is
 * only about what reaches `run`.
 *
 * Returns the arguments unchanged, by identity, when there is no title to take: the common case allocates nothing.
 */
export function takeCallTitle(args: Record<string, unknown>): { args: Record<string, unknown>; title?: string } {
    const v = args[CALL_TITLE];
    if (typeof v !== "string" || !v.trim()) return { args };
    const rest = { ...args };
    delete rest[CALL_TITLE];
    return { args: rest, title: v.trim() };
}
