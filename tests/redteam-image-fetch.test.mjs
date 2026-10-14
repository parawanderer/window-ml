// redteam-image-fetch.test.mjs — what an approved page gets from FETCH_IMAGE_B64 (`ml._fetchImageBase64`), the
// worker's read of an image URL the page names.
//
// The page names any URL and reads the answer. The worker's fetch reaches every host the extension has host permission
// for, and a worker fetch in the default credentials mode carries that host's cookies, so the read was AS THE PERSON:
// another origin's HTML, JSON or logged-in image, which the page's own fetch cannot read. What the page must NOT get: the
// person's cookies spent on its URL, anything that is not an image, a body past the cap, a private or loopback host
// reached through a redirect, the extension's referrer, or an error that differs by what the server answered. What it
// keeps: a public image's bytes, as a data URL labelled by the bytes. The worker is the real background bundle (node:vm)
// with a mocked `fetch`; the handler is `fetchImageDataUrl` (src/sw/sw-image-fetch.ts).
import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-SECRET-KEY", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });
const PAGE = { tab: { id: 9, url: "https://site.example/page" }, url: "https://site.example/page" };
const IMG = "https://cdn.example/pic.png";

// The first bytes of each format the sniffer names; the rest is padding, which the sniffer does not read.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const enc = (s) => new TextEncoder().encode(s);

/** A response stub with a streamed body, a content type, a status and (after a redirect) the final URL. */
function bytesResponse(bytes, { type = "image/png", status = 200, url, redirected = false, length } = {}) {
    let sent = false;
    const headers = { "content-type": type, ...(length != null ? { "content-length": String(length) } : {}) };
    return {
        ok: status >= 200 && status < 300, status, url, redirected,
        headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
        body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }) },
        text: async () => new TextDecoder().decode(bytes),
    };
}

/** One FETCH_IMAGE_B64 from an approved page, answered by `respond`; returns the answer and the fetch calls made. */
async function read(url, respond) {
    const bg = loadBackground({ config: baseConfig(), onFetch: (call) => respond(call) });
    const res = await bg.send({ type: "FETCH_IMAGE_B64", payload: { url } }, PAGE);
    return { res, calls: bg.calls.filter((c) => !String(c.url).startsWith("http://host/")) };
}

// --- the person's cookies: never spent on a URL a page names ---
// A service worker's fetch with no `credentials` is `same-origin` relative to the extension's origin, but every host the
// extension may reach is treated as that origin's for cookies: the default sent them. The handler names `omit`.

test("a page's FETCH_IMAGE_B64 sends no cookies: the worker's fetch is credentials:'omit'", async () => {
    const { calls } = await read(IMG, () => bytesResponse(PNG));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts?.credentials, "omit", `the fetch must not carry the person's cookies (${JSON.stringify(calls[0].opts)})`);
});

test("a page's FETCH_IMAGE_B64 sends no referrer and reads no HTTP cache", async () => {
    const { calls } = await read(IMG, () => bytesResponse(PNG));
    assert.equal(calls[0].opts?.referrerPolicy, "no-referrer", "no Referer: the extension's id is not sent to the image host");
    // The worker's cache is shared with its credentialed fetches (FETCH_URL with credentials, FETCH_SHEET): a cached
    // as-the-person response must never answer a page's uncredentialed read, nor its timing say one is there.
    assert.equal(calls[0].opts?.cache, "no-store", "the HTTP cache is neither read nor written");
});

// --- only an image: the bytes decide, the header must agree ---

test("an HTML response is refused, whatever its content type says", async () => {
    for (const type of ["text/html", "image/png", "application/octet-stream"]) {
        const { res } = await read(IMG, () => bytesResponse(enc("<!doctype html><html><body>Signed in as ada</body></html>"), { type }));
        assert.ok(res.error && !res.data, `HTML served as ${type} is refused (${JSON.stringify(res).slice(0, 120)})`);
        assert.ok(!/ada/.test(JSON.stringify(res)), "none of the body reaches the page");
    }
});

