// PROTOBUF AGAINST THE REAL BACKEND — opt-in, like `live` in the fast suite, and never in CI.
//
// Everything else about this path drives frames this repo also wrote, which is a closed loop: it proves the
// decoder agrees with our idea of the encoder. This is the only thing that puts the SERVER'S OWN BYTES
// through the built extension — its service worker, its `chrome-extension://` origin, the real key, and a
// real model deciding to call a real tool.
//
//   npm run build && USE_ENV=1 npx playwright test tests/e2e/proto-live.spec.mjs
//
// Reads OPENWEBUI_URL / OPENWEBUI_KEY / OPENWEBUI_MODEL from .env. Skips itself entirely without USE_ENV,
// because the backend is live, it spends GPU time, and CI has neither.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";

const env = (() => {
    try {
        return Object.fromEntries(readFileSync(".env", "utf8").split("\n").map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#") && l.includes("="))
            .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    } catch { return {}; }
})();
const LIVE = process.env.USE_ENV === "1" && !!env.OPENWEBUI_URL;
const BASE = (env.OPENWEBUI_URL || "").replace(/\/+$/, "");
// THE ONLY ROUTE THAT SERVES IT. OpenWebUI's own `/api/chat/completions` re-encodes the model's stream as
// SSE, so protobuf can never come back there — measured, and the settings panel says so. The encoder is on
// the ollama passthrough.
const CHAT_URL = process.env.CHAT_URL || `${BASE}/ollama/v1/chat/completions`;
const MODEL = process.env.E2E_MODEL || env.OPENWEBUI_MODEL;

test.describe.configure({ mode: "serial" });
test.skip(!LIVE, "live backend only — set USE_ENV=1 with a .env (never in CI)");

/**
 * Watch what the SERVICE WORKER actually sent and got back.
 *
 * The extension decodes protobuf internally and nothing downstream says which wire delivered a token — by
 * design, since the whole point is that the caller cannot tell. So the only honest way to assert the format
 * was USED is to look at the response headers in the realm that made the request. Installed from the SW
 * realm, which a page cannot reach.
 */
const watchFetch = (sw) => sw.evaluate(() => {
    globalThis.__wire = [];
    if (globalThis.__wireInstalled) return;
    globalThis.__wireInstalled = true;
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url;
        const accept = init?.headers?.Accept ?? init?.headers?.accept ?? null;
        const res = await real(input, init);
        try { globalThis.__wire.push({ url: String(url), accept, type: res.headers.get("content-type"), status: res.status }); } catch { /* opaque */ }
        return res;
    };
});
const wire = (sw) => sw.evaluate(() => globalThis.__wire || []);

test("a real streamed reply comes back as protobuf, and its tokens are intact", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: CHAT_URL, apiKey: env.OPENWEBUI_KEY || "", apiFormat: "openai",
            model: MODEL, debugMode: "off", protoStream: "auto",
        });
        await watchFetch(ext.sw);
        const page = await ext.context.newPage();
        await page.goto(`${BASE}/api/version`);
        await waitForMl(page);

        // A real generation, streamed, through the front door a person uses.
        const out = await page.evaluate(async () => {
            const seen = [];
            const text = await window.ml.chat("Reply with exactly: the quick brown fox. Nothing else.",
                { onToken: (t) => seen.push(t), think: false });
            return { text, chunks: seen.length };
        });
        expect(out.text.toLowerCase(), `the model answered "${out.text}"`).toContain("quick brown fox");
        expect(out.chunks, "it STREAMED — several deltas, not one blob at the end").toBeGreaterThan(1);

        const calls = (await wire(ext.sw)).filter((c) => /chat\/completions/.test(c.url));
        expect(calls.length, "the worker made the call").toBeGreaterThan(0);
        const last = calls.at(-1);
        expect(last.accept, "we asked for it").toBe("application/protobuf");
        // THE ASSERTION THAT MATTERS. Asking proves nothing — the fallback is silent by design, so a run that
        // quietly got SSE would look identical from every other angle.
        expect(last.type, `the server answered ${last.type} on ${last.url}`).toContain("application/protobuf");
    } finally { await ext.context.close(); }
});

