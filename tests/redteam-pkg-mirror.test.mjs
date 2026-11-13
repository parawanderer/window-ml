// redteam-pkg-mirror.test.mjs — a PyPI answer is UNTRUSTED, and so is whatever a card's row would have the worker
// download: what an answer can make the worker fetch, where those bytes may come from, what the mirror may keep, and
// what the person is told (e3's rows for feat/pkg-mirror, docs/plan/repl/PACKAGES_INSTALL.md slice 3).
//
// The builder's own tests (tests/pkg-index.test.mjs, tests/pkg-mirror.test.mjs) measure each function's rule one at a
// time. These measure the JOIN a hostile answer presses: the JSON goes in and only what the card showed may come out —
// ONE request per row, to files.pythonhosted.org, for bytes whose sha256 is the card's.
//
// MUTATION PER ROW (notes, not committed changes — apply one, watch its row go red, revert; all four measured at
// 4f7c7100, clean 5/5 before and after):
//   A  pkg-index.ts `fileOf`'s `if (!wheelUrlOk(url, filename)) return null;` → `if (false) return null;` → A red
//      (3.4 ms: the answer's other-host URL is recorded against the card's file, and the download goes there).
//   B  sw-pkg-mirror.ts `boundedBody`'s counted half (`if (n > max) { await reader.cancel(); throw … }`) → `if (false)`
//      → B red (32.6 ms: a stream that lies about its length is read to the end).
//   C  `import { mirroredDigests } from "./sw/sw-pkg-mirror.ts";` appended to src/bus.ts → C red (17.5 ms).
//   E  `ensureWheel`'s `if ((await mirroredDigests()).has(w.sha256)) return "held";` → `if (false) return "held";` → E
//      red (2.0 ms: a held digest is downloaded again for the second filename).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
const { resolveVerdict, fileKey, INDEX_BOUNDS, FILES_HOST, wheelUrlOk } = await import("../src/python/pkg-index.ts");
const { CORE_ENV } = await import("../src/python/core-env.gen.ts");
const { ensureWheel, indexGetFor, mirroredDigests } = await import("../src/sw/sw-pkg-mirror.ts");
const { fetchApproved } = await import("../src/sw/sw-pkg-install.ts");

const ROOT = new URL("../", import.meta.url);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const H = (c) => c.repeat(64);
const url = (fn) => `https://${FILES_HOST}/packages/ab/cd/${fn}`;
/** A PyPI file entry as the JSON API lists it. */
const file = (fn, o = {}) => ({ filename: fn, size: 1000, yanked: false, url: url(fn), digests: { sha256: H("a") }, ...o });
/** A project answer whose latest release is `version`, with its files. */
const answer = (name, version, files, requires_dist = null) => ({ info: { name, version, requires_python: null, requires_dist }, urls: files, releases: { [version]: files } });
/** A `get` over a table of answers by URL; a URL not in it is a 404. Records the URLs asked. */
const fakeGet = (table) => { const asked = []; const get = async (u) => { asked.push(u); return table[u] ?? null; }; get.asked = asked; return get; };
const U = (n, v) => `https://pypi.org/pypi/${n}${v ? `/${v}` : ""}/json`;
const CORE = {
    tags: CORE_ENV.tags, markerEnv: CORE_ENV.markerEnv, python: CORE_ENV.python,
    lock: new Map([["six", { version: "1.17.0", file: "six-1.17.0-py3-none-any.whl", depends: [] }]]),
    preloaded: new Set(),
};
/** A Response over `bytes`, split into chunks, with a declared content-length (or none). */
function respond(bytes, { status = 200, length = bytes.length, chunk = 16 } = {}) {
    const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); } });
    return new Response(body, { status, headers: length === null ? {} : { "content-length": String(length) } });
}
/** Stub fetch with `handler(url, init)`; returns the calls. */
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (u, init) => { calls.push({ url: String(u), init }); return handler(String(u), init); };
    return calls;
}

// --- A. an untrusted answer may only ever become one request, for the card's file, on the one files host ---

