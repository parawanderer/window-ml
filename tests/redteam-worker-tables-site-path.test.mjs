// redteam-worker-tables-site-path.test.mjs — a `tables` source in python_exec on a WORKER-built run (HUD, overlay,
// chat), where the page's loader is not the one that runs. A path on the tab's site (`/x.csv`, `./x.csv`, `../x.csv`)
// is that URL and the run's fetch cache stays the gate: nothing is fetched here, nothing is sent to the DOM reader as a
// selector, and the entry read is THIS run's, on THIS tab's origin. The lane's own rows
// (tests/python-table-sources.test.mjs) hold the shapes it names and the two hosts' answers side by side; these take
// the shapes the URL PARSER decides rather than the start-shaped regex, a second run's cache, a second tab, and a
// redirect.
//
// The property, in one line: no `tables` source resolves off the tab's origin, reads a fetch this run did not make, or
// turns into a DOM read or a request. Every row keeps a positive control, and the free controls show the path branch
// still works when the cache does hold the entry.
import { test } from "node:test";
import assert from "node:assert/strict";

const { sitePathUrl, _loadTable } = await import("../src/ml/ml-python.ts");
const { mlFetchCache } = await import("../src/ml/ml-fetch-cache.ts");
const { workerTable } = await import("../src/sw/worker-tools.ts");

const PAGE = "http://site.test/a/step3";
const T = { timeout: 30000 };
const csv = (url, rows = [[1], [2]]) => ({ ok: true, url, type: "csv", table: { columns: ["amount"], rows } });
const onPage = (href) => { globalThis.location = new URL(href); };
const cacheCsv = (url) => mlFetchCache.set(url, csv(url));
/** A worker loader's context, with a spy for the DOM reader and the cache handed in as [url, entry] pairs. */
const ctxFor = (page, entries, opts = {}) => {
    const seen = [];
    return {
        seen,
        ctx: {
            tabId: 1, tabUrl: () => page, cache: new Map(entries),
            media: { table: async (sel) => { seen.push(sel); return { label: sel, data: { kind: "rows", columns: ["dom"], rows: [["x"]] } }; } },
            ...opts,
        },
    };
};

// --- the shape rule: what the URL parser does, not what the source starts with ---

test("RED TEAM (#2012): no source shape is resolved off the page's origin, whatever the URL parser reads in it", T, async () => {
    for (const src of [
        "//evil.test/x.csv",            // protocol-relative: another host
        "/\\evil.test/x.csv",           // `\` is `/` to the URL parser, so this names a HOST
        "/\\/evil.test/x.csv",          // starts `/` then `\`: the START rule calls it a path, the parser reads `//evil.test`
        "/\t/evil.test/x.csv",          // a tab the parser strips, leaving `//evil.test`
        "/\n/evil.test/x.csv",          // a newline, the same
        "//site.test@evil.test/x.csv",  // userinfo dressed as the page's host
        "//evil.test\\@site.test/x.csv",
    ]) assert.equal(sitePathUrl(src, PAGE), null, `${JSON.stringify(src)} must not resolve off the page's origin`);
    // Positive control: the shapes that ARE paths resolve, and every one lands on the page's own origin.
    for (const src of ["/x.csv", "./x.csv", "../x.csv", "/..//evil.test/x.csv", "/%2f%2fevil.test/x.csv", "/.//evil.test/x.csv", "/%5c/evil.test/x.csv"]) {
        const u = sitePathUrl(src, PAGE);
        assert.ok(u, `${JSON.stringify(src)}: a path`);
        assert.equal(new URL(u).origin, "http://site.test", `${JSON.stringify(src)}: ${u}`);
    }
});

// --- the worker's loader: this run's cache, this tab's origin, never the reader, never a request ---

