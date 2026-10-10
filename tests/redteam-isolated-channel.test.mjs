// redteam-isolated-channel.test.mjs — the red-team pass for the channel an isolated exec asks the worker on while it
// runs (iso-channel.ts, sw-isolated-exec.ts; site access slice 2 part 4b): what a hostile page must NOT get from it,
// each property a test with a positive control in the same test.
//
// The page shares the tab's DOM, knows every run id, and can post anything through the content script; it cannot read
// an isolated world's source (where the call's nonce is), but each test hands it the nonce anyway, so the checks that
// stand are the ones the browser vouches for (the channel itself, the tab, the frame, the document, the world). The run
// is isolated-harness.mjs: a user-script world or a CDP world (context 11; the page's own context is 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { runOn, fromTab, DATA_URL, CSV, ROWS } from "./isolated-harness.mjs";

const { ValueStore } = await import("../src/pointers/value-store.ts");
const { HANDLE_MAP, PAGE_STARTED_TYPES } = await import("../src/page-relay.ts");
const { isoServer, ISO_ASK_MAX, ISO_REFUSED } = await import("../src/sw/iso-channel.ts");

const T = { timeout: 120000 };
const nonceOf = (code) => /__mlIsoStarted = "([0-9a-f]+)"/.exec(code)?.[1];
/** The sender a real user-script world of this call has: the run's tab, top frame, routed document, its own world. */
const worldSender = (worldId) => ({ tab: { id: 7 }, frameId: 0, documentId: "doc-1", userScriptWorldId: worldId });
/** Resolve with what a send got back, or "NO ANSWER" if nothing answered within `ms` (an unanswered send never settles). */
const within = (p, ms = 150) => Promise.race([Promise.resolve(p).then((r) => r === undefined ? "NO ANSWER" : JSON.parse(JSON.stringify(r))), new Promise((r) => setTimeout(() => r("NO ANSWER"), ms))]);
/** A script whose own `.pipe()` is the positive control: it reaches the worker through the channel. */
const OWN = () => 'window.b = 1; const v = @tool:"orders"; return "<<<" + JSON.stringify((await v.pipe("head -n 2")).text) + ">>>"';
const OWN_TEXT = '"{\\n  \\"columns\\": ["';

// --- 1. who can send on the channel ---

test("the channel is not a page message: ISO_EXEC_ASK is outside HANDLE_MAP, and sent through runtime.onMessage from the run's tab with the live nonce it gets no answer", T, async () => {
    assert.ok(!Object.keys(HANDLE_MAP).includes("ISO_EXEC_ASK") && !Object.values(HANDLE_MAP).some((e) => e.type === "ISO_EXEC_ASK"), "not relayed by the content script");
    assert.ok(!PAGE_STARTED_TYPES.has("ISO_EXEC_ASK"));
    const heard = [];
    const r = await runOn("userScripts", [OWN], {
        onExecute: async (bg, inj) => {
            const nonce = nonceOf(inj.js[0].code);
            if (!nonce) return;
            for (const sender of [fromTab, { ...fromTab, documentId: "doc-1" }, { ...fromTab, documentId: "doc-1", userScriptWorldId: inj.worldId }])
                heard.push(await within(bg.send({ type: "ISO_EXEC_ASK", nonce, req: { op: "pipe", i: 0, stages: "head -n 1" } }, sender)));
        },
    });
    assert.equal(r.results[0].includes(`<<<${OWN_TEXT}>>>`), true, `positive control: the world's own .pipe() was answered: ${r.results[0].slice(0, 300)}`);
    for (const h of heard) assert.ok(h === "NO ANSWER" || (h && h.error && !h.ok && !h.data), `the page's channel got an answer: ${JSON.stringify(h).slice(0, 200)}`);
});

