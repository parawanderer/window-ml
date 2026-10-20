// redteam-mermaid.test.mjs — the red-team pass on the Mermaid diagram sandbox (PRs #832 / #843: src/mermaid/,
// manifest.json's `sandbox.pages`, scripts/build-web.mjs's native frame CSP). A hostile page that never renders a
// reply must get nothing from the diagram machinery, and a model-written fence must not spend more than it takes to
// draw one diagram. Each property is asserted as the DEFENDED outcome with a positive control in the same test; one
// that does not hold yet carries a `todo` naming the gap.
//
// THREAT MODEL, refined for this surface. The frame (mermaid.html) is a web-accessible resource, so any origin can
// embed it; the page that embeds it IS its `parent`, and the frame's only asker check is `e.source !== parent`. So
// "the opener" is not an identity — it is whatever window framed the page. Beyond that: the sandbox CSP is the only
// thing standing between a Mermaid parse of hostile source and a network (nested frame), and no-bridge.ts is the only
// thing standing between that parse and the phone app's native bridge. An SVG drawn back into a reply is inert as an
// `<img>`, but only if the URL is a data: URL of SVG and the dimensions cannot break out of the attribute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const sandboxCsp = manifest.content_security_policy?.sandbox ?? "";
const war = (manifest.web_accessible_resources ?? []).flatMap((e) => e.resources.map((r) => ({ ...e, resource: r })));

// --- the sandbox page's CSP: the only thing a nested frame is refused by ---