test("RED TEAM (#2012): a site path is answered only from THIS run's fetches on THIS tab's origin", T, async () => {
    const own = [["http://site.test/x.csv", csv("http://site.test/x.csv")]];
    // Positive control: this run's own fetch answers the path.
    assert.equal((await workerTable(ctxFor(PAGE, own).ctx, "df", "/x.csv", false)).source.kind, "fetch");
    // Another run's cache (same tab, same page) has nothing this run fetched.
    const other = ctxFor(PAGE, []);
    await assert.rejects(workerTable(other.ctx, "df", "/x.csv", false), /not among this run's fetches/);
    assert.deepEqual(other.seen, [], "a miss is not a DOM read");
    // Another tab: the same path resolves on THAT tab's origin, which this run never fetched.
    await assert.rejects(workerTable(ctxFor("http://other.test/a/step3", own).ctx, "df", "/x.csv", false), /not among this run's fetches/);
    // Another HOST's entry, cached by this very run (its fetch_url went there): a path on this tab never names it.
    await assert.rejects(workerTable(ctxFor(PAGE, [["http://evil.test/x.csv", csv("http://evil.test/x.csv")]]).ctx, "df", "/x.csv", false), /not among this run's fetches/);
});

test("RED TEAM (#2012): `//host/x` and `/\\host/x` are never read as a URL, even when this run fetched that host", T, async () => {
    const evil = "http://evil.test/x.csv";
    for (const src of ["//evil.test/x.csv", "/\\evil.test/x.csv"]) {
        const { ctx, seen } = ctxFor(PAGE, [[evil, csv(evil)]]);
        const r = await workerTable(ctx, "df", src, false);
        assert.equal(r.source.kind, "dom", `${JSON.stringify(src)} must stay a selector`);
        assert.deepEqual(seen, [src], `${JSON.stringify(src)} is handed to the DOM reader unchanged`);
    }
});

test("RED TEAM (#2012): a path is never a selector and a selector is never a path", T, async () => {
    const cache = [["http://site.test/x.csv", csv("http://site.test/x.csv")]];
    const { ctx, seen } = ctxFor(PAGE, cache);
    const bySel = await workerTable(ctx, "df", "x.csv", false);
    assert.equal(bySel.source.kind, "dom", "`x.csv` is element x, class csv");
    assert.deepEqual(seen, ["x.csv"]);
    seen.length = 0;
    assert.equal((await workerTable(ctx, "df", "/x.csv", false)).source.kind, "fetch");
    assert.deepEqual(seen, [], "a cached path never reaches the reader");
    await assert.rejects(workerTable(ctx, "df", "/never.csv", false), /not among this run's fetches/);
    assert.deepEqual(seen, [], "a path with no entry is refused, not re-tried as a selector");
    // A run that cannot read the page at all: the cache still answers a path, and a selector says so.
    const noMedia = { tabId: 1, tabUrl: () => PAGE, cache: new Map(cache) };
    assert.equal((await workerTable(noMedia, "df", "/x.csv", false)).source.kind, "fetch");
    await assert.rejects(workerTable(noMedia, "df", "x.csv", false), /cannot read the page here/);
});

test("RED TEAM (#2012): a redirect never moves the read: the cache is keyed by the URL as it was judged", T, async () => {
    const landed = { ok: true, url: "http://evil.test/landed.csv", type: "csv", table: { columns: ["amount"], rows: [[7]] } };
    const { ctx } = ctxFor(PAGE, [["http://site.test/x.csv", landed]], { media: { table: async () => { throw new Error("the DOM reader must not be reached"); } } });
    const r = await workerTable(ctx, "df", "/x.csv", false);
    assert.equal(r.source.kind, "fetch");
    assert.deepEqual(r.data.rows, [[7]], "the table this run's approved fetch landed on is the table its path names");
    // Where it LANDED is not a source a path may name: `/landed.csv` is a path on THIS tab's origin, which was never fetched.
    await assert.rejects(workerTable(ctx, "df", "/landed.csv", false), /not among this run's fetches/);
});

// --- the page's loader refuses the same shapes, with the off-origin URL already in its cache ---

test("RED TEAM (#2012): the page's loader never reads an off-origin shape from its cache", T, async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage(PAGE);
    cacheCsv("http://evil.test/x.csv");
    for (const src of ["//evil.test/x.csv", "/\\evil.test/x.csv", "/\\/evil.test/x.csv", "/\t/evil.test/x.csv"]) {
        await assert.rejects(
            _loadTable.call({ _resolveTable: (sel) => { throw new Error(`"${sel}" is not a valid CSS selector`); } }, "df", src),
            (e) => /CSS selector/.test(e.message) && !/fetch cache/.test(e.message),
            JSON.stringify(src));
    }
});
