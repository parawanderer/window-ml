// World-agnostic ml.agent orchestrator — the loop plus the SECURITY-CRITICAL gate ordering, with
// every world-specific capability (model call, tool execution, approval UI, message building)
// injected as a dependency. This is the reusable heart of design A: the SAME loop runs whether the
// deps execute tools in the page's main world (today) or the background DELEGATES them to the page
// (safe mode). The invariant it exists to guarantee:
//
//   a requiresApproval tool's run() is invoked ONLY after the approval gate (or a pure, trusted-world
//   auto-approve decision) grants it — and that decision never depends on anything the *executor*
//   controls. So moving the executor into hostile territory (the page) can't self-approve: the
//   deny/approve happens here, before `runTool` is ever called.
//
// No chrome, no DOM → builds standalone (dist/agent-loop.js) and is unit-tested against a mocked
// model / executor / gate in tests/agent-loop.test.js.

import type { AgentResult, AgentTranscriptEntry, ApprovalDecision, ToolCall, RenderDescriptor, ToolFeedback, SubcallUsage, TokenUsage, RunStats } from "./contract";
import { runStats, fmtTokPerSec, UI_OUT_CAP } from "./contract";
import type { TokenRender } from "./contract";
import { UNATTENDED_REFUSAL } from "./prompts";
import { toolToken } from "./util";
import { TokenStore, derefPipe, describeToken, extraBeyondModel, memoryFault, cleanLabel, nameOf, shortType, isAliasRef, parseLabel, DEREF_TOOL, type TokenKind, type TokenValue, type DerefRead } from "./token-pipe";

export type Approval = "readonly" | "sandbox" | "same-origin" | "consented" | "self-source" | "user" | "denied" | "skipped" | "cancelled";
export interface ToolMeta { name: string; requiresApproval?: boolean; capabilities?: string[]; remote?: import("./contract").RemoteToolTarget; }
// The tool's serializable result. `renderIn`/`renderOut` are the debug-render slots computed by the
// executor's world (page-side for the delegated path) so the emitter can show a rendered In/Out.
// `image` is a screenshot a vision tool (native `look`) captured — INLINE VISION: it's injected into
// the model's next turn as a user image (via pushToolImages) so the model reasons over the real pixels.
export interface ToolRunResult { result: string; elements?: unknown[]; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; image?: string; imageLabel?: string; images?: { image: string; label?: string }[]; feedback?: ToolFeedback; reused?: import("./contract").ReusedGrant[]; remoteMs?: import("./contract").RemoteTiming; }

export interface AgentLoopDeps {
    // One model turn → the assistant message (content + normalized tool_calls + usage + the separate
    // reasoning/thinking channel, which the sidebar shows as a collapsible "think" section).
    callModel(messages: unknown[], opts: { tools: ToolMeta[]; step: number }): Promise<{ content?: string | null; tool_calls?: ToolCall[]; usage?: unknown; reasoning?: unknown }>;
    // Execute a tool by name — LOCAL (page-side today) or DELEGATED (background → page, safe mode).
    // Reached for a requiresApproval tool ONLY after the gate. This is the untrusted delegation point.
    // `onStream`, when provided (opt-in `stream`), is handed to the tool as `ctx.stream` so it can stream live
    // output as it runs (the loop throttles + fans it). Ignored by tools that don't support streaming.
    runTool(name: string, args: Record<string, unknown>, onStream?: (text: string, ts?: number) => void): Promise<ToolRunResult>;
    // The approval gate (UI). Reached ONLY for a requiresApproval tool that isn't auto-approved. `seq`
    // and `step` identify the pending step so a background gate can correlate its async decision to it.
    approve(req: { tool: string; arguments: Record<string, unknown>; seq?: number; step?: number }): Promise<ApprovalDecision>;
    // Pure auto-approve decision, made in the TRUSTED world (python readonly / suspicious-char /
    // external-sheet). Returns the provenance to skip the gate, or null to require it. NEVER delegated —
    // a forged "it's auto-approved" is exactly the threat design A closes.
    // Returns the provenance to skip the gate, or null to require it — OR an object also naming the prior
    // grants this call REUSED (e.g. an already-approved Google Sheet), surfaced on the step for transparency.
    autoApprove?(name: string, args: Record<string, unknown>): Approval | { approval: Approval; reused?: import("./contract").ReusedGrant[] } | null;
    // Read-only try (exec only): attempt the call via the mediated read-only interpreter, which is
    // side-effect-free (it can't mutate) — so it BOTH decides "auto-approve" AND returns the result. A
    // non-null result skips the gate AND runTool (the interpreter already ran it). null → gate as normal.
    // Page-delegated on the background path; safe to delegate BECAUSE it can't do anything a mutation
    // could. Reached before autoApprove/the gate for a requiresApproval tool.
    tryReadonly?(name: string, args: Record<string, unknown>): Promise<ToolRunResult | null>;
    // PRE-RUN In render for the pending step (the tool's `render(input,args)` — exec's beautified JS,
    // python's code cell), so a step you WATCH streaming shows a pretty In instead of raw JSON args from the
    // moment it starts. Async because the background must ask the page to compute it. Used only for a
    // streaming run (that's when a pending step is on screen long enough to matter). Optional.
    renderFor?(name: string, args: Record<string, unknown>): Promise<RenderDescriptor | undefined>;
    // Doomed-action precheck (click/type): a side-effect-free target resolution → an ERROR STRING if the
    // action can only fail (no element / stale @pt / bad selector), else null/"" to proceed to the gate.
    // The loop uses it to SKIP the approval prompt for an action that would just fail. Page-delegated on
    // the background path (the DOM is page-side); safe BECAUSE the precheck can't mutate.
    precheck?(name: string, args: Record<string, unknown>): Promise<string | null>;
    // Build the initial neutral message array (system + user(task)) — world-specific (page context).
    buildMessages(task: string): unknown[];
    // Append the assistant tool-call message / a tool-result message to the running history.
    pushAssistant(messages: unknown[], msg: { content?: string | null; tool_calls?: ToolCall[] }): void;
    pushToolResult(messages: unknown[], call: ToolCall, result: string): void;
    // Inline vision: after a step, inject any screenshots the step's tools captured as a user turn, so
    // the NEXT model call sees the pixels (a tool RESULT can't carry an image; a user turn can). Omit
    // → no inline vision (a text-only driver). World-specific (the neutral message shape).
    pushToolImages?(messages: unknown[], images: { image: string; label: string }[]): void;
    // Debug/telemetry hook (agent-step events: pending START then the DONE, sharing `seq`).
    // `elements` carries the tool's real result nodes on a DONE (page-side only — nodes can't cross the
    // bus, so the background path leaves it undefined and assembles answer nodes separately). The page's
    // emit uses them for onStep + the debug event's element COUNT.
    /** A model call is UNDERWAY (and, on a streamed run, what it is emitting right now). Fired the instant
     *  the request goes out, so a surface can draw the call while it happens rather than back-dating a
     *  finished block over memory it already drew. Optional: a host that has no live surface omits it. */
    emitTurn?(ev: { step: number; phases?: import("./contract").GenPhase[] }): void;
    emit?(ev: { step: number; seq?: number; pending?: boolean; thought?: string; reasoning?: unknown; tool?: string; arguments?: Record<string, unknown>; result?: string; modelResult?: string; token?: string; approval?: Approval; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; feedback?: ToolFeedback; usage?: unknown; elements?: unknown[]; reused?: import("./contract").ReusedGrant[]; streamOutput?: string; streamMarks?: [number, number][]; remoteMs?: import("./contract").RemoteTiming }): void;
    // Mid-run STEERING (a.say()): drained at each step boundary (before the model call) — returns any user
    // messages queued since the last step, injected via pushUser so the model sees them on its next turn.
    // Omit → no steering. The queue lives in the caller's world (page handle / SW inbox).
    drainInbox?(): string[];
    pushUser?(messages: unknown[], text: string): void;
    // Self-introspection (ml.chatMetaTool): resolve the run's model facts for the metadata summary.
    // World-specific (page: ml.capabilities/ml.ps/config; background: the SW's caches). The token/message
    // counts come from the loop itself (accurate on BOTH paths), so only the MODEL facts need a dep.
    chatMeta?(): Promise<ChatMeta | null>;
    // This turn's DELEGATED-sub-call token tally (look/locate/verify's own vision calls) — spend the loop
    // never sees directly, metered where those events are suppressed (bus.ts). Omit → no delegated calls.
    subcallTokens?(): SubcallUsage;
}

