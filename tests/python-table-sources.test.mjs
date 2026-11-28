// python-table-sources.test.mjs — how an `ml.table` source string becomes a table, on the page (ml-python.ts `_hoistTable`,
// what a page-started cell's literals are read with) and in the worker (worker-tools.ts `workerTableRead`, what a run's cell
// reads at the call): a path on the page's site is the URL fetch_url read there, looked up in the fetch cache (which stays
// the gate: nothing is fetched here); a /files path and an @file: pointer are the run's files, read by its reader.
import test from "node:test";
import assert from "node:assert";

const { _hoistTable } = await import("../src/ml/ml-python.ts");
const { mlFetchCache } = await import("../src/ml/ml-fetch-cache.ts");

const onPage = (href) => { globalThis.location = new URL(href); };
const cacheCsv = (url) => mlFetchCache.set(url, { ok: true, url, type: "csv", table: { columns: ["amount"], rows: [[1], [2]] } });

// --- a path on this page's site ---

test("a path ('/sales.csv', './sales.csv') loads the table fetch_url read at that URL on the page's site", async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage("http://site.test/step3");
    cacheCsv("http://site.test/sales.csv");
    for (const src of ["/sales.csv", "./sales.csv"]) {
        const loaded = await _hoistTable.call({}, src);
        assert.equal(loaded.source.kind, "fetch", src);
        assert.deepEqual(loaded.data.rows, [[1], [2]], src);
    }
});

test("a path the page never fetched is refused from the cache, never fetched or read as a selector", async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage("http://site.test/step3");
    await assert.rejects(_hoistTable.call({}, "/never.csv"), (e) => /"http:\/\/site\.test\/never\.csv" is not in this page's fetch cache/.test(e.message) && !/CSS selector/.test(e.message));
});

test("off a web page (an extension page) a path is not resolved against it", async (t) => {
    t.after(() => { delete globalThis.location; });
    onPage("chrome-extension://abcdef/chat.html");
    cacheCsv("chrome-extension://abcdef/sales.csv");
    await assert.rejects(_hoistTable.call({ _queryAll: () => [] }, "/sales.csv"), (e) => !/fetch cache/.test(e.message));
});

// --- the run's files: a /files path and an @file: pointer (worker only; ruling 107) ---

const noDeps = { file: () => ({ error: "no files" }), holds: async () => false, sheet: async () => { throw new Error("no sheet ask here"); } };

test("filesTablePath: `.` and `..` resolve inside /files/; climbing out, or naming the folder, is refused", async () => {
    const { filesTablePath } = await import("../src/sw/worker-tools.ts");
    for (const [src, want] of [
        ["/files/attached/f1/s.csv", "/files/attached/f1/s.csv"],
        ["/files/agent/./out/../s.csv", "/files/agent/s.csv"],
        ["/files//attached///f1/s.csv", "/files/attached/f1/s.csv"],
        ["/files/a/../../files/b.csv", null],
        ["/files/..", null],
        ["/files/../etc/passwd", null],
        ["/files/", null],
        ["/files", null],
        ["/files/a/..", null],
    ]) {
        if (want) assert.equal(filesTablePath(src), want, src);
        else assert.throws(() => filesTablePath(src), /climbs out of \/files\/|the \/files\/ folder, not a file/, src);
    }
});

