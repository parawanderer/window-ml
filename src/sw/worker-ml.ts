// worker-ml.ts — the `ml` the service worker assembles a run with: the part of `window.ml` that `assembleRun` reads,
// answered by the worker's own functions instead of by messages from a page.
//
// It exists so a run the USER starts is assembled in the worker and not in the page it will act on
// (docs/spec/SITE_ACCESS.md, slice 0), by the SAME code a page uses for a console `ml.agent()` (run-assembly.ts).
// Its tool factories are the page's factories: building a tool needs no DOM (it is a name, a schema and a closure),
// so the descriptors the model is shown, approval flags included, come from one definition. A builtin tool's `run` is
// never called here: the page that hosts the run executes it, under the toolset `_adoptRun` registers there. The one
// exception is a REMOTE tool, whose `run` calls the backend and so runs in the worker (sw-local-tools.ts).

import type { AssemblyMl } from "../run-assembly";
import { modelFilterAllows, publicConfig } from "../contract/contract-config";
import type { MlApi } from "../contract";
import { defineTool, lookTool, locateTool, navigateTool, fetchTool, clickTool, typeTool, pythonTool, chatMetaTool } from "../ml-tool-factories";
import { _resolveVisionModel, _modelSees, _nativeLookTool, ocrRequest } from "../ml-vision";
import { getConfig, modelCapabilities, listAvailableModels, listServerTools, fetchLLM } from "./sw-llm";
import { executeServerTool, serverToolResult } from "./sw-tools";
import { makeDomTools } from "../tools";

/**
 * Build the worker's `ml` for assembling one run on a tab.
 * @param tabUrl the tab's URL as the browser reports it (`chrome.tabs`), for the one config field that depends on the
 *   page (`pageApprovalAllowed`)
 * @returns an `ml` that `assembleRun` accepts, plus the Commander kit's factories and the one tool body that does run
 *   here: a remote tool's call to the backend (`execServerTool`)
 */
export function workerMl(tabUrl: string): WorkerMl {
    const ml = {
        defineTool,
        domTools: makeDomTools(defineTool),
        config: async () => publicConfig(await getConfig(), tabUrl),
        capabilities: async (model: string) => modelCapabilities(await getConfig(), model),
        // What `ml.models()` answers a page: the server's list, through the model filter.
        models: async () => {
            const [{ ids }, cfg] = await Promise.all([listAvailableModels(), getConfig()]);
            return ids.filter((m) => modelFilterAllows(m, cfg.modelFilter));
        },
        serverTools: () => listServerTools(),
        read: async (image: string | HTMLImageElement, opts: { model?: string | null; prompt?: string | null; numCtx?: number | null } = {}) => {
            const r = await fetchLLM(ocrRequest(await ml._imageToDataUrl(image), opts));
            return String((r as { content?: string | null }).content || "").trim();
        },
        // Composer attachments reach the worker already sanitised to data URLs; nothing else is a valid image here.
        _imageToDataUrl: async (image: string | HTMLImageElement) => {
            if (typeof image === "string" && image.startsWith("data:")) return image;
            throw new Error("the worker can only take an image as a data URL");
        },
        _resolveVisionModel, _modelSees, _nativeLookTool,
        lookTool, locateTool, navigateTool, fetchTool, clickTool, typeTool, pythonTool, chatMetaTool,
        // A REMOTE tool of a run the worker built runs here, not in the page (sw-local-tools.ts): the page would have
        // to read the backend's tool list to build it, and its arguments leave the machine. Its `run` is the page's
        // own (buildServerTools), calling this instead of the SERVER_TOOL_EXEC message.
        execServerTool: async (toolId: string, name: string, args: Record<string, unknown> = {}, { onOutput, signal }: { onOutput?: (text: string, ts?: number) => void; signal?: AbortSignal } = {}) =>
            serverToolResult(await executeServerTool({
                toolId, name, args, signal,
                // Only OUTPUT frames are text: an `event` frame is structural, the same filter ml-server.ts applies.
                onFrame: onOutput ? (frame, at) => { if (frame.type === "output") onOutput(String((frame as { text?: unknown }).text ?? ""), at); } : undefined,
            })),
    };
    return ml as unknown as WorkerMl;
}

/** The worker's `ml`: what assembly reads, the Commander kit's factories, and a remote tool's backend call. */
export type WorkerMl = AssemblyMl & Pick<MlApi, "capabilities" | "_modelSees" | "clickTool" | "typeTool" | "pythonTool" | "chatMetaTool" | "execServerTool">;
