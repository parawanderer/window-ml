// pkg-mirror.test.mjs — python_install's network and mirror (src/sw/sw-pkg-mirror.ts, src/sw/sw-pkg-install.ts fetchApproved): host-locked index reads with a per-run cap, and wheel downloads kept only when their size and sha256 are the card's. `fetch` is a stub and IndexedDB is fake-indexeddb. Run: node --import tsx --test tests/pkg-mirror.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const mirror = await import("../src/sw/sw-pkg-mirror.ts");
const { fetchApproved } = await import("../src/sw/sw-pkg-install.ts");
const { INDEX_BOUNDS, IndexRunCap, fileKey } = await import("../src/python/pkg-index.ts");
const { ensureWheel, indexGetFor, mirroredDigests, mirroredWheel } = mirror;

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FILES = "https://files.pythonhosted.org/packages/ab/cd";
let n = 0;
/** A fresh wheel: unique bytes, so each test has a digest the mirror has never held. */
function wheel(len = 64) {
    const i = n++;
    const bytes = new Uint8Array(len).map((_, k) => (k * 7 + i * 13 + 1) & 255);
    bytes.set(new TextEncoder().encode(`w${i}-`));
    const filename = `w${i}-1.0-py3-none-any.whl`;
    return { bytes, want: { name: `w${i}`, version: "1.0", filename, size: len, sha256: sha(bytes), url: `${FILES}/${filename}` } };
}
/** A Response over `bytes`, optionally split in chunks, with a declared content-length. */
function respond(bytes, { status = 200, length = bytes.length, chunk = 16 } = {}) {
    let cancelled = false;
    const body = new ReadableStream({
        start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); },
        cancel() { cancelled = true; },
    });
    const res = new Response(body, { status, headers: length === null ? {} : { "content-length": String(length) } });
    res.cancelled = () => cancelled;
    return res;
}
/** Stub fetch with `handler(url, init)`; returns the calls. */
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
    return calls;
}

// --- downloading a wheel ---

test("ensureWheel: a correct download is stored, returns downloaded, and the second call is held with no fetch", async () => {
    const w = wheel();
    const calls = stubFetch(() => respond(w.bytes));
    assert.equal(await ensureWheel(w.want), "downloaded");
    assert.equal(calls.length, 1);
    assert.ok((await mirroredDigests()).has(w.want.sha256));
    assert.equal(await ensureWheel(w.want), "held");
    assert.equal(calls.length, 1);
    const blob = await mirroredWheel(w.want.sha256);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), w.bytes);
});

test("ensureWheel: fetch is called with redirect error, credentials omit and no cookies or referrer", async () => {
    const w = wheel();
    const calls = stubFetch(() => respond(w.bytes));
    await ensureWheel(w.want);
    assert.equal(calls[0].url, w.want.url);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.referrerPolicy, "no-referrer");
});

test("ensureWheel: two concurrent calls for one digest share one fetch", async () => {
    const w = wheel();
    const calls = stubFetch(async () => { await new Promise((r) => setTimeout(r, 10)); return respond(w.bytes); });
    const [a, b] = await Promise.all([ensureWheel(w.want), ensureWheel(w.want)]);
    assert.equal(calls.length, 1);
    assert.equal(a, "downloaded");
    assert.equal(b, "downloaded");
    assert.equal(await ensureWheel(w.want), "held");
});

test("ensureWheel: a body larger than the card's size throws, cancels the read, and stores nothing", async () => {
    const w = wheel(64), big = new Uint8Array(200).fill(7);
    let res;
    stubFetch(() => (res = respond(big, { length: null })));
    await assert.rejects(ensureWheel({ ...w.want, sha256: sha(big) }), /larger than 64 bytes/);
    assert.ok(res.cancelled());
    assert.ok(!(await mirroredDigests()).has(sha(big)));
    assert.equal(await mirroredWheel(sha(big)), undefined);
});

