// nav-handover.test.mjs — a page-built run that navigates onto a site that may not use window.ml is handed to the worker
// there (src/sw/nav-handover.ts, docs/spec/SITE_ACCESS.md slice 2 part 5), and the rest of its turn runs as a worker run.
//
// The built worker in node:vm (tests/helpers.js `loadBackground`, with the real origin gate): an approved page's START_RUN
// builds the run, the page is played by `onTabMessage`, and the navigation is the browser's commit (`bg.commit`) followed
// by the destination's re-adopt (CONTENT_READY, RUN_READOPTED), as content.ts sends them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUILDER = "https://builder.example/start";
const UNAPPROVED = "https://elsewhere.example/landing";
const ALSO_APPROVED = "https://friend.example/landing";
const CAPS = { "text-driver": ["completion", "tools"], "reader-vl": ["completion", "vision"] };
const QUESTION = "Q-SECRET-4242 what is the total";

/** A PNG header the worker reads a capture's size from. */
function png(w, h) {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return `data:image/png;base64,${b.toString("base64")}`;
}

/** A blank raster (a vm worker has no OffscreenCanvas). */
function blankRaster() {
    let n = 0;
    const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" ? undefined : p === "getImageData" ? (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }) : p === "measureText" ? (s) => ({ width: String(s).length * 7 }) : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
    return { decode: async () => ({ source: {}, width: 1024, height: 768, close() {} }), canvas: (w, h) => ({ width: w, height: h, getContext: () => ctx }), encode: async () => `data:image/png;base64,CROP${++n}` };
}

/** The page's honest geometry for the worker's look. */
function geometry(g) {
    switch (g.op) {
        case "view": return { w: 1024, h: 768, dpr: 1, sx: 0, sy: 0 };
        case "target": return { rect: { left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 } };
        case "legend": return { controls: [], media: [], boundaries: [], text: [], moreControls: 0, moreMedia: 0 };
        default: return null;
    }
}

/**
 * A run an approved page (BUILDER) builds on tab 7, whose driver calls `calls` in order, then answers "done". A
 * `navigate` call moves the tab to its `url`: the page answers it, then the browser commits the new document and, unless
 * `readopt` is false, the destination re-adopts the run. `page(payload)` plays the page for any other tool call.
 */
async function run({ calls, page = () => undefined, readopt = true, onNavigated = async () => {} }) {
    const tab = { id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" };
    const driverBodies = [], subs = [], adopts = [];
    let bg, docN = 1;
    const sender = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    const navigate = async (url) => {
        tab.url = url; docN++;
        bg.commit(7, { documentId: `doc-${docN}`, url });
        await onNavigated(bg);
        if (!readopt) return;
        const ready = plain(await bg.send({ type: "CONTENT_READY" }, sender()));
        adopts.push({ url, adopt: ready?.adopt ?? [] });
        await bg.send({ type: "RUN_READOPTED", payload: { runId: "page-run", pageInfo: `You are on ${url}` } }, sender());
    };
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", ocrModel: "reader-vl", debugMode: "off", cdp: false },
        siteGate: true, local: { ml_site_always: ["https://builder.example", "https://friend.example"] },
        openTabs: [tab],
        onCaptureTab: async () => png(1024, 768),
        onFetch: async (call) => {
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: Object.keys(CAPS).map((id) => ({ id })) });
            if (call.url.endsWith("/api/show")) { const caps = CAPS[call.body?.model]; return caps ? jsonResponse({ capabilities: caps, model_info: {} }) : jsonResponse({}, 404); }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!(Array.isArray(call.body?.tools) && call.body.tools.length)) { subs.push(call.body); return jsonResponse({ model: call.body?.model, choices: [{ message: { content: "the reader's words" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }); }
            driverBodies.push(call.body);
            const next = calls[driverBodies.length - 1];
            return next ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${driverBodies.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: "tool_calls" }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tabId, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.geometry) return { result: "", geometry: { seq: p.geometry.seq, reply: geometry(p.geometry) } };
            if (p.finish) return { result: "" };
            if (p.renderOnly || p.precheck || p.readonlyTry) return { result: "" };
            if (p.name === "navigate") { setTimeout(() => void navigate(p.args.url), 5); return { result: `Navigating to ${p.args.url}` }; }
            const r = await page(p);
            return r !== undefined ? r : { result: `ran ${p.name}` };
        },
    });
    bg.context.__mlWorkerVisionForTest.useRaster(blankRaster());
    const tools = ["navigate", "look", "scroll"];
    const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: name === "look" ? ["vision"] : [] });
    const started = bg.send({ type: "START_RUN", payload: { runId: "page-run", task: "do it", systemPrompt: "sys", tools: tools.map(tool), model: "text-driver", think: null, maxSteps: 20, surface: "off", crossOrigin: true, approvalRouting: "both",
        rebuild: { toolNames: tools, model: "text-driver", driverSees: false, visionModel: "reader-vl", groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } },
        sender());
    for (let i = 0; i < 4000 && driverBodies.length <= calls.length; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await sleep(2);
    }
    await sleep(30);
    const log = async () => (await bg.context.__mlRunLog.all()).filter((r) => r.run === "page-run" && r.subsystem === "routing").map((r) => plain(r));
    return {
        bg, tab, started, driverBodies, subs, adopts, log,
        /** Every RUN_TOOL_IN_PAGE call (no preview, no geometry) the tab was sent, by tool name. */
        calls: () => bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE").map(([, m]) => plain(m.payload)).filter((p) => p.name && !p.renderOnly && !p.precheck && !p.readonlyTry && !p.geometry && !p.finish),
        geometryAsked: () => bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.geometry).length,
        results: () => (driverBodies.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)),
    };
}

