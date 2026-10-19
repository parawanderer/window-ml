// mermaid-frame.ts — draws a Mermaid diagram as SVG, inside the sandboxed mermaid.html, for whoever framed it.
//
// The model writes the diagram source, so it is hostile input to a large parser that builds DOM: it runs here, in an
// opaque origin with no extension APIs and no access to the page that asked (src/mermaid/mermaid-client.ts). The answer
// is a string of SVG, which the asker shows as an `<img>`, where no script in it can run. `securityLevel: "strict"`
// also strips script, event handlers and `click` callbacks from what Mermaid emits, and `htmlLabels: false` keeps the
// labels SVG text rather than `foreignObject` HTML, which an `<img>` would draw without the fonts measured here.
import mermaid from "mermaid";

/** One request: the diagram source and the theme to draw it in. */
interface Ask { mmd: "render"; id: number; src: string; dark: boolean }

/** The font stack measured here and drawn by the `<img>`: system fonts only, since an image loads no web font. */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

let theme: "dark" | "default" | null = null;   // state: plumbing (the theme Mermaid was last initialised with)
let n = 0;   // state: plumbing (element ids for mermaid.render)

/** Give the SVG an intrinsic size from its viewBox: Mermaid writes `width="100%"`, which an `<img>` reads as unsized. */
function sized(svg: string): { svg: string; w: number; h: number } {
    const vb = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
    const w = vb ? Math.ceil(+vb[1]) : 0, h = vb ? Math.ceil(+vb[2]) : 0;
    if (!w || !h) return { svg, w, h };
    const out = svg.replace(/<svg([^>]*?)\swidth="[^"]*"/, "<svg$1").replace(/<svg([^>]*?)\sstyle="[^"]*"/, "<svg$1")
        .replace(/<svg/, `<svg width="${w}" height="${h}"`);
    return { svg: out, w, h };
}

addEventListener("message", async (e: MessageEvent) => {
    // Only the page that framed this one: anything else that can reach this window is not an asker.
    if (e.source !== parent) return;
    const ask = e.data as Ask;
    if (!ask || ask.mmd !== "render" || typeof ask.id !== "number" || typeof ask.src !== "string") return;
    const want = ask.dark ? "dark" : "default";
    if (want !== theme) {
        theme = want;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: FONT, htmlLabels: false, flowchart: { htmlLabels: false } });
    }
    try {
        const { svg } = await mermaid.render(`mmd-${++n}`, ask.src);
        parent.postMessage({ mmd: "done", id: ask.id, ...sized(svg) }, "*");
    } catch (err) {
        const msg = String((err as Error)?.message || err).split("\n")[0].slice(0, 200);
        parent.postMessage({ mmd: "done", id: ask.id, error: msg || "not a diagram Mermaid can draw" }, "*");
    }
});
parent.postMessage({ mmd: "ready" }, "*");
