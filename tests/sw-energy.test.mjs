// sw-energy.test.mjs — the worker's energy hold (src/sw/sw-energy.ts) over a fake `/api/events`: a session's model
// call to a server seen reporting power opens the stream with no panel open, its generations' ends write its share to
// storage.local, the close writes it complete and lets the stream go; a server never seen reporting power costs no
// request at all, and a stream's first sample says which a server is.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { resetStateRegistry } from "../src/state-registry.ts";

const SESSION = "wml-run1";
const enc = new TextEncoder();

/** A box whose `/api/events` is a stream the test writes frames to; records each events connection. */
function box() {
    const conns = [], asked = [];
    const fetch = async (url, init = {}) => {
        const u = new URL(url);
        asked.push(u.pathname);
        if (u.pathname === "/ollama/api/ps") return new Response("no", { status: 404 });
        if (u.pathname === "/api/ps") return new Response(JSON.stringify({ models: [] }), { status: 200 });
        if (u.pathname === "/api/events") {
            let ctl;
            const body = new ReadableStream({ start(c) { ctl = c; } });
            const conn = { since: u.searchParams.get("since"), closed: false, send: (f) => ctl.enqueue(enc.encode(JSON.stringify(f) + "\n")) };
            init.signal?.addEventListener("abort", () => { conn.closed = true; try { ctl.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ } });
            conns.push(conn);
            return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
        }
        return new Response("no", { status: 404 });
    };
    return { fetch, conns, asked };
}

/** chrome with a sync config and an in-memory storage.local. */
function chromeWith(config) {
    const local = {};
    const area = (data) => ({
        get: async (k) => k == null ? { ...data } : typeof k === "string" ? (k in data ? { [k]: data[k] } : {}) : Object.fromEntries(Object.entries(k).map(([key, d]) => [key, key in data ? data[key] : d])),
        set: async (o) => { Object.assign(data, structuredClone(o)); },
    });
    globalThis.chrome = { storage: { sync: { get: async (d) => ({ ...d, ...config }) }, local: area(local) } };
    return local;
}

const sample = (t, w) => ({ kind: "sample", t, info: { compute: { supported_gpus: [{ gpu_id: "0", power: { draw_mw: w * 1000 } }], power_sources: [] } }, ps: { models: [] } });
const genEnd = (t, ms) => ({ kind: "gen.end", t, model: "qwen3:8b", hint: { session: SESSION }, timings: { prompt_ms: ms / 2, eval_ms: ms / 2 } });
const until = async (cond, what) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r)); assert.ok(cond(), what); };

async function fresh(fetchImpl, config, power = { "http://box.test": true }) {
    const local = chromeWith({ chatUrl: "http://box.test/api/chat", apiFormat: "ollama", ...config });
    globalThis.fetch = fetchImpl;
    if (power) local.ml_power_seen = power;
    resetStateRegistry(); // each fresh module declares its state again
    // sw-energy imports THIS sw-events, so its connection and frame ring are reset rather than re-imported.
    const events = await import("../src/sw/sw-events.ts");
    events._resetResourceEvents();
    const energy = await import(`../src/sw/sw-energy.ts?t=${Math.random()}`);
    return { local, events, energy };
}

// --- the hold ---

test("energy hold: a session's call opens the stream with no panel open, writes its share, and the close lets it go", async (t) => {
    const b = box();
    const { local, energy } = await fresh(b.fetch, { electricityPerKwh: 0.3, electricityCurrency: "EUR" });
    t.after(() => energy._resetEnergy());
    const done = energy.energyRequest(SESSION);
    await until(() => b.conns.length === 1, "the call opened the event stream");
    assert.equal(b.conns[0].since, "600000", "a fresh connection asks for the server's whole ring, to find the rest in");
    for (let s = 0; s <= 10; s++) b.conns[0].send(sample(s * 1000, 200));
    b.conns[0].send(genEnd(10_000, 10_000));
    const key = energy.energyKey(SESSION);
    await until(() => local[key], "the generation's end wrote the session's record");
    const [rec] = Object.values(local[key]);
    assert.equal(rec.open, true);
    assert.ok(Math.abs(rec.J - 2000) < 1e-6, `10 s at 200 W: ${rec.J}`);
    assert.equal(rec.currency, "EUR");

    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    done();
    assert.equal(b.conns[0].closed, false, "the tail and the rest after it are still watched");
    mock.timers.tick(10_000 + 60_001);
    await until(() => Object.values(local[key])[0].open === false, "the close wrote the stretch complete");
    assert.equal(b.conns[0].closed, true, "and let the stream go");
    assert.equal(Object.values(local[key])[0].cut, false);
});

test("energy hold: a call to a server never seen reporting power opens no stream and asks it nothing", async (t) => {
    for (const power of [null, { "http://box.test": false }, { "http://other.test": true }]) {
        const b = box();
        const { local, energy } = await fresh(b.fetch, {}, power);
        t.after(() => energy._resetEnergy());
        const done = energy.energyRequest(SESSION);
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
        done();
        assert.deepEqual(b.asked, [], `no request for ${JSON.stringify(power)}: a cloud or stock backend pays nothing`);
        assert.equal(Object.keys(local).filter((k) => k.startsWith("ml_energy_")).length, 0);
    }
});

test("energy hold: a stream's first sample says whether its server reports power, kept per origin", async (t) => {
    const b = box();
    const { local, events, energy } = await fresh(b.fetch, {}, null);
    const unwatch = energy.watchPower();
    t.after(() => { unwatch(); energy._resetEnergy(); });
    const panel = { onDisconnect: { addListener() {} }, postMessage() {} };
    events.subscribeResourceEvents(panel);
    await until(() => b.conns.length === 1, "the panel opened the stream");
    b.conns[0].send({ kind: "hello", t: 0 });
    b.conns[0].send({ kind: "sample", t: 0, info: { compute: { supported_gpus: [{ gpu_id: "0" }], power_sources: [] } } });
    await until(() => local.ml_power_seen, "the first sample's answer was kept");
    assert.deepEqual(local.ml_power_seen, { "http://box.test": false });
    b.conns[0].send(sample(1000, 200));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(local.ml_power_seen, { "http://box.test": false }, "only a connection's first sample is read");
    b.conns[0].send({ kind: "hello", t: 0 });
    b.conns[0].send(sample(2000, 200));
    await until(() => local.ml_power_seen["http://box.test"] === true, "the next connection's first sample says it reports power now");
});

// --- a worker that died inside a stretch ---

test("energy hold: at a worker's start every record still open is marked cut", async () => {
    const b = box();
    const { local, energy } = await fresh(b.fetch, {});
    const open = { J: 5, aboveJ: 2, basis: "gpu", ms: 100, cost: null, currency: null, open: true, cut: false };
    const closed = { ...open, open: false };
    local[energy.energyKey(SESSION)] = { 1: open, 2: closed };
    local.unrelated = { 1: open };
    await energy.cutOpenStretches();
    assert.deepEqual(local[energy.energyKey(SESSION)], { 1: { ...open, open: false, cut: true }, 2: closed });
    assert.deepEqual(local.unrelated, { 1: open }, "only energy records are touched");
});