test("a user-script message under the live nonce is answered only for the call's own tab, top frame, document and world: every other sender shape gets nothing", T, async () => {
    const got = {};
    const r = await runOn("userScripts", [OWN], {
        onExecute: async (bg, inj) => {
            const nonce = nonceOf(inj.js[0].code), own = worldSender(inj.worldId);
            if (!nonce) return;
            const ask = (sender, n = nonce) => within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce: n, req: { op: "pipe", i: 0, stages: "head -n 1" } }, sender));
            got.own = await ask(own);
            const shapes = {
                "another tab": { ...own, tab: { id: 9 } }, "no tab": { ...own, tab: undefined }, "a sub-frame": { ...own, frameId: 2 }, "no frame": { ...own, frameId: undefined },
                "another document": { ...own, documentId: "doc-0" }, "no document": { ...own, documentId: undefined },
                "another run's world": { ...own, userScriptWorldId: "wml-0123456789abcdef" }, "the default world": { ...own, userScriptWorldId: "" },
            };
            for (const [k, s] of Object.entries(shapes)) got[k] = await ask(s);
            for (const bad of ["", "0".repeat(32), nonce.toUpperCase(), `${nonce} `]) got[`nonce ${JSON.stringify(bad)}`] = await ask(own, bad);
            got["a stream type"] = await within(bg.emitUserScriptMessage({ type: "ISO_EXEC_STREAM", nonce, req: { op: "pipe", i: 0, stages: "head -n 1" } }, own));
        },
    });
    assert.equal(got.own?.ok?.value, "{", `positive control: the call's own sender is answered: ${JSON.stringify(got.own)} ${r.results[0].slice(0, 200)}`);
    for (const [k, v] of Object.entries(got)) if (k !== "own") assert.equal(v, "NO ANSWER", k);
});

test("a CDP binding call carrying a read is served only from the isolated world's context on the run's tab under the call's nonce, and the answer is evaluated in that context alone", T, async () => {
    const evals = [];
    let forged = 0;
    const r = await runOn("cdp", [OWN], {
        onBg: (bg) => {
            const send = bg.context.chrome.debugger.sendCommand;
            bg.context.chrome.debugger.sendCommand = async (t, method, params) => { if (method === "Runtime.evaluate" && /__mlIsoAnswer\(/.test(params?.expression ?? "")) evals.push([t.tabId, params.contextId, params.expression]); return send(t, method, params); };
        },
        onEvaluate: async (bg, params) => {
            const nonce = nonceOf(params.expression);
            if (!nonce || forged++) return;
            const payload = JSON.stringify({ nonce, ask: 999, req: { op: "pipe", i: 0, stages: "head -n 1" } });
            bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 1, payload });
            bg.emitDebuggerEvent({ tabId: 9 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 11, payload });
            bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", payload });
            bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlCdpStream", executionContextId: 11, payload });
            // The world's own context, but not the call's nonce (another call's, or a guess).
            for (const bad of ["0".repeat(32), nonce.toUpperCase(), ""]) bg.emitDebuggerEvent({ tabId: 7 }, "Runtime.bindingCalled", { name: "__mlIsoStream", executionContextId: 11, payload: JSON.stringify({ nonce: bad, ask: 998, req: { op: "pipe", i: 0, stages: "head -n 1" } }) });
            await new Promise((res) => setTimeout(res, 50));
        },
    });
    assert.equal(r.results[0].includes(`<<<${OWN_TEXT}>>>`), true, `positive control: the world's own read was answered: ${r.results[0].slice(0, 300)}`);
    assert.ok(evals.length >= 1, "positive control: an answer was evaluated");
    for (const [tab, ctx, expr] of evals) {
        assert.deepEqual([tab, ctx], [7, 11], "an answer is evaluated only in the isolated world's context");
        assert.doesNotMatch(expr, /__mlIsoAnswer\(99[89],/, "a forged binding call was answered");
    }
});

// --- 2. what the channel answers, even to the world itself ---

