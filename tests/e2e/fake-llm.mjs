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

/**
 * One scripted turn: a plain reply, a tool call, or a function that decides from the conversation so far.
 * This is the contract the e2e specs write against — 14 of them — so it is worth naming rather than
 * leaving each spec to infer it from an example.
 *
 * @typedef {object} FakeStep
 * @property {string} [content] a plain assistant reply, which ends the run
 * @property {string} [tool] call this tool instead of replying
 * @property {Record<string, unknown>} [args] the tool's arguments
 * @property {string} [reasoning] thinking text, streamed word by word when the request asks to stream
 * @property {StreamBeat[]} [emit] STREAMING ONLY: the exact order the turn comes out in, so a test can script
 *   an INTERLEAVED turn — think, start the call, think again, answer. Without it a streamed step emits the
 *   default order (all the reasoning, then the tool call or the content), which is what every existing spec
 *   expects. A `call` beat emits ONE fragment of the tool call; several of them split the arguments across
 *   chunks the way OpenAI actually does, which is what the accumulator has to survive.
 *
 * @typedef {object} StreamBeat
 * @property {"think" | "answer" | "call"} kind which channel this beat comes out on
 * @property {string} [text] the text, for `think` / `answer`
 *
 * @typedef {FakeStep | ((req: any) => FakeStep)} StepOrFn
 */

/** @typedef {import("node:http").ServerResponse} Res */
/** @typedef {import("node:http").IncomingMessage} Req */

