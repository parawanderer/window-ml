// contract-chat.ts — a MODEL CALL and what came back: messages, options, usage, and the run's arithmetic.
//
// The neutral message shape every API format converts to and from (NeutralMessage, Role, ToolCall) -- travel
// in this shape, convert at the wire, never the other way round. Then the options a call is made with
// (ChatOptions, ExtendProfile), the conversation handle createChat returns, and what the server reports back:
// TokenUsage, GenPhase, LlmResult.
//
// RunStats and its three helpers live here rather than in a UI module on purpose. They are the ONE place a
// run's tokens-per-second and its provenance are computed, so the sidebar, the exports and the bench cannot
// each arrive at a slightly different number for the same run.
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { JsonSchema } from "./contract";
import type { RequestUse } from "./contract-run";

/** Who a message is FROM, in the neutral shape. `tool` is a tool's result being fed back, which the openai
 *  format carries with a tool_call_id and the ollama format carries without one. */
export type Role = "system" | "user" | "assistant" | "tool";

/** Neutral message shape; each API format converts it to its wire form. */
export interface NeutralMessage {
    role: Role;
    content: string | null;
    /** full data URLs */
    images?: string[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** OpenWebUI tool/RAG provenance */
    sources?: unknown[];
}

/** Normalized tool call — `{ id, name, arguments }` regardless of backend. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown> | string;
}

/** Token accounting for ONE request, when the server reports it (OpenWebUI returns a
 *  `usage` block; Ollama-native returns prompt_eval_count/eval_count).
 *
 *  IMPORTANT: `promptTokens` already covers the WHOLE conversation — every turn
 *  re-sends the full history — so live context occupancy is
 *  `promptTokens + completionTokens` of the LATEST call, never a sum across turns
 *  (summing would overcount quadratically). Only cumulative SPEND is a sum. */
export interface TokenUsage {
    /** OUR id for the request this usage came back from, sent as `hint.request` and echoed on a patched ollama's
     *  `gen.end` — what lets the panel match the server's record of this generation to it exactly. */
    requestId?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** How much of the prompt the server's prefix cache served — OpenAI's standard
     *  `usage.prompt_tokens_details.cached_tokens` (ollama's own OpenAI route, and OpenWebUI's once its fork is
     *  deployed), ollama-native `prompt_eval_cached_count`, or the protobuf `End.cached_tokens`. `0` is a COLD
     *  prefill; ABSENT is "not reported" — never collapsed, since a count of 0 is a measurement. A cache hit is
     *  invisible in `promptTokens`, which is the same either way; this and the prefill's duration are the
     *  evidence. Cheap in TIME, never in tokens — do not fold it into a spend figure. */
    cachedTokens?: number;
    /** How many of `completionTokens` were THINKING — COUNTED, not estimated from text. From the server's own
     *  `completion_tokens_details.reasoning_tokens` when it reports a nonzero one (ollama and OpenWebUI send 0
     *  whatever the model did, so a 0 there is not taken), else from a streamed turn: the engine's running count on
     *  the last chunk while the call was still in its thinking phase. Absent on a call that neither reported nor
     *  streamed a count — a surface then estimates, and says so. */
    reasoningTokens?: number;
    /** Wall-clock ms of THIS model call, measured at the source (around the fetch). ALWAYS available; it
     *  includes the call's own network/queue latency (TTFT) — the honest "time spent waiting on the model". */
    genMs?: number;
    /** Ollama-native `eval_duration` (generation-only, ns → ms) when the native route reports it. PREFERRED
     *  over `genMs` for a tok/s rate (it excludes network/queue); absent for cloud / OpenWebUI-OpenAI. */
    evalMs?: number;
    /** Ollama-native `load_duration` (ns → ms): how long THIS call spent loading the model before generating.
     *  Small and constant when the model was already resident; seconds-to-a-minute when it was not — which is
     *  the difference between "the model was slow" and "the model wasn't there yet", and the only place that
     *  answer exists. Absent for cloud / OpenWebUI-OpenAI, which don't report it. */
    loadMs?: number;
    /** Ollama-native `prompt_eval_duration` (ns → ms): reading the prompt, before a token comes back. Real
     *  model work, and it scales with the conversation — a system prompt re-sent every turn is paid for every
     *  turn. It is the difference between a model that is slow to answer and a BOX that is slow to reach:
     *  without it, `genMs - evalMs` lumps prompt eval together with queue and network, and a gap between two
     *  models cannot be attributed to either. Absent for cloud / OpenWebUI-OpenAI. */
    promptEvalMs?: number;
    /** WHAT the model was doing across this call, when we could observe it — see {@link GenPhase}. STREAMED
     *  CALLS ONLY: a non-streaming response is one object with one `eval_duration`, which says how long the
     *  generation took but not when it stopped thinking and started answering. Splitting that by text length
     *  would be inventing a timestamp, so it stays absent and the surfaces draw one undifferentiated block. */
    genPhases?: GenPhase[];
}

/** One stretch of a generation, by what the model was emitting: its thinking channel, its reply, or the
 *  fragments of a tool call.
 *
 *  A MARK, not a span: `atMs` is where the phase STARTED, as an offset from the call's own start, and it runs
 *  until the next mark (or the end of the call). Offsets rather than absolute stamps so the marks stay
 *  meaningful without carrying a clock alongside them, and so they line up with `genMs` — which is measured
 *  from the same origin — instead of drifting against it.
 *
 *  A SEQUENCE, deliberately, not three buckets. Models interleave: reasoning resumes after a tool call's
 *  fragments, and a run that thinks-calls-thinks is a real shape. Bucketing would collapse the re-entry and
 *  draw one long block that never happened. */
export interface GenPhase {
    /** `think` the reasoning channel · `answer` the reply content · `call` tool-call fragments. */
    kind: "think" | "answer" | "call";
    /** Offset in ms from the START of the model call. */
    atMs: number;
}

/** How much captured tool output the UI keeps. Deliberately FAR larger than the model-facing cap: the model's
 *  clip protects its context budget, but the human watching a stream shouldn't see the output SHRINK when the
 *  step finishes. The surplus is shown MARKED as "captured, but not sent to the model" (see `seen`), so the two
 *  views never get confused. Shared by exec / python_exec and the loop's live-stream fan so live == final. */
export const UI_OUT_CAP = 12000;

/** Whole-run token accounting, cumulative across every model call — the numbers API consumers care about
 *  (spend) plus a generation rate. Computed by {@link runStats} and shared by the DevTools bottom bar, the
 *  chat_metadata tool, and the exports so all three agree. */
export interface RunStats {
    inTokens: number;      // cumulative prompt-token SPEND: Σ promptTokens (billed every call — a real sum, unlike live occupancy)
    outTokens: number;     // cumulative completion tokens (all generated output, incl. thinking)
    totalTokens: number;   // in + out
    calls: number;         // model calls that reported usage
    tokPerSec: number | null;   // outTokens ÷ Σ per-call generation seconds; null when no timing was captured
    genBasis: "eval" | "wall" | "mixed" | null;   // eval = Ollama generation-only; wall = includes network/queue; mixed = some of each
}

/** Fold per-call usage samples into a whole-run summary. Cumulative in/out are SUMS (each call is billed the
 *  full prompt it re-sends). The tok/s denominator prefers Ollama's `evalMs` (generation-only) per call and
 *  falls back to the wall-clock `genMs` (which includes that call's network/queue) — `genBasis` records which,
 *  so a surface can be honest about what the rate measures. Pure; null/empty samples are skipped. */
export function runStats(usages: readonly (TokenUsage | null | undefined)[]): RunStats {
    let inTokens = 0, outTokens = 0, totalTokens = 0, calls = 0;
    let ratedOut = 0, genMs = 0, evalCount = 0, wallCount = 0;   // rate basis: only calls that carried timing
    for (const u of usages) {
        if (!u) continue;
        calls++;
        inTokens += u.promptTokens || 0;
        outTokens += u.completionTokens || 0;
        totalTokens += u.totalTokens || ((u.promptTokens || 0) + (u.completionTokens || 0));
        const ms = u.evalMs ?? u.genMs;   // prefer generation-only (Ollama); else wall-clock (incl. network)
        if (ms != null && ms > 0) {
            genMs += ms; ratedOut += u.completionTokens || 0;
            if (u.evalMs != null) evalCount++; else wallCount++;
        }
    }
    const tokPerSec = genMs > 0 ? ratedOut / (genMs / 1000) : null;
    const genBasis = (evalCount || wallCount) ? (evalCount && wallCount ? "mixed" : evalCount ? "eval" : "wall") : null;
    return { inTokens, outTokens, totalTokens, calls, tokPerSec, genBasis };
}

/** The tok/s rate as a short display string ("42 tok/s" / "6.3 tok/s"), or null when no timing was captured. */
export function fmtTokPerSec(s: RunStats): string | null {
    if (s.tokPerSec == null) return null;
    return `${s.tokPerSec >= 100 ? Math.round(s.tokPerSec) : s.tokPerSec.toFixed(1)} tok/s`;
}

/** A one-line PROVENANCE explanation for the tok/s figure — what the denominator actually measured — for a
 *  hover tooltip, so the rate is never presented as more precise than it is. */
export function runStatsProvenance(s: RunStats): string {
    const basis = s.genBasis === "eval" ? "Ollama generation time (eval_duration — excludes network/queue)"
        : s.genBasis === "wall" ? "wall-clock per model call (includes network + queue latency)"
        : s.genBasis === "mixed" ? "Ollama generation time where reported, else wall-clock (includes network)"
        : "no per-call timing was available";
    const rate = s.tokPerSec == null ? `rate unavailable — ${basis}` : `${s.outTokens} generated tokens ÷ ${basis}`;
    return `${rate}. Cumulative spend: ${s.inTokens} in + ${s.outTokens} out across ${s.calls} model call${s.calls === 1 ? "" : "s"}.`;
}

/** What ONE model call came back with, after the format's own extraction. `model` is what the server
 *  actually used once it resolved extend/ocr/default, which is not necessarily what was asked for, and
 *  reasoning is kept apart from content so a thinking model's prose is never mistaken for its answer. */
export interface LlmResult {
    content: string;
    sources?: unknown[] | null;
    /** the model actually used, after server-side resolution (extend/ocr/default) */
    model?: string | null;
    /** separate reasoning/thinking text (reasoning_content / message.thinking) */
    reasoning?: string | null;
    /** token counts, when the server reports them */
    usage?: TokenUsage | null;
}

/** Config "profile" a call extends. "utility" pulls model + num_ctx/num_gpu
 *  from the saved utility-model config (falling back to the default model when
 *  none is set); "default"/omitted is the plain default-model behaviour.
 *  Explicit options always override the profile ({ ...profile, ...explicit }). */
export type ExtendProfile = "default" | "utility";

/** Everything a chat call can be asked for: which model, how much context, whether to stream, what shape to
 *  answer in, which server tools to allow. Every field is optional and the defaults come from the saved
 *  config, so `ml.chat("hi")` and a fully specified call go down the same path. */
export interface ChatOptions {
    system?: string | null;
    model?: string | null;
    extend?: ExtendProfile | null;
    /** Ollama num_ctx (context window); ollama format only */
    numCtx?: number | null;
    /** Ollama num_gpu (0 = force CPU); ollama format only */
    numGpu?: number | null;
    /** Toggle the model's separate reasoning pass: true = think before answering, false = don't;
     *  null = omit the param (Ollama-only — some cloud models reject it). The thinking text is
     *  returned separately from the reply, not inline. */
    think?: boolean | null;
    images?: (string | HTMLImageElement)[];
    schema?: JsonSchema | null;
    toolIds?: string[] | null;
    maxTokens?: number | null;
    save?: boolean;
    onToken?: (delta: string, full: string) => void;
    /** abort the request (streaming disconnects the Port; both kill the fetch) */
    signal?: AbortSignal | null;
    /** Who waits for the output, told to a patched ollama so it can learn how models are used ({@link RequestUse}).
     *  Omit it when you cannot tell — a script and a person at the console call this alike — and nothing is
     *  guessed; `extend: "utility"` defaults to `"utility"`. Never changes the answer. */
    use?: RequestUse;
}

/** A stateful multi-turn chat (the object ml.createChat returns). Its methods'
 *  `this` is the history object itself — annotate ml.createChat's return type as
 *  `MlHistory` so `this.model` / `this.messages` resolve (do NOT rewrite `this`
 *  to the captured `ml`; that's window.ml, a different object). */
export interface MlHistory {
    messages: NeutralMessage[];
    hash: string;
    model: string | null;
    extend: ExtendProfile | null;
    numCtx: number | null;
    numGpu: number | null;
    think: boolean | null;
    schema: JsonSchema | null;
    toolIds: string[] | null;
    maxTokens: number | null;
    save: boolean;
    chat(this: MlHistory, prompt: string, opts?: ChatOptions): Promise<string | Record<string, unknown>>;
    fork(this: MlHistory): MlHistory;
}