test("ensureWheel: a body shorter than the card's size throws and stores nothing", async () => {
    const w = wheel(64);
    stubFetch(() => respond(w.bytes.slice(0, 10), { length: null }));
    await assert.rejects(ensureWheel(w.want), /not the 64/);
    assert.ok(!(await mirroredDigests()).has(w.want.sha256));
});

test("ensureWheel: the right size with the wrong bytes throws and stores nothing", async () => {
    const w = wheel(64), other = new Uint8Array(64).fill(9);
    stubFetch(() => respond(other));
    await assert.rejects(ensureWheel(w.want), /does not match the sha256/);
    assert.ok(!(await mirroredDigests()).has(w.want.sha256));
    assert.ok(!(await mirroredDigests()).has(sha(other)));
    assert.equal(await mirroredWheel(w.want.sha256), undefined);
    // a failure is not remembered: the same file can be fetched again
    stubFetch(() => respond(w.bytes));
    assert.equal(await ensureWheel(w.want), "downloaded");
});

test("ensureWheel: a content-length larger than the card's size throws before the body is read", async () => {
    const w = wheel(64);
    let res;
    stubFetch(() => (res = respond(w.bytes, { length: 100000 })));
    await assert.rejects(ensureWheel(w.want), /larger than 64 bytes/);
    assert.ok(res.cancelled());
    assert.ok(!(await mirroredDigests()).has(w.want.sha256));
});

test("ensureWheel: a non-200 answer throws", async () => {
    const w = wheel();
    stubFetch(() => respond(new Uint8Array(0), { status: 503 }));
    await assert.rejects(ensureWheel(w.want), /answered 503/);
    assert.ok(!(await mirroredDigests()).has(w.want.sha256));
});

test("ensureWheel: a URL off files.pythonhosted.org throws with no fetch", async () => {
    const w = wheel();
    const calls = stubFetch(() => respond(w.bytes));
    const bad = [
        `https://evil.example/packages/ab/${w.want.filename}`,
        `http://files.pythonhosted.org/packages/ab/${w.want.filename}`,
        `https://files.pythonhosted.org:444/packages/ab/${w.want.filename}`,
        `https://files.pythonhosted.org/packages/ab/other.whl`,
        "not a url",
    ];
    for (const url of bad) await assert.rejects(ensureWheel({ ...w.want, url }), undefined, url);
    assert.equal(calls.length, 0);
});

test("mirroredWheel: a digest the mirror does not hold is undefined", async () => {
    assert.equal(await mirroredWheel("0".repeat(64)), undefined);
});

// --- fetchApproved: an approved card's files ---

const card = (rows) => ({ request: { name: "w" }, card: { ok: true, files: rows, loaded: [], totalBytes: 0 }, urls: new Map(rows.filter((r) => r.url).map((r) => [fileKey(r.sha256, r.filename), r.url])) });
const rowOf = (w, o = {}) => ({ name: w.want.name, version: "1.0", filename: w.want.filename, source: "pypi", size: w.want.size, sha256: w.want.sha256, url: w.want.url, ...o });

test("fetchApproved: downloads pypi rows, skips lock rows, reports held ones", async () => {
    const a = wheel(), b = wheel();
    const calls = stubFetch((u) => respond(u === a.want.url ? a.bytes : b.bytes));
    await ensureWheel(b.want);
    calls.length = 0;
    const lock = { name: "six", version: "1", filename: "six.whl", source: "lock", size: null, sha256: "f".repeat(64) };
    const text = await fetchApproved(card([lock, rowOf(a), rowOf(b)]));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, a.want.url);
    assert.equal(text, "Approved: downloaded and checked 1 file; 1 already held. This build does not install packages yet, so nothing was installed.");
});

