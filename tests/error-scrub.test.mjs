// error-scrub.test.mjs — the configured server URL, the API key and the model filter never reach a page or the model
// through an error's text (src/secret-scrub.ts, scrubbed where the worker answers a page and where a tool result
// enters a run's model context). The person's own surfaces (the popup, the DevTools panel, the run log's `key`) keep
// the full text.
//
// The page-facing half ENUMERATES every page-started message type (page-relay.ts) under each way the backend can
// fail, rather than sampling a few: a type added to HANDLE_MAP is covered by this file without being edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { PAGE_STARTED_TYPES } = await import("../src/page-relay.ts");
const { scrubSecrets, secretsOf, scrubErrors } = await import("../src/secret-scrub.ts");

const T = { timeout: 30000 };
const URL_ = "http://secret-box.example:4123/api/chat/completions";
const ORIGIN = "http://secret-box.example:4123";
const KEY = "sk-DISTINCTIVE-KEY-4b1d";
const FILTER = "^(default|allowed)-model$";
const PRICES = "http://price-box.example:3002";
const config = { chatUrl: URL_, apiKey: KEY, model: "default-model", apiFormat: "openai", ocrModel: "", modelFilter: FILTER, priceSnapshotUrl: PRICES, debugMode: "off" };
/** What must never be in page- or model-facing text: each secret, and the forms an error writes it in. */
const LEAKS = [URL_, ORIGIN, "secret-box.example", KEY, FILTER, PRICES, "price-box.example"];
const leaksIn = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v) ?? ""; return LEAKS.filter((x) => s.includes(x)); };

const PAGE = { tab: { id: 7, url: "https://site.example/page" }, url: "https://site.example/page", origin: "https://site.example", frameId: 0 };
const POPUP = { url: "chrome-extension://test/popup.html" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A 500 whose body echoes the request's secrets back, as a misconfigured proxy or a verbose server can. */
const echo500 = () => ({ ok: false, status: 500, headers: { get: () => "application/json" }, json: async () => ({}),
    text: async () => JSON.stringify({ detail: `bad bearer ${KEY} for ${URL_} (filter ${FILTER}, prices ${PRICES})` }) });
const modelList = () => jsonResponse({ data: [{ id: "default-model" }, { id: "blocked-model" }] });

/** The ways the backend fails, each one an error whose raw text names a secret. */
const BACKENDS = {
    down: () => { throw new TypeError("Failed to fetch"); },
    echo500: () => echo500(),
    // Reachable; a request naming a model outside the filter is refused with the filter in the message.
    filtered: (call) => call.url.endsWith("/api/models") ? modelList() : jsonResponse({ choices: [{ message: { content: "ok" } }] }),
};

/** A payload that takes each type as far toward the backend as it goes, naming `model`; everything else gets an empty
 *  one. Each type is sent twice: with a model the filter refuses, and with one it allows, which reaches the network. */
const payloadFor = (type, model) => ({
    FETCH_LLM: { messages: [{ role: "user", content: "hi" }], model },
    SET_MODEL: { model },
    MODEL_CAPS: { model },
    EMBED: { inputs: ["x"], model },
    OLLAMA_UNLOAD: { models: [model] },
    START_RUN: { runId: `scrub-run-${model}`, task: "t", systemPrompt: "s", tools: [], model, surface: "off" },
    RESUME_RUN: { runId: `scrub-run-${model}`, task: "t" },
    SERVER_TOOL_EXEC: { toolId: "t", name: "f", args: {} },
})[type] ?? {};
/** Types whose handler reaches the backend under every failure, so each MUST answer with an error: the guard that
 *  the enumeration below is not passing because nothing failed. */
const MUST_ERR = ["FETCH_LLM", "SET_MODEL", "START_RUN"];

// --- the scrub itself (pure) ---

test("scrubSecrets replaces the URL in every form an error writes it, the key, and the filter; text without them is unchanged", () => {
    const s = secretsOf(config);
    const raw = `Couldn't reach the server at ${URL_}. HTTP 500 from ${ORIGIN}/api/models. Could not reach an Ollama API behind ${ORIGIN}. key ${KEY}. blocked by the model filter (/${FILTER}/). prices ${PRICES}/snap`;
    const out = scrubSecrets(raw, s);
    assert.deepEqual(leaksIn(out), [], out);
    assert.match(out, /\[server\]/);
    assert.equal(scrubSecrets("Model \"x\" does not support image input", s), "Model \"x\" does not support image input");
});

test("an empty config scrubs nothing, and a short filter that is a plain word is not stripped from model names", () => {
    assert.equal(scrubSecrets("HTTP 500 from http://localhost:3000", secretsOf({})), "HTTP 500 from http://localhost:3000");
    const out = scrubSecrets("Model \"qwen3\" is blocked by the model filter (/qwen/).", secretsOf({ modelFilter: "qwen" }));
    assert.match(out, /Model "qwen3"/, "the model's own name stays");
    assert.doesNotMatch(out, /\/qwen\//, "the filter's own form is gone");
});

test("scrubErrors rewrites every `error` string in a response, at any depth, and leaves data alone", () => {
    const s = secretsOf(config);
    const r = scrubErrors({ error: `at ${URL_}`, data: { url: URL_, result: { error: `key ${KEY}` }, list: [{ error: FILTER }] } }, s);
    assert.deepEqual(leaksIn(r.error), []);
    assert.deepEqual(leaksIn(r.data.result.error), []);
    assert.deepEqual(leaksIn(r.data.list[0].error), []);
    assert.equal(r.data.url, URL_, "a data field is the handler's answer, not an error");
});

// --- every page-started type, under every way the backend fails ---

for (const [name, onFetch] of Object.entries(BACKENDS)) {
    test(`page: every page-started message type answers an approved page without the URL, key or filter (backend ${name})`, T, async () => {
        const bg = loadBackground({ config, onFetch, openTabs: [PAGE.tab], onTabMessage: async (_t, m) => (m.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : m.type === "RUN_TOOL_IN_PAGE" ? { result: "" } : undefined) });
        const leaked = [], errored = new Set();
        for (const type of PAGE_STARTED_TYPES) for (const model of ["blocked-model", "default-model"]) {
            const res = await Promise.race([
                bg.send({ type, requestId: `r-${type}`, payload: payloadFor(type, model) }, structuredClone(PAGE)),
                new Promise((r) => setTimeout(() => r("(no answer)"), 3000)),
            ]);
            if (res && typeof res === "object" && "error" in res) errored.add(type);
            const found = leaksIn(res);
            if (found.length) leaked.push(`${type} (${model}): ${found.join(", ")} in ${JSON.stringify(res).slice(0, 300)}`);
        }
        assert.deepEqual(leaked, [], "no page-facing answer names a secret");
        for (const t of MUST_ERR) assert.ok(errored.has(t), `${t} reached the failing backend and answered with an error (not vacuous)`);
    });
}

test("page: the streaming port's error names no secret (LLM_STREAM)", T, async () => {
    for (const [name, onFetch] of Object.entries(BACKENDS)) {
        const bg = loadBackground({ config, onFetch });
        const port = bg.connect("LLM_STREAM", structuredClone(PAGE));
        port.send({ payload: { messages: [{ role: "user", content: "hi" }], model: "blocked-model" } });
        for (let i = 0; i < 200 && !port.messages.some((m) => m.type === "error" || m.type === "done"); i++) await flush();
        const err = port.messages.find((m) => m.type === "error");
        assert.ok(err, `${name}: the stream failed`);
        assert.deepEqual(leaksIn(err), [], `${name}: ${JSON.stringify(err)}`);
    }
});

test("page: SET_MODEL's unknown-model error does not list the models the filter hides", T, async () => {
    const bg = loadBackground({ config, onFetch: BACKENDS.filtered });
    const res = await bg.send({ type: "SET_MODEL", payload: { model: "nope" } }, structuredClone(PAGE));
    assert.match(res.error, /Unknown model "nope"/);
    assert.doesNotMatch(res.error, /blocked-model/, res.error);
});

// --- the person's own surfaces keep the full text (positive control) ---

test("control: the popup (an extension page) still reads the real URL in the same error", T, async () => {
    const bg = loadBackground({ config, onFetch: BACKENDS.down });
    const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "default-model" } }, POPUP);
    assert.ok(res.error?.includes(URL_), `the person's diagnostic surface names the server: ${res.error}`);
    const filtered = loadBackground({ config, onFetch: BACKENDS.filtered });
    const f = await filtered.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "blocked-model" } }, POPUP);
    assert.ok(f.error?.includes(FILTER), `and the filter: ${f.error}`);
});

