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
const { runAgentLoop } = await import("../src/agent/agent-loop.ts");

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

// --- the model: every way a step of the shared loop produces text goes through forModel once ---

test("loop: whatever a step produced (a result, a throw, a read-only try, a precheck, a gate that threw, a denial), the model, transcript and log read it through forModel", async () => {
    const secret = `HTTP 500 from ${URL_}`;
    const boom = () => { throw new Error(secret); };
    const danger = { name: "danger", requiresApproval: true };
    const cases = {
        run: { runTool: async () => ({ result: secret }) },
        "run throws": { runTool: async () => boom() },
        readonly: { tryReadonly: async () => ({ result: secret }) },
        precheck: { precheck: async () => secret },
        "approve throws": { approve: async () => boom() },
        denied: { approve: async () => ({ approved: false, feedback: secret }) },
    };
    for (const [name, over] of Object.entries(cases)) {
        let turn = 0;
        const pushed = [], emitted = [], scrubbed = [];
        const deps = {
            callModel: async () => (turn++ === 0 ? { content: "", tool_calls: [{ id: "c1", name: "danger", arguments: {} }] } : { content: "done", tool_calls: [] }),
            runTool: async () => ({ result: "ok" }),
            approve: async () => true,
            autoApprove: () => null,
            buildMessages: (task) => [{ role: "user", content: task }],
            pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
            pushToolResult: (m, call, result) => { pushed.push(result); m.push({ role: "tool", tool_call_id: call.id, content: result }); },
            emit: (ev) => { if (ev.result != null) emitted.push(ev.result); },
            forModel: async (tool, text) => { scrubbed.push(tool); return scrubSecrets(text, secretsOf(config)); },
            ...over,
        };
        const res = await runAgentLoop("x", { tools: [danger] }, deps);
        assert.deepEqual(scrubbed, ["danger"], `${name}: one crossing per step`);
        assert.deepEqual(leaksIn([pushed, emitted, res.transcript]), [], `${name}: ${JSON.stringify(pushed)}`);
        assert.match(pushed[0], /\[server\]/, `${name}: the model read the scrubbed text`);
    }
});

// --- the forms a secret takes in text the worker did not write itself (a backend's body, a resolver's message) ---

/** The needles still present in `text` once scrubbed under `cfg`. */
const leftIn = (text, cfg, needles) => { const out = scrubSecrets(text, secretsOf(cfg)); return needles.filter((n) => (n instanceof RegExp ? n.test(out) : out.includes(n))); };

test("form: a configured port does not shield the bare host name", () => {
    assert.deepEqual(leftIn("getaddrinfo ENOTFOUND secret-box.example; Host: secret-box.example", { chatUrl: URL_ }, ["secret-box.example"]), []);
});

test("form: a dotless docker host or a loopback name is not stripped from ordinary text", () => {
    assert.equal(scrubSecrets("ollama ps lists qwen3 on the ollama box", secretsOf({ chatUrl: "http://ollama:11434" })), "ollama ps lists qwen3 on the ollama box");
    assert.equal(scrubSecrets("serve it on localhost", secretsOf({ chatUrl: "http://localhost:3000/api/chat/completions" })), "serve it on localhost");
});

test("form: an IPv6 host is scrubbed with and without its brackets", () => {
    const cfg = { chatUrl: "http://[fd00:1234::7]:8080/api/chat/completions" };
    assert.deepEqual(leftIn("connect ECONNREFUSED fd00:1234::7:8080 ([fd00:1234::7])", cfg, ["fd00:1234::7"]), []);
});

test("form: the URL in another letter case is scrubbed", () => {
    assert.deepEqual(leftIn("upstream HTTP://SECRET-BOX.EXAMPLE:4123/x said no", { chatUrl: URL_ }, [/secret-box\.example/i]), []);
});

test("form: the URL percent-encoded (a redirect's query) is scrubbed", () => {
    const text = `302 to /login?next=${encodeURIComponent(URL_)}`;
    assert.deepEqual(leftIn(text, { chatUrl: URL_ }, ["secret-box.example", encodeURIComponent(ORIGIN)]), []);
});

test("form: the URL and a key with a slash, JSON-escaped (`\\/`) or percent-encoded, are scrubbed", () => {
    const key = "sk-ab/cd+ef/0123456789xyz";
    const body = `{"url":"${URL_.replace(/\//g, "\\/")}","auth":"${key.replace(/\//g, "\\/")}","q":"key=${encodeURIComponent(key)}"}`;
    assert.deepEqual(leftIn(body, { chatUrl: URL_, apiKey: key }, ["secret-box.example", "ab\\/cd+ef", "ab%2Fcd%2Bef"]), []);
});

test("form: an internationalized host is scrubbed as configured and as punycode", () => {
    const cfg = { chatUrl: "http://bücher.example:8080/v1/chat/completions" };
    assert.deepEqual(leftIn("Host bücher.example refused; resolved xn--bcher-kva.example", cfg, ["bücher.example", "xn--bcher-kva.example"]), []);
});

test("form: a placeholder key (`ollama`, `EMPTY`, `sk-1234`) does not strip that word from ordinary text", () => {
    for (const apiKey of ["ollama", "EMPTY", "sk-1234", "changeme"]) {
        const text = `ollama run qwen3; EMPTY string; LiteLLM's sk-1234 example; changeme later`;
        assert.equal(scrubSecrets(text, secretsOf({ apiKey })), text, apiKey);
    }
});

