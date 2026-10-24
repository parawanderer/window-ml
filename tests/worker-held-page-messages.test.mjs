// worker-held-page-messages.test.mjs — every message the worker sends the tab of a run it holds, from the run's start
// to after it settles, and what each may carry into the page's world (docs/dev/site-access.md; review of #625).
//
// The built worker in node:vm (tests/helpers.js `loadBackground`, with the real origin gate) drives a run on a page whose
// site may not use window.ml: one the worker built, and one a page built that is handed to the worker at a navigation.
// The page is played by `onTabMessage`. Each run is given content the page must never read (the person's task and
// follow-up, the answer, the model names, another site's text, python's output, the look question and the reader's
// reply), and every message is checked by type: the ones content.ts or the shell post on the page's window against a
// list of fields, the shell's own against content.ts (they must not reach the window at all), and any other type fails
// until it is classified here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITE = "https://site.example/page";
const ELSEWHERE = "https://elsewhere.example/landing";
const BUILDER = "https://builder.example/start";
const CAPS = { "text-driver": ["completion", "tools"], "reader-vl": ["completion", "vision"] };

/** What the page's world must never be given, each a string that appears nowhere else. */
const SECRET = {
    task: "TASK-SECRET-1111",
    follow: "FOLLOW-SECRET-2222",
    other: "OTHER-SITE-SECRET-3333",
    summary: "SUMMARY-SECRET-4444",
    python: "PY-SECRET-5555",
    question: "LOOK-SECRET-6666",
    reader: "READER-SECRET-7777",
    driver: "text-driver",
    vision: "reader-vl",
};

/** The fields of a RUN_TOOL_IN_PAGE payload the page's world may be given for a run the worker holds. `reads` (pointer
 *  values) is allowed only empty. */
const TOOL_FIELDS = new Set(["runId", "name", "args", "renderOnly", "readonlyTry", "precheck", "verifyInWorker", "stream", "geometry", "pageRead", "answerSelect", "answerShape", "reads",
    "verifyAt", "verifyViewport", "verifyText", "verifyPipe", "verifyElement", "verifyFocus"]);
/** The fields of a rebuild a worker-held run's page may be given, with the model fields that must be empty. */
const REBUILD_FIELDS = new Set(["toolNames", "model", "driverSees", "visionModel", "groundingModel", "groundingRange", "pierceClosed", "cdp", "crossOrigin", "builtBy"]);
/** Types only the content-script shell reads: content.ts must not post them on the page's window (checked below). */
const SHELL_ONLY = new Set(["ML_DEBUG_TO_PAGE", "SHOT_RECTS", "ML_HL_REMOTE"]);

/** What is wrong with one message the tab was sent, or with one re-adopt a CONTENT_READY was answered with. */
function problems(m, runIds) {
    const out = [];
    const leaks = (x) => Object.entries(SECRET).filter(([, s]) => JSON.stringify(x ?? null).includes(s)).map(([k]) => k);
    const rebuild = (r, where) => {
        for (const k of Object.keys(r ?? {})) if (!REBUILD_FIELDS.has(k)) out.push(`${where}: rebuild field ${k}`);
        if (r?.model != null || r?.visionModel != null || r?.groundingModel != null || r?.driverSees) out.push(`${where}: rebuild names a model`);
        if (r?.builtBy !== "worker") out.push(`${where}: rebuild is not the worker's`);
    };
    if (SHELL_ONLY.has(m.type)) return out;
    if (m.type === "RUN_TOOL_IN_PAGE") {
        const p = m.payload ?? {};
        if (!runIds.includes(p.runId)) return out;
        if (p.finish) { if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(["finish", "runId"])) out.push(`finish fields ${Object.keys(p)}`); return out; }
        for (const k of Object.keys(p)) if (!TOOL_FIELDS.has(k)) out.push(`tool field ${k} (${p.name})`);
        if (p.reads?.length) out.push(`pointer values sent with ${p.name}`);
        const l = leaks(p);
        if (l.length) out.push(`${p.name ?? "geometry"} carries ${l}`);
        return out;
    }
    if (m.type === "ADOPT_RUN_NOW" || m.type === "CONTENT_READY reply") {
        for (const a of m.type === "ADOPT_RUN_NOW" ? [m.payload] : m.adopt) {
            if (!runIds.includes(a.runId)) continue;
            for (const k of Object.keys(a)) if (k !== "runId" && k !== "rebuild") out.push(`${m.type} field ${k}`);
            rebuild(a.rebuild, m.type);
            const l = leaks(a);
            if (l.length) out.push(`${m.type} carries ${l}`);
        }
        return out;
    }
    if (m.type === "RUN_STATE_IN_PAGE") { if (JSON.stringify(Object.keys(m.payload ?? {})) !== JSON.stringify(["runId"])) out.push("RUN_STATE_IN_PAGE fields"); return out; }
    // A run the worker holds runs python and server tools in the worker: no stream for them goes to the page.
    if (m.type === "PYTHON_STREAM" || m.type === "SERVER_TOOL_STREAM") { const l = leaks(m); out.push(`${m.type} sent${l.length ? ` carrying ${l}` : ""}`); return out; }
    // Sent before the worker injects the page script (sw-presence.ts injectPageScripts): its type and nothing else.
    if (m.type === "PAGE_PORT_ARM") { if (JSON.stringify(Object.keys(m)) !== JSON.stringify(["type"])) out.push("PAGE_PORT_ARM fields"); return out; }
    if (m.type === "ML_SESSION_TO_PAGE") { if (runIds.includes(m.hash)) out.push(`ML_SESSION_TO_PAGE for the run carries ${leaks(m)}`); return out; }
    out.push(`unclassified message type ${m.type}: add it here with what it may carry`);
    return out;
}

