"use strict";
// sw-redirects.test.mjs — a worker fetch follows a redirect hop only when a judge allows it (src/sw/sw-redirects.ts).
//
// `judgedFetch` fetches each hop with `redirect: "manual"` and reads the 3xx's Location from
// `chrome.webRequest.onHeadersReceived`, which fires before `fetch` resolves. The stubs here play that: a `fetch` that
// answers `{ type: "opaqueredirect" }` and, synchronously, fires the registered listener with the headers Chrome would
// report. The module keeps its state (the listener, the in-flight maps) at module level; every test uses URLs of its own,
// and every path out of `hopOnce` clears its entry, so tests do not see each other's hops. The same module is also
// exercised through the real worker bundle (FETCH_IMAGE_B64) for the image fetch's per-hop rule.
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const listeners = [];
/** A webRequest event a render guard listens to: its listeners, and `fire(details)`. */
const navEvent = () => { const fns = new Set(); return { fns, addListener: (fn) => fns.add(fn), removeListener: (fn) => fns.delete(fn), fire: (d) => { for (const fn of fns) fn(d); } }; };
/** The session rules, by id, and the tabs open now, for the render guard's tests. */
const dnr = { rules: new Map(), fail: false };
let openTabs = [];
globalThis.chrome = {
    debugger: {}, windows: {}, scripting: {}, extension: {}, permissions: { contains: async () => true }, action: {},
    tabs: { query: async () => openTabs.map((id) => ({ id })) },
    runtime: { getURL: (p = "") => `chrome-extension://test/${p}` },
    webRequest: { onHeadersReceived: { addListener: (fn) => listeners.push(fn) }, onBeforeRedirect: navEvent(), onCompleted: navEvent(), onErrorOccurred: navEvent() },
    declarativeNetRequest: {
        getSessionRules: async () => [...dnr.rules.values()],
        updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
            if (dnr.fail) throw new Error("rule refused");
            for (const id of removeRuleIds) dnr.rules.delete(id);
            for (const r of addRules) dnr.rules.set(r.id, structuredClone(r));
        },
    },
};
const { judgedFetch, hopIsOwn, watchRedirects, prepareRenderGuard, RENDER_RULE_BASE, MAX_HOPS, HOP_EVENT_WAIT_MS, RedirectRefused } = await import("../src/sw/sw-redirects.ts");
const { sheetHop, fetchSheetCsv } = await import("../src/sw/sw-fetch.ts");
watchRedirects();
watchRedirects();   // once
const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

// Node reports an opaque origin ("null") for a chrome-extension: URL; the worker compares against the same computation.
const ORIGIN = new URL("chrome-extension://test/").origin;
/** Fire the headers event Chrome reports for the worker's own request. */
function headers(url, { status = 302, loc, tabId = -1, initiator = ORIGIN } = {}) {
    const locs = loc == null ? [] : Array.isArray(loc) ? loc : [loc];
    const d = { tabId, statusCode: status, url, initiator, responseHeaders: locs.map((value) => ({ name: "Location", value })) };
    for (const fn of listeners) fn(d);
}
const plain = (url, extra = {}) => ({ type: "basic", ok: true, status: 200, url, headers: new Headers(), body: { cancel: async () => {} }, ...extra });

/**
 * Script the network: `routes[url]` is `{ loc, ...eventOpts }` for a 3xx (an opaque response plus the event), or a function
 * returning a response. Returns the list of URLs requested, in order.
 */
function net(routes) {
    const requested = [];
    globalThis.fetch = async (url, init) => {
        requested.push(String(url));
        assert.equal(init.redirect, "manual", "every hop is fetched with redirect:manual");
        const r = routes[url];
        if (!r) return plain(url, { ok: false, status: 404 });
        if (typeof r === "function") return r(url);
        // The event's URL is the network's: no fragment.
        const bare = new URL(url); bare.hash = "";
        headers(bare.href, r);
        return { type: "opaqueredirect", ok: false, status: 0, url: "", body: null };
    };
    return requested;
}
const all = () => true;
const none = () => false;

