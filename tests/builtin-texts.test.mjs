// builtin-texts.test.mjs — a page-built run's builtin tools given the extension's texts (src/sw/builtin-texts.ts): the
// descriptions change, the schema's parameters never do, whatever a parameter is named.
import { test } from "node:test";
import assert from "node:assert/strict";

const { builtinTexts, withOurTexts } = await import("../src/sw/builtin-texts.ts");

// --- the schema keeps its parameters ---

test("every builtin keeps every parameter, its title included, and every required name is a parameter", () => {
    const texts = builtinTexts("https://example.com/", { docs: true, toolTokens: true, crossOrigin: true });
    assert.ok(texts.has("locate"), "locate is built here");
    const page = [...texts].map(([name, t]) => ({ name, description: "the page's words", parameters: t.parameters }));
    for (const t of withOurTexts(page, texts)) {
        const ours = Object.keys(texts.get(t.name).parameters?.properties ?? {});
        const props = Object.keys(t.parameters?.properties ?? {});
        assert.deepEqual(props, ours, `${t.name}: parameters`);
        for (const r of t.parameters?.required ?? []) assert.ok(props.includes(r), `${t.name}: required ${r} is not a parameter`);
    }
});

test("a parameter NAMED description or title stays, with the extension's description; the keyword is replaced", () => {
    const schema = (d) => ({
        type: "object", description: d,
        properties: { description: { type: "string", description: d }, title: { type: "string", description: d }, n: { type: "integer" } },
        required: ["description"],
    });
    const texts = new Map([["locate", { description: "ours", parameters: schema("ours") }]]);
    const [t] = withOurTexts([{ name: "locate", description: "page", parameters: schema("page") }], texts);
    assert.deepEqual(t.parameters, schema("ours"));
});

test("a parameter only the page's schema has loses its description, and keeps its place", () => {
    const texts = new Map([["locate", { description: "ours", parameters: { type: "object", properties: { a: { type: "string", description: "ours" } } } }]]);
    const page = { type: "object", properties: { a: { type: "string", description: "page" }, extra: { type: "string", description: "page" } } };
    const [t] = withOurTexts([{ name: "locate", description: "page", parameters: page }], texts);
    assert.deepEqual(t.parameters, { type: "object", properties: { a: { type: "string", description: "ours" }, extra: { type: "string" } } });
});

// --- the run's record carries the texts the model was sent (#968) ---
// On the overlay and DevTools surfaces the page emits a page-built run's `agent` start, with the page's tool texts; the
// worker then rewrites them before the model sees them. The session's config (tool cards, Markdown and JSON exports)
// must say what the wire said.

test("a page-built run's exported config.tools carry the descriptions and schema sent to the model, on every surface", { timeout: 20_000 }, async () => {
    const { createRequire } = await import("node:module");
    const { jsonResponse, loadBackground } = createRequire(import.meta.url)("./helpers");
    await import("./stub-css.mjs");
    const { onDebug } = await import("../src/sidebar/debug-reducer.ts");
    const { sessionMap, config } = await import("../src/sidebar/store.ts");
    const { sessionToJson } = await import("../src/sidebar/export/export-json.ts");
    const { serializeSession } = await import("../src/sidebar/export/export.ts");
    const SITE_URL = "https://site.example/page";
    const sender = { tab: { id: 7, url: SITE_URL }, url: SITE_URL, origin: "https://site.example", frameId: 0, documentId: "doc-7" };
    // A site tool named like a builtin: the worker gives it the extension's description and parameter texts.
    const pageTools = [{ name: "click", description: "the site's own click", requiresApproval: false, capabilities: [],
        parameters: { type: "object", description: "the site's schema", properties: { selector: { type: "string", description: "the site's selector" } } } }];
    for (const surface of ["off", "overlay", "devtools"]) {
        const runId = `wire-${surface}`;
        const bg = loadBackground({
            config: { chatUrl: "http://host/api/chat/completions", apiKey: "k", model: "m", apiFormat: "openai", ocrModel: "", debugMode: surface },
            siteGate: true, local: { ml_site_always: ["https://site.example"] }, openTabs: [{ id: 7, url: SITE_URL, title: "Site" }],
            onFetch: (call) => (call.url.includes("/chat/completions") ? jsonResponse({ choices: [{ message: { content: "done" } }] }) : jsonResponse({})),
            onTabMessage: async (_t, msg) => (msg.type === "RUN_TOOL_IN_PAGE" ? { result: "" } : undefined),
        });
        const payload = { runId, task: "do it", systemPrompt: "S", tools: structuredClone(pageTools), model: "m", think: null, maxSteps: 3,
            autoApprovePython: false, autoApproveReadonly: false, surface, pageUrl: SITE_URL };
        // The page's own start event (ml-agent-run.ts), which the overlay and DevTools surfaces receive from the page.
        const pageStart = { kind: "agent", id: runId, ts: 1, save: false, session: { hash: runId, turn: 0 }, task: "do it", model: "m", maxSteps: 3,
            config: { system: "S", customSystem: false, maxSteps: 3, think: null, env: true, vision: null, systemAppend: null,
                tools: pageTools.map((t) => ({ name: t.name, requiresApproval: false, vision: false, description: t.description, parameters: t.parameters })) } };
        const res = await bg.send({ type: "START_RUN", payload }, sender);
        assert.equal(res?.data?.summary, "done", `${surface}: the run answered (${JSON.stringify(res)?.slice(0, 200)})`);
        const body = bg.calls.find((c) => c.url.includes("/chat/completions")).body;
        const wire = body.tools.map((t) => t.function).find((f) => f.name === "click");
        assert.notEqual(wire.description, "the site's own click", `${surface}: the worker rewrote the description`);
        const worker = bg.tabMessages.map(([, m]) => m).filter((m) => m?.type === "ML_DEBUG_TO_PAGE").map((m) => m.event);
        sessionMap.clear();
        if (surface !== "off") onDebug(pageStart);
        for (const ev of worker) onDebug(ev);
        const s = sessionMap.get(runId);
        const tool = sessionToJson(s).session.config.tools.find((t) => t.name === "click");
        assert.equal(tool.description, wire.description, `${surface}: the JSON export's description is the wire's`);
        assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), JSON.parse(JSON.stringify(wire.parameters)), `${surface}: the JSON export's schema is the wire's`);
        assert.equal(sessionToJson(s).session.config.system, body.messages.find((m) => m.role === "system").content, `${surface}: and the system prompt is the wire's`);
        config.value = { ...config.value, exportToolDefs: true };
        const { md } = serializeSession(s);
        assert.ok(md.includes(JSON.stringify(wire.description).slice(1, -1)), `${surface}: the Markdown export carries the wire's description`);
        assert.ok(!md.includes("the site's own click") && !md.includes("the site's selector"), `${surface}: and not the page's texts`);
    }
});