test("a JSON response is refused", async () => {
    const { res } = await read("https://api.example/me", () => bytesResponse(enc('{"email":"ada@example.com"}'), { type: "application/json" }));
    assert.ok(res.error && !res.data, "JSON is not an image");
    assert.ok(!/ada@/.test(JSON.stringify(res)));
});

test("image bytes behind a non-image content type are refused (text/html, application/json)", async () => {
    for (const type of ["text/html", "application/json", "text/plain"]) {
        const { res } = await read(IMG, () => bytesResponse(PNG, { type }));
        assert.ok(res.error && !res.data, `a PNG labelled ${type} is refused`);
    }
});

test("an SVG is refused: it is XML text, not raster bytes", async () => {
    const { res } = await read("https://cdn.example/a.svg", () => bytesResponse(enc('<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>'), { type: "image/svg+xml" }));
    assert.ok(res.error && !res.data);
});

// --- a redirect: the final URL is held to the same rule as the first ---

test("a redirect to a private or loopback address is refused", async () => {
    for (const final of ["http://127.0.0.1/admin.png", "http://192.168.1.1/cam.jpg", "http://169.254.169.254/latest/meta-data/", "http://localhost:11434/x.png", "http://[::ffff:7f00:1]/x.png", "http://100.101.102.103/x.png"]) {
        const { res } = await read(IMG, () => bytesResponse(PNG, { url: final, redirected: true }));
        assert.ok(res.error && !res.data, `a redirect to ${final} is refused (${JSON.stringify(res).slice(0, 80)})`);
    }
});

test("a redirect to another public host still reads (a CDN hop)", async () => {
    const { res } = await read(IMG, () => bytesResponse(PNG, { url: "https://img.cdn2.example/p.png", redirected: true }));
    assert.match(String(res.data), /^data:image\/png;base64,/);
});

// --- the private-address rule, on the first URL ---

test("a first URL naming a private, loopback, tailnet or single-label host is refused before any fetch", async () => {
    const hosts = [
        "http://127.0.0.1/x.png", "http://10.0.0.1/x.png", "http://172.16.0.1/x.png", "http://192.168.0.1/x.png",
        "http://169.254.169.254/", "http://0.0.0.0/x.png", "http://localhost/x.png", "http://a.localhost/x.png",
        "http://[::1]/x.png", "http://[::]/x.png", "http://[::ffff:127.0.0.1]/x.png", "http://[::ffff:10.0.0.1]/x.png",
        "http://[fe80::1]/x.png", "http://[fd00::1]/x.png", "http://2130706433/x.png", "http://0x7f.1/x.png",
        "http://100.64.0.1/x.png", "http://100.127.255.254/x.png", "http://mlbox/x.png", "http://mlbox:8080/x.png",
        "http://printer.local/x.png", "http://box.internal/x.png", "http://nas.lan/x.png", "http://r.home.arpa/x.png",
        "file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "not a url",
    ];
    for (const url of hosts) {
        const { res, calls } = await read(url, () => bytesResponse(PNG));
        assert.equal(calls.length, 0, `${url} is never fetched`);
        assert.ok(res.error, `${url} is refused`);
    }
});

// --- size ---

test("a body past the cap is refused, by its declared length before reading and by what arrives", async () => {
    const big = new Uint8Array(16_000_001); big.set(PNG);
    const declared = await read(IMG, () => bytesResponse(PNG, { length: 16_000_001 }));
    assert.ok(declared.res.error && !declared.res.data, "a declared content-length past the cap is refused");
    const actual = await read(IMG, () => bytesResponse(big));
    assert.ok(actual.res.error && !actual.res.data, "a streamed body past the cap is refused (no length header)");
});

// --- uniform failures: the answer says nothing about what the server said ---
// The server never sees a cookie now, so its status does not depend on the person; even so, a page that could tell a 401
// from a 404 from a network error from "not an image" learns a cross-origin status its own fetch cannot read. Every
// failure after the request was made answers the same text.

