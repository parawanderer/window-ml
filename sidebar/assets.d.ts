// esbuild loads `.css` imports as text (see build.mjs `loader`), so the
// highlight.js theme files import as strings we inject into the shadow root.
declare module "*.css" {
    const content: string;
    export default content;
}
