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
async function run({ calls, page = () => undefined, readopt = true, onNavigated = async () => {}, onStart = () => {}, tools = ["navigate", "look", "scroll"], local = { ml_site_always: ["https://builder.example", "https://friend.example"] }, session = {}, config = {}, payload = {}, answer = "done", idb, onPyRun }) {
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
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", ocrModel: "reader-vl", debugMode: "off", cdp: false, ...config },
        siteGate: true, local, session, indexedDB: idb, onPyRun,
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
                : jsonResponse({ choices: [{ message: { content: answer } }] });
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
    onStart(bg, tab);
    const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: name === "look" ? ["vision"] : [] });
    const started = bg.send({ type: "START_RUN", payload: { runId: "page-run", task: "do it", systemPrompt: "sys", tools: tools.map(tool), model: "text-driver", think: null, maxSteps: 20, surface: "off", crossOrigin: true, approvalRouting: "both", ...payload,
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

// --- the hand-over outlives the worker that made it ---

test("a run handed over mid-turn is stored as the worker's: its in-flight snapshot says so, and a worker restarted from it refuses the approved builder page's RESUME_RUN", T, async () => {
    let bgRef = null, snap = null;
    const w = await run({ calls: [{ name: "navigate", args: { url: UNAPPROVED } }, { name: "scroll", args: {} }],
        onNavigated: async (bg) => { bgRef = bg; },
        // The step after the hand-over: the run is in flight, and the per-step snapshot was written after the navigate.
        page: (p) => { if (p.name === "scroll") snap = plain(bgRef.localStore["ml_bgrun_page-run"]); } });
    assert.equal(w.driverBodies.length, 3);
    assert.ok(snap, "an in-flight snapshot was written");
    assert.equal(snap.p.builtBy, "worker", "the snapshot an eviction resumes from is the worker's run, not the page's");
    assert.equal(snap.p.rebuild?.builtBy, "worker");
    // The eviction: a fresh worker hydrates that snapshot; the tab is back on the approved builder site, whose page
    // sends RESUME_RUN for the run. One way: it stays the worker's.
    const calls = [];
    const bg2 = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: { ml_site_always: ["https://builder.example"], "ml_bgrun_page-run": { ...snap, ts: Date.now() } },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async (call) => { calls.push(call.url); return jsonResponse({ choices: [{ message: { content: "page took it" } }] }); },
    });
    await sleep(30);
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: "https://builder.example", frameId: 0, documentId: "doc-back" };
    const r = plain(await Promise.race([bg2.send({ type: "RESUME_RUN", payload: { runId: "page-run", task: "mine again" } }, sender), sleep(2000).then(() => "no answer")]));
    assert.match(String(r?.error), /Refused/, `the page's resume was refused: ${JSON.stringify(r)}`);
    assert.ok(!calls.some((u) => u.includes("/chat/completions")), "no model call was made for the page");
});

test("a commit that wakes a worker before it has restored its runs still hands an in-flight page-built run over", T, async () => {
    const p = { runId: "slept-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: "https://builder.example",
        rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } };
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: { ml_site_always: ["https://builder.example"], "ml_bgrun_slept-run": { p, tabId: 7, messages: [], version: "9.9.9", ts: Date.now() } },
        openTabs: [{ id: 7, windowId: 3, active: true, url: UNAPPROVED, title: "Elsewhere" }],
    });
    // The event that woke the worker, delivered before its storage read came back.
    bg.commit(7, { documentId: "doc-elsewhere", url: UNAPPROVED });
    await sleep(50);
    const log = (await bg.context.__mlRunLog.all()).filter((r) => r.run === "slept-run" && r.kind === "handed-to-worker").map(plain);
    assert.equal(log.length, 1, "the commit handed the run over once the runs were restored");
    // And the page it is on cannot resume it as its builder.
    const r = plain(await Promise.race([bg.send({ type: "RESUME_RUN", payload: { runId: "slept-run", task: "x" } }, { tab: { id: 7, url: UNAPPROVED }, url: UNAPPROVED, origin: "https://elsewhere.example", frameId: 0, documentId: "doc-elsewhere" }), sleep(2000).then(() => "no answer")]));
    assert.match(String(r?.error), /Refused/);
});

// --- a top-frame document the run's tab shows without a main-frame commit ---

test("a prerendered unapproved page the tab activates is handed the run's next tool as a worker run: its look runs in the worker, never sent to the page with its question", T, async () => {
    let bgRef = null, tabRef = null;
    // Simulated from Chrome's documented behaviour (inferred, not staged in a browser): a prerender commits in its own
    // frame tree (frameId != 0, documentLifecycle "prerender"), and its activation fires no main-frame onCommitted.
    const w = await run({ calls: [{ name: "scroll", args: {} }, { name: "look", args: { question: QUESTION } }],
        page: (p) => {
            if (p.name !== "scroll" || !bgRef) return undefined;
            bgRef.commit(7, { documentId: "doc-pre", url: UNAPPROVED, frameId: 9, frameType: "outermost_frame", documentLifecycle: "prerender" });
            bgRef.activate(7, { documentId: "doc-pre", url: UNAPPROVED });
            tabRef.url = UNAPPROVED;
            return undefined;
        },
        onStart: (bg, tab) => { bgRef = bg; tabRef = tab; } });
    assert.equal(w.driverBodies.length, 3, "the run went through its two calls and answered");
    // Positive control: the scroll before the activation ran in the page.
    assert.equal(w.calls().filter((p) => p.name === "scroll").length, 1);
    const looks = w.calls().filter((p) => p.name === "look");
    assert.deepEqual(looks, [], `the activated page was sent no look call: ${JSON.stringify(looks)}`);
    const leaked = w.bg.tabMessages.map(([, m]) => m).filter((m) => m.type !== "ML_DEBUG_TO_PAGE" && JSON.stringify(m).includes("Q-SECRET-4242"));
    assert.deepEqual(leaked.map(plain), [], "the question never reached the page (the shell's own run events aside)");
    assert.ok(w.geometryAsked() > 0, "the worker's look asked the page for geometry only");
});

// --- a revoke while the run is on its builder's page, with no navigation ---

