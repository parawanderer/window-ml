// Execute ONE agent tool call → a result envelope. This is the single place a tool's `run()` is
// invoked, with the same arg-validation + error/envelope handling: the page-side agent loop calls it
// today, and design A's RUN_TOOL_IN_PAGE handler (the background delegating page-context execution to
// the page) will call the SAME function — so the two paths can't drift. Page-side (a tool's run()
// touches the DOM and may return real Nodes); the delegation layer reduces `elements` to a count.
import type { MlTool, ToolResult, RenderDescriptor, ToolContext, ToolFeedback, DocsMemory } from "./contract";
import { AnswerSet } from "./answer-set";
import { validateArgs } from "./validate";
import { errText } from "./dom";

// `agent_api_docs`'s within-burst dedup memory is per RUN, but `toolContext` is rebuilt on every
// background-delegated call (run-delegation.ts) — so it can't be created here per call. Keyed off the run's
// `byName` map (the one object both loop paths hold stable for the whole run) it's created once and reused.
const docsMemories = new WeakMap<object, DocsMemory>();

// Same idea for the run's curated answer set: one instance per run, keyed by the toolset, so the `answer`
// tool and `ml.answer` mutate the SAME set whether the tool runs inline (page loop) or delegated (background).
const answerSets = new WeakMap<object, AnswerSet>();
/** The run's answer set for this toolset (created once per run). Exposed so the loop can read it at assembly. */
export function answerSetFor(byName: object): AnswerSet {
    let a = answerSets.get(byName);
    if (!a) { a = new AnswerSet(); answerSets.set(byName, a); }
    return a;
}

// The answer set of the tool currently executing — so `window.ml.answer` (called from an APPROVED exec, or
// the console) resolves to THIS run's set, and THROWS outside any tool run. The read-only exec path threads the
// facade directly (evalReadonly), so this covers the non-readonly paths. Save/restore, so a nested run restores.
let activeAnswer: AnswerSet | null = null;
/** The answer set of the tool currently running, or null (→ `ml.answer` throws outside a run). */
export function currentAnswer(): AnswerSet | null { return activeAnswer; }

// How many NON-docs tool calls may fall between two `agent_api_docs` calls before the dig counts as "over" and
// the shown-set is purged. 1 = tolerate a single quick detour (an `exec` check) mid-dig without re-printing;
// a second intervening step means the model has moved on, so a later re-pull re-reads the definitions fresh.
const DOCS_STREAK_LENIENCY = 1;

/** Build the runtime ToolContext from the run's toolset (+ model/caps). One helper so the page loop and the
 *  background-delegation path produce an identical `ctx`. `byName` is the same map both paths already hold —
 *  which is also what keys the per-run docs-dedup memory, so it survives `toolContext` being rebuilt per call. */
export function toolContext(byName: Record<string, MlTool>, model: string | null = null, capabilities: string[] | null = null, driverSees = false, visionModel: string | null = null): ToolContext {
    let docsMemory = docsMemories.get(byName);
    if (!docsMemory) { docsMemory = { shown: new Set(), sinceDocs: 0 }; docsMemories.set(byName, docsMemory); }
    return { tools: Object.keys(byName), hasTool: (n) => n in byName, model, capabilities, driverSees, visionModel, docsMemory, answer: answerSetFor(byName) };
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
    /** trusted-keyboard type (canvas / WebGL / remote-desktop / sealed field) → the executor types via CDP */
    cdpType?: { text: string; submit?: boolean; append?: boolean; x?: number; y?: number; selector?: string; index?: number; verify?: boolean; verifyElement?: string; verifyFocus?: boolean };
    /** what the tool fed into the model's context (locate's snap-inject) → surfaced in the debug render + export */
    feedback?: ToolFeedback;
    /** the built-in `answer` tool already added these to the run's answer set — the loop must not re-add them */
    answerManaged?: boolean;
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
    // Bind `window.ml.answer` to THIS run's set for the duration of the tool call (an approved exec that calls
    // ml.answer resolves it; outside a run it throws). Save/restore for nested runs.
    const prevAnswer = activeAnswer;
    if (ctx?.answer) activeAnswer = ctx.answer;
    // Drive `agent_api_docs`'s burst-scoped dedup: a NON-docs tool call is a step away from the dig, so count
    // it, and once the model has moved on (past the leniency) purge what it was shown so a later re-pull re-reads
    // definitions fresh. The docs tool itself resets `sinceDocs` when it runs (it's the streak).
    if (ctx?.docsMemory && tool.name !== "agent_api_docs" && ++ctx.docsMemory.sinceDocs > DOCS_STREAK_LENIENCY) {
        ctx.docsMemory.shown.clear();
    }
    try {
        const raw = await tool.run(args, ctx);
        // A tool may return a plain string, or { content, elements, image?, render?, renderIn? } to
        // also hand back real DOM nodes / a screenshot (routed to onStep/the transcript, never the model).
        if (raw && typeof raw === "object" && typeof (raw as ToolResult).content === "string") {
            const r = raw as ToolResult;
            return { result: r.content + note, elements: r.elements, answerMedia: r.answerMedia, answerManaged: r.answerManaged, image: r.image, imageLabel: r.imageLabel, images: r.images, render: r.render, renderIn: r.renderIn, cdpClick: r.cdpClick, cdpExec: r.cdpExec, cdpShadowClick: r.cdpShadowClick, cdpType: r.cdpType, feedback: r.feedback };
        }
        return { result: String(raw) + note };
    } catch (e) { return { result: `Error: ${errText(e)}` + note }; }
    finally { activeAnswer = prevAnswer; }
}