/** A model that calls `calls` in order, then answers with each of `answers` in turn, one per turn. */
function scripted(turns) {
    let turn = 0, i = 0;
    const bodies = [], subs = [];
    return {
        bodies, subs,
        onFetch: async (call) => {
            if (call.url.startsWith("https://other.example/")) return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => `<h1>${SECRET.other}</h1>`, body: null };
            if (call.url.endsWith("/api/models")) return jsonResponse({ data: Object.keys(CAPS).map((id) => ({ id })) });
            if (call.url.endsWith("/api/show")) { const caps = CAPS[call.body?.model]; return caps ? jsonResponse({ capabilities: caps, model_info: {} }) : jsonResponse({}, 404); }
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            if (!(Array.isArray(call.body?.tools) && call.body.tools.length)) { subs.push(call.body); return jsonResponse({ model: call.body?.model, choices: [{ message: { content: SECRET.reader } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }); }
            bodies.push(call.body);
            const t = turns[turn];
            const next = t?.calls[i];
            if (next) { i++; return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: "tool_calls" }] }); }
            turn++; i = 0;
            return jsonResponse({ choices: [{ message: { content: t?.answer ?? "done" } }] });
        },
    };
}

/** A page on tab 7 that answers every tool honestly and moves the tab on `navigate`, re-adopting as content.ts does. */
function tabWorld({ url, local, model, page = async () => undefined }) {
    const tab = { id: 7, windowId: 3, active: true, url, title: "Tab" };
    const adopts = [];
    let bg, docN = 1;
    const sender = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    const navigate = async (to, runId) => {
        tab.url = to; docN++;
        bg.commit(7, { documentId: `doc-${docN}`, url: to });
        const ready = plain(await bg.send({ type: "CONTENT_READY" }, sender()));
        adopts.push({ type: "CONTENT_READY reply", adopt: ready?.adopt ?? [] });
        await bg.send({ type: "RUN_READOPTED", payload: { runId, pageInfo: `You are on ${to}` } }, sender());
    };
    bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", ocrModel: "reader-vl", debugMode: "off", cdp: false, autoApproveReadonly: true },
        siteGate: true, local, openTabs: [tab],
        onCaptureTab: async () => png(1024, 768),
        onFetch: model.onFetch,
        onPyRun: async (msg) => (msg.type !== "PY_RUN" ? { ok: true, prewarm: "started" } : { ok: true, value: null, stdout: `${SECRET.python}\n` }),
        onTabMessage: async (_tabId, msg) => {
            if (msg.type === "SHOT_RECTS") return { vw: 1024, vh: 768, rects: [] };
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.geometry) return { result: "", geometry: { seq: p.geometry.seq, reply: geometry(p.geometry) } };
            if (p.finish) return { result: "" };
            if (p.renderOnly || p.precheck || p.readonlyTry) return { result: "" };
            if (p.name === "navigate") { setTimeout(() => void navigate(p.args.url, p.runId), 5); return { result: `Navigating to ${p.args.url}` }; }
            const r = await page(p, bg, sender);
            return r !== undefined ? r : { result: `ran ${p.name}` };
        },
    });
    bg.context.__mlWorkerVisionForTest.useRaster(blankRaster());
    const approveAll = () => { for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true); };
    return { bg, tab, adopts, sender, approveAll };
}