test("a page-built run whose site is revoked while it runs is handed to the worker: its page's next send is refused and reaches no backend", T, async () => {
    let bgRef = null, n = 0;
    const replies = [];
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: "https://builder.example", frameId: 0, documentId: "doc-1" };
    const pageCall = async () => replies.push(plain(await Promise.race([bgRef.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "the page's own call" }] } }, sender), sleep(3000).then(() => "no answer")])));
    const w = await run({ calls: [{ name: "scroll", args: {} }, { name: "scroll", args: {} }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => {
            if (p.name !== "scroll") return undefined;
            // Written straight into storage, with no storage event: the hand-over is decided at the run's next send.
            if (n++ === 0) { await pageCall(); bgRef.localStore.ml_site_always = ["https://friend.example"]; return undefined; }
            await pageCall();
            return undefined;
        } });
    assert.equal(w.driverBodies.length, 3, "the run went on to its answer");
    assert.ok(replies[0]?.data !== undefined && !replies[0]?.error, `positive control: before the revoke the page's call was served: ${JSON.stringify(replies[0])}`);
    assert.match(String(replies[1]?.error), /^Refused/, `after it, refused: ${JSON.stringify(replies[1])}`);
    assert.equal(w.subs.filter((b) => JSON.stringify(b).includes("the page's own call")).length, 1, "only the call before the revoke reached the backend");
    assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker").map((r) => [r.reason, r.detail.origin]), [["site-revoked", "https://builder.example"]], "handed over at its next send");
});

// --- a revoke while the run is on its builder's page, by every path that takes the site off the approved set ---

const POINTER_VALUE = "PTR-VALUE-7731";
const FIRST_EXEC = "window.a = 1; return 1";
const POINTER_EXEC = "window.b = 1; return @tool:exec.length";
const BUILDER_ORIGIN = "https://builder.example";
/** The toolbar popup, and the DevTools Settings panel: the extension's own pages, which edit the lists by SITE_ACCESS. */
const POPUP = { url: "chrome-extension://test/popup.html" };
const SETTINGS = { url: "chrome-extension://test/sidebar.html" };
const edit = (bg, sender, e) => bg.send({ type: "SITE_ACCESS", payload: { origin: e.origin, edit: e } }, sender);

/** Every path that takes BUILDER off the approved set, each with the lists it starts from. */
const REVOKE_PATHS = [
    { path: "the popup's Revoke", revoke: (bg) => edit(bg, POPUP, { op: "revoke", origin: BUILDER_ORIGIN }) },
    { path: "DevTools Settings' Revoke", revoke: (bg) => edit(bg, SETTINGS, { op: "revoke", origin: BUILDER_ORIGIN }) },
    { path: "the popup's Deny (moved to the denied list)", revoke: (bg) => edit(bg, POPUP, { op: "deny", origin: BUILDER_ORIGIN }) },
    { path: "Revoke of an approval for this session", local: { ml_site_always: ["https://friend.example"] }, session: { ml_site_session: [BUILDER_ORIGIN] },
        revoke: (bg) => edit(bg, SETTINGS, { op: "revoke", origin: BUILDER_ORIGIN }) },
    { path: "another surface or a sync writing the approved list (storage.onChanged)", revoke: async (bg) => bg.setLocal({ ml_site_always: ["https://friend.example"] }) },
    { path: "another surface or a sync writing the denied list (storage.onChanged)", revoke: async (bg) => bg.setLocal({ ml_site_denied: [BUILDER_ORIGIN] }) },
    { path: "the site's host removed from the self-approval whitelist (sync)", local: { ml_site_always: ["https://friend.example"] }, config: { pageApprovalDomains: ["builder.example"] },
        revoke: async (bg) => bg.setSync({ pageApprovalDomains: [] }) },
];

/**
 * A page-built run on BUILDER: an exec whose output the page answers with POINTER_VALUE, a scroll during which `revoke`
 * runs (or nothing, for the control), then a look with QUESTION and an exec naming the first exec's output.
 */
