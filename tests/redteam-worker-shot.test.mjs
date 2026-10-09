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
const CDP_SHOT_MS = constOf("CDP_SHOT_MS"), SHOT_RECTS_MS = constOf("SHOT_RECTS_MS");
const { jsonResponse, loadBackground } = require("./helpers");
const { PAGE_STARTED_TYPES, RUN_TAB_TYPES } = require("../src/page-relay.ts");

globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.chrome ??= { runtime: { id: "ext-id" } };
const { pageShotGate } = await import("../src/sidebar/shell-shot.ts");

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
/** The shell's answer when none of the extension's UI is on the page. */
const NO_UI = { vw: 800, vh: 600, rects: [] };
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
        // The shell, by default mounted with no extension UI showing.
        onTabMessage: (...a) => (onTabMessage ? onTabMessage(...a) : a[1]?.type === "SHOT_RECTS" ? NO_UI : undefined),
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

test("a shot whose tab commits another document between the rect query and the capture is refused, not handed back with that document's pixels", async () => {
    for (const cdp of [false, true]) {
        // Positive control: no navigation, the run's own document.
        const honest = world({ cdp });
        assert.equal((await honest.wv.workerShot(3)).dataUrl, RUN_PNG, `cdp=${cdp}: the honest shot`);

        // The page navigates the tab to a page the person is signed in to as the shot starts.
        const w = world({ cdp, onTabMessage: (_t, m) => { if (m.type === "SHOT_RECTS" && w.state.doc === "doc-A") w.navigate(); return NO_UI; } });
        const got = await w.wv.workerShot(3).then((s) => s.dataUrl, (e) => `refused: ${e.message}`);
        assert.notEqual(got, BANK_PNG, `cdp=${cdp}: the worker returned another document's pixels as the run's screenshot`);
        assert.match(got, /^refused: .*went to another page/);

        // A commit back to the same document id (a back-forward cache restore) during the shot is refused too.
        const b = world({ cdp, onCaptureTab: async () => { b.bg.commit(3, { documentId: "doc-A", url: RUN_URL }); return RUN_PNG; },
            onDebuggerCommand: (m) => { if (m === "Page.captureScreenshot") { b.bg.commit(3, { documentId: "doc-A", url: RUN_URL }); return { data: RUN_PNG.split(",")[1] }; } } });
        await assert.rejects(b.wv.workerShot(3), /went to another page/, `cdp=${cdp}: a commit during the shot`);
    }
});

test("the rect query is pinned to the run's document: it names the documentId the shot is of", async () => {
    const { bg, wv } = world();
    await wv.workerShot(3);
    const q = shotMsgs(bg);
    assert.equal(q.length, 2);
    assert.ok(q.every(([tab, m, opts]) => tab === 3 && m.type === "SHOT_RECTS" && opts?.frameId === 0 && opts?.documentId === "doc-A"));
});

test("two shots at once each ask the run's tab, top frame only, and neither sends anything that changes the page", async () => {
    const { bg, wv } = world();
    const [a, b] = await Promise.all([wv.workerShot(3), wv.workerShot(3)]);
    await flush();
    assert.equal(a.dataUrl, RUN_PNG); assert.equal(b.dataUrl, RUN_PNG);
    const sent = shotMsgs(bg);
    assert.equal(sent.length, 4, "a query before and after per shot");
    assert.ok(sent.every(([tab, m, opts]) => tab === 3 && m.type === "SHOT_RECTS" && Object.keys(m).length === 1 && opts?.frameId === 0), "a bare read, never another tab or a subframe");
});

// --- (b) the sidebar is not in the shot ---

test("a shell that is mounted but does not say where the extension's UI is in time (the page holds its main thread) gets no shot taken past it", async () => {
    for (const cdp of [false, true]) {
        const order = [];
        const { wv } = world({
            cdp,
            // The page starves its main thread: the shell's answer comes 1.5 s late, past the bound.
            onTabMessage: (_t, m) => { order.push(m.type); return tick(SHOT_RECTS_MS + 500).then(() => { order.push("answered"); return NO_UI; }); },
            onCaptureTab: async () => { order.push("capture"); return RUN_PNG; },
            onDebuggerCommand: (m) => { if (m === "Page.captureScreenshot") { order.push("capture"); return { data: RUN_PNG.split(",")[1] }; } },
        });
        const r = await wv.workerShot(3).then(() => "shot", (e) => e.message);
        assert.match(r, /too busy/, `cdp=${cdp}: ${order.join(" → ")}`);
        assert.ok(!order.includes("capture"), `cdp=${cdp}: a capture was taken without knowing where the UI is`);
    }
});