/** Every message the tab was sent, then every re-adopt it was answered with, as one list. */
const allSent = (w) => [...w.bg.tabMessages.map(([, m]) => plain(m)), ...w.adopts];

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

/** Wait until `done()` holds, approving every gate meanwhile. */
async function until(w, done, ms = 8000) {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) { w.approveAll(); await sleep(3); }
    await sleep(30);
}

const result = (w, runId, i) => w.bg.tabMessages.map(([, m]) => m).filter((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === runId)[i];

/** The calls a turn makes: every kind of message a run's tools send the tab. */
const TURN_CALLS = [
    { name: "fetch_url", args: { url: "https://other.example/doc" } },
    { name: "python_exec", args: { code: "print(1)" } },
    { name: "look", args: { question: SECRET.question } },
    { name: "scroll", args: {} },
    { name: "exec", args: { js: "return @tool:fetch_url.length" } },
    { name: "navigate", args: { url: "https://third.example/next" } },
];

// --- every message to the tab of a run the worker holds, by type ---

test("a run the worker BUILT on a site that may not use window.ml: no message to its tab carries the run's content, over a turn, a follow-up and a cancel", T, async () => {
    const model = scripted([{ calls: TURN_CALLS, answer: SECRET.summary }, { calls: [], answer: `${SECRET.summary} again` }, { calls: [{ name: "scroll", args: {} }, { name: "scroll", args: {} }], answer: "never" }]);
    let cancelAt = null, hash;
    const w = tabWorld({ url: SITE, local: {}, model, page: async (p, bg, sender) => {
        // The third turn: the person presses Stop (the shell's CANCEL_RUN) while a page tool runs.
        if (cancelAt !== null && p.name === "scroll") void bg.send({ type: "CANCEL_RUN", payload: { runId: hash } }, sender());
        return undefined;
    } });
    ({ hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: SECRET.task, surface: "hud" }, { approvalRouting: "both" }));
    await until(w, () => result(w, hash, 0));
    assert.equal(result(w, hash, 0)?.event.summary, SECRET.summary, "positive control: the first turn ran to its answer");
    // Positive controls: the run held each secret, so a message that leaked one would carry it.
    const seen = JSON.stringify(model.bodies.at(-1).messages);
    for (const k of ["task", "other", "python", "reader"]) assert.ok(seen.includes(SECRET[k]), `the model saw the ${k} secret`);
    assert.ok(w.adopts.length > 0, "the navigation re-adopted the run");
    // The follow-up, from the person's UI, and its end.
    const sent = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash, action: "send", text: SECRET.follow, surface: "hud" } }, w.sender());
    assert.equal(sent.data, "turn");
    await until(w, () => result(w, hash, 1));
    // A third turn the person cancels.
    cancelAt = Date.now();
    const third = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash, action: "send", text: "go on", surface: "hud" } }, w.sender());
    await until(w, () => result(w, hash, 2));
    assert.equal(third.data, "turn");
    assert.ok(result(w, hash, 2)?.event.cancelled, "positive control: the third turn was cancelled");
    await sleep(100);
    const found = allSent(w).flatMap((m) => problems(m, [hash]).map((p) => `${m.type}: ${p}`));
    assert.deepEqual([...new Set(found)], [], "every message to the tab carries only what its type may");
    assert.ok(allSent(w).some((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload?.geometry), "positive control: the page was asked geometry");
    assert.ok(allSent(w).filter((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload?.finish).length >= 2, "positive control: each turn sent a finish");
});