async function revokedRun({ revoke, local, session, config, during }) {
    let bgRef = null, mark = null, handedAtRevoke = null;
    const w = await run({
        payload: { toolTokens: true }, tools: ["exec", "look", "scroll"], ...(local ? { local } : {}), ...(session ? { session } : {}), ...(config ? { config } : {}),
        calls: [{ name: "exec", args: { js: FIRST_EXEC } }, { name: "scroll", args: {} }, { name: "look", args: { question: QUESTION } }, { name: "exec", args: { js: POINTER_EXEC } }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => {
            if (p.name === "exec" && p.args.js === FIRST_EXEC) return { result: POINTER_VALUE };
            if (p.name !== "scroll" || !revoke) return undefined;
            await revoke(bgRef);
            await during?.(bgRef);
            await sleep(20);
            // Decided at the revoke, before the run sends anything else: not left to its next send.
            handedAtRevoke = (await bgRef.context.__mlRunLog.all()).some((r) => r.run === "page-run" && r.kind === "handed-to-worker");
            mark = bgRef.tabMessages.length;
            return undefined;
        },
    });
    const after = mark == null ? [] : w.bg.tabMessages.slice(mark).map(([, m]) => plain(m));
    return { ...w, handedAtRevoke, after };
}

/** What reached the page after the revoke: a tool call, or anything carrying the question or the pointer's value. */
function pageGotAfter(after) {
    const calls = after.filter((m) => m.type === "RUN_TOOL_IN_PAGE" && m.payload?.name && !m.payload.renderOnly && !m.payload.precheck && !m.payload.readonlyTry && !m.payload.geometry && !m.payload.finish);
    // The shell's own run events (ML_DEBUG_TO_PAGE) go to the content script, never the page's world.
    const leaked = after.filter((m) => m.type !== "ML_DEBUG_TO_PAGE" && (JSON.stringify(m).includes(POINTER_VALUE) || JSON.stringify(m).includes("Q-SECRET-4242")));
    return { calls: calls.map((m) => m.payload.name), leaked };
}

test("control: a page-built run on its approved builder page sends the page its look and the pointer's value", T, async () => {
    const w = await revokedRun({});
    assert.equal(w.driverBodies.length, 5);
    const sent = w.calls();
    assert.equal(sent.filter((p) => p.name === "look").length, 1, "the look went to the page");
    const ptr = sent.find((p) => p.name === "exec" && p.args.js === POINTER_EXEC);
    assert.equal(ptr?.reads?.[0]?.value, POINTER_VALUE, `the page was sent the pointer's value: ${JSON.stringify(ptr)}`);
});

for (const { path, revoke, local, session, config } of REVOKE_PATHS) {
    test(`revoked by ${path} while its page-built run is going: the run is handed to the worker at once, and the page gets no tool call and no pointer value after it`, T, async () => {
        const w = await revokedRun({ revoke, local, session, config });
        assert.equal(w.driverBodies.length, 5, "the run went through its four calls and answered");
        assert.equal(w.handedAtRevoke, true, "handed over at the revoke, before the run's next send");
        assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker").map((r) => [r.reason, r.detail.origin]), [["site-revoked", BUILDER_ORIGIN]]);
        // Positive control: before the revoke, the page ran the run's exec.
        assert.equal(w.calls().filter((p) => p.name === "exec" && p.args.js === FIRST_EXEC).length, 1);
        const got = pageGotAfter(w.after);
        assert.deepEqual(got.calls, [], `no tool call reached the page after the revoke: ${JSON.stringify(got.calls)}`);
        assert.deepEqual(got.leaked, [], "neither the question nor the pointer's value reached the page");
        assert.ok(w.geometryAsked() > 0, "the worker's look asked the page for geometry only");
        assert.match(w.results().at(-1), /not approved/, `the pointer exec was not run on the page: ${w.results().at(-1)}`);
    });
}

test("a revoke while the page is running the run's call: the call's answer is taken, and nothing further of the run reaches the page", T, async () => {
    let bgRef = null, handedMidCall = null, mark = null, columns = [];
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-1" };
    const askColumns = async () => columns.push(plain(await bgRef.send({ type: "VALUE_COLUMNS", runId: "page-run", key: "k", names: ["a"] }, sender)));
    const w = await run({
        payload: { toolTokens: true }, tools: ["exec", "look", "scroll"],
        calls: [{ name: "exec", args: { js: FIRST_EXEC } }, { name: "look", args: { question: QUESTION } }, { name: "exec", args: { js: POINTER_EXEC } }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => {
            if (p.name !== "exec" || p.args.js !== FIRST_EXEC) return undefined;
            // The page is in the middle of the run's exec when the person revokes the site from the popup.
            await askColumns();
            await edit(bgRef, POPUP, { op: "revoke", origin: BUILDER_ORIGIN });
            await sleep(20);
            handedMidCall = (await bgRef.context.__mlRunLog.all()).some((r) => r.run === "page-run" && r.kind === "handed-to-worker");
            // Still in its call, the page asks for a stored table's columns: refused now.
            await askColumns();
            mark = bgRef.tabMessages.length;
            return { result: POINTER_VALUE };
        },
    });
    assert.equal(w.driverBodies.length, 4);
    assert.equal(handedMidCall, true, "handed over while the page's call was in flight");
    assert.doesNotMatch(String(columns[0]?.error), /^Refused/, `positive control: before the revoke the page was not refused: ${JSON.stringify(columns[0])}`);
    assert.match(String(columns[1]?.error), /^Refused/, `after it, refused: ${JSON.stringify(columns[1])}`);
    assert.match(w.results()[0], new RegExp(POINTER_VALUE), "the in-flight call's answer reached the model");
    const got = pageGotAfter(w.bg.tabMessages.slice(mark).map(([, m]) => plain(m)));
    assert.deepEqual(got.calls, [], `no tool call after the in-flight one: ${JSON.stringify(got.calls)}`);
    assert.deepEqual(got.leaked, []);
});

test("a revoke that lands while a call is being built for the page (no storage event yet): the call is built again as the worker's, whatever step it lands on", T, async () => {
    // The storage is written with no event, at the n-th time the worker asks the browser for the tab's top frame once the
    // pointer exec is on its way: every point between the run's routing decision and the send.
    let refused = 0;
    for (let nth = 1; nth <= 6; nth++) {
        let armed = false, seen = 0, mark = null;
        const w = await run({
            payload: { toolTokens: true }, tools: ["exec", "look", "scroll"],
            calls: [{ name: "exec", args: { js: FIRST_EXEC } }, { name: "exec", args: { js: POINTER_EXEC } }],
            onStart: (bg) => {
                const getFrame = bg.context.chrome.webNavigation.getFrame;
                bg.context.chrome.webNavigation.getFrame = async (q) => {
                    if (armed && ++seen === nth) { bg.localStore.ml_site_always = ["https://friend.example"]; mark = bg.tabMessages.length; }
                    return getFrame(q);
                };
            },
            page: async (p) => {
                if (p.name === "exec" && p.args.js === FIRST_EXEC) { armed = true; return { result: POINTER_VALUE }; }
                return undefined;
            },
        });
        assert.equal(w.driverBodies.length, 3, `nth=${nth}: the run answered`);
        if (mark == null) continue;
        const got = pageGotAfter(w.bg.tabMessages.slice(mark).map(([, m]) => plain(m)));
        assert.deepEqual(got.leaked, [], `nth=${nth}: the pointer's value never reached the page after the revoke`);
        assert.deepEqual(got.calls, [], `nth=${nth}: no tool call after the revoke`);
        if (/not approved/.test(w.results().at(-1))) refused++;
    }
    assert.ok(refused >= 2, `the revoke landed before the pointer exec was sent in several placements (${refused}), so the test reaches the window`);
});

test("re-approving the site does not hand the run back: its look stays the worker's, and the page cannot resume it", T, async () => {
    let bgRef = null, n = 0;
    const w = await run({ calls: [{ name: "scroll", args: {} }, { name: "scroll", args: {} }, { name: "look", args: { question: QUESTION } }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => {
            if (p.name !== "scroll") return undefined;
            if (n++ === 0) await edit(bgRef, POPUP, { op: "revoke", origin: BUILDER_ORIGIN });
            else await edit(bgRef, POPUP, { op: "allow", origin: BUILDER_ORIGIN, scope: "always" });
            return undefined;
        } });
    assert.equal(w.driverBodies.length, 4);
    assert.ok(w.bg.localStore.ml_site_always.includes(BUILDER_ORIGIN), "the site is approved again");
    assert.deepEqual(w.calls().filter((p) => p.name === "look"), [], "the look ran in the worker");
    assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker").map((r) => r.reason), ["site-revoked"]);
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-1" };
    const r = plain(await Promise.race([w.bg.send({ type: "RESUME_RUN", payload: { runId: "page-run", task: "mine again" } }, sender), sleep(2000).then(() => "no answer")]));
    assert.match(String(r?.error), /Refused/, `the approved page's resume was refused: ${JSON.stringify(r)}`);
});

// --- a revoke and a worker restart ---

test("a run handed over at a revoke stays the worker's across an eviction before its next checkpoint: the restarted worker refuses the re-approved page's RESUME_RUN", T, async () => {
    let bgRef = null, stored = null;
    const w = await run({ calls: [{ name: "scroll", args: {} }, { name: "scroll", args: {} }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => {
            if (p.name !== "scroll" || stored) return undefined;
            await edit(bgRef, POPUP, { op: "revoke", origin: BUILDER_ORIGIN });
            await sleep(20);
            // What storage holds the moment the worker is evicted, before the step ends and its snapshot is rewritten.
            stored = plain(Object.fromEntries(Object.entries(bgRef.localStore).filter(([k]) => k.startsWith("ml_bgrun_") || k === "ml_handed_to_worker")));
            return undefined;
        } });
    assert.ok(w.driverBodies.length >= 2);
    assert.ok(stored?.["ml_bgrun_page-run"], "an in-flight snapshot was written");
    assert.notEqual(stored["ml_bgrun_page-run"].p.builtBy, "worker", "the snapshot itself predates the hand-over");
    const calls = [];
    const bg2 = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: { ml_site_always: [BUILDER_ORIGIN], ...stored, "ml_bgrun_page-run": { ...stored["ml_bgrun_page-run"], ts: Date.now() } },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async (call) => { calls.push(call.url); return jsonResponse({ choices: [{ message: { content: "page took it" } }] }); },
    });
    await sleep(30);
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-back" };
    const r = plain(await Promise.race([bg2.send({ type: "RESUME_RUN", payload: { runId: "page-run", task: "mine again" } }, sender), sleep(2000).then(() => "no answer")]));
    assert.match(String(r?.error), /Refused/, `the page's resume was refused: ${JSON.stringify(r)}`);
    assert.ok(!calls.some((u) => u.includes("/chat/completions")), "no model call was made for the page");
});

test("a revoke the worker never heard (made while it was evicted) is decided when it restarts: the re-approved page cannot resume the run", T, async () => {
    const p = { runId: "slept-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: BUILDER_ORIGIN,
        rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } };
    const calls = [];
    // The lists as the other surface left them: BUILDER not approved. The restarted worker gets no storage event for it.
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: { ml_site_always: ["https://friend.example"], "ml_bgrun_slept-run": { p, tabId: 7, messages: [], version: "9.9.9", ts: Date.now() } },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async (call) => { calls.push(call.url); return jsonResponse({ choices: [{ message: { content: "page took it" } }] }); },
    });
    await sleep(50);
    const log = (await bg.context.__mlRunLog.all()).filter((r) => r.run === "slept-run" && r.kind === "handed-to-worker").map(plain);
    assert.equal(log.length, 1, "decided at the restart");
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "allow", origin: BUILDER_ORIGIN, scope: "always" } } }, POPUP);
    const r = plain(await Promise.race([bg.send({ type: "RESUME_RUN", payload: { runId: "slept-run", task: "x" } }, { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" }), sleep(2000).then(() => "no answer")]));
    assert.match(String(r?.error), /Refused/, `refused: ${JSON.stringify(r)}`);
    assert.ok(!calls.some((u) => u.includes("/chat/completions")));
});

// --- what the revoked page still gets back: the answer to its own START_RUN ---

test("a revoke mid-run: the page's own START_RUN answer carries nothing the worker did after it (no history, no summary)", T, async () => {
    let bgRef = null;
    const w = await run({ calls: [{ name: "scroll", args: {} }, { name: "look", args: { question: QUESTION } }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => { if (p.name === "scroll") await edit(bgRef, POPUP, { op: "revoke", origin: BUILDER_ORIGIN }); return undefined; } });
    assert.equal(w.driverBodies.length, 3);
    assert.equal(w.subs.filter((b) => JSON.stringify(b).includes("Q-SECRET-4242")).length, 1, "positive control: the worker's look asked its reader after the revoke");
    const answer = JSON.stringify(plain(await w.started));
    assert.ok(!answer.includes("the reader's words"), `the worker's look answer did not reach the page: ${answer.slice(0, 400)}`);
    assert.ok(!answer.includes("Q-SECRET-4242"), "the question asked after the revoke did not reach the page");
    assert.match(answer, /handed to the extension/, "the page is told why it gets no result");
});

test("control: with no revoke, the page's START_RUN answer is the run's result", T, async () => {
    const w = await run({ calls: [{ name: "scroll", args: {} }] });
    const r = plain(await w.started);
    assert.equal(r?.data?.summary, "done", JSON.stringify(r).slice(0, 300));
    assert.ok(Array.isArray(r?.messages) && r.messages.length > 0);
});

// --- `ml_handed_to_worker`: what it holds, and what a stale entry may never do ---

test("a stale ml_handed_to_worker entry does not take a later page-built run under the same id from its approved page after an eviction", T, async () => {
    // 1. A page-built run settles on its approved page; the site is then revoked. The settled run is handed over, but its
    // snapshot is already gone, so the id the store keeps outlives anything it protects.
    const first = await run({ calls: [{ name: "scroll", args: {} }] });
    await edit(first.bg, POPUP, { op: "revoke", origin: BUILDER_ORIGIN });
    assert.ok(!first.bg.localStore["ml_bgrun_page-run"], "the settled run has no snapshot");
    // 2. The worker is evicted; the person approves the site again; the page starts a fresh run under the same id (an
    // ml.agent handle keeps its hash). Storage is captured mid-run, as an eviction would find it.
    const left = plain(first.bg.localStore);
    left.ml_site_always = [BUILDER_ORIGIN, "https://friend.example"];
    let mid = null, bgRef = null;
    const second = await run({ local: left, calls: [{ name: "scroll", args: {} }, { name: "scroll", args: {} }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => { if (p.name === "scroll" && !mid) { await sleep(10); mid = plain(bgRef.localStore); } return undefined; } });
    assert.ok(second.driverBodies.length >= 2);
    assert.ok(mid?.["ml_bgrun_page-run"], "the new run's in-flight snapshot was written");
    assert.deepEqual((await second.log()).filter((r) => r.kind === "handed-to-worker"), [], "the new run was never handed over");
    // 3. A worker evicted in the middle of the new run restores it as the page's: its approved page may resume it.
    const bg3 = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: { ...mid, "ml_bgrun_page-run": { ...mid["ml_bgrun_page-run"], ts: Date.now() } },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async () => jsonResponse({ choices: [{ message: { content: "resumed" } }] }),
    });
    await sleep(30);
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-back" };
    const r = plain(await Promise.race([bg3.send({ type: "RESUME_RUN", payload: { runId: "page-run", task: "go on" } }, sender), sleep(3000).then(() => "no answer")]));
    assert.doesNotMatch(JSON.stringify(r), /started from the extension/, `the approved page's own run is still its own: ${JSON.stringify(r).slice(0, 300)}`);
    assert.deepEqual((await bg3.context.__mlRunLog.all()).filter((x) => x.run === "page-run" && x.kind === "handed-to-worker").map(plain), [], "nothing handed it over");
});

test("a page's START_RUN under the id of a run handed to the worker, sent as it wakes the worker (before the runs are restored), is refused", T, async () => {
    const p = { runId: "handed-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: BUILDER_ORIGIN,
        rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } };
    for (const [label, extra] of [["handed over after its last checkpoint", { ml_handed_to_worker: ["handed-run"] }], ["built by the worker", null]]) {
        const tasks = [];
        const snap = { p: extra ? p : { ...p, builtBy: "worker", rebuild: { ...p.rebuild, builtBy: "worker" } }, tabId: 7, messages: [{ role: "user", content: "the person's task" }], version: "9.9.9", ts: Date.now() };
        const bg = loadBackground({
            config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
            siteGate: true, local: { ml_site_always: [BUILDER_ORIGIN], "ml_bgrun_handed-run": snap, ...(extra ?? {}) },
            openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
            onFetch: async (call) => { if (call.url.includes("/chat/completions")) tasks.push(JSON.stringify(call.body)); return jsonResponse({ choices: [{ message: { content: "the page took it" } }] }); },
        });
        // No wait: the page's message is what wakes the worker.
        const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" };
        const r = plain(await Promise.race([bg.send({ type: "START_RUN", payload: { ...p, task: "the page's own task", rebuild: p.rebuild } }, sender), sleep(3000).then(() => "no answer")]));
        assert.match(String(r?.error), /Refused/, `${label}: refused: ${JSON.stringify(r).slice(0, 300)}`);
        assert.ok(!tasks.some((b) => b.includes("the page's own task")), `${label}: no model call ran the page's task`);
    }
});

test("upgrade: storage written before ml_handed_to_worker existed (no key, or a malformed one) restores a page-built run as its page's", T, async () => {
    const p = { runId: "old-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: BUILDER_ORIGIN,
        rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } };
    for (const extra of [{}, { ml_handed_to_worker: "old-run" }, { ml_handed_to_worker: [42, null, { runId: "old-run" }] }]) {
        const bg = loadBackground({
            config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
            siteGate: true, local: { ml_site_always: [BUILDER_ORIGIN], "ml_bgrun_old-run": { p, tabId: 7, messages: [], version: "9.9.9", ts: Date.now() }, ...extra },
            openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
            onFetch: async () => jsonResponse({ choices: [{ message: { content: "resumed" } }] }),
        });
        await sleep(30);
        const r = plain(await Promise.race([bg.send({ type: "RESUME_RUN", payload: { runId: "old-run", task: "go on" } }, { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" }), sleep(3000).then(() => "no answer")]));
        assert.equal(r?.data?.summary, "resumed", `${JSON.stringify(extra)}: the approved page resumed its run: ${JSON.stringify(r).slice(0, 300)}`);
        assert.deepEqual((await bg.context.__mlRunLog.all()).filter((x) => x.kind === "handed-to-worker").map(plain), [], "nothing was handed over");
    }
});

// --- a revoke that lands while a send is held, with its storage event not yet heard ---

test("a revoke written while the pointer exec's send is held by a navigation on the same approved site: the send decides again, and the pointer's value never reaches the page", T, async () => {
    let leaks = 0, reached = 0;
    for (let nth = 1; nth <= 4; nth++) {
        let armed = false, seen = 0, mark = null;
        const w = await run({
            payload: { toolTokens: true }, tools: ["exec", "look", "scroll"],
            calls: [{ name: "exec", args: { js: FIRST_EXEC } }, { name: "exec", args: { js: POINTER_EXEC } }],
            onStart: (bg) => {
                const getFrame = bg.context.chrome.webNavigation.getFrame;
                bg.context.chrome.webNavigation.getFrame = async (q) => {
                    const r = await getFrame(q);
                    if (!armed || ++seen !== nth) return r;
                    // The page navigates within its own approved site, which holds the run's next send at the barrier
                    // until the new document re-adopts. Meanwhile the site is revoked; its storage event is still on its way.
                    bg.commit(7, { documentId: "doc-next", url: "https://builder.example/next" });
                    setTimeout(async () => {
                        bg.localStore.ml_site_always = ["https://friend.example"];
                        mark = bg.tabMessages.length;
                        const s = { tab: { id: 7, url: "https://builder.example/next" }, url: "https://builder.example/next", origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-next" };
                        await bg.send({ type: "RUN_READOPTED", payload: { runId: "page-run", pageInfo: "next" } }, s);
                    }, 40);
                    return r;
                };
            },
            page: async (p) => {
                if (p.name === "exec" && p.args.js === FIRST_EXEC) { armed = true; return { result: POINTER_VALUE }; }
                return undefined;
            },
        });
        assert.equal(w.driverBodies.length, 3, `nth=${nth}: the run answered`);
        if (mark == null) continue;
        reached++;
        const got = pageGotAfter(w.bg.tabMessages.slice(mark).map(([, m]) => plain(m)));
        if (got.leaked.length || got.calls.length) leaks++;
    }
    assert.ok(reached > 0, "the revoke landed during a held send in at least one placement");
    assert.equal(leaks, 0, `in ${leaks} of ${reached} placements the call built for the page was sent after the revoke`);
});

// --- which runs a revoke hands over: several tabs, ports, and approvals that still cover the site ---

/** A worker with page-built runs settled on `tabs` (each `{ id, url }`), started by their own pages. */
async function settledRuns({ tabs, local, config = {} }) {
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off", ...config },
        siteGate: true, local,
        openTabs: tabs.map((t) => ({ id: t.id, windowId: 3, active: false, url: t.url, title: "t" })),
        onFetch: async (call) => (call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "done" } }] }) : jsonResponse({})),
    });
    for (const t of tabs) {
        const origin = new URL(t.url).origin;
        const r = plain(await bg.send({ type: "START_RUN", payload: { runId: `run-${t.id}`, task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 3, surface: "off", crossOrigin: true,
            rebuild: { toolNames: [], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } },
            { tab: { id: t.id, url: t.url }, url: t.url, origin, frameId: 0, documentId: `doc-${t.id}` }));
        assert.equal(r?.data?.summary, "done", `run on tab ${t.id} (${t.url}) ran: ${JSON.stringify(r).slice(0, 200)}`);
    }
    const handed = async () => (await bg.context.__mlRunLog.all()).filter((r) => r.kind === "handed-to-worker").map((r) => r.run).sort();
    return { bg, handed };
}

test("a revoke hands over the page-built runs on every tab of the revoked origin and on no other", T, async () => {
    const w = await settledRuns({ local: { ml_site_always: [BUILDER_ORIGIN, "https://friend.example"] }, tabs: [
        { id: 7, url: BUILDER }, { id: 8, url: "https://builder.example/other" }, { id: 9, url: ALSO_APPROVED }] });
    await edit(w.bg, POPUP, { op: "revoke", origin: BUILDER_ORIGIN });
    assert.deepEqual(await w.handed(), ["run-7", "run-8"]);
});

test("removing a host from the self-approval whitelist hands over its runs on every port; an entry that still covers the origin hands over nothing", T, async () => {
    // The whitelist names a host: it approves https on any port.
    const w = await settledRuns({ local: { ml_site_always: ["https://friend.example"] }, config: { pageApprovalDomains: ["builder.example"] }, tabs: [
        { id: 7, url: BUILDER }, { id: 8, url: "https://builder.example:8443/x" }, { id: 9, url: ALSO_APPROVED }] });
    w.bg.setSync({ pageApprovalDomains: [] });
    await sleep(50);
    assert.deepEqual(await w.handed(), ["run-7", "run-8"]);

    // Still covered: the list entry goes, the whitelist keeps the host.
    const a = await settledRuns({ local: { ml_site_always: [BUILDER_ORIGIN] }, config: { pageApprovalDomains: ["builder.example"] }, tabs: [{ id: 7, url: BUILDER }] });
    await edit(a.bg, POPUP, { op: "revoke", origin: BUILDER_ORIGIN });
    assert.deepEqual(await a.handed(), [], "the whitelist still approves the site");
    // Still covered: one whitelist entry goes, another list keeps the origin.
    const b = await settledRuns({ local: { ml_site_always: [BUILDER_ORIGIN] }, config: { pageApprovalDomains: ["builder.example", "x.example"] }, tabs: [{ id: 7, url: BUILDER }] });
    b.bg.setSync({ pageApprovalDomains: ["x.example"] });
    await sleep(50);
    assert.deepEqual(await b.handed(), [], "the approved list still holds the site");
    // Still covered: the session approval stays while another surface rewrites the approved list without it.
    const c = await settledRuns({ local: { ml_site_always: [BUILDER_ORIGIN] }, tabs: [{ id: 7, url: BUILDER }] });
    await c.bg.context.chrome.storage.session.set({ ml_site_session: [BUILDER_ORIGIN] });
    c.bg.setLocal({ ml_site_always: [] });
    await sleep(50);
    assert.deepEqual(await c.handed(), [], "the session approval still holds the site");
});

test("a denial whose session-list write fails after the denied list was written still hands the run over", T, async () => {
    const w = await settledRuns({ local: { ml_site_always: [BUILDER_ORIGIN] }, tabs: [{ id: 7, url: BUILDER }] });
    const session = w.bg.context.chrome.storage.session;
    // Only the list's write fails: the execution log lives in the same area.
    const set = session.set;
    session.set = async (obj) => { if ("ml_site_session" in obj) throw new Error("QUOTA_BYTES quota exceeded"); return set(obj); };
    const r = plain(await edit(w.bg, POPUP, { op: "deny", origin: BUILDER_ORIGIN }));
    assert.match(String(r?.error), /quota/, "the editor hears the write failed");
    await sleep(50);
    assert.deepEqual(plain(w.bg.localStore.ml_site_denied), [BUILDER_ORIGIN], "the denied list was written");
    assert.deepEqual(await w.handed(), ["run-7"]);
});

// --- VALUE_COLUMNS under the origin gate: an approved page's own reads still work ---

test("VALUE_COLUMNS: a value disclosed to an APPROVED page reads back under the real origin gate, and the same page is refused once its site is revoked", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const { ValueStore } = await import("../src/pointers/value-store.ts");
    const idb = new IDBFactory();
    const mine = await new ValueStore({ idb, budgetBytes: () => 1e9 }).put(new Blob(["a\n1\n2\n"]), { format: "csv", session: "page:9" });
    const bg = loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", debugMode: "off" }, indexedDB: idb, siteGate: true, local: { ml_site_always: ["https://shop.example"] } });
    const page = { tab: { id: 9, url: "https://shop.example/report" }, url: "https://shop.example/report", origin: "https://shop.example", frameId: 0 };
    const ok = plain(await bg.send({ type: "VALUE_COLUMNS", runId: "x", key: mine.key, names: ["a"] }, page));
    assert.equal(ok.error, undefined, JSON.stringify(ok));
    assert.deepEqual(ok.columns.a, [1, 2]);
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "revoke", origin: "https://shop.example" } } }, POPUP);
    const no = plain(await bg.send({ type: "VALUE_COLUMNS", runId: "x", key: mine.key, names: ["a"] }, page));
    assert.match(String(no.error), /^Refused/);
    assert.equal(no.columns, undefined);
});