// --- hopIsOwn: the hops that need no approval ---

test("hopIsOwn over an enumerated table", () => {
    const rows = [
        // from, to, expected, why
        ["https://a.example/x", "https://a.example/y", true, "same host"],
        ["https://a.example/x", "https://www.a.example/y", true, "subdomain of the same site"],
        ["https://www.a.example/x", "https://api.a.example/y", true, "sibling subdomains"],
        ["https://a.example/x", "https://b.example/y", false, "another site"],
        ["https://a.example/x", "https://a.example.evil.test/y", false, "a lookalike suffix"],
        ["https://alice.github.io/x", "https://bob.github.io/y", false, "*.github.io siblings are different sites (private suffix)"],
        ["https://alice.github.io/x", "https://alice.github.io/y", true, "same github.io site"],
        ["http://a.example/x", "https://a.example/x", true, "http to https on the same host"],
        ["http://a.example/x", "https://b.example/x", false, "http to https on another host"],
        ["http://a.example:8080/x", "https://a.example/x", true, "http to https, port dropped, same host"],
        ["https://a.example/x", "http://a.example/x", true, "https to http on the same site is judged on its site, which matches"],
        ["https://a.example/x", "http://b.example/x", false, "https to http on another site"],
        ["http://localhost:3000/x", "http://localhost:4000/y", true, "localhost keeps its host as its site, ports aside"],
        ["http://localhost:3000/x", "http://127.0.0.1:3000/y", false, "localhost to a loopback IP is a different name"],
        ["http://10.0.0.1/x", "http://10.0.0.1:8080/y", true, "same IP, another port"],
        ["http://10.0.0.1/x", "http://10.0.0.2/y", false, "another IP"],
        ["https://a.example/x", "ftp://a.example/y", false, "non-http target"],
        ["https://a.example/x", "data:text/plain,hi", false, "data: target"],
        ["https://a.example/x", "javascript:alert(1)", false, "javascript: target"],
        ["https://a.example/x", "not a url", false, "unparsable target"],
        ["not a url", "https://a.example/x", false, "unparsable origin"],
    ];
    for (const [from, to, want, why] of rows) assert.equal(hopIsOwn(from, to), want, `${from} -> ${to}: ${why}`);
});

// --- judgedFetch: the hop loop ---

test("judgedFetch with no redirect returns the response untouched and not redirected", async () => {
    const requested = net({ "https://j1.test/": (u) => plain(u) });
    const res = await judgedFetch("https://j1.test/", {}, none);
    assert.equal(res.status, 200);
    assert.notEqual(res.redirected, true);
    assert.deepEqual(requested, ["https://j1.test/"]);
});

test("judgedFetch follows a chain the judge allows, in order, and marks the answer redirected", async () => {
    const seen = [];
    const requested = net({
        "https://j2.test/a": { loc: "https://j2.test/b" },
        "https://j2.test/b": { loc: "https://other.test/c", status: 301 },
        "https://other.test/c": (u) => plain(u),
    });
    const res = await judgedFetch("https://j2.test/a", {}, (h) => (seen.push(h), true));
    assert.deepEqual(requested, ["https://j2.test/a", "https://j2.test/b", "https://other.test/c"]);
    assert.deepEqual(seen, [{ from: "https://j2.test/a", to: "https://j2.test/b" }, { from: "https://j2.test/b", to: "https://other.test/c" }]);
    assert.equal(res.redirected, true);
    assert.equal(res.url, "https://other.test/c");
});

test("a refused hop throws RedirectRefused naming the hop, and its target is never requested", async () => {
    const requested = net({
        "https://j3.test/a": { loc: "https://j3.test/b" },
        "https://j3.test/b": { loc: "https://victim.test/secret" },
        "https://victim.test/secret": (u) => plain(u),
    });
    const err = await judgedFetch("https://j3.test/a", {}, ({ to }) => to.startsWith("https://j3.test/")).catch((e) => e);
    assert.ok(err instanceof RedirectRefused);
    assert.deepEqual(err.hop, { from: "https://j3.test/b", to: "https://victim.test/secret" });
    assert.deepEqual(requested, ["https://j3.test/a", "https://j3.test/b"], "the refused target was not requested");
});