test("every step of a worker shot is bounded: a page stalling every one of them gets a refusal in bounded time, never a hang", async () => {
    const bounded = 2 * SHOT_RECTS_MS + CDP_SHOT_MS + CAPTURE_RETRIES * CAPTURE_RETRY_MS;
    // A debugger shot that never finishes, then the own-tab capture hitting its quota every time (a page on an approved
    // origin can spend that quota with CAPTURE_TAB).
    const { wv } = world({
        cdp: true,
        onDebuggerCommand: (m) => (m === "Page.captureScreenshot" ? new Promise(() => {}) : undefined),
        onCaptureTab: async () => { throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."); },
    });
    const t0 = Date.now();
    await assert.rejects(wv.workerShot(3), /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
    const took = Date.now() - t0;
    assert.ok(took < bounded + 1000, `the shot took ${took} ms against ${bounded} ms of bounded steps`);
    // And a shell that never answers at all is a refusal at the first bound.
    const silent = world({ onTabMessage: () => new Promise(() => {}) });
    const t1 = Date.now();
    await assert.rejects(silent.wv.workerShot(3), /too busy/);
    assert.ok(Date.now() - t1 < SHOT_RECTS_MS + 500);
});

// --- (d) the shell acts on the worker alone ---

test("no page-started or run-tab message, from the run's tab or a hostile one, makes the worker send SHOT_* to any tab", async () => {
    const { bg } = world({ siteGate: true, local: { ml_site_always: ["https://run.example"] } });
    const evil = { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", origin: "https://evil.example", frameId: 0, documentId: "doc-evil" };
    await sendEveryType(bg, { type: "SHOT_RECTS", id: "x", tabId: 4, runId: "run-1" }, [fromRunTab(), evil], { id: "x" });
    assert.deepEqual(shotMsgs(bg), [], "a page's message became a SHOT_* to a shell");
    // Positive control: the worker's own shot does reach the shell.
    await bg.context.__mlWorkerVisionForTest.workerShot(3);
    await flush();
    assert.equal(shotMsgs(bg).length, 2);
});

test("the page's own hide ends on its own: a page cannot keep the extension's sidebar and approval card hidden by never saying show", async () => {
    const surface = { hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; } };
    const gate = pageShotGate(surface, 40);
    gate.pageHide(() => {});
    assert.equal(surface.hidden, true, "control: the page's hide hides");
    await tick(200);
    assert.equal(surface.hidden, false, "the page's hide is still holding the sidebar hidden");
    // The shell takes the handshake only from its own window (shell.ts: e.source === window), so a cross-origin
    // subframe's post does not hide anything.
    const shell = readFileSync(new URL("../src/sidebar/shell.ts", import.meta.url), "utf8");
    assert.match(shell, /__mlSidebarShot === "hide" && e\.source === window/);
    assert.match(shell, /__mlSidebarShot === "show" && e\.source === window/);
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

test("a page's FETCH_LLM cannot file its generation under a worker-built run's session on the wire", async () => {
    const bodies = [];
    // A real worker-built run (the worker-tool state `seedRun` makes is not one): its hash is what the page knows.
    const { bg } = world({ siteGate: true, local: { ml_site_always: ["https://run.example"] },
        onTabMessage: (_t, m) => (m?.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : m?.type === "SHOT_RECTS" ? NO_UI : m?.type === "RUN_TOOL_IN_PAGE" ? { result: "" } : undefined),
        onFetch: (c) => { if (c.body?.messages) bodies.push(c.body); return jsonResponse({ choices: [{ message: { content: "ok" } }] }); } });
    const { hash } = await bg.context.__mlStartUserRunForTest(3, { task: "a task", surface: "hud" });
    await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "PAGE CALL" }], hint: { use: "agent", session: hintSession(hash) } } }, fromRunTab());
    const page = bodies.filter((b) => b.messages.some((m) => m.content === "PAGE CALL"));
    assert.equal(page.length, 1, "control: the call went");
    assert.notEqual(page[0].hint?.session, hintSession(hash), "the page's call is filed under the worker run's session");
});
