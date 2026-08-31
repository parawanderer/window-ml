// Execute ONE agent tool call → a result envelope. This is the single place a tool's `run()` is
// invoked, with the same arg-validation + error/envelope handling: the page-side agent loop calls it
// today, and design A's RUN_TOOL_IN_PAGE handler (the background delegating page-context execution to
// the page) will call the SAME function — so the two paths can't drift. Page-side (a tool's run()
// touches the DOM and may return real Nodes); the delegation layer reduces `elements` to a count.
import type { MlTool, ToolResult, RenderDescriptor, ToolContext, ToolFeedback } from "./contract";
import { validateArgs } from "./validate";
import { errText } from "./dom";

/** Build the runtime ToolContext from the run's toolset (+ model/caps). One helper so the page loop and the
 *  background-delegation path produce an identical `ctx`. `byName` is the same map both paths already hold. */
export function toolContext(byName: Record<string, MlTool>, model: string | null = null, capabilities: string[] | null = null, driverSees = false, visionModel: string | null = null): ToolContext {
    return { tools: Object.keys(byName), hasTool: (n) => n in byName, model, capabilities, driverSees, visionModel };
}

export interface ToolEnvelope {
    result: string;
    elements?: Node[];
    /** answer's serialized element visuals → the HUD completion card (never the model / debug sidebar) */
    answerMedia?: import("./contract").AnswerMedia[];
    image?: string;
    imageLabel?: string;
    /** multiple inline-vision images from one call (look's overlay + no-overlay) → pushed as separate turns */
    images?: { image: string; label?: string }[];
    render?: RenderDescriptor;
    renderIn?: RenderDescriptor;
    /** reserved-surface (cross-origin iframe / sealed shadow) click signal → the executor does a CDP click */
    cdpClick?: { x: number; y: number; hint?: string; verify?: boolean };
    /** strict-page exec: main-world eval was CSP/TT-blocked → the executor re-runs the source via CDP */
    cdpExec?: { source: string };
    /** sealed-shadow (`>>>` into a closed/declarative root) click → the executor CDP-resolves + clicks it */
    cdpShadowClick?: { selector: string; index?: number; verify?: boolean };
    /** what the tool fed into the model's context (locate's snap-inject) → surfaced in the debug render + export */
    feedback?: ToolFeedback;
}

export async function executeTool(tool: MlTool, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolEnvelope> {
    // Check the model's args against the tool's schema (the same validateArgs that feeds the debug ⚠
    // strip) and surface it to the MODEL, not just the sidebar. A MISSING REQUIRED arg means the tool
    // can't run usefully (e.g. click with no `selector` → a baffling "No element matches undefined"),
    // so short-circuit with the schema error. Softer issues (unknown/extra prop, bad enum, type
    // mismatch) don't block — the tool runs and we PREPEND the note, so a lenient validator never
    // rejects a legitimate call.
    const issues = validateArgs(tool.parameters, args);
    if (issues.some(s => s.startsWith("missing required"))) {
        // "Error:" so the sidebar's toolFailed marks the step failed (red dot), not green — it never ran.
        return { result: `Error: invalid arguments for "${tool.name}" — ${issues.join("; ")}. Call it again with the correct argument name(s).` };
    }
    // Soft issues APPEND (not prepend), so a real "Error:"/"Denied" prefix stays at position 0.
    const note = issues.length ? `\n\n⚠ Argument schema issue(s): ${issues.join("; ")}` : "";
    try {
        const raw = await tool.run(args, ctx);
        // A tool may return a plain string, or { content, elements, image?, render?, renderIn? } to
        // also hand back real DOM nodes / a screenshot (routed to onStep/the transcript, never the model).
        if (raw && typeof raw === "object" && typeof (raw as ToolResult).content === "string") {
            const r = raw as ToolResult;
            return { result: r.content + note, elements: r.elements, answerMedia: r.answerMedia, image: r.image, imageLabel: r.imageLabel, images: r.images, render: r.render, renderIn: r.renderIn, cdpClick: r.cdpClick, cdpExec: r.cdpExec, cdpShadowClick: r.cdpShadowClick, feedback: r.feedback };
        }
        return { result: String(raw) + note };
    } catch (e) { return { result: `Error: ${errText(e)}` + note }; }
}
