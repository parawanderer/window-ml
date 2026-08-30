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
import { runAgentLoop, shotTurnMessage } from "./agent-loop";
import type { ToolMeta, AgentLoopDeps, ToolRunResult } from "./agent-loop";
import { autoApprovePython } from "./auto-approve";
import { externalSheetIds } from "./dom";

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
    unattended?: boolean;          // headless run: refuse any call that reaches the human gate (see ml.agent's `unattended`)
    resumeMessages?: NeutralMessage[];   // RESUME: continue this prior history (+ `task` as a new user turn) instead of a fresh system+task
    images?: string[];   // native-vision composer attachments (data URLs) → attached to THIS turn's user message. The OCR fallback for a text-only driver already folded into `task` page-side.
}

export interface RunAgentHostDeps {
    // One model turn (background fetchLLM) → a normalized assistant message.
    callModel(
        messages: NeutralMessage[],
        opts: { tools: ToolMeta[]; model?: string | null; think?: boolean | null; step: number },
    ): Promise<{ content?: string | null; tool_calls?: ToolCall[]; usage?: unknown; reasoning?: unknown }>;
    // Delegate a tool call to the page (RUN_TOOL_IN_PAGE) → its serializable result string. Reached for
    // a requiresApproval tool ONLY after the gate — the untrusted execution point.
    delegateTool(name: string, args: Record<string, unknown>): Promise<ToolRunResult>;
    // Self-introspection (chat_metadata): the run's model + its context window + capability list, from the
    // SW's caches. The loop supplies the token/message counts; this only adds the model facts. Optional.
    chatMeta?(): Promise<{ model: string | null; contextWindow: number | null; capabilities: string[] | null } | null>;
    // This turn's delegated vision sub-call tally (look/locate/verify's own calls) — accumulated background-
    // side from each delegated tool's envelope delta, so chat_metadata reports the real number here too.
    subcallTokens?: AgentLoopDeps["subcallTokens"];
    // Read-only try (exec only): page-delegated attempt via the mediated interpreter. A non-null result
    // means it ran safely (no mutation) → skip the gate. Wired only when autoApproveReadonly is on.
    tryReadonly?(name: string, args: Record<string, unknown>): Promise<ToolRunResult | null>;
    precheck?(name: string, args: Record<string, unknown>): Promise<string | null>;   // doomed-action skip (click/type)
    // The approval gate — the sidebar, in design A (origin-authed; the decision never crosses the page).
    approve(req: { tool: string; arguments: Record<string, unknown>; seq?: number; step?: number }): Promise<ApprovalDecision>;
    // Whether an external Google spreadsheet was already approved this run (trusted, background-side) —
    // lets a repeat python_exec on the same sheet skip the re-prompt without re-escalating.
    isSheetApproved?(id: string): boolean;
    // Cross-origin navigation consent: true → this `navigate` leaves the run's consented origins, so it must
    // GATE (a page can't silently send the agent to another site); false → same-site (or an already-consented
    // origin) → auto-approve. Trusted (background-decided from the tab's real origin), not page-forgeable.
    navNeedsConsent?(url: string): boolean;
    // ml.fetch consent: true → this exact URL hasn't been approved on this tab yet → GATE; false → already
    // approved this session → auto-approve (no re-prompt). Trusted (background-side, per-URL), not forgeable.
    fetchNeedsConsent?(url: string): boolean;
    // Debug fan-out (agent-step events: the pending START then the DONE).
    emit?: AgentLoopDeps["emit"];
    // Durable resume: called with the run's live message array after each COMPLETED step, so the background
    // can snapshot it to storage — a re-spawned SW (MV3 evicts ~30s idle) can then rehydrate an in-flight run.
    checkpoint?(messages: NeutralMessage[]): void;
    // Mid-run steering (a.say() → INJECT_MESSAGE): the run's SW-side inbox, drained at each step boundary.
    drainInbox?: AgentLoopDeps["drainInbox"];
    signal?: AbortSignal | null;
}

/** Run one agent task in the background, delegating tool execution to the page. This is the design-A
 *  counterpart of the page-side ml.agent loop; both share runAgentLoop's gate-before-execute invariant. */