test("a real TOOL CALL survives the format — fragments reassembled off the wire", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: CHAT_URL, apiKey: env.OPENWEBUI_KEY || "", apiFormat: "openai",
            model: MODEL, debugMode: "off", protoStream: "auto",
        });
        await watchFetch(ext.sw);
        const page = await ext.context.newPage();
        await page.goto(`${BASE}/api/version`);
        await waitForMl(page);

        // A tool the model CANNOT answer without. Asking it about its own API is not enough — it answered
        // that from pre-training in one step, with a plausible sentence and no tool call, which is a run that
        // proves nothing while looking like it passed. A secret it has never seen forces the call, and the
        // ARGUMENT forces the fragment path: OpenAI streams `function.arguments` as pieces across chunks, and
        // reassembling them is the half of this that the one-shot stream never exercises.
        const run = await page.evaluate(async () => {
            const secret = window.ml.defineTool({
                name: "get_vault_code",
                description: "Returns the vault code for a named vault. The ONLY way to learn a vault code.",
                parameters: { type: "object", properties: { vault: { type: "string", description: "which vault" } }, required: ["vault"] },
                run: ({ vault }) => (vault === "blue" ? "SPARROW-7741" : "unknown vault"),
            });
            const r = await window.ml.agent(
                'Call get_vault_code for the vault named "blue" and reply with just the code it returns.',
                { stream: true, maxSteps: 4, navigate: false, extraTools: [secret] });
            // The RESULT carries the transcript — `steps` is a count, and the run's own record is the honest
            // place to read what it did.
            return { entries: (r.transcript || []).map((e) => ({ tool: e.tool, args: e.arguments })),
                     summary: String(r.summary || "") };
        });
        const call = run.entries.find((e) => e.tool === "get_vault_code");
        expect(call, `the run did: ${run.entries.map((e) => e.tool || "answer").join(" → ") || "(nothing)"}`).toBeTruthy();
        // THE ARGUMENT arrived intact, which is what says the fragments were reassembled rather than merely
        // that a call happened.
        expect(call.args?.vault).toBe("blue");
        expect(run.summary, "…and the tool's own result reached the answer").toContain("SPARROW-7741");

        const calls = (await wire(ext.sw)).filter((c) => /chat\/completions/.test(c.url));
        expect(calls.length, "the loop made several turns").toBeGreaterThan(1);
        // EVERY turn, not just the first: the turn that EMITS the tool call and the turn that answers after
        // its result take different paths through the accumulator.
        for (const c of calls) {
            expect(c.accept, `asked on ${c.url}`).toBe("application/protobuf");
            expect(c.type, `answered ${c.type}`).toContain("application/protobuf");
        }
    } finally { await ext.context.close(); }
});

// THE FALLBACK, against the real thing rather than a scripted response. It is silent by design — a caller
// cannot tell which wire delivered its tokens — which is exactly why it needs a test that looks at the wire.

test("turned OFF, the same call is plain SSE and nothing else changes", async () => {
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: CHAT_URL, apiKey: env.OPENWEBUI_KEY || "", apiFormat: "openai",
            model: MODEL, debugMode: "off", protoStream: "off",
        });
        await watchFetch(ext.sw);
        const page = await ext.context.newPage();
        await page.goto(`${BASE}/api/version`);
        await waitForMl(page);
        const out = await page.evaluate(async () => {
            const seen = [];
            const text = await window.ml.chat("Reply with exactly: the quick brown fox. Nothing else.",
                { onToken: (t) => seen.push(t), think: false });
            return { text, chunks: seen.length };
        });
        expect(out.text.toLowerCase()).toContain("quick brown fox");
        expect(out.chunks, "still streamed").toBeGreaterThan(1);

        const last = (await wire(ext.sw)).filter((c) => /chat\/completions/.test(c.url)).at(-1);
        expect(last.accept, "the header is not sent at all when the setting is off").toBeFalsy();
        expect(last.type, "…and the server answers with the SSE it always did").toContain("text/event-stream");
    } finally { await ext.context.close(); }
});

test("a backend that will not serve it still works — we ask, get SSE, and parse SSE", async () => {
    // THE MISS IS THE FALLBACK. OpenWebUI's own chat route re-encodes the model's stream as SSE, so it can
    // never answer protobuf however politely we ask — which makes it the perfect real backend for this:
    // same box, same model, a route that genuinely will not do it. This is what protects anyone pointing the
    // extension at a stock Ollama or an older build.
    //
    // Under "on", the state that INSISTS, because it is the one where getting this wrong would be worst: a
    // hard failure there would trade a saved envelope for a chat that does not work, against a route half
    // the users of this extension are pointed at. "on" buys a report, never a refusal — asserted here
    // against the real route rather than against a stub that agrees with us.
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${BASE}/api/chat/completions`, apiKey: env.OPENWEBUI_KEY || "", apiFormat: "openai",
            model: MODEL, debugMode: "off", protoStream: "on",
        });
        await watchFetch(ext.sw);
        const page = await ext.context.newPage();
        await page.goto(`${BASE}/api/version`);
        await waitForMl(page);
        const out = await page.evaluate(async () => {
            const seen = [];
            const text = await window.ml.chat("Reply with exactly: the quick brown fox. Nothing else.",
                { onToken: (t) => seen.push(t), think: false });
            return { text, chunks: seen.length };
        });
        const last = (await wire(ext.sw)).filter((c) => /chat\/completions/.test(c.url)).at(-1);
        expect(last.accept, "we asked").toBe("application/protobuf");
        expect(last.type, "it declined").toContain("text/event-stream");
        // …and none of that reached the caller, which is the point of negotiating by the response.
        expect(out.text.toLowerCase(), "the answer is intact anyway").toContain("quick brown fox");
        expect(out.chunks, "and it still streamed").toBeGreaterThan(1);
    } finally { await ext.context.close(); }
});
