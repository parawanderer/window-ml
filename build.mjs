// Build the extension into dist/ — the loadable (unpacked) output.
// esbuild compiles/bundles each entry to a classic IIFE (content scripts and the
// injected main-world script can't be ES modules), and we copy the static assets
// + manifest alongside. `node build.mjs` for a one-shot; `--watch` to rebuild.
//
// The core (injected/content/background/popup) has no runtime deps and compiles
// to plain JS; the sidebar/ entry may pull in bundled deps (e.g. a highlighter).
import * as esbuild from "esbuild";
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import { generatePreview } from "./tools/preview-annotate.mjs";
import { generatePreview as generateLegendPreview } from "./tools/preview-legend.mjs";
import { writeApiDocs } from "./scripts/gen-api-docs.mjs";
import { writeBuildInfo } from "./scripts/gen-build-info.mjs";
import { writeSchema } from "./scripts/gen-export-schema.mjs";

// output name (dist/<name>.js)  ->  source entry
const ENTRIES = {
    injected: "src/injected.ts",
    content: "src/content.ts",
    background: "src/background.ts",
    popup: "src/popup.ts",
    // Tiny MAIN-world, document_start script that captures CLOSED shadow roots (opt-in
    // pierceClosedShadow feature) before page components attach them. See shadow-patch.ts.
    "shadow-patch": "src/shadow-patch.ts",
    // Offscreen document hosting the Pyodide runtime for the python_exec tool, and the
    // dedicated worker it spawns to run Pyodide OFF the shared main thread (keeps the
    // sidebar UI responsive during a long run).
    offscreen: "src/offscreen.ts",
    "python-worker": "src/python-worker.ts",
    // Content-script shell (hosts the iframe) + the Preact app that runs inside
    // the sidebar.html iframe.
    "sidebar-shell": "src/sidebar/shell.ts",
    "sidebar-app": "src/sidebar/app.tsx",
    // Optional DevTools panel: a second surface for the same app. `devtools` registers
    // the panel; `panel` hosts the app iframe and relays the debug stream from the
    // background (see sidebar/panel.ts).
    "devtools": "src/sidebar/devtools.ts",
    "panel": "src/sidebar/panel.ts",
    // Standalone PDF-print tab (window.print() is suppressed inside docked DevTools; a real tab isn't).
    "print": "src/sidebar/print.ts",
};

// [source, dist-relative dest] — copied verbatim next to the bundles.
const ASSETS = [
    ["manifest.json", "manifest.json"],
    ["src/popup.html", "popup.html"],
    ["src/sidebar/sidebar.html", "sidebar.html"],
    ["src/sidebar/sidebar.css", "sidebar.css"],
    ["src/sidebar/devtools.html", "devtools.html"],
    ["src/sidebar/panel.html", "panel.html"],
    ["src/sidebar/print.html", "print.html"],
    ["src/offscreen.html", "offscreen.html"],
];

const watch = process.argv.includes("--watch");

// --outdir <dir> and --define K=V build a VARIANT of the extension somewhere other than dist/. The bench
// uses them to compile an experimental dimension in (see tests/e2e/bench/), so a hypothesis that may well
// conclude "the current design was fine" costs the product no config flag. Default behaviour is unchanged.
function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : null;
}
const OUTDIR = argValue("--outdir") || "dist";
// Built into a STAGING directory and swapped in only once everything succeeded. The old sequence deleted
// the output first and bundled second, so any failure after that point — a typo in a CSS template literal
// was the real one — left `dist/` with no manifest, which Chrome reports as "Failed to load extension" on
// an extension that was working a second ago. A build that fails should change nothing.
// Watch mode keeps writing in place: esbuild rebuilds incrementally there, and swapping a directory out
// from under a browser that has it loaded is the thing being avoided, not a thing to do on every keystroke.
const BUILD_DIR = watch ? OUTDIR : `${OUTDIR}.stage`;
const DEFINES = Object.fromEntries(process.argv
    .map((a, i) => (a === "--define" ? process.argv[i + 1] : null))
    .filter(Boolean)
    .map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));

// Core (injected/content/background/popup/sidebar-shell) is left UNminified so
// injected.js stays readable when inspected in devtools. The sidebar app is a
// compiled Preact bundle (not meant to be read) and pulls in highlight.js, so
// it's minified.
const { "sidebar-app": sidebarApp, ...coreEntries } = ENTRIES;
const base = {
    outdir: BUILD_DIR,
    bundle: true,
    format: "iife",      // classic scripts — required for content/injected scripts
    target: ["chrome114"],
    jsx: "automatic",    // the sidebar entry is Preact TSX
    jsxImportSource: "preact",
    loader: { ".css": "text" },   // import highlight.js theme CSS as a string (injected into the shadow root)
    ...(Object.keys(DEFINES).length ? { define: DEFINES } : {}),
    logLevel: "info",
};

function copyAssets() {
    for (const [src, dst] of ASSETS) cpSync(src, `${BUILD_DIR}/${dst}`);
}