// Returns AgentResult WITHOUT `hash` (see runAgentLoop): the page-side ml.agent caller owns the
// run's hash (runHash) and stamps it onto the result it hands back — the background never mints one.
export function runBackgroundAgent(cfg: RunAgentConfig, deps: RunAgentHostDeps): Promise<{ result: Omit<AgentResult, "hash">; messages: NeutralMessage[] }> {
    // Format-neutral message plumbing — the background's fetchLLM (callModel) converts to the wire form
    // per API format, so the host only deals in NeutralMessage.
    // `built` retains the run's message array so the caller can persist the final history for a RESUME
    // (the loop mutates it in place). A resume seeds it with the prior turns + the new task; a fresh run
    // starts with system + task.
    let built: NeutralMessage[] = [];
    const buildMessages = (task: string): NeutralMessage[] => {
        // This turn's user message — carries native-vision composer images when present. Emitted only when
        // there's text OR an image (a.run() with no arg + no image runs over what say() already queued).
        const userTurn = (task || cfg.images?.length)
            ? [{ role: "user", content: task || "", ...(cfg.images?.length ? { images: cfg.images } : {}) } as NeutralMessage] : [];
        built = cfg.resumeMessages && cfg.resumeMessages.length
            // Continue the handle's prior history. Ensure a system prompt heads it (an idle say() before the
            // first run() has none).
            ? [
                ...(cfg.resumeMessages[0]?.role === "system" ? [] : [{ role: "system", content: cfg.systemPrompt } as NeutralMessage]),
                ...cfg.resumeMessages,
                ...userTurn,
            ]
            : [{ role: "system", content: cfg.systemPrompt }, ...userTurn];
        return built;
    };
    const pushAssistant = (messages: NeutralMessage[], msg: { content?: string | null; tool_calls?: ToolCall[] }): void => {
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    };
    const pushToolResult = (messages: NeutralMessage[], call: ToolCall, result: string): void => {
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
    };
    // Inline vision: a tool RESULT can't carry an image, but a user turn can — so a native `look`
    // screenshot reaches the (vision-capable) driver model on its next turn. Mirrors the page loop.
    const pushToolImages = (messages: NeutralMessage[], images: { image: string; label: string }[]): void => {
        messages.push({
            role: "user",
            content: shotTurnMessage(images.map(p => p.label).join(", "), images.length),
            images: images.map(p => p.image),
        });
    };

    const loopDeps: AgentLoopDeps = {
        callModel: (messages, o) => deps.callModel(messages as NeutralMessage[], { tools: o.tools, model: cfg.model, think: cfg.think, step: o.step }),
        runTool: (name, args) => deps.delegateTool(name, args),
        tryReadonly: deps.tryReadonly,
        precheck: deps.precheck,
        approve: deps.approve,
        // Trusted auto-approve: only python_exec today; a tool not modelled here simply always asks
        // (friction, never less safety — see auto-approve.ts).
        autoApprove: (name, args) => {
            if (name === "python_exec") {
                const isApproved = deps.isSheetApproved || (() => false);
                const prov = autoApprovePython(args, { autoApprovePython: !!cfg.autoApprovePython }, isApproved);
                if (!prov) return null;
                // Parity with the page loop (injected.ts): surface which already-approved external sheet(s)
                // this call REUSED as a "reused a grant" note — else the background path silently drops it.
                const reusedSheets = externalSheetIds(args).filter(id => isApproved(id));
                return reusedSheets.length ? { approval: prov, reused: reusedSheets.map(id => ({ kind: "sheet" as const, detail: id })) } : prov;
            }
            // navigate: a cross-origin nav that needs consent GATES; same-site (or already-consented) auto-approves.
            if (name === "navigate") return deps.navNeedsConsent?.(String((args as { url?: unknown }).url ?? "")) ? null : "same-origin";
            // fetch_url: a CREDENTIALED (fetch-as-the-user) call ALWAYS gates — never auto-approved, never
            // remembered. An uncredentialed URL already approved this session auto-approves; a new one gates.
            if (name === "fetch_url") {
                if ((args as { credentials?: unknown }).credentials) return null;
                return deps.fetchNeedsConsent?.(String((args as { url?: unknown }).url ?? "")) ? null : "consented";
            }
            return null;
        },
        buildMessages: buildMessages as AgentLoopDeps["buildMessages"],
        pushAssistant: pushAssistant as AgentLoopDeps["pushAssistant"],
        pushToolResult: pushToolResult as AgentLoopDeps["pushToolResult"],
        pushToolImages: pushToolImages as AgentLoopDeps["pushToolImages"],
        // Mid-run steering: drain the SW-side inbox (a.say() → INJECT_MESSAGE) and inject as user turns.
        drainInbox: deps.drainInbox,
        pushUser: (messages, text) => (messages as NeutralMessage[]).push({ role: "user", content: text }),
        // Wrap emit to checkpoint the live history after each COMPLETED step (the DONE emit, not the pending
        // START) — so a snapshot for durable resume lands once a step's result is in `built`.
        emit: (deps.emit || deps.checkpoint) ? ((ev) => {
            deps.emit?.(ev);
            if (deps.checkpoint && !ev.pending && ev.step != null) deps.checkpoint(built);
        }) : undefined,
        chatMeta: deps.chatMeta,   // resolve model/caps/window SW-side (background provides the caches)
        subcallTokens: deps.subcallTokens,   // this turn's delegated vision sub-call tally (background-accumulated)
    };
    return runAgentLoop(cfg.task, { tools: cfg.tools, maxSteps: cfg.maxSteps, signal: deps.signal, unattended: cfg.unattended }, loopDeps)
        .then(result => ({ result, messages: built }));
}