/** Model facts for chat_metadata, resolved per-world. `local`: true = Ollama-resident, false = cloud/remote,
 *  null = undeterminable. `contextWindow`/`vramGB` are null when not resident or on a cloud model. */
export interface ChatMeta {
    model: string | null;
    contextWindow: number | null;
    capabilities: string[] | null;
    vramGB?: number | null;
    local?: boolean | null;
    backend?: string | null;   // "OpenWebUI" / "Ollama" / "OpenAI-compatible" — how the call is routed
    // ESTIMATED fixed-overhead tokens (~chars/4, no real tokenizer): the system prompt and the tool-schema
    // list — the part of every request that ISN'T the conversation. The world provides these (it has the
    // full system prompt + tool descriptions; the loop only has ToolMeta names).
    systemTokens?: number | null;
    toolTokens?: number | null;
}

/** prompt/completion token counts from a usage object. The extension NORMALIZES usage to camelCase
 *  (TokenUsage: promptTokens/completionTokens/totalTokens — see extractUsage), so read that FIRST; fall
 *  back to the raw OpenAI (prompt_tokens) / Ollama (prompt_eval_count) names for any un-normalized source.
 *  Non-numbers → 0. (Reading only snake_case was the "generated: 0 tokens" bug — the real field is
 *  completionTokens.) */
function usageTokens(u: unknown): { prompt: number; completion: number } {
    const o = (u || {}) as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && isFinite(x) ? x : 0);
    return {
        prompt: n(o.promptTokens) || n(o.prompt_tokens) || n(o.input_tokens) || n(o.prompt_eval_count),
        completion: n(o.completionTokens) || n(o.completion_tokens) || n(o.output_tokens) || n(o.eval_count),
    };
}

/** The `chat_metadata` tool's human-readable dump: the run's model facts (from the dep) + the live token /
 *  conversation stats the loop tracks. Deliberately plain text — the model relays it. */
function formatChatMeta(
    cm: ChatMeta | null,
    stats: { promptLast: number; genTotal: number; calls: number; sub?: SubcallUsage },
    rs: RunStats,
    messages: unknown[],
    tools: ToolMeta[],
): string {
    const role = (r: string) => messages.filter(m => (m as { role?: string }).role === r).length;
    const imgs = messages.filter(m => Array.isArray((m as { images?: unknown[] }).images) && (m as { images?: unknown[] }).images!.length).length;
    const L: string[] = [];
    // model + where it runs
    const where = cm?.local === true ? " (local · Ollama)" : cm?.local === false ? " (cloud / remote)" : "";
    L.push(`model: ${cm?.model || "(default — unresolved)"}${where}`);
    if (cm?.backend) L.push(`routed via: ${cm.backend}`);
    if (cm?.capabilities?.length) L.push(`supports: ${cm.capabilities.join(", ")}`);
    else if (cm && cm.capabilities === null) L.push("supports: unknown (cloud / non-Ollama)");
    // context window (unknown for a cloud model)
    if (cm?.contextWindow) {
        const pct = stats.promptLast ? ` — ~${Math.round((stats.promptLast / cm.contextWindow) * 100)}% full` : "";
        L.push(`context window: ${cm.contextWindow} tokens${pct}`);
    } else if (cm?.local === false) L.push("context window: unknown (cloud model — the API doesn't report it)");
    // two DIFFERENT token notions: what's PERSISTED in the conversation vs what the model has GENERATED
    if (stats.promptLast) L.push(`context in use: ~${stats.promptLast} tokens (the whole conversation, re-sent each turn)`);
    // Fixed per-request overhead (system prompt + tool schemas) — the part of context that ISN'T the chat.
    if (cm?.systemTokens || cm?.toolTokens) {
        const sys = cm.systemTokens || 0, tl = cm.toolTokens || 0;
        const share = cm.contextWindow ? ` (~${Math.round(((sys + tl) / cm.contextWindow) * 100)}% of the window)` : "";
        L.push(`fixed overhead: ~${sys + tl} tokens${share} — system prompt ~${sys}, tool list ~${tl} (estimated)`);
    }
    L.push(`generated this run: ${stats.genTotal} tokens over ${stats.calls} model call${stats.calls === 1 ? "" : "s"} (all output incl. thinking — thinking isn't kept in context)`);
    // Cumulative SPEND (what an API bill sums) + the generation rate — the same figures the DevTools bar shows.
    L.push(`cumulative tokens: ${rs.inTokens} in + ${rs.outTokens} out = ${rs.totalTokens} billed across ${rs.calls} call${rs.calls === 1 ? "" : "s"} (input re-sent each turn, so it grows fast)`);
    const tps = fmtTokPerSec(rs);
    if (tps) L.push(`generation rate: ${tps} — ${rs.genBasis === "eval" ? "Ollama generation time (excludes network)" : rs.genBasis === "wall" ? "wall-clock per call (includes network/queue)" : "mixed (Ollama timing where available, else wall-clock)"}`);
    if (cm?.vramGB) L.push(`VRAM resident: ~${cm.vramGB.toFixed(1)} GB`);
    // conversation SHAPE — "messages" was ambiguous; split turns / your messages / model replies
    L.push(`conversation so far: ${role("user")} of your messages · ${role("assistant")} model replies${imgs ? ` · ${imgs} carried images` : ""}`);
    // Delegated sub-call tokens: `locate` is ALWAYS a delegated vision sub-call; `look` is only a sub-call
    // when the model itself can't see (delegated to a reader). A VISION model's `look` inlines the image into
    // context (counted in "context in use"), so it's NOT delegated. Gate the look-note on the model's caps.
    // When we've actually METERED some (stats.sub), report the real number — that spend is a SEPARATE context
    // (gone after each call), so it's extra cost, NOT part of the occupancy above. Else fall back to the note.
    const sub = stats.sub;
    if (sub && sub.calls) {
        L.push(`delegated vision sub-calls this session: ${sub.prompt + sub.completion} tokens over ${sub.calls} call${sub.calls === 1 ? "" : "s"} (locate/look/verify — a SEPARATE context each, not part of the occupancy above)`);
        // Per-model breakdown — which vision model handled how many + at what cost (the "slop" the user wants
        // visible). Biggest spender first; only when more than one model, else the aggregate line already says it.
        const bm = (sub.byModel || []).slice().sort((a, b) => (b.prompt + b.completion) - (a.prompt + a.completion));
        if (bm.length > 1) for (const m of bm) L.push(`  · ${m.model} — ${m.calls} call${m.calls === 1 ? "" : "s"}, ~${m.prompt + m.completion} tokens`);
    } else {
        const delegated: string[] = [];
        if (tools.some(t => t.name === "locate")) delegated.push("`locate`");
        if (tools.some(t => t.name === "look") && !cm?.capabilities?.includes("vision")) delegated.push("`look` (delegated — this model can't see natively)");
        if (delegated.length) L.push(`note: ${delegated.join(" and ")} run their own vision sub-call(s) whose tokens are NOT counted above (none yet this session).`);
    }
    return L.join("\n");
}