test("form: a filter that reads as a model name does not corrupt that model's name, and its error form is still scrubbed", () => {
    const cfg = { modelFilter: "qwen3.5" };
    assert.equal(scrubSecrets("Model \"qwen3.5:9b\" is ready", secretsOf(cfg)), "Model \"qwen3.5:9b\" is ready");
    assert.doesNotMatch(scrubSecrets("blocked by the model filter (/qwen3.5/).", secretsOf(cfg)), /qwen3\.5/);
});

test("form: a one-letter filter does not strip `/a/` out of every path", () => {
    const cfg = { modelFilter: "a" };
    assert.equal(scrubSecrets("see https://x.example/a/b and /a/", secretsOf(cfg)), "see https://x.example/a/b and /a/");
    assert.doesNotMatch(scrubSecrets("blocked by the model filter (/a/).", secretsOf(cfg)), /\(\/a\/\)/);
});

test("form: blank settings scrub nothing (never every empty string)", () => {
    assert.deepEqual(secretsOf({ chatUrl: "  ", apiKey: " ", modelFilter: "", priceSnapshotUrl: "" }), []);
    assert.equal(scrubSecrets("abc", secretsOf({ chatUrl: "  ", apiKey: " " })), "abc");
});

test("form: an 8 MB tool result of near misses scrubs in linear time, under a filter with nested quantifiers", () => {
    const cfg = { ...config, modelFilter: "^(a+)+$" };
    const chunk = "http://secret-box.example:412 sk-DISTINCTIVE-KEY-4b1 (/^(a+)+/) aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa! ";
    const big = chunk.repeat(Math.ceil(8e6 / chunk.length));
    const s = secretsOf(cfg);
    const t0 = performance.now();
    const out = scrubSecrets(big + URL_, s);
    const ms = performance.now() - t0;
    assert.ok(out.endsWith("[server]"));
    assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});

// --- page: the paths and timings around forPage ---

test("page: a secret the 300-character body cut lands inside leaves no prefix of itself", T, async () => {
    for (const [what, secret] of [["key", KEY], ["url", URL_]]) {
        // The worker writes `HTTP 500 from <url>: <body.slice(0, 300)>`; the body places the secret across the cut.
        const body = "x".repeat(300 - 10) + secret + " trailing";
        const bg = loadBackground({ config, onFetch: (call) => (call.url.endsWith("/api/models") ? modelList() : { ok: false, status: 500, headers: { get: () => "text/plain" }, json: async () => ({}), text: async () => body }) });
        const res = await bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "default-model" } }, structuredClone(PAGE));
        assert.ok(res.error, what);
        assert.ok(!res.error.includes(secret.slice(0, 10)), `${what}: ${res.error.slice(-80)}`);
    }
});

test("page: a server tool's transport error (the endpoint's echoed body) names no secret", T, async () => {
    const s = secretsOf(config);
    assert.deepEqual(leaksIn(scrubErrors({ data: { ok: false, transportError: `the tool endpoint returned 500: ${URL_} ${KEY}` } }, s)), []);
    const bg = loadBackground({ config: { ...config, pageApprovalDomains: ["site.example"] }, onFetch: BACKENDS.echo500 });
    const res = await bg.send({ type: "SERVER_TOOL_EXEC", requestId: "st1", payload: { toolId: "t", name: "f", args: {} } }, structuredClone(PAGE));
    assert.match(JSON.stringify(res), /tool endpoint returned 500/, "the call reached the endpoint");
    assert.deepEqual(leaksIn(res), [], JSON.stringify(res).slice(0, 400));
});

test("page: an error written under the old URL is scrubbed after the URL changes mid-request", T, async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const bg = loadBackground({ config, onFetch: async (call) => (call.url.endsWith("/api/models") ? modelList() : (await gate, { ok: false, status: 500, headers: { get: () => "text/plain" }, json: async () => ({}), text: async () => "nope" })) });
    const pending = bg.send({ type: "FETCH_LLM", payload: { messages: [{ role: "user", content: "hi" }], model: "default-model" } }, structuredClone(PAGE));
    await flush(20);
    bg.setSync({ chatUrl: "http://new-box.example:9000/api/chat/completions", apiKey: "sk-ANOTHER-KEY-77aa" });
    release();
    const res = await pending;
    assert.ok(res.error, "the request failed");
    assert.deepEqual(leaksIn(res), [], res.error);
});

// --- the model: what a resumed history carries ---

test("model: a resumed history written before the scrub (a raw URL in a tool result) reaches the model scrubbed", T, async () => {
    const sent = [];
    const bg = loadBackground({ config, onFetch: (call) => {
        if (call.url.endsWith("/api/models")) return modelList();
        sent.push(JSON.stringify(call.body.messages));
        return jsonResponse({ choices: [{ message: { content: "done" } }] });
    } });
    // The shape a session saved by the pre-#620 worker holds: the tool's error text as it was written.
    const old = [
        { role: "system", content: "SYS" },
        { role: "user", content: "read the doc" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: `Error: Couldn't reach the server at ${URL_} (key ${KEY})` },
        { role: "assistant", content: `The server at ${ORIGIN} is down.` },
    ];
    const res = await bg.send({ type: "START_RUN", payload: { runId: "resume-old", task: "again", systemPrompt: "SYS", tools: [], model: "default-model", think: null, maxSteps: 3, surface: "off", resumeMessages: old } }, structuredClone(PAGE));
    assert.ok(res.data, JSON.stringify(res).slice(0, 300));
    assert.ok(sent.length, "the model was called");
    assert.deepEqual(leaksIn(sent), [], sent[0].slice(0, 600));
});
