// The chat page's web bundle must run where there is no extension: a plain page, a phone app. `npm run build` refuses
// a bundle that references `chrome.*` (scripts/build-web.mjs); this runs the same check in memory, so `npm test` says
// so too, and it checks that the check itself still recognises a reference.
import test from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
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
