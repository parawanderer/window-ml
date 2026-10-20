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

test("the extension's sandbox CSP refuses a nested frame, a base and a form, as the native build's does", { todo: "manifest.json content_security_policy.sandbox omits frame-src/base-uri/form-action 'none' (scripts/build-web.mjs sets all three for the native build)" }, () => {
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

test("the diagram frame is not a web-accessible resource every origin can embed and drive", { todo: "mermaid.html and mermaid-frame.js are WAR to <all_urls> without use_dynamic_url, so any page can embed the sandbox (src/mermaid/mermaid-frame.ts checks only e.source !== parent)" }, () => {
    // WAR with `matches: ["<all_urls>"]` is what lets a hostile page do
    // `iframe src=chrome-extension://<id>/mermaid.html` at all. From there the page IS `parent`, so mermaid-frame.ts's
    // `e.source !== parent` passes and the page gets a Mermaid render oracle plus the CSP gap above. The sidebar's
    // nested frame loads from an extension document and does not need WAR for every origin to do that.
    const exposed = war.filter((e) => /(^|\/)mermaid(\.html|-frame\.js)$/.test(e.resource));
    assert.ok(exposed.length > 0, "positive control: mermaid.html/mermaid-frame.js are web-accessible at all (the test is reading the right list)");
    for (const e of exposed) {
        assert.ok(!e.matches.includes("<all_urls>"),
            `${e.resource} is web-accessible to ${JSON.stringify(e.matches)} — any page can frame the diagram sandbox`);
        assert.ok(e.use_dynamic_url === true,
            `${e.resource} lacks use_dynamic_url, which docs/dev/detection-surface.md row 5 lists as the mitigation for its fingerprint`);
    }
});

test("the diagram frame answers a render only to the opener that created it, not to whoever framed it", { todo: "mermaid-frame.ts takes any parent as the asker (e.source !== parent) and replies with targetOrigin '*' — a page that frames mermaid.html renders diagrams through the extension" }, () => {
    // The property, stated as the frame must keep it: a window other than the one the extension's own client created
    // this frame for cannot buy a drawing. Today the only check is `e.source !== parent`, and a page that frames
    // mermaid.html is `parent`. The answer is then posted to `parent` with targetOrigin `*`.
    const src = read("src/mermaid/mermaid-frame.ts");
    assert.ok(/e\.source\s*!==\s*parent/.test(src), "positive control: the frame has an asker check at all");
    // Defended: the check must bind the asker to something a hostile framer cannot be (a nonce in the fragment the
    // client minted, a MessageChannel port, an explicit allowlist of opener origins — the shape is the fixer's).
    assert.ok(/nonce|MessageChannel|channel\.port1|openerToken|allowlist|e\.origin/.test(src),
        "mermaid-frame.ts accepts any parent as the asker; a page that embeds the WAR page drives renders for free");
    // And the answer must not be broadcast to every embedder.
    assert.ok(!/postMessage\([^)]*["']\*["']\s*\)/.test(src),
        `mermaid-frame.ts answers with targetOrigin "*": ${src.match(/postMessage\([^\n]+/g)?.join(" | ")}`);
});

// --- the phone's native bridge must be gone before Mermaid can run anything ---

test("the diagram frame removes every native bridge the phone injects, before Mermaid evaluates", { todo: "no-bridge.ts deletes only ReactNativeWebView, and in dist/mermaid-frame.js that delete lands AFTER Mermaid's library body (byte 5223565 vs startOnLoad 511642)" }, () => {
    // react-native-webview gives EVERY frame its `ReactNativeWebView` (src/mermaid/no-bridge.ts); iOS WKWebView is
    // the same injection under `window.webkit.messageHandlers`. no-bridge.ts deletes only the first, and the import
    // order it relies on ("imported first by mermaid-frame.ts") is not what the bundle does: esbuild emits the
    // delete AFTER Mermaid's module body has evaluated, so Mermaid's own code runs with the bridge still present.
    const nb = read("src/mermaid/no-bridge.ts");
    assert.ok(/ReactNativeWebView/.test(nb), "positive control: no-bridge.ts removes ReactNativeWebView");
    assert.ok(/webkit|messageHandlers/.test(nb),
        "no-bridge.ts leaves window.webkit.messageHandlers in place — the iOS half of the same injection");

    const dist = path.join(root, "dist/mermaid-frame.js");
    assert.ok(existsSync(dist), "dist/mermaid-frame.js exists (npm run build:all first)");
    const js = read("dist/mermaid-frame.js");
    const del = js.indexOf("delete globalThis.ReactNativeWebView");
    assert.ok(del >= 0, "positive control: the built frame deletes ReactNativeWebView");
    // Mermaid's module init is its own top-level side effects; `startOnLoad` is in the object mermaid.initialize
    // reads and the library body sits well before the entry's statements. The delete must precede any of it.
    const lib = js.indexOf("startOnLoad");
    assert.ok(lib >= 0, "positive control: the built frame contains Mermaid");
    assert.ok(del < lib,
        `no-bridge's delete runs at byte ${del}, after Mermaid's library (startOnLoad at ${lib}) — import "./no-bridge" first does not survive bundling`);
    assert.ok(/delete[^;]{0,80}messageHandlers|delete[^;]{0,80}webkit/.test(js),
        "the built frame never deletes webkit.messageHandlers");
});

// --- an SVG handed back as <img>: scheme, dimensions, size ---

test("a drawn diagram's <img> is built from a data:image/svg+xml URL with finite dimensions, and the result is size-bounded", { todo: "mermaid-block.ts imgHtml writes r.w/r.h unvalidated (Infinity passes the client's typeof number check) and embeds an unbounded SVG as a data: URL" }, async () => {
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

test("the answer channel refuses a dimension or a body that is not a drawn SVG", { todo: "mermaid-client.ts accepts Infinity dimensions (typeof number) and an unbounded SVG body" }, async () => {
    // mermaid-client.ts is the last gate before an <img> is emitted from a frame message. A hostile page that can
    // reach the client's window (it sits in someone's page) must not be able to shape the img.
    const src = read("src/mermaid/mermaid-client.ts");
    assert.ok(/\/\^<svg\[\\s>\]\/\.test\(d\.svg\)/.test(src), "positive control: the client requires the body to open with <svg");
    assert.ok(/typeof d\.w === "number"/.test(src) && /typeof d\.h === "number"/.test(src), "positive control: the client type-checks w and h");
    // Defended: finite, and a byte budget on the body it will put in the DOM.
    assert.ok(/Number\.isFinite\(d\.w\)|isFinite\(d\.w\)/.test(src), "the client accepts w: Infinity (typeof number) — mermaid-block will emit width=\"Infinity\"");
    assert.ok(/MAX_SVG|SVG_LIMIT|svg\.length\s*<|svg\.length\s*>/.test(src), "the client has no size bound on the SVG body it caches and renders");
});

// --- unbounded drawing cost, from a page or from a model ---

test("drawing one diagram is bounded work: source length, in-flight count, and distinct draws per document", { todo: "mermaid-client.ts / mermaid-frame.ts bound neither the source length nor the number of distinct draws (a page or a model can schedule unbounded Mermaid parses)" }, () => {
    // A page that frames mermaid.html (above) and a model that writes N fences both currently get N full Mermaid
    // parses. CACHE_MAX bounds only the CACHE, not how many draws happen; inFlight is keyed by source, so N distinct
    // sources are N parallel renders; there is no cap on the source string the frame is asked to parse.
    const client = read("src/mermaid/mermaid-client.ts");
    const frame = read("src/mermaid/mermaid-frame.ts");
    assert.ok(/CACHE_MAX/.test(client), "positive control: the cache is bounded (by count)");
    assert.ok(/RENDER_TIMEOUT_MS/.test(client), "positive control: a single draw has a timeout");
    assert.ok(/src\.length\s*<|src\.length\s*>|MAX_SRC|SRC_LIMIT/.test(client + frame),
        "no cap on the diagram source sent to the frame — a multi-megabyte string is handed to Mermaid to parse");
    assert.ok(/MAX_IN_FLIGHT|inFlight\.size\s*<|queue\.length|MAX_DRAWS|DRAW_BUDGET/.test(client),
        "no cap on how many distinct draws run at once, nor how many a document may start");
});

// --- the HUD surface ---

test("the HUD streams a half-written ```mermaid fence as code, never as a diagram, and holds the same close contract as the transcript", { todo: "hud-card.tsx renders run.liveStream.content through markdown() without closeStreaming, so the HUD does not share the transcript's half-written-fence contract" }, async () => {
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

test("detection-surface.md row 5 matches what the manifest actually does about the diagram frame", { todo: "docs/dev/detection-surface.md row 5 lists use_dynamic_url as the mitigation for mermaid.html/mermaid-frame.js, but manifest.json does not set use_dynamic_url on them" }, () => {
    const doc = read("docs/dev/detection-surface.md");
    const row = doc.split("\n").find((l) => /mermaid\.html/.test(l));
    assert.ok(row, "positive control: detection-surface.md has a row naming mermaid.html");
    // The row lists use_dynamic_url as the mitigation. If the manifest does not set it, the doc is claiming a
    // defence that is not there — which is worse than an open hole, because a reviewer stops looking.
    if (/use_dynamic_url/.test(row)) {
        const exposed = war.filter((e) => /mermaid/.test(e.resource));
        for (const e of exposed) assert.equal(e.use_dynamic_url, true,
            `detection-surface.md claims use_dynamic_url on ${e.resource}, but manifest.json does not set it`);
    }
    // Positive control: the manifest's WAR is what the doc is talking about.
    assert.ok(war.some((e) => /mermaid\.html/.test(e.resource)), "positive control: mermaid.html is in web_accessible_resources");
});