test("the world gets only what its approved source named: another stored table, a read index it was not sent, and a read that failed are refused", T, async () => {
    const OTHER_URL = "https://data.example/other.csv";
    const OTHER = CSV.replace("id,n,s", "id,m,t");
    const got = {};
    const r = await runOn("userScripts", [OWN], {
        fetches: [{ url: DATA_URL, token: "orders" }, { url: OTHER_URL, token: "other" }],
        bodies: { [DATA_URL]: CSV, [OTHER_URL]: OTHER },
        onExecute: async (bg, inj) => {
            const rows = await new ValueStore({ idb: bg.context.indexedDB, budgetBytes: () => 1e12 }).rows();
            const key = (u) => rows.find((x) => x.source === u)?.key;
            const nonce = nonceOf(inj.js[0].code), own = worldSender(inj.worldId);
            if (!nonce) return;
            const ask = (req) => within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce, req }, own), 2000);
            got.ownTable = await ask({ op: "cols", key: key(DATA_URL), names: ["n"] });
            got.otherTable = await ask({ op: "cols", key: key(OTHER_URL), names: ["m"] });
            for (const i of [1, 2, -1, "0", 0.5, null, 1e9]) got[`pipe i=${JSON.stringify(i)}`] = await ask({ op: "pipe", i, stages: "head -n 1" });
            for (const req of [null, "x", { op: "eval" }, { op: "cols", key: 1, names: [] }, { op: "cols", key: key(DATA_URL), names: "n" }, { op: "pipe", i: 0, stages: Array(33).fill("head") }, { op: "pipe", i: 0, stages: [{}] }])
                got[`malformed ${JSON.stringify(req)}`] = await ask(req);
        },
    });
    assert.ok(r.ids.every(Boolean), "both fetches made pointers");
    assert.equal(got.ownTable?.ok?.columns?.n?.length, ROWS, `positive control: the named table's column is read whole: ${JSON.stringify(got.ownTable).slice(0, 200)}`);
    assert.deepEqual(got.otherTable, { error: ISO_REFUSED.table }, "a stored table the source did not name");
    for (const [k, v] of Object.entries(got)) if (k.startsWith("pipe ")) assert.deepEqual(v, { error: ISO_REFUSED.unnamed }, k);
    for (const [k, v] of Object.entries(got)) if (k.startsWith("malformed ")) assert.deepEqual(v, { error: ISO_REFUSED.malformed }, k);
});

test("a call's channel closes with it: its nonce gets nothing after the exec ends, nor while a later exec of the same run is in flight", T, async () => {
    const calls = [];
    let during;
    const ask = (bg, c) => within(bg.emitUserScriptMessage({ type: "ISO_EXEC_ASK", nonce: c.nonce, req: { op: "pipe", i: 0, stages: "head -n 1" } }, c.own));
    const r = await runOn("userScripts", [OWN, OWN], {
        onExecute: async (bg, inj) => {
            const nonce = nonceOf(inj.js[0].code);
            if (!nonce || calls.some((c) => c.nonce === nonce)) return;
            calls.push({ nonce, own: worldSender(inj.worldId) });
            if (calls.length === 2) during = { replay: await ask(bg, calls[0]), live: await ask(bg, calls[1]) };
        },
    });
    assert.equal(calls.length, 2, "two execs, each its own call");
    assert.ok(r.results.every((x) => x.includes(`<<<${OWN_TEXT}>>>`)), `positive control: both execs read through the channel: ${r.results.map((x) => x.slice(0, 120))}`);
    assert.equal(during.live?.ok?.value, "{", "positive control: the live call's nonce is answered");
    assert.equal(during.replay, "NO ANSWER", "the first exec's nonce, replayed while the second runs");
    assert.equal(await ask(r.bg, calls[1]), "NO ANSWER", "the last exec's nonce, after it ended");
    assert.equal(await ask(r.bg, calls[0]), "NO ANSWER", "the first exec's nonce, after the run");
});

// --- 3. halting ---