test("a run a PAGE built, handed to the worker at a navigation onto a site that may not use window.ml: no message to its tab after the hand-over carries the run's content", T, async () => {
    const model = scripted([{ calls: [{ name: "navigate", args: { url: ELSEWHERE } }, ...TURN_CALLS.filter((c) => c.name !== "navigate")], answer: SECRET.summary }]);
    const w = tabWorld({ url: BUILDER, local: { ml_site_always: ["https://builder.example"] }, model });
    const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: name === "look" ? ["vision"] : [] });
    const names = ["navigate", "look", "scroll", "exec", "fetch_url", "python_exec"];
    const started = w.bg.send({ type: "START_RUN", payload: { runId: "page-run", task: "the page's task", systemPrompt: "sys", tools: names.map(tool), model: "text-driver", think: null, maxSteps: 20, surface: "off", crossOrigin: true, approvalRouting: "both",
        rebuild: { toolNames: names, model: "text-driver", driverSees: false, visionModel: "reader-vl", groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } }, w.sender());
    await until(w, () => result(w, "page-run", 0));
    assert.equal(result(w, "page-run", 0)?.event.summary, SECRET.summary, "positive control: the run ran to its answer");
    assert.match(JSON.stringify(plain(await started)), /handed to the extension/);
    const seen = JSON.stringify(model.bodies.at(-1).messages);
    for (const k of ["other", "python", "reader"]) assert.ok(seen.includes(SECRET[k]), `positive control: the model saw the ${k} secret`);
    // From the hand-over on: everything after the navigate call was answered.
    const all = allSent(w);
    const from = all.findIndex((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload?.name === "navigate" && !m.payload.renderOnly && !m.payload.precheck);
    assert.ok(from >= 0);
    const after = all.slice(from + 1);
    const found = after.flatMap((m) => problems(m, ["page-run"]).map((p) => `${m.type}: ${p}`));
    assert.deepEqual([...new Set(found)], [], "every message to the tab after the hand-over carries only what its type may");
});

// --- the types only the shell reads never reach the page's window ---

test("content.ts posts none of the shell's own types on the page's window, whatever they carry", async () => {
    const world = loadPageWorld({ onRuntimeMessage: () => ({ data: "ok" }) });
    const seen = [];
    world.context.window.addEventListener("message", (e) => seen.push(JSON.stringify(e.data)));
    await sleep(10);
    seen.length = 0;
    for (const type of SHELL_ONLY) await world.fireRuntimeMessage({ type, event: { kind: "agent-result", summary: SECRET.summary }, ref: SECRET.summary, watch: "begin" });
    await sleep(10);
    assert.deepEqual(seen.filter((s) => s.includes(SECRET.summary)), [], "nothing of a shell-only message reached the page's window");
});

// --- the DevTools composer's message for a run the worker holds ---

test("a DevTools composer message for a run the worker holds, sent from the panel of ANOTHER tab, reaches no page", T, async () => {
    // userRunAction refuses a run driven from a tab that is not its own (null), and the router then relayed the
    // person's message to the panel's tab as ML_SESSION_TO_PAGE, which the shell posts on that page's window.
    const model = scripted([{ calls: [], answer: SECRET.summary }]);
    const w = tabWorld({ url: SITE, local: {}, model });
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: SECRET.task, surface: "hud" }, { approvalRouting: "both" });
    await until(w, () => result(w, hash, 0));
    for (const action of ["send", "continue"]) w.bg.send({ type: "ML_SESSION_REMOTE", tabId: 9, hash, action, text: SECRET.follow });
    await sleep(100);
    const toPage = w.bg.tabMessages.filter(([, m]) => m.type === "ML_SESSION_TO_PAGE").map(([t, m]) => [t, plain(m)]);
    assert.deepEqual(toPage, [], "the person's message went to no page");
    assert.ok(!JSON.stringify(model.bodies).includes(SECRET.follow), "nor did it drive the run from another tab");
    // Control: a run the worker does not hold (a page's own) is still relayed to the panel's tab.
    w.bg.send({ type: "ML_SESSION_REMOTE", tabId: 9, hash: "page-owned-run", action: "send", text: "for the page" });
    await sleep(50);
    assert.equal(w.bg.tabMessages.filter(([t, m]) => t === 9 && m.type === "ML_SESSION_TO_PAGE" && m.hash === "page-owned-run").length, 1);
});