test("a 3xx with no Location is refused with an unreadable target", async () => {
    const requested = net({ "https://j4.test/a": { loc: null } });
    const err = await judgedFetch("https://j4.test/a", {}, all).catch((e) => e);
    assert.ok(err instanceof RedirectRefused);
    assert.deepEqual(err.hop, { from: "https://j4.test/a", to: null });
    assert.equal(requested.length, 1);
});

test("two Location headers are refused, whatever the judge says", async () => {
    const requested = net({ "https://j5.test/a": { loc: ["https://j5.test/b", "https://evil.test/"] } });
    const err = await judgedFetch("https://j5.test/a", {}, all).catch((e) => e);
    assert.ok(err instanceof RedirectRefused && err.hop.to === null);
    assert.deepEqual(requested, ["https://j5.test/a"]);
});

test("an event that lands AFTER fetch resolves (within HOP_EVENT_WAIT_MS) is still read and followed", async () => {
    const requested = net({
        "https://j18.test/a": (u) => { setTimeout(() => headers(u, { loc: "https://j18.test/b" }), 20); return { type: "opaqueredirect", body: null }; },
        "https://j18.test/b": (u) => plain(u),
    });
    const res = await judgedFetch("https://j18.test/a", {}, all);
    assert.equal(res.url, "https://j18.test/b");
    assert.deepEqual(requested, ["https://j18.test/a", "https://j18.test/b"]);
});

test("an event that never arrives is refused after HOP_EVENT_WAIT_MS, and a later fetch of the URL waits for the hold", async () => {
    assert.equal(HOP_EVENT_WAIT_MS, 2000);
    const requested = [];
    globalThis.fetch = async (url) => { requested.push(url); return { type: "opaqueredirect", body: null }; };
    const t0 = Date.now();
    const err = await judgedFetch("https://j19.test/a", {}, all).catch((e) => e);
    assert.ok(err instanceof RedirectRefused && err.hop.to === null);
    assert.ok(Date.now() - t0 >= HOP_EVENT_WAIT_MS - 100, "it waited for the event");
    // The URL is still held for a late event: a second fetch is not issued until that event lands or the hold ends.
    const second = judgedFetch("https://j19.test/a", {}, all).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(requested.length, 1, "the second fetch of a held URL has not been issued");
    headers("https://j19.test/a", { loc: "https://j19.test/late" });   // the late event, taken by NO later fetch
    const err2 = await second;
    assert.equal(requested.length, 2, "the hold released when the late event landed");
    assert.ok(err2 instanceof RedirectRefused && err2.hop.to === null, "the late event was not read as the second fetch's target");
});

test("a second 3xx event for the URL while one is waiting is refused", async () => {
    const requested = net({
        "https://j6.test/a": (u) => { headers(u, { loc: "https://j6.test/b" }); headers(u, { loc: "https://evil.test/" }); return { type: "opaqueredirect", body: null }; },
    });
    const err = await judgedFetch("https://j6.test/a", {}, all).catch((e) => e);
    assert.ok(err instanceof RedirectRefused && err.hop.to === null);
    assert.deepEqual(requested, ["https://j6.test/a"]);
});

test("a relative Location is resolved against the hop that sent it", async () => {
    const seen = [];
    net({
        "https://j7.test/dir/a": { loc: "../b?q=1" },
        "https://j7.test/b?q=1": { loc: "/c" },
        "https://j7.test/c": { loc: "//proto.test/d" },
        "https://proto.test/d": (u) => plain(u),
    });
    await judgedFetch("https://j7.test/dir/a", {}, (h) => (seen.push(h.to), true));
    assert.deepEqual(seen, ["https://j7.test/b?q=1", "https://j7.test/c", "https://proto.test/d"]);
});

