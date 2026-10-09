// redteam-worker-shot.test.mjs — the red-team pass for the worker's own capture and vision sub-call (src/sw/worker-vision.ts,
// src/sidebar/shell-shot.ts, the metered path in src/sw/worker-tools.ts; site access slice 2 part 3, PR 3): what a hostile
// page must NOT get from a screenshot the worker takes of a run's tab or from the vision call it sends.
//
// The page is played by `onTabMessage` (what reaches its tab), `onCaptureTab`/`onDebuggerCommand` (what the browser
// shoots) and `bg.send` with the run's tab as sender (what it can post). Driven through the built worker's test hook
// `__mlWorkerVisionForTest`, since no tool takes its shots this way yet. Pixels and real frames are in
// tests/e2e/redteam-worker-shot.spec.mjs. An open hole is a `todo` naming what is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { hintSession } from "../src/contract/contract-run.ts";
import { readFileSync } from "node:fs";
import { CAPTURE_RETRIES, CAPTURE_RETRY_MS } from "../src/sw/sw-capture.ts";

const require = createRequire(import.meta.url);
// worker-vision.ts imports by extensionless paths, which only the bundle resolves: read its bounds from the source.
const visionSrc = readFileSync(new URL("../src/sw/worker-vision.ts", import.meta.url), "utf8");
const constOf = (name) => Number(new RegExp(`export const ${name} = ([0-9_]+);`).exec(visionSrc)[1].replace(/_/g, ""));
const CDP_SHOT_MS = constOf("CDP_SHOT_MS"), SHOT_HIDE_MS = constOf("SHOT_HIDE_MS");
const { jsonResponse, loadBackground } = require("./helpers");
const { PAGE_STARTED_TYPES, RUN_TAB_TYPES } = require("../src/page-relay.ts");

globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.chrome ??= { runtime: { id: "ext-id" } };
const { shotGate, WORKER_SHOT_HOLD_MS } = await import("../src/sidebar/shell-shot.ts");

