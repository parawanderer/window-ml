// worker-vision.test.mjs — the worker's vision pieces (src/sw/worker-vision.ts), not yet used by any tool: a capture of
// a run's own tab by id (the debugger first, bounded, then the own-tab capture, which refuses a tab not showing), the
// sidebar hidden through the extension's shell around it, and the vision sub-call the worker sends itself, metered
// into the run. Driven through the built worker's test hook `__mlWorkerVisionForTest` (background.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { oneShotRequest } from "../src/ml/ml-chat.ts";
import { hintSession } from "../src/contract/contract-run.ts";
import { NOT_SHOWING } from "../src/sw/sw-capture.ts";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const baseConfig = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });

/** A PNG's first 24 bytes (signature + IHDR) for a `w`×`h` image, plus `tag` so two shots tell apart. */
function png(w, h, tag = "") {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return Buffer.concat([b, Buffer.from(tag)]).toString("base64");
}
const CDP_PNG = png(1600, 1200, "cdp");
const OWN_PNG = png(800, 600, "own");
const dataUrl = (b64) => `data:image/png;base64,${b64}`;

/** The run's tab 3 and another tab 4 in window 1; `showing` says which one the window shows. */
function world({ cdp, showing = 3, onDebuggerCommand, onCaptureTab, onTabMessage, onFetch } = {}) {
    const openTabs = [
        { id: 3, windowId: 1, active: showing === 3, url: "https://run.example/" },
        { id: 4, windowId: 1, active: showing === 4, url: "https://other.example/" },
    ];
    const bg = loadBackground({
        config: baseConfig({ cdp }), openTabs,
        onDebuggerCommand: onDebuggerCommand ?? ((m) => (m === "Page.captureScreenshot" ? { data: CDP_PNG } : undefined)),
        onCaptureTab: onCaptureTab ?? (async (windowId) => {
            const t = openTabs.find((x) => x.windowId === windowId && x.active);
            return t.id === 3 ? dataUrl(OWN_PNG) : dataUrl(png(800, 600, "OTHER"));
        }),
        onTabMessage, onFetch: onFetch ?? (() => jsonResponse({})),
    });
    return { bg, wv: bg.context.__mlWorkerVisionForTest };
}
const cdpShots = (bg) => bg.debuggerCalls.filter((c) => c[0] === "sendCommand" && c[2] === "Page.captureScreenshot");

// --- captureRunTab: the run's own tab, by id ---

test("with the debugger on, the run's tab is shot by id even when its window shows another tab, sized from the PNG header", async () => {
    const { bg, wv } = world({ cdp: true, showing: 4 });
    const shot = await wv.captureRunTab(3);
    assert.deepEqual({ ...shot }, { dataUrl: dataUrl(CDP_PNG), w: 1600, h: 1200 });
    assert.deepEqual(cdpShots(bg).map((c) => JSON.stringify(c[1])), [JSON.stringify({ tabId: 3 })], "the debugger's shot is of tab 3");
    assert.equal(bg.captures.length, 0, "captureVisibleTab, which shoots whatever the window shows, is never called");
});

test("a debugger shot that never finishes gives way to the own-tab capture after the bound: the run's tab when it shows, a refusal when it doesn't", async () => {
    const hang = (m) => (m === "Page.captureScreenshot" ? new Promise(() => {}) : undefined);
    const showing = world({ cdp: true, showing: 3, onDebuggerCommand: hang });
    const t0 = Date.now();
    const shot = await showing.wv.captureRunTab(3, { cdpTimeoutMs: 60 });
    assert.ok(Date.now() - t0 < 2000, "bounded by the timeout, not by the debugger");
    assert.deepEqual({ ...shot }, { dataUrl: dataUrl(OWN_PNG), w: 800, h: 600 });
    assert.deepEqual(showing.bg.captures.map((a) => a[0]), [1], "captureVisibleTab of the run tab's window");

    const hidden = world({ cdp: true, showing: 4, onDebuggerCommand: hang });
    await assert.rejects(hidden.wv.captureRunTab(3, { cdpTimeoutMs: 60 }), /debugger's screenshot failed \(it did not finish in time\).*isn't/);
    assert.equal(hidden.bg.captures.length, 0, "the window's other tab is never shot");
});

test("a debugger shot that fails falls back the same way, and the refusal names the debugger's failure rather than telling the person to turn it on", async () => {
    const fail = (m) => { if (m === "Page.captureScreenshot") throw new Error("Another debugger is already attached"); };
    const showing = world({ cdp: true, showing: 3, onDebuggerCommand: fail });
    assert.equal((await showing.wv.captureRunTab(3)).dataUrl, dataUrl(OWN_PNG));
    const hidden = world({ cdp: true, showing: 4, onDebuggerCommand: fail });
    const err = await hidden.wv.captureRunTab(3).then(() => null, (e) => e.message);
    assert.match(err, /Another debugger is already attached/);
    assert.doesNotMatch(err, /turn on/);
    assert.equal(hidden.bg.captures.length, 0);
});

test("with the debugger off, the run's tab is shot only while it shows: refused otherwise, and never by switching tabs", async () => {
    const showing = world({ cdp: false, showing: 3 });
    assert.deepEqual({ ...(await showing.wv.captureRunTab(3)) }, { dataUrl: dataUrl(OWN_PNG), w: 800, h: 600 });
    assert.equal(cdpShots(showing.bg).length, 0, "no debugger when it is off");

    const hidden = world({ cdp: false, showing: 4 });
    await assert.rejects(hidden.wv.captureRunTab(3), (e) => e.message === NOT_SHOWING);
    assert.equal(hidden.bg.captures.length, 0);
    assert.equal(hidden.bg.debuggerCalls.length, 0);
});

