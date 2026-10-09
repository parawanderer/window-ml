// cache-breakpoints.ts — ask an Anthropic model to cache a request's prefix, on the OpenAI wire format.

// OpenAI, DeepSeek and Gemini cache a repeated prefix on their own. Anthropic caches only when asked, so without it
// every call of a run pays full price for the tools, the system prompt and the whole history again (Claude was most of
// the bench's OpenRouter spend, 2026-10-09). One top-level `cache_control` turns on Anthropic's AUTOMATIC caching: the
// breakpoint goes on the last cacheable block, so the next call reads everything this one sent, tool results included.
// It replaced two per-message markers (#524), which had to dodge OpenWebUI: its /api/chat/completions rebuilds a system
// message as a plain string (merge_system_messages) and a tool result loses the marker, so they could not cover the
// latest turn. Measured through OpenWebUI to LiteLLM's native Anthropic route and to OpenRouter (mlbox,
// reports/ui-api/anthropic-cache-control-answer.md, addendum 2).

/** Model ids that are Anthropic's: only these are asked, so no other backend sees an unfamiliar key. */
const ANTHROPIC_MODEL = /(^|[./:-])(anthropic|claude)([./:-]|$)/i;

/**
 * Whether a model id names an Anthropic model, through whatever prefix the server gives it
 * (`litellm.anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5.5`, `claude-haiku-4-5`).
 * @param model the model id sent on the request
 * @returns true for an Anthropic model
 */
export function isAnthropicModel(model: unknown): boolean {
    return typeof model === "string" && ANTHROPIC_MODEL.test(model);
}

/**
 * The request body with Anthropic's automatic prompt caching asked for, when the model is Anthropic's; any other model's
 * body comes back as the same object.
 * @param body the OpenAI-format request body
 * @returns the body to send
 */
export function withPromptCache<B extends { model?: unknown }>(body: B): B {
    return isAnthropicModel(body.model) ? { ...body, cache_control: { type: "ephemeral" } } : body;
}