test("no answer can make the worker fetch anything but the card's own wheel from files.pythonhosted.org: its other URLs are dropped, not followed", async () => {
    const fn = "victim-1.0-py3-none-any.whl";
    const bytes = new Uint8Array(64).map((_, i) => (i * 11 + 3) & 255);
    const good = { filename: fn, size: bytes.length, digests: { sha256: sha(bytes) } };
    // Every way an answer for THIS project could try to move the download: a look-alike host, a host in the userinfo, a
    // query, a fragment, a traversal path, a plain http URL, and a URL that is good for a file the card does not show.
    const hostile = [
        file(fn, { ...good, url: `https://evil.example/packages/ab/cd/${fn}` }),
        file(fn, { ...good, url: `https://${FILES_HOST}@evil.example/packages/ab/cd/${fn}` }),
        file(fn, { ...good, url: `${url(fn)}?redirect=evil` }),
        file(fn, { ...good, url: `${url(fn)}#evil` }),
        file(fn, { ...good, url: `https://${FILES_HOST}/packages/../../x/${fn}` }),
        file(fn, { ...good, url: `http://${FILES_HOST}/packages/ab/cd/${fn}` }),
        file(fn, { ...good, url: `https://${FILES_HOST}:8443/packages/ab/cd/${fn}` }),
        file("other-9.9-py3-none-any.whl", { filename: "other-9.9-py3-none-any.whl", size: bytes.length, digests: { sha256: sha(bytes) }, url: url(fn) }),
    ];
    // Control: the answer holds one file that is fetchable, or the empty result below would prove nothing.
    const get = fakeGet({ [U("victim")]: answer("victim", "1.0", [file(fn, good), ...hostile]) });
    const r = await resolveVerdict({ name: "victim" }, CORE, get);
    assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict));
    // The card's file is the good one, and the URL recorded for it is the good one: a hostile duplicate carrying the same
    // digest and filename must not overwrite it (`filesOf` records by fileKey, so the LAST one would win).
    assert.equal(r.verdict.files.length, 1, `the answer's other files reached the card: ${JSON.stringify(r.verdict.files)}`);
    assert.equal(r.urls.size, 1, `the answer's other URLs survived: ${[...r.urls.values()].join(", ")}`);
    assert.equal(r.urls.get(fileKey(sha(bytes), fn)), url(fn));
    // And the join: what fetchApproved then asks the network for is that one URL, and nothing else.
    const calls = stubFetch(() => respond(bytes));
    const text = await fetchApproved({ request: { name: "victim" }, card: { ok: true, files: r.verdict.files, loaded: [] }, urls: r.urls });
    assert.deepEqual(calls.map((c) => c.url), [url(fn)], "the download went somewhere the answer chose");
    assert.equal(calls[0].init.redirect, "error", "a redirect would be followed");
    assert.equal(calls[0].init.credentials, "omit");
    // What the person is told carries no URL: the answer names a file, never a host.
    assert.match(text, /^Approved: downloaded and checked 1 file/);
    assert.ok(!/https?:/.test(text), `the answer carried a URL: ${text}`);
});

// --- B. an index body past the bound is cut even when it lies about its length ---

test("an index answer past INDEX_BOUNDS.body is cut from the STREAM when its content-length does not say so, and nothing is parsed", async () => {
    let cut = false;
    const mb = new Uint8Array(1024 * 1024).fill(32);   // spaces: valid JSON whitespace, so a full read would parse as an empty answer
    const stream = (chunks) => new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('{"info":')); for (let i = 0; i < chunks; i++) c.enqueue(mb); c.close(); },
        cancel() { cut = true; },
    }), { status: 200 });
    for (const [label, declared] of [["no content-length", null], ["a content-length that lies", "16"]]) {
        globalThis.fetch = async () => {
            const res = stream(Math.ceil(INDEX_BOUNDS.body / mb.length) + 1);
            return declared === null ? new Response(res.body, { status: 200 }) : new Response(res.body, { status: 200, headers: { "content-length": declared } });
        };
        cut = false;
        await assert.rejects(indexGetFor(`redteam-b-${label}`, () => {})("https://pypi.org/pypi/big/json"), /larger than/,
            `${label}: an answer past the bound was read whole`);
    }
    assert.ok(cut, "the read was not cancelled: the stream was consumed to its end");
    // Control: an answer UNDER the bound is read and parsed, so the cap above is the bound and not a dead reader.
    globalThis.fetch = async () => new Response(JSON.stringify({ info: { name: "ok" } }), { status: 200 });
    assert.deepEqual(await indexGetFor("redteam-b-control", () => {})("https://pypi.org/pypi/ok/json"), { info: { name: "ok" } });
});