const config = (o = {}) => ({ chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", ...o });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A PNG's signature + IHDR for a `w`×`h` image, plus `tag` so shots of different documents tell apart. */
function png(w, h, tag = "") {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return `data:image/png;base64,${Buffer.concat([b, Buffer.from(tag)]).toString("base64")}`;
}
const RUN_PNG = png(800, 600, "RUN-DOCUMENT");
const BANK_PNG = png(800, 600, "BANK-DOCUMENT");
const RUN_URL = "https://run.example/";
/** The run's tab 3, as a sender: what the page on it can post. */
const fromRunTab = (documentId = "doc-A", url = RUN_URL) => ({ tab: { id: 3, url }, url, origin: new URL(url).origin, frameId: 0, documentId });

/**
 * A worker with the run's tab 3 (showing) and another tab 4 in window 1. `doc` is what tab 3 holds now; the default
 * capture answers with that document's pixels, so a shot taken after a navigation is the new document's.
 */
function world({ cdp = false, onTabMessage, onCaptureTab, onDebuggerCommand, onFetch, siteGate = false, local = {}, cfg = {} } = {}) {
    const state = { doc: "doc-A" };
    const openTabs = [
        { id: 3, windowId: 1, active: true, url: RUN_URL, title: "Run" },
        { id: 4, windowId: 1, active: false, url: "https://other.example/", title: "Other" },
    ];
    const pixels = () => (state.doc === "doc-A" ? RUN_PNG : BANK_PNG);
    const bg = loadBackground({
        config: config({ cdp, ...cfg }), openTabs, siteGate, local,
        onDebuggerCommand: onDebuggerCommand ?? ((m) => (m === "Page.captureScreenshot" ? { data: pixels().split(",")[1] } : undefined)),
        onCaptureTab: onCaptureTab ?? (async () => pixels()),
        onTabMessage: (...a) => (onTabMessage ? onTabMessage(...a) : undefined),
        onFetch: onFetch ?? (() => jsonResponse({ model: "vl", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })),
    });
    bg.commit(3, { documentId: "doc-A", url: RUN_URL });
    /** The browser commits another document on tab 3 (the page navigated itself). */
    const navigate = (url = "https://bank.example/inbox") => { state.doc = "doc-B"; bg.commit(3, { documentId: "doc-B", url }); };
    return { bg, wv: bg.context.__mlWorkerVisionForTest, navigate, state };
}
const shotMsgs = (bg) => bg.tabMessages.filter((a) => /^SHOT_/.test(a[1]?.type)).map((a) => JSON.parse(JSON.stringify(a)));
const spendOf = (wv, run) => JSON.parse(JSON.stringify(wv.spend(run) ?? null));
const chatCalls = (calls) => calls.filter((c) => c.url.includes("/chat/completions"));

/**
 * Send every page-startable and run-tab type with `payload`, from each of `senders`. START_RUN is left out: it starts the
 * PAGE's own run (refused under a worker run's hash, tests/run-start.test.mjs), and with this bait payload its handler
 * throws on the missing toolset after the channel is gone, which says nothing about a shot or a spend.
 */
async function sendEveryType(bg, payload, senders, extra = {}) {
    for (const t of new Set([...PAGE_STARTED_TYPES, ...RUN_TAB_TYPES])) {
        if (t === "START_RUN") continue;
        for (const sender of senders) await Promise.race([bg.send({ ...extra, type: t, payload: { ...payload } }, sender).catch(() => {}), tick()]);
    }
    await tick(50);
}

// --- (b) the worker's capture is of the run's document, and only that ---

test("a shot whose tab commits another document between the hide and the capture is refused, not handed back with that document's pixels", {
    todo: "workerShot/captureRunTab are by tab id and pin no document: a page that navigates its own top frame on the hide (it sees the hide in the DOM) gets the next document captured, with no shell hide in it. Later PR (document pinning): read frame 0's documentId before the hide, send SHOT_* with { documentId }, and refuse when getFrame differs after the capture.",
}, async () => {
    for (const cdp of [false, true]) {
        // Positive control: no navigation, the run's own document.
        const honest = world({ cdp });
        assert.equal((await honest.wv.workerShot(3)).dataUrl, RUN_PNG, `cdp=${cdp}: the honest shot`);

        // The page, seeing the sidebar hidden, navigates the tab to a page the person is signed in to.
        const w = world({ cdp, onTabMessage: (_t, m) => { if (m.type === "SHOT_HIDE") w.navigate(); return { hidden: true }; } });
        const got = await w.wv.workerShot(3).then((s) => s.dataUrl, (e) => `refused: ${e.message}`);
        assert.notEqual(got, BANK_PNG, `cdp=${cdp}: the worker returned another document's pixels as the run's screenshot`);
        assert.match(got, /^refused/);
    }
});

test("the hide and the show go to the run's tab, top frame only, and two shots at once each show their own id", async () => {
    const { bg, wv } = world({ onTabMessage: (_t, m) => (m.type === "SHOT_HIDE" ? { hidden: true } : undefined) });
    const [a, b] = await Promise.all([wv.workerShot(3), wv.workerShot(3)]);
    await flush();
    assert.equal(a.dataUrl, RUN_PNG); assert.equal(b.dataUrl, RUN_PNG);
    const sent = shotMsgs(bg);
    assert.equal(sent.length, 4, "a hide and a show per shot");
    assert.ok(sent.every(([tab, , opts]) => tab === 3 && opts?.frameId === 0), "never another tab or a subframe");
    const ids = (t) => sent.filter(([, m]) => m.type === t).map(([, m]) => m.id).sort();
    assert.deepEqual(ids("SHOT_HIDE"), ids("SHOT_SHOW"), "each show names a hide");
    assert.notEqual(ids("SHOT_HIDE")[0], ids("SHOT_HIDE")[1], "two shots share an id: one's show would lift the other's hide");
});

// --- (b) the sidebar is not in the shot ---

test("with the debugger off, a shell that is mounted but has not confirmed the hide is not shot past: the capture waits or is refused", {
    todo: "workerShot captures after 200 ms whether or not the shell answered (worker-vision.ts SHOT_HIDE_MS race). The shell answers after two frames on the PAGE's main thread, which the page can hold (it sees the hide as a style mutation), and captureVisibleTab shoots the last painted frame: the sidebar is in the shot (tests/e2e/redteam-worker-shot.spec.mjs shows it in pixels). This PR: on the own-tab path, a send that did not REJECT (a shell is there) and did not answer in time means refuse, not capture; with CDP the capture renders the current DOM, so the timeout may stand there.",
}, async () => {
    const order = [];
    const { wv } = world({
        cdp: false,
        // The page starves frames: the shell's two-frame ack comes 400 ms late.
        onTabMessage: (_t, m) => { order.push(m.type); return m.type === "SHOT_HIDE" ? tick(400).then(() => { order.push("hidden"); return { hidden: true }; }) : undefined; },
        onCaptureTab: async () => { order.push("capture"); return RUN_PNG; },
    });
    const r = await wv.workerShot(3).then(() => "shot", (e) => e.message);
    await tick(450);
    if (r === "shot") assert.ok(order.indexOf("hidden") >= 0 && order.indexOf("hidden") < order.indexOf("capture"), `the capture went before the shell had hidden the sidebar: ${order.join(" → ")}`);
});

test("every bounded step of a worker shot together stays inside the shell's 15 s hold, so the sidebar is not back mid-shot", async () => {
    const bounded = SHOT_HIDE_MS + CDP_SHOT_MS + CAPTURE_RETRIES * CAPTURE_RETRY_MS;
    assert.ok(bounded < WORKER_SHOT_HOLD_MS, `${bounded} ms of bounded steps against a ${WORKER_SHOT_HOLD_MS} ms hold`);
    // Measured: a debugger shot that never finishes, then the own-tab capture hitting its quota every time (a page on an
    // approved origin can spend that quota with CAPTURE_TAB).
    const { wv } = world({
        cdp: true,
        onTabMessage: () => new Promise(() => {}),
        onDebuggerCommand: (m) => (m === "Page.captureScreenshot" ? new Promise(() => {}) : undefined),
        onCaptureTab: async () => { throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."); },
    });
    const t0 = Date.now();
    await assert.rejects(wv.workerShot(3), /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
    const took = Date.now() - t0;
    assert.ok(took < WORKER_SHOT_HOLD_MS, `the shot took ${took} ms`);
});

// --- (d) the shell acts on the worker alone ---

test("no page-started or run-tab message, from the run's tab or a hostile one, makes the worker send SHOT_* to any tab", async () => {
    const { bg } = world({ siteGate: true, local: { ml_site_always: ["https://run.example"] } });
    const evil = { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", origin: "https://evil.example", frameId: 0, documentId: "doc-evil" };
    await sendEveryType(bg, { type: "SHOT_SHOW", id: "x", tabId: 4, runId: "run-1" }, [fromRunTab(), evil], { id: "x" });
    assert.deepEqual(shotMsgs(bg), [], "a page's message became a SHOT_* to a shell");
    // Positive control: the worker's own shot does reach the shell.
    await bg.context.__mlWorkerVisionForTest.workerShot(3, { hideMs: 10 });
    await flush();
    assert.equal(shotMsgs(bg).length, 2);
});

test("the page's own hide never ends: the extension's sidebar and approval card stay hidden for as long as the page likes", {
    todo: "pre-existing, not this PR: `__mlSidebarShot: \"hide\"` from any window message (no e.source check, so a cross-origin subframe too) sets pageHidden with no bound, hiding the sidebar and the off-mode approval card until the page says show. A page can also cover them with its own overlay, so the fix is a bound like the worker's hold (lift a page hide after a few seconds), for the honest page-hosted look, which shows within a second.",
}, async () => {
    const surface = { hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; } };
    const gate = shotGate(surface, 40);
    gate.pageHide(() => {});
    assert.equal(surface.hidden, true, "control: the page's hide hides");
    await tick(200);
    assert.equal(surface.hidden, false, "the page's hide is still holding the sidebar hidden");
});

// --- (c) spend: only the worker's own calls, only into its own run ---

test("a vision sub-call for a model the model filter blocks sends nothing and counts nothing", async () => {
    let calls = 0;
    const { wv } = world({ cfg: { modelFilter: "^allowed-" }, onFetch: (c) => { if (c.url.includes("/chat/completions")) calls++; return jsonResponse({ model: "allowed-vl", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }); } });
    wv.seedRun("run-1", 3);
    await assert.rejects(wv.workerVisionChat("run-1", "describe", { images: [RUN_PNG], model: "blocked-vl", maxTokens: 64, numCtx: null }), /model filter/);
    assert.equal(calls, 0);
    assert.equal(spendOf(wv, "run-1").calls, 0);
    // Positive control: an allowed model goes and is counted.
    assert.equal(await wv.workerVisionChat("run-1", "describe", { images: [RUN_PNG], model: "allowed-vl", maxTokens: 64, numCtx: null }), "ok");
    assert.equal(calls, 1);
    assert.equal(spendOf(wv, "run-1").calls, 1);
});

test("no message a page can send, naming the run, sends a model call through the run's metered path or changes its spend", async () => {
    const backend = [];
    const { bg, wv } = world({
        siteGate: true, local: { ml_site_always: ["https://run.example"] },
        onFetch: (c) => { backend.push(c); return jsonResponse({ model: "vl", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }); },
    });
    wv.seedRun("run-1", 3);
    const before = spendOf(wv, "run-1");
    const session = hintSession("run-1");
    const payload = { runId: "run-1", hash: "run-1", messages: [{ role: "user", content: "spend" }], prompt: "spend", hint: { use: "agent", session }, images: [RUN_PNG], model: "vl" };
    await sendEveryType(bg, payload, [fromRunTab()]);
    assert.ok(chatCalls(backend).length > 0, "control: the approved page's own FETCH_LLM did reach the backend");
    assert.deepEqual(spendOf(wv, "run-1"), before, "a page's call was counted into the worker run's sub-call spend");
    // Positive control: the worker's own call is.
    await wv.workerVisionChat("run-1", "describe", { images: [], model: "vl", maxTokens: 8, numCtx: null });
    assert.equal(spendOf(wv, "run-1").calls, before.calls + 1);
});

test("a page's FETCH_LLM cannot file its generation under a worker-built run's session on the wire", {
    todo: "pre-existing, not this PR: FETCH_LLM passes the page's `hint.session` through wireHint unchanged, so an approved page that knows a worker run's hash files its own model calls under `wml-<hash>`, and the resource panel (model-stats.ts groups server gens by hint.session) shows them as that run's. The run's own subUsage is untouched (previous test). Fix in the FETCH_LLM handler: drop a page's hint.session that names a worker-built run (workerRunsStarting / the run registry), or any session not of a run the page hosts.",
}, async () => {
    const bodies = [];
    const { bg, wv } = world({ siteGate: true, local: { ml_site_always: ["https://run.example"] }, onFetch: (c) => { if (c.body?.messages) bodies.push(c.body); return jsonResponse({ choices: [{ message: { content: "ok" } }] }); } });
    wv.seedRun("run-1", 3);
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "x" }], hint: { use: "agent", session: hintSession("run-1") } } }, fromRunTab());
    assert.equal(bodies.length, 1, "control: the call went");
    assert.notEqual(bodies[0].hint?.session, hintSession("run-1"), "the page's call is filed under the worker run's session");
});
