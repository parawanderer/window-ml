// PAGE-SIDE tool delegation. The agent loop runs in the BACKGROUND (extension origin, so
// its approval decision is unforgeable by the page), but page-context tools (exec/click/type/look/
// locate/DOM survey) must run where the DOM is: the page's main world. So the toolset — live MlTool
// objects, whose run() functions can't cross the window bus — is registered here per RUN, and the
// background asks the page to run a named tool via RUN_TOOL_IN_PAGE (relayed by content.ts as a
// PAGE_TOOL_RUN window message; the reply rides back as PAGE_TOOL_RESULT).
//
// Only the SERIALIZABLE parts of the result cross back to the background (result string, screenshot
// data-URL, render descriptors, an element COUNT). The real DOM Nodes an answer-capable tool returns
// stay page-side, accumulated in the run record so ml.agent can assemble AgentResult.elements once the
// background reports the run finished. This is the transport half of design A; the loop that drives it
// is `runAgentLoop` (agent-loop.ts), assembled background-side in a later slice.
import type { MlTool, PageToolEnvelope } from "./contract";
import { executeTool, toolContext } from "./tool-exec";
import { captureVerify } from "./builtin-tools";
import { descriptorFor } from "./render-descriptor";
import { evalReadonly } from "./readonly-exec";
import { formatReadonlyExec } from "./approval";

/** One active agent run's page-side state: its toolset by name, and the DOM nodes designated by
 *  answer-capable tools (assembled into AgentResult.elements — nodes can't cross the bus). */
export interface PageRun {
    byName: Record<string, MlTool>;
    answered: Node[];
    model?: string | null;         // the run's driver model, for the tools' ToolContext (background-delegated path)
    driverSees?: boolean;          // does the driver see natively (native vs delegated look/locate feedback)
    visionModel?: string | null;   // the resolved vision reader — both carried onto the delegated ToolContext
}

const runs = new Map<string, PageRun>();

/** Register an agent run's live toolset page-side (called by ml.agent's START_RUN shim). `model`/`driverSees`/
 *  `visionModel` feed the ToolContext a delegated tool's run(args, ctx) receives (the page loop builds its own
 *  ctx directly, from the SAME values) — so a background-hosted locate reads the same vision facts. */
export function registerRun(runId: string, tools: MlTool[], model: string | null = null, driverSees = false, visionModel: string | null = null): PageRun {
    const run: PageRun = { byName: Object.fromEntries(tools.map(t => [t.name, t])), answered: [], model, driverSees, visionModel };
    runs.set(runId, run);
    return run;
}

/** End a run and return its record (with the accumulated answered nodes), or undefined if unknown. */
export function endRun(runId: string): PageRun | undefined {
    const run = runs.get(runId);
    runs.delete(runId);
    return run;
}

export function getRun(runId: string): PageRun | undefined { return runs.get(runId); }

/** Run ONE delegated tool call for a background-hosted run → a serializable envelope for the bus.
 *  executeTool already validates args + catches errors (never throws), so this only reduces the
 *  envelope: real nodes → a count, and an answer-capable tool's nodes are stashed page-side. */
