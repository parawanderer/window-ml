// bundle.mjs — the bench's pages as code: the dashboard (app.tsx) and a run page's lane (run-lane.tsx), each bundled by
// esbuild into one script string, in memory, the first time it is asked for. Plus the stylesheet that goes with them.
// No dist and no build step to forget: the page is built from the source that is checked out, every time the bench runs.

import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const cache = new Map();

/** One entry, bundled as an IIFE with Preact's JSX, minified; built once per process. */
function bundle(entry) {
    if (!cache.has(entry)) {
        const out = buildSync({
            entryPoints: [path.join(HERE, entry)], bundle: true, write: false, format: "iife", platform: "browser",
            jsx: "automatic", jsxImportSource: "preact", minify: true, target: "es2020", logLevel: "silent",
            // `<` inside a string literal would let a `</script>` close the inline tag the bundle is shipped in.
            charset: "utf8",
        });
        cache.set(entry, out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
    }
    return cache.get(entry);
}

/** The dashboard's script. */
export const appScript = () => bundle("app.tsx");
/** The script that draws a run's lane on its own page. */
export const runLaneScript = () => bundle("run-lane.tsx");

/** The sidebar's stylesheet, the source of the lane's rules and of both themes' colours. */
export const sidebarCss = () => readFileSync(path.join(ROOT, "src/sidebar/sidebar.css"), "utf8");

/**
 * The dashboard's stylesheet: the sidebar's colour tokens for both themes (following the system unless the page's
 * toggle set `data-theme`), the lane's rules from sidebar.css, and the page's own layout (page.css).
 */
export async function appCss() {
    const { themeVars, laneCss } = await import("../../../../src/sidebar/resource/lane-static.ts");
    const css = sidebarCss();
    const { dark, light } = themeVars(css);
    return [
        `:root{${dark}}`,
        `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${light}}}`,
        `:root[data-theme="light"]{${light}}`,
        laneCss(css, { scoped: false }),
        readFileSync(path.join(HERE, "page.css"), "utf8"),
    ].join("\n");
}