test("the extension's sandbox CSP refuses a nested frame, a base and a form, as the native build's does", () => {
    // scripts/build-web.mjs pins the same page by hash and then adds `frame-src 'none'; base-uri 'none';
    // form-action 'none'`, with the comment that `frame-src 'none'` is what refuses a nested frame that loads a URL.
    // A nested frame is the one request the CSP box still allows out (`connect-src`/`img-src` do not govern
    // navigation), and mermaid.html is reachable from every origin below — so this gap is an exfil channel any page
    // can aim the extension's sandbox at.
    for (const dir of ["frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
        assert.ok(sandboxCsp.includes(dir), `manifest sandbox CSP is missing ${dir}: ${JSON.stringify(sandboxCsp)}`);
    }
    // Positive control: the native build really does pin them, so this is the extension lagging the stronger policy,
    // not a requirement invented here.
    const build = read("scripts/build-web.mjs");
    assert.ok(/frame-src 'none'/.test(build), "positive control: scripts/build-web.mjs sets frame-src 'none'");
    assert.ok(/base-uri 'none'/.test(build), "positive control: scripts/build-web.mjs sets base-uri 'none'");
    assert.ok(/form-action 'none'/.test(build), "positive control: scripts/build-web.mjs sets form-action 'none'");
});

// --- who may frame mermaid.html, and who the frame will answer ---

test("the diagram frame, web-accessible to every origin, answers only a framer of its own origin", () => {
    // WAR to `<all_urls>` is required, not a slip: the overlay is an extension frame inside a web page, and Chrome
    // refuses it a nested extension frame otherwise (docs/dev/sidebar.md). So any page CAN embed mermaid.html, and the
    // property is what it gets for that: nothing. The frame reads the framer's origin from `location.ancestorOrigins`,
    // which a page cannot set, and registers no listener and posts nothing (not even "ready") unless it is its own.
    const exposed = war.filter((e) => /(^|\/)mermaid(\.html|-frame\.js)$/.test(e.resource));
    assert.ok(exposed.length > 0, "positive control: mermaid.html/mermaid-frame.js are web-accessible at all (the test is reading the right list)");
    const src = read("src/mermaid/mermaid-frame.ts");
    assert.match(src, /const framer = location\.ancestorOrigins\?\.\[0\]/, "the frame reads the framer's origin from ancestorOrigins");
    assert.match(src, /: framer === own\)/, "off `file:`, the framer must be the frame's own origin exactly");
    const gate = src.indexOf("if (framedByOwn)");
    assert.ok(gate > 0, "the frame's listener and its ready are behind the origin check");
    assert.equal(src.indexOf("addEventListener(\"message\""), src.indexOf("addEventListener(\"message\"", gate), "no message listener outside the check");
    assert.equal((src.match(/postMessage\(\{ mmd: "ready" \}/g) || []).length, 1, "one ready, and it is inside the check");
    assert.ok(src.indexOf('postMessage({ mmd: "ready" }') > gate, "ready is posted only inside the check");
});

test("the diagram frame answers a render only to the opener that created it, not to whoever framed it", () => {
    // The property, stated as the frame must keep it: a window other than the one the extension's own client created
    // this frame for cannot buy a drawing. Today the only check is `e.source !== parent`, and a page that frames
    // mermaid.html is `parent`. The answer is then posted to `parent` with targetOrigin `*`.
    const src = read("src/mermaid/mermaid-frame.ts");
    assert.ok(/e\.source\s*!==\s*parent/.test(src), "positive control: the frame has an asker check at all");
    // Defended: the check must bind the asker to something a hostile framer cannot be (a nonce in the fragment the
    // client minted, a MessageChannel port, an explicit allowlist of opener origins — the shape is the fixer's).
    assert.ok(/nonce|MessageChannel|channel\.port1|openerToken|allowlist|e\.origin|ancestorOrigins/.test(src),
        "mermaid-frame.ts accepts any parent as the asker; a page that embeds the WAR page drives renders for free");
    // And the answer must not be broadcast to every embedder.
    assert.ok(!/postMessage\([^)]*["']\*["']\s*\)/.test(src),
        `mermaid-frame.ts answers with targetOrigin "*": ${src.match(/postMessage\([^\n]+/g)?.join(" | ")}`);
});

// --- the phone's native bridge must be gone before Mermaid can run anything ---

test("the diagram frame removes every native bridge the phone injects, before Mermaid evaluates", () => {
    // react-native-webview gives EVERY frame its bridge: `ReactNativeWebView` (Android), `webkit.messageHandlers`
    // (iOS). An import of no-bridge.ts from mermaid-frame.ts did not survive bundling (esbuild placed the delete after
    // Mermaid's body), so it is now its own <script> in the phone's mermaid.html, ahead of the library's.
    const nb = read("src/mermaid/no-bridge.ts");
    assert.match(nb, /delete g\.ReactNativeWebView/, "no-bridge.ts removes ReactNativeWebView");
    assert.match(nb, /webkit/, "no-bridge.ts removes webkit (the iOS half)");
    assert.doesNotMatch(read("src/mermaid/mermaid-frame.ts"), /no-bridge/, "not imported into the library's bundle, where order is the bundler's");

    const page = path.join(root, "dist-native/mermaid.html");
    assert.ok(existsSync(page), "dist-native/mermaid.html exists (npm run build:all first)");
    const html = read("dist-native/mermaid.html");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2, "two inline scripts: the bridge removal, then the library");
    assert.match(scripts[0], /ReactNativeWebView/, "the FIRST script removes the bridge");
    assert.match(scripts[0], /webkit/, "the first script also removes webkit");
    assert.doesNotMatch(scripts[0], /startOnLoad/, "the first script is not Mermaid");
    assert.match(scripts[1], /startOnLoad/, "positive control: the second script is Mermaid");
    // Both pinned by hash, and nothing else allowed to run.
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.equal((csp.match(/'sha256-/g) || []).length, 2, `two hashes in script-src: ${csp.slice(0, 160)}`);
    assert.doesNotMatch(csp, /unsafe-inline|'self'/);
});

// --- an SVG handed back as <img>: scheme, dimensions, size ---

test("a drawn diagram's <img> is built from a data:image/svg+xml URL with finite dimensions, and the result is size-bounded", async () => {
    const { done, keyOf, mermaidBlock, pageIsDark } = await import("../src/mermaid/mermaid-block.ts");
    // pageIsDark() is true in node (no document), so the cache key is the dark one.
    const dark = pageIsDark();
    const src = "graph TD\n  A-->B";
    done.set(keyOf(src, dark), { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><text>A</text></svg>", w: 10, h: 10 });
    const ok = mermaidBlock(src);
    // Positive control: the honest path is a data: URL of SVG (an <img> of that scheme runs no script and fetches no
    // external reference — the browser's secure-static-mode, which this test cannot replace).
    assert.ok(ok.includes('src="data:image/svg+xml;charset=utf-8,'), `expected a data:image/svg+xml img, got: ${ok.slice(0, 200)}`);
    assert.ok(!/src="(https?:|javascript:|blob:)/.test(ok), "the img src must never be a network or script URL");
    assert.ok(!/width="[^"]*"/.test(ok) || /width="\d+"/.test(ok), "width is a plain integer attribute");

    // Non-finite dimensions: the client's `typeof d.w === "number"` accepts Infinity, and sized() writes it straight
    // into the attribute.
    const srcInf = "graph TD\n  A-->C";
    done.set(keyOf(srcInf, dark), { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"></svg>", w: Infinity, h: 5 });
    const inf = mermaidBlock(srcInf);
    assert.ok(!/width="Infinity"|width="NaN"/.test(inf), `non-finite width reached the img: ${inf.slice(0, 200)}`);

    // Size: a model or a page that drives the frame can come back with a multi-megabyte SVG. The cache holds 200 of
    // them (mermaid-client.ts CACHE_MAX) with no byte budget, and imgHtml encodes the whole thing into the DOM.
    const huge = "x".repeat(2 * 1024 * 1024);
    const srcHuge = "graph TD\n  A-->D";
    done.set(keyOf(srcHuge, dark), { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>${huge}</text></svg>`, w: 1, h: 1 });
    const big = mermaidBlock(srcHuge);
    assert.ok(big.length < 512 * 1024, `a ${huge.length}-byte SVG became a ${big.length}-byte block with no size cap`);
});

test("the answer channel refuses a dimension or a body that is not a drawn SVG", async () => {
    // mermaid-client.ts is the last gate before an <img> is emitted from a frame message. Every answer goes through
    // `undrawable` (mermaid-block.ts) there, and again where the <img> is built from the cache.
    const src = read("src/mermaid/mermaid-client.ts");
    assert.ok(/\/\^<svg\[\\s>\]\/\.test\(d\.svg\)/.test(src), "positive control: the client requires the body to open with <svg");
    assert.match(src, /const why = undrawable\(r\);\s*settle\(why \? \{ error: why \} : r\)/, "every drawing answer passes undrawable before it is settled");
    const { undrawable, MAX_SVG, MAX_DIM } = await import("../src/mermaid/mermaid-block.ts");
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
    assert.equal(undrawable({ svg, w: 40, h: 20 }), null, "positive control: an ordinary drawing passes");
    for (const [w, h] of [[Infinity, 5], [5, Infinity], [NaN, 5], [0, 5], [-1, 5], [MAX_DIM + 1, 5]]) {
        assert.ok(undrawable({ svg, w, h }), `w=${w} h=${h} is refused`);
    }
    assert.ok(undrawable({ svg: "<svg>" + "x".repeat(MAX_SVG) + "</svg>", w: 1, h: 1 }), "an SVG past MAX_SVG is refused");
});

// --- unbounded drawing cost, from a page or from a model ---

test("drawing one diagram is bounded work: source length, in-flight count, and distinct draws per document", () => {
    // A page that frames mermaid.html (above) and a model that writes N fences both currently get N full Mermaid
    // parses. CACHE_MAX bounds only the CACHE, not how many draws happen; inFlight is keyed by source, so N distinct
    // sources are N parallel renders; there is no cap on the source string the frame is asked to parse.
    const client = read("src/mermaid/mermaid-client.ts");
    const frame = read("src/mermaid/mermaid-frame.ts");
    assert.ok(/CACHE_MAX/.test(client), "positive control: the cache is bounded (by count)");
    assert.ok(/RENDER_TIMEOUT_MS/.test(client), "positive control: a single draw has a timeout");
    assert.ok(/src\.length\s*<|src\.length\s*>|MAX_SRC|SRC_LIMIT/.test(client + frame),
        "no cap on the diagram source sent to the frame — a multi-megabyte string is handed to Mermaid to parse");
    assert.match(client, /const turn = sending;[\s\S]*turn\.then\(\(\) => frameReady\(doc\)\)[\s\S]*sending = p\.catch/,
        "the client asks the frame for one drawing at a time: each waits for the one before");
    assert.match(frame, /queue = queue\.then\(\(\) => draw\(ask\)\)/, "the frame draws one at a time too");
});

// --- the HUD surface ---

test("the HUD streams a half-written ```mermaid fence as code, never as a diagram, and holds the same close contract as the transcript", async () => {
    // The chat page closes open Markdown before every render (src/sidebar/transcript/stream-close.ts): an open
    // ```mermaid fence becomes `mermaid_open`, so a half-written diagram is never sent to be drawn. The HUD card
    // (src/sidebar/card/hud-card.tsx) renders `markdown(run.liveStream.content)` with no closeStreaming, so it is one
    // "fix the flicker" commit away from handing half-written source to the drawer — and today already disagrees with
    // the transcript about what a fence in front of the reader is.
    const hud = read("src/sidebar/card/hud-card.tsx");
    const close = read("src/sidebar/transcript/stream-close.ts");
    assert.ok(/closeStreaming/.test(close), "positive control: closeStreaming exists and rewrites a mermaid fence to mermaid_open");
    assert.ok(/mermaid_open/.test(close), "positive control: closeStreaming's mermaid rule is the one under test");
    const streamLine = hud.split("\n").find((l) => /liveStream\.content/.test(l) && /markdown\(/.test(l));
    assert.ok(streamLine, "positive control: the HUD's streaming answer goes through markdown()");
    assert.ok(/closeStreaming\(/.test(streamLine ?? ""),
        `the HUD renders liveStream.content without closeStreaming: ${streamLine?.trim()}`);

    // Positive control on the shared rule: whatever closes the fence, markdown() must not draw `mermaid_open`.
    const { markdown } = await import("../src/sidebar/format.ts");
    assert.ok(!/class="mmd"/.test(markdown("```mermaid_open\ngraph TD\n```")), "a mermaid_open fence stays code");
});

// --- fingerprint of the new web-accessible paths (docs/dev/detection-surface.md row 5) ---

test("detection-surface.md row 5 matches what the manifest actually does about the diagram frame", () => {
    const doc = read("docs/dev/detection-surface.md");
    const row = doc.split("\n").find((l) => /mermaid\.html/.test(l));
    assert.ok(row, "positive control: detection-surface.md has a row naming mermaid.html");
    // The row lists use_dynamic_url as the mitigation. If the manifest does not set it, the doc is claiming a
    // defence that is not there — which is worse than an open hole, because a reviewer stops looking.
    const exposed = war.filter((e) => /mermaid/.test(e.resource));
    if (/use_dynamic_url/.test(row) && !exposed.every((e) => e.use_dynamic_url === true)) {
        assert.match(row, /does not set it|not set/, `detection-surface.md names use_dynamic_url without saying manifest.json does not set it: ${row}`);
    }
    // Positive control: the manifest's WAR is what the doc is talking about.
    assert.ok(war.some((e) => /mermaid\.html/.test(e.resource)), "positive control: mermaid.html is in web_accessible_resources");
});
