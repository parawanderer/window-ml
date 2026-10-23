// redteam-ml-wire.test.mjs — what a hostile page must NOT get from the `ml` wire (ML_CALL, src/sw/sw-ml-wire.ts).

// The page shares the main world, posts any window message, knows every run id, and can make its content script's
// renderer send any runtime message (a compromised renderer). The wire's defences, each a test here with a positive
// control: ML_CALL is not page-relayable; the worker answers only a client it opened, from the sender kind it opened it
// for; the run id is checked against the client's, never read; a read-only client has only the read-only members; a
// secret handle is never answered with a value; and no answer is ever a function or a proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { wireRun, wireCall, OFFSCREEN, SITE } from "./ml-wire-harness.mjs";

const require = createRequire(import.meta.url);
const { loadPageWorld } = require("./helpers");
const { HANDLE_MAP, PAGE_STARTED_TYPES } = require("../src/page-relay.ts");

const T = { timeout: 30000 };
const hostilePage = (id = SITE.id, url = SITE.url) => ({ tab: { id, url }, url, frameId: 0, documentId: `doc-${id}`, origin: new URL(url).origin });

// --- a page cannot start a wire call ---

test("a page posting ML_CALL (or any spelling of it) is never relayed to the worker", async () => {
    assert.ok(!PAGE_STARTED_TYPES.has("ML_CALL"));
    assert.ok(!Object.values(HANDLE_MAP).some((e) => e.type === "ML_CALL"), "no HANDLE_MAP entry maps to ML_CALL");
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: null }) });
    await new Promise((r) => setTimeout(r, 5));
    const boot = world.runtimeCalls.length;
    const msgs = ["CONFIG_REQUEST", "ML_CALL", "ML_CALL_REQUEST", "ML_ANSWER"].map((type) => ({ type, requestId: "r", payload: { client: "x", call: "config", args: [] } }));
    for (const m of msgs) world.context.window.postMessage(m);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(world.runtimeCalls.length, boot, "nothing posted on the page's window is relayed (SITE_PRESENCE step 2b)");
    for (const m of msgs) world.asInjected(m);   // a page that took injected.js's port
    await new Promise((r) => setTimeout(r, 5));
    const relayed = world.runtimeCalls.map((c) => c.type);
    assert.ok(relayed.includes("GET_CONFIG"), "positive control: a real request type relays");
    assert.ok(!relayed.some((t) => /ML_CALL|ML_ANSWER/.test(t)), `relayed: ${relayed}`);
});

test("a tab's sender holding a LIVE client handle is refused; the offscreen document with it is answered", T, async () => {
    const got = {};
    await wireRun(async (wire, bg) => {
        got.page = await wireCall(bg, wire, "dereference", ["fetch_url"], { sender: hostilePage() });
        got.frame = await wireCall(bg, wire, "config", [], { sender: { ...hostilePage(), url: "chrome-extension://test/offscreen.html" } });
        got.ownPage = await wireCall(bg, wire, "config", [], { sender: { id: "test", url: "chrome-extension://test/sidebar.html", origin: "chrome-extension://test" } });
        got.iso = await wireCall(bg, wire, "config", [], { sender: { ...hostilePage(), userScriptWorldId: "w" } });
        got.ok = await wireCall(bg, wire, "dereference", ["fetch_url"]);
    });
    assert.match(got.ok.value?.text ?? "", /north/, "positive control: the offscreen document is answered");
    for (const k of ["page", "frame", "ownPage", "iso"]) {
        assert.equal(got[k].error?.code, "Refused", k);
        assert.ok(!JSON.stringify(got[k]).includes("north"), `${k} got no value`);
    }
});

test("an unknown, guessed or closed handle is refused the same way a wrong sender is", T, async () => {
    let wire, bg;
    const got = {};
    await wireRun(async (w, b) => {
        wire = w; bg = b;
        got.guess = await wireCall(b, { ...w, client: "mlw-00000000-0000-0000-0000-000000000000" }, "config");
        got.none = await wireCall(b, { ...w, client: undefined }, "config");
    });
    got.closed = await wireCall(bg, wire, "config");
    for (const k of ["guess", "none", "closed"]) assert.deepEqual(got[k].error, { code: "Refused", message: "this sender cannot call ml over the wire" }, k);
});

// --- the run id is not authority ---

test("a forged run id from the verified sender reaches nothing: only the client's own run is answered", T, async () => {
    const got = {};
    await wireRun(async (wire, bg) => {
        got.other = await wireCall(bg, wire, "dereference", ["fetch_url"], { run: "run-of-another-tab" });
        got.nullRun = await wireCall(bg, wire, "dereference", ["fetch_url"], { run: null });
        got.own = await wireCall(bg, wire, "dereference", ["fetch_url"]);
    });
    assert.match(got.own.value?.text ?? "", /north/, "positive control");
    assert.equal(got.other.error?.code, "Refused");
    assert.equal(got.nullRun.error?.code, "Refused");
});

