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

import type { AgentResult, AgentTranscriptEntry, ApprovalDecision, ToolCall, RenderDescriptor } from "./contract";

export type Approval = "readonly" | "sandbox" | "user" | "denied";
export interface ToolMeta { name: string; requiresApproval?: boolean; capabilities?: string[]; }
// The tool's serializable result. `renderIn`/`renderOut` are the debug-render slots computed by the
// executor's world (page-side for the delegated path) so the emitter can show a rendered In/Out.
// `image` is a screenshot a vision tool (native `look`) captured — INLINE VISION: it's injected into
// the model's next turn as a user image (via pushToolImages) so the model reasons over the real pixels.
export interface ToolRunResult { result: string; elements?: unknown[]; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; image?: string; imageLabel?: string; }

export interface AgentLoopDeps {
    // One model turn → the assistant message (content + normalized tool_calls + usage).
    callModel(messages: unknown[], opts: { tools: ToolMeta[]; step: number }): Promise<{ content?: string | null; tool_calls?: ToolCall[]; usage?: unknown }>;
    // Execute a tool by name — LOCAL (page-side today) or DELEGATED (background → page, safe mode).
    // Reached for a requiresApproval tool ONLY after the gate. This is the untrusted delegation point.
    runTool(name: string, args: Record<string, unknown>): Promise<ToolRunResult>;
    // The approval gate (UI). Reached ONLY for a requiresApproval tool that isn't auto-approved. `seq`
    // and `step` identify the pending step so a background gate can correlate its async decision to it.
    approve(req: { tool: string; arguments: Record<string, unknown>; seq?: number; step?: number }): Promise<ApprovalDecision>;
    // Pure auto-approve decision, made in the TRUSTED world (python readonly / suspicious-char /
    // external-sheet). Returns the provenance to skip the gate, or null to require it. NEVER delegated —
    // a forged "it's auto-approved" is exactly the threat design A closes.
    autoApprove?(name: string, args: Record<string, unknown>): "readonly" | "sandbox" | null;
    // Read-only try (exec only): attempt the call via the mediated read-only interpreter, which is
    // side-effect-free (it can't mutate) — so it BOTH decides "auto-approve" AND returns the result. A
    // non-null result skips the gate AND runTool (the interpreter already ran it). null → gate as normal.
    // Page-delegated on the background path; safe to delegate BECAUSE it can't do anything a mutation
    // could. Reached before autoApprove/the gate for a requiresApproval tool.
    tryReadonly?(name: string, args: Record<string, unknown>): Promise<ToolRunResult | null>;
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
    emit?(ev: { step: number; seq?: number; pending?: boolean; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; approval?: Approval; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; usage?: unknown }): void;
}

export interface AgentLoopOptions { tools: ToolMeta[]; maxSteps?: number; signal?: AbortSignal | null; }

// Normalize an approval gate's return (boolean OR the rich contract) into a decision. Inlined (not
// imported from approval.ts) so this module stays DOM/chrome-free for the standalone build.
const normalize = (d: ApprovalDecision, orig: Record<string, unknown>): { approved: boolean; feedback: string | null; arguments: Record<string, unknown> } => {
    if (d && typeof d === "object") return {
        approved: !!d.approved,
        feedback: typeof d.feedback === "string" && d.feedback.trim() ? d.feedback.trim() : null,
        arguments: d.approved && d.arguments && typeof d.arguments === "object" ? d.arguments : orig,
    };
    return { approved: !!d, feedback: null, arguments: orig };
};

export async function runAgentLoop(task: string, opts: AgentLoopOptions, deps: AgentLoopDeps): Promise<AgentResult> {
    const { tools, maxSteps = 10, signal } = opts;
    const byName = new Map(tools.map(t => [t.name, t]));
    const messages = deps.buildMessages(task);
    const transcript: AgentTranscriptEntry[] = [];
    let seq = 0;
    const cancelled = (steps: number): AgentResult => ({ summary: "Cancelled by the caller.", steps, transcript, elements: [], cancelled: true });

    for (let step = 1; step <= maxSteps; step++) {
        if (signal?.aborted) return cancelled(step - 1);
        const msg = await deps.callModel(messages, { tools, step });
        if (signal?.aborted) return cancelled(step - 1);
        if (!msg.tool_calls || !msg.tool_calls.length) {
            // Final-answer step: emit its usage (the run's peak context) so the sidebar's usage gauge
            // measures the same on the background path as it does page-side — a usage-only step event.
            if (msg.usage) deps.emit?.({ step, usage: msg.usage });
            return { summary: (msg.content || "").trim(), steps: step - 1, transcript, elements: [] };
        }
        // The step's token usage rides the thought emit (or a usage-only emit when there's no prose),
        // matching the page-side loop so a background run's usage gauge isn't blank.
        const thought = (msg.content || "").trim();
        if (thought || msg.usage) {
            if (thought) transcript.push({ thought });
            deps.emit?.({ step, thought: thought || undefined, usage: msg.usage });
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
            } else if (meta.requiresApproval) {
                // Read-only try FIRST: the mediated interpreter can't mutate, so if the call is in its
                // dialect it's already run safely — auto-approve with its result, no gate, no runTool.
                const ro = deps.tryReadonly ? await deps.tryReadonly(call.name, args) : null;
                const auto = ro ? null : (deps.autoApprove?.(call.name, args) || null);
                if (ro) {
                    approval = "readonly";
                    tr = ro; result = ro.result;   // the interpreter already produced the result
                } else if (auto) {
                    approval = auto;
                    tr = await deps.runTool(call.name, args); result = tr.result;   // trusted auto-approve → execute
                } else {
                    const d = normalize(await deps.approve({ tool: call.name, arguments: args, seq: s, step }), args);
                    if (!d.approved) {
                        approval = "denied";
                        result = d.feedback
                            ? `Denied by the user: ${d.feedback}\nDo not retry this exact call unchanged; address the feedback or try another approach.`
                            : "Denied by the user. Do not retry this exact call; try another approach.";
                        // NB: runTool is NOT called — the security invariant.
                    } else {
                        approval = "user";
                        args = d.arguments;                                   // possibly gate-edited
                        tr = await deps.runTool(call.name, args); result = tr.result;   // EXECUTE ONLY AFTER APPROVE
                    }
                }
            } else {
                tr = await deps.runTool(call.name, args); result = tr.result;   // non-approval tool
            }
            result = String(result);
            transcript.push({ tool: call.name, arguments: args, result });
            deps.emit?.({ step, seq: s, tool: call.name, arguments: args, result, approval, renderIn: tr?.renderIn, renderOut: tr?.renderOut });   // DONE (patches the START)
            deps.pushToolResult(messages, call, result);
            if (tr?.image) pendingImages.push({ image: tr.image, label: tr.imageLabel || "screenshot" });
        }
        // Inline vision: hand any screenshots this step captured to the model as a user turn, so the
        // next step reasons over the real pixels (the native `look` path; a text-only driver omits the dep).
        if (pendingImages.length) deps.pushToolImages?.(messages, pendingImages);
    }
    return { summary: `Stopped at the ${maxSteps}-step cap without finishing.`, steps: maxSteps, transcript, elements: [], hitCap: true };
}
