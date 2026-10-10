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

// --- what a call records ---

test("a call records the electricity price only when one is set, and the price snapshot only when the service is", async () => {
    const svc = service({ bodies: {}, sources: {} });
    const { spendForCall } = await fresh(svc.fetch);
    assert.deepEqual(await spendForCall({ priceSnapshotUrl: "", electricityPerKwh: 0, electricityCurrency: "EUR" }), {});
    assert.deepEqual(await spendForCall({ priceSnapshotUrl: "", electricityPerKwh: 0.31, electricityCurrency: "eur " }), { electricity: { perKwh: 0.31, currency: "EUR" } });
    assert.deepEqual(svc.asked, [], "no price service set: nothing fetched");
});

// --- a two-rate tariff ---

test("off-peak: the hours wrap past midnight, weekends count all day when set, and unparsable hours mean none", async () => {
    const { isOffPeak } = await fresh(async () => new Response("", { status: 404 }));
    const at = (day, hour) => new Date(2026, 9, 5 + day, hour, 30);   // 2026-10-05 is a Monday (day 0 here)
    for (const [h, want] of [[22, false], [23, true], [3, true], [6, true], [7, false], [12, false]]) assert.equal(isOffPeak(at(0, h), "23-7", true), want, `Monday ${h}:30`);
    assert.equal(isOffPeak(at(5, 12), "23-7", true), true, "Saturday noon, weekends on");
    assert.equal(isOffPeak(at(5, 12), "23-7", false), false, "Saturday noon, weekends off");
    assert.equal(isOffPeak(at(0, 10), "9-17", false), true, "a daytime window that does not wrap");
    for (const bad of ["", "night", "23", "5-5"]) assert.equal(isOffPeak(at(0, 3), bad, false), false, JSON.stringify(bad));
});

test("a call records the rate in effect when it ran; with no off-peak price set it records the single rate as before", async () => {
    const { spendForCall } = await fresh(async () => new Response("", { status: 404 }));
    const cfg = { electricityPerKwh: 0.26216, electricityCurrency: "EUR", electricityOffPeakPerKwh: 0.22113, electricityOffPeakHours: "23-7", electricityOffPeakWeekends: true };
    const tariff = { normalPerKwh: 0.26216, offPeakPerKwh: 0.22113, offPeakHours: "23-7", offPeakWeekends: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    assert.deepEqual(await spendForCall(cfg, new Date(2026, 9, 5, 14)), { electricity: { perKwh: 0.26216, currency: "EUR", rate: "normal", tariff } });
    assert.deepEqual(await spendForCall(cfg, new Date(2026, 9, 5, 23, 30)), { electricity: { perKwh: 0.22113, currency: "EUR", rate: "off-peak", tariff } }, "the whole tariff rides along, so a stretch crossing 23:00 can be split later");
    assert.deepEqual(await spendForCall({ ...cfg, electricityOffPeakPerKwh: 0 }, new Date(2026, 9, 5, 23, 30)), { electricity: { perKwh: 0.26216, currency: "EUR" } });
});

// --- priced on read, for the panel ---

/** A snapshot with a model list (one local model, one external) and OpenRouter's prices for the external one. */
const OWUI = Buffer.from(JSON.stringify({ data: [{ id: "qwen3:8b", ollama: {} }, { id: "or.acme/m1", connection_type: "external" }] }));
const OR = Buffer.from(JSON.stringify({ data: [{ id: "acme/m1", pricing: { prompt: "0.000002", completion: "0.00001" } }] }));

test("each call is priced against the snapshot it ran under: priced, local, reported, or unpriced with the reason", async () => {
    const svc = service({ bodies: { [sha(OWUI)]: OWUI, [sha(OR)]: OR }, sources: { owui_models: { sha256: sha(OWUI) }, openrouter: { sha256: sha(OR) } } });
    const { pricesForCall, costCalls } = await fresh(svc.fetch);
    const prices = await pricesForCall("http://box:3002");
    const [ext, local, reported, none, gone] = await costCalls([
        { usage: { promptTokens: 1000, completionTokens: 100, prices }, model: "or.acme/m1" },
        { usage: { promptTokens: 1000, completionTokens: 100, prices }, model: "qwen3:8b" },
        { usage: { promptTokens: 10, completionTokens: 1, raw: { cost: 0.5 } }, model: "anything" },
        { usage: { promptTokens: 10, completionTokens: 1 }, model: "or.acme/m1" },
        { usage: { promptTokens: 10, completionTokens: 1, prices: { fetchedAt: "x", sources: { owui_models: "0".repeat(64) } } }, model: "or.acme/m1" },
    ]);
    assert.ok(Math.abs(ext.computed - (1000 * 0.000002 + 100 * 0.00001)) < 1e-12);
    assert.equal(ext.basis, "openrouter");
    assert.equal(local.local, true);
    assert.equal(local.computed, null, "a local model is never priced in tokens");
    assert.equal(reported.reported, 0.5, "the provider's own figure needs no snapshot");
    assert.equal(none.computed, null);
    assert.equal(none.why, "no price snapshot recorded");
    assert.equal(gone.computed, null, "a snapshot this browser no longer holds prices nothing");
    assert.equal(gone.why, "no price snapshot recorded");
    assert.deepEqual(await costCalls("not a list"), []);
    assert.deepEqual((await costCalls([null])).map((c) => c.why), ["no price snapshot recorded"], "a malformed call is unpriced, never a throw");
});

test("PRICE_CALLS answers an extension page and refuses a web page", async () => {
    const { createRequire } = await import("node:module");
    const { loadBackground } = createRequire(import.meta.url)("./helpers");
    const bg = loadBackground({});
    const calls = [{ usage: { promptTokens: 1, completionTokens: 1, raw: { cost: 0.25 } }, model: "m" }];
    const refused = await bg.send({ type: "PRICE_CALLS", payload: { calls } }, { tab: { id: 7, url: "https://evil.example/" }, url: "https://evil.example/" });
    assert.match(refused.error, /Refused/);
    assert.equal(refused.data, undefined);
    const reply = await bg.send({ type: "PRICE_CALLS", payload: { calls } }, { url: "chrome-extension://test/sidebar.html", tab: { id: 7, url: "https://evil.example/" } });
    assert.equal(reply.data[0].reported, 0.25, "the overlay is an extension frame inside a page tab, and is answered");
});
