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

import type { AgentResult, AgentTranscriptEntry, ApprovalDecision, ToolCall, RenderDescriptor, ToolFeedback, SubcallUsage } from "./contract";
import { UNATTENDED_REFUSAL } from "./prompts";

export type Approval = "readonly" | "sandbox" | "same-origin" | "consented" | "user" | "denied" | "skipped" | "cancelled";
export interface ToolMeta { name: string; requiresApproval?: boolean; capabilities?: string[]; }
// The tool's serializable result. `renderIn`/`renderOut` are the debug-render slots computed by the
// executor's world (page-side for the delegated path) so the emitter can show a rendered In/Out.
// `image` is a screenshot a vision tool (native `look`) captured — INLINE VISION: it's injected into
// the model's next turn as a user image (via pushToolImages) so the model reasons over the real pixels.
export interface ToolRunResult { result: string; elements?: unknown[]; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; image?: string; imageLabel?: string; images?: { image: string; label?: string }[]; feedback?: ToolFeedback; reused?: import("./contract").ReusedGrant[]; }

export interface AgentLoopDeps {
    // One model turn → the assistant message (content + normalized tool_calls + usage + the separate
    // reasoning/thinking channel, which the sidebar shows as a collapsible "think" section).
    callModel(messages: unknown[], opts: { tools: ToolMeta[]; step: number }): Promise<{ content?: string | null; tool_calls?: ToolCall[]; usage?: unknown; reasoning?: unknown }>;
    // Execute a tool by name — LOCAL (page-side today) or DELEGATED (background → page, safe mode).
    // Reached for a requiresApproval tool ONLY after the gate. This is the untrusted delegation point.
    runTool(name: string, args: Record<string, unknown>): Promise<ToolRunResult>;
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
    emit?(ev: { step: number; seq?: number; pending?: boolean; thought?: string; reasoning?: unknown; tool?: string; arguments?: Record<string, unknown>; result?: string; approval?: Approval; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; feedback?: ToolFeedback; usage?: unknown; elements?: unknown[]; reused?: import("./contract").ReusedGrant[] }): void;
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

export interface AgentLoopOptions { tools: ToolMeta[]; maxSteps?: number | (() => number); signal?: AbortSignal | null; unattended?: boolean; }

// Normalize an approval gate's return (boolean OR the rich contract) into a decision. Inlined (not
// imported from approval.ts) so this module stays DOM/chrome-free for the standalone build.
const normalize = (d: ApprovalDecision, orig: Record<string, unknown>): { approved: boolean; feedback: string | null; arguments: Record<string, unknown>; source: "user" | "external" } => {
    if (d && typeof d === "object") return {
        approved: !!d.approved,
        feedback: typeof d.feedback === "string" && d.feedback.trim() ? d.feedback.trim() : null,
        arguments: d.approved && d.arguments && typeof d.arguments === "object" ? d.arguments : orig,
        source: d.source === "external" ? "external" : "user",
    };
    return { approved: !!d, feedback: null, arguments: orig, source: "user" };
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
    let seq = 0;
    // Live token stats for the chat_metadata tool: promptLast = the last call's prompt tokens (current
    // context occupancy), genTotal = completion tokens summed across the run. Accurate on both worlds since
    // the loop is shared. `calls` = model turns so far.
    let promptLast = 0, genTotal = 0, modelCalls = 0;
    const cancelled = (steps: number): Omit<AgentResult, "hash"> => ({ summary: "Cancelled by the caller.", steps, transcript, elements: [], cancelled: true });

    for (let step = 1; step <= maxSteps(); step++) {
        if (signal?.aborted) return cancelled(step - 1);
        // Mid-run steering: inject any user messages queued via a.say() since the last step, so the model
        // sees them on THIS turn — landing after the previous step's tool resolved, before the next model call.
        for (const text of deps.drainInbox?.() ?? []) deps.pushUser?.(messages, text);
        // A CANCEL_RUN mid-generation aborts the in-flight fetch, which REJECTS here — convert that to a
        // clean cancel (don't propagate as a run error), same as the boundary check. Re-throw a real error.
        let msg;
        try { msg = await deps.callModel(messages, { tools, step }); }
        catch (e) { if (signal?.aborted) return cancelled(step - 1); throw e; }
        if (signal?.aborted) return cancelled(step - 1);
        if (msg.usage) { const u = usageTokens(msg.usage); modelCalls++; if (u.prompt) promptLast = u.prompt; genTotal += u.completion; }
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
            return { summary: answer, steps: step - 1, transcript, elements: [] };
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
        for (const call of msg.tool_calls) {
            const meta = byName.get(call.name);
            let args = (call.arguments || {}) as Record<string, unknown>;
            const s = ++seq;
            deps.emit?.({ step, seq: s, pending: true, tool: call.name, arguments: args });   // in-flight START
            let result: string, approval: Approval | undefined;
            let tr: ToolRunResult | undefined;   // the full result — its render slots ride the DONE emit
            if (!meta) {
                result = `Error: no tool named "${call.name}".`;
            } else if (meta.capabilities?.includes("meta")) {
                // Self-introspection (chat_metadata): the LOOP answers it — it holds the live token counts
                // and message list, so the numbers are accurate on both the page and background paths with no
                // extra plumbing. Never gated, never delegated to runTool (it only reads its own run's state).
                const cm = deps.chatMeta ? await deps.chatMeta() : null;
                result = formatChatMeta(cm, { promptLast, genTotal, calls: modelCalls, sub: deps.subcallTokens?.() }, messages, tools);
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
                    tr = await deps.runTool(call.name, args); result = tr.result;   // trusted auto-approve → execute
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
                    const rawDecision = await deps.approve({ tool: call.name, arguments: args, seq: s, step });
                    if (signal?.aborted) {
                        // CANCELLED while the gate was open (Stop pressed) — the gate promise resolved because
                        // cancel wakes it (background CANCEL_RUN resolves the pending gate). The tool never ran;
                        // store a generic, non-accusatory result — NOT "denied" — so a follow-up turn sees a
                        // coherent transcript, then the signal check at the top of the next step exits the run as
                        // cancelled. This is also what CLEARS the approve/deny buttons: the DONE emit below patches
                        // the step out of `awaitingApproval` (with a result), instead of leaving it hung.
                        approval = "cancelled";
                        result = "The user cancelled the run. Stop here and wait for their next instructions — do not retry this call.";
                    } else {
                        const d = normalize(rawDecision, args);
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
                            tr = await deps.runTool(call.name, args); result = tr.result;   // EXECUTE ONLY AFTER APPROVE
                        }
                    }
                }
            } else {
                tr = await deps.runTool(call.name, args); result = tr.result;   // non-approval tool
            }
            result = String(result);
            const entry: AgentTranscriptEntry = { tool: call.name, arguments: args, result };
            // Real result nodes ride the transcript ENTRY too (page-side only — undefined for the delegated
            // path). They reach the caller's res.transcript / onStep, never the model.
            if (tr?.elements && tr.elements.length) entry.elements = tr.elements as AgentTranscriptEntry["elements"];
            transcript.push(entry);
            deps.emit?.({ step, seq: s, tool: call.name, arguments: args, result, approval, renderIn: tr?.renderIn, renderOut: tr?.renderOut, feedback: tr?.feedback, elements: tr?.elements, reused: tr?.reused });   // DONE (patches the START)
            deps.pushToolResult(messages, call, result);
            if (tr?.image) pendingImages.push({ image: tr.image, label: tr.imageLabel || "screenshot" });
            // Multiple images from one call (look's overlay + no-overlay) → each becomes its own inline image.
            if (tr?.images) for (const im of tr.images) pendingImages.push({ image: im.image, label: im.label || "screenshot" });
        }
        // Inline vision: hand any screenshots this step captured to the model as a user turn, so the
        // next step reasons over the real pixels (the native `look` path; a text-only driver omits the dep).
        if (pendingImages.length) deps.pushToolImages?.(messages, pendingImages);
    }
    return { summary: `Stopped at the ${maxSteps()}-step cap without finishing.`, steps: maxSteps(), transcript, elements: [], hitCap: true };
}
