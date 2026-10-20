// mermaid-block.ts — what `markdown()` emits for a ```mermaid fence: the finished diagram when it was drawn before, the
// fence as pending code when not. Pure and import-light, because format.ts imports it; the drawing itself is
// mermaid-client.ts, which fills the cache this reads.

/** Escape text for HTML: the source goes into the page as code, and the error into a note. format.ts has its own; this
 *  one is local so the two modules do not import each other. */
const escapeHtml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A finished drawing, or why there is none. */
export type MermaidResult = { svg: string; w: number; h: number } | { error: string };

/** The longest diagram source sent to be drawn: a fence past it stays code with a note. Mermaid's parse is the cost a
 *  model's text (or anything that reaches the frame) could otherwise make unbounded. */
export const MAX_SRC = 20_000;
/** The largest SVG shown, in characters: it goes into the page as a `data:` URL and the cache keeps 200 of them. */
export const MAX_SVG = 500_000;
/** The largest width or height an `<img>` is given, in CSS pixels. */
export const MAX_DIM = 20_000;

/** Why a drawing cannot be shown as it came back, or null when it can: positive, finite dimensions within `MAX_DIM`,
 *  an SVG body within `MAX_SVG`. Checked where an answer is taken (mermaid-client.ts) and again where the `<img>` is
 *  built, since the cache is shared. */
export function undrawable(r: { svg: string; w: number; h: number }): string | null {
    const dim = (v: number) => Number.isFinite(v) && v > 0 && v <= MAX_DIM;
    if (!dim(r.w) || !dim(r.h)) return "the drawing came back without a usable size";
    if (r.svg.length > MAX_SVG) return "the drawing is too large to show";
    return null;
}

// state: cache (finished drawings by theme + source; rebuilt by asking the frame again, and lost with the page)
export const done = new Map<string, MermaidResult>();
// state: ui (the sources a person switched to their text with the toggle; a re-rendering keeps their choice)
export const showingSource = new Set<string>();

/** The cache key: the theme and the source, since a diagram is drawn in the page's colours. */
export const keyOf = (src: string, dark: boolean): string => `${dark ? "d" : "l"}:${src}`;

/** Whether the page is drawn dark: `data-theme` on the root, dark when absent (sidebar.css's default). */
export const pageIsDark = (): boolean =>
    typeof document === "undefined" || document.documentElement.dataset.theme !== "light";

/** A finished drawing of `src` in the page's current theme, if one was made already. Never starts one. */
export function mermaidCached(src: string, dark = pageIsDark()): MermaidResult | undefined {
    return done.get(keyOf(src, dark));
}

/** The source of a ```mermaid fence as `markdown()` should draw it: finished if the cache has it, pending if not. */
export function mermaidBlock(src: string): string {
    const code = `<pre class="code mmd-src"${showingSource.has(src) ? "" : " data-mmd-hide"}><code class="hljs">${escapeHtml(src)}</code></pre>`;
    const r = shown(mermaidCached(src));
    if (!r) return `<div class="mmd" data-mmd="pending">${code.replace(" data-mmd-hide", "")}</div>`;
    if ("error" in r) return `<div class="mmd" data-mmd="error">${code.replace(" data-mmd-hide", "")}${noteHtml(r.error)}</div>`;
    return `<div class="mmd" data-mmd="done"${showingSource.has(src) ? " data-mmd-source" : ""}>${toolsHtml(showingSource.has(src))}${imgHtml(r)}${code}</div>`;
}

/** A ```mermaid fence in a STATIC document (the PDF's HTML): the drawing alone, with nothing to click, since nothing
 *  there runs; its code with the note when it could not be drawn, or plain code when it was never drawn. `dark` picks
 *  the drawing made in that theme, which the caller asks for first (`renderMermaid`). */
export function mermaidStatic(src: string, dark: boolean): string {
    const code = `<pre class="code mmd-src"><code class="hljs">${escapeHtml(src)}</code></pre>`;
    const r = shown(mermaidCached(src, dark));
    if (!r) return code;
    if ("error" in r) return `<div class="mmd" data-mmd="error">${code}${noteHtml(r.error)}</div>`;
    return `<div class="mmd" data-mmd="done">${imgHtml(r)}</div>`;
}

/** A cached result as it may be shown: a drawing `undrawable` refuses becomes its error. */
function shown(r: MermaidResult | undefined): MermaidResult | undefined {
    if (!r || "error" in r) return r;
    const why = undrawable(r);
    return why ? { error: why } : r;
}

const noteHtml = (error: string): string => `<div class="mmd-note">Couldn't draw this diagram: ${escapeHtml(error)}</div>`;
const imgHtml = (r: { svg: string; w: number; h: number }): string =>
    `<img class="mmd-img" alt="Diagram" width="${r.w}" height="${r.h}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.svg)}">`;
const toolsHtml = (source: boolean): string =>
    `<div class="mmd-tools"><button type="button" class="mmd-btn" data-mmd-act="toggle" aria-label="${source ? "Show the diagram" : "Show the diagram's source"}">${source ? "diagram" : "source"}</button>` +
    `<button type="button" class="mmd-btn" data-mmd-act="copy" aria-label="Copy the diagram's source">copy</button></div>`;

