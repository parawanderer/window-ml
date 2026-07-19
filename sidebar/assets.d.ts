// esbuild loads `.css` imports as text (see build.mjs `loader`), so the
// highlight.js theme files import as strings we inject into the shadow root.
declare module "*.css" {
    const content: string;
    export default content;
}

// Standalone js-beautify build (no @types for the deep path).
declare module "js-beautify/js/lib/beautify.js" {
    export function js_beautify(source: string, opts?: Record<string, unknown>): string;
}
