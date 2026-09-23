// The chat page's web bundle must run where there is no extension: a plain page, a phone app. `npm run build` refuses
// a bundle that references `chrome.*` (scripts/build-web.mjs); this runs the same check in memory, so `npm test` says
// so too, and it checks that the check itself still recognises a reference.
import test from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { webBuildOptions, chromeRefs } from "../scripts/build-web.mjs";

test("the check recognises chrome.* however it is spelled, and nothing else", () => {
    assert.equal(chromeRefs("a=chrome.runtime.sendMessage(x)").length, 1);
    assert.equal(chromeRefs("chrome?.storage?.local").length, 1);
    assert.equal(chromeRefs("chrome . permissions").length, 1);
    assert.deepEqual(chromeRefs('ua.includes("chrome") || x.chromeVersion || typeof chrome'), []);
});

test("the web bundle builds and references no chrome.*", async () => {
    const r = await esbuild.build({ ...webBuildOptions("/tmp/unused"), write: false, logLevel: "silent" });
    const js = r.outputFiles.find((f) => f.path.endsWith("chat.js"));
    assert.ok(js && js.text.length > 100_000, "built the whole page, not an empty shell");
    assert.deepEqual(chromeRefs(js.text), [], "route these through services() or the ClientPlatform");
});

// The HOSTED app (dist-app/) is the same client, made installable: a manifest, icons and a service worker holding its
// own files. These read what the last build wrote, so they say nothing when there is none — the browser-side proof
// (it registers, it controls the page, it loads with the network off) is not something node can make.
test("the hosted app is installable: a manifest, a worker with no placeholders left, and a head that names both", async (t) => {
    const app = new URL("../dist-app/", import.meta.url);
    if (!existsSync(new URL("index.html", app))) return t.skip("no dist-app/ — run `node scripts/build-web.mjs`");

    const manifest = JSON.parse(readFileSync(new URL("app.webmanifest", app), "utf8"));
    assert.equal(manifest.display, "standalone", "a home-screen launch must not open browser chrome");
    assert.ok(manifest.start_url.startsWith("."), "relative, so it works under a subpath (GitHub Pages serves /window-ml/)");
    assert.ok(manifest.scope.startsWith("."), "likewise");
    assert.ok(manifest.icons.some((i) => i.purpose === "maskable"), "Android crops anything else into its own shape");
    for (const icon of manifest.icons) assert.ok(existsSync(new URL(icon.src, app)), `${icon.src} is named by the manifest`);

    const sw = readFileSync(new URL("sw.js", app), "utf8");
    assert.ok(!sw.includes("__VERSION__") && !sw.includes("__PRECACHE__"), "the build stamps both placeholders");
    const precache = JSON.parse(sw.match(/const PRECACHE = (\[.*?\]);/s)[1]);
    for (const f of precache) assert.ok(existsSync(new URL(f, app)), `${f} is precached but was not built`);
    assert.ok(precache.includes("index.html") && precache.includes("client.js"), "the shell itself");

    const html = readFileSync(new URL("index.html", app), "utf8");
    assert.match(html, /<link rel="manifest" href="app\.webmanifest">/, "nothing offers to install a page without it");
    assert.match(html, /serviceWorker.*register\("sw\.js"\)/, "and nothing caches without the registration");
    assert.match(html, /apple-touch-icon/, "iOS takes its home-screen icon from this, not from the manifest alone");
});
