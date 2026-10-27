// artifact-wall.spec.mjs — what leaves an artifact's sandbox frame by each route, under today's manifest and under the
// second wall docs/spec/ARTIFACTS.md proposes, counted by a server the frame is pointed at. The probe runs UNMEDIATED
// (tests/e2e/fixtures/artifact-wall/probe.js): it stands for an evaluator that has been escaped.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { launchExtension } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures/artifact-wall");
/** The evaluator as a worker body (eval-worker.ts), bundled once; its size is part of what spike Q2 measures. */
const EVAL_SRC = buildSync({ entryPoints: [path.join(FIX, "eval-worker.ts")], bundle: true, format: "iife", minify: true, target: "chrome120", write: false }).outputFiles[0].text;
const DIST = process.env.E2E_DIST ? path.resolve(process.env.E2E_DIST) : path.join(HERE, "../../dist");

/** Every route probe.js knows, embedded from an extension page as the sidebar embeds its frames. */
const PROBES = [
    "nav-location", "nav-meta", "nav-anchor", "nav-data-chain", "nav-blob-chain",
    "nav-anchor-blank", "nav-open", "nav-top", "nav-form", "nested-srcdoc", "nested-iframe", "a-ping",
    "img", "css-bg", "css-link", "css-import", "font", "video", "audio", "object", "script", "worker", "manifest",
    "prefetch", "preload-fetch", "preload-style", "preconnect",
    "fetch", "xhr", "beacon", "websocket", "eventsource", "webrtc-stun",
    // From a blob worker the frame starts (probe.js `inWorker`): an evaluator with no window.
    "w-fetch", "w-xhr", "w-websocket", "w-eventsource", "w-import-scripts", "w-import-dynamic", "w-nested-worker", "w-font-face", "w-webtransport",
];

const SANDBOX_TODAY = "sandbox allow-scripts; script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const SANDBOX_WALL = "sandbox allow-scripts; default-src 'none'; script-src 'self'; object-src 'none'; connect-src 'none'; img-src data:; frame-src 'none'; base-uri 'none'; form-action 'none'";
const PAGES_TODAY = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

/** The manifest variants: today's, the sandbox CSP tightened, and that plus the embedder's frame-src. */
const VARIANTS = {
    today: { sandbox: null, pages: null },
    "sandbox-csp": { sandbox: SANDBOX_WALL, pages: null },
    wall: { sandbox: SANDBOX_WALL, pages: `${PAGES_TODAY}; frame-src 'self'` },
    // The wall, plus the one source a frame needs to start its evaluator in a worker from a blob it built.
    "wall+worker": { sandbox: `${SANDBOX_WALL}; worker-src blob:`, pages: `${PAGES_TODAY}; frame-src 'self'` },
};

/** A copy of the built extension with the probe pages added and the CSPs of `variant` written into its manifest. */
function distFor(variant) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `artifact-wall-${variant}-`));
    fs.cpSync(DIST, dir, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(m.content_security_policy.sandbox, "the spec's copy of today's sandbox CSP is current").toBe(SANDBOX_TODAY);
    expect(m.content_security_policy.extension_pages).toBe(PAGES_TODAY);
    const v = VARIANTS[variant];
    if (v.sandbox) m.content_security_policy.sandbox = v.sandbox;
    if (v.pages) m.content_security_policy.extension_pages = v.pages;
    m.sandbox.pages.push("artifact-probe.html");
    m.web_accessible_resources[0].resources.push("artifact-probe.html", "artifact-probe.js");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2));
    fs.writeFileSync(path.join(dir, "artifact-eval-src.js"), `self.__EVAL_SRC = ${JSON.stringify(EVAL_SRC)};`);
    for (const [from, to] of [["probe.html", "artifact-probe.html"], ["probe.js", "artifact-probe.js"], ["host.html", "artifact-probe-host.html"], ["host.js", "artifact-probe-host.js"]])
        fs.copyFileSync(path.join(FIX, from), path.join(dir, to));
    return dir;
}