// --- what a run the worker holds sends its page when it ends: the finish, with nothing of the run ---

const SUMMARY = "SUMMARY-SECRET-6060 the total is 42";

/** Every message the tab was sent that its page's world can read (the shell's own run events go to the content script),
 *  and every re-adopt the worker answered, that carries the run's final answer. */
function summaryReached(w) {
    const sent = w.bg.tabMessages.map(([, m]) => plain(m)).filter((m) => m.type !== "ML_DEBUG_TO_PAGE" && JSON.stringify(m).includes("SUMMARY-SECRET-6060"));
    const adopted = w.adopts.filter((a) => JSON.stringify(a).includes("SUMMARY-SECRET-6060"));
    return [...sent, ...adopted];
}

/** The finish messages the tab was sent for the run. */
const finishes = (w) => w.bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload?.finish).map(([, m]) => plain(m.payload));

test("a page-built run handed over at a navigation onto an unapproved site: its finish carries only the run id, and the run's answer never reaches the page", T, async () => {
    const w = await run({ answer: SUMMARY, calls: [{ name: "navigate", args: { url: UNAPPROVED } }, { name: "scroll", args: {} }] });
    assert.equal(w.driverBodies.length, 3, "the run went through its calls and answered");
    assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker").map((r) => r.reason), ["navigated-to-unapproved-site"]);
    assert.deepEqual(finishes(w), [{ runId: "page-run", finish: true }], "the finish names the run and nothing else");
    assert.deepEqual(summaryReached(w), [], "the run's answer reached the page by no message");
    // The answer still reached the person: the shell's own result event carries it.
    const result = w.bg.tabMessages.map(([, m]) => m).find((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-result" && m.event.id === "page-run");
    assert.equal(result?.event.summary, SUMMARY);
});

test("a page-built run handed over at a revoke of its site: its finish carries only the run id, and the run's answer never reaches the page", T, async () => {
    let bgRef = null;
    const w = await run({ answer: SUMMARY, calls: [{ name: "scroll", args: {} }, { name: "scroll", args: {} }],
        onStart: (bg) => { bgRef = bg; },
        page: async (p) => { if (p.name === "scroll" && bgRef.localStore.ml_site_always.includes(BUILDER_ORIGIN)) await edit(bgRef, POPUP, { op: "revoke", origin: BUILDER_ORIGIN }); return undefined; } });
    assert.equal(w.driverBodies.length, 3);
    assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker").map((r) => r.reason), ["site-revoked"]);
    assert.deepEqual(finishes(w), [{ runId: "page-run", finish: true }], "the finish names the run and nothing else");
    assert.deepEqual(summaryReached(w), [], "the run's answer reached the page by no message");
    assert.match(JSON.stringify(plain(await w.started)), /handed to the extension/, "the page's own START_RUN gets no result either");
});

test("control: a page-built run never handed over gets its answer back on its own START_RUN, and needs no finish", T, async () => {
    const w = await run({ answer: SUMMARY, calls: [{ name: "scroll", args: {} }] });
    const r = plain(await w.started);
    assert.equal(r?.data?.summary, SUMMARY, "the page that built the run is answered with its result");
    assert.deepEqual(finishes(w), [], "the page-side caller ends its own run");
});

// --- a page's START_RUN or RESUME_RUN that wakes the worker, with the run restore slowed ---

test("a page's START_RUN or RESUME_RUN under the id of a run the worker holds, delivered while the worker's run restore is still reading storage, is refused and runs nothing", T, async () => {
    const p = { runId: "held-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: BUILDER_ORIGIN,
        rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } };
    const cases = [];
    for (const type of ["START_RUN", "RESUME_RUN"]) for (const [label, extra] of [["handed over after its last checkpoint", { ml_handed_to_worker: ["held-run"] }], ["built by the worker", null]]) cases.push({ type, label, extra });
    for (const { type, label, extra } of cases) {
        const tasks = [];
        let release;
        const holdRestore = new Promise((r) => { release = r; });
        const snap = { p: extra ? p : { ...p, builtBy: "worker", rebuild: { ...p.rebuild, builtBy: "worker" } }, tabId: 7, messages: [{ role: "user", content: "the person's task" }], version: "9.9.9", ts: Date.now() };
        const bg = loadBackground({
            config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
            siteGate: true, holdRestore, local: { ml_site_always: [BUILDER_ORIGIN], "ml_bgrun_held-run": snap, ...(extra ?? {}) },
            openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
            onFetch: async (call) => { if (call.url.includes("/chat/completions")) tasks.push(JSON.stringify(call.body)); return jsonResponse({ choices: [{ message: { content: "the page took it" } }] }); },
        });
        const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" };
        const payload = type === "START_RUN" ? { ...p, task: "the page's own task", rebuild: p.rebuild } : { runId: "held-run", task: "the page's own task" };
        const answered = bg.send({ type, payload }, sender);
        // The origin gate and the config read finish while the restore is held.
        await sleep(60);
        release();
        const r = plain(await Promise.race([answered, sleep(3000).then(() => "no answer")]));
        assert.match(String(r?.error), /^Refused/, `${type}, ${label}: refused: ${JSON.stringify(r).slice(0, 300)}`);
        assert.ok(!tasks.some((b) => b.includes("the page's own task")), `${type}, ${label}: no model call ran the page's task`);
    }
});

test("control: an approved page's own START_RUN delivered while the restore is held runs once the restore is done", T, async () => {
    let release;
    const holdRestore = new Promise((r) => { release = r; });
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, holdRestore, local: { ml_site_always: [BUILDER_ORIGIN] },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async () => jsonResponse({ choices: [{ message: { content: "ran" } }] }),
    });
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" };
    const answered = bg.send({ type: "START_RUN", payload: { runId: "fresh-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 3, surface: "off", crossOrigin: true,
        rebuild: { toolNames: [], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } }, sender);
    await sleep(60);
    release();
    const r = plain(await Promise.race([answered, sleep(3000).then(() => "no answer")]));
    assert.equal(r?.data?.summary, "ran", JSON.stringify(r).slice(0, 300));
});

