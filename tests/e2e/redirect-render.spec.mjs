// redirect-render.spec.mjs — a rendered fetch_url's tab follows a redirect only to a hop it judged (SITE_PRESENCE step 5).
//
// The render tab opens blank and a declarativeNetRequest session rule scoped to it blocks main- and sub-frame requests
// off the first URL's site before they leave (sw-redirects.ts, guardRenderTab). One server answers every hostname; it
// records each request, so "never requested" is asserted on the server, not inferred from the result.

import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

test.describe.configure({ mode: "default" });

/** The tool results the driver was sent in its last call, in order. */
const toolResults = (fake) => (fake.calls().filter((c) => c.tools?.length).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

/** A server for every `*.test` name: `/r/<status>/<encoded target>` redirects, `/js/<target>` navigates by script,
 *  `/frames` embeds a same-site and a cross-site frame, anything else is a page naming its host and path. */
async function serve() {
    const hits = [];
    const srv = http.createServer((q, s) => {
        const host = String(q.headers.host).split(":")[0];
        hits.push(host + q.url);
        const m = q.url.match(/^\/r\/(\d+)\/(.*)$/);
        if (m) { s.writeHead(Number(m[1]), { Location: decodeURIComponent(m[2]) }); return s.end(); }
        s.writeHead(200, { "content-type": "text/html" });
        if (q.url.startsWith("/js/")) return s.end(`<p>leaving</p><script>location.href=${JSON.stringify(decodeURIComponent(q.url.slice(4)))}</script>`);
        if (q.url === "/frames") return s.end(`<p>framed</p><iframe src="http://ads.test:${port}/ad"></iframe><iframe src="http://cdn.site.test:${port}/ok"></iframe>`);
        if (q.url === "/favicon.ico") return s.end("");
        s.end(`<!doctype html><title>t</title><p>page at ${host}${q.url}</p>`);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    return { hits, url: (host, path) => `http://${host}:${port}${path}`, close: () => new Promise((r) => srv.close(r)) };
}

const enc = encodeURIComponent;
/** A page-hosted run's fetch goes through the page, which is told only that the hop left for another site: the
 *  `Location` of a response its own fetch could not have read is not ours to hand it (SITE_PRESENCE step 5). */
const ANOTHER_SITE = "redirected to a different origin on another site";

/** Start a run on `home` whose model fetches `steps` (each a fetch_url args object) and then answers; return its tool
 *  results. Credentials are off, so a cross-origin render runs incognito when allowed, else in the session tab it asks
 *  for; the gates are approved here, as a person would. */
async function runFetches(ext, fake, page, steps) {
    fake.setScript([...steps.map((args) => ({ tool: "fetch_url", args })), { content: "done" }]);
    const before = fake.calls().length;
    await page.evaluate(() => { window.ml.agent("Fetch them.", { env: false, approvalRouting: "external" }); return true; });
    for (let i = 0; i < 600 && fake.calls().length - before < steps.length + 1; i++) {
        await ext.sw.evaluate(() => { for (const d of globalThis.__mlApprovals?.list?.() || []) globalThis.__mlApprovals.resolve(d.key, true); });
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(fake.calls().length - before, "every step reached the model").toBe(steps.length + 1);
    return toolResults(fake);
}

let fake, srv, ext, page;
test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    srv = await serve();
    ext = await launchExtension({ args: ["--host-resolver-rules=MAP *.test 127.0.0.1",
        "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests"] });
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
    page = await ext.context.newPage();
    await page.goto(srv.url("a.site.test", "/home"));
    await waitForMl(page);
});
test.afterAll(async () => { await ext?.close(); fake?.stop?.(); await srv?.close(); });

// --- a rendered fetch on the run's own origin, credentialed (the session tab, free on the same origin) ---

test("a same-site redirect chain is followed, and the page it lands on is read", async () => {
    srv.hits.length = 0;
    const url = srv.url("a.site.test", `/r/302/${enc(srv.url("b.site.test", "/landed"))}`);
    const [out] = await runFetches(ext, fake, page, [{ url, rendered: true, credentials: true }]);
    expect(out).toContain("page at b.site.test/landed");
    expect(srv.hits).toContain("b.site.test/landed");
});

test("a cross-site hop is refused before its target is requested", async () => {
    srv.hits.length = 0;
    const target = srv.url("evil.test", "/x");
    const url = srv.url("a.site.test", `/r/302/${enc(target)}`);
    const [out] = await runFetches(ext, fake, page, [{ url, rendered: true, credentials: true }]);
    expect(out).toContain(ANOTHER_SITE);
    expect(srv.hits.filter((h) => h.startsWith("evil.test")), "the target got no request").toEqual([]);
});

test("a chain whose second hop leaves the site is refused at that hop", async () => {
    srv.hits.length = 0;
    const target = srv.url("evil.test", "/y");
    const url = srv.url("a.site.test", `/r/302/${enc(srv.url("b.site.test", `/r/301/${enc(target)}`))}`);
    const [out] = await runFetches(ext, fake, page, [{ url, rendered: true, credentials: true }]);
    expect(out).toContain(ANOTHER_SITE);
    expect(srv.hits.some((h) => h.startsWith("b.site.test/r/301")), "the allowed hop ran").toBe(true);
    expect(srv.hits.filter((h) => h.startsWith("evil.test"))).toEqual([]);
});

test("a script navigation off the site is held the same way", async () => {
    srv.hits.length = 0;
    const target = srv.url("evil.test", "/z");
    const [out] = await runFetches(ext, fake, page, [{ url: srv.url("a.site.test", `/js/${target}`), rendered: true, credentials: true }]);
    expect(out).toContain(ANOTHER_SITE);
    expect(srv.hits.filter((h) => h.startsWith("evil.test"))).toEqual([]);
});

test("a cross-site frame is not loaded, a same-site one is, and the render still reads", async () => {
    srv.hits.length = 0;
    const [out] = await runFetches(ext, fake, page, [{ url: srv.url("a.site.test", "/frames"), rendered: true, credentials: true }]);
    expect(out).toContain("framed");
    expect(srv.hits).toContain("cdn.site.test/ok");
    expect(srv.hits.filter((h) => h.startsWith("ads.test"))).toEqual([]);
});

test("a hop to a URL the run already approved is followed", async () => {
    srv.hits.length = 0;
    const target = srv.url("partner.test", "/ok");
    const url = srv.url("a.site.test", `/r/302/${enc(target)}`);
    // The first step approves the target itself (a gated cross-origin fetch, approved here, which the run remembers); the
    // second reaches it through the redirect.
    const outs = await runFetches(ext, fake, page, [{ url: target }, { url, rendered: true, credentials: true }]);
    expect(outs.at(-1)).toContain("page at partner.test/ok");
});

test("no render rule is left behind", async () => {
    const left = await ext.sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id));
    expect(left).toEqual([]);
});