/** The counting servers: HTTP hits by probe, bare TCP connections (preconnect), UDP datagrams (STUN). */
async function startCounters() {
    const hits = new Map();
    const count = (k) => hits.set(k, (hits.get(k) || 0) + 1);
    const site = (port) => `<!doctype html><body><script>
        window.__got = []; addEventListener("message", (e) => window.__got.push(e.data));
        </script><iframe src="${"EXT"}/artifact-probe.html?p=top-post&h=http://leak.test:${port}"></iframe>`;
    const web = http.createServer((req, res) => {
        const m = /^\/hit\/([\w-]+)/.exec(req.url);
        if (m) count(m[1]);
        if (req.url.startsWith("/site?ext=")) {
            const ext = decodeURIComponent(req.url.slice("/site?ext=".length));
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(site(web.address().port).replace("EXT", ext));
        }
        res.writeHead(200, { "content-type": "text/css" });
        res.end("");
    });
    web.on("upgrade", (req, sock) => { const m = /^\/hit\/([\w-]+)/.exec(req.url); if (m) count(m[1]); sock.destroy(); });
    const tcp = net.createServer((s) => { count("preconnect"); s.destroy(); });
    const udp = dgram.createSocket("udp4");
    udp.on("message", () => count("webrtc-stun"));
    await new Promise((r) => web.listen(0, "127.0.0.1", r));
    await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
    await new Promise((r) => udp.bind(0, "127.0.0.1", r));
    return {
        cfg: { h: `http://leak.test:${web.address().port}`, t: String(tcp.address().port), u: String(udp.address().port) },
        siteUrl: (ext) => `http://leak.test:${web.address().port}/site?ext=${encodeURIComponent(ext)}`,
        hits,
        stop: async () => { web.closeAllConnections?.(); await new Promise((r) => web.close(r)); await new Promise((r) => tcp.close(r)); udp.close(); },
    };
}

/** Launch the extension built at `dist` with `leak.test` and `pre.test` resolving to the counting servers. */
function launchWith(dist) {
    return launchExtension({
        dist,
        args: [
            "--host-resolver-rules=MAP leak.test 127.0.0.1, MAP pre.test 127.0.0.1",
            // The counting server is on loopback; Chromium's local-network checks would refuse loads that CSP would let
            // reach a public host, so they are off: the wall under test is the sandbox and the CSPs, not those checks.
            "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests",
        ],
    });
}

/** Run every probe under `variant`, waiting for the routes `expected` says leak (so a slow machine cannot pass them off
 * as blocked) and then a further settle for any that are not expected; returns which routes reached the server, what
 * each frame said, and what reached a site embedding the frame. */
async function measure(variant, expected) {
    const counters = await startCounters();
    const dist = distFor(variant);
    const ext = await launchWith(dist);
    try {
        const host = await ext.context.newPage();
        await host.goto(`chrome-extension://${ext.extensionId}/artifact-probe-host.html`);
        await host.evaluate(([names, cfg]) => window.__embed(names, cfg), [PROBES, counters.cfg]);
        await expect.poll(() => expected.filter((p) => !counters.hits.get(p)), { timeout: 20_000 }).toEqual([]);
        await host.waitForTimeout(3000);
        const said = await host.evaluate(() => window.__said).catch(() => []);
        const site = await ext.context.newPage();
        // The frame's per-session origin (`use_dynamic_url`), as a site that learned it would frame it: the extension's id
        // alone no longer loads a web-accessible file into a web page.
        const framed = (await ext.sw.evaluate(() => chrome.runtime.getURL("artifact-probe.html"))).replace(/\/artifact-probe\.html$/, "");
        await site.goto(counters.siteUrl(framed));
        await site.waitForTimeout(1500);
        const topPost = await site.evaluate(() => window.__got);
        return { reached: Object.fromEntries(PROBES.map((p) => [p, counters.hits.get(p) || 0])), said, topPost };
    } finally {
        await ext.close();
        await counters.stop();
        fs.rmSync(dist, { recursive: true, force: true });
    }
}

// --- the measurement: every route, every variant ---

// The routes that DO reach the server under each variant; every other route must reach nothing. Measured 2026-10-24
// (Chromium from Playwright). Navigation of the frame itself is stopped only by the EMBEDDER's frame-src; CSS, font,
// media and prefetch loads only by the sandbox CSP's default-src. Preconnect (a TCP connect whose hostname can carry
// data through DNS) and WebRTC's STUN (UDP) are governed by no CSP directive: they leave any window. A worker has
// neither, nor a `top` to post to, so an evaluator in one is the variant with nothing out.
const NAV_SELF = ["nav-location", "nav-meta", "nav-anchor", "nav-data-chain", "nav-blob-chain"];
const SUBRESOURCES = ["css-link", "css-import", "font", "video", "audio", "prefetch", "preload-style"];
const NO_CSP_GOVERNS = ["preconnect", "webrtc-stun"];
const WORKER_ROUTES = PROBES.filter((p) => p.startsWith("w-"));
const EXPECT = {
    today: [...NAV_SELF, ...SUBRESOURCES, ...NO_CSP_GOVERNS],
    "sandbox-csp": [...NAV_SELF, ...NO_CSP_GOVERNS],
    wall: [...NO_CSP_GOVERNS],
    "wall+worker": [...NO_CSP_GOVERNS],
};