test("HALTING: a page's START_RUN and RESUME_RUN while the run restore never finishes are refused within the bound, and run nothing", T, async () => {
    // Closed, not open: judged against the empty maps a run the worker holds would read as nobody's.
    const chats = [];
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, holdRestore: new Promise(() => {}), local: { ml_site_always: [BUILDER_ORIGIN] },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async (call) => { if (call.url.includes("/chat/completions")) chats.push(call); return jsonResponse({ choices: [{ message: { content: "ran" } }] }); },
    });
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" };
    const start = bg.send({ type: "START_RUN", payload: { runId: "stuck-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 3, surface: "off", crossOrigin: true,
        rebuild: { toolNames: [], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } } }, sender);
    const resume = bg.send({ type: "RESUME_RUN", payload: { runId: "stuck-run", task: "again" } }, sender);
    const within = (p) => Promise.race([p, sleep(15000).then(() => "no answer")]);
    const [s, r] = (await Promise.all([within(start), within(resume)])).map(plain);
    assert.match(String(s?.error), /^Refused for now: the extension is still restoring/, JSON.stringify(s));
    assert.match(String(r?.error), /^Refused for now: the extension is still restoring/, JSON.stringify(r));
    assert.equal(chats.length, 0, "no model call ran");
});

// --- more hand-overs than the store's cap ---

