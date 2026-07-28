// Build the extension into dist/ — the loadable (unpacked) output.
// esbuild compiles/bundles each entry to a classic IIFE (content scripts and the
// injected main-world script can't be ES modules), and we copy the static assets
// + manifest alongside. `node build.mjs` for a one-shot; `--watch` to rebuild.
//
// The core (injected/content/background/popup) has no runtime deps and compiles
// to plain JS; the sidebar/ entry may pull in bundled deps (e.g. a highlighter).
import * as esbuild from "esbuild";
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { generatePreview } from "./tools/preview-annotate.mjs";

// output name (dist/<name>.js)  ->  source entry
const ENTRIES = {
    injected: "injected.ts",
    content: "content.ts",
    background: "background.ts",
    popup: "popup.ts",
    // Offscreen document hosting the Pyodide runtime for the python_exec tool.
    offscreen: "offscreen.ts",
    // Content-script shell (hosts the iframe) + the Preact app that runs inside
    // the sidebar.html iframe.
    "sidebar-shell": "sidebar/shell.ts",
    "sidebar-app": "sidebar/app.tsx",
    // Optional DevTools panel: a second surface for the same app. `devtools` registers
    // the panel; `panel` hosts the app iframe and relays the debug stream from the
    // background (see sidebar/panel.ts).
    "devtools": "sidebar/devtools.ts",
    "panel": "sidebar/panel.ts",
};

// [source, dist-relative dest] — copied verbatim next to the bundles.
const ASSETS = [
    ["manifest.json", "manifest.json"],
    ["popup.html", "popup.html"],
    ["sidebar/sidebar.html", "sidebar.html"],
    ["sidebar/sidebar.css", "sidebar.css"],
    ["sidebar/devtools.html", "devtools.html"],
    ["sidebar/panel.html", "panel.html"],
    ["offscreen.html", "offscreen.html"],
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

// Offline python_exec runtime → dist/pyodide/: the Pyodide CORE (from the `pyodide` npm
// devDep) + the numpy/Pillow wheels (from `npm run fetch-pyodide`, which the npm package
// doesn't ship). All optional — a missing piece just means the python_exec tool won't
// load; nothing else breaks. Copied once (not per watch-rebuild — it's ~17 MB static).
const PYODIDE_CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
function copyPyodide() {
    if (!existsSync("node_modules/pyodide")) { console.warn("⚠ pyodide not installed — python_exec disabled (npm i)."); return; }
    mkdirSync("dist/pyodide", { recursive: true });
    for (const f of PYODIDE_CORE) cpSync(`node_modules/pyodide/${f}`, `dist/pyodide/${f}`);
    if (existsSync("pyodide-wheels")) {
        for (const w of readdirSync("pyodide-wheels")) cpSync(`pyodide-wheels/${w}`, `dist/pyodide/${w}`);
    } else {
        console.warn("⚠ pyodide-wheels/ missing — run `npm run fetch-pyodide` to enable python_exec (numpy/Pillow).");
    }
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

if (watch) {
    const copyPlugin = { name: "copy-assets", setup(b) { b.onEnd(() => copyAssets()); } };
    const coreCtx = await esbuild.context({ ...base, entryPoints: coreEntries, plugins: [copyPlugin] });
    const sidebarCtx = await esbuild.context({ ...base, entryPoints: { "sidebar-app": sidebarApp }, minify: true, plugins: [copyPlugin] });
    await coreCtx.watch();
    await sidebarCtx.watch();
    copyPyodide();   // once — static, not worth recopying on every rebuild
    console.log("watching… (dist/)");
} else {
    await esbuild.build({ ...base, entryPoints: coreEntries });
    await esbuild.build({ ...base, entryPoints: { "sidebar-app": sidebarApp }, minify: true });
    // Standalone CJS builds for node unit tests (the same modules are bundled into
    // injected.js via their imports): the read-only exec interpreter + the
    // Set-of-Marks hit-test engine.
    await esbuild.build({ entryPoints: { "readonly-exec": "readonly-exec.ts" }, outdir: "dist", bundle: true, format: "cjs", platform: "node", logLevel: "info" });
    await esbuild.build({ entryPoints: { "som": "som.ts" }, outdir: "dist", bundle: true, format: "cjs", platform: "node", logLevel: "info" });
    // The python_exec runtime (PRELUDE + wrapUserCode) — bundled standalone so tests/python.test.js
    // exercises the EXACT script the offscreen sandbox runs against real CPython (Pyodide-in-Node).
    await esbuild.build({ entryPoints: { "python-runtime": "python-runtime.ts" }, outdir: "dist", bundle: true, format: "cjs", platform: "node", logLevel: "info" });
    copyAssets();
    copyPyodide();
    // Regenerate the standalone visual preview of som's canvas annotate() (gitignored —
    // it's a build artifact). Open tools/annotate-preview.html to eyeball label placement.
    await generatePreview();
    console.log("built dist/ (+ tools/annotate-preview.html)");
}