test("401, 403, 404, 500, a network error, HTML, an oversized body and a private redirect answer one identical error", async () => {
    const big = new Uint8Array(16_000_001); big.set(PNG);
    const outcomes = [
        () => bytesResponse(enc("no"), { status: 401, type: "text/html" }),
        () => bytesResponse(enc("no"), { status: 403, type: "text/html" }),
        () => bytesResponse(PNG, { status: 404 }),
        () => bytesResponse(enc("err"), { status: 500, type: "text/plain" }),
        () => { throw new TypeError("Failed to fetch"); },
        () => bytesResponse(enc("<html>login</html>"), { type: "text/html" }),
        () => bytesResponse(big),
        () => bytesResponse(PNG, { url: "http://10.1.1.1/x.png", redirected: true }),
    ];
    const errors = [];
    for (const respond of outcomes) {
        const { res } = await read(IMG, respond);
        assert.ok(!res.data, "no data on a failure");
        errors.push(res.error);
    }
    assert.equal(new Set(errors).size, 1, `every failure answers one text: ${JSON.stringify([...new Set(errors)])}`);
    assert.ok(errors[0] && !/\d{3}|fetch|html|private|redirect|large/i.test(errors[0]), `the text names no cause (${errors[0]})`);
});

// --- what still works: a public image's bytes, labelled by what they are ---

test("a public PNG, JPEG, GIF and WebP read as data URLs labelled by their bytes", async () => {
    for (const [bytes, mime] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [GIF, "image/gif"], [WEBP, "image/webp"]]) {
        const { res } = await read(IMG, () => bytesResponse(bytes, { type: "image/png; charset=binary" }));
        assert.ok(String(res.data).startsWith(`data:${mime};base64,`), `${mime}: ${JSON.stringify(res).slice(0, 80)}`);
        const back = Buffer.from(String(res.data).split(",")[1], "base64");
        assert.deepEqual([...back], [...bytes], "the bytes round-trip exactly");
    }
});

test("an image served as application/octet-stream (an S3 default) reads when its bytes are an image", async () => {
    const { res } = await read(IMG, () => bytesResponse(JPEG, { type: "application/octet-stream" }));
    assert.ok(String(res.data).startsWith("data:image/jpeg;base64,"));
});

test("a public name that merely starts like a private prefix still reads (fcbarcelona.com, fd.example, a public IPv6)", async () => {
    // The rule before this one matched `fc`/`fd`/`fe80` as a PREFIX of any hostname, so a public name was refused.
    for (const url of ["https://fcbarcelona.com/crest.png", "https://fd.example/x.png", "https://fe80.example.com/x.png", "https://localhost.example.com/x.png", "http://100.63.0.1/x.png", "http://[2606:4700::1111]/x.png", "https://cdn.example./x.png"]) {
        const { res, calls } = await read(url, () => bytesResponse(PNG));
        assert.equal(calls.length, 1, `${url} is fetched`);
        assert.match(String(res.data), /^data:image\/png;base64,/, url);
    }
});

// --- the sniffer: magic bytes name the image, and text never passes ---

test("imageMime names each raster format by its magic bytes and refuses text, SVG, PDF and a truncated header", async () => {
    const { imageMime } = await import("../src/sw/body-read.ts");
    const bmp = Uint8Array.from([0x42, 0x4d, 0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]);
    const ico = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]);
    const avif = Uint8Array.from([0, 0, 0, 0x1c, ...enc("ftypavif"), 0, 0, 0, 0]);
    const heic = Uint8Array.from([0, 0, 0, 0x18, ...enc("ftypheic"), 0, 0, 0, 0]);
    for (const [bytes, mime] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [GIF, "image/gif"], [WEBP, "image/webp"], [bmp, "image/bmp"], [ico, "image/x-icon"], [avif, "image/avif"], [heic, "image/heif"]])
        assert.equal(imageMime(bytes), mime);
    for (const bytes of [enc("<!doctype html>"), enc('{"a":1}'), enc("<svg xmlns='http://www.w3.org/2000/svg'/>"), enc("%PDF-1.7"), enc("BM is a word"), PNG.subarray(0, 4), new Uint8Array(0), Uint8Array.from([0, 0, 0, 0x18, ...enc("ftypmp42")])])
        assert.equal(imageMime(bytes), null, new TextDecoder().decode(bytes));
});
