// Build the chat page's WEB bundle into dist-web/: the portable core with no extension (docs/spec/CHAT_PAGE.md §Two
// places). `npm run build` runs it after the extension; `node scripts/build-web.mjs` runs it alone.
//
// It FAILS if the bundle references `chrome.*`. The chat core must run in a plain page and a phone app, and the only
// thing that keeps it that way over time is a build that refuses otherwise: a shared renderer that reaches for
// `chrome.storage` "just this once" breaks the phone, and nothing else would say so before a person did.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A `chrome.<member>` access, optional chaining included. Strings and comments are fine; minified code has none of
 *  the latter, and a string would have to spell a member access to match. */
export const CHROME_REF = /\bchrome\s*\??\.\s*[A-Za-z_$]/g;

/** Every `chrome.*` reference in a bundle, with a little context each, for the error message. */
export function chromeRefs(text) {
    return [...text.matchAll(CHROME_REF)].map((m) => text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " "));
}

/** The esbuild options for the web bundle, shared with the test that builds it in memory. */
export const webBuildOptions = (outdir) => ({
    absWorkingDir: ROOT,
    // `chat`: the demo (the fake host's world), what the specs and the screenshots drive. `client`: the standalone
    // client over a real hub (src/chat/client.tsx), what the phone app and a desktop wrapper run.
    entryPoints: { chat: "src/chat/web.tsx", client: "src/chat/client.tsx" },
    outdir,
    bundle: true,
    format: "iife",
    target: ["chrome114", "safari16"],
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".css": "text" },
    minify: true,
    logLevel: "warning",
});

/** Build dist-web/ (staged, swapped in on success, like the extension build). Throws on a `chrome` reference. */
export async function buildWeb({ outdir = "dist-web", appdir = outdir === "dist-web" ? "dist-app" : null } = {}) {
    const out = path.resolve(ROOT, outdir);
    const stage = `${out}.stage`;
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    try {
        await esbuild.build(webBuildOptions(stage));
        const refs = ["chat.js", "client.js"].flatMap((f) => chromeRefs(readFileSync(path.join(stage, f), "utf8")));
        if (refs.length) {
            throw new Error(`the web bundle references chrome.* ${refs.length} time(s); route it through services() or the ClientPlatform:\n  ${refs.slice(0, 8).join("\n  ")}`);
        }
        cpSync(path.join(ROOT, "src/chat/chat.html"), path.join(stage, "index.html"));
        cpSync(path.join(ROOT, "src/chat/client.html"), path.join(stage, "client.html"));
        cpSync(path.join(ROOT, "src/chat/chat.css"), path.join(stage, "chat.css"));
        cpSync(path.join(ROOT, "src/sidebar/sidebar.css"), path.join(stage, "sidebar.css"));
        const fonts = path.join(ROOT, "node_modules/katex/dist/fonts");
        if (existsSync(fonts)) {
            mkdirSync(path.join(stage, "fonts"), { recursive: true });
            for (const f of readdirSync(fonts)) if (f.endsWith(".woff2")) cpSync(path.join(fonts, f), path.join(stage, "fonts", f));
        }
        rmSync(out, { recursive: true, force: true });
        renameSync(stage, out);
    } catch (err) {
        rmSync(stage, { recursive: true, force: true });
        console.error(`\n✗ web build FAILED — ${outdir}/ is untouched.`);
        throw err;
    }
    console.log(`built ${outdir}/ (the chat page, no extension)`);
    if (appdir) buildApp(out, path.resolve(ROOT, appdir));
    if (outdir === "dist-web") await buildNative(out, path.resolve(ROOT, "dist-native"));
}

/** The page the phone app's WebView loads, as ONE file: the JS and both stylesheets inlined, so the app can carry it as a
 *  string and write it to its own storage (docs/spec/NATIVE_SHELL.md). `</script` inside the bundle is escaped. */
