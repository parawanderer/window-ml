// Design A — the BACKGROUND agent host. Assembles the world-agnostic loop (runAgentLoop, agent-loop.ts)
// with the format-neutral message builders + the TRUSTED auto-approve decision, leaving the truly
// chrome-specific capabilities injected: the model call (background fetchLLM), tool delegation to the
// page (RUN_TOOL_IN_PAGE — run-delegation.ts on the page side), the approval gate (the sidebar), and
// the debug emitter (agent-step fan-out). background.ts provides those; this module is chrome/DOM-free
// so the assembly + message handling unit-test standalone (dist/agent-host.js).
//
// Why the auto-approve lives HERE (trusted) and not in the injected delegateTool: `autoApprovePython`
// is the decision that lets a privileged python_exec SKIP the human gate. It must be made where the
// page can't forge it — the whole point of design A. So the host makes it; the page only ever EXECUTES
// what the host already decided to run.  (exec's read-only fast-path is deliberately NOT here — exec is
// page-context, so a forged "it's read-only" gains nothing the page couldn't already do; it stays a
// page-side concern of the delegated exec path. See principle-adding-a-privileged-tool.)
import type { NeutralMessage, ToolCall, AgentResult, ApprovalDecision } from "./contract";
import { runAgentLoop } from "./agent-loop";
import type { ToolMeta, AgentLoopDeps } from "./agent-loop";
import { autoApprovePython } from "./auto-approve";

/** The run's resolved setup, sent from ml.agent's START_RUN shim. The system prompt is built PAGE-SIDE
 *  (it needs page context + the vision/answer/compute clauses + the toolset), so the background receives
 *  it ready-made; the tools are serializable descriptors only (their run() stays on the page). */
export interface RunAgentConfig {
    task: string;
    systemPrompt: string;
    tools: ToolMeta[];
    model?: string | null;
    think?: boolean | null;
    maxSteps?: number;
    autoApprovePython?: boolean;   // the trusted config flag, read background-side
}

export interface RunAgentHostDeps {
    // One model turn (background fetchLLM) → a normalized assistant message.
    callModel(
        messages: NeutralMessage[],
        opts: { tools: ToolMeta[]; model?: string | null; think?: boolean | null; step: number },
    ): Promise<{ content?: string | null; tool_calls?: ToolCall[]; usage?: unknown }>;
    // Delegate a tool call to the page (RUN_TOOL_IN_PAGE) → its serializable result string. Reached for
    // a requiresApproval tool ONLY after the gate — the untrusted execution point.
    delegateTool(name: string, args: Record<string, unknown>): Promise<{ result: string }>;
    // The approval gate — the sidebar, in design A (origin-authed; the decision never crosses the page).
    approve(req: { tool: string; arguments: Record<string, unknown>; seq?: number; step?: number }): Promise<ApprovalDecision>;
    // Whether an external Google spreadsheet was already approved this run (trusted, background-side) —
    // lets a repeat python_exec on the same sheet skip the re-prompt without re-escalating.
    isSheetApproved?(id: string): boolean;
    // Debug fan-out (agent-step events: the pending START then the DONE).
    emit?: AgentLoopDeps["emit"];
    signal?: AbortSignal | null;
}

/** Run one agent task in the background, delegating tool execution to the page. This is the design-A
 *  counterpart of the page-side ml.agent loop; both share runAgentLoop's gate-before-execute invariant. */
export function runBackgroundAgent(cfg: RunAgentConfig, deps: RunAgentHostDeps): Promise<AgentResult> {
    // Format-neutral message plumbing — the background's fetchLLM (callModel) converts to the wire form
    // per API format, so the host only deals in NeutralMessage.
    const buildMessages = (task: string): NeutralMessage[] => [
        { role: "system", content: cfg.systemPrompt },
        { role: "user", content: task },
    ];
    const pushAssistant = (messages: NeutralMessage[], msg: { content?: string | null; tool_calls?: ToolCall[] }): void => {
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    };
    const pushToolResult = (messages: NeutralMessage[], call: ToolCall, result: string): void => {
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
    };
    // Inline vision: a tool RESULT can't carry an image, but a user turn can — so a native `look`
    // screenshot reaches the (vision-capable) driver model on its next turn. Mirrors the page loop.
    const pushToolImages = (messages: NeutralMessage[], images: { image: string; label: string }[]): void => {
        const labels = images.map(p => p.label).join(", ");
        messages.push({
            role: "user",
            content: `Screenshot${images.length > 1 ? "s" : ""} you requested (${labels}). ` +
                "Describe what you see, then take the next action — or give your final answer if the task is done.",
            images: images.map(p => p.image),
        });
    };

    const loopDeps: AgentLoopDeps = {
        callModel: (messages, o) => deps.callModel(messages as NeutralMessage[], { tools: o.tools, model: cfg.model, think: cfg.think, step: o.step }),
        runTool: (name, args) => deps.delegateTool(name, args),
        approve: deps.approve,
        // Trusted auto-approve: only python_exec today; a tool not modelled here simply always asks
        // (friction, never less safety — see auto-approve.ts).
        autoApprove: (name, args) => name === "python_exec"
            ? autoApprovePython(args, { autoApprovePython: !!cfg.autoApprovePython }, deps.isSheetApproved || (() => false))
            : null,
        buildMessages: buildMessages as AgentLoopDeps["buildMessages"],
        pushAssistant: pushAssistant as AgentLoopDeps["pushAssistant"],
        pushToolResult: pushToolResult as AgentLoopDeps["pushToolResult"],
        pushToolImages: pushToolImages as AgentLoopDeps["pushToolImages"],
        emit: deps.emit,
    };
    return runAgentLoop(cfg.task, { tools: cfg.tools, maxSteps: cfg.maxSteps, signal: deps.signal }, loopDeps);
}