export async function runDelegatedTool(runId: string, name: string, args: Record<string, unknown>, opts: { renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; verifyAt?: { x: number; y: number } } = {}): Promise<PageToolEnvelope> {
    const run = runs.get(runId);
    if (!run) return { result: `Error: no active agent run "${runId}" on this page (it may have ended).` };
    // Post-CDP `verify`: the reserved-surface click was done BACKGROUND-side (CDP), so the page-side verify
    // couldn't run inline — the background rings back HERE, after the click, to capture the general-area crop
    // at the click point (captureVerify, with this run's driver-sees/reader ctx). Merged into the click result.
    if (opts.verifyAt) {
        const ctx = toolContext(run.byName, run.model ?? null, null, run.driverSees ?? false, run.visionModel ?? null);
        const ml = (typeof window !== "undefined" ? window.ml : null) as unknown as import("./contract").MlApi;
        if (!ml) return { result: "" };
        const v = await captureVerify(ml, ctx, { x: opts.verifyAt.x, y: opts.verifyAt.y }, "clicked");
        return { result: v.content || "", image: v.image, imageLabel: v.imageLabel, feedback: v.feedback };
    }
    const tool = run.byName[name];
    if (!tool) return { result: `Error: no tool named "${name}".` };
    // Approval preview: compute the In render for the CALL without RUNNING the tool (side-effect-free).
    if (opts.renderOnly) {
        const { in: renderIn } = descriptorFor(tool, { result: "" }, args);
        return { result: "", renderIn };
    }
    // Doomed-action precheck (click/type): side-effect-free target resolution. A non-null error → the
    // action can only fail, so the background SKIPS the gate and returns it (no pointless approval).
    if (opts.precheck) {
        let pre: string | null = null;
        try { pre = typeof tool.precheck === "function" ? tool.precheck(args) : null; } catch { pre = null; }
        return { result: pre || "", precheckFailed: !!pre };
    }
    // Read-only try (exec only): run the mediated interpreter (no eval, no mutation). If in-dialect it
    // BOTH decides auto-approve AND produces the result → the background skips the gate. Out-of-dialect
    // (any NotInDialect/Denied throw) → readonly:false, so the background falls through to the human gate.
    // `window.ml` is passed so the dialect can call its read-only slice (ML_READONLY_METHODS) — the
    // interpreter reduces it to a facade holding nothing else.
    if (opts.readonlyTry) {
        if (name !== "exec" || typeof (args as { js?: unknown }).js !== "string") return { result: "", readonly: false };
        try {
            const ro = await evalReadonly((args as { js: string }).js, document, typeof window !== "undefined" ? window.ml : null);
            const { result, elements } = formatReadonlyExec(ro.value, ro.logs);
            const { in: renderIn, out: renderOut } = descriptorFor(tool, { result, elements }, args);
            return { result, elementCount: elements ? elements.length : undefined, renderIn, renderOut, readonly: true };
        } catch { return { result: "", readonly: false }; }
    }
    const env = await executeTool(tool, args, toolContext(run.byName, run.model ?? null, null, run.driverSees ?? false, run.visionModel ?? null));
    // An answer-capable tool designates the caller-facing result node(s) → stash them page-side; only
    // the COUNT crosses to the background (the nodes reach the caller via AgentResult.elements).
    if (env.elements && env.elements.length && tool.capabilities && tool.capabilities.includes("answer")) {
        run.answered.push(...env.elements);
    }
    // Compute the debug-render slots HERE (page-side) — the tool's render() method + its live nodes
    // live here, so the background emits the same rendered In/Out the page loop would.
    const { in: renderIn, out: renderOut } = descriptorFor(tool, env, args);
    return {
        result: env.result,
        elementCount: env.elements ? env.elements.length : undefined,
        image: env.image, imageLabel: env.imageLabel,
        renderIn, renderOut,
        feedback: env.feedback,   // what locate fed into the model's context → surfaced in the debug render + export
        cdpClick: env.cdpClick,   // reserved-surface click → the BACKGROUND does the CDP click (trusted)
    };
}

/** Install the window-message bridge (once, at injection): content.ts relays the background's
 *  RUN_TOOL_IN_PAGE here as a PAGE_TOOL_RUN window message; we run the tool and post the serializable
 *  PAGE_TOOL_RESULT back, correlated by the content-minted callId. */
export function installToolDelegation(): void {
    window.addEventListener("message", async (event: MessageEvent) => {
        if (event.source !== window || !event.data || event.data.type !== "PAGE_TOOL_RUN") return;
        const { callId, runId, name, args, renderOnly, readonlyTry, precheck, verifyAt } = event.data as { callId: string; runId: string; name: string; args: Record<string, unknown>; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; verifyAt?: { x: number; y: number } };
        const envelope = await runDelegatedTool(runId, name, args || {}, { renderOnly: !!renderOnly, readonlyTry: !!readonlyTry, precheck: !!precheck, verifyAt });
        window.postMessage({ type: "PAGE_TOOL_RESULT", callId, envelope }, "*");
    });
}