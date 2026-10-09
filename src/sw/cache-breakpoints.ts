// cache-breakpoints.ts — mark where an Anthropic model may cache a request's prefix, on the OpenAI wire format.

// OpenAI, DeepSeek and Gemini cache a repeated prefix on their own. Anthropic caches only up to an explicit
// `cache_control` breakpoint, so without one every call of a run pays full price for the tools, the system prompt and
// the whole history again (Claude was most of the bench's OpenRouter spend, 2026-10-09). The breakpoint has to sit on a
// USER or ASSISTANT message: OpenWebUI's /api/chat/completions rebuilds a system message as a plain string from its
// first text part (normalize_messages_for_model → merge_system_messages), dropping the marker, and a marker on a tool
// result does not arrive either. Measured through OpenWebUI to OpenRouter (reports/ui-api/anthropic-cache-control-answer.md
// on mlbox, and four pairs of calls from the laptop): a marked first user message cached tools + system + task; a
// marked assistant message cached everything up to it; the second call of each pair read the cache at about a
// twentieth of the price.

/** Model ids that are Anthropic's: only these get breakpoints, so no other backend sees an unfamiliar content shape. */
const ANTHROPIC_MODEL = /(^|[./:-])(anthropic|claude)([./:-]|$)/i;

/** The marker Anthropic reads; "ephemeral" is its only cache type. */
const MARK = { cache_control: { type: "ephemeral" } } as const;

/**
 * Whether a model id names an Anthropic model, through whatever prefix the server gives it
 * (`openrouter.anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5`, `claude-haiku-4-5`).
 * @param model the model id sent on the request
 * @returns true for an Anthropic model
 */
export function isAnthropicModel(model: unknown): boolean {
    return typeof model === "string" && ANTHROPIC_MODEL.test(model);
}

/**
 * The OpenAI-format messages with two cache breakpoints for an Anthropic model: on the FIRST user message (everything
 * before it, the tools and the system prompt, plus the task, is the run's stable prefix) and on the LAST assistant
 * message that has text (the history up to there, which the next call reads back). Anthropic allows four. A message's
 * text becomes a one-part content array carrying the marker; image parts are kept, the marker going on its last part.
 * Any other model gets the messages back unchanged, as the same array.
 * @param messages the wire messages, already in the OpenAI shape
 * @param model the model id
 * @returns the messages to send
 */
export function withCacheBreakpoints<M extends { role?: string; content?: unknown }>(messages: M[], model: unknown): M[] {
    if (!isAnthropicModel(model)) return messages;
    const firstUser = messages.findIndex((m) => m.role === "user");
    let lastAssistant = -1;
    // The last assistant message WITH text: a turn that only called tools has empty content, and an empty text block
    // is refused, so the breakpoint falls back to the turn before (the history to there still caches).
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant" && hasText(messages[i].content)) { lastAssistant = i; break; }
    if (firstUser < 0 && lastAssistant < 0) return messages;
    return messages.map((m, i) => (i === firstUser || i === lastAssistant ? marked(m) : m));
}

/** One message with the marker on its last content part, its text turned into a part when it was a plain string. */
function marked<M extends { content?: unknown }>(m: M): M {
    const c = m.content;
    if (typeof c === "string") return c ? { ...m, content: [{ type: "text", text: c, ...MARK }] } : m;
    if (Array.isArray(c) && c.length) return { ...m, content: [...c.slice(0, -1), { ...c[c.length - 1], ...MARK }] };
    return m;
}

/** Whether a message's content holds any text a marker can sit on. */
function hasText(c: unknown): boolean {
    return typeof c === "string" ? c.length > 0 : Array.isArray(c) && c.length > 0;
}
