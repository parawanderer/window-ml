// The two debug-render slots for one agent tool step, each derived from its OWN hook. Extracted from
// ml.agent so BOTH the page-side loop (injected.ts) and design A's page-side delegation handler
// (run-delegation.ts, which runs the tool on behalf of the background loop) compute them identically —
// otherwise a background-hosted run would fall back to raw JSON (no rendered view).
//
//  · In  = a visualization of the CALL — a run()-returned `renderIn` wins, else the tool's
//          `render(input, args)` method (page-side, defensive: throw → fall back to raw args).
//  · Out = a visualization of the RESULT — a run()-returned `render` wins, else an auto-derived
//          image / elements descriptor from the envelope.
// Either may be undefined → the sidebar renders that block's raw view. Page-side (touches Element/DOM).
import type { MlTool, RenderDescriptor, ToolRenderInput } from "./contract";
import { clickSelector, truncate } from "./dom";

export function descriptorFor(
    tool: MlTool | undefined,
    input: ToolRenderInput,
    args: Record<string, unknown>,
): { in?: RenderDescriptor; out?: RenderDescriptor } {
    let inD: RenderDescriptor | undefined;
    if (input.renderIn && input.renderIn.type) inD = input.renderIn;   // run() precomputed the In (e.g. python's cell header)
    else if (tool?.render) {
        try { const d = tool.render(input, args); if (d && d.type) inD = d; }   // the render() method (e.g. exec's pretty JS)
        catch (e) { console.error(`ml tool "${tool.name}" render threw:`, e); }
    }
    let outD: RenderDescriptor | undefined;
    if (input.render && input.render.type) outD = input.render;   // run() precomputed the Out (e.g. locate's marks)
    else if (input.image) outD = { type: "image", src: input.image, label: input.imageLabel };
    else if (input.elements?.length) outD = {
        type: "elements",
        // Use clickSelector — the SAME stateless currency the tools hand the model in their text
        // output (click/type/answer take it) — so the rendered list PAIRS with what the model sees,
        // and "copy reference" / hover-highlight resolve the same node. NOT elPath (a full path that
        // wouldn't match), and no `index`: clickSelector is unique, so the reference is a bare
        // querySelector and the display badge falls back to the array position.
        items: input.elements.slice(0, 50).map((el: Node) => ({
            path: (typeof Element !== "undefined" && el instanceof Element) ? clickSelector(el) : String(el.nodeName || "node"),
            text: truncate((el as Element).textContent || "", 60),
        })),
    };
    return { in: inD, out: outD };
}
