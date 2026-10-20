// mermaid-frame.ts — draws a Mermaid diagram as SVG, inside the sandboxed mermaid.html, for the page of its own origin
// that framed it.
//
// The model writes the diagram source, so it is hostile input to a large parser that builds DOM: it runs here, in an
// opaque origin with no extension APIs and no access to the page that asked (src/mermaid/mermaid-client.ts). The answer
// is a string of SVG, which the asker shows as an `<img>`, where no script in it can run. `securityLevel: "strict"`
// also strips script, event handlers and `click` callbacks from what Mermaid emits, and `htmlLabels: false` keeps the
// labels SVG text rather than `foreignObject` HTML, which an `<img>` would draw without the fonts measured here.
//
// WHO MAY ASK. mermaid.html is a web-accessible resource (the overlay is an extension frame inside a web page, and
// Chrome refuses it a nested extension frame otherwise), so ANY page can frame it, and a page that does is its
// `parent`. So `e.source === parent` says nothing. What a framer cannot choose is its origin, and the browser reports
// it in `location.ancestorOrigins`: this frame answers only when the window that framed it has the frame's own origin
// (the extension, the web app's server, the phone's `file:`), and says nothing at all otherwise, not even "ready".
import mermaid from "mermaid";
import { MAX_SRC } from "./mermaid-block";

/** One request: the diagram source and the theme to draw it in. */
interface Ask { mmd: "render"; id: number; src: string; dark: boolean }

/** The font stack measured here and drawn by the `<img>`: system fonts only, since an image loads no web font. */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** The origin this frame was loaded from, as `ancestorOrigins` writes it. */
const own = new URL(location.href).origin;
/** How a `file:` framer is reported: "file://", or "null" where file pages get an opaque origin (Android's WebView).
 *  Accepting "null" there is safe only because nothing else can frame a `file:` URL: a web page may not, and the
 *  phone's WebView loads nothing outside the page's own directory (mobile/src/embed.tsx). */
const FILE_FRAMERS = ["file://", "null"];
/** Whether the window that framed this one is of that origin. Absent `ancestorOrigins` refuses: there is no proof. */
const framer = location.ancestorOrigins?.[0];
const framedByOwn = framer !== undefined && (location.protocol === "file:" ? FILE_FRAMERS.includes(framer) : framer === own);
/** Where answers go: the framer's origin, never "*". A `file:` origin cannot be named as a target, and there the
 *  framer was already checked to be a `file:` page. */
const answerTo = location.protocol === "file:" ? "*" : own;

let theme: "dark" | "default" | null = null;   // state: plumbing (the theme Mermaid was last initialised with)
let n = 0;   // state: plumbing (element ids for mermaid.render)
let queue: Promise<void> = Promise.resolve();   // state: plumbing (one drawing at a time: the next waits on this)

/** Give the SVG an intrinsic size from its viewBox: Mermaid writes `width="100%"`, which an `<img>` reads as unsized. */
function sized(svg: string): { svg: string; w: number; h: number } {
    const vb = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
    const w = vb ? Math.ceil(+vb[1]) : 0, h = vb ? Math.ceil(+vb[2]) : 0;
    if (!w || !h) return { svg, w, h };
    const out = svg.replace(/<svg([^>]*?)\swidth="[^"]*"/, "<svg$1").replace(/<svg([^>]*?)\sstyle="[^"]*"/, "<svg$1")
        .replace(/<svg/, `<svg width="${w}" height="${h}"`);
    return { svg: out, w, h };
}

/** Draw one diagram and answer it. Never two at once: each waits for the one before (`queue`). */
async function draw(ask: Ask): Promise<void> {
    if (ask.src.length > MAX_SRC) {
        parent.postMessage({ mmd: "done", id: ask.id, error: `it is longer than ${MAX_SRC.toLocaleString("en")} characters` }, answerTo);
        return;
    }
    const want = ask.dark ? "dark" : "default";
    if (want !== theme) {
        theme = want;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: FONT, htmlLabels: false, flowchart: { htmlLabels: false } });
    }
    try {
        const { svg } = await mermaid.render(`mmd-${++n}`, ask.src);
        parent.postMessage({ mmd: "done", id: ask.id, ...sized(svg) }, answerTo);
    } catch (err) {
        const msg = String((err as Error)?.message || err).split("\n")[0].slice(0, 200);
        parent.postMessage({ mmd: "done", id: ask.id, error: msg || "not a diagram Mermaid can draw" }, answerTo);
    }
}

if (framedByOwn) {
    addEventListener("message", (e: MessageEvent) => {
        if (e.source !== parent) return;
        const ask = e.data as Ask;
        if (!ask || ask.mmd !== "render" || typeof ask.id !== "number" || typeof ask.src !== "string") return;
        queue = queue.then(() => draw(ask));
    });
    parent.postMessage({ mmd: "ready" }, answerTo);
}