// --- C. the mirror and the index have ONE caller, python_install's own path ---

test("nothing but python_install's precheck reaches the mirror or the index reader: enumerated over src, so a second caller reds this", async () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith(".gen.ts")) files.push(p);
    } };
    walk(new URL("src/", ROOT).pathname);
    assert.ok(files.length > 100, `the enumeration read ${files.length} files`);
    const importers = files.filter((f) => /\bfrom\s+["'][^"']*sw-pkg-mirror(\.ts)?["']|\bimport\(\s*["'][^"']*sw-pkg-mirror/.test(fs.readFileSync(f, "utf8")))
        .map((f) => path.relative(new URL(".", ROOT).pathname, f)).sort();
    assert.deepEqual(importers, ["src/sw/sw-pkg-install.ts"], `the index and the wheel host have another caller: ${importers.join(", ")}`);
    // Control: the enumeration sees imports at all, and the file it should is not filtered out by the pattern.
    const anyImporter = files.filter((f) => /from\s+["'][^"']*\/sw-runs(\.ts)?["']/.test(fs.readFileSync(f, "utf8")));
    assert.ok(anyImporter.length > 5, `the pattern found ${anyImporter.length} importers of sw-runs: the test pattern is broken, not the code`);
});

// --- D. what a person is shown and told names no host ---

test("the card's rows and the install answer carry no URL: a person approves a file, never a host", async () => {
    const fn = "demo-1.0-py3-none-any.whl";
    const bytes = new Uint8Array(32).fill(4);
    const get = fakeGet({ [U("demo")]: answer("demo", "1.0", [file(fn, { size: bytes.length, digests: { sha256: sha(bytes) } })]) });
    const r = await resolveVerdict({ name: "demo" }, CORE, get);
    assert.equal(r.verdict.ok, true);
    const card = { request: { name: "demo" }, card: { ok: true, files: r.verdict.files, loaded: [] }, urls: r.urls };
    const shown = JSON.stringify(card.card.files);
    assert.ok(!/https?:|\/packages\//.test(shown), `the card shows a URL: ${shown}`);
    stubFetch(() => respond(bytes));
    const text = await fetchApproved(card);
    assert.ok(!/https?:/.test(text), `the answer names a URL: ${text}`);
    // Control: the URL IS held beside the card, or the assertion above would be about an absent map.
    assert.deepEqual([...card.urls.values()], [url(fn)]);
});

// --- E. one digest is downloaded once, whatever a second row calls it ---

test("a digest the mirror already holds is not fetched again, even when a second card row names it under another filename", async () => {
    const first = "held-1.0-py3-none-any.whl";
    const bytes = new Uint8Array(48).map((_, i) => (i * 5 + 1) & 255);
    const digest = sha(bytes);
    const other = new Uint8Array(16).fill(9);
    const calls = stubFetch((u) => respond(u.includes("new-") ? other : bytes));
    assert.equal(await ensureWheel({ name: "held", version: "1.0", filename: first, size: bytes.length, sha256: digest, url: url(first) }), "downloaded");
    assert.equal(calls.length, 1);
    // The SAME bytes, presented under another name and so another URL: the mirror has them, so no request is made.
    assert.equal(await ensureWheel({ name: "held", version: "1.0", filename: "held-1.0-2-py3-none-any.whl", size: bytes.length, sha256: digest, url: url("held-1.0-2-py3-none-any.whl") }), "held");
    assert.equal(calls.length, 1, "a held digest was fetched again");
    assert.ok((await mirroredDigests()).has(digest));
    // Control: a digest the mirror does NOT hold is fetched, so the assertion above is not a reader that never fetches.
    assert.equal(await ensureWheel({ name: "held", version: "1.0", filename: "new-1.0-py3-none-any.whl", size: other.length, sha256: sha(other), url: url("new-1.0-py3-none-any.whl") }), "downloaded");
    assert.equal(calls.length, 2);
    // And the guard every URL passes through is the same one this row's filenames had to satisfy.
    assert.equal(wheelUrlOk(url("new-1.0-py3-none-any.whl"), "new-1.0-py3-none-any.whl"), true);
    assert.equal(wheelUrlOk(url("new-1.0-py3-none-any.whl"), "other-1.0-py3-none-any.whl"), false);
});