test("a cell a PAGE started has no run, even on the run's own tab mid-run: it cannot name the run to read its pointers", T, async () => {
    // The page knows the run id, its origin is approved, and PYTHON_EXEC is page-started: it starts its own cell on the
    // tab while the run's cell is in flight. That cell's client is bound to no run, so neither the run's id nor a null
    // run reaches the run's store.
    const got = {};
    await wireRun(async (wire, bg) => {
        if (wire.run === null) {
            got.pageWire = wire;
            got.named = await wireCall(bg, wire, "dereference", ["fetch_url"], { run: got.runWire.run });
            got.own = await wireCall(bg, wire, "dereference", ["fetch_url"]);
            got.cfg = await wireCall(bg, wire, "config");
            return;
        }
        got.runWire = wire;
        await bg.send({ type: "PYTHON_EXEC", requestId: "p1", payload: { code: "x", hardened: true } }, hostilePage());
        got.ok = await wireCall(bg, wire, "dereference", ["fetch_url"]);
    }, { siteGate: false, local: { ml_site_schema: 2, ml_site_selfapprove: ["https://site.example"] } });
    assert.match(got.ok.value?.text ?? "", /north/, "positive control: the run's own cell reads it");
    assert.ok(got.pageWire, "positive control: the page's cell ran");
    assert.equal(got.pageWire.run, null, "a page's cell is bound to no run");
    assert.equal(got.named.error?.code, "Refused");
    assert.equal(got.own.error?.code, "Absent", "with no run there is no dereference");
    assert.equal(typeof got.cfg.value?.model, "string", "positive control: the page's cell has what the page has");
});

// --- what a read-only client can reach ---

test("a read-only client cannot reach chat, click, a live fetch, the cache-only fetch, or anything off the prototype", T, async () => {
    const names = ["chat", "click", "type", "fetch", "_fetchCached", "pythonExec", "agent", "step", "sh", "current", "setModel", "unload",
        "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype", "then"];
    const got = {};
    await wireRun(async (wire, bg) => {
        for (const n of names) got[n] = await wireCall(bg, wire, n, n === "fetch" ? ["https://evil.example/x", { fresh: true }] : []);
        got.ctrl = await wireCall(bg, wire, "models");
    });
    assert.ok(Array.isArray(got.ctrl.value), "positive control");
    for (const n of names) assert.equal(got[n].error?.code, "Absent", n);
});

// --- secrets ---

test("a secret-tagged reference in any argument is refused, never answered with a value", T, async () => {
    const got = {};
    await wireRun(async (wire, bg) => {
        got.top = await wireCall(bg, wire, "schema", [{ $secret: "github" }]);
        got.nested = await wireCall(bg, wire, "schema", [{ a: [{ b: { $secret: "github" } }] }]);
        got.opt = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: { $secret: "github" } }]);
        got.ctrl = await wireCall(bg, wire, "schema", [{ secret: "github" }]);
    });
    assert.equal(typeof got.ctrl.value, "string", "positive control: a key merely named `secret` is data");
    for (const k of ["top", "nested", "opt"]) {
        assert.equal(got[k].error?.code, "SecretHandle", k);
        assert.ok(!("value" in got[k]), k);
    }
});

// --- what crosses ---

test("no answer of any member carries a function or a proxy: each is plain JSON data", T, async () => {
    const raw = [];
    await wireRun(async (wire, bg) => {
        for (const [call, args] of [["config", []], ["models", []], ["getModel", []], ["capabilities", ["m"]], ["ps", []], ["serverTools", []], ["info", []], ["schema", [{ a: 1 }]], ["range", [2]], ["dereference", ["fetch_url"]], ["chat", []]]) {
            raw.push(await bg.send({ type: "ML_CALL", client: wire.client, run: wire.run, seq: raw.length, call, args }, { ...OFFSCREEN }));
        }
    });
    const walk = (v, path) => {
        assert.ok(v === null || ["string", "number", "boolean", "object"].includes(typeof v), `${path} is a ${typeof v}`);
        if (v && typeof v === "object") {
            const proto = Object.getPrototypeOf(v);
            assert.ok(Array.isArray(v) || proto === null || proto?.constructor?.name === "Object", `${path} is ${proto?.constructor?.name}`);
            for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
        }
    };
    raw.forEach((a, i) => {
        walk(a, `answer ${i}`);
        assert.equal(Object.keys(a).filter((k) => ["value", "pointer", "error", "ask"].includes(k)).length, 1, `answer ${i} has exactly one kind`);
    });
});