test("more than 200 runs handed over at once: every one stays the worker's across a restart, the oldest included", T, async () => {
    const N = 205;
    const local = { ml_site_always: [BUILDER_ORIGIN] };
    const ids = Array.from({ length: N }, (_, i) => `many-${i}`);
    for (const runId of ids) {
        local[`ml_bgrun_${runId}`] = { p: { runId, task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: BUILDER_ORIGIN,
            rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } }, tabId: 7, messages: [], version: "9.9.9", ts: Date.now() };
    }
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local, openTabs: [{ id: 7, windowId: 3, active: true, url: UNAPPROVED, title: "Elsewhere" }],
    });
    bg.commit(7, { documentId: "doc-elsewhere", url: UNAPPROVED });
    await sleep(100);
    const handed = (await bg.context.__mlRunLog.all()).filter((r) => r.kind === "handed-to-worker").length;
    assert.equal(handed, N, "every run on the tab was handed over");
    const stored = plain(bg.localStore.ml_handed_to_worker);
    assert.equal(stored.length, N, `the store keeps every run the worker holds: ${stored.length}`);
    assert.ok(stored.includes("many-0"), "the oldest hand-over is kept");
    // The restart, on the builder's approved page: the first run handed over is refused to it.
    const calls = [];
    const bg2 = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: plain(bg.localStore), openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
        onFetch: async (call) => { calls.push(call.url); return jsonResponse({ choices: [{ message: { content: "page took it" } }] }); },
    });
    await sleep(50);
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-back" };
    const r = plain(await Promise.race([bg2.send({ type: "RESUME_RUN", payload: { runId: "many-0", task: "mine again" } }, sender), sleep(2000).then(() => "no answer")]));
    assert.match(String(r?.error), /Refused/, `the page's resume of the oldest hand-over was refused: ${JSON.stringify(r)}`);
    assert.ok(!calls.some((u) => u.includes("/chat/completions")));
});

