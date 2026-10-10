// sw-prices.test.mjs — price snapshots for spend: fetched only when the setting is on, each body stored once after its
// hash is checked, the reference stamped on a call, and the exact bytes read back for the bench.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
// Not clean UTF-8 on purpose: a decode and re-encode would change the hash.
const HTML = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0x3c, 0x2f, 0x70, 0x3e]);
const JSONB = Buffer.from('{"data":[{"id":"x","pricing":{"prompt":"0.000001"}}]}');

/** A price service: `/latest` names each source's hash, `/raw/<hash>` serves `bodies[hash]`; records every URL asked. */
function service({ bodies, sources, fetchedAt = "2026-10-10T09:07:00Z" }) {
    const asked = [];
    const fetch = async (url) => {
        asked.push(String(url));
        const u = new URL(url);
        if (u.pathname === "/latest") return new Response(JSON.stringify({ fetched_at: fetchedAt, sources }), { status: 200 });
        const m = u.pathname.match(/^\/raw\/([0-9a-f]{64})$/);
        if (m && bodies[m[1]]) return new Response(bodies[m[1]], { status: 200, headers: { "content-type": "text/html" } });
        return new Response("no", { status: 404 });
    };
    return { fetch, asked };
}

/** A fresh module over a fresh database, with `fetch` replaced. */
async function fresh(fetchImpl) {
    globalThis.indexedDB = new IDBFactory();
    globalThis.fetch = fetchImpl;
    return import(`../src/sw/sw-prices.ts?t=${Math.random()}`);
}

// --- off by default ---

test("with the setting empty nothing is fetched and a call names no prices", async () => {
    const svc = service({ bodies: {}, sources: {} });
    const { pricesForCall } = await fresh(svc.fetch);
    for (const setting of ["", "   ", undefined, "not a url"]) assert.equal(await pricesForCall(setting), null);
    assert.deepEqual(svc.asked, [], "no request when spend tracking is off");
});

// --- a snapshot, by reference ---

test("a call names each source by its hash, and each body is fetched once and read back as the exact bytes", async () => {
    const h1 = sha(HTML), h2 = sha(JSONB);
    const svc = service({ bodies: { [h1]: HTML, [h2]: JSONB }, sources: { deepseek_pricing_page: { sha256: h1, content_type: "text/html" }, openrouter: { sha256: h2 } } });
    const { pricesForCall, priceBody } = await fresh(svc.fetch);
    const ref = await pricesForCall("http://box:3002/latest");
    assert.deepEqual(ref, { fetchedAt: "2026-10-10T09:07:00Z", sources: { deepseek_pricing_page: h1, openrouter: h2 } });
    assert.deepEqual(svc.asked.sort(), ["http://box:3002/latest", `http://box:3002/raw/${h1}`, `http://box:3002/raw/${h2}`].sort());
    const body = await priceBody(h1);
    assert.equal(body.source, "deepseek_pricing_page");
    assert.equal(sha(Buffer.from(body.base64, "base64")), h1, "the bytes the hash names, not a re-encoded string");
    assert.equal(await priceBody("0".repeat(64)), null, "an unknown hash is null, never a throw");
    assert.equal(await priceBody("../etc"), null);
    // Fresh within the hour: the next call asks nothing.
    const before = svc.asked.length;
    assert.deepEqual(await pricesForCall("http://box:3002"), ref);
    assert.equal(svc.asked.length, before);
});

test("a body that does not match its hash is not stored and not named", async () => {
    const h1 = sha(HTML);
    const svc = service({ bodies: { [h1]: JSONB }, sources: { moonshot_pricing_page: { sha256: h1 } } });
    const { pricesForCall, priceBody } = await fresh(svc.fetch);
    assert.deepEqual(await pricesForCall("http://box:3002"), { fetchedAt: "2026-10-10T09:07:00Z", sources: {} });
    assert.equal(await priceBody(h1), null);
});

test("a price service that is down never fails the call: it runs with no prices named", async () => {
    const { pricesForCall } = await fresh(async () => { throw new TypeError("fetch failed"); });
    assert.equal(await pricesForCall("http://box:3002"), null);
});