test("events from a tab, a foreign initiator or a non-3xx are ignored, so the hop is unreadable", async () => {
    for (const [i, opts] of [{ tabId: 5 }, { initiator: "https://evil.test" }, { status: 200 }].entries()) {
        const url = `https://j8-${i}.test/a`;
        const requested = net({ [url]: { loc: "https://j8.test/elsewhere", ...opts } });
        const err = await judgedFetch(url, {}, all).catch((e) => e);
        assert.ok(err instanceof RedirectRefused && err.hop.to === null, `${JSON.stringify(opts)} must not supply a Location`);
        assert.deepEqual(requested, [url]);
    }
});

test("an event with no initiator is taken (the worker's own request may carry none)", async () => {
    net({ "https://j9.test/a": { loc: "https://j9.test/b", initiator: undefined }, "https://j9.test/b": (u) => plain(u) });
    const res = await judgedFetch("https://j9.test/a", {}, all);
    assert.equal(res.url, "https://j9.test/b");
});

test("a fragment in the requested URL still matches the network's event, which has none", async () => {
    const requested = net({ "https://j10.test/a#frag": { loc: "https://j10.test/b" }, "https://j10.test/b": (u) => plain(u) });
    const res = await judgedFetch("https://j10.test/a#frag", {}, all);
    assert.equal(res.url, "https://j10.test/b");
    assert.equal(requested.length, 2);
});

test("more than MAX_HOPS throws, after exactly MAX_HOPS + 1 requests", async () => {
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(url);
        const n = Number(new URL(url).searchParams.get("n"));
        headers(url, { loc: `https://j11.test/?n=${n + 1}` });
        return { type: "opaqueredirect", body: null };
    };
    const err = await judgedFetch("https://j11.test/?n=0", {}, all).catch((e) => e);
    assert.ok(err instanceof Error && !(err instanceof RedirectRefused));
    assert.match(err.message, /too many redirects/);
    assert.equal(requested.length, MAX_HOPS + 1);
});

test("exactly MAX_HOPS hops still resolve", async () => {
    globalThis.fetch = async (url) => {
        const n = Number(new URL(url).searchParams.get("n"));
        if (n >= MAX_HOPS) return plain(url);
        headers(url, { loc: `https://j12.test/?n=${n + 1}` });
        return { type: "opaqueredirect", body: null };
    };
    const res = await judgedFetch("https://j12.test/?n=0", {}, all);
    assert.equal(res.url, `https://j12.test/?n=${MAX_HOPS}`);
});

test("two concurrent fetches of one URL run one at a time: the second is not issued until the first resolves", async () => {
    const issued = [];
    const gates = [];
    globalThis.fetch = (url) => new Promise((resolve) => { issued.push(url); gates.push(() => resolve(plain(url))); });
    const a = judgedFetch("https://j13.test/a", {}, none);
    const b = judgedFetch("https://j13.test/a#other", {}, none);   // the same URL without its fragment
    const c = judgedFetch("https://j13.test/different", {}, none);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(issued, ["https://j13.test/a", "https://j13.test/different"], "only the first of the same-URL pair is in flight; another URL is not held");
    gates[0]();
    await a;
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(issued, ["https://j13.test/a", "https://j13.test/different", "https://j13.test/a#other"]);
    gates[1](); gates[2]();
    await Promise.all([b, c]);
});

test("a failed first fetch of a URL does not wedge the second", async () => {
    let n = 0;
    globalThis.fetch = async (url) => { if (n++ === 0) throw new TypeError("Failed to fetch"); return plain(url); };
    const a = judgedFetch("https://j14.test/a", {}, none).catch((e) => e);
    const b = judgedFetch("https://j14.test/a", {}, none);
    assert.ok((await a) instanceof TypeError);
    assert.equal((await b).status, 200);
});