/** @param {Res} res @param {number} code @param {unknown} body */
const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
};
/** @param {Req} req @returns {Promise<any>} the JSON body, or `{}` when it is absent or malformed */
const readBody = (req) => new Promise((resolve) => {
    let b = ""; req.on("data", (/** @type {Buffer} */ c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});

// A step spec → an OpenAI-shape assistant choice.
let callSeq = 0;
/** @param {FakeStep} step */
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
/** @param {any} body the chat request @param {FakeStep} step the scripted turn being answered */
function usageFor(body, step) {
    /** @param {unknown} s */
    const est = (s) => Math.max(1, Math.ceil(String(s || "").length / 4));
    const prompt = (body.messages || []).reduce((/** @type {number} */ n, /** @type {any} */ m) => n + est(typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")), 0)
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
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function startFakeLlm({ port = 0, model = "fake-model", streamDelayMs = 0 } = {}) {
    // A scriptable fake BOX as well as a fake model: /api/ps (what is resident) and /api/info (what capacity
    // exists) are what the resource panel polls, and both are settable mid-run so a test or demo can make
    // models load and evict on a timeline. `info: null` reproduces a stock Ollama, which doesn't serve the
    // route at all — the case the panel must degrade for.
    /** @type {any[]} */
    let resident = [];
    /** @type {any} */
    let boxInfo = null;
    // The event stream (a PATCHED ollama only — docs/FORKED-BACKENDS.md). `frames` is what a new subscriber
    // is backfilled with; `pushFrame` sends to everyone connected NOW. Frames go out verbatim, so a fixture
    // captured off the real box exercises the real shapes — fully-qualified model names included, which is
    // exactly what the short names in `/api/ps` have to be reconciled against.
    /** @type {any[]} */
    let frames = [];
    /** @type {Set<import("node:http").ServerResponse>} */
    const streamSubs = new Set();
    let eventsSupported = false;
    /** @type {StepOrFn[]} */
    let script = [];
    let idx = 0;
    /** @type {any[]} */
    const calls = [];
    /** @type {any[]} */
    const toolCalls = [];
    /** @type {any[]} */
    let serverTools = [];
    /** @type {any} */
    let serverToolScript = null;
    // Stream a step as SSE (when the request asks for stream:true) — reasoning_content word-by-word, then the
    // content words (or the tool_call whole), then [DONE]. A step's `reasoning` field feeds the thinking channel.
    // `streamDelayMs` paces the words so a test can screenshot MID-stream. Mirrors the OpenAI SSE shape
    // background.ts's streamChunk parses.
    /** @param {Res} res @param {FakeStep} step @param {any} body */
    const streamStep = async (res, step, body) => {
        res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-store" });
        /** @param {Record<string, unknown>} delta @param {Record<string, unknown>} [extra] */
        const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-${callSeq}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, ...extra }] })}\n\n`);
        const choice = toChoice(step);
        const calls = choice.message.tool_calls;
        if (step.emit) {
            // A SCRIPTED order. The tool call's arguments are split across however many `call` beats there
            // are, so a run that interleaves think → call → think → call is a real fragmented stream and not a
            // single whole call dressed up as one.
            const nCall = step.emit.filter((b) => b.kind === "call").length;
            let sent = 0;
            for (const beat of step.emit) {
                if (beat.kind === "think") send({ reasoning_content: beat.text || "" });
                else if (beat.kind === "answer") send({ content: beat.text || "" });
                else if (calls) {
                    // First fragment carries the id and the name (as OpenAI does); the rest carry argument text.
                    send({ tool_calls: calls.map((tc, i) => {
                        const args = String(tc.function.arguments || "");
                        const size = Math.ceil(args.length / Math.max(1, nCall));
                        return { index: i, ...(sent === 0 ? { id: tc.id, type: "function" } : {}),
                                 function: { ...(sent === 0 ? { name: tc.function.name } : {}), arguments: args.slice(sent * size, (sent + 1) * size) } };
                    }) });
                    sent++;
                }
                await sleep(streamDelayMs);
            }
            send({}, { finish_reason: calls ? "tool_calls" : "stop" });
        } else if (calls) {
            for (const w of (step.reasoning || "").match(/\S+\s*/g) || []) { send({ reasoning_content: w }); await sleep(streamDelayMs); }
            send({ tool_calls: calls.map((tc, i) => ({ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } })) });
            send({}, { finish_reason: "tool_calls" });
        } else {
            for (const w of (step.reasoning || "").match(/\S+\s*/g) || []) { send({ reasoning_content: w }); await sleep(streamDelayMs); }
            for (const w of (choice.message.content || "").match(/\S+\s*/g) || []) { send({ content: w }); await sleep(streamDelayMs); }
            send({}, { finish_reason: "stop" });
        }
        // Token counts ride the final chunk, as OpenWebUI's do. Not decoration: everything the CLIENT measures
        // about a call (its wall clock, and the generation phases) is stamped onto that usage object, so a
        // stream that reports no counts drops our own measurements with them.
        res.write(`data: ${JSON.stringify({ id: `chatcmpl-${callSeq}`, object: "chat.completion.chunk", model, choices: [], usage: usageFor(body, step) })}\n\n`);
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
        if (req.method === "GET" && (path === "/api/events" || path === "/ollama/api/events")) {
            // Unsupported reproduces a STOCK server: OpenWebUI answers an unknown route with the SPA's HTML
            // at 200, never a 404, so "no stream here" has to be read off the content type.
            if (!eventsSupported) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><html><body>app</body></html>"); }
            res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
            // `hello` first, then the retained ring as BACKFILL with negative offsets — every connection
            // anchors on its own hello, so a frame that predates it says so rather than being restamped.
            const since = Number(new URL(req.url || "/", "http://x").searchParams.get("since") || 0);
            const back = frames.filter((f) => !since || -f.t <= since);
            res.write(JSON.stringify({ v: 1, kind: "hello", t: 0, serverTime: new Date().toISOString(), box: "fake-box", retainedMs: 600000, backfilled: back.length }) + "\n");
            for (const f of back) res.write(JSON.stringify(f) + "\n");
            streamSubs.add(res);
            req.on("close", () => streamSubs.delete(res));
            return;
        }
        if (req.method === "GET" && path === "/api/version") return json(res, 200, { version: "fake" });
        // The patched OpenWebUI's tool surface: the bundle list, and running ONE function from a bundle
        // ourselves. `setServerTools()` scripts both — the list, and what each call streams.
        if (req.method === "GET" && path === "/api/v1/tools/") {
            return json(res, 200, serverTools.map((t) => ({ id: t.id, name: t.name, meta: { description: t.description || "" }, specs: t.specs || [] })));
        }
        const exec = path.match(/^\/api\/v1\/tools\/id\/([^/]+)\/execute$/);
        if (req.method === "POST" && exec) {
            const body = await readBody(req);
            toolCalls.push({ toolId: decodeURIComponent(exec[1]), ...body });
            const script = serverToolScript;
            if (script?.status && script.status !== 200) return json(res, script.status, { detail: script.detail || "nope" });
            const frames = typeof script?.frames === "function" ? script.frames(body) : (script?.frames || [
                { type: "output", text: `ran ${body.name}\n`, atMs: 5 },
                { type: "result", result: { ok: true }, name: body.name, durationMs: 42, queuedMs: 1 },
            ]);
            if (!body.stream) {
                const last = frames.filter((/** @type {any} */ f) => f.type === "result").pop() || {};
                return json(res, 200, { tool_id: decodeURIComponent(exec[1]), name: body.name, result: last.result, durationMs: last.durationMs, queuedMs: last.queuedMs });
            }
            res.writeHead(200, { "content-type": "application/x-ndjson", "access-control-allow-origin": "*", "cache-control": "no-store" });
            for (const f of frames) { res.write(JSON.stringify(f) + "\n"); await sleep(streamDelayMs); }
            // `endless: true` never sends a result frame — the transport-failure case, which a client must
            // not report to the model as a tool that returned nothing.
            return res.end();
        }
        // OLLAMA-NATIVE (`/ollama/api/chat`, the passthrough OpenWebUI exposes and the `ollama` apiFormat
        // targets). A genuinely different wire shape, not a spelling: NDJSON rather than SSE, thinking on
        // `message.thinking` rather than `reasoning_content`, tool calls delivered WHOLE in one chunk rather
        // than fragmented by index, and the token counts plus THREE durations on a final `done` object. The
        // extension supports both formats and only one of them was ever exercised end to end.
        if (req.method === "POST" && (path === "/api/chat" || path === "/ollama/api/chat")) {
            const body = await readBody(req);
            calls.push(body);
            let step = idx < script.length ? script[idx++] : { content: "" };
            if (typeof step === "function") step = step(body) || { content: "" };
            const choice = toChoice(step);
            const tc = choice.message.tool_calls;
            const whole = tc ? tc.map((c) => ({ function: { name: c.function.name, arguments: JSON.parse(c.function.arguments || "{}") } })) : null;
            const u = usageFor(body, step);
            // The three durations, in NANOSECONDS as Ollama reports them. Each answers a different question —
            // "was the model there", "how long did it read", "how long did it generate" — and only this route
            // reports any of them.
            const done = { done: true, done_reason: "stop",
                           prompt_eval_count: u.prompt_tokens, eval_count: u.completion_tokens,
                           load_duration: 20_000_000, prompt_eval_duration: 640_000_000, eval_duration: 1_200_000_000 };
            if (!body.stream) {
                return json(res, 200, { model, message: { role: "assistant", content: choice.message.content || "",
                                        ...(step.reasoning ? { thinking: step.reasoning } : {}), ...(whole ? { tool_calls: whole } : {}) }, ...done });
            }
            res.writeHead(200, { "content-type": "application/x-ndjson", "access-control-allow-origin": "*", "cache-control": "no-store" });
            /** @param {Record<string, unknown>} message */
            const line = (message) => res.write(JSON.stringify({ model, message, done: false }) + "\n");
            const beats = step.emit || [
                ...(step.reasoning ? [{ kind: "think", text: step.reasoning }] : []),
                ...(whole ? [{ kind: "call" }] : [{ kind: "answer", text: choice.message.content || "" }]),
            ];
            for (const b of beats) {
                if (b.kind === "think") line({ role: "assistant", content: "", thinking: b.text || "" });
                else if (b.kind === "answer") line({ role: "assistant", content: b.text || "" });
                // WHOLE, every time — Ollama does not fragment, so repeated `call` beats resend the same
                // array. That is the point: several beats must still collapse to ONE `call` phase.
                else if (whole) line({ role: "assistant", content: "", tool_calls: whole });
                await sleep(streamDelayMs);
            }
            res.write(JSON.stringify({ model, message: { role: "assistant", content: "" }, ...done }) + "\n");
            return res.end();
        }
        if (req.method === "POST" && (path === "/api/chat/completions" || path === "/v1/chat/completions")) {
            const body = await readBody(req);
            calls.push(body);
            let step = idx < script.length ? script[idx++] : { content: "" };
            if (typeof step === "function") step = step(body) || { content: "" };
            if (body.stream) return streamStep(res, step, body);
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
            // address() is `string | AddressInfo | null` because a server can be bound to a unix socket;
            // this one is always a TCP listen, so the port is there.
            const realPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
            const origin = `http://127.0.0.1:${realPort}`;
            resolve({
                url: `${origin}/api/chat/completions`,
                origin,
                setScript: (/** @type {StepOrFn[]} */ steps) => { script = steps.slice(); idx = 0; },
                /** What /api/ps reports as resident — raw ollama ps rows (size / size_vram / gpus / …). */
                setResident: (/** @type {any[]} */ models) => { resident = models; },
                /** What /api/info reports as capacity; null = a server that doesn't serve the route at all. */
                setCapacity: (/** @type {any} */ info) => { boxInfo = info; },
                /**
                 * Turn the event stream ON and seed the retained ring. Frames are the server's own shape
                 * (`{v, kind, t, model?, …}`) with `t` NEGATIVE for backfill — capture a real one with
                 * tests/e2e/capture-frames.mjs. Off by default: most specs want the polling path.
                 */
                setEvents: (/** @type {any[]} */ list) => { eventsSupported = true; frames = (list || []).slice(); },
                /** Send a frame to everyone connected now, and retain it for later subscribers. */
                pushFrame: (/** @type {any} */ f) => {
                    frames.push(f);
                    for (const r of streamSubs) { try { r.write(JSON.stringify(f) + "\n"); } catch { streamSubs.delete(r); } }
                },
                /** How many panels are subscribed — the worker holds ONE connection however many are open. */
                streamSubscribers: () => streamSubs.size,
                /** The tool BUNDLES `/api/v1/tools/` lists — `[{ id, name, description, specs: [{name, description, parameters}] }]`. */
                setServerTools: (/** @type {any[]} */ tools) => { serverTools = tools.slice(); },
                /**
                 * What `/execute` streams. `{ frames }` is the NDJSON frame list (or a function of the
                 * request body); `{ status, detail }` fails before the first byte instead. Omitting a
                 * `result` frame reproduces the transport-failure case, which a client must NOT report to
                 * the model as a tool that returned nothing.
                 */
                setServerToolScript: (/** @type {any} */ script) => { serverToolScript = script; },
                calls: () => calls.slice(),
                /** Every `/execute` request body, with the `toolId` from the path. */
                toolCalls: () => toolCalls.slice(),
                // A held-open NDJSON response keeps the server alive forever, so close() would hang.
                stop: () => new Promise((r) => { for (const s2 of streamSubs) { try { s2.end(); } catch { /* gone */ } } streamSubs.clear(); server.close(() => r(undefined)); }),
            });
        });
    });
}