// --- a page-built run that navigates onto a site that may not use window.ml ---

test("a page-built run that navigates onto an unapproved site is handed to the worker there: its next look runs in the worker, and its re-adopt names no model", T, async () => {
    const w = await run({ calls: [{ name: "look", args: { question: QUESTION } }, { name: "navigate", args: { url: UNAPPROVED } }, { name: "look", args: { question: QUESTION } }] });
    assert.equal(w.driverBodies.length, 4, "the run went through its three calls and answered");
    const looks = w.calls().filter((p) => p.name === "look");
    // The positive control: before the navigation the run was the page's, and its look ran there with the question.
    assert.equal(looks.length, 1, `only the first look reached the page as a call: ${JSON.stringify(looks)}`);
    assert.equal(looks[0].args.question, QUESTION);
    assert.ok(w.geometryAsked() > 0, "the second look asked the page for geometry only");
    assert.equal(w.subs.at(-1)?.model, "reader-vl", "the worker's look asked the reader the run was built with");
    // The destination's re-adopt: the worker's run, with no model or vision fact for the page.
    const adopt = w.adopts[0]?.adopt.find((a) => a.runId === "page-run");
    assert.ok(adopt, `the destination re-adopted the run: ${JSON.stringify(w.adopts)}`);
    assert.equal(adopt.rebuild.builtBy, "worker");
    assert.equal(adopt.rebuild.model, null);
    assert.equal(adopt.rebuild.visionModel, null);
    assert.ok(!JSON.stringify(w.adopts).includes("text-driver") && !JSON.stringify(w.adopts).includes("reader-vl"));
    const log = await w.log();
    assert.deepEqual(log.filter((r) => r.kind === "handed-to-worker").map((r) => [r.reason, r.detail.origin]), [["navigated-to-unapproved-site", "https://elsewhere.example"]]);
});

test("a page-built run that navigates onto another APPROVED site stays the page's: its next look still runs in the page", T, async () => {
    const w = await run({ calls: [{ name: "navigate", args: { url: ALSO_APPROVED } }, { name: "look", args: { question: QUESTION } }] });
    assert.equal(w.driverBodies.length, 3);
    const looks = w.calls().filter((p) => p.name === "look");
    assert.equal(looks.length, 1, "the look went to the page");
    assert.equal(looks[0].args.question, QUESTION);
    const adopt = w.adopts[0]?.adopt.find((a) => a.runId === "page-run");
    assert.equal(adopt?.rebuild.builtBy, undefined, "still page-built");
    assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker"), []);
});

test("the hand-over is the browser's commit, not the page's word: a destination that never re-adopts the run still has it handed over", T, async () => {
    let handedAtCommit = null;
    const w = await run({ readopt: false, calls: [{ name: "navigate", args: { url: UNAPPROVED } }],
        onNavigated: async (bg) => { await sleep(20); handedAtCommit = (await bg.context.__mlRunLog.all()).some((r) => r.run === "page-run" && r.kind === "handed-to-worker"); } });
    assert.ok(w.driverBodies.length >= 1);
    assert.equal(handedAtCommit, true, "handed over before any message from the new document");
    assert.deepEqual(w.adopts, [], "the destination said nothing");
});

test("a page-built run handed over mid-turn has the rest of its turn's answer and finish driven by the worker", T, async () => {
    // The finish of a worker's run asks the page to end its registration (`finish: true`); a page-built run's does not.
    const w = await run({ calls: [{ name: "navigate", args: { url: UNAPPROVED } }, { name: "scroll", args: {} }] });
    assert.equal(w.driverBodies.length, 3);
    const finish = w.bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.finish);
    assert.equal(finish.length, 1, "the worker ended the run's page registration, as for a run it built");
    // And the turn's result reached the surfaces from the worker (no page-side caller is left).
    const result = w.bg.tabMessages.map(([, m]) => m).find((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === "page-run");
    assert.ok(result, "the worker fanned the run's result");
});
