// Build the extension into dist/ — the loadable (unpacked) output.
// esbuild compiles/bundles each entry to a classic IIFE (content scripts and the
// injected main-world script can't be ES modules), and we copy the static assets
// + manifest alongside. `node build.mjs` for a one-shot; `--watch` to rebuild.
//
// The core (injected/content/background/popup) has no runtime deps and compiles
// to plain JS; the sidebar/ entry may pull in bundled deps (e.g. a highlighter).
import * as esbuild from "esbuild";
import { cpSync, rmSync, mkdirSync } from "node:fs";

// output name (dist/<name>.js)  ->  source entry
const ENTRIES = {
    injected: "injected.ts",
    content: "content.js",
    background: "background.js",
    popup: "popup.js",
    sidebar: "sidebar/sidebar.js",
};

// [source, dist-relative dest] — copied verbatim next to the bundles.
const ASSETS = [
    ["manifest.json", "manifest.json"],
    ["popup.html", "popup.html"],
    ["sidebar/sidebar.html", "sidebar.html"],
    ["sidebar/sidebar.css", "sidebar.css"],
];

const watch = process.argv.includes("--watch");

const buildOpts = {
    entryPoints: ENTRIES,
    outdir: "dist",
    bundle: true,
    format: "iife",      // classic scripts — required for content/injected scripts
    target: ["chrome114"],
    logLevel: "info",
};

function copyAssets() {
    for (const [src, dst] of ASSETS) cpSync(src, `dist/${dst}`);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

if (watch) {
    const ctx = await esbuild.context({
        ...buildOpts,
        plugins: [{
            name: "copy-assets",
            setup(b) { b.onEnd(() => copyAssets()); },
        }],
    });
    await ctx.watch();
    console.log("watching… (dist/)");
} else {
    await esbuild.build(buildOpts);
    copyAssets();
    console.log("built dist/");
}
