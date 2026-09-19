// Build the chat page's WEB bundle into dist-web/: the portable core with no extension (docs/spec/CHAT_PAGE.md §Two
// places). `npm run build` runs it after the extension; `node scripts/build-web.mjs` runs it alone.
//
// It FAILS if the bundle references `chrome.*`. The chat core must run in a plain page and a phone app, and the only
// thing that keeps it that way over time is a build that refuses otherwise: a shared renderer that reaches for
// `chrome.storage` "just this once" breaks the phone, and nothing else would say so before a person did.
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
}

/**
 * THE APP'S WEB DIRECTORY (`dist-app/`, Capacitor's `webDir`): the standalone client as the start page and nothing of
 * the demo. The app loads `index.html`, and `dist-web/`'s is the demo world the specs drive, so the app gets its own
 * directory rather than the demo moving out of the specs' way.
 */
function buildApp(web, app) {
    rmSync(app, { recursive: true, force: true });
    mkdirSync(app, { recursive: true });
    for (const f of ["client.js", "sidebar.css", "chat.css"]) cpSync(path.join(web, f), path.join(app, f));
    cpSync(path.join(web, "client.html"), path.join(app, "index.html"));
    if (existsSync(path.join(web, "fonts"))) cpSync(path.join(web, "fonts"), path.join(app, "fonts"), { recursive: true });
    console.log(`built ${path.relative(ROOT, app)}/ (the phone app's pages: the standalone client)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--outdir");
    await buildWeb(i >= 0 ? { outdir: process.argv[i + 1] } : {});
}