/** The user turn that carries a native-vision `look`/`locate` screenshot to the driver on its next call.
 *  Deliberately MINIMAL — just labels the image so the model correlates it to its request. The `look`
 *  tool description already says to describe + act; re-forcing "Describe what you see, then take the next
 *  action" on EVERY vision turn only bloated the prompt (repeated boilerplate) and made the model write a
 *  paragraph before acting (wasted completion tokens on a split-second visual check). Shared by the page
 *  loop and the background host so the two can't drift. */
export const shotTurnMessage = (labels: string, count: number): string => `[Screenshot${count > 1 ? "s" : ""}: ${labels}]`;

// The tools whose output is CITABLE with an `@tool:` token — they expose the opt-in `token` param, and (when
// tool tokens are on) get a stable id minted onto every non-failed call so the answer renderer can resolve a
// reference to it. Shared with injected.ts's per-call param injection so the two can't drift.
export const CITABLE_TOOLS = new Set(["exec", "python_exec", "look", "locate", "fetch_url"]);

export interface AgentLoopOptions { tools: ToolMeta[]; maxSteps?: number | (() => number); signal?: AbortSignal | null; unattended?: boolean;
    // Tool tokens: when set (+ a runHash to seed the id), a tool RESULT that has a rich render (renderIn/
    // renderOut — an image/table/code, worth showing verbatim) gets a trailing `@tool:<id>` line, so the model
    // can cite that exact output in its final answer / answer set. Off → no token lines (plain runs unchanged).
    // `seqBase` offsets the per-turn `seq` so a MULTI-TURN run mints GLOBALLY-unique token ids: the loop restarts
    // `seq` at 0 each turn, so without the base, turn 2's step 1 and turn 1's step 1 would mint the SAME id and a
    // citation would resolve to the earlier step. The caller passes its running base (the same one it offsets the
    // stored step.seq by), so the minted id matches a session-unique step exactly.
    toolTokens?: boolean; runHash?: string; seqBase?: number;
    /** Called once at run start with a resolver for this run's `@tool:` pointers. The host binds it into the
     *  ToolContext so `ml.dereference` inside an approved exec reads THIS run's outputs — and only while a
     *  tool of this run is executing. The loop owns the store, so it is the only place that can hand this out. */
    tokenSink?: (resolve: (ref: string, pipe?: string | string[]) => DerefRead) => void;
    /** Which lexical metric ranks a near-miss on a pointer label (config `labelMatch`). Omitted = the
     *  default; the benchmark varies it. */
    labelMatch?: import("./contract").LexicalMetric;
    /** The pointer store to use. Pass the SESSION's store so `@tool:` references survive across a handle's
     *  turns; omit for a one-shot run and the loop makes its own. */
    tokenStore?: TokenStore;
    /** Opt-in LIVE tool-output streaming (same flag as the streamed thinking): when set, each tool call gets a
     *  throttled `ctx.stream(text)` so a tool that supports it (exec's console.log, python_exec's print) streams
     *  its output as it runs. Off → tools return the full result at the end, unchanged. */
    stream?: boolean;
}

// Live tool-output streaming: throttle the fan (a chatty loop can't flood the bus) and cap the accumulated
// text (a runaway print can't blow up a message). The DONE emit carries the full result and supersedes this,
// so the cap only bounds the LIVE view. Mirrors the LLM stream's 90ms cadence.
const STREAM_EMIT_MS = 90;
// Same budget the finished render keeps (UI_OUT_CAP), so the live view and the settled one agree — output
// never visibly shrinks (or jumps) when the step lands. Past it, a running "[+N chars]" note counts up.
const STREAM_OUTPUT_CAP = UI_OUT_CAP;
/** Build the per-tool-call streaming fan (or null when streaming is off). `push` accumulates + throttled-emits
 *  the running output; `done` stops any pending trailing emit (the DONE supersedes it). */
function makeStreamFan(on: boolean | undefined, emit: (out: string, marks: [number, number][]) => void): { push: (text: string, ts?: number) => void; done: () => void } | null {
    if (!on) return null;
    let acc = "", dropped = 0, last = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const marks: [number, number][] = [];   // [offset in acc, when the producer emitted it]
    // Past the cap we keep the HEAD (like the final clip) and COUNT what we dropped, re-emitting the note each
    // flush — so a runaway loop shows a truncation figure that ticks up instead of silently freezing.
    const send = (): void => { last = Date.now(); emit(dropped ? `${acc}… [+${dropped} chars]` : acc, marks.slice()); };
    return {
        push(text: string, ts?: number): void {
            const s = String(text), room = STREAM_OUTPUT_CAP - acc.length;
            // The EXECUTOR's timestamp wins (it may have crossed a worker/network hop); fall back to now only
            // when the producer is this realm. One mark per push — the UI maps a line back to the mark at or
            // before its offset.
            if (room > 0 && s) marks.push([acc.length, ts ?? Date.now()]);
            if (room > 0) { acc += s.slice(0, room); if (s.length > room) dropped += s.length - room; }
            else dropped += s.length;
            if (Date.now() - last >= STREAM_EMIT_MS) { if (timer) { clearTimeout(timer); timer = null; } send(); }   // leading edge
            else if (!timer) timer = setTimeout(() => { timer = null; send(); }, STREAM_EMIT_MS);                    // trailing, coalesced
        },
        done(): void { if (timer) { clearTimeout(timer); timer = null; } },   // the DONE result supersedes the live view
    };
}

