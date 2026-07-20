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
    content: "content.ts",
    background: "background.ts",
    popup: "popup.ts",
    // Content-script shell (hosts the iframe) + the Preact app that runs inside
    // the sidebar.html iframe.
    "sidebar-shell": "sidebar/shell.ts",
    "sidebar-app": "sidebar/app.tsx",
};

// [source, dist-relative dest] — copied verbatim next to the bundles.
const ASSETS = [
    ["manifest.json", "manifest.json"],
    ["popup.html", "popup.html"],
    ["sidebar/sidebar.html", "sidebar.html"],
    ["sidebar/sidebar.css", "sidebar.css"],
];

const watch = process.argv.includes("--watch");

// Core (injected/content/background/popup/sidebar-shell) is left UNminified so
// injected.js stays readable when inspected in devtools. The sidebar app is a
// compiled Preact bundle (not meant to be read) and pulls in highlight.js, so
// it's minified.
const { "sidebar-app": sidebarApp, ...coreEntries } = ENTRIES;
const base = {
    outdir: "dist",
    bundle: true,
    format: "iife",      // classic scripts — required for content/injected scripts
    target: ["chrome114"],
    jsx: "automatic",    // the sidebar entry is Preact TSX
    jsxImportSource: "preact",
    loader: { ".css": "text" },   // import highlight.js theme CSS as a string (injected into the shadow root)
    logLevel: "info",
};

function copyAssets() {
    for (const [src, dst] of ASSETS) cpSync(src, `dist/${dst}`);
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

if (watch) {
    const copyPlugin = { name: "copy-assets", setup(b) { b.onEnd(() => copyAssets()); } };
    const coreCtx = await esbuild.context({ ...base, entryPoints: coreEntries, plugins: [copyPlugin] });
    const sidebarCtx = await esbuild.context({ ...base, entryPoints: { "sidebar-app": sidebarApp }, minify: true, plugins: [copyPlugin] });
    await coreCtx.watch();
    await sidebarCtx.watch();
    console.log("watching… (dist/)");
} else {
    await esbuild.build({ ...base, entryPoints: coreEntries });
    await esbuild.build({ ...base, entryPoints: { "sidebar-app": sidebarApp }, minify: true });
    // Standalone CJS build of the read-only exec interpreter, for node unit tests
    // (the same module is bundled into injected.js via its import).
    await esbuild.build({ entryPoints: { "readonly-exec": "readonly-exec.ts" }, outdir: "dist", bundle: true, format: "cjs", platform: "node", logLevel: "info" });
    copyAssets();
    console.log("built dist/");
}