// KaTeX web fonts → dist/fonts/. katex.min.css (bundled into sidebar-app as text, injected as a
// <style>) references `fonts/KaTeX_*.woff2`, resolved relative to sidebar.html. Copy the woff2s
// (modern; the css also lists woff/ttf fallbacks a modern browser never fetches). Static → copy once.
function copyKatexFonts() {
    const dir = "node_modules/katex/dist/fonts";
    if (!existsSync(dir)) { console.warn("⚠ katex not installed — math rendering disabled (npm i)."); return; }
    mkdirSync(`${BUILD_DIR}/fonts`, { recursive: true });
    for (const f of readdirSync(dir)) if (f.endsWith(".woff2")) cpSync(`${dir}/${f}`, `${BUILD_DIR}/fonts/${f}`);
}

// Offline python_exec runtime → dist/pyodide/: the Pyodide CORE (from the `pyodide` npm
// devDep) + the numpy/Pillow wheels (from `npm run fetch-pyodide`, which the npm package
// doesn't ship). All optional — a missing piece just means the python_exec tool won't
// load; nothing else breaks. Copied once (not per watch-rebuild — it's ~17 MB static).
const PYODIDE_CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
function copyPyodide() {
    if (!existsSync("node_modules/pyodide")) { console.warn("⚠ pyodide not installed — python_exec disabled (npm i)."); return; }
    mkdirSync(`${BUILD_DIR}/pyodide`, { recursive: true });
    for (const f of PYODIDE_CORE) cpSync(`node_modules/pyodide/${f}`, `${BUILD_DIR}/pyodide/${f}`);
    if (existsSync("pyodide-wheels")) {
        for (const w of readdirSync("pyodide-wheels")) cpSync(`pyodide-wheels/${w}`, `${BUILD_DIR}/pyodide/${w}`);
    } else {
        console.warn("⚠ pyodide-wheels/ missing — run `npm run fetch-pyodide` to enable python_exec (numpy/Pillow).");
    }
}

// The STAGING dir is what gets cleared — never the live one. In watch mode these are the same path, which
// is the pre-existing behaviour and is what watch wants.
rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

// api-docs.gen.ts — the agent_api_docs tool's payload, lifted from contract.ts. Generated
// BEFORE bundling (tools.ts imports it) and gitignored, so the shipped reference can never
// drift from the interface. Rewritten only when it changes, so --watch doesn't self-trigger.
writeApiDocs();
// build-info.gen.ts — the harness's own provenance (repo URL, commit + date, build time) that
// agent_api_docs reports, captured from git at build time (gitignored; the extension can't run git live).
writeBuildInfo();
// docs/spec/export.schema.json — the JSON export contract in a language-neutral form, lifted from
// export-schema.ts. CHECKED IN (not gitignored like the two above): it is a published spec people link to
// and generate parsers from, so it has to exist in the repo, and `tests/export-schema.test.mjs` fails if
// an edit left it stale.
writeSchema();

if (watch) {
    const copyPlugin = { name: "copy-assets", setup(b) { b.onEnd(() => copyAssets()); } };
    const coreCtx = await esbuild.context({ ...base, entryPoints: coreEntries, plugins: [copyPlugin] });
    const sidebarCtx = await esbuild.context({ ...base, entryPoints: { "sidebar-app": sidebarApp }, minify: true, plugins: [copyPlugin] });
    await coreCtx.watch();
    await sidebarCtx.watch();
    copyPyodide(); copyKatexFonts();   // once — static, not worth recopying on every rebuild
    console.log(`watching… (${OUTDIR}/)`);
} else {
    try {
    await esbuild.build({ ...base, entryPoints: coreEntries });
    await esbuild.build({ ...base, entryPoints: { "sidebar-app": sidebarApp }, minify: true });
    // NOTE: the pure modules (locate, readonly-exec, python-runtime, agent-loop, auto-approve,
    // run-delegation, agent-host) used to be bundled here as standalone CJS for the node unit
    // tests. They aren't anymore — those tests `require("../<name>.ts")` directly under the
    // `tsx` loader (`npm test`), so go-to-definition/find-usages resolves into the source.
    // The vm/integration tests still read the BUNDLES above as text, so those entries stay.
    copyAssets();
    copyPyodide();
    copyKatexFonts();
    // Regenerate the standalone visual previews (gitignored build artifacts): locate's canvas
    // annotate() label placement, and the legend word-clipping "visual test" notebook (CI uploads
    // the latter so a failing legend case can be reviewed by eye). Open the HTMLs in a browser.
    await generatePreview();
    await generateLegendPreview();
    // Everything succeeded, so the staged build replaces the live one. Anything that throws above leaves
    // `dist/` exactly as it was — the whole point — and the stage is cleaned up on the way out.
    rmSync(OUTDIR, { recursive: true, force: true });
    renameSync(BUILD_DIR, OUTDIR);
    console.log(`built ${OUTDIR}/ (+ tools/annotate-preview.html, tools/legend-notebook.html)`);
    } catch (err) {
        // SAY that the old build is still there. Not keeping dist/ was its own failure mode — a loaded
        // extension with no manifest — but "your last good build is still installed" is the sort of good
        // news that misleads if it is silent: a silenced build now looks exactly like a successful one, and
        // whatever you were about to test is the PREVIOUS bundle. Which is how this line got written.
        rmSync(BUILD_DIR, { recursive: true, force: true });
        console.error(`\n✗ build FAILED — ${OUTDIR}/ is untouched and still holds the PREVIOUS build.`);
        console.error(`  Anything you run now tests that older bundle, not your current source.\n`);
        throw err;
    }
}
