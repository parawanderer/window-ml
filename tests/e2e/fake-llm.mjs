// fake-llm.mjs — a tiny scriptable stand-in for an OpenWebUI/OpenAI backend, so the E2E harness can drive
// the REAL extension pipeline (background loop → tool delegation → page) deterministically, with no Ollama.
//
// It speaks just enough of the API the extension calls (see background.ts): GET /api/models (the model
// list), POST /api/chat/completions (the scripted turns), GET /api/ps (empty). A spec sets a SCRIPT — an
// ordered list of "what the model does next" — and each chat call pops the next step. A step is one of:
//   { content: "final answer text" }                        → a plain assistant reply (ends the run)
//   { tool: "navigate", args: { url: "/step2" } }           → one tool call (the loop runs it, comes back)
//   (reqBody) => oneOfTheAbove                               → reactive: inspect the conversation so far
// (a function step is how the final answer can echo a value a REAL tool read from the page).
//
// To run the harness against a REAL backend instead, point the extension at it (E2E_BACKEND) and skip
// starting this — see tests/e2e/harness.mjs.

import { createServer } from "node:http";

const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});

// A step spec → an OpenAI-shape assistant choice.
let callSeq = 0;
const toChoice = (step) => {
    if (step && typeof step.tool === "string") {
        return {
            index: 0, finish_reason: "tool_calls",
            message: { role: "assistant", content: "", tool_calls: [
                { id: `call_${++callSeq}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } },
            ] },
        };
    }
    return { index: 0, finish_reason: "stop", message: { role: "assistant", content: (step && step.content) || "" } };
}

// A real OpenAI-shaped backend always reports token usage, so the fake does too — otherwise anything that
// READS usage (the sidebar's meter, the bench's token-cost metric) is exercised only against a real model,
// which is the one place a wrong reading is expensive to discover. Counts are a crude 4-chars-per-token
// estimate over the actual request and reply: not accurate, but proportional to real work and never zero.
function usageFor(body, step) {
    const est = (s) => Math.max(1, Math.ceil(String(s || "").length / 4));
    const prompt = (body.messages || []).reduce((n, m) => n + est(typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")), 0)
        + est(JSON.stringify(body.tools || []));
    const completion = est(step && step.content) + (step && step.tool ? est(JSON.stringify(step.args || {})) : 0);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
};

/**
 * Start the fake backend. Returns { url, origin, setScript, setResident, setCapacity, calls, stop }.
 * - url:       the chatUrl to configure the extension with (…/api/chat/completions)
 * - setScript: (steps: Array<StepOrFn>) => void   — the ordered turns for the NEXT run
 * - calls:     () => object[]                      — every chat request body received (for assertions)
 * @param {{ port?: number, model?: string }} [opts]
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function startFakeLlm({ port = 0, model = "fake-model", streamDelayMs = 0 } = {}) {
    // A scriptable fake BOX as well as a fake model: /api/ps (what is resident) and /api/info (what capacity
    // exists) are what the resource panel polls, and both are settable mid-run so a test or demo can make
    // models load and evict on a timeline. `info: null` reproduces a stock Ollama, which doesn't serve the
    // route at all — the case the panel must degrade for.
    let resident = [];
    let boxInfo = null;
    let script = [];
    let idx = 0;
    const calls = [];
    // Stream a step as SSE (when the request asks for stream:true) — reasoning_content word-by-word, then the
    // content words (or the tool_call whole), then [DONE]. A step's `reasoning` field feeds the thinking channel.
    // `streamDelayMs` paces the words so a test can screenshot MID-stream. Mirrors the OpenAI SSE shape
    // background.ts's streamChunk parses.
    const streamStep = async (res, step) => {
        res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-store" });
        const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-${callSeq}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, ...extra }] })}\n\n`);
        const choice = toChoice(step);
        for (const w of (step.reasoning || "").match(/\S+\s*/g) || []) { send({ reasoning_content: w }); await sleep(streamDelayMs); }
        if (choice.message.tool_calls) {
            send({ tool_calls: choice.message.tool_calls.map((tc, i) => ({ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } })) });
            send({}, { finish_reason: "tool_calls" });
        } else {
            for (const w of (choice.message.content || "").match(/\S+\s*/g) || []) { send({ content: w }); await sleep(streamDelayMs); }
            send({}, { finish_reason: "stop" });
        }
        res.write("data: [DONE]\n\n");
        res.end();
    };

    const server = createServer(async (req, res) => {
        const path = (req.url || "/").split("?")[0];
        if (req.method === "GET" && (path === "/api/models" || path === "/v1/models")) {
            return json(res, 200, { data: [{ id: model, name: model, owned_by: "ollama", connection_type: "local" }] });
        }
        // Both bases findOllamaBase tries: `${origin}/ollama` first, then the origin itself.
        if (req.method === "GET" && (path === "/api/ps" || path === "/ollama/api/ps")) return json(res, 200, { models: resident });
        if (req.method === "GET" && (path === "/api/info" || path === "/ollama/api/info")) {
            // A server without the patch answers this route with the SPA's HTML, not a 404 — reproduce THAT,
            // since "unknown capacity" arriving as unparseable HTML is the case worth exercising.
            if (!boxInfo) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><html><body>app</body></html>"); }
            return json(res, 200, boxInfo);
        }
        if (req.method === "GET" && path === "/api/version") return json(res, 200, { version: "fake" });
        if (req.method === "POST" && (path === "/api/chat/completions" || path === "/v1/chat/completions")) {
            const body = await readBody(req);
            calls.push(body);
            let step = idx < script.length ? script[idx++] : { content: "" };
            if (typeof step === "function") step = step(body) || { content: "" };
            if (body.stream) return streamStep(res, step);
            return json(res, 200, {
                id: `chatcmpl-${callSeq}`, object: "chat.completion", model,
                choices: [toChoice(step)],
                usage: usageFor(body, step),
            });
        }
        json(res, 404, { error: `no fake route for ${req.method} ${path}` });
    });

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
            const realPort = server.address().port;
            const origin = `http://127.0.0.1:${realPort}`;
            resolve({
                url: `${origin}/api/chat/completions`,
                origin,
                setScript: (steps) => { script = steps.slice(); idx = 0; },
                /** What /api/ps reports as resident — raw ollama ps rows (size / size_vram / gpus / …). */
                setResident: (models) => { resident = models; },
                /** What /api/info reports as capacity; null = a server that doesn't serve the route at all. */
                setCapacity: (info) => { boxInfo = info; },
                calls: () => calls.slice(),
                stop: () => new Promise((r) => server.close(r)),
            });
        });
    });
}
