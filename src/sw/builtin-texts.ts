// builtin-texts.ts — the extension's own description and parameters for each builtin tool, put in place of a page's, so
// a tool named like one of ours reads to the model as ours, whatever the page wrote for it.
//
// docs/spec/SITE_ACCESS_SLICE3.md, S2 (owner, 2026-10-14). A page-built run sends its tools as descriptors it wrote,
// and the model reads their texts verbatim. A tool named like a builtin always uses the extension's text; a site's own
// tool keeps its text, which the start card shows as the site's own words (`siteToolTexts`). The texts come from the
// same factories the worker builds a person's run with (worker-ml.ts), transformed as `assembleRun` transforms them.

import type { MlTool, JsonSchema } from "../contract";
import type { StartRunPayload } from "../contract/contract-messages";
import { isBuiltinTool } from "../tools/tool-registry";
import { withToolDetails } from "../tools/tool-details";
import { CITABLE_TOOLS, citeParam, withCallTitle } from "../tools/tool-params";
import { buildDereferenceTool } from "../tools/tools";
import { workerMl } from "./worker-ml";

/** The name of the docs tool, whose presence shortens every tool's details. */
const DOCS_TOOL = ["agent", "api", "docs"].join("_");

/** One tool's text the model reads. */
interface ToolText { description: string; parameters?: JsonSchema }

/**
 * The extension's own text for each builtin it can build here, for a run with these facts.
 * @param url the page's URL (the worker's `ml` reads its config for it)
 * @param facts `crossOrigin` (navigate's text names it), `toolTokens` (a citable tool's `token` parameter), and whether
 *   the run has `agent_api_docs` (which shortens the details every tool's description carries)
 * @returns name → text
 */
export function builtinTexts(url: string, facts: { crossOrigin?: boolean; docs?: boolean; toolTokens?: boolean }): Map<string, ToolText> {
    const ml = workerMl(url) as unknown as Record<string, (...a: unknown[]) => MlTool> & { domTools: MlTool[]; defineTool: (t?: Partial<MlTool>) => MlTool };
    const tools: MlTool[] = [...ml.domTools];
    const build = (name: string, ...args: unknown[]): void => { try { tools.push(ml[name].call(ml, ...args)); } catch { /* not buildable here: its text stays the page's, shown as the site's */ } };
    build("lookTool"); build("locateTool"); build("clickTool"); build("typeTool"); build("navigateTool", { crossOrigin: !!facts.crossOrigin });
    build("fetchTool"); build("pythonTool"); build("chatMetaTool");
    try { tools.push(buildDereferenceTool(ml.defineTool)); } catch { /* as above */ }
    // Only its presence matters to `withToolDetails`: a stand-in, not a tool (check-tools would read a literal name as a factory).
    const named = facts.docs ? [...tools, Object.fromEntries([["name", DOCS_TOOL], ["description", ""]]) as unknown as MlTool] : tools;
    const out = new Map<string, ToolText>();
    for (const t of withToolDetails(named)) {
        if (!t?.name || !t.description || !isBuiltinTool(t.name) || out.has(t.name)) continue;
        const params = facts.toolTokens && CITABLE_TOOLS.has(t.name)
            ? { ...t.parameters, properties: { ...(t.parameters as { properties?: Record<string, unknown> }).properties, token: citeParam("the pricing table") } } as JsonSchema
            : t.parameters;
        out.set(t.name, { description: t.description, parameters: withCallTitle(params) });
    }
    return out;
}

/**
 * A page's START_RUN tools with every builtin-named one given the extension's own description, and each parameter the
 * extension's schema has given its description; a parameter only the page's schema has loses its description. The
 * schema's shape stays the page's (the page runs the tool), so a call still validates.
 * @param tools the page's descriptors
 * @param texts the extension's texts (`builtinTexts`)
 * @returns new descriptors
 */
export function withOurTexts(tools: StartRunPayload["tools"], texts: Map<string, ToolText>): StartRunPayload["tools"] {
    return tools.map((t) => {
        const ours = t && !t.remote ? texts.get(t.name) : undefined;
        if (!ours) return t;
        return { ...t, description: ours.description, parameters: describeAs(t.parameters, ours.parameters) as JsonSchema };
    });
}

/** A schema with each `description` taken from the same place in `ours`, and dropped where `ours` has none. */
function describeAs(page: unknown, ours: unknown): unknown {
    if (Array.isArray(page)) return page.map((v, i) => describeAs(v, Array.isArray(ours) ? ours[i] : undefined));
    if (!page || typeof page !== "object") return page;
    const o = ours && typeof ours === "object" && !Array.isArray(ours) ? ours as Record<string, unknown> : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(page as Record<string, unknown>)) {
        if (k === "description" || k === "title") { if (typeof o[k] === "string") out[k] = o[k]; continue; }
        out[k] = describeAs(v, o[k]);
    }
    return out;
}

/**
 * The texts of a run's tools that are the site's own (every tool whose text is not the extension's, and that is not a
 * server tool), quoted on the start card with the site's other instructions.
 * @param tools the run's descriptors, after `withOurTexts`
 * @param texts the extension's texts it used
 * @returns the text, empty when there is none
 */
export function siteToolTexts(tools: StartRunPayload["tools"], texts: Map<string, ToolText>): string {
    return tools.filter((t) => t && !t.remote && !texts.has(t.name)).map((t) => {
        let params = "";
        try { params = JSON.stringify(t.parameters ?? {}); } catch { params = ""; }
        return `Tool "${t.name}": ${t.description ?? ""}${params && params !== "{}" ? `\nIts parameters: ${params}` : ""}`;
    }).join("\n\n");
}

/**
 * A run's tools with the extension's texts for its builtins, and the site's own tool texts the card quotes.
 * @param p the run's payload (its tools, `crossOrigin`, `toolTokens`)
 * @param url the page's URL
 * @returns the tools, and the site's tool texts
 */
export function ourToolTexts(p: Pick<StartRunPayload, "tools" | "crossOrigin" | "toolTokens">, url: string): { tools: StartRunPayload["tools"]; siteTools: string } {
    const texts = builtinTexts(url, { crossOrigin: !!p.crossOrigin, toolTokens: !!p.toolTokens, docs: p.tools.some((t) => t?.name === "agent_api_docs") });
    const tools = withOurTexts(p.tools, texts);
    return { tools, siteTools: siteToolTexts(tools, texts) };
}
