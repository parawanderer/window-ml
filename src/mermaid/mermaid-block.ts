// mermaid-block.ts — what `markdown()` emits for a ```mermaid fence: the finished diagram when it was drawn before, the
// fence as pending code when not. Pure and import-light, because format.ts imports it; the drawing itself is
// mermaid-client.ts, which fills the cache this reads.

/** Escape text for HTML: the source goes into the page as code, and the error into a note. format.ts has its own; this
 *  one is local so the two modules do not import each other. */
const escapeHtml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A finished drawing, or why there is none. */
export type MermaidResult = { svg: string; w: number; h: number } | { error: string };

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
    const r = mermaidCached(src);
    if (!r) return `<div class="mmd" data-mmd="pending">${code.replace(" data-mmd-hide", "")}</div>`;
    if ("error" in r) return `<div class="mmd" data-mmd="error">${code.replace(" data-mmd-hide", "")}${noteHtml(r.error)}</div>`;
    return `<div class="mmd" data-mmd="done"${showingSource.has(src) ? " data-mmd-source" : ""}>${toolsHtml(showingSource.has(src))}${imgHtml(r)}${code}</div>`;
}

const noteHtml = (error: string): string => `<div class="mmd-note">Couldn't draw this diagram: ${escapeHtml(error)}</div>`;
const imgHtml = (r: { svg: string; w: number; h: number }): string =>
    `<img class="mmd-img" alt="Diagram" width="${r.w}" height="${r.h}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.svg)}">`;
const toolsHtml = (source: boolean): string =>
    `<div class="mmd-tools"><button type="button" class="mmd-btn" data-mmd-act="toggle" aria-label="${source ? "Show the diagram" : "Show the diagram's source"}">${source ? "diagram" : "source"}</button>` +
    `<button type="button" class="mmd-btn" data-mmd-act="copy" aria-label="Copy the diagram's source">copy</button></div>`;