// --- the eviction seam forgets what a real eviction forgets ---

test("after __mlEvictForTest the hand-overs held in memory are gone, as after an eviction: a run handed over again is stored again", T, async () => {
    const p = { runId: "evict-run", task: "t", systemPrompt: "s", tools: [], model: "text-driver", think: null, maxSteps: 5, surface: "off", crossOrigin: true, pageUrl: BUILDER, pageOrigin: BUILDER_ORIGIN,
        rebuild: { toolNames: ["scroll"], model: "text-driver", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true } };
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "text-driver", apiFormat: "openai", debugMode: "off" },
        siteGate: true, local: { ml_site_always: [BUILDER_ORIGIN], "ml_bgrun_evict-run": { p, tabId: 7, messages: [], version: "9.9.9", ts: Date.now() }, ml_handed_to_worker: ["evict-run"] },
        openTabs: [{ id: 7, windowId: 3, active: true, url: BUILDER, title: "Builder" }],
    });
    await sleep(30);
    const sender = { tab: { id: 7, url: BUILDER }, url: BUILDER, origin: BUILDER_ORIGIN, frameId: 0, documentId: "doc-b" };
    const resume = async () => plain(await Promise.race([bg.send({ type: "RESUME_RUN", payload: { runId: "evict-run", task: "x" } }, sender), sleep(2000).then(() => "no answer")]));
    assert.match(String((await resume())?.error), /Refused/, "control: restored as the worker's from the stored hand-over");
    // Storage loses the hand-over; the eviction then keeps only what storage holds, so the run restores as its page's.
    delete bg.localStore.ml_handed_to_worker;
    await bg.context.__mlEvictForTest();
    // The tab moves to an unapproved site: the run is handed over again, and that is stored, as on a worker that never
    // knew of the first hand-over.
    bg.commit(7, { documentId: "doc-elsewhere", url: UNAPPROVED });
    await sleep(50);
    assert.deepEqual(plain(bg.localStore.ml_handed_to_worker), ["evict-run"], "the second hand-over was stored");
});