function singleFile(js, css) {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="color-scheme" content="dark light">
<title>window.ml</title>
<link rel="icon" href="data:,">
<style>${css}</style>
</head><body><div id="root"></div>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>
`;
}

/**
 * THE NATIVE SHELL'S PAGE (`dist-native/`): `embed.html` over this device's account and `embed-demo.html` over the demo
 * world, each self-contained, with the KaTeX fonts beside them (the stylesheet names them relatively). The phone app
 * (mobile/) takes one of the two into its bundle with `mobile/scripts/sync-embed.mjs`.
 */
async function buildNative(web, out) {
    const stage = `${out}.stage`;
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    let bundle = "dev";
    try { bundle = (await import("node:child_process")).execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
    await esbuild.build({ ...webBuildOptions(stage), entryPoints: { app: "src/chat/native-embed-app.tsx", demo: "src/chat/native-embed-demo.tsx" }, define: { __BUNDLE__: JSON.stringify(bundle) } });
    const css = ["sidebar.css", "chat.css"].map((f) => readFileSync(path.join(web, f), "utf8")).join("\n");
    for (const [entry, name] of [["app", "embed.html"], ["demo", "embed-demo.html"]]) {
        const js = readFileSync(path.join(stage, `${entry}.js`), "utf8");
        const refs = chromeRefs(js);
        if (refs.length) throw new Error(`the native embed references chrome.* ${refs.length} time(s):\n  ${refs.slice(0, 8).join("\n  ")}`);
        writeFileSync(path.join(stage, name), singleFile(js, css));
        rmSync(path.join(stage, `${entry}.js`));
    }
    if (existsSync(path.join(web, "fonts"))) cpSync(path.join(web, "fonts"), path.join(stage, "fonts"), { recursive: true });
    rmSync(out, { recursive: true, force: true });
    renameSync(stage, out);
    console.log(`built ${path.relative(ROOT, out)}/ (the phone app's page: embed.html, embed-demo.html)`);
}

/**
 * THE STANDALONE CLIENT'S OWN DIRECTORY (`dist-app/`): the client as the start page and nothing of the demo, for
 * serving it as a site of its own. `dist-web/`'s `index.html` is the demo world the specs drive, so the client gets its
 * own directory rather than the demo moving out of the specs' way.
 */
function buildApp(web, app) {
    rmSync(app, { recursive: true, force: true });
    mkdirSync(app, { recursive: true });
    for (const f of ["client.js", "sidebar.css", "chat.css"]) cpSync(path.join(web, f), path.join(app, f));
    cpSync(path.join(web, "client.html"), path.join(app, "index.html"));
    if (existsSync(path.join(web, "fonts"))) cpSync(path.join(web, "fonts"), path.join(app, "fonts"), { recursive: true });
    installable(app);
    console.log(`built ${path.relative(ROOT, app)}/ (the phone app's pages: the standalone client, installable)`);
}

/** Everything the page's own source does not carry: what a browser needs to offer to install it. */
const PWA_DIR = path.resolve(ROOT, "src/chat/pwa");
/** The files a fresh visit needs before the network is optional. Fonts and icons are added from what was built. */
const SHELL = ["index.html", "client.js", "sidebar.css", "chat.css"];

/**
 * MAKE `dist-app/` INSTALLABLE: the manifest, the icons and a service worker holding the app's own files, so a phone
 * can put it on its home screen and open it without the network.
 *
 * The head tags and the registration are injected HERE rather than written into `src/chat/client.html`, because that
 * file is also the page served from `dist-web/` for the tests and the screenshots, and a worker installed by a test
 * run outlives the run. Only the directory meant to be hosted gets one.
 *
 * The worker's version is a hash of the files it holds, so a deploy that changed nothing installs nothing, and one
 * that changed a byte replaces the whole cache on the next load.
 */
function installable(app) {
    for (const f of readdirSync(PWA_DIR)) if (f !== "sw.js") cpSync(path.join(PWA_DIR, f), path.join(app, f));
    const fonts = existsSync(path.join(app, "fonts")) ? readdirSync(path.join(app, "fonts")).map((f) => `fonts/${f}`) : [];
    const precache = [...SHELL, "app.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", ...fonts];
    const version = createHash("sha256").update(precache.join("\n")).update(SHELL.map((f) => readFileSync(path.join(app, f))).join("")).digest("hex").slice(0, 12);
    const sw = readFileSync(path.join(PWA_DIR, "sw.js"), "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(precache));
    writeFileSync(path.join(app, "sw.js"), sw);

    const head = `    <link rel="manifest" href="app.webmanifest">
    <link rel="apple-touch-icon" href="apple-touch-icon.png">
    <meta name="theme-color" content="#1e1f24">
    <!-- iOS reads the manifest's display mode now, but an older one only ever read this. -->
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="window.ml">
`;
    // Registered after load, so it never competes with the app's own first paint for the connection.
    const reg = `<script>addEventListener("load",()=>{navigator.serviceWorker&&navigator.serviceWorker.register("sw.js").catch(()=>{})})</script>\n`;
    const html = readFileSync(path.join(app, "index.html"), "utf8").replace("</head>", `${head}</head>`).replace("</body>", `${reg}</body>`);
    writeFileSync(path.join(app, "index.html"), html);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--outdir");
    await buildWeb(i >= 0 ? { outdir: process.argv[i + 1] } : {});
}