test.describe.configure({ mode: "default" });
for (const variant of Object.keys(VARIANTS)) {
    test(`artifact wall, ${variant}: exactly the expected routes leave the sandbox frame`, async () => {
        test.setTimeout(90_000);
        const r = await measure(variant, EXPECT[variant]);
        fs.mkdirSync(path.join(HERE, "artifacts"), { recursive: true });
        fs.writeFileSync(path.join(HERE, `artifacts/artifact-wall-${variant}.json`), JSON.stringify(r, null, 2));
        expect(PROBES.filter((p) => r.reached[p] > 0).sort(), "the routes that reached the counting server").toEqual([...EXPECT[variant]].sort());
        // Every probe ran, so a route counted as blocked was tried; a worker starts only where worker-src allows a blob.
        const ran = new Set(r.said.filter((s) => s.ran).map((s) => s.probe));
        const workerStarts = variant === "wall+worker";
        expect(PROBES.filter((p) => !ran.has(p)), "probes that never ran").toEqual(workerStarts ? [] : WORKER_ROUTES);
        if (workerStarts) for (const s of r.said.filter((x) => x.probe.startsWith("w-") && x.ran))
            expect(s.has, `${s.probe}: window-only names in the worker's scope`).toEqual([]);
        // The frame's `top` is whoever embeds it: under the in-page sidebar, the site. No CSP stops this message.
        expect(r.topPost).toEqual([{ leak: "artifact-secret" }]);
    });
}

// --- the evaluator in that worker: an artifact's scripts, run where nothing gets out (spike Q2) ---

test("the read-only evaluator runs in the frame's blob worker: the realm's reads answer, its escapes refuse", async () => {
    test.setTimeout(60_000);
    const dist = distFor("wall+worker");
    const ext = await launchWith(dist);
    try {
        const host = await ext.context.newPage();
        await host.goto(`chrome-extension://${ext.extensionId}/artifact-probe-host.html`);
        const { startMs } = await host.evaluate(() => window.__evalFrame());
        const current = { messages: [{ role: "user", content: "plan the week" }, { role: "assistant", content: "ok" }], run: { id: "r1" }, meta: [{}, {}], log: [] };
        const state = { todos: [{ text: "write spec", done: true }, { text: "run spike", done: false }, { text: "estimate", done: false }] };
        const run = (code) => host.evaluate(([c, cur, g]) => window.__run(c, cur, g), [code, current, { state }]);
        const r = {
            todo: await run("state.todos.filter(t => !t.done).map(t => t.text)"),
            current: await run("ml.current.messages.map(m => m.role + ': ' + m.content).join('\\n')"),
            fetch: await run("fetch('http://leak.test/x')"),
            global: await run("globalThis.postMessage('x')"),
            self: await run("self"),
            budget: await run("let n = 0; for (const a of Array(2000)) for (const b of Array(2000)) n++; n"),
        };
        fs.mkdirSync(path.join(HERE, "artifacts"), { recursive: true });
        fs.writeFileSync(path.join(HERE, "artifacts/artifact-wall-evaluator.json"), JSON.stringify({ bundleBytes: EVAL_SRC.length, startMs, r }, null, 2));
        console.log(`[evaluator] bundle ${EVAL_SRC.length} bytes, worker ready in ${startMs.toFixed(1)} ms`, JSON.stringify(r, null, 1));
        expect(r.todo).toMatchObject({ ok: true, value: ["run spike", "estimate"] });
        expect(r.current).toMatchObject({ ok: true, value: "user: plan the week\nassistant: ok" });
        for (const k of ["fetch", "global", "self", "budget"]) expect(r[k].ok, `${k} is refused`).toBe(false);
        expect(r.budget.error).toMatch(/too much work/);
    } finally { await ext.close(); fs.rmSync(dist, { recursive: true, force: true }); }
});