test("the vm's chrome.storage.local hands out and keeps copies on every read and write, as the browser does, so a worker that changes what it read or wrote changes nothing stored", T, async () => {
    // The harness fix in #625 copied only get(null). A get by key or a set that shares objects with the store lets the
    // worker change storage by mutating them, which the browser never does, and a test then passes on state no
    // browser would keep.
    const bg = loadBackground({ local: { ml_probe: { n: 1, list: ["a"] } } });
    const local = bg.context.chrome.storage.local;
    for (const read of [() => local.get("ml_probe"), () => local.get(["ml_probe"]), () => local.get({ ml_probe: null }), () => local.get(null)]) {
        const got = await read();
        got.ml_probe.n = 99; got.ml_probe.list.push("mutated");
    }
    const written = { n: 2, list: ["b"] };
    await local.set({ ml_written: written });
    written.n = 99; written.list.push("mutated");
    assert.deepEqual(plain(bg.localStore.ml_probe), { n: 1, list: ["a"] }, "a read's object is not the stored one");
    assert.deepEqual(plain(bg.localStore.ml_written), { n: 2, list: ["b"] }, "a write's object is not the stored one");
});

// --- a handed-over run's stored values ---

test("control: a page-built run handed to the worker keeps the stored value it held from its page: its python_exec, the worker's now, reads it", T, async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const { ValueStore } = await import("../src/pointers/value-store.ts");
    const idb = new IDBFactory();
    const store = new ValueStore({ idb, budgetBytes: () => 1e9 });
    // What the builder page's own fetch stored and disclosed to its tab (sw-fetch-url.ts).
    const { key } = await store.put(new Blob(["a\n1\n2\n"]), { format: "csv", session: "page:7" });
    const w = await run({
        idb, tools: ["navigate", "probe", "python_exec"], payload: { toolTokens: true },
        calls: [
            { name: "probe", args: { token: "orders" } },
            { name: "navigate", args: { url: UNAPPROVED } },
            { name: "python_exec", args: { code: "df", tables: { df: '@tool:"orders"' } } },
        ],
        page: (p) => (p.name === "probe" ? { result: "ran", renderOut: { type: "table", columns: ["a"], rows: [[1]], rowCount: 2, value: key } } : undefined),
        onPyRun: (m) => (m.type === "PY_RUN" ? { ok: true, stdout: "", value: null } : { ok: true, prewarm: "started" }),
    });
    assert.equal(w.driverBodies.length, 4, JSON.stringify(w.results()));
    assert.deepEqual((await w.log()).filter((r) => r.kind === "handed-to-worker").map((r) => r.reason), ["navigated-to-unapproved-site"]);
    assert.ok(!w.calls().some((p) => p.name === "python_exec"), "the python_exec ran in the worker, not on the unapproved page");
    assert.deepEqual((await store.rows()).find((r) => r.key === key)?.sessions, ["page-run"], "the run's claim outlived the page's, which went with its document");
    const handed = w.bg.pyRuns.filter((m) => m.type === "PY_RUN").map((m) => JSON.stringify(m.tables ?? []));
    assert.ok(handed.some((t) => t.includes(key)), `the worker's sandbox was handed the run's stored value: ${handed} / ${w.results().at(-1)}`);
});