test("workerTableRead: a /files path is a file answer for the reader, with the call's options; /filesx is not one", async () => {
    const { workerTableRead } = await import("../src/sw/worker-tools.ts");
    const ctx = { tabId: 1, tabUrl: () => "http://site.test/p", cache: new Map() };
    const a = await workerTableRead(ctx, "  /files/agent/../attached/f1/s.tsv ", { raw: true, delimiter: "\t" }, noDeps);
    assert.deepEqual(a, { source: { kind: "file", label: "/files/attached/f1/s.tsv" }, data: { kind: "file", path: "/files/attached/f1/s.tsv", raw: true, delimiter: "\t" } });
    await assert.rejects(workerTableRead(ctx, "/files/../x", {}, noDeps), /climbs out/);
    await assert.rejects(workerTableRead(ctx, "/filesx/s.csv", {}, noDeps), /not among this run's fetches/, "a site path, read from the run's fetches only");
});

test("workerTableRead: an @file: pointer is its /files/attached path; a name that climbs is refused; an unknown file says why", async () => {
    const { workerTableRead } = await import("../src/sw/worker-tools.ts");
    const ctx = { tabId: 1, tabUrl: () => "http://site.test/p", cache: new Map() };
    const files = { "@file:f1": { id: "f1", name: "sales.csv" }, "@file:f2": { id: "f2", name: "../../agent/x.csv" }, "@file:f3": { id: "f3", name: "../f1/sales.csv" } };
    const deps = { ...noDeps, file: (ref) => (files[ref] ? { file: files[ref] } : { error: `no attached file ${ref}` }) };
    assert.deepEqual(await workerTableRead(ctx, "@file:f1", {}, deps), { source: { kind: "file", label: "@file:f1" }, data: { kind: "file", path: "/files/attached/f1/sales.csv" } });
    for (const ref of ["@file:f2", "@file:f3"]) await assert.rejects(workerTableRead(ctx, ref, {}, deps), /not one it can be read under/, ref);
    await assert.rejects(workerTableRead(ctx, "@file:nope", {}, deps), /no attached file @file:nope/);
});

test("workerTableRead: a source that is not a string, empty, or past the length bound is refused before any read", async () => {
    const { workerTableRead, TABLE_SRC_MAX } = await import("../src/sw/worker-tools.ts");
    const ctx = { tabId: 1, tabUrl: () => "http://site.test/p", cache: new Map(), media: { table: async () => { throw new Error("the page was asked"); } } };
    for (const src of [3, null, ["#t"], "", "   "]) await assert.rejects(workerTableRead(ctx, src, {}, noDeps), /takes a source string/, JSON.stringify(src));
    await assert.rejects(workerTableRead(ctx, "#" + "a".repeat(TABLE_SRC_MAX), {}, noDeps), /at most \d+ characters/);
});

test("workerTableRead: a stored table's preview is read by key only when this run holds it", async () => {
    const { workerTableRead } = await import("../src/sw/worker-tools.ts");
    const ctx = { tabId: 1, tabUrl: () => "http://site.test/p", cache: new Map() };
    const meta = { id: "abc1234", kind: "table", value: "v01", table: { columns: ["a"], rows: [[1]], shape: [500, 1], truncated: true } };
    const deref = () => ({ value: "", meta });
    await assert.rejects(workerTableRead(ctx, "@tool:abc1234", {}, { ...noDeps, deref, holds: async () => false }), /not held by this run/);
    const a = await workerTableRead(ctx, "@tool:abc1234", {}, { ...noDeps, deref, holds: async (k) => k === "v01" });
    assert.deepEqual(a.data, { kind: "value", key: "v01", label: "@tool:abc1234", columns: ["a"] });
    assert.equal(a.rowCount, 500);
    await assert.rejects(workerTableRead(ctx, "@tool:abc1234", { delimiter: ";" }, { ...noDeps, deref }), /delimiter and header do not apply/);
});

// --- a path and a selector told apart: one rule, the same answer on the page and in the worker ---

test("sitePathUrl: a path starts with /, ./ or ../ and resolves on the page's origin; everything else is not one", async () => {
    const { sitePathUrl } = await import("../src/ml/ml-python.ts");
    const page = "http://site.test/a/step3";
    for (const [src, want] of [
        ["/sales.csv", "http://site.test/sales.csv"],
        ["./sales.csv", "http://site.test/a/sales.csv"],
        ["../sales.csv", "http://site.test/sales.csv"],
        ["/../../../x.csv", "http://site.test/x.csv"],          // dot segments stop at the root: never another origin
        ["/data/2024 report.csv?x=1", "http://site.test/data/2024%20report.csv?x=1"],
        ["//evil.test/x.csv", null],                            // protocol-relative: another host
        ["/\\evil.test/x.csv", null],                           // the URL parser reads `\` as `/`: off-origin, refused
        ["x.csv", null],                                        // a selector: element x, class csv
        ["sales", null], ["#sales", null], ["table#sales", null], [".sales", null], ["current", null],
        ["http://site.test/sales.csv", null],                  // already a URL: the caller's own branch
        ["", null],
    ]) assert.equal(sitePathUrl(src, page), want, src);
    assert.equal(sitePathUrl("/sales.csv", "chrome-extension://abcdef/chat.html"), null, "an extension page is not a site");
    assert.equal(sitePathUrl("/sales.csv", "about:blank"), null);
    assert.equal(sitePathUrl("/sales.csv", "not a url"), null);
});

test("the page's loader and the worker's give the same answer for the same source, path or selector", async (t) => {
    t.after(() => { delete globalThis.location; });
    const { workerTableRead } = await import("../src/sw/worker-tools.ts");
    const page = "http://site.test/a/step3";
    onPage(page);
    const fetched = "http://site.test/sales.csv";
    const table = { columns: ["amount"], rows: [[1], [2]] };
    mlFetchCache.set(fetched, { ok: true, url: fetched, type: "csv", table });
    const dom = { kind: "rows", columns: ["dom"], rows: [["x"]] };
    /** The DOM reader both hosts end at: one table under `#sales`, and a selector error for anything else. */
    const readDom = (sel) => { if (sel === "#sales") return dom; throw new Error(`"${sel}" is not a valid CSS selector`); };
    const ctx = { tabId: 1, tabUrl: () => page, cache: new Map([[fetched, { ok: true, url: fetched, type: "csv", table }]]),
        media: { table: async (sel) => ({ label: sel, data: readDom(sel) }) } };
    /** What a loader did with the source, in words the two hosts share. */
    const outcome = async (load) => {
        try {
            const r = await load();
            return `${r.source.kind}:${r.data.columns[0]}`;
        } catch (e) {
            const url = /"(https?:\/\/[^"]+)"/.exec(e.message)?.[1];
            if (/fetch cache|among this run's fetches/.test(e.message)) return `not fetched:${url}`;
            if (/CSS selector/.test(e.message)) return "selector error";
            return `other: ${e.message}`;
        }
    };
    for (const [src, want] of [
        ["/sales.csv", "fetch:amount"],
        ["../sales.csv", "fetch:amount"],
        [fetched, "fetch:amount"],
        ["./sales.csv", "not fetched:http://site.test/a/sales.csv"],
        ["/never.csv", "not fetched:http://site.test/never.csv"],
        ["#sales", "dom:dom"],
        ["x.csv", "selector error"],
    ]) {
        const onPage_ = await outcome(() => _hoistTable.call({ _resolveTable: (sel) => readDom(sel) }, src));
        const inWorker = await outcome(() => workerTableRead(ctx, src, {}, noDeps));
        assert.equal(onPage_, want, `page: ${src}`);
        assert.equal(inWorker, want, `worker: ${src}`);
    }
});
