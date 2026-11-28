// redteam-worker-tables-site-path.test.mjs — an `ml.table` source in a python_exec cell on a WORKER-built run (read at the
// call, worker-tools.ts `workerTableRead`; it was a `tables` source) (HUD, overlay,
// chat), where the page's loader is not the one that runs. A path on the tab's site (`/x.csv`, `./x.csv`, `../x.csv`)
// is that URL and the run's fetch cache stays the gate: nothing is fetched here, nothing is sent to the DOM reader as a
// selector, and the entry read is THIS run's, on THIS tab's origin. The lane's own rows
// (tests/python-table-sources.test.mjs) hold the shapes it names and the two hosts' answers side by side; these take
// the shapes the URL PARSER decides rather than the start-shaped regex, a second run's cache, a second tab, and a
// redirect.
//
// The property, in one line: no `ml.table` source resolves off the tab's origin, reads a fetch this run did not make, or
// turns into a DOM read or a request. Every row keeps a positive control, and the free controls show the path branch
// still works when the cache does hold the entry.
import { test } from "node:test";
import assert from "node:assert/strict";

const { sitePathUrl, _hoistTable } = await import("../src/ml/ml-python.ts");
const { mlFetchCache } = await import("../src/ml/ml-fetch-cache.ts");
const { workerTableRead } = await import("../src/sw/worker-tools.ts");
/** The worker's read with no files, no pointers, nothing stored and no Sheet ask: only the path and selector rules are in play. */
const NODEPS = { file: () => ({ error: "no files" }), holds: async () => false, sheet: async () => { throw new Error("no sheet ask"); } };
const workerTable = (ctx, src) => workerTableRead(ctx, src, {}, NODEPS);

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
    assert.equal((await workerTable(ctxFor(PAGE, own).ctx, "/x.csv")).source.kind, "fetch");
    // Another run's cache (same tab, same page) has nothing this run fetched.
    const other = ctxFor(PAGE, []);
    await assert.rejects(workerTable(other.ctx, "/x.csv"), /not among this run's fetches/);
    assert.deepEqual(other.seen, [], "a miss is not a DOM read");
    // Another tab: the same path resolves on THAT tab's origin, which this run never fetched.
    await assert.rejects(workerTable(ctxFor("http://other.test/a/step3", own).ctx, "/x.csv"), /not among this run's fetches/);
    // Another HOST's entry, cached by this very run (its fetch_url went there): a path on this tab never names it.
    await assert.rejects(workerTable(ctxFor(PAGE, [["http://evil.test/x.csv", csv("http://evil.test/x.csv")]]).ctx, "/x.csv"), /not among this run's fetches/);
});

test("RED TEAM (#2012): `//host/x` and `/\\host/x` are never read as a URL, even when this run fetched that host", T, async () => {
    const evil = "http://evil.test/x.csv";
    for (const src of ["//evil.test/x.csv", "/\\evil.test/x.csv"]) {
        const { ctx, seen } = ctxFor(PAGE, [[evil, csv(evil)]]);
        const r = await workerTable(ctx, src);
        assert.equal(r.source.kind, "dom", `${JSON.stringify(src)} must stay a selector`);
        assert.deepEqual(seen, [src], `${JSON.stringify(src)} is handed to the DOM reader unchanged`);
    }
});

test("RED TEAM: `//host/x` naming the page's OWN host is still not a path, even when this run fetched that URL", T, async () => {
    // The origin check alone passes this shape (it resolves to http://site.test/x.csv), so only the start rule's
    // `(?!\/)` keeps it a selector: the row the off-origin shapes above cannot pin.
    const own = "http://site.test/x.csv";
    assert.equal(sitePathUrl("//site.test/x.csv", PAGE), null);
    const { ctx, seen } = ctxFor(PAGE, [[own, csv(own)]]);
    const r = await workerTable(ctx, "//site.test/x.csv");
    assert.equal(r.source.kind, "dom", "a protocol-relative source stays a selector");
    assert.deepEqual(seen, ["//site.test/x.csv"]);
    // Positive control: the same file as a path is this run's fetch.
    assert.equal((await workerTable(ctxFor(PAGE, [[own, csv(own)]]).ctx, "/x.csv")).source.kind, "fetch");
});

test("RED TEAM (#2012): a path is never a selector and a selector is never a path", T, async () => {
    const cache = [["http://site.test/x.csv", csv("http://site.test/x.csv")]];
    const { ctx, seen } = ctxFor(PAGE, cache);
    const bySel = await workerTable(ctx, "x.csv");
    assert.equal(bySel.source.kind, "dom", "`x.csv` is element x, class csv");
    assert.deepEqual(seen, ["x.csv"]);
    seen.length = 0;
    assert.equal((await workerTable(ctx, "/x.csv")).source.kind, "fetch");
    assert.deepEqual(seen, [], "a cached path never reaches the reader");
    await assert.rejects(workerTable(ctx, "/never.csv"), /not among this run's fetches/);
    assert.deepEqual(seen, [], "a path with no entry is refused, not re-tried as a selector");
    // A run that cannot read the page at all: the cache still answers a path, and a selector says so.
    const noMedia = { tabId: 1, tabUrl: () => PAGE, cache: new Map(cache) };
    assert.equal((await workerTable(noMedia, "/x.csv")).source.kind, "fetch");
    await assert.rejects(workerTable(noMedia, "x.csv"), /cannot read the page here/);
});

test("RED TEAM (#2012): a redirect never moves the read: the cache is keyed by the URL as it was judged", T, async () => {
    const landed = { ok: true, url: "http://evil.test/landed.csv", type: "csv", table: { columns: ["amount"], rows: [[7]] } };
    const { ctx } = ctxFor(PAGE, [["http://site.test/x.csv", landed]], { media: { table: async () => { throw new Error("the DOM reader must not be reached"); } } });
    const r = await workerTable(ctx, "/x.csv");
    assert.equal(r.source.kind, "fetch");
    assert.deepEqual(r.data.rows, [[7]], "the table this run's approved fetch landed on is the table its path names");
    // Where it LANDED is not a source a path may name: `/landed.csv` is a path on THIS tab's origin, which was never fetched.
    await assert.rejects(workerTable(ctx, "/landed.csv"), /not among this run's fetches/);
});

// --- the page's loader refuses the same shapes, with the off-origin URL already in its cache ---

test("RED TEAM (#2012): the page's loader never reads an off-origin shape from its cache", T, async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage(PAGE);
    cacheCsv("http://evil.test/x.csv");
    for (const src of ["//evil.test/x.csv", "/\\evil.test/x.csv", "/\\/evil.test/x.csv", "/\t/evil.test/x.csv"]) {
        await assert.rejects(
            _hoistTable.call({ _resolveTable: (sel) => { throw new Error(`"${sel}" is not a valid CSS selector`); } }, src),
            (e) => /CSS selector/.test(e.message) && !/fetch cache/.test(e.message),
            JSON.stringify(src));
    }
});