test("two concurrent fetches of one URL each read their own redirect target", async () => {
    // Serialised, the headers event of the first cannot be taken by the second.
    let n = 0;
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(url);
        if (url === "https://j15.test/a") { const to = n++ === 0 ? "https://j15.test/x" : "https://j15.test/y"; headers(url, { loc: to }); return { type: "opaqueredirect", body: null }; }
        return plain(url);
    };
    const [r1, r2] = await Promise.all([judgedFetch("https://j15.test/a", {}, all), judgedFetch("https://j15.test/a", {}, all)]);
    assert.deepEqual([r1.url, r2.url], ["https://j15.test/x", "https://j15.test/y"]);
});

test("a response that followed on its own is judged after the fact: refused when the judge refuses, kept when it allows", async () => {
    let cancelled = 0;
    const followed = (u) => plain("https://landed.test/z", { body: { cancel: async () => { cancelled++; } } });
    net({ "https://j16.test/a": followed });
    const err = await judgedFetch("https://j16.test/a", {}, none).catch((e) => e);
    assert.ok(err instanceof RedirectRefused);
    assert.deepEqual(err.hop, { from: "https://j16.test/a", to: "https://landed.test/z" });
    assert.equal(cancelled, 1, "the body is dropped unread");
    const res = await judgedFetch("https://j16.test/a", {}, ({ to }) => to === "https://landed.test/z");
    assert.equal(res.url, "https://landed.test/z");
});

test("a stub answer whose url is the requested one (or only differs by a fragment) is not judged", async () => {
    net({ "https://j17.test/a#f": (u) => plain("https://j17.test/a") });
    assert.equal((await judgedFetch("https://j17.test/a#f", {}, none)).status, 200);
});

// --- sheetHop: where a Google Sheets export may be sent ---

test("sheetHop allows only https docs.google.com and *.googleusercontent.com", () => {
    const rows = [
        ["https://docs.google.com/spreadsheets/d/x/export?format=csv", true],
        ["https://doc-0k-sheets.googleusercontent.com/export/abc", true],
        ["https://googleusercontent.com/x", false],   // the bare domain is not a subdomain
        ["https://accounts.google.com/ServiceLogin", false],
        ["https://www.google.com/", false],
        ["http://docs.google.com/spreadsheets/d/x/export?", false],
        ["https://docs.google.com.evil.test/", false],
        ["https://evilgoogleusercontent.com/", false],
        ["https://evil.test/?u=docs.google.com", false],
        ["ftp://docs.google.com/", false],
        ["not a url", false],
    ];
    for (const [to, want] of rows) assert.equal(sheetHop({ from: "https://docs.google.com/", to }), want, to);
});

const sheet = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
const csvRes = (url) => plain(url, { headers: new Headers({ "content-type": "text/csv" }), text: async () => "a,b\n1,2\n" });

test("fetchSheetCsv follows docs.google.com -> googleusercontent.com", async () => {
    const SHEET = sheet("s0");
    net({ [SHEET]: { loc: "https://doc-1.googleusercontent.com/export/x" }, "https://doc-1.googleusercontent.com/export/x": csvRes });
    assert.equal((await fetchSheetCsv(SHEET)).csv, "a,b\n1,2\n");
});

test("fetchSheetCsv: a hop to accounts.google.com is the not-signed-in error, and the login page is never requested", async () => {
    const SHEET = sheet("s1");
    const requested = net({ [SHEET]: { loc: "https://accounts.google.com/ServiceLogin?continue=x" }, "https://accounts.google.com/ServiceLogin?continue=x": csvRes });
    await assert.rejects(fetchSheetCsv(SHEET), /Not signed in to Google in this browser/);
    assert.deepEqual(requested, [SHEET]);
});

test("fetchSheetCsv: a hop to any other host is refused by name and not requested", async () => {
    const SHEET = sheet("s2");
    const requested = net({ [SHEET]: { loc: "https://evil.test/steal" }, "https://evil.test/steal": csvRes });
    await assert.rejects(fetchSheetCsv(SHEET), /redirected to https:\/\/evil\.test\/steal, which is not a Google Sheets host/);
    assert.deepEqual(requested, [SHEET]);
});