test("fetchApproved: a failed download says which file and that nothing was kept", async () => {
    const a = wheel();
    stubFetch(() => respond(new Uint8Array(a.want.size).fill(1)));
    const text = await fetchApproved(card([rowOf(a)]));
    assert.match(text, new RegExp(`^Not installed: ${a.want.filename} could not be downloaded as approved .*Nothing of it was kept\\.$`));
    assert.ok(!(await mirroredDigests()).has(a.want.sha256));
});

test("fetchApproved: a row with no URL in the check is not downloaded", async () => {
    const a = wheel();
    const calls = stubFetch(() => respond(a.bytes));
    const c = card([rowOf(a)]);
    c.urls = new Map();
    assert.match(await fetchApproved(c), /^Not installed: .* has no download/);
    assert.equal(calls.length, 0);
});

test("fetchApproved: a refusal card downloads nothing", async () => {
    const calls = stubFetch(() => respond(new Uint8Array(1)));
    assert.match(await fetchApproved({ request: { name: "x" }, card: { ok: false, reason: "not-on-index", at: "x" }, urls: new Map() }), /^Not installed/);
    assert.equal(calls.length, 0);
});

// --- reading the index ---

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const IDX = "https://pypi.org/pypi/foo/json";

test("indexGetFor: reads JSON from pypi.org with redirect error and credentials omit, and logs once per request", async () => {
    const logged = [];
    const calls = stubFetch(() => jsonRes({ info: { name: "foo" } }));
    const get = indexGetFor("run-a", (u) => logged.push(u));
    assert.deepEqual(await get(IDX), { info: { name: "foo" } });
    await get(IDX);
    assert.deepEqual(logged, [IDX, IDX]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.headers.accept, "application/json");
});

test("indexGetFor: a 404 is null; another failure status throws", async () => {
    const get = indexGetFor("run-b", () => {});
    stubFetch(() => jsonRes({}, 404));
    assert.equal(await get(IDX), null);
    stubFetch(() => jsonRes({}, 500));
    await assert.rejects(get(IDX), /answered 500/);
    stubFetch(() => new Response("not json"));
    await assert.rejects(get(IDX));
});

test("indexGetFor: a URL off pypi.org throws before the log and before any fetch", async () => {
    const logged = [];
    const calls = stubFetch(() => jsonRes({}));
    const get = indexGetFor("run-c", (u) => logged.push(u));
    for (const u of ["https://evil.example/pypi/foo/json", "http://pypi.org/pypi/foo/json", "https://pypi.org:8443/pypi/foo/json", "https://files.pythonhosted.org/pypi/foo/json", "https://pypi.org.evil.example/pypi/foo/json"]) {
        await assert.rejects(get(u), /not the index/, u);
    }
    assert.deepEqual(logged, []);
    assert.equal(calls.length, 0);
});

test("indexGetFor: an answer past INDEX_BOUNDS.body is refused by its content-length", async () => {
    const get = indexGetFor("run-d", () => {});
    stubFetch(() => new Response("{}", { headers: { "content-length": String(INDEX_BOUNDS.body + 1) } }));
    await assert.rejects(get(IDX), /larger than/);
});

test("indexGetFor: the per-run cap throws IndexRunCap after INDEX_BOUNDS.perRun requests, and another run is unaffected", async () => {
    const calls = stubFetch(() => jsonRes({}));
    const logged = [];
    const a = indexGetFor("run-e", (u) => logged.push(u));
    for (let i = 0; i < INDEX_BOUNDS.perRun; i++) await a(IDX);
    await assert.rejects(a(IDX), IndexRunCap);
    assert.equal(calls.length, INDEX_BOUNDS.perRun);
    assert.equal(logged.length, INDEX_BOUNDS.perRun);
    // the count belongs to the run, not to the reader: a second reader for it shares the cap
    await assert.rejects(indexGetFor("run-e", () => {})(IDX), IndexRunCap);
    // another run is unaffected
    assert.deepEqual(await indexGetFor("run-f", () => {})(IDX), {});
});