test("HALTING: a script that loops on the channel is bounded: the server answers ISO_ASK_MAX requests a call, then refuses each without work, and the loop ends", { timeout: 30000 }, async () => {
    // In a worker with its own timeout: an unbounded loop would hang the worker, not the suite.
    const src = `
        const { workerData, parentPort } = require("node:worker_threads");
        const vm = require("node:vm");
        (async () => {
            (await import(workerData.tsxCjs)).register();
            (await import(workerData.tsx)).register();
            const { isoServer } = await import(workerData.channel);
            const { isolatedWrapper } = await import(workerData.wrapper);
            let reads = 0;
            const serve = isoServer("run-1", [{ ref: "@tool:abc1234", pipe: [], value: "a\\nb", meta: { id: "abc1234", kind: "text", tool: "x", step: 1 } }],
                { deref: () => () => { reads++; return { value: "a" }; }, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }) });
            const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, __ask: (req) => serve(req) });
            const run = (js) => vm.runInContext(isolatedWrapper(js, { reads: [{ ref: "@tool:abc1234", pipe: [], value: "a\\nb", meta: { id: "abc1234", kind: "text", tool: "x", step: 1 } }] }, "N1", "", "__ask"), ctx);
            const loop = await run("{ const v = ml.dereference('@tool:abc1234'); let n = 0; for (;;) { await v.pipe('head -n 1'); n++; } }");
            const readsLoop = reads;
            const burst = await run("{ const v = ml.dereference('@tool:abc1234'); const r = await Promise.allSettled(Array.from({ length: 5000 }, () => v.pipe('head -n 1'))); return r.filter((x) => x.status === 'fulfilled').length }");
            parentPort.postMessage({ loop: JSON.parse(JSON.stringify(loop)), readsLoop, burst: JSON.parse(JSON.stringify(burst)), readsAll: reads });
        })().catch((e) => parentPort.postMessage({ crashed: String(e && e.stack || e) }));`;
    const w = new Worker(src, { eval: true, workerData: { tsx: import.meta.resolve("tsx/esm/api"), tsxCjs: import.meta.resolve("tsx/cjs/api"), channel: new URL("../src/sw/iso-channel.ts", import.meta.url).href, wrapper: new URL("../src/sw/sw-isolated-exec.ts", import.meta.url).href } });
    const out = await Promise.race([
        new Promise((res, rej) => { w.once("message", res); w.once("error", rej); }),
        new Promise((res) => setTimeout(() => res({ timedOut: true }), 20000)),
    ]);
    await w.terminate();
    assert.ok(!out.timedOut, "the loop did not end");
    assert.equal(out.crashed, undefined, out.crashed);
    assert.match(out.loop.threw, new RegExp(ISO_REFUSED.budget.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the loop ends on the budget's sentence");
    assert.equal(out.readsLoop, ISO_ASK_MAX, "the store was read once per answered request, and never past the budget");
    // A second call has its own server here only because the test made one server for both: the budget is per server.
    assert.equal(out.burst.v, "0", "a burst past the budget is refused whole once it is spent");
    assert.equal(out.readsAll, ISO_ASK_MAX);
});

test("HALTING: a fresh call's budget answers a burst up to ISO_ASK_MAX and refuses the rest without touching the store", async () => {
    let reads = 0;
    const serve = isoServer("run-1", [{ ref: "@tool:abc1234", pipe: [], value: "a", meta: { id: "abc1234", kind: "text", tool: "x", step: 1 } }],
        { deref: () => () => { reads++; return { value: "a" }; }, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }) });
    const out = await Promise.all(Array.from({ length: ISO_ASK_MAX * 4 }, () => serve({ op: "pipe", i: 0, stages: "head -n 1" })));
    assert.equal(out.filter((x) => "ok" in x).length, ISO_ASK_MAX);
    assert.ok(out.slice(ISO_ASK_MAX).every((x) => x.error === ISO_REFUSED.budget));
    assert.equal(reads, ISO_ASK_MAX);
});

// --- 4. the server alone: what it passes through and what it adds ---

