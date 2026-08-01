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
import { executeTool } from "./tool-exec";
import { descriptorFor } from "./render-descriptor";

/** One active agent run's page-side state: its toolset by name, and the DOM nodes designated by
 *  answer-capable tools (assembled into AgentResult.elements — nodes can't cross the bus). */
export interface PageRun {
    byName: Record<string, MlTool>;
    answered: Node[];
}

const runs = new Map<string, PageRun>();

/** Register an agent run's live toolset page-side (called by ml.agent's START_RUN shim). */
export function registerRun(runId: string, tools: MlTool[]): PageRun {
    const run: PageRun = { byName: Object.fromEntries(tools.map(t => [t.name, t])), answered: [] };
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
export async function runDelegatedTool(runId: string, name: string, args: Record<string, unknown>): Promise<PageToolEnvelope> {
    const run = runs.get(runId);
    if (!run) return { result: `Error: no active agent run "${runId}" on this page (it may have ended).` };
    const tool = run.byName[name];
    if (!tool) return { result: `Error: no tool named "${name}".` };
    const env = await executeTool(tool, args);
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
    };
}

/** Install the window-message bridge (once, at injection): content.ts relays the background's
 *  RUN_TOOL_IN_PAGE here as a PAGE_TOOL_RUN window message; we run the tool and post the serializable
 *  PAGE_TOOL_RESULT back, correlated by the content-minted callId. */
export function installToolDelegation(): void {
    window.addEventListener("message", async (event: MessageEvent) => {
        if (event.source !== window || !event.data || event.data.type !== "PAGE_TOOL_RUN") return;
        const { callId, runId, name, args } = event.data as { callId: string; runId: string; name: string; args: Record<string, unknown> };
        const envelope = await runDelegatedTool(runId, name, args || {});
        window.postMessage({ type: "PAGE_TOOL_RESULT", callId, envelope }, "*");
    });
}