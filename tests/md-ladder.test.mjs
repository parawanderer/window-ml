"use strict";
// The Markdown negotiation ladder (sw-fetch.ts `fetchUrlContent`), driven against a scripted fetch. Every
// scenario here is a behaviour measured on a real docs platform — see the probe notes in dom.ts.
import { test } from "node:test";
import assert from "node:assert";

globalThis.chrome = { debugger: {}, tabs: {}, windows: {}, scripting: {}, runtime: {}, extension: {}, permissions: {}, action: {} };
const { fetchUrlContent } = await import("../src/sw-fetch.ts");

const MD = "text/markdown; charset=utf-8";
const HTML = "text/html; charset=utf-8";
const res = (url, status, contentType, body, redirected = false) => ({
    ok: status >= 200 && status < 300, status, url, redirected,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
});
/** Script the network as a url -> response map; unlisted urls 404 with an HTML error page (what a real docs
 *  site serves for a missing `.md`, and the reason a status check alone is not enough). */
function net(map) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, accept: init?.headers?.Accept ?? init?.headers?.accept });
        const r = map[url];
        return r ? r(url) : res(url, 404, HTML, "<!doctype html><html><body>Not found</body></html>");
    };
    return calls;
}
const page = (body) => (url) => res(url, 200, HTML, body);
const md = (body) => (url) => res(url, 200, MD, body);
const PLAIN_PAGE = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const declaring = (href) => `<!doctype html><html><head><link rel="alternate" type="text/markdown" href="${href}"></head><body><h1>Hi</h1></body></html>`;
// The sibling rung's negative cache is SW-LIFETIME module state (by design — see sw-fetch), so a test that
// lets an origin miss poisons that origin for every later test. Each test below therefore uses its OWN origin;
// the one test that deliberately exercises the cache asserts it across two pages of a single origin.
const by = (r) => r.negotiation?.resolvedBy;
const rung = (r, s) => r.negotiation.attempts.find((a) => a.strategy === s);