test("the server passes the store's own errors through unchanged (an oversized read), refuses a table another run holds and a read that failed, and says when the run's pointers are gone", async () => {
    const table = { columns: ["n"], rows: [[1]], shape: [9, 1], dtypes: { n: "int64" }, truncated: true };
    const reads = [{ ref: "@tool:t", pipe: [], value: "x", meta: { id: "t", kind: "table", tool: "fetch_url", step: 1, table, value: "vkey" } }];
    const capErr = "reading column \"n\" of this stored table would return 6,000,000 cells, more than one read hands back (5,000,000). Compute over it in python_exec instead (tables: { df: \"@tool:…\" }).";
    const s1 = isoServer("run-1", reads, { deref: () => undefined, holders: async () => ["run-1"], columns: async () => { throw new Error(capErr); } });
    assert.deepEqual(await s1({ op: "cols", key: "vkey", names: ["n"] }), { error: capErr }, "the cap's sentence, as every path gets it");
    assert.deepEqual(await s1({ op: "pipe", i: 0, stages: "head" }), { error: ISO_REFUSED.ended });
    const s2 = isoServer("run-1", reads, { deref: () => undefined, holders: async () => ["run-2"], columns: async () => ({ rowCount: 1, columns: { n: [1] } }) });
    assert.deepEqual(await s2({ op: "cols", key: "vkey", names: ["n"] }), { error: ISO_REFUSED.held });
    const failed = isoServer("run-1", [{ ref: "@tool:gone", pipe: [], error: "MemoryFault: gone" }, ...reads], { deref: () => () => ({ value: "LEAKED" }), holders: async () => ["run-1"], columns: async () => ({}) });
    assert.deepEqual(await failed({ op: "pipe", i: 0, stages: "head" }), { error: ISO_REFUSED.unnamed }, "a read that failed is not re-read under another pipe");
    assert.ok("ok" in await failed({ op: "pipe", i: 1, stages: "head" }), "positive control: the read that resolved is");
    const s3 = isoServer("run-1", reads, { deref: () => undefined, holders: async () => ["run-1"], columns: async () => ({ rowCount: 1, columns: { n: [1] } }) });
    assert.deepEqual(await s3({ op: "cols", key: "vkey", names: ["n"] }), { ok: { rowCount: 1, columns: { n: [1] } } }, "positive control");
});

test("a table a re-pipe answered with becomes readable for that call, and only through the worker's own record of it", async () => {
    const piped = { columns: ["a"], rows: [[1]], shape: [5, 1], dtypes: { a: "int64" }, truncated: true, delimiter: ";" };
    const calls = [];
    const serve = isoServer("run-1", [{ ref: "@tool:t", pipe: [], value: "x", meta: { id: "t", kind: "text", tool: "x", step: 1 } }], {
        deref: () => (ref, pipe) => ({ value: "y", meta: { id: "u", kind: "table", tool: "x", step: 2, table: piped, value: "vpiped" } }),
        holders: async () => ["run-1"], columns: async (key, names, opts) => { calls.push([key, names, opts]); return { rowCount: 5, columns: { a: [1, 2, 3, 4, 5] } }; },
    });
    assert.deepEqual(await serve({ op: "cols", key: "vpiped", names: ["a"] }), { error: ISO_REFUSED.table }, "not before the worker handed it over");
    assert.ok("ok" in await serve({ op: "pipe", i: 0, stages: ["head"] }));
    assert.ok("ok" in await serve({ op: "cols", key: "vpiped", names: ["a"], delimiter: "," }));
    assert.deepEqual(calls, [["vpiped", ["a"], { delimiter: ";" }]], "the delimiter is the worker's record, never the world's");
});

// --- 5. the wrapper's channel binding, as source ---

test("the kit and the channel are locals of the wrapper: a world's globals hold neither after the call", async () => {
    const { isolatedWrapper } = await import("../src/sw/sw-isolated-exec.ts");
    const ctx = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, __ask: async () => ({ ok: { value: "z" } }) });
    const out = await vm.runInContext(isolatedWrapper("(String(await ml.dereference('@tool:t').pipe('head')))", { reads: [{ ref: "@tool:t", pipe: [], value: "x" }] }, "N1", "", "__ask"), ctx);
    assert.equal(out.v, "z", "positive control: the channel answered");
    assert.equal(vm.runInContext("[typeof __mlIsoKit, typeof __chan, typeof __chanAsk, typeof isoValue].join()", ctx), "undefined,undefined,undefined,undefined");
});