// Normalize an approval gate's return (boolean OR the rich contract) into a decision. Inlined (not
// imported from approval.ts) so this module stays DOM/chrome-free for the standalone build.
const normalize = (d: ApprovalDecision, orig: Record<string, unknown>): { approved: boolean; feedback: string | null; arguments: Record<string, unknown>; source: "user" | "external"; cancelled: boolean } => {
    if (d && typeof d === "object") return {
        approved: !!d.approved,
        feedback: typeof d.feedback === "string" && d.feedback.trim() ? d.feedback.trim() : null,
        arguments: d.approved && d.arguments && typeof d.arguments === "object" ? d.arguments : orig,
        source: d.source === "external" ? "external" : "user",
        cancelled: !!d.cancelled,
    };
    return { approved: !!d, feedback: null, arguments: orig, source: "user", cancelled: false };
};

// Returns AgentResult WITHOUT `hash` — this loop is identity-agnostic; the page-side ml.agent
// caller stamps the run's hash onto the result (it owns runHash). See injected.ts's background path.
export async function runAgentLoop(task: string, opts: AgentLoopOptions, deps: AgentLoopDeps): Promise<Omit<AgentResult, "hash">> {
    const { tools, signal } = opts;
    // maxSteps is read LIVE each iteration (not destructured) so a handle can raise the cap mid-run
    // (a.maxSteps = 40) and the loop keeps going instead of stopping at the original value.
    const maxSteps = () => { const m = typeof opts.maxSteps === "function" ? opts.maxSteps() : opts.maxSteps; return m ?? 10; };
    const byName = new Map(tools.map(t => [t.name, t]));
    const messages = deps.buildMessages(task);
    const transcript: AgentTranscriptEntry[] = [];
    // Per-step render data for citable steps, so the outputs resolver can turn a cited/designated token into its
    // structured value (res.outputs — the headless-scripting payload).
    const tokenRenders: TokenRender[] = [];
    /** seq -> the id a PIPED dereference minted for its reduction, so the emit path can carry it onto that
     *  step. Keyed by seq because that is what both sides already agree on. */
    const mintedViews = new Map<number, string>();
    // Values addressable by `@tool:<id>` for THIS run — what `dereference` reads. Populated at mint time below,
    // so the pointer store and the citation ids can never disagree. Owned by the LOOP (not the page), which is
    // why dereference resolves here instead of being delegated: it is a pure read of run state, identical on
    // the page-hosted and background-hosted paths, and needs no page round-trip or approval.
    // The caller may own the store so it spans a SESSION (every turn of a handle) rather than one turn: the
    // model sees `@tool:` pointers in its own history from earlier turns, so they have to keep resolving —
    // a follow-up "how did you compute that?" dereferencing the previous turn's python_exec used to get
    // "Nothing has been captured in this run yet". Ids stay unique across turns via `seqBase`, so a shared
    // store cannot collide. No store passed (a one-shot run) → a fresh one, as before.
    const tokenStore = opts.tokenStore ?? new TokenStore();
    /** Give a PIPED dereference view its own pointer, so the model can cite the reduction it just built instead
     *  of the whole original. Returns the line telling it the new id (empty when tool tokens are off). */
    const mintView = (src: TokenValue, text: string, args: Record<string, unknown>, step: number, seq: number): string => {
        if (!opts.toolTokens || !opts.runHash) return "";
        const id = toolToken(opts.runHash, (opts.seqBase ?? 0) + seq);
        tokenStore.note({
            id, tool: DEREF_TOOL, kind: /^\s*[[{]/.test(text) ? "json" : "text", out: text,
            // The label says what this view IS — its source and the reduction that produced it — so a later
            // read (or the nearest-pointer list on a typo) reads as "dereference: python_exec | .rows | head 5".
            label: cleanLabel(`${nameOf(src)} | ${String(args?.pipe ?? "")}`),
            in: JSON.stringify(args), t: Date.now(), step,
        });
        tokenRenders.push({ id, tool: DEREF_TOOL, render: undefined, result: text });   // citable in the answer
        // …and onto the STEP. The answer renderer resolves a citation by matching `step.token`, and this id is
        // minted outside the generic path (dereference is not `citable`), so without this the model was handed
        // a pointer, told to cite it, and the citation rendered as "unresolved @tool:…" — a handle the run had
        // genuinely produced, reported as one it had invented.
        mintedViews.set(seq, id);
        return `\n\n[this view is @tool:${id} — to SHOW this reduction rather than the whole output, embed it with image syntax: ![label](@tool:${id}:out). It expands in place; don't retype it.]`;
    };
    /** Resolve a `dereference` call against this run's pointer store. Side-effect-free by construction (it only
     *  reads values already captured), so it needs no approval and never touches the page. Every answer leads
     *  with WHAT is at the pointer and WHEN it was captured: a pointer aliases a snapshot with no invalidation,
     *  so a survey taken before a click still resolves, and a model would otherwise read it as current. */
    const derefLocally = (args: Record<string, unknown>, step: number, seq: number): ToolRunResult => {
        const ref = String(args?.token ?? "").trim();
        const pipe = args?.pipe == null ? "" : String(args.pipe);
        // NO argument is a legitimate read: the INVENTORY of what this session holds. It used to be reachable
        // only by triggering the "token is required" error, which is backwards for a mechanism whose whole job
        // is confidence — a model that cannot cheaply see what it has will guess, and a model that expects to
        // guess wrong retypes the data instead, which is the cost this exists to avoid.
        // A `pipe` with no token is a slip, not an inventory request — the model meant to reduce SOMETHING.
        // Still answer with the inventory (that is what it needs to recover), but say the pipe was dropped
        // rather than silently ignoring an argument it deliberately wrote.
        if (!ref) return { result: pipe.trim() ? `${inventory()}\n\n(Your \`pipe\` was not applied: no pointer was named to apply it to.)` : inventory() };
        const { value: v, matched, score, via } = tokenStore.resolveRef(ref, opts.labelMatch);
        // A pointer that doesn't resolve is usually a HALLUCINATED id (six plausible hex characters that were
        // never minted), so name the closest real ones rather than just saying no — the model can then correct
        // itself in one step instead of guessing again.
        if (!v) return { result: `Error: ${memoryFault(ref, tokenStore.nearest(ref), step)}` };
        const slot = TokenStore.slotOf(ref);
        const age = step - v.step;
        // The staleness line is not decoration: this is the failure mode of pointer-passing.
        const when = age <= 0 ? "captured this step" : `captured at step ${v.step}, ${age} step${age === 1 ? "" : "s"} ago — the page may have changed since`;
        // The model's own label leads (it is what it will recognise), but the DERIVED description always
        // follows it — the label is a claim it wrote, the description is what the value actually is.
        const head = `@tool:${v.id} (${nameOf(v)}${slot === "in" ? ", the call" : ""}) — ${describeToken(v)}${extraBeyondModel(v)}, ${when}.`;
        try {
            const text = derefPipe(v, slot, pipe);
            // MINT a pointer for a PIPED view. A no-pipe read really is "no new data" — the header above already
            // names the source's id, so a second handle for identical bytes would just clutter the store (the
            // reason `dereference` is excluded from `citable`). A PIPE is the case that reasoning doesn't cover:
            // the reduction is something the model just CONSTRUCTED, and a model often only decides an output is
            // worth showing after it has narrowed it. Without a pointer its only options are citing the whole
            // original or retyping the view into the answer — the second costs context and loses the render.
            // Minted here rather than through `citable` because the generic path would read this tool's `token`
            // PARAMETER (the pointer being read) as the model's opt-in/label. Uses the call's own seq, which the
            // generic path leaves unused for dereference, so ids cannot collide.
            const derived = pipe.trim() && text !== derefPipe(v, slot, "") ? mintView(v, text, args, step, seq) : "";
            // BIND the alias. `python_exec` means "the LATEST python_exec call" — a moving target that changes
            // the next time the tool runs. A model that didn't pass `token: true` at the time was never told
            // that call's id (it is minted for a citable builtin either way, just not surfaced), so the alias is
            // the only handle it has, and it often only decides an output is worth keeping AFTER seeing it.
            // Reading through the alias is exactly that moment, so hand back the stable id and say it is one.
            // Only when the model came in via a NAME: given the hex it already holds the pin.
            // A label that did NOT match exactly was resolved by similarity. Say so, every time: an address
            // dereference must never quietly change which data the computation ran on, and the model can only
            // notice a wrong resolution if it is told one happened.
            const soft = matched
                ? `\n\n[resolved by similarity, not an exact name: you asked for ${JSON.stringify(parseLabel(ref) ?? ref)} and the closest label was ${JSON.stringify(matched)} (${score?.toFixed(2)}). If that is not what you meant, list what you have with dereference and no token.]`
                : "";
            // Only the BARE TOOL NAME is a moving target. It was keyed on "the ref is not the id", which is
            // also true of a LABEL — so a label read was told its own handle "always means the LATEST call and
            // will move", which is false, and the model repeated it back as a rule it had learned. A label
            // names one captured value; the id is what it resolves to, worth handing over so the model can
            // cite it, but nothing about it moves. And the alias message quoted `nameOf(v)` — a DISPLAY string
            // (`look: "hud render check"`) that is not a reference form at all — where it had to quote the
            // alias actually used, or it teaches a spelling that does not resolve.
            const pin = via === "tool"
                ? `\n\n[pinned: this call is @tool:${v.id}. @tool:${v.tool} always means the LATEST ${v.tool} call and will move when you run it again — @tool:${v.id} always means THIS one. Cite it with ![label](@tool:${v.id}:out).]`
                : via === "label"
                ? `\n\n[this label names @tool:${v.id}. Cite it with ![label](@tool:${v.id}:out) — the id stays with this capture even if you label something else the same way later.]`
                : "";
            return { result: `${head}\n\n${text}${derived}${soft}${pin}` };
        } catch (e) {
            // Any stage that fails throws with an actionable message — the pipe dialect's existing contract.
            // Surface it verbatim so the model corrects the pipe rather than abandoning the pointer.
            return { result: `Error: ${(e as Error)?.message || e}` };
        }
    };
    const tokenList = (): string =>
        tokenStore.size ? tokenStore.all().map(v => `@tool:${v.id} (${nameOf(v)}, step ${v.step})`).join(", ") : "(nothing captured yet)";
    /** Everything this session holds a pointer to — what it is, what it was called, and how far back. The
     *  answer to "what do I have?", so the model never has to recall an id to find out. Also teaches the
     *  reference forms by example, which is cheaper than a paragraph in the tool description that is paid on
     *  every run. One line each, no column padding (it is read by a model). */
    const inventory = (): string => {
        const all = tokenStore.all();
        if (!all.length) return "No pointers captured yet this session. Run a tool with `token: true` (or a short label) and its output becomes readable here.";
        const lines = all.map((v) => `  @tool:${v.id} (${nameOf(v)}) ${shortType(v)}, step ${v.step}`);
        const labelled = all.find((v) => v.label);
        const byLabel = labelled ? ` — or by its label: @tool:${JSON.stringify(labelled.label)}.` : "";
        return `${all.length} pointer${all.length === 1 ? "" : "s"} in this session:\n${lines.join("\n")}\n`
            + `Read one by passing it as \`token\`, e.g. "@tool:${all[all.length - 1].id}"${byLabel}`;
    };
    /** `look` at an IMAGE POINTER. A screenshot the run already captured is addressable like any other output,
     *  so `look { selector: "@tool:abc123" }` re-examines it — a different question about the SAME pixels —
     *  instead of re-screenshotting a page that has since scrolled or changed. The store lives here, so the
     *  loop resolves the pointer and hands the image down; `look` never learns about tokens.
     *  Returns null when the selector isn't a pointer (the ordinary path), or an error string when it is one
     *  but can't be looked at. */
    const resolveLookPointer = (args: Record<string, unknown>, step: number): { args?: Record<string, unknown>; error?: string } | null => {
        const sel = String(args?.selector ?? "").trim();
        if (!/^@tool:/.test(sel)) return null;
        const v = tokenStore.get(sel);
        if (!v) return { error: memoryFault(sel, tokenStore.nearest(sel), step) };
        if (!v.image) return { error: `@tool:${v.id} is ${describeToken(v)}, not an image — there is nothing to look at. Read it with dereference instead.` };
        return { args: { ...args, _image: v.image, _imageLabel: `@tool:${v.id} (captured at step ${v.step})` } };
    };
    // Hand the resolver to the host (see tokenSink). Throws exactly what the tool would return, so a failed
    // read inside exec surfaces the same MemoryFault / pipe error the model sees from the tool itself.
    opts.tokenSink?.((ref: string, pipe?: string | string[]): DerefRead => {
        const { value: v, matched, score } = tokenStore.resolveRef(ref, opts.labelMatch);
        if (!v) throw new Error(memoryFault(ref, tokenStore.nearest(ref), seq));
        // A soft label match travels BESIDE the value, never inside it: the caller here is a script that will
        // parse/split/pipe what it gets back, so a note appended to the value would corrupt the data.
        const warning = matched
            ? `ml.dereference: resolved ${JSON.stringify(parseLabel(ref) ?? ref)} to the label ${JSON.stringify(matched)} by similarity (${score?.toFixed(2)}), not an exact name.`
            : undefined;
        // The METADATA travels with the value. The store knows what this is (a table, an image, JSON) and
        // when it was captured; flattening all of it to text made every caller re-sniff the bytes.
        const meta = {
            id: v.id, tool: v.tool, kind: v.kind, step: v.step,
            ...(v.label ? { label: v.label } : {}),
            ...(v.table ? { table: v.table } : {}),
            ...(v.image ? { image: v.image } : {}),
            ...(v.latex ? { latex: v.latex } : {}),
        };
        return { value: derefPipe(v, TokenStore.slotOf(ref), pipe), ...(warning ? { warning } : {}), meta };
    });
    /** Rewrite a `look` at an image pointer into a look at that image; anything else passes through.
     *  A bad pointer becomes an ERROR RESULT, never a throw: the model should read the fault and correct the
     *  call, exactly as it does for `dereference`, rather than the run dying on a mistyped id. */
    const lookArgs = (name: string, a: Record<string, unknown>, step: number): { args: Record<string, unknown> } | { error: string } => {
        if (name !== "look") return { args: a };
        const r = resolveLookPointer(a, step);
        if (!r) return { args: a };
        return r.error ? { error: r.error } : { args: r.args! };
    };
    // How long the last tool actually RAN, excluding the approval gate — the human deciding for thirty seconds
    // is not the tool being slow, and a span that conflated them would say the wrong thing about both. Written
    // by runTool, read by the DONE emit; safe as a single holder because the loop dispatches tools one at a
    // time (delegation is sequential).
    let lastToolMs: number | undefined;
    /** How long the approval GATE was open for this step, when it opened at all. */
    let lastApproveMs: number | undefined;
    /** When the model call for the current turn RETURNED. Everything between that instant and the tool
     *  actually starting is plumbing — parsing the call, validating its arguments, building the context,
     *  the hop to the page on a delegated run. Measured rather than inferred, for the same reason
     *  `approveMs` is: the timeline reconstructs a block's start by subtracting the parts it knows about,
     *  so an unmeasured part does not merely go unlabelled, it shifts the whole block later than the work
     *  happened — against a shared axis with the memory trace, which is the one error that matters. */
    let turnReturnedAt: number | undefined;
    /** That gap, for the step being emitted. */
    let lastDispatchMs: number | undefined;
    /** Every tool dispatch goes through here so `dereference` is answered from run state instead of delegated. */
    const runTool = async (name: string, a: Record<string, unknown>, push: ((t: string, ts?: number) => void) | undefined, step: number, seq: number): Promise<ToolRunResult> => {
        const t0 = Date.now();
        // The gap since the model call returned, minus any time a human held the gate open — that wait is
        // already its own phase, and counting it here would draw the same seconds twice.
        if (turnReturnedAt != null) lastDispatchMs = Math.max(0, t0 - turnReturnedAt - (lastApproveMs ?? 0));
        try {
            if (name === DEREF_TOOL) return await derefLocally(a, step, seq);
            const l = lookArgs(name, a, step);
            return "error" in l ? { result: `Error: ${l.error}` } : await deps.runTool(name, l.args, push);
        } finally { lastToolMs = Date.now() - t0; }
    };
    let seq = 0;
    // Live token stats for the chat_metadata tool: promptLast = the last call's prompt tokens (current
    // context occupancy), genTotal = completion tokens summed across the run. Accurate on both worlds since
    // the loop is shared. `calls` = model turns so far.
    let promptLast = 0, genTotal = 0, modelCalls = 0;
    const usages: TokenUsage[] = [];   // every call's usage sample → runStats (cumulative in/out spend + tok/s) for chat_metadata
    const cancelled = (steps: number): Omit<AgentResult, "hash"> => ({ summary: "Cancelled by the caller.", steps, transcript, elements: [], cancelled: true, tokenRenders });

    for (let step = 1; step <= maxSteps(); step++) {
        if (signal?.aborted) return cancelled(step - 1);
        // Mid-run steering: inject any user messages queued via a.say() since the last step, so the model
        // sees them on THIS turn — landing after the previous step's tool resolved, before the next model call.
        for (const text of deps.drainInbox?.() ?? []) deps.pushUser?.(messages, text);
        // A CANCEL_RUN mid-generation aborts the in-flight fetch, which REJECTS here — convert that to a
        // clean cancel (don't propagate as a run error), same as the boundary check. Re-throw a real error.
        let msg;
        deps.emitTurn?.({ step });   // the call is going out NOW — the only stamp for "the model started"
        try { msg = await deps.callModel(messages, { tools, step }); }
        catch (e) { if (signal?.aborted) return cancelled(step - 1); throw e; }
        turnReturnedAt = Date.now();
        if (signal?.aborted) return cancelled(step - 1);
        if (msg.usage) { const u = usageTokens(msg.usage); modelCalls++; if (u.prompt) promptLast = u.prompt; genTotal += u.completion; usages.push(msg.usage as TokenUsage); }
        if (!msg.tool_calls || !msg.tool_calls.length) {
            // Final-answer step: emit its usage (the run's peak context) + any reasoning so the sidebar's
            // gauge/think-section match the page-side loop even on a content-less final turn.
            if (msg.usage || msg.reasoning) deps.emit?.({ step, usage: msg.usage, reasoning: msg.reasoning });
            // Record the answer in history so a background-hosted RESUME continues WITH it in context
            // (mirrors the page loop). Harmless for a one-shot run — the messages array is then dropped.
            deps.pushAssistant(messages, { content: msg.content || "" });
            // Record the answer in the transcript too, so res.transcript is a complete turn (its actions
            // AND its reply) — otherwise a run reads as tool calls with no conclusion. Skip an empty answer.
            // SALVAGE: a thinking model can put its whole conclusion in the reasoning/thinking channel and
            // leave `content` empty (seen with gemma right after a vision step) — the loop would otherwise
            // return a blank answer even though the model "knew" it. Fall back to the reasoning text so the
            // caller gets the conclusion, not nothing.
            const reasoningText = typeof msg.reasoning === "string" ? msg.reasoning.trim() : "";
            const answer = (msg.content || "").trim() || reasoningText;
            if (answer) transcript.push({ assistant: answer });
            return { summary: answer, steps: step - 1, transcript, elements: [], tokenRenders };
        }
        // The step's prose (content), token usage, and the separate reasoning channel ride one emit
        // (or a usage/reasoning-only emit when there's no prose — a model that thinks in reasoning_content
        // and leaves content empty while tool-calling). `thought` = the assistant's prose; `reasoning` =
        // its thinking (rendered as a collapsible think section, distinct from the prose).
        const thought = (msg.content || "").trim();
        if (thought || msg.usage || msg.reasoning) {
            if (thought) transcript.push({ thought });
            deps.emit?.({ step, thought: thought || undefined, reasoning: msg.reasoning, usage: msg.usage });
        }
        deps.pushAssistant(messages, msg);

        const pendingImages: { image: string; label: string }[] = [];   // inline vision — injected after the step
        let stopRun = false;   // a gate resolved as CANCELLED (Stop) → exit after this step, even if the signal never aborted
        for (const call of msg.tool_calls) {
            const meta = byName.get(call.name);
            let args = (call.arguments || {}) as Record<string, unknown>;
            const s = ++seq;
            lastToolMs = undefined; lastApproveMs = undefined; lastDispatchMs = undefined;   // this step's own measurements, never the previous step's
            // On a STREAMING run the pending step is on screen while its output fills in, so give it a pretty
            // In up front (the gated path already does this via approve; this covers auto-approved calls too).
            const preIn = (opts.stream && deps.renderFor) ? await deps.renderFor(call.name, args).catch(() => undefined) : undefined;
            deps.emit?.({ step, seq: s, pending: true, tool: call.name, arguments: args, renderIn: preIn });   // in-flight START
            // Live tool-output fan for THIS call (opt-in `stream`): a delta emit carries only { step, seq,
            // streamOutput } so the reducer patches the pending row additively; the DONE below supersedes it.
            const fan = makeStreamFan(opts.stream, (out, marks) => deps.emit?.({ step, seq: s, streamOutput: out, streamMarks: marks }));
            let result: string, approval: Approval | undefined;
            let tr: ToolRunResult | undefined;   // the full result — its render slots ride the DONE emit
            if (!meta) {
                result = `Error: no tool named "${call.name}".`;
            } else if (meta.capabilities?.includes("meta")) {
                // Self-introspection (chat_metadata): the LOOP answers it — it holds the live token counts
                // and message list, so the numbers are accurate on both the page and background paths with no
                // extra plumbing. Never gated, never delegated to runTool (it only reads its own run's state).
                const cm = deps.chatMeta ? await deps.chatMeta() : null;
                result = formatChatMeta(cm, { promptLast, genTotal, calls: modelCalls, sub: deps.subcallTokens?.() }, runStats(usages), messages, tools);
            } else if (meta.requiresApproval) {
                // Read-only try FIRST: the mediated interpreter can't mutate, so if the call is in its
                // dialect it's already run safely — auto-approve with its result, no gate, no runTool.
                const ro = deps.tryReadonly ? await deps.tryReadonly(call.name, args) : null;
                const autoRaw = ro ? null : (deps.autoApprove?.(call.name, args) || null);
                // autoApprove may return the bare provenance OR { approval, reused } (grants it reused).
                const auto = autoRaw ? (typeof autoRaw === "string" ? { approval: autoRaw, reused: undefined } : autoRaw) : null;
                if (ro) {
                    approval = "readonly";
                    tr = ro; result = ro.result;   // the interpreter already produced the result
                } else if (auto) {
                    approval = auto.approval;
                    tr = await runTool(call.name, args, fan?.push, step, s); result = tr.result;   // trusted auto-approve → execute
                    if (auto.reused?.length) tr = { ...tr, reused: [...(tr.reused || []), ...auto.reused] };   // surface the reused grants
                } else if (deps.precheck && (result = (await deps.precheck(call.name, args)) || "")) {
                    // Doomed-action skip: a side-effect-free precheck (click/type target resolution) found
                    // the action can only fail (no element / stale @pt / bad selector), so return that error
                    // WITHOUT gating — approving something that will just fail is pointless friction. It
                    // never ran; the "skipped" provenance tells the UI why there was no prompt. `result` set above.
                    approval = "skipped";
                } else if (opts.unattended) {
                    // Unattended run: nothing auto-approved it and there's no human to ask, so REFUSE (never
                    // prompt) and steer to read-only. Mirrors the page loop; same clean message on both paths.
                    approval = "denied";
                    result = UNATTENDED_REFUSAL;
                } else {
                    // The gate's own duration. It is the HUMAN's time, not the machine's, and leaving it out of
                    // the picture entirely made a step that waited two minutes for a click look identical to
                    // one that ran instantly.
                    const gateT0 = Date.now();
                    const rawDecision = await deps.approve({ tool: call.name, arguments: args, seq: s, step });
                    lastApproveMs = Date.now() - gateT0;
                    const d = normalize(rawDecision, args);
                    // CANCELLED while the gate was open (Stop pressed) — two channels, either suffices:
                    // `signal.aborted` (CANCEL_RUN aborted the run's controller) OR `d.cancelled` (CANCEL_RUN
                    // resolved this gate with a cancellation decision). The SECOND is essential when the
                    // controller is GONE (an evicted/re-adopted run): aborting can't reach the loop, so without
                    // it the gate would resolve to a plain `false` → read as a DENY → the loop steps on forever
                    // ("auto-denied + can't Stop", the reported bug). Store a generic, non-accusatory result —
                    // NOT "denied" — and set `stopRun` so the loop EXITS after this step's DONE even if the
                    // signal never aborted (the top-of-step signal check alone wouldn't catch the no-controller
                    // case). The DONE emit below clears the approve/deny buttons on every surface.
                    if (signal?.aborted || d.cancelled) {
                        approval = "cancelled";
                        result = "The user cancelled the run. Stop here and wait for their next instructions — do not retry this call.";
                        stopRun = true;
                    } else {
                        if (!d.approved) {
                            approval = "denied";
                            // Attribute the denial accurately: a human in a browser surface, or an external
                            // approver (the __mlApprovals IPC channel — an orchestrator / policy driver).
                            const who = d.source === "external" ? "an external approver" : "the user";
                            result = d.feedback
                                ? `Denied by ${who}: ${d.feedback}\nDo not retry this exact call unchanged; address the feedback or try another approach.`
                                : `Denied by ${who}. Do not retry this exact call; try another approach.`;
                            // NB: runTool is NOT called — the security invariant.
                        } else {
                            approval = "user";
                            args = d.arguments;                                   // possibly gate-edited
                            tr = await runTool(call.name, args, fan?.push, step, s); result = tr.result;   // EXECUTE ONLY AFTER APPROVE
                        }
                    }
                }
            } else {
                tr = await runTool(call.name, args, fan?.push, step, s); result = tr.result;   // non-approval tool
            }
            fan?.done();   // the tool finished — stop any trailing live emit; the DONE below carries the full result
            result = String(result);
            const entry: AgentTranscriptEntry = { tool: call.name, arguments: args, result };
            // Real result nodes ride the transcript ENTRY too (page-side only — undefined for the delegated
            // path). They reach the caller's res.transcript / onStep, never the model.
            if (tr?.elements && tr.elements.length) entry.elements = tr.elements as AgentTranscriptEntry["elements"];
            transcript.push(entry);
            // Tool token: surface an `@tool:<id>` line ONLY when this step has a rich render (renderIn/renderOut —
            // OPT-IN: the model asks for a token by setting `token: true` on a call whose output it intends to
            // CITE (exec/python_exec/look/locate/fetch_url expose the param). So exploratory/intermediate steps —
            // and inspection tools (describeElement/sampleText/…) that never expose the param — produce none,
            // keeping the model from being spammed with tokens it won't use. NOT on a FAILED call either: a token
            // pointing at "not a valid selector" is pointless; the model should fix + retry. Deterministic id so
            // the answer/final-text renderer re-derives it from `seq`.
            // A token points at a REAL, usable output — so never mint one for a call that didn't produce one:
            //  · BLOCKED — the gate was denied / cancelled / skipped, so the tool never ran (no output at all).
            //  · ERRORED — it ran but failed: an `Error:`/`Denied` string, OR (robust to any prefix, e.g. a
            //    ">1 table matched" note the python tool prepends) the python render's own `error` flag.
            const blocked = approval === "denied" || approval === "cancelled" || approval === "skipped";
            // Match the error marker at a LINE start, not just string start — `exec` prepends any `console.log`
            // output (`console:\n…\n\nError: …`) and `python_exec` can prepend a table note, so `^Error:` alone
            // misses a logged-then-failed call. Biasing toward "failed" is the safe direction: a false positive
            // just withholds a token (degrades to plain prose); a false negative would cite an ERROR as an answer.
            const failed = blocked
                || /(^|\n)(Error:|Denied|Python error:)/.test(result)
                || (tr?.renderOut?.type === "python-out" && !!tr.renderOut.error);
            // `token` is either `true` (opt in) or a SHORT LABEL the model writes for itself — a string is both
            // the opt-in and the name, so naming a pointer costs no extra field.
            const rawToken = (args as Record<string, unknown>)?.token;
            const wantsToken = rawToken === true || (typeof rawToken === "string" && !!rawToken.trim());
            const label = cleanLabel(rawToken);
            // Mint a stable id onto EVERY non-failed citable step (when the feature's on) and CARRY it on the step
            // — the answer renderer matches this stored id EXACTLY (never re-derives runHash:seq, which could
            // resolve a citation to the WRONG step). The id is INVISIBLE to the model unless it opted IN
            // (`token: true`): only then is the `@tool:` line appended to what the model sees (`forModel`), so it
            // isn't spammed with ids on every intermediate call. Nothing is EVER auto-surfaced from a minted id:
            // an output reaches the answer only if the model explicitly cites it (inline or via `answer`).
            // Citable = a builtin whose output is worth citing (minted so the model CAN cite it), OR ANY call the
            // model explicitly opted into (`token: true` — e.g. a custom tool that has no param but whose output
            // the model wants to cite). Never a failed call (nothing to cite).
            // `dereference` is never citable: it produces no new data, only a VIEW of a pointer that already
            // exists, so minting one would clutter the store with self-referential handles. It also has its own
            // `token` PARAMETER — the pointer being read — which would otherwise be misread here as a label.
            // A REMOTE tool is citable too, and by DECLARATION rather than by name: its name is generated from
            // the server's own bundle, so it can never be in a hardcoded list — and its schema comes from the
            // server, so it has no `token` parameter for the model to opt in with either. Which would leave
            // the one kind of output pointers most exist for — large, expensive to reproduce, fetched from
            // off the machine — as the only kind that can never become one.
            const citable = call.name !== DEREF_TOOL && (CITABLE_TOOLS.has(call.name) || !!meta?.remote || wantsToken) && !failed;
            // Seed the id from the GLOBAL seq (base + per-turn) so a multi-turn run never mints a colliding id
            // (turn 2's step 1 vs turn 1's step 1) that a citation would then resolve to the wrong, earlier step.
            // A PIPED dereference mints its own id (mintView) and has already registered it — carry that one
            // rather than minting a second, so the step the answer resolves to is the step that produced it.
            const mintedView = mintedViews.get(s);
            const tokenId = mintedView
                ?? ((opts.toolTokens && opts.runHash && citable) ? toolToken(opts.runHash, (opts.seqBase ?? 0) + s) : undefined);
            if (tokenId && !mintedView) tokenRenders.push({ id: tokenId, tool: call.name, render: tr?.renderOut, result });   // → res.outputs (only if CITED)
            // The pointer carries the value's TYPE, taken from the render descriptor the step already produced —
            // so `dereference … | keys` on a DataFrame means its COLUMNS, without re-parsing a rendered grid.
            // A minted VIEW was already stored by mintView, with the label and kind that describe the
            // reduction. Re-noting it here would overwrite that with the dereference step's own result.
            if (tokenId && !mintedView) {
                const r = tr?.renderOut;
                const df = r?.type === "python-out" ? r.df : undefined;
                const tbl = df ? { columns: df.columns, rows: df.rows as unknown[][] }
                    : r?.type === "table" ? { columns: r.columns, rows: r.rows as unknown[][] } : undefined;
                const looksJson = /^\s*[[{]/.test(result);
                const kind: TokenKind = tbl ? "table"
                    : (r?.type === "image" || r?.type === "look") ? "image"
                    : (r?.type === "code" || r?.type === "python-in") ? "code"
                    : looksJson ? "json" : "text";
                // Store the FULLER capture beside the model-facing one. `result` is already clipped to the
                // model's context budget, so a pointer holding only that would hand back exactly what the model
                // already has — useless. The render descriptor kept far more (UI_OUT_CAP), and reaching THAT is
                // the main reason to dereference at all.
                const fuller = (r?.type === "python-out" || r?.type === "exec-out") ? r.stdout : undefined;
                const full = fuller && fuller.length > result.length ? fuller : undefined;
                // Carry the typed PAYLOADS too, not just the kind — an image pointer with no image is what
                // `look` would resolve to, and a `latex` cast needs the symbolic string.
                const image = tr?.image
                    ?? (r?.type === "image" ? r.src : r?.type === "look" ? r.image : r?.type === "python-out" ? r.image : undefined);
                const latex = r?.type === "python-out" && r.latex && r.value != null ? String(r.value) : undefined;
                tokenStore.note({ id: tokenId, tool: call.name, kind, out: result, ...(full ? { full } : {}), ...(image ? { image } : {}), ...(latex ? { latex } : {}), ...(label ? { label } : {}), in: JSON.stringify(args), t: Date.now(), step, ...(tbl ? { table: tbl } : {}) });
            }
            // Not for a minted view: mintView appended its own line explaining what the reduction is, and
            // `dereference`'s `token` PARAMETER is the pointer being READ, so `wantsToken` is true for every
            // call — which would staple a second, contradictory citation instruction onto the same result.
            const forModel = (tokenId && wantsToken && !mintedView)
                ? `${result}\n\n[output token @tool:${tokenId} — EMBED this exact output in your final answer with image syntax: ![label](@tool:${tokenId}:out) (use ":in" for the call/code). It expands in place; don't retype it.]`
                : result;
            // The DONE event carries the clean `result` for the pretty Out AND — when a token line was appended —
            // `modelResult` (what the model ACTUALLY saw), so the log's raw view stays complete (the AGENTS rule).
            deps.emit?.({ step, seq: s, tool: call.name, arguments: args, result, ...(tokenId ? { token: tokenId } : {}), ...(forModel !== result ? { modelResult: forModel } : {}), approval, renderIn: tr?.renderIn, renderOut: tr?.renderOut, feedback: tr?.feedback, elements: tr?.elements, reused: tr?.reused, ...(lastToolMs != null ? { toolMs: lastToolMs } : {}), ...(lastApproveMs != null ? { approveMs: lastApproveMs } : {}), ...(lastDispatchMs ? { dispatchMs: lastDispatchMs } : {}), ...(tr?.remoteMs ? { remoteMs: tr.remoteMs } : {}) });   // DONE (patches the START)
            deps.pushToolResult(messages, call, forModel);
            if (tr?.image) pendingImages.push({ image: tr.image, label: tr.imageLabel || "screenshot" });
            // Multiple images from one call (look's overlay + no-overlay) → each becomes its own inline image.
            if (tr?.images) for (const im of tr.images) pendingImages.push({ image: im.image, label: im.label || "screenshot" });
        }
        // A gate was CANCELLED this step (Stop) — exit now as cancelled, even if the AbortSignal never fired
        // (the no-controller case the top-of-step check can't catch). The cancelled step's DONE already emitted.
        if (signal?.aborted || stopRun) return cancelled(step);
        // Inline vision: hand any screenshots this step captured to the model as a user turn, so the
        // next step reasons over the real pixels (the native `look` path; a text-only driver omits the dep).
        if (pendingImages.length) deps.pushToolImages?.(messages, pendingImages);
    }
    return { summary: `Stopped at the ${maxSteps()}-step cap without finishing.`, steps: maxSteps(), transcript, elements: [], hitCap: true, tokenRenders };
}