test("rung 1: content negotiation alone resolves it, and nothing else is attempted", async () => {
    const calls = net({ "https://d.test/guide": md("# Guide\n\nText.") });
    const r = await fetchUrlContent("https://d.test/guide");
    assert.equal(by(r), "accept");
    assert.equal(r.type, "markdown");
    assert.match(r.text, /# Guide/);
    assert.equal(calls.length, 1, "ONE request — the negotiated GET is never a HEAD and never wasted");
    assert.match(calls[0].accept, /^text\/markdown/, "Markdown ranked first");
    assert.match(calls[0].accept, /\*\/\*/, "…but everything still welcome, so a strict negotiator can't 406 us");
    for (const s of ["declared", "sibling", "convert"]) assert.equal(rung(r, s).outcome, "skipped");
});

test("rung 2: the page DECLARES its twin, and that beats deriving one", async () => {
    // docs.github.com publishes at /api/article/body?pathname=… — no derivation would ever find it.
    const declared = "https://d.test/api/article/body?pathname=/guide";
    const calls = net({ "https://d.test/guide": page(declaring(declared)), [declared]: md("# Declared\n\nText.") });
    const r = await fetchUrlContent("https://d.test/guide");
    assert.equal(by(r), "declared");
    assert.match(r.text, /# Declared/);
    assert.equal(r.url, declared, "the result reports the URL the bytes came from");
    assert.equal(calls.length, 2);
    assert.equal(rung(r, "sibling").outcome, "skipped", "no need to guess once the site has named it");
});

test("rung 3: with no declaration, the sibling is derived — by the trailing slash", async () => {
    net({ "https://d.test/guide": page(PLAIN_PAGE), "https://d.test/guide.md": md("# Sibling") });
    const r = await fetchUrlContent("https://d.test/guide");
    assert.equal(by(r), "sibling");
    assert.equal(rung(r, "sibling").url, "https://d.test/guide.md");

    // Cloudflare's shape: a trailing slash takes index.md, and `guide.md` would 404.
    net({ "https://d.test/guide/": page(PLAIN_PAGE), "https://d.test/guide/index.md": md("# Index") });
    const r2 = await fetchUrlContent("https://d.test/guide/");
    assert.equal(by(r2), "sibling");
    assert.equal(rung(r2, "sibling").url, "https://d.test/guide/index.md");
});

test("rung 4: everything misses, so we convert the HTML ourselves — and say it is OURS", async () => {
    net({ "https://conv.test/guide": page(PLAIN_PAGE) });
    const r = await fetchUrlContent("https://conv.test/guide");
    assert.equal(by(r), "convert");
    assert.equal(r.type, "html", "the body is still the HTML; the conversion happens page-side");
    // The rung's note stays short; "whose Markdown is this" is carried by the resolved-by label, which
    // tests/fetch-ladder.test.mjs pins — saying it in both places just made the row wrap.
    assert.match(rung(r, "convert").note, /stripped/, "says what the conversion did to the page");
    assert.equal(rung(r, "sibling").outcome, "not-markdown");
});

// The failure mode is not a 404 — docs.github.com answers `…/index.md` with 359KB of HTML.
test("a 200 text/html SPA catch-all is NOT accepted as the twin", async () => {
    net({ "https://spa.test/guide": page(PLAIN_PAGE), "https://spa.test/guide.md": page("<!doctype html><html><body>app shell</body></html>") });
    const r = await fetchUrlContent("https://spa.test/guide");
    assert.equal(by(r), "convert", "the catch-all was rejected and we fell through");
    assert.equal(rung(r, "sibling").outcome, "not-markdown");
});

// A declaration is page-controlled, unlike a derived sibling. Following a cross-origin one under this page's
// grant would turn "read this page as Markdown" into "fetch whatever the page names".
test("a CROSS-ORIGIN declaration is refused, and the ladder carries on", async () => {
    const calls = net({ "https://xorig.test/guide": page(declaring("https://evil.test/x.md")), "https://xorig.test/guide.md": md("# Own") });
    const r = await fetchUrlContent("https://xorig.test/guide");
    assert.equal(by(r), "sibling", "fell through to the origin-safe rung");
    assert.match(rung(r, "declared").note, /cross-origin/);
    assert.ok(!calls.some((c) => c.url.includes("evil.test")), "and never requested it");
});

test("a data body stops the ladder at rung 1 — an API pays exactly one request", async () => {
    const calls = net({ "https://d.test/api": (u) => res(u, 200, "application/json", '{"a":1}') });
    const r = await fetchUrlContent("https://d.test/api");
    assert.equal(calls.length, 1);
    assert.equal(r.type, "json");
    assert.deepEqual(r.json, { a: 1 });
    assert.match(rung(r, "declared").note, /not a document/);
});

test("a URL that already names a data file never negotiates at all", async () => {
    const calls = net({ "https://d.test/data.json": (u) => res(u, 200, "application/json", '{"a":1}') });
    const r = await fetchUrlContent("https://d.test/data.json");
    assert.equal(calls.length, 1);
    assert.equal(r.negotiation, undefined, "no ladder ran");
    assert.doesNotMatch(calls[0].accept, /^text\/markdown/, "and the Markdown-first Accept was not sent to an API");
});

test('format:"html" skips the ladder entirely', async () => {
    const calls = net({ "https://d.test/guide": page(PLAIN_PAGE), "https://d.test/guide.md": md("# Sibling") });
    const r = await fetchUrlContent("https://d.test/guide", false, "html");
    assert.equal(calls.length, 1, "one plain request");
    assert.equal(r.negotiation, undefined);
    assert.equal(r.type, "html");
    assert.doesNotMatch(calls[0].accept, /^text\/markdown/);
});

// A redirect is how `…/guide` becomes `…/guide/`, which is exactly what flips the sibling to index.md.
test("later rungs derive from the FINAL url, not the requested one", async () => {
    net({
        "https://redir.test/guide": (u) => ({ ...res(u, 200, HTML, PLAIN_PAGE, true), url: "https://redir.test/guide/" }),
        "https://redir.test/guide/index.md": md("# Landed"),
    });
    const r = await fetchUrlContent("https://redir.test/guide");
    assert.equal(by(r), "sibling");
    assert.equal(rung(r, "sibling").url, "https://redir.test/guide/index.md");
});

test("an origin with no sibling is not asked twice", async () => {
    const calls = net({ "https://nosib.test/a": page(PLAIN_PAGE), "https://nosib.test/b": page(PLAIN_PAGE) });
    const first = await fetchUrlContent("https://nosib.test/a");
    assert.equal(rung(first, "sibling").outcome, "not-markdown");
    const n = calls.length;
    const second = await fetchUrlContent("https://nosib.test/b");
    assert.equal(rung(second, "sibling").outcome, "skipped");
    assert.match(rung(second, "sibling").note, /seen earlier/);
    assert.equal(calls.length - n, 1, "the second page cost only its own negotiated GET");
});

test("a rung that throws is recorded and the ladder continues", async () => {
    net({
        "https://boom.test/guide": page(declaring("https://boom.test/boom.md")),
        "https://boom.test/boom.md": () => { throw new Error("network down"); },
        "https://boom.test/guide.md": md("# Recovered"),
    });
    const r = await fetchUrlContent("https://boom.test/guide");
    assert.equal(by(r), "sibling");
    assert.equal(rung(r, "declared").outcome, "error");
    assert.match(rung(r, "declared").note, /network down/);
});

// A DECLARED url is the site's own claim, and a claim can be wrong — a stale link, a moved endpoint, an SPA
// catch-all behind it. Trusting it because the page said so would strand the ladder one rung early.
test("a declared twin that isn't markdown falls through to the derived sibling", async () => {
    net({
        "https://decl.test/guide": page(declaring("https://decl.test/stale.md")),
        "https://decl.test/stale.md": page("<!doctype html><html><body>moved</body></html>"),
        "https://decl.test/guide.md": md("# Recovered"),
    });
    const r = await fetchUrlContent("https://decl.test/guide");
    assert.equal(by(r), "sibling", "the ladder kept going");
    assert.equal(rung(r, "declared").outcome, "not-markdown");
    assert.match(r.text, /# Recovered/);
});

// Some URLs have no sibling to derive: a site root, or a url that already names a markdown file. The rung
// must say so rather than fetching something invented.
test("a URL with nothing to derive skips the sibling rung with a reason", async () => {
    net({ "https://root.test/": page(PLAIN_PAGE) });
    const r = await fetchUrlContent("https://root.test/");
    assert.equal(rung(r, "sibling").outcome, "skipped");
    assert.match(rung(r, "sibling").note, /nothing to derive/);
    assert.equal(by(r), "convert", "…and the ladder still finishes");
});

// The sibling is a GUESS at a url that may not exist, so a network failure there is expected traffic, not an
// exception the caller should see. (The declared-rung throw is covered above; this is the other one.)
test("a sibling fetch that THROWS is recorded and the ladder still finishes", async () => {
    net({
        "https://boom2.test/guide": page(PLAIN_PAGE),
        "https://boom2.test/guide.md": () => { throw new Error("DNS failure"); },
    });
    const r = await fetchUrlContent("https://boom2.test/guide");
    assert.equal(by(r), "convert");
    assert.equal(rung(r, "sibling").outcome, "error");
    assert.match(rung(r, "sibling").note, /DNS failure/);
});

// A credentialed fetch is the gated as-you path. Every rung must carry that decision — a twin fetched
// WITHOUT the user's session would silently be the logged-out page, which is a different document.
test("credentials carry to every rung, not just the first request", async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
        seen.push({ url, credentials: init?.credentials });
        if (url === "https://cred.test/guide") return res(url, 200, HTML, PLAIN_PAGE);
        if (url === "https://cred.test/guide.md") return md("# Private")(url);
        return res(url, 404, HTML, "nope");
    };
    const r = await fetchUrlContent("https://cred.test/guide", true);
    assert.equal(by(r), "sibling");
    assert.ok(seen.length >= 2, "more than one request was made");
    for (const call of seen) assert.equal(call.credentials, "include", `${call.url} lost the session`);

    // …and the uncredentialed default must NOT send cookies on any rung either.
    seen.length = 0;
    await fetchUrlContent("https://cred2.test/guide").catch(() => {});
    for (const call of seen) assert.equal(call.credentials, "omit", `${call.url} sent cookies it should not have`);
});

// A server may send no Content-Type at all. The rung must then judge by CONTENT alone rather than treating a
// missing header as a miss — the twin is still the twin. (Found by coverage: this was the only branch inside
// the ladder that no test reached and that can actually happen; the rest are defensive fallbacks against
// things a real `fetch` cannot produce.)
test("a twin served with NO content-type is judged by its content", async () => {
    const noType = (body) => (url) => ({
        ok: true, status: 200, url, redirected: false,
        headers: new Headers(), text: async () => body,
    });
    net({ "https://noct.test/guide": noType("# Guide\n\nReal markdown, unlabelled.") });
    const r = await fetchUrlContent("https://noct.test/guide");
    assert.equal(by(r), "accept", "prose with no header is accepted, not rejected for lacking one");
    assert.equal(rung(r, "accept").contentType, "", "…and the trace records that there was none");

    // …while HTML with no header is still HTML, because the sniff carries the decision either way.
    net({ "https://noct2.test/guide": noType(PLAIN_PAGE) });
    const r2 = await fetchUrlContent("https://noct2.test/guide");
    assert.equal(by(r2), "convert", "a missing header is not a licence to accept tag soup");
});
