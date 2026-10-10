// redteam-page-run-builtby.test.mjs — what a page's own START_RUN may say about its run (src/sw/sw-run-host.ts
// `startBackgroundRun`): `builtBy`, `rebuild.builtBy` and `display` are the worker's to set, and only its own `hostRun`
// call (sw-run-start.ts) sets them; `pageOrigin`/`pageUrl` are the browser's (the sender), never the payload's; and
// `approvalRouting` changes only where the run's gates are shown, never whether they block.
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
const REBUILD = { toolNames: ["navigate", "fetch_url", "click"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: true };
const TOOLS = [
    { name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] },
    { name: "fetch_url", description: "fetch", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] },
    { name: "click", description: "click", parameters: { type: "object", properties: { selector: { type: "string" } } }, requiresApproval: false, capabilities: [] },
];

/**
 * A page on tab 7 starts its OWN run with `extra` merged into the START_RUN payload. The model calls `calls` in turn
 * (every gate the UI shows approved, unless `approve` is false), then answers. Returns what reached the page, what the
 * worker fetched itself, each gate the run raised (`{ tool, url, ui }`), and the worker.
 */
async function pageRun(extra, calls, { approve = true } = {}) {
    let turns = 0, bg;
    const gates = [];
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
            const ev = msg.type === "ML_DEBUG_TO_PAGE" ? msg.event : null;
            if (ev?.pending && (ev.awaitingApproval || ev.approvalExternal)) gates.push({ tool: ev.tool, url: ev.arguments?.url, ui: !!ev.awaitingApproval, seq: ev.seq });
            if (approve && ev?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } });
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
    return { bg, toPage, workerFetched, gates };
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

// --- the page's origin is the browser's, never the payload's ---

const BANK = "https://bank.example";
/** The gates one call raises in a fresh page run started with `extra` (one call per run: a navigate waits on the page). */
const gatesFor = async (extra, call) => (await pageRun(extra, [call])).gates.map((g) => `${g.tool} ${g.url}`);

test("a run on its own page has its own origin consented: a same-site navigate and fetch_url raise no gate, another site's do", T, async () => {
    // With and without the page naming its origin: the consent comes from the sender either way.
    for (const extra of [{ crossOrigin: true, pageOrigin: "https://site.example" }, { crossOrigin: true, pageOrigin: undefined }]) {
        const label = `pageOrigin ${JSON.stringify(extra.pageOrigin ?? null)}`;
        assert.deepEqual(await gatesFor(extra, { name: "navigate", args: { url: "https://site.example/other" } }), [], `${label}: same-site navigate`);
        assert.deepEqual(await gatesFor(extra, { name: "fetch_url", args: { url: "https://site.example/data.json" } }), [], `${label}: same-site fetch_url`);
        assert.deepEqual(await gatesFor(extra, { name: "navigate", args: { url: `${BANK}/inbox` } }), [`navigate ${BANK}/inbox`], `${label}: another site`);
    }
});

test("a page START_RUN naming another origin as pageOrigin gets no free navigate or fetch_url there: each is gated", T, async () => {
    const forged = { crossOrigin: true, pageOrigin: BANK };
    assert.deepEqual(await gatesFor(forged, { name: "navigate", args: { url: `${BANK}/inbox` } }), [`navigate ${BANK}/inbox`], "a navigate to the claimed origin went through without the person");
    assert.deepEqual(await gatesFor(forged, { name: "fetch_url", args: { url: `${BANK}/statement.csv` } }), [`fetch_url ${BANK}/statement.csv`], "a fetch_url of the claimed origin went through without the person");
});

test("a page START_RUN naming another page as pageUrl gets no free as-you fetch_url of it: it is gated", T, async () => {
    const forged = { crossOrigin: true, pageOrigin: BANK, pageUrl: `${BANK}/inbox` };
    assert.deepEqual(await gatesFor(forged, { name: "fetch_url", args: { url: `${BANK}/inbox`, credentials: true } }), [`fetch_url ${BANK}/inbox`], "a credentialed read of the claimed page went through without the person");
});

// --- approvalRouting: where a page's run's gates are shown, never whether they block ---

/** Every type a page can post, each with a payload aimed at the gate `g` of run pagerun9. */
async function pageTriesToResolve(bg, g) {
    const { PAGE_STARTED_TYPES } = require("../src/page-relay.ts");
    const payload = { runId: "pagerun9", seq: g.seq, decision: true, approved: true, key: `pagerun9:${g.seq}`, hash: "pagerun9" };
    for (const type of PAGE_STARTED_TYPES) {
        // A new turn, or the page stopping its own run (which it may): neither is an answer to this turn's gate.
        if (type === "START_RUN" || type === "RESUME_RUN" || type === "PAGE_CANCEL_RUN") continue;
        await Promise.race([bg.send({ type, payload: { ...payload } }, fromPage).catch(() => {}), flush(4)]);
    }
    await flush(30);
}

test("a page run with approvalRouting \"external\": its gate still blocks, nothing the page posts resolves it, and only the worker's channel does", T, async () => {
    const r = await pageRun({ crossOrigin: true, approvalRouting: "external" }, [{ name: "navigate", args: { url: `${BANK}/inbox` } }]);
    assert.equal(r.gates.length, 1, "the cross-origin navigate is gated");
    assert.equal(r.gates[0].ui, false, "the UI buttons are suppressed: that much the page may choose");
    const ran = () => r.bg.tabMessages.some(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "navigate" && !m.payload.renderOnly && !m.payload.precheck);
    assert.equal(ran(), false, "the navigate did not run before anyone decided");
    await pageTriesToResolve(r.bg, r.gates[0]);
    assert.equal(ran(), false, "a page-posted message resolved the gate");
    const listed = JSON.parse(JSON.stringify(r.bg.context.__mlApprovals.list()));   // the worker realm's array, by value
    assert.deepEqual(listed.map((d) => d.key), [`pagerun9:${r.gates[0].seq}`], "the gate waits on the worker-realm channel");
    assert.equal(r.bg.context.__mlApprovals.resolve(listed[0].key, true), true);
    await flush(60);
    assert.equal(ran(), true, "positive control: the channel's approval runs it");
});

test("approvalRouting from a page: \"both\" and an unknown value still show and block the gate; \"ui\" keeps it off the external channel", T, async () => {
    for (const approvalRouting of ["both", "auto", "none", "ui"]) {
        const r = await pageRun({ crossOrigin: true, approvalRouting }, [{ name: "navigate", args: { url: `${BANK}/inbox` } }], { approve: false });
        assert.equal(r.gates.length, 1, `${approvalRouting}: gated`);
        assert.equal(r.gates[0].ui, true, `${approvalRouting}: the person sees the buttons`);
        const ran = r.bg.tabMessages.some(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "navigate" && !m.payload.renderOnly && !m.payload.precheck);
        assert.equal(ran, false, `${approvalRouting}: blocked until decided`);
        await pageTriesToResolve(r.bg, r.gates[0]);
        assert.equal(r.bg.tabMessages.some(([, m]) => m.type === "RUN_TOOL_IN_PAGE" && m.payload.name === "navigate" && !m.payload.renderOnly && !m.payload.precheck), false, `${approvalRouting}: a page message resolved it`);
        assert.equal(r.bg.context.__mlApprovals.list().length, approvalRouting === "both" ? 1 : 0, `${approvalRouting}: on the external channel only when opted in`);
    }
});