test("fetchSheetCsv: an unreadable target is refused, not followed", async () => {
    const SHEET = sheet("s3");
    net({ [SHEET]: { loc: null } });
    await assert.rejects(fetchSheetCsv(SHEET), /could not read/);
});

// --- FETCH_IMAGE_B64: every hop is held to the public-host rule ---

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const baseConfig = () => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET", model: "m", apiFormat: "openai", ocrModel: "" });
const PAGE = { tab: { id: 9, url: "https://site.example/page" }, url: "https://site.example/page" };
function pngResponse(url) {
    let sent = false;
    return {
        ok: true, status: 200, url, redirected: false, type: "basic",
        headers: { get: (k) => ({ "content-type": "image/png" })[String(k).toLowerCase()] ?? null },
        body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: PNG })), cancel: async () => {} }) },
    };
}
/** One image read through the worker bundle: `routes[url]` is a Location (a 3xx) or "png". */
async function readImage(start, routes) {
    let bg;
    const onFetch = (call) => {
        const r = routes[call.url];
        if (r === "png") return pngResponse(call.url);
        if (typeof r === "string") { bg.headersReceived(call.url, 302, r); return { type: "opaqueredirect", ok: false, status: 0, url: "", body: null }; }
        return { ok: false, status: 404, url: call.url, headers: { get: () => null }, body: null };
    };
    bg = loadBackground({ config: baseConfig(), onFetch });
    const res = await bg.send({ type: "FETCH_IMAGE_B64", payload: { url: start } }, PAGE);
    return { res, urls: bg.calls.map((c) => c.url).filter((u) => !u.startsWith("http://host/")), bg };
}

test("an image behind a chain of public hops (another site's CDN) still reads", async () => {
    const { res, urls } = await readImage("https://img.example/a.png", {
        "https://img.example/a.png": "https://cdn.other.example/b.png",
        "https://cdn.other.example/b.png": "https://cdn.third.example/c.png",
        "https://cdn.third.example/c.png": "png",
    });
    assert.match(res.data, /^data:image\/png;base64,/);
    assert.equal(urls.length, 3);
});

test("a redirect to a private or loopback address at ANY step is IMAGE_FAILED and nothing past it is requested", async () => {
    const bad = ["http://10.0.0.5/pic.png", "http://localhost:8080/pic.png", "http://127.0.0.1/pic.png", "http://192.168.1.1/pic.png",
        "http://169.254.169.254/latest", "http://[::1]/pic.png", "http://nas/pic.png", "http://printer.local/pic.png", "ftp://img.example/pic.png"];
    for (const target of bad) {
        for (const depth of [0, 1, 2]) {
            const routes = { [target]: "png" };
            const chain = ["https://img.example/a.png", "https://cdn.example/b.png", "https://cdn2.example/c.png"];
            for (let i = 0; i < depth; i++) routes[chain[i]] = chain[i + 1];
            routes[chain[depth]] = target;
            const { res, urls } = await readImage(chain[0], routes);
            assert.deepEqual(res, { error: "Could not read that URL as an image." }, `${target} at depth ${depth}`);
            assert.ok(!urls.includes(target), `${target} must not be requested (depth ${depth}): ${urls.join(" ")}`);
            assert.equal(urls.length, depth + 1);
        }
    }
});

test("a redirect whose Location cannot be read is IMAGE_FAILED", async () => {
    let bg;
    bg = loadBackground({ config: baseConfig(), onFetch: (call) => (bg.headersReceived(call.url, 302, null), { type: "opaqueredirect", ok: false, status: 0, url: "", body: null }) });
    const res = await bg.send({ type: "FETCH_IMAGE_B64", payload: { url: "https://img.example/a.png" } }, PAGE);
    assert.deepEqual(res, { error: "Could not read that URL as an image." });
});

