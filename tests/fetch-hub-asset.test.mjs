// fetch-hub-asset.test.mjs — that fetch-hub's release download retries a 5xx and then falls back to the API asset endpoint.

import test from "node:test";
import assert from "node:assert";
import { releaseAsset } from "../scripts/fetch-hub.mjs";

/** A wait that records the attempts it waits after instead of spending the real backoff, so a row runs in
 *  milliseconds while still proving the pacing: the attempts named are exactly the gaps between retries. */
function instantSleep() {
    const sleeps = [];
    return { sleeps, sleep: async (attempt) => { sleeps.push(attempt); } };
}

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
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    try {
        const { archive, sums } = await releaseAsset("v0.4.3", "wmlhub-aarch64-apple-darwin.tar.gz", sleep);
        assert.equal(Buffer.from(archive).toString("utf8"), "hello hub\n", "the API's bytes are the archive");
        assert.equal(new TextDecoder().decode(sums), `${digest}  wmlhub-aarch64-apple-darwin.tar.gz\n`, "the API's digest is the shasum line");
        assert.equal(stub.downloadHits, 3, "the download route is tried three times before the fallback");
        assert.deepEqual(sleeps, [0, 1], "the download route's retries wait in their own gaps; the API needed none");
    } finally {
        globalThis.fetch = real;
    }
});

// --- the API's bytes come down the same CDN and 504 in the same window (#1535's e2e 2/3, 2026-11-08 10:40Z) ---

test("the API's own bytes 504 twice and the third try lands: the fallback is retried, not one shot", async () => {
    const digest = "cd".repeat(32);
    const body = new TextEncoder().encode("third time\n");
    let downloadHits = 0, bytesHits = 0;
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/releases/download/")) {
            if (!u.endsWith(".sha256")) downloadHits++;
            return { ok: false, status: 504, statusText: "", arrayBuffer: async () => new Uint8Array() };
        }
        if (u.includes("/releases/tags/")) {
            return { ok: true, status: 200, json: async () => ({ assets: [{ id: 4242, name: "wmlhub-x86_64-unknown-linux-gnu.tar.gz", digest: "sha256:" + digest }] }) };
        }
        if (u.includes("/releases/assets/")) {
            bytesHits++;
            const ok = bytesHits > 2;
            return { ok, status: ok ? 200 : 504, statusText: "", arrayBuffer: async () => body };
        }
        throw new Error(`unexpected URL: ${u}`);
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "third time\n");
        assert.equal(downloadHits, 3, "the download route was spent first");
        assert.equal(bytesHits, 3, "the API's bytes were asked three times");
        assert.deepEqual(sleeps, [0, 1, 0, 1], "each route's retries wait in their own gaps");
    } finally {
        globalThis.fetch = real;
    }
});

test("both routes 5xx through every attempt: one error naming both, no body", async () => {
    // The shape of the CI failure: the download route 504s, the API metadata answers and names the asset,
    // and the asset's own bytes 504 too (they come down the same CDN).
    const real = globalThis.fetch;
    const asked = [];
    const { sleeps, sleep } = instantSleep();
    globalThis.fetch = async (url) => {
        const u = String(url);
        asked.push(u);
        if (u.includes("/releases/tags/")) {
            return { ok: true, status: 200, json: async () => ({ assets: [{ id: 4242, name: "wmlhub-x86_64-unknown-linux-gnu.tar.gz", digest: "sha256:" + "ab".repeat(32) }] }) };
        }
        return { ok: false, status: 504, statusText: "", arrayBuffer: async () => new Uint8Array() };
    };
    try {
        const err = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep).then(() => null, (e) => e);
        assert.ok(err, "it throws");
        assert.equal(err.message, "neither the download route nor the release API served wmlhub-x86_64-unknown-linux-gnu.tar.gz on v0.4.3", "one error naming both routes and the asset");
        const downloads = asked.filter((u) => u.includes("/releases/download/") && !u.endsWith(".sha256")).length;
        const meta = asked.filter((u) => u.includes("/releases/tags/")).length;
        const bytes = asked.filter((u) => u.includes("/releases/assets/")).length;
        assert.equal(downloads, 3, "three download attempts");
        assert.equal(meta, 3, "three API metadata attempts");
        assert.equal(bytes, 3, "three API byte attempts — the bytes fetch is what 504'd in CI");
        assert.deepEqual(sleeps, [0, 1, 0, 1], "every retry pair waited: four waits for six spent attempts");
    } finally {
        globalThis.fetch = real;
    }
});