// --- the model: a tool result in a worker-built run ---

const SITE = { id: 7, url: "https://site.example/page", title: "Site" };

/** A worker-built run whose model calls fetch_url with an `ask`, the reader's call failing with `reader`. Returns the
 *  tool result the model read, and the run's execution log. */
async function readerFails(reader) {
    let turns = 0, bg;
    const seenByModel = [];
    bg = loadBackground({
        config: { ...config, autoApproveReadonly: true }, openTabs: [SITE],
        onFetch: (call) => {
            if (call.url.startsWith("https://other.example/")) return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => "<h1>doc</h1>", arrayBuffer: async () => new TextEncoder().encode("<h1>doc</h1>").buffer, body: null };
            if (call.url.endsWith("/api/models")) return modelList();
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const msgs = call.body.messages;
            if (msgs.length === 1 && /Question:/.test(msgs[0].content)) return reader(call);
            seenByModel.push(msgs);
            return turns++ === 0
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: "https://other.example/doc", ask: "what?" }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            return { result: "" };
        },
    });
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    for (let i = 0; i < 600 && turns < 2; i++) await flush(2);
    await flush(30);
    const toolResult = (seenByModel.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    const log = await bg.send({ type: "DUMP_RUN_LOG", payload: { run: hash } }, POPUP);
    return { toolResult, log };
}

test("model: a tool whose model call failed hands the model no URL, key or filter, under every failure", T, async () => {
    const readers = { down: BACKENDS.down, echo500: BACKENDS.echo500, filtered: () => { throw new Error(`blocked by the model filter (/${FILTER}/) at ${URL_}`); } };
    for (const [name, reader] of Object.entries(readers)) {
        const { toolResult } = await readerFails(reader);
        assert.match(toolResult, /\S/, `${name}: the model got a result`);
        assert.deepEqual(leaksIn(toolResult), [], `${name}: ${toolResult.slice(0, 400)}`);
    }
});

test("control: the run's execution log keeps the raw text for the person, in its human-only key", T, async () => {
    const { log } = await readerFails(BACKENDS.down);
    const scrubbed = (log?.data?.events ?? []).filter((r) => r.kind === "scrubbed");
    assert.ok(scrubbed.length, `a scrubbed record was written: ${JSON.stringify(log).slice(0, 400)}`);
    assert.ok(scrubbed.some((r) => (r.key ?? "").includes(URL_)), "its key holds the real URL");
});