test("a capture that is not a readable image is refused rather than returned without its size", async () => {
    const { wv } = world({ cdp: false, onCaptureTab: async () => "data:image/png;base64,SHOT" });
    await assert.rejects(wv.captureRunTab(3), /not an image/);
});

// --- workerShot: hide through the shell, capture, show ---

test("the hide goes to the tab's top frame and is answered before the capture; the show follows it, with the same shot id", async () => {
    const order = [];
    const { bg, wv } = world({
        cdp: false,
        onTabMessage: async (tabId, msg, opts) => { order.push(msg.type); return msg.type === "SHOT_HIDE" ? { hidden: true } : undefined; },
        onCaptureTab: async () => { order.push("capture"); return dataUrl(OWN_PNG); },
    });
    await wv.workerShot(3);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, ["SHOT_HIDE", "capture", "SHOT_SHOW"]);
    const sent = bg.tabMessages.filter((a) => /^SHOT_/.test(a[1]?.type));
    assert.ok(sent.every((a) => a[0] === 3 && a[2]?.frameId === 0), "to the run's tab, top frame only");
    assert.equal(sent[0][1].id, sent[1][1].id, "the show names the hide's shot");
    assert.match(sent[0][1].id, /^[0-9a-f-]{36}$/);
});

test("the show is sent even when the capture fails", async () => {
    const order = [];
    const { wv } = world({ cdp: false, showing: 4, onTabMessage: async (_t, msg) => { order.push(msg.type); return {}; } });
    await assert.rejects(wv.workerShot(3), (e) => e.message === NOT_SHOWING);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, ["SHOT_HIDE", "SHOT_SHOW"]);
});

test("a shell that never answers the hide (none mounted, a tab that does not paint) is waited for 200 ms, then the capture goes anyway", async () => {
    const order = [];
    const { wv } = world({
        cdp: false,
        onTabMessage: (_t, msg) => { order.push(msg.type); return msg.type === "SHOT_HIDE" ? new Promise(() => {}) : undefined; },
        onCaptureTab: async () => { order.push("capture"); return dataUrl(OWN_PNG); },
    });
    const t0 = Date.now();
    await wv.workerShot(3);
    const took = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(took >= 190 && took < 1500, `waited ${took} ms`);
    assert.deepEqual(order, ["SHOT_HIDE", "capture", "SHOT_SHOW"]);
});

test("a tab with no content script (the send rejects) is captured at once, and the rejection goes nowhere", async () => {
    const { wv } = world({ cdp: false, onTabMessage: async () => { throw new Error("Could not establish connection. Receiving end does not exist."); } });
    const t0 = Date.now();
    assert.equal((await wv.workerShot(3)).w, 800);
    assert.ok(Date.now() - t0 < 150);
});

// --- workerVisionChat: the page's request, sent by the worker, counted into the run ---

/** The wire bodies a world sends, with the per-request id (minted by the worker for each call) left out. */
const noRequestId = (body) => JSON.parse(JSON.stringify(body, (k, v) => (k === "request" ? undefined : v)));

test("the worker's vision request is the one oneShotRequest builds for the same inputs, on the wire byte for byte, and its usage lands in the run's spend", async () => {
    const bodies = [];
    const { bg, wv } = world({ onFetch: (c) => { if (c.body?.messages) bodies.push(c.body); return jsonResponse({ model: "reader-vl", choices: [{ message: { content: "A blue button." } }], usage: { prompt_tokens: 812, completion_tokens: 9 } }); } });
    const prompt = "Describe the current page concisely — what is shown and what stands out.";
    const o = { images: [dataUrl(OWN_PNG)], model: "reader-vl", maxTokens: 512, numCtx: 8192 };
    wv.seedRun("run-1", 3);
    assert.equal(await wv.workerVisionChat("run-1", prompt, o), "A blue button.");
    await bg.send({ type: "FETCH_LLM", payload: oneShotRequest(prompt, { ...o, session: hintSession("run-1") }) });
    assert.equal(bodies.length, 2);
    assert.equal(JSON.stringify(noRequestId(bodies[0])), JSON.stringify(noRequestId(bodies[1])));
    assert.ok(JSON.stringify(bodies[0]).includes(OWN_PNG), "the image is in the request");
    assert.deepEqual(JSON.parse(JSON.stringify(wv.spend("run-1"))), { prompt: 812, completion: 9, calls: 1, byModel: [{ model: "reader-vl", prompt: 812, completion: 9, calls: 1 }] });
});

test("a second call adds to the same run's spend; a run the worker holds no state for sends nothing", async () => {
    let n = 0;
    const { wv } = world({ onFetch: () => { n++; return jsonResponse({ model: "reader-vl", choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }); } });
    wv.seedRun("run-1", 3);
    await wv.workerVisionChat("run-1", "a", { images: [], model: "reader-vl", maxTokens: 64, numCtx: null });
    await wv.workerVisionChat("run-1", "b", { images: [], model: "reader-vl", maxTokens: 64, numCtx: null });
    assert.deepEqual(JSON.parse(JSON.stringify(wv.spend("run-1"))), { prompt: 20, completion: 4, calls: 2, byModel: [{ model: "reader-vl", prompt: 20, completion: 4, calls: 2 }] });
    await assert.rejects(wv.workerVisionChat("run-unknown", "c", { images: [], model: null, maxTokens: 64, numCtx: null }), /no worker state/);
    assert.equal(n, 2, "the unknown run's call was never sent");
});