test("an intermittent 504 is survived by the retry, with no API call", async () => {
    const digest = "cd".repeat(32);
    const archive = new TextEncoder().encode("straight from the cdn\n");
    const sums = new TextEncoder().encode(`${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
    let downloadPairs = 0;
    const { sleeps, sleep } = instantSleep();
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
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "straight from the cdn\n");
        assert.equal(new TextDecoder().decode(got.sums), `${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
        assert.equal(downloadPairs, 2, "two pairs were asked: the 504 and the retry's 200");
        assert.deepEqual(sleeps, [0], "one wait, between the 504 and the retry");
    } finally {
        globalThis.fetch = real;
    }
});

test("the download route's own bytes and shasum line are used when it answers first time, and the URL is the asset's own name", async () => {
    const digest = "ef".repeat(32);
    const archive = new TextEncoder().encode("first try\n");
    const sums = new TextEncoder().encode(`${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
    const real = globalThis.fetch;
    const asked = [];
    const { sleeps, sleep } = instantSleep();
    globalThis.fetch = async (url) => {
        asked.push(String(url));
        return { ok: true, status: 200, arrayBuffer: async () => (String(url).endsWith(".sha256") ? sums : archive) };
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "first try\n");
        assert.equal(asked.filter((u) => u.includes("/releases/download/") && !u.endsWith(".sha256")).length, 1, "only one pair, no retry needed");
        // The name is the asset's own: the URL is exactly `<tag>/<asset.name>`, never a second `.tar.gz`.
        assert.equal(asked[0], "https://github.com/parawanderer/window-ml-hub/releases/download/v0.4.3/wmlhub-x86_64-unknown-linux-gnu.tar.gz");
        assert.equal(asked[1], "https://github.com/parawanderer/window-ml-hub/releases/download/v0.4.3/wmlhub-x86_64-unknown-linux-gnu.tar.gz.sha256");
        assert.deepEqual(sleeps, [], "first try: nothing waited");
    } finally {
        globalThis.fetch = real;
    }
});

// --- a request or a body that DIES rather than answering: the retry is the same (e3's `fetch failed`, 2026-11-08) ---

test("a fetch that throws before a response is retried like a 504, with no API call", async () => {
    // The shape main died of at 10:40Z (run 42472382289): `fetch-hub: fetch failed`, no HTTP status at all.
    const digest = "cd".repeat(32);
    const archive = new TextEncoder().encode("after the thunder\n");
    const sums = new TextEncoder().encode(`${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
    let pairs = 0, apiHits = 0;
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/releases/download/")) {
            if (u.endsWith(".sha256")) return { ok: true, status: 200, arrayBuffer: async () => sums };
            pairs++;
            if (pairs < 3) throw new TypeError("fetch failed"); // the transport error, before any response
            return { ok: true, status: 200, arrayBuffer: async () => archive };
        }
        apiHits++;
        throw new Error(`unexpected URL: ${u}`);
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "after the thunder\n", "the third ask lands");
        assert.equal(pairs, 3, "the dying asks were retried, not let through");
        assert.equal(apiHits, 0, "a retry that lands needs no fallback");
        assert.deepEqual(sleeps, [0, 1], "one wait per retry gap");
    } finally {
        globalThis.fetch = real;
    }
});