// --- prepareRenderGuard: a render tab is held to its site from its first request ---

const nav = chrome.webRequest;
const blockedNav = (tabId, url) => nav.onErrorOccurred.fire({ tabId, url, error: "net::ERR_BLOCKED_BY_CLIENT" });
const onlyRule = () => { assert.equal(dnr.rules.size, 1, "one render rule"); return [...dnr.rules.values()][0]; };

test("the rule goes in before the tab exists, covering every tab but the open ones, and bind narrows it to the new tab", async () => {
    openTabs = [3, 7];
    const pending = await prepareRenderGuard("https://www.site.example/start");
    const before = onlyRule();
    assert.ok(before.id >= RENDER_RULE_BASE);
    assert.deepEqual(before.action, { type: "block" });
    assert.deepEqual(before.condition, { excludedTabIds: [3, 7], resourceTypes: ["main_frame", "sub_frame"], excludedRequestDomains: ["site.example"] });
    const guard = await pending.bind(11);
    assert.deepEqual(onlyRule().condition, { tabIds: [11], resourceTypes: ["main_frame", "sub_frame"], excludedRequestDomains: ["site.example"] });
    await guard.widen("https://partner.example/x");
    assert.deepEqual(onlyRule().condition.excludedRequestDomains, ["site.example", "partner.example"]);
    await guard.dispose();
    assert.equal(dnr.rules.size, 0, "dispose removes the rule");
    assert.equal(nav.onErrorOccurred.fns.size + nav.onBeforeRedirect.fns.size + nav.onCompleted.fns.size, 0, "and the listeners");
});

test("a hop blocked before bind is kept for the new tab; another tab's events are not its", async () => {
    openTabs = [];
    const pending = await prepareRenderGuard("https://a.site.example/r");
    nav.onBeforeRedirect.fire({ tabId: 20, url: "https://a.site.example/r", redirectUrl: "https://evil.example/x" });
    blockedNav(20, "https://evil.example/x");
    blockedNav(21, "https://other.example/y");
    const guard = await pending.bind(20);
    assert.deepEqual(guard.blocked(), { from: "https://a.site.example/r", to: "https://evil.example/x" });
    blockedNav(21, "https://other.example/z");
    guard.clear();
    assert.equal(guard.blocked(), null, "clear forgets it, and the other tab's later block is not this tab's");
    nav.onCompleted.fire({ tabId: 20, url: "https://a.site.example/landed" });
    blockedNav(20, "https://evil.example/js");
    assert.deepEqual(guard.blocked(), { from: "https://a.site.example/landed", to: "https://evil.example/js" }, "a script navigation comes from the page the tab loaded");
    await guard.dispose();
});

test("renders prepare one at a time: the next waits until the last binds or is disposed", async () => {
    openTabs = [];
    const first = await prepareRenderGuard("https://one.example/");
    let second = null;
    const waiting = prepareRenderGuard("https://two.example/").then((p) => (second = p));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(second, null, "the second waits while the first's broad rule is in");
    const g1 = await first.bind(30);
    await waiting;
    assert.ok(second, "it goes once the first is narrowed");
    let third = null;
    const waiting3 = prepareRenderGuard("https://three.example/").then((p) => (third = p));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(third, null);
    await second.dispose();   // a tab that failed to open
    await waiting3;
    assert.ok(third, "a disposed guard lets the next one go");
    await third.dispose();
    await g1.dispose();
    assert.equal(dnr.rules.size, 0);
});

test("a rule the browser refuses fails the prepare, leaves nothing behind, and does not wedge the next render", async () => {
    openTabs = [];
    dnr.fail = true;
    await assert.rejects(prepareRenderGuard("https://refused.example/"), /rule refused/);
    dnr.fail = false;
    assert.equal(nav.onErrorOccurred.fns.size, 0, "no listener left");
    const next = await prepareRenderGuard("https://after.example/");
    await next.dispose();
    assert.equal(dnr.rules.size, 0);
});
