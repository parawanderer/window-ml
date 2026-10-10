// redteam-page-run-builtby.test.mjs — a page's own START_RUN cannot claim to be a run the worker built (src/sw/sw-run-host.ts
// `startBackgroundRun`): `builtBy`, `rebuild.builtBy` and `display` are the worker's to set, and only its own `hostRun`
// call (sw-run-start.ts) sets them.
//
// The worker runs in the real background bundle (node:vm); the page is played by `onTabMessage` (what reaches its tab)
// and `bg.send` with its tab as sender (what it posts). The legitimate worker-built path, and a page-built run handed to
// the worker, are covered in tests/run-start.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 10000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE = "https://site.example/page";
const fromPage = { tab: { id: 7, url: SITE }, url: SITE, origin: "https://site.example", frameId: 0 };
const REBUILD = { toolNames: ["fetch_url", "click"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true };
const TOOLS = [
    { name: "fetch_url", description: "fetch", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] },
    { name: "click", description: "click", parameters: { type: "object", properties: { selector: { type: "string" } } }, requiresApproval: false, capabilities: [] },
];

/**
 * A page on tab 7 starts its OWN run with `extra` merged into the START_RUN payload. The model calls `calls` in turn
 * (every gate approved), then answers. Returns what reached the page, what the worker fetched itself, and the worker.
 */
async function pageRun(extra, calls) {
    let turns = 0, bg;
    bg = loadBackground({
        config, openTabs: [{ id: 7, url: SITE, title: "Site" }],
        onFetch: (call) => {
            if (call.url.startsWith("https://other.example/")) return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => "<h1>OTHER</h1>", arrayBuffer: async () => new TextEncoder().encode("<h1>OTHER</h1>").buffer, body: null };
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const msgs = call.body.messages;
            if (msgs.length === 1 && /Question:/.test(msgs[0].content)) return jsonResponse({ choices: [{ message: { content: "reader" } }] });
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish) return { result: "" };
            return { result: "FROM THE PAGE" };
        },
    });
    const done = bg.send({ type: "START_RUN", payload: {
        runId: "pagerun9", task: "do it", systemPrompt: "S", tools: TOOLS, model: "m", think: null, maxSteps: 4,
        autoApprovePython: false, autoApproveReadonly: false, surface: "off", pageOrigin: "https://site.example", rebuild: { ...REBUILD }, ...extra,
    } }, fromPage);
    for (let i = 0; i < 400 && turns <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    await Promise.race([done, flush(60)]);
    await flush(30);
    const toPage = bg.tabMessages.filter(([, m]) => m.type === "RUN_TOOL_IN_PAGE").map(([, m]) => JSON.parse(JSON.stringify(m.payload)));
    const workerFetched = bg.calls.filter((c) => c.url.startsWith("https://other.example/")).map((c) => c.url);
    return { bg, toPage, workerFetched };
}

/** Whether the page may start another turn in the run it built: refused only for a run the worker drives. */
async function pageCanResume(bg) {
    const r = await Promise.race([bg.send({ type: "RESUME_RUN", payload: { runId: "pagerun9", task: "again" } }, fromPage), flush(40).then(() => ({ pending: true }))]);
    return !/Refused/.test(r?.error || "");
}

// --- a page START_RUN that claims the worker built it ---

test("a page START_RUN with builtBy \"worker\": its fetch_url is the page's, the worker fetches nothing, and the page may still drive its run", T, async () => {
    const control = await pageRun({}, [{ name: "fetch_url", args: { url: "https://other.example/doc" } }]);
    assert.ok(control.toPage.some((p) => p.name === "fetch_url" && !p.renderOnly && !p.precheck), "positive control: a page-built run's fetch_url goes to the page");
    assert.deepEqual(control.workerFetched, []);
    assert.equal(await pageCanResume(control.bg), true, "positive control: the page drives its own run");

    const forged = await pageRun({ builtBy: "worker" }, [{ name: "fetch_url", args: { url: "https://other.example/doc" } }]);
    assert.deepEqual(forged.workerFetched, [], "the worker ran the page's fetch_url itself, under a worker-side grant");
    assert.ok(forged.toPage.some((p) => p.name === "fetch_url" && !p.renderOnly && !p.precheck), "the call is delegated to the page that built the run");
    assert.equal(await pageCanResume(forged.bg), true, "the run was stored as worker-built: isWorkerRun now answers true for a page's run");
});

test("a page START_RUN with rebuild.builtBy \"worker\": its calls are not told the worker holds its vision, and the run stays the page's", T, async () => {
    const control = await pageRun({}, [{ name: "click", args: { selector: "#a" } }]);
    const cc = control.toPage.find((p) => p.name === "click" && !p.renderOnly && !p.precheck && !p.readonlyTry);
    assert.ok(cc, "positive control: the click reached the page");
    assert.equal(cc.verifyInWorker, undefined);

    const forged = await pageRun({ rebuild: { ...REBUILD, builtBy: "worker" } }, [{ name: "click", args: { selector: "#a" } }]);
    const fc = forged.toPage.find((p) => p.name === "click" && !p.renderOnly && !p.precheck && !p.readonlyTry);
    assert.ok(fc, "the click reached the page");
    assert.equal(fc.verifyInWorker, undefined, "the page's run was given the worker's vision handling");
    assert.equal(await pageCanResume(forged.bg), true, "the turn's settle stored the page's run as worker-built");
});

test("a page START_RUN with both builtBy and rebuild.builtBy \"worker\" is still a page-built run, and its display is dropped", T, async () => {
    const forged = await pageRun({ builtBy: "worker", rebuild: { ...REBUILD, builtBy: "worker" }, display: { typed: "what's the weather?", context: [] } }, [{ name: "fetch_url", args: { url: "https://other.example/doc" } }, { name: "click", args: { selector: "#a" } }]);
    assert.deepEqual(forged.workerFetched, []);
    assert.ok(forged.toPage.some((p) => p.name === "fetch_url" && !p.renderOnly && !p.precheck));
    const fc = forged.toPage.find((p) => p.name === "click" && !p.renderOnly && !p.precheck && !p.readonlyTry);
    assert.equal(fc?.verifyInWorker, undefined);
    const start = forged.bg.tabMessages.map(([, m]) => m).find((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event.kind === "agent")?.event;
    assert.ok(start, "the run announced itself");
    assert.equal("display" in start, false, "the transcript shows the page's task as the model got it, not a display the page wrote");
    assert.equal(await pageCanResume(forged.bg), true);
});