test("a body that dies mid-read is the retry's business, not the run's", async () => {
    const digest = "cd".repeat(32);
    const archive = new TextEncoder().encode("whole on the retry\n");
    const sums = new TextEncoder().encode(`${digest}  wmlhub-x86_64-unknown-linux-gnu.tar.gz\n`);
    let pairs = 0;
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (!u.includes("/releases/download/")) throw new Error(`unexpected URL: ${u}`);
        const isSum = u.endsWith(".sha256");
        pairs += isSum ? 0 : 1;
        return {
            ok: true, status: 200,
            arrayBuffer: async () => {
                if (!isSum && pairs === 1) throw new TypeError("terminated"); // the connection cut mid-body
                return isSum ? sums : archive;
            },
        };
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "whole on the retry\n");
        assert.equal(pairs, 2, "the dead read was retried");
        assert.deepEqual(sleeps, [0], "one wait, between the dead read and the retry");
    } finally {
        globalThis.fetch = real;
    }
});

test("the fallback's metadata fetch and its body dying are retried", async () => {
    const digest = "cd".repeat(32);
    const archive = new TextEncoder().encode("from the api\n");
    let metaHits = 0, bytesHits = 0;
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/releases/download/")) {
            return { ok: false, status: 504, statusText: "", arrayBuffer: async () => new Uint8Array() };
        }
        if (u.includes("/releases/tags/")) {
            metaHits++;
            if (metaHits === 1) throw new TypeError("fetch failed"); // dies before the response
            return {
                ok: true, status: 200,
                json: async () => {
                    if (metaHits === 2) throw new TypeError("terminated"); // dies reading it
                    return { assets: [{ id: 4242, name: "wmlhub-x86_64-unknown-linux-gnu.tar.gz", digest: "sha256:" + digest }] };
                },
            };
        }
        if (u.includes("/releases/assets/")) {
            bytesHits++;
            return { ok: true, status: 200, arrayBuffer: async () => archive };
        }
        throw new Error(`unexpected URL: ${u}`);
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "from the api\n");
        assert.equal(metaHits, 3, "both dead metadata reads were retried");
        assert.equal(bytesHits, 1, "the bytes were asked only once");
        assert.deepEqual(sleeps, [0, 1, 0, 1], "the download's two gaps, then the fallback's two");
    } finally {
        globalThis.fetch = real;
    }
});

test("the fallback's asset fetch and its body dying are retried", async () => {
    const digest = "cd".repeat(32);
    const archive = new TextEncoder().encode("from the api on the third\n");
    let metaHits = 0, bytesHits = 0;
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/releases/download/")) {
            return { ok: false, status: 504, statusText: "", arrayBuffer: async () => new Uint8Array() };
        }
        if (u.includes("/releases/tags/")) {
            metaHits++;
            return { ok: true, status: 200, json: async () => ({ assets: [{ id: 4242, name: "wmlhub-x86_64-unknown-linux-gnu.tar.gz", digest: "sha256:" + digest }] }) };
        }
        if (u.includes("/releases/assets/")) {
            bytesHits++;
            if (bytesHits === 1) throw new TypeError("fetch failed"); // dies before the response
            return {
                ok: true, status: 200,
                arrayBuffer: async () => {
                    if (bytesHits === 2) throw new TypeError("terminated"); // dies reading it
                    return archive;
                },
            };
        }
        throw new Error(`unexpected URL: ${u}`);
    };
    try {
        const got = await releaseAsset("v0.4.3", "wmlhub-x86_64-unknown-linux-gnu.tar.gz", sleep);
        assert.equal(Buffer.from(got.archive).toString("utf8"), "from the api on the third\n");
        assert.equal(metaHits, 3, "the metadata was re-read each round");
        assert.equal(bytesHits, 3, "both dead byte attempts were retried");
        assert.deepEqual(sleeps, [0, 1, 0, 1], "the download's two gaps, then the fallback's two");
    } finally {
        globalThis.fetch = real;
    }
});
