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

// --- workerShot: the extension's UI masked out, nothing on the page changed ---

const NO_UI = { vw: 800, vh: 600, rects: [] };

test("the shell is asked where the extension's UI is before and after the capture, in the run's document and top frame only; with none, the capture is returned as taken", async () => {
    const order = [];
    const { bg, wv } = world({
        cdp: false,
        onTabMessage: async (_t, msg) => { order.push(msg.type); return NO_UI; },
        onCaptureTab: async () => { order.push("capture"); return dataUrl(OWN_PNG); },
    });
    const shot = await wv.workerShot(3);
    assert.deepEqual({ ...shot }, { dataUrl: dataUrl(OWN_PNG), w: 800, h: 600 });
    assert.deepEqual(order, ["SHOT_RECTS", "capture", "SHOT_RECTS"]);
    const sent = bg.tabMessages.map((a) => JSON.parse(JSON.stringify(a)));
    // A read that starts the shell's watch, and the one that ends it, both for this shot's id: nothing that changes the page.
    const id = sent[0][1].id;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(sent.map((a) => a[1]), [{ type: "SHOT_RECTS", watch: "begin", id }, { type: "SHOT_RECTS", watch: "end", id }], "a read, and nothing that changes the page");
    assert.ok(sent.every((a) => a[0] === 3 && a[2]?.frameId === 0 && a[2]?.documentId === "doc-3"), "to the run's tab, top frame, pinned to its document");
});

test("a tab with no content script (the send rejects) has no extension UI on it: captured at once, unmasked", async () => {
    const { wv } = world({ cdp: false, onTabMessage: async () => { throw new Error("Could not establish connection. Receiving end does not exist."); } });
    const t0 = Date.now();
    assert.equal((await wv.workerShot(3)).dataUrl, dataUrl(OWN_PNG));
    assert.ok(Date.now() - t0 < 150);
});

test("a shell that is there and does not answer in time (a page holding its main thread) is refused a shot, not shot unmasked", async () => {
    const { bg, wv } = world({ cdp: false, onTabMessage: () => new Promise(() => {}) });
    await assert.rejects(wv.workerShot(3, { rectsMs: 50 }), /too busy for window.ml to find its own panels/);
    assert.equal(bg.captures.length, 0, "refused before anything was captured");
    // And when only the second answer is late: the capture taken is not returned.
    let n = 0;
    const late = world({ cdp: false, onTabMessage: () => (n++ === 0 ? NO_UI : new Promise(() => {})) });
    await assert.rejects(late.wv.workerShot(3, { rectsMs: 50 }), /too busy/);
    assert.equal(late.bg.captures.length, 1);
});

test("an answer that is not the shell's shape is refused rather than read as no UI", async () => {
    for (const bad of [undefined, null, "x", { rects: [] }, { vw: 800, vh: 600, rects: [{ x: NaN, y: 0, w: 1, h: 1, kind: "card" }] }]) {
        const { wv } = world({ cdp: false, onTabMessage: async () => bad });
        await assert.rejects(wv.workerShot(3), /can't be read/, JSON.stringify(bad));
    }
    // A send that fails other than "nothing is listening" (the shell threw, its port closed) is not "no UI here".
    const { wv } = world({ cdp: false, onTabMessage: async () => { throw new Error("The message port closed before a response was received."); } });
    await assert.rejects(wv.workerShot(3), /can't be read/);
});

test("an extension surface covering most of the viewport (the image viewer) is refused with a sentence, not masked into a grey image", async () => {
    const { wv } = world({ cdp: false, onTabMessage: async () => ({ vw: 800, vh: 600, rects: [{ x: 0, y: 0, w: 800, h: 600, kind: "lightbox" }] }) });
    await assert.rejects(wv.workerShot(3), /image viewer is open over the page: close it \(Esc\)/);
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
    const { calls_: one, ...total1 } = JSON.parse(JSON.stringify(wv.spend("run-1")));
    assert.deepEqual(total1, { prompt: 812, completion: 9, calls: 1, byModel: [{ model: "reader-vl", prompt: 812, completion: 9, calls: 1 }] });
    assert.deepEqual(one.map((c) => [c.model, c.prompt, c.completion]), [["reader-vl", 812, 9]], "the call itself is kept, for spend");
});

test("a second call adds to the same run's spend; a run the worker holds no state for sends nothing", async () => {
    let n = 0;
    const { wv } = world({ onFetch: () => { n++; return jsonResponse({ model: "reader-vl", choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }); } });
    wv.seedRun("run-1", 3);
    await wv.workerVisionChat("run-1", "a", { images: [], model: "reader-vl", maxTokens: 64, numCtx: null });
    await wv.workerVisionChat("run-1", "b", { images: [], model: "reader-vl", maxTokens: 64, numCtx: null });
    const { calls_: two, ...total2 } = JSON.parse(JSON.stringify(wv.spend("run-1")));
    assert.deepEqual(total2, { prompt: 20, completion: 4, calls: 2, byModel: [{ model: "reader-vl", prompt: 20, completion: 4, calls: 2 }] });
    assert.equal(two.length, 2);
    await assert.rejects(wv.workerVisionChat("run-unknown", "c", { images: [], model: null, maxTokens: 64, numCtx: null }), /no worker state/);
    assert.equal(n, 2, "the unknown run's call was never sent");
});
