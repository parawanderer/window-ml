// The page's fetch cache has a budget. It used to be a Map that grew for the life of the tab, holding every
// fetched body — and every parsed CSV's rows — in the user's page.
import test from "node:test";
import assert from "node:assert";
import { FetchCache, estimateFetchResultBytes } from "../src/fetch-cache.ts";

const sized = (budget) => new FetchCache(budget, (v) => v.bytes, 3);

test("the least recently USED entry goes first — a read counts as use", () => {
    const c = sized(300);
    c.set("a", { bytes: 100 }); c.set("b", { bytes: 100 }); c.set("c", { bytes: 100 });
    c.get("a");                           // a is now the most recently used
    c.set("d", { bytes: 100 });           // 400 > 300: the oldest by USE is b
    assert.equal(c.get("b"), undefined);
    assert.ok(c.get("a") && c.get("c") && c.get("d"));
    assert.equal(c.estimatedBytes, 300);
});

test("the entry just stored is kept even when it alone exceeds the budget", () => {
    // The commonest read of this cache is the NEXT step reading what was just fetched. Evicting that on arrival
    // would break the one handoff the cache exists for.
    const c = sized(100);
    c.set("small", { bytes: 50 });
    c.set("huge", { bytes: 5000 });
    assert.ok(c.get("huge"), "the most recent fetch survives");
    assert.equal(c.get("small"), undefined, "everything older makes room for it");
});

test("an evicted key is remembered, so a miss can say it WAS fetched", () => {
    const c = sized(100);
    c.set("a", { bytes: 100 });
    c.set("b", { bytes: 100 });
    assert.equal(c.get("a"), undefined);
    assert.equal(c.wasEvicted("a"), true, "fetched, then evicted — not 'never fetched'");
    assert.equal(c.wasEvicted("never"), false);
    // Storing it again clears the memory: it is simply cached now.
    c.set("a", { bytes: 10 });
    assert.equal(c.wasEvicted("a"), false);
});

test("the eviction memory is itself bounded", () => {
    const c = new FetchCache(1, (v) => v.bytes, 2);
    for (const k of ["a", "b", "c", "d"]) c.set(k, { bytes: 10 });
    // a, b, c were evicted in that order; only the last two are remembered.
    assert.equal(c.wasEvicted("a"), false);
    assert.equal(c.wasEvicted("b"), true);
    assert.equal(c.wasEvicted("c"), true);
});

test("replacing a key re-counts its size rather than adding to it", () => {
    const c = sized(1000);
    c.set("a", { bytes: 400 });
    c.set("a", { bytes: 100 });
    assert.equal(c.estimatedBytes, 100);
    assert.equal(c.size, 1);
});

test("the size estimate charges a parsed table by the cell — where a parsed CSV's weight is", () => {
    const text = "x".repeat(1000);
    const plain = estimateFetchResultBytes({ text });
    const table = estimateFetchResultBytes({ text, table: { columns: ["a", "b", "c", "d"], rows: Array.from({ length: 10_000 }, () => [1, 2, 3, 4]) } });
    assert.equal(plain, 2000);
    assert.equal(table - plain, 40_000 * 32, "10,000 rows × 4 columns");
    assert.ok(estimateFetchResultBytes({ text, json: {} }) > plain, "a parsed JSON value is charged for its object graph");
});

test("each budget eviction is reported with its key and bytes, and a failing reporter does not break the cache", () => {
    const seen = [];
    const cache = new FetchCache(10, (v) => v.length, 64, (key, bytes) => { seen.push([key, bytes]); throw new Error("reporter down"); });
    cache.set("a", "xxxxxx");
    cache.set("b", "yyyyyy");
    assert.deepEqual(seen, [["a", 6]]);
    assert.equal(cache.get("b"), "yyyyyy");
    assert.ok(cache.wasEvicted("a"));
});
