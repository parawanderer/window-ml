// fetch-hub-asset.test.mjs — that fetch-hub's release download retries a 5xx and then falls back to the API asset endpoint.

import test from "node:test";
import assert from "node:assert";
import { releaseAsset } from "../scripts/fetch-hub.mjs";

// --- the download CDN 504'd and the API answered (e3, 2026-11-08) ---

/**
 * A fetch that answers `ok` for the API pair and 504 for everything under
 * `releases/download/`, and records how many times each was asked.
 */
function fetchFallingDownloadServingApi(bodyOf) {
    let downloadHits = 0;
    return {
        get downloadHits() { return downloadHits; },
        fetch: async (url, init) => {
            const u = String(url);
            if (u.includes("/releases/download/")) {
                if (!u.endsWith(".sha256")) downloadHits++;
                return { ok: false, status: 504, statusText: "Not Found", arrayBuffer: async () => new Uint8Array() };
            }
            if (u.includes("/releases/tags/")) {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        assets: [{ id: 4242, name: "wmlhub-aarch64-apple-darwin.tar.gz", digest: "sha256:" + bodyOf.digest }],
                    }),
                };
            }
            if (u.includes("/releases/assets/")) {
                return { ok: true, status: 200, arrayBuffer: async () => bodyOf.bytes };
            }
            return { ok: false, status: 404, statusText: "Not Found", arrayBuffer: async () => new Uint8Array() };
        },
    };
}

test("three 5xxs on the download fall back to the release API asset endpoint", async () => {
    const digest = "ab".repeat(32);
    const body = new TextEncoder().encode("hello hub\n");
    const stub = fetchFallingDownloadServingApi({ digest, bytes: body });
    const real = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    try {
        const { archive, sums } = await releaseAsset("v0.4.3", "wmlhub-aarch64-apple-darwin.tar.gz");
        assert.equal(Buffer.from(archive).toString("utf8"), "hello hub\n", "the API's bytes are the archive");
        assert.equal(new TextDecoder().decode(sums), `${digest}  wmlhub-aarch64-apple-darwin.tar.gz\n`, "the API's digest is the shasum line");
        assert.equal(stub.downloadHits, 3, "the download route is tried three times before the fallback");
    } finally {
        globalThis.fetch = real;
    }
});

test("an intermittent 504 is survived by the retry, with no API call", async () => {
    const digest = "cd".repeat(32);
    const archive = new TextEncoder().encode("straight from the cdn\n");
    const sums = new TextEncoder().encode(`${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
    let downloadPairs = 0;
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/releases/download/")) {
            if (!u.endsWith(".sha256")) downloadPairs++;
            // 504 on the first pair, 200 after: the retry must catch the good window.
            const ok = downloadPairs > 1;
            return {
                ok,
                status: ok ? 200 : 504,
                statusText: ok ? "OK" : "Not Found",
                arrayBuffer: async () => (u.endsWith(".sha256") ? sums : archive),
            };
        }
        throw new Error(`unexpected URL in the fallback test: ${u}`);
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz");
        assert.equal(Buffer.from(got.archive).toString("utf8"), "straight from the cdn\n");
        assert.equal(new TextDecoder().decode(got.sums), `${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
        assert.equal(downloadPairs, 2, "two pairs were asked: the 504 and the retry's 200");
    } finally {
        globalThis.fetch = real;
    }
});

test("the download route's own bytes and shasum line are used when it answers first time", async () => {
    const digest = "ef".repeat(32);
    const archive = new TextEncoder().encode("first try\n");
    const sums = new TextEncoder().encode(`${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
    const real = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async (url) => {
        asked.push(String(url));
        return { ok: true, status: 200, arrayBuffer: async () => (String(url).endsWith(".sha256") ? sums : archive) };
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz");
        assert.equal(Buffer.from(got.archive).toString("utf8"), "first try\n");
        assert.equal(asked.filter((u) => u.includes("/releases/download/") && !u.endsWith(".sha256")).length, 1, "only one pair, no retry needed");
        assert.equal(asked.some((u) => u.includes("/releases/download/")), true, "the download route is tried first");
    } finally {
        globalThis.fetch = real;
    }
});
