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
import type { MlTool, PageToolEnvelope, SubcallUsage } from "./contract";
import { outputCapEscalated } from "./contract";
import { executeTool, toolContext } from "./tool-exec";
import { captureVerify } from "./builtin-tools";
import { htmlToMarkdown } from "./html-to-md";
import { clipOut } from "./dom";
import { descriptorFor } from "./render-descriptor";
import { evalReadonly } from "./readonly-exec";
import { formatReadonlyExec } from "./approval";
import { subcallUsage } from "./bus";

/** The delegated vision-sub-call tokens `fn` spent, as a DELTA around the page-side meter (bus.ts). The
 *  background loop can't read the page's accumulator, so each delegated tool call reports its own spend and
 *  the SW sums them per turn. Undefined when nothing was delegated (keeps the envelope clean). */
async function withSubUsage<T extends PageToolEnvelope>(fn: () => Promise<T>): Promise<T> {
    const before = subcallUsage();
    const env = await fn();
    const after = subcallUsage();
    const sub: SubcallUsage = { prompt: after.prompt - before.prompt, completion: after.completion - before.completion, calls: after.calls - before.calls };
    // Per-model DELTA too, so the background tally can attribute the spend (chat_metadata "which model cost
    // what") on the delegated path — not just the page loop. after minus before, per model, calls>0 only.
    const b = new Map((before.byModel || []).map(x => [x.model, x]));
    const byModel = (after.byModel || []).map(a => {
        const prev = b.get(a.model);
        return { model: a.model, prompt: a.prompt - (prev?.prompt || 0), completion: a.completion - (prev?.completion || 0), calls: a.calls - (prev?.calls || 0) };
    }).filter(d => d.calls > 0);
    if (byModel.length) sub.byModel = byModel;
    if (sub.calls > 0) env.subUsage = sub;
    return env;
}

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
const VERIFY_TEXT_MAX = 8000;   // cap the navigate verify:"text" Markdown so a big page can't flood the turn
export async function runDelegatedTool(runId: string, name: string, args: Record<string, unknown>, opts: { renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; verifyAt?: { x: number; y: number }; verifyViewport?: boolean; verifyText?: "strip" | "all" } = {}): Promise<PageToolEnvelope> {
    const run = runs.get(runId);
    if (!run) return { result: `Error: no active agent run "${runId}" on this page (it may have ended).` };
    // navigate({ verify: "text" / "text-all" }): after the destination page re-adopts, the background rings
    // back HERE to distil the new page's DOM to Markdown (same HTML→Markdown as fetch_url) — a text-only way to
    // SEE where you landed without a screenshot (cheaper for a text driver, and no vision needed). "strip" drops
    // nav/header/footer/aside (the content); "all" keeps them. Same await/merge path as the screenshot verify.
    if (opts.verifyText) {
        const html = (typeof document !== "undefined" ? document.documentElement?.outerHTML : "") || "";
        const md = htmlToMarkdown(html, { stripChrome: opts.verifyText === "strip" });
        const clipped = clipOut(md, VERIFY_TEXT_MAX);
        const cut = clipped.length < md.length;
        const label = opts.verifyText === "strip" ? "nav/chrome stripped" : "full page";
        return { result: `Destination page as Markdown (${label}${cut ? ", truncated" : ""}):\n\n${clipped}` };
    }
    // navigate({ verify: true / "viewport" }): after the destination page re-adopts, the background rings back
    // HERE to capture a WHOLE-VIEWPORT screenshot of the new page (captureVerify, center null) — a vision driver
    // gets it inline, a text-only driver a delegated description. Merged into the navigate result background-side.
    if (opts.verifyViewport) {
        const ctx = toolContext(run.byName, run.model ?? null, null, run.driverSees ?? false, run.visionModel ?? null);
        const ml = (typeof window !== "undefined" ? window.ml : null) as unknown as import("./contract").MlApi;
        if (!ml) return { result: "" };
        return withSubUsage(async () => {
            const v = await captureVerify(ml, ctx, null, "navigated");
            return { result: v.content || "", image: v.image, imageLabel: v.imageLabel, feedback: v.feedback };
        });
    }
    // Post-CDP `verify`: the reserved-surface click was done BACKGROUND-side (CDP), so the page-side verify
    // couldn't run inline — the background rings back HERE, after the click, to capture the general-area crop
    // at the click point (captureVerify, with this run's driver-sees/reader ctx). Merged into the click result.
    if (opts.verifyAt) {
        const ctx = toolContext(run.byName, run.model ?? null, null, run.driverSees ?? false, run.visionModel ?? null);
        const ml = (typeof window !== "undefined" ? window.ml : null) as unknown as import("./contract").MlApi;
        if (!ml) return { result: "" };
        // captureVerify makes a delegated describe sub-call for a text-only driver → meter its spend.
        return withSubUsage(async () => {
            const v = await captureVerify(ml, ctx, { x: opts.verifyAt!.x, y: opts.verifyAt!.y }, "clicked");
            return { result: v.content || "", image: v.image, imageLabel: v.imageLabel, feedback: v.feedback };
        });
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
        if (outputCapEscalated("exec", args)) return { result: "", readonly: false };   // a raised output cap must hit the human gate
        try {
            const ro = await evalReadonly((args as { js: string }).js, document, typeof window !== "undefined" ? window.ml : null);
            const { result, elements } = formatReadonlyExec(ro.value, ro.logs);
            const { in: renderIn, out: renderOut } = descriptorFor(tool, { result, elements }, args);
            const urls = [...new Set(ro.reused)];   // cached ml.fetch URLs this survey reused → the "reused a grant" note
            return { result, elementCount: elements ? elements.length : undefined, renderIn, renderOut, readonly: true, reused: urls.length ? urls.map(u => ({ kind: "fetch-url" as const, detail: u })) : undefined };
        } catch { return { result: "", readonly: false }; }
    }
    // A tool (look/locate, or click/type/wait with verify) may make its own delegated vision sub-calls —
    // meter their spend as a delta so the background loop can tally it (the page meter it can't read).
    return withSubUsage(async () => {
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
            answerMedia: env.answerMedia,   // serialized answer-element visuals (data URLs) → cross to the background → HUD card
            image: env.image, imageLabel: env.imageLabel, images: env.images,
            renderIn, renderOut,
            feedback: env.feedback,   // what locate fed into the model's context → surfaced in the debug render + export
            cdpClick: env.cdpClick,   // reserved-surface click → the BACKGROUND does the CDP click (trusted)
            cdpExec: env.cdpExec,     // strict-page exec → the BACKGROUND re-runs the source via CDP eval (CSP-exempt)
        };
    });
}

/** Install the window-message bridge (once, at injection): content.ts relays the background's
 *  RUN_TOOL_IN_PAGE here as a PAGE_TOOL_RUN window message; we run the tool and post the serializable
 *  PAGE_TOOL_RESULT back, correlated by the content-minted callId. */
export function installToolDelegation(): void {
    window.addEventListener("message", async (event: MessageEvent) => {
        if (event.source !== window || !event.data || event.data.type !== "PAGE_TOOL_RUN") return;
        const { callId, runId, name, args, renderOnly, readonlyTry, precheck, verifyAt, verifyViewport, verifyText } = event.data as { callId: string; runId: string; name: string; args: Record<string, unknown>; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; verifyAt?: { x: number; y: number }; verifyViewport?: boolean; verifyText?: "strip" | "all" };
        const envelope = await runDelegatedTool(runId, name, args || {}, { renderOnly: !!renderOnly, readonlyTry: !!readonlyTry, precheck: !!precheck, verifyAt, verifyViewport: !!verifyViewport, verifyText });
        window.postMessage({ type: "PAGE_TOOL_RESULT", callId, envelope }, "*");
    });
}