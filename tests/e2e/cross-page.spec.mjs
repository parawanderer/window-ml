// cross-page.spec.mjs — end-to-end (real Chromium + the built extension) tests for cross-page agent
// persistence. Deterministic by default: a scripted fake-LLM stands in for the model, so the REAL pipeline
// (background loop → tool delegation → page) runs with no Ollama. Point at a real backend with:
//     E2E_BACKEND=http://localhost:3000/api/chat/completions  E2E_MODEL=qwen3:32b  npm run test:e2e
// (then the scripted turns are ignored and the real model drives — slower, non-deterministic).

import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// Bind an ephemeral port then CLOSE it → a definitely-CONNECTION-REFUSED URL, for the dead-backend tests
// (simulating "the box is offline"). More reliable than guessing an unused port.
async function deadBackendUrl() {
    const srv = createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    return `http://127.0.0.1:${port}/api/chat/completions`;
}

// A backend that serves the FIRST chat turn (a tool call), then DIES — so a run makes real progress and THEN
// the box vanishes mid-run (the "server randomly dies during a run" case). /api/models answers healthy while
// alive (so the health probe doesn't false-flag before the death). Returns { url, stop }.
async function startDyingBackend() {
    const srv = createServer((req, res) => {
        const isChat = /\/chat\/completions|\/api\/chat/.test(req.url || "");
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            if (!isChat) {   // model-list / health probe → healthy while the box is up
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
                return;
            }
            // First (and only) chat turn: a DOM tool call, then close the server so the NEXT turn — and the
            // health probe — hit a refused port. res 'finish' guarantees the response flushed before we die.
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "findByText", arguments: JSON.stringify({ text: "Step" }) } }] } }] }));
            res.on("finish", () => srv.close());
        });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/api/chat/completions`, stop: () => new Promise((r) => srv.close(r)) };
}

const BACKEND = process.env.E2E_BACKEND;   // real-backend override (skips the fake)
let ext, fake, site;

test.beforeAll(async () => {
    fake = BACKEND ? null : await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: BACKEND || fake.url,
        apiKey: process.env.E2E_KEY || "",   // a hosted backend (e.g. Groq) needs the bearer token
        apiFormat: "openai",
        model: BACKEND ? (process.env.E2E_MODEL || "") : "fake-model",
        modelFilter: "",
        debugMode: "off",
    });
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
});

// Smoke: proves the whole harness — the extension loads, window.ml is live in the page main world, the
// background loop reaches the (fake) backend, and a one-shot agent run resolves with the model's reply.
test("smoke: the extension loads and window.ml runs a one-shot agent", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    if (fake) fake.setScript([{ content: "hello from the harness" }]);
    const result = await page.evaluate(() => window.ml.agent("Say hello.", { env: false }));
    expect(JSON.stringify(result)).toContain(BACKEND ? "" : "hello from the harness");
    await page.close();
});

// fetch_url { rendered: true } — loads the URL in a background tab so its JS runs, then returns the SETTLED
// DOM. /spa's raw HTML is an empty shell ("Loading…"); only after the client script runs does the marker
// appear. A raw GET would never see it. Gated like a credentialed fetch (always prompts) → resolved via IPC.
(BACKEND ? test.skip : test)("fetch_url rendered: a background-tab render returns JS-injected content (a raw GET can't) with cookie/ad overlays stripped", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const page = await ext.context.newPage();
    const answers = [];
    await page.exposeFunction("__ren", (s) => answers.push(s));
    await page.addInitScript(() => { if (window.top === window) window.addEventListener("message", (e) => { if (e.data?.__mlDebug?.kind === "agent-result") window.__ren(e.data.__mlDebug.summary); }); });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        // credentials:true → renders in a NORMAL tab (the harness has no Incognito access; the private default
        // needs "Allow in Incognito" — covered by the next test). Same JS-runs + overlay-strip either way.
        { tool: "fetch_url", args: { url: site.url + "/spa", rendered: true, credentials: true } },
        // Reactive final answer: the RENDERED DOM (in the tool result) must carry the JS-only content marker AND
        // NOT the cookie-overlay marker (overlays are stripped before the grab).
        (reqBody) => { const s = JSON.stringify(reqBody.messages || []); const content = s.includes("SPA-RENDERED-9931"); const overlay = s.includes("COOKIE-OVERLAY-SLOP-7777"); return { content: content && !overlay ? "RENDERED-CLEAN" : content ? "RENDERED-WITH-OVERLAY" : "RENDERED-MISSING" }; },
    ]);
    await page.evaluate(() => { window.ml.agent("Fetch the SPA page rendered and report.", { env: false, approvalRouting: "external" }); return true; });

    // The rendered fetch ALWAYS gates → approve it via the IPC channel.
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    expect(String(gate.tool)).toBe("fetch_url");
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);

    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    await expect.poll(() => answers.join("|"), { timeout: 10000 }).toContain("RENDERED-CLEAN");   // content present, overlay stripped
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off" });
});

// The PRIVATE (default) rendered fetch renders in INCOGNITO — no session. That needs "Allow in Incognito",
// which is OFF for an unpacked extension in the harness, so the render returns ACTIONABLE guidance (walk the
// user to the toggle) instead of a silent failure. Proves the permission flow fires (and that uncredentialed
// rendered doesn't fall back to the session).
(BACKEND ? test.skip : test)("fetch_url rendered (private/incognito): a CROSS-ORIGIN render without 'Allow in Incognito' returns actionable guidance", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const page = await ext.context.newPage();
    const answers = [];
    await page.exposeFunction("__reni", (s) => answers.push(s));
    await page.addInitScript(() => { if (window.top === window) window.addEventListener("message", (e) => { if (e.data?.__mlDebug?.kind === "agent-result") window.__reni(e.data.__mlDebug.summary); }); });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    // CROSS-ORIGIN + no credentials → the PRIVATE incognito path (a same-origin render uses the session tab, no
    // incognito). It gates for consent first (cross-origin), then hits the incognito requirement.
    fake.setScript([
        { tool: "fetch_url", args: { url: site.crossOrigin + "/", rendered: true } },
        (reqBody) => ({ content: /incognito/i.test(JSON.stringify(reqBody.messages || [])) ? "NEEDS-INCOGNITO" : "NO-GUIDANCE" }),
    ]);
    await page.evaluate(() => { window.ml.agent("Render the other site privately.", { env: false, approvalRouting: "external" }); return true; });
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    await expect.poll(() => answers.join("|"), { timeout: 10000 }).toContain("NEEDS-INCOGNITO");
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off" });
});

// A SAME-ORIGIN rendered fetch is FREE (no prompt) — but it renders in INCOGNITO (session-less), so with
// "Allow in Incognito" OFF (the harness default) it auto-approves AND then returns the incognito guidance. The
// FREE part is proven by: approvalRouting "external" + NO approval given → the run still completes (a gate
// would have blocked at 1 call) and no gate was ever raised. The incognito part by the guidance in the result.
(BACKEND ? test.skip : test)("fetch_url rendered: a SAME-ORIGIN render is FREE (no prompt) and uses incognito (not the session)", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([{ tool: "fetch_url", args: { url: site.url + "/spa", rendered: true } }, { content: "ok" }]);   // same-origin, no creds → FREE, incognito
    await page.evaluate(() => { window.ml.agent("render same-origin", { env: false, approvalRouting: "external" }); return true; });
    // Completes BOTH turns with no approval → the fetch auto-approved (a gate would have blocked at 1 call).
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    expect((await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length).toBe(0);   // FREE: no gate was raised
    // …and it took the INCOGNITO path (not the session): the tool result carries the "Allow in Incognito" guidance.
    expect(/incognito/i.test(JSON.stringify(fake.calls()[before + 1]?.messages || []))).toBe(true);
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off" });
});

// A plain (non-rendered) SAME-ORIGIN fetch is FREE too — the page could `fetch()` its own origin itself. Same
// proof: external routing + no approval → the run completes, so it auto-approved.
(BACKEND ? test.skip : test)("fetch_url: a plain SAME-ORIGIN fetch is FREE (no prompt); a CROSS-ORIGIN one gates", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    // Same-origin plain fetch → auto-approves → the run finishes both turns with no approval given.
    let before = fake.calls().length;
    fake.setScript([{ tool: "fetch_url", args: { url: site.url + "/data.json" } }, { content: "done" }]);
    await page.evaluate(() => { window.ml.agent("read same-origin json", { env: false, approvalRouting: "external" }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    expect((await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length).toBe(0);   // no gate for same-origin
    // Cross-origin plain fetch → gates (a gate appears in the external channel).
    before = fake.calls().length;
    fake.setScript([{ tool: "fetch_url", args: { url: site.crossOrigin + "/data.json" } }, { content: "done" }]);
    await page.evaluate(() => { window.ml.agent("read cross-origin json", { env: false, approvalRouting: "external" }); return true; });
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    expect(String(gate.tool)).toBe("fetch_url");
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off" });
});

// A shared driver: render `path` (credentials:true → a normal session tab, which works in the headful harness
// — the private/incognito path needs "Allow in Incognito") and report whether `marker` reached the model.
// Reads the marker straight from the fake-LLM's captured request body (the final call's messages include the
// tool result) — no dependence on a debug event reaching the page, so it's not flaky under load.
async function renderAndCheck(path, marker) {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([{ tool: "fetch_url", args: { url: site.url + path, rendered: true, credentials: true } }, { content: "ok" }]);
    await page.evaluate(() => { window.ml.agent("render it", { env: false, approvalRouting: "external" }); return true; });
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await expect.poll(() => fake.calls().length - before, { timeout: 30000 }).toBe(2);
    const body = fake.calls()[before + 1];   // the final-answer call — its messages carry the fetch tool result
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off" });
    return JSON.stringify(body?.messages || []).includes(marker) ? "MARKER-PRESENT" : "MARKER-ABSENT";
}

// The DOM-quiet settle waits for the DOM to stop changing (a network-idle proxy) instead of a fixed delay — so
// content that STREAMS in past the old ~1.2s window (an SPA hydrating) is captured, not truncated mid-stream.
// Retried: the fixture's streaming rides background-tab setInterval, which Chrome can throttle under harness
// load (>700ms gaps let the quiet wait bail early) — it's reliable in isolation, so a couple retries absorb it.
test.describe(() => {
    test.describe.configure({ retries: 2 });
    (BACKEND ? test.skip : test)("fetch_url rendered: the DOM-quiet settle captures content that streams in after the old fixed delay", async () => {
        expect(await renderAndCheck("/slow", "STREAM-DONE-3377")).toContain("MARKER-PRESENT");
    });
});

// The scroll pass trips a viewport-lazy widget (IntersectionObserver, like GitHub's lazy <include-fragment>) —
// without a scroll it would never enter the viewport in a never-scrolled render tab.
(BACKEND ? test.skip : test)("fetch_url rendered: the scroll pass trips a viewport-lazy (IntersectionObserver) widget", async () => {
    expect(await renderAndCheck("/lazy", "LAZY-SCROLL-5591")).toContain("MARKER-PRESENT");
});

// renderSnapshot's layout-aware checkVisibility() prunes CSS-CLASS-hidden content (display:none via a
// stylesheet) that the raw static strip can't see — so hidden fallback slots (GitHub's "Uh oh!" blocks) don't
// pollute the rendered markdown.
(BACKEND ? test.skip : test)("fetch_url rendered: checkVisibility prunes CSS-class-hidden content (raw strip can't see it)", async () => {
    expect(await renderAndCheck("/hidden", "CSS-HIDDEN-JUNK-4242")).toContain("MARKER-ABSENT");
});

// Continue-past-step-cap: a run that STOPS at its maxSteps cap resumes — via the same __mlContinueRun the
// "Continue (+N steps)" button posts — with a FRESH step budget, continuing from its stored state (no typed
// follow-up). We drive a maxSteps:1 run (the first tool call exhausts the cap → hitCap), then fire the
// continue message and assert the run finishes.
test("continue: a step-capped run resumes with a fresh budget via __mlContinueRun (the Continue button)", async () => {
    const page = await ext.context.newPage();
    const results = [];
    await page.exposeFunction("__cont", (e) => results.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => {
            if (e.data && e.data.__mlDebug && e.data.__mlDebug.kind === "agent-result")
                window.__cont({ summary: e.data.__mlDebug.summary, hitCap: !!e.data.__mlDebug.hitCap });
        });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);
    // maxSteps:1 → step 1 is the tool call, then the loop exceeds the cap → hitCap. After continue, the next
    // turn's first call is the final answer → the run completes.
    fake.setScript([
        { tool: "findByText", args: { text: "Step" } },
        { content: "Finished after the extra budget." },
    ]);
    const first = await page.evaluate(() => window.ml.agent("do the thing", { env: false, maxSteps: 1 }));
    expect(first.hitCap).toBe(true);
    // Fire the exact message the Continue button posts (the injected consumer resumes by hash, empty task).
    await page.evaluate((hash) => window.postMessage({ __mlContinueRun: { hash } }, "*"), first.hash);
    // The resumed turn completes — a non-capped agent-result with the post-continue answer.
    await expect.poll(() => results.some((r) => !r.hitCap && /extra budget/.test(r.summary || "")), { timeout: 15000 }).toBe(true);
    await page.close();
});

// Streaming (opt-in stream:true): the REAL SSE path end to end. The fake backend streams reasoning_content
// word by word, then a tool_call (accumulated from the stream), then a streamed final answer. Proves the
// browser's real fetch + streamAgentTurn reassemble a fragmented tool_call correctly (the loop still delegates
// it with full args and reads the page value), and that live agent-stream deltas fire. node:vm can only mock
// the SSE reader; this drives a genuine HTTP event-stream through the built extension.
test("streaming: a stream:true run streams reasoning deltas AND accumulates a streamed tool_call end to end", async () => {
    if (BACKEND) return;   // fake-only: the reasoning script + delta assertions are backend-specific
    const page = await ext.context.newPage();
    const streams = [];
    await page.exposeFunction("__strEv", (e) => streams.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => {
            const d = e.data && e.data.__mlDebug;
            if (d && (d.kind === "agent-stream" || d.kind === "agent-result")) window.__strEv({ kind: d.kind, reasoning: d.reasoning || "", content: d.content || "", summary: d.summary || "" });
        });
    });
    await page.goto(site.url + "/step3");
    await waitForMl(page);
    fake.setScript([
        { reasoning: "Let me search the page for the code before I answer the question properly.", tool: "findByText", args: { text: "CROSSPAGE" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/CROSSPAGE-\d+/);
            return { reasoning: "Found the code, now composing the answer.", content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    const result = await page.evaluate(() => window.ml.agent("What code is shown here? Use findByText, then answer.", { env: false, stream: true }));
    // The streamed, fragmented tool_call was reassembled + delegated with full args, so the page value reached the answer.
    expect(JSON.stringify(result)).toContain("CROSSPAGE-9471");
    // Live reasoning deltas fired (the "thinking" streamed), not just the final turn.
    await expect.poll(() => streams.some((s) => s.kind === "agent-stream" && /search the page|composing the answer/.test(s.reasoning)), { timeout: 10000 }).toBe(true);
    await page.close();
});

// Two-UI approval sync: when a gate is decided (from ANY surface / the external channel), every OTHER surface
// must clear its approve/deny box IMMEDIATELY, not only when the tool's DONE lands (seconds off for a slow
// fetch). The fix fans a "decided" step patch (awaitingApproval:false, no result yet) the instant the gate
// resolves, before the tool runs. We reproduce with the SW __mlApprovals channel standing in for "the other
// UI", and assert the page surface receives that decided patch ahead of the DONE.
test("approval: resolving a gate clears the approve/deny box on other surfaces immediately (before the tool DONE)", async () => {
    if (BACKEND) return;
    const page = await ext.context.newPage();
    const steps = [];
    await page.exposeFunction("__apEv", (e) => steps.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => {
            const d = e.data && e.data.__mlDebug;
            if (d && d.kind === "agent-step") window.__apEv({ seq: d.seq, awaitingApproval: !!d.awaitingApproval, approval: d.approval || null, hasResult: d.result != null });
        });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);
    fake.setScript([
        { tool: "exec", args: { js: "window.__gate = 1; 'mutated'" } },   // a MUTATING exec -> out of the readonly dialect -> gates
        { content: "done" },
    ]);
    // approvalRouting "both" so the SW channel (our stand-in for a second UI) can resolve the gate.
    await page.evaluate(() => { window.ml.agent("mutate then finish", { env: false, approvalRouting: "both" }); return true; });
    await expect.poll(() => steps.some((s) => s.awaitingApproval), { timeout: 12000 }).toBe(true);
    const gateSeq = steps.find((s) => s.awaitingApproval).seq;
    // Resolve from the channel (a different surface than the page). One press -> every surface clears.
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 5000 }).toBeGreaterThan(0);
    await ext.sw.evaluate(() => { const [g] = globalThis.__mlApprovals.list(); return globalThis.__mlApprovals.resolve(g.key, true); });
    // The page surface gets a DECIDED patch for that step (awaiting cleared, approval set, NO result yet) -
    // proving it clears BEFORE the tool's DONE (which carries the result).
    await expect.poll(() => steps.some((s) => s.seq === gateSeq && !s.awaitingApproval && s.approval === "user" && !s.hasResult), { timeout: 5000 }).toBe(true);
    await page.close();
});

// A real-shape sanity check that ALSO runs in the non-blocking real-model job: the agent reads a value off
// the page with a DOM tool and answers it. Deterministic under the fake (a hard gate); a genuine "can a
// real OpenAI-shaped model actually drive a tool and answer" probe under E2E_BACKEND.
test("sanity: the agent reads a value off the page via a DOM tool and answers with it", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/step3");
    await waitForMl(page);
    if (fake) fake.setScript([
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/CROSSPAGE-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    const result = await page.evaluate(() =>
        window.ml.agent("What code is shown on this page? Use findByText to locate it, then answer with just the code."));
    expect(JSON.stringify(result)).toContain("CROSSPAGE-9471");
    await page.close();
});

// The acceptance test for cross-page persistence. The default toolset includes `exec` (an approval tool),
// so under debugMode:"off" on a non-whitelisted origin the run is BACKGROUND-hosted — the durable spine that
// survives the navigation. Script: navigate to /step2, then /step3, read the code, answer.
//
// We do NOT await ml.agent()'s return: the caller's page main-world context is DESTROYED by the navigation,
// so its promise can never resolve back into page.evaluate (that's the whole reason the loop must live in
// the background). Instead we observe the run through the STABLE fake-LLM, which sees every model turn.
test("cross-page: a background run survives a same-origin navigation and reads the far page", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;   // calls accumulate across tests → measure THIS run's tail
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { tool: "navigate", args: { url: "/step3" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        // final answer echoes the code the REAL findByText read off /step3 (proves the tool ran post-nav)
        (req) => {
            const readText = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = readText.match(/CROSSPAGE-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "I could not find the code." };
        },
    ]);
    // Fire-and-forget: the promise dies with the page context; the background run carries on.
    await page.evaluate(() => { window.ml.agent("Go to step 2, then step 3, and tell me the code shown on step 3."); return true; });

    // All FOUR model turns fired → the loop kept stepping across BOTH navigations (re-adopting each new page).
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(4);
    // The real proof of re-adoption: the DOM tool ran on /step3 and the code it read reached the model's final
    // turn. A FAILED adopt would feed the model a "no active run" error instead — so this string can't appear.
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toContain("CROSSPAGE-9471");
    expect(page.url()).toContain("/step3");
    await page.close();
});

// Overlay/off HUD replay-across-nav: the destination page must receive the run's PRE-nav history (start +
// early steps), so a fresh card can rebuild mid-run instead of only showing the tail. We tag each debug
// event with the URL it arrived on; a `kind:"agent"` / step-1 event landing on /step3 can ONLY be the
// background replay (the fresh /step3 document never emits the run start itself — it's background-hosted).
test("cross-page: the destination page replays the run's pre-nav history", async () => {
    const page = await ext.context.newPage();
    const events = [];
    await page.exposeFunction("__cpEvent", (e) => events.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;   // top frame only (avoid an overlay iframe double-capture)
        window.addEventListener("message", (e) => {
            if (e.data && e.data.__mlDebug) window.__cpEvent({ url: location.pathname, kind: e.data.__mlDebug.kind, step: e.data.__mlDebug.step ?? null, fromBg: !!e.data.__mlFromBg });
        });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { tool: "navigate", args: { url: "/step3" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/CROSSPAGE-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 2, then step 3, and read the code.", { env: false }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(4);
    await expect.poll(() => events.some((e) => e.url.includes("/step3") && e.kind === "agent-result"), { timeout: 10000 }).toBe(true);

    const onStep3 = events.filter((e) => e.url.includes("/step3"));
    // The run START replayed onto /step3 (fresh doc → could only come from the background buffer)…
    expect(onStep3.some((e) => e.kind === "agent" && e.fromBg)).toBe(true);
    // …and an EARLY step (the step-1 navigate, emitted while on "/") replayed too.
    expect(onStep3.some((e) => e.kind === "agent-step" && e.step === 1)).toBe(true);
    await page.close();
});

// HUD-after-nav bug: a cross-page run that FINISHES before the destination page's content script injects
// (Chrome "on click" site access withholds the <all_urls> CS) showed NO corner card / final answer there —
// its replay buffer was dropped on completion and the CONTENT_READY replay was gated on LIVE runs only. We
// reproduce the mechanic with a RELOAD after completion (a fresh document on the tab whose only run is DONE —
// identical to a late injection from the background's view): the fresh page must still replay the run's
// history (start + result) so the card can rebuild. Before the fix this replays nothing.
test("cross-page: a page loading AFTER the run finished still replays its HUD history (on-click / late-injection)", async () => {
    const page = await ext.context.newPage();
    const events = [];
    await page.exposeFunction("__cpLate", (e) => events.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => {
            if (e.data && e.data.__mlDebug) window.__cpLate({ url: location.pathname, kind: e.data.__mlDebug.kind, fromBg: !!e.data.__mlFromBg });
        });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    // Navigate to /step2, then ANSWER — the run FINISHES on the destination WITHOUT a page tool (the reported
    // repro: a fast final answer needs no delegation, so the loop never waits for the new page's CS).
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { content: "All done — the answer is 42." },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 2 and finish.", { env: false }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    await expect.poll(() => events.some((e) => e.kind === "agent-result"), { timeout: 10000 }).toBe(true);

    // A FRESH page loads on the tab AFTER the run completed → it must still get the run's history replayed.
    events.length = 0;
    await page.reload();
    await waitForMl(page);
    await expect.poll(() => events.some((e) => e.kind === "agent" && e.fromBg), { timeout: 10000 }).toBe(true);
    expect(events.some((e) => e.kind === "agent-result" && e.fromBg)).toBe(true);
    await page.close();
});

// HUD corner card, cross-page: the card is destroyed with the old document at a nav and must REBUILD on the
// destination page from the background replay. Unlike the two tests above (which assert the debug events reach
// a page-added init-script listener), this drives the REAL shell + card iframe — the actual regression: the
// shell's window listener attaches after an async chrome.storage.get, so on a fast cached same-origin nav the
// replay burst could land before it was listening → the `agent` start was missed → the card never mounted
// (only the DevTools panel, fed by a surviving port, kept working). Assert the card shows the answer on /step3.
test("cross-page (HUD card): the corner card rebuilds and shows the answer on the destination page", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step3" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },   // a page tool ON the destination (like the reported exec)
        { content: "Done — the corner card must show this on step3." },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 3 and finish.", { env: false }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);

    // The off-mode corner HUD card iframe must appear ON THE DESTINATION PAGE and reveal the final answer.
    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 20000 }).toContain("corner card must show");
    await page.close();
});

// The DEVTOOLS coexist card, cross-page (the exact reported config): debugMode:"devtools" +
// agentHudInDevtools → a corner card rides alongside the panel. On page 1 the card mounts from the page's OWN
// injected `agent` event; after a nav the destination page's card can ONLY get that start from the background
// replay. The reported bug: the panel kept working (surviving port) but the corner card never reappeared.
test("cross-page (devtools coexist card): the corner card reappears on the destination page after a nav", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: true });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step3" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        { content: "Done — the coexist card must show this on step3." },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 3 and finish.", { env: false }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);

    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 20000 }).toContain("coexist card must show");
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off", agentHudInDevtools: false });   // restore
});

// A page served with a `sandbox` CSP (exactly like raw.githubusercontent.com) BLOCKS the extension's injected
// main-world script, so window.ml never comes up there and a delegated tool has NO answerer. The extension
// must fail that tool FAST with an actionable error, not wedge the run forever (the reported raw.github
// stuck-run bug). We navigate the run onto the blocked page and assert the next tool's result carries the CSP
// message — and that all turns fire within the window, which is only possible via the fast-fail (the script
// `onerror` flag), never the 120s backstop or an outright hang.
test("csp-sandbox: a delegated tool on a script-blocking page FAILS FAST with an actionable error (no hang)", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/blocked" } },            // same-origin → auto-approved; injected is blocked there
        { tool: "findByText", args: { text: "SANDBOXED-FILE" } },   // delegated to the blocked page → must fail fast
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            return { content: /blocks the extension|Content-Security-Policy/i.test(seen) ? "GOT-CSP-ERROR" : "no-error-seen" };
        },
    ]);
    // Fire-and-forget (the page context dies at the nav); the background run carries on.
    await page.evaluate(() => { window.ml.agent("Read the file on the next page."); return true; });

    // All THREE turns fire → the delegated findByText RETURNED (fast-fail) instead of wedging the run. Without
    // the fix it would post into the void on the CSP-blocked page and never answer, so the 3rd turn never fires
    // and this poll times out. (~15s for the nav re-adopt timeout, then the tool fails instantly — well under
    // the 120s backstop, so completing in this window proves the onerror fast-path, not the timeout.)
    await expect.poll(() => fake.calls().length - before, { timeout: 45000 }).toBe(3);
    // The delegated tool's result — fed to the final turn — carries the actionable CSP message.
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toMatch(/blocks the extension|Content-Security-Policy/i);
    await page.close();
});

// The reported bug: the corner HUD card reappears after a SAME-origin nav but NOT a CROSS-DOMAIN one. Devtools
// coexist card + a run that navigates to a DIFFERENT origin — the card must rebuild on the destination origin.
test("cross-domain (HUD card): the corner card reappears on the destination ORIGIN after a cross-origin nav", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: true });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },
        { tool: "findByText", args: { text: "XDOMAIN" } },
        { content: "Resumed answer — the coexist card must show THIS on the other origin." },
    ]);
    await page.evaluate((cross) => { window.ml.agent(`Go to ${cross} and read the code.`, { env: false, crossOrigin: true, approvalRouting: "external" }); return true; }, site.crossOrigin);
    // Approve the cross-origin crossing (routed to the IPC channel).
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);
    expect(new URL(page.url()).host).toBe(new URL(site.crossOrigin).host);   // really left the first origin

    // The corner HUD card must appear ON THE DESTINATION ORIGIN with the answer.
    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 20000 }).toContain("must show THIS on the other origin");
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off", agentHudInDevtools: false });   // restore
});

// The EXACT reported repro: a RESUME (follow-up "can you go to youtube…") that navigates CROSS-DOMAIN. A
// resume emits no `agent` start, so the destination-origin card must rebuild from the replay/steps alone.
test("cross-domain (HUD card): a RESUME that navigates cross-origin still shows the card on the destination origin", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: true });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    // Turn 1: a background-hosted run that finishes on the START origin. Grab its hash.
    const events = [];
    await page.exposeFunction("__cpXd", (e) => events.push(e));
    await page.addInitScript(() => { if (window.top === window) window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__cpXd({ kind: e.data.__mlDebug.kind, id: e.data.__mlDebug.id }); }); });
    await page.reload(); await waitForMl(page);
    let before = fake.calls().length;
    fake.setScript([{ content: "Turn one done." }]);
    await page.evaluate(() => { window.ml.createAgent({ env: false, crossOrigin: true, approvalRouting: "external" }).run("Say turn one."); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(1);
    const hash = await expect.poll(() => events.find((e) => e.kind === "agent")?.id, { timeout: 10000 }).toBeTruthy().then(() => events.find((e) => e.kind === "agent").id);

    // Turn 2 (RESUME): navigate CROSS-ORIGIN, then answer.
    before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },
        { tool: "findByText", args: { text: "XDOMAIN" } },
        { content: "Resumed answer — the coexist card must show THIS across the domain." },
    ]);
    await page.evaluate((h) => { window.postMessage({ __mlSessionSend: { hash: h, text: "Go to the other site and read the code." } }, "*"); return true; }, hash);
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await expect.poll(() => page.url(), { timeout: 20000 }).toContain(new URL(site.crossOrigin).host);

    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 20000 }).toContain("must show THIS across the domain");
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off", agentHudInDevtools: false });
});

// The reported repro's ACTUAL trigger: a LONG session (many tool calls) that then navigates cross-origin. The
// destination page rebuilds its card from a replay burst; the shell's bgRing buffers that burst until the card
// iframe handshakes `ready`. bgRing is a smaller ring (200) than the background replay (400) and — the bug —
// used to drop-oldest WITHOUT pinning the run's `agent` start, so a >200-event burst shifted the start out
// before the flush → the app orphaned every step → the corner card rendered EMPTY (the DevTools panel, fed by
// a surviving port, kept working — exactly what was reported). pushBg now pins the start (shell twin of the
// background pushReplay fix). Skips under a real backend (needs the scripted 120-call turn).
(BACKEND ? test.skip : test)("cross-domain (HUD card): a >200-event session still rebuilds the card after a cross-origin nav (bgRing start not dropped)", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: true });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const events = [];
    await page.exposeFunction("__cpBg", (e) => events.push(e));
    await page.addInitScript(() => { if (window.top === window) window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__cpBg({ kind: e.data.__mlDebug.kind, id: e.data.__mlDebug.id }); }); });
    await page.reload(); await waitForMl(page);

    // Turn 1: ~120 read-only tool calls (each emits a pending + a done step ⇒ ~240 buffered events > the 200
    // bgRing cap), then an answer — filling the replay ring past the shell's ring so the start would be dropped.
    let before = fake.calls().length;
    const many = [];
    for (let i = 0; i < 120; i++) many.push({ tool: "findByText", args: { text: "step" } });
    many.push({ content: "Long turn done." });
    fake.setScript(many);
    await page.evaluate(() => { window.ml.createAgent({ crossOrigin: true, approvalRouting: "external", maxSteps: 300 }).run("Scan the page many times."); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 90000 }).toBe(121);
    const hash = await expect.poll(() => events.find((e) => e.kind === "agent")?.id, { timeout: 10000 }).toBeTruthy().then(() => events.find((e) => e.kind === "agent").id);

    // Turn 2 (RESUME): navigate CROSS-ORIGIN, then answer — the destination card must NOT be empty.
    before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },
        { content: "Answer after a long session — the card must show THIS on the destination origin." },
    ]);
    await page.evaluate((h) => { window.postMessage({ __mlSessionSend: { hash: h, text: "Go to the other site." } }, "*"); return true; }, hash);
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await expect.poll(() => page.url(), { timeout: 20000 }).toContain(new URL(site.crossOrigin).host);

    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 20000 }).toContain("must show THIS on the destination origin");
    await page.close();
    await configureExtension(ext.sw, { debugMode: "off", agentHudInDevtools: false });
});

// Variant B — cross-DOMAIN. Even WITH { crossOrigin: true }, leaving the origin is a scope escalation, so a
// cross-origin nav must GATE for consent (a page can't silently send the agent to another site). We route
// the gate to the IPC channel so the test can approve/deny it.
test("cross-domain: a cross-origin nav GATES for consent; APPROVED → it proceeds and reads the other site", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },   // a DIFFERENT origin (different port)
        { tool: "findByText", args: { text: "XDOMAIN" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/XDOMAIN-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    await page.evaluate((cross) => { window.ml.agent(`Go to ${cross} and read the code shown there.`, { env: false, crossOrigin: true, approvalRouting: "external" }); return true; }, site.crossOrigin);
    // The cross-origin nav must PROMPT — the security point.
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    expect(gate.tool).toBe("navigate");
    expect(gate.arguments.url).toContain(new URL(site.crossOrigin).host);     // the human sees WHERE it wants to go
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);   // approve the crossing

    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toContain("XDOMAIN-2025");                                   // findByText ran on the OTHER origin
    expect(new URL(page.url()).host).toBe(new URL(site.crossOrigin).host);    // really left the first origin
    await page.close();
});

test("cross-domain: a cross-origin nav DENIED at the gate → the run stays on the original site", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },
        { content: "Understood — I won't leave this site." },
    ]);
    await page.evaluate((cross) => { window.ml.agent(`Go to ${cross}.`, { env: false, crossOrigin: true, approvalRouting: "external" }); return true; }, site.crossOrigin);
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, false), gate.key);   // DENY the crossing
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toMatch(/[Dd]enied/);                                         // the refusal reached the model
    expect(new URL(page.url()).host).toBe(new URL(site.url).host);            // never left the original origin
    await page.close();
});

test("cross-domain: WITHOUT the flag, a cross-origin navigate is refused by the tool (no gate, stays put)", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },   // cross-origin, but no opt-in
        { content: "Understood — I can't leave this site." },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to the other domain.", { env: false }); return true; });   // default: crossOrigin off
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toMatch(/not enabled|crossOrigin/i);                          // the refusal reached the model
    expect(new URL(page.url()).host).toBe(new URL(site.url).host);             // never left the original origin
    await page.close();
});

// A HUD-started run's handle lives PAGE-side; a navigation destroys it. A composer follow-up on the new page
// must still reach the (background) run by hash — else the user types a follow-up into the void.
test("cross-page: a HUD composer follow-up reaches the run after it navigated away", async () => {
    const page = await ext.context.newPage();
    const events = [];
    await page.exposeFunction("__cpFollow", (e) => events.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__cpFollow({ kind: e.data.__mlDebug.kind, id: e.data.__mlDebug.id }); });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { content: "Done — I'm on step 2 now." },
    ]);
    // A handle-backed run (createAgent, like the HUD) that navigates → its page-side handle dies with the nav.
    await page.evaluate(() => { window.ml.createAgent({ env: false }).run("Navigate to /step2."); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    expect(page.url()).toContain("/step2");
    const hash = events.find((e) => e.kind === "agent")?.id;
    expect(hash).toBeTruthy();

    // Follow up via the HUD composer on the NAVIGATED page (the __mlSessionSend the composer posts by hash).
    fake.setScript([{ content: "My favourite is a sleepy tabby." }]);
    const before2 = fake.calls().length;
    await page.evaluate((h) => { window.postMessage({ __mlSessionSend: { hash: h, text: "What's your favourite cat pic?" } }, "*"); return true; }, hash);
    // The follow-up must reach the run (a new model turn), carrying the follow-up text.
    await expect.poll(() => fake.calls().length - before2, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toContain("favourite cat pic");
    await page.close();
});

// HUD card on a RESUME that ITSELF navigates (the reported repro: "open that page at your current hash" →
// the run resumes and navigates, then answers). A RESUME deliberately does NOT re-emit the `agent` start
// (re-emitting would wipe the accumulated session), so the destination page's fresh card has NO start event
// to mount on — only the resumed turn's steps/result. The card must still appear on the destination page.
test("cross-page (HUD card): a resume that navigates still shows the card on the destination page", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    // Turn 1: a background-hosted run that finishes on the START page (no nav yet). Grab its hash.
    const events = [];
    await page.exposeFunction("__cpResume", (e) => events.push(e));
    await page.addInitScript(() => { if (window.top === window) window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__cpResume({ kind: e.data.__mlDebug.kind, id: e.data.__mlDebug.id }); }); });
    await page.reload(); await waitForMl(page);   // re-add the init listener on a fresh load
    const before = fake.calls().length;
    fake.setScript([{ content: "Turn one done." }]);
    await page.evaluate(() => { window.ml.createAgent({ env: false }).run("Say turn one."); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(1);
    const hash = await expect.poll(() => events.find((e) => e.kind === "agent")?.id, { timeout: 10000 }).toBeTruthy().then(() => events.find((e) => e.kind === "agent").id);

    // Turn 2 (RESUME): navigate to /step3, then answer — exactly the reported flow.
    fake.setScript([
        { tool: "navigate", args: { url: "/step3" } },
        { content: "Resumed answer — the corner card must show THIS on step3." },
    ]);
    await page.evaluate((h) => { window.postMessage({ __mlSessionSend: { hash: h, text: "Open the page at your current hash." } }, "*"); return true; }, hash);
    await expect.poll(() => page.url(), { timeout: 20000 }).toContain("/step3");

    // The corner HUD card must appear ON THE DESTINATION PAGE with the resumed answer — even though the resume
    // never re-emitted an `agent` start.
    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 20000 }).toContain("must show THIS on step3");
    await page.close();
});

// A HUD follow-up AFTER a nav routes through RESUME_RUN (the page handle died at the nav). RESUME_RUN must
// CONTINUE the step/seq numbering past the prior turns — it reused base 0, so the follow-up turn's tool steps
// collided with turn 1's at seq 1, and the reducer (which patches a step by seq) OVERWROTE turn 1's steps
// instead of appending: the follow-up's tool call (e.g. the user's approved exec) vanished from the sidebar/
// panel and the export's chat log scrambled. This asserts the follow-up's steps land AFTER turn 1's.
test("cross-page: a HUD composer follow-up after a nav offsets its steps past the prior turn (no seq collision)", async () => {
    const page = await ext.context.newPage();
    const evs = [];   // {agentId?} | {step, seq, tool}
    await page.exposeFunction("__cpBase", (e) => evs.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;
        window.addEventListener("message", (e) => {
            const d = e.data && e.data.__mlDebug;
            if (!d) return;
            if (d.kind === "agent") window.__cpBase({ agentId: d.id });
            else if (d.kind === "agent-step") window.__cpBase({ step: d.step, seq: d.seq ?? null, tool: d.tool || null });
        });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },      // turn 1: nav (a tool step, seq'd)
        { tool: "findByText", args: { text: "CROSSPAGE" } },// turn 1: another tool step
        { content: "Turn 1 done." },
    ]);
    // A handle-backed run (createAgent, like the HUD) that navigates → its page handle dies; follow-ups resume.
    await page.evaluate(() => { window.ml.createAgent({ env: false }).run("Go to step 2 and read the code."); return true; });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/step2");
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);
    const hash = evs.find((e) => e.agentId)?.agentId;
    expect(hash, "captured the run hash").toBeTruthy();

    // The boundary turn 1 reached — the follow-up must continue PAST it, not collide.
    const turn1Max = Math.max(...evs.filter((e) => e.step != null).map((e) => e.step));
    const turn1Seqs = new Set(evs.filter((e) => e.seq != null).map((e) => e.seq));
    const mark = evs.length;

    // Follow up via the HUD composer (RESUME_RUN). It runs ANOTHER tool — the step that used to collide.
    fake.setScript([
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        { content: "Follow-up done." },
    ]);
    const before2 = fake.calls().length;
    await page.evaluate((h) => { window.postMessage({ __mlSessionSend: { hash: h, text: "read it again" } }, "*"); return true; }, hash);
    await expect.poll(() => fake.calls().length - before2, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => evs.slice(mark).some((e) => e.tool === "findByText"), { timeout: 10000 }).toBe(true);

    // The follow-up's tool steps CONTINUE past turn 1: a higher step number AND seqs that don't collide — so the
    // reducer APPENDS them (they're visible) instead of PATCHING over turn 1's (which made them vanish).
    const followSteps = evs.slice(mark).filter((e) => e.step != null);
    expect(Math.max(...followSteps.map((e) => e.step)), "follow-up steps continue past turn 1").toBeGreaterThan(turn1Max);
    const followSeqs = evs.slice(mark).filter((e) => e.seq != null).map((e) => e.seq);
    expect(followSeqs.length, "the follow-up made a seq'd tool step").toBeGreaterThan(0);
    expect(followSeqs.every((sq) => !turn1Seqs.has(sq)), "follow-up seqs don't collide with turn 1's").toBe(true);
    await page.close();
});

// Durable resume: a background run snapshots to storage each step, so an SW evicted mid-run rehydrates and
// AUTO-CONTINUES when its page re-adopts. We pause the run at an approval gate, simulate eviction (drop
// in-memory state + rehydrate, exactly what a respawn does), then reload → the run picks up from its
// checkpoint. (A real MV3 eviction is ~30s of idle; __mlEvictForTest is the SW-realm-only test shortcut.)
test("durable resume: an SW-evicted run rehydrates and continues when the page re-adopts", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },                              // same-origin → auto-approved, checkpointed
        { tool: "exec", args: { js: "document.title = 'X'; 'ok'" } },               // gates → the run PAUSES here
        { content: "Continued after the eviction." },                              // what the RESUME turn returns
    ]);
    await page.evaluate(() => { window.ml.agent("Go to /step2, then set the title.", { env: false, approvalRouting: "external" }); return true; });
    // It navigates (checkpointed) and pauses at the exec gate — 2 model calls so far.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/step2");
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    expect(fake.calls().length - before).toBe(2);
    // Its snapshot is on disk (durable).
    const keys = await ext.sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("ml_bgrun_")));
    expect(keys.length).toBe(1);

    // Simulate the eviction: drop all in-memory run state + rehydrate from storage (the gate-suspended loop
    // is orphaned, exactly as a real eviction leaves it — its finally never runs, so the snapshot survives).
    await ext.sw.evaluate(() => globalThis.__mlEvictForTest());
    expect(await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).toHaveLength(0);   // the gate is gone

    // Reload → CONTENT_READY → re-adopt with resume:true → the run continues from its checkpoint (past the
    // navigate) → the RESUME turn (3rd call) returns the final answer. No re-gate (the fake advanced past exec).
    await page.reload();
    await waitForMl(page);
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);   // the run made a NEW model call → it resumed
    expect((fake.calls().at(-1).messages || []).some((m) => typeof m.content === "string" && /step2|Go to/.test(m.content))).toBe(true);   // it carried the pre-eviction history
    await page.close();
});

// REPRO of the reported vanish: a CROSS-ORIGIN nav to a not-yet-granted site pops Chrome's native site-access
// grant, and granting it can CYCLE the MV3 service worker mid-nav (re-registering content scripts). We model
// that as: approve the cross-origin nav → it lands → EVICT the SW (drops in-memory bgRuns/activeRuns, like a
// real restart) → the grant re-injects the CS (a fresh CONTENT_READY = a reload). The run must RECOVER via
// durable resume and continue on the destination origin, not vanish.
test("cross-domain durable resume: an SW restart during the cross-origin nav (site grant) recovers on the destination", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },   // cross-origin → gates for consent
        { tool: "findByText", args: { text: "XDOMAIN" } },             // runs ON the destination after re-adopt
        { content: "Continued after the grant restarted the worker." },
    ]);
    await page.evaluate((cross) => { window.ml.agent(`Go to ${cross} and read the code.`, { env: false, crossOrigin: true, approvalRouting: "external" }); return true; }, site.crossOrigin);
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);   // approve the crossing
    await expect.poll(() => new URL(page.url()).host, { timeout: 20000 }).toBe(new URL(site.crossOrigin).host);   // it landed on the other origin

    // The site grant restarts the worker mid-nav → drop in-memory state (durable snapshot survives on disk).
    await ext.sw.evaluate(() => globalThis.__mlEvictForTest());
    // The grant re-injects the content script = a fresh CONTENT_READY on the destination origin.
    await page.reload();
    await waitForMl(page);
    // The run must RECOVER and finish (findByText + answer) — not vanish.
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBeGreaterThanOrEqual(3);
    await page.close();
});

// The debug SURFACE (inline sidebar / off card / devtools panel — same app) must show the run's FULL history
// on the destination page after a nav, not just post-nav steps: the overlay shell mounts fresh per page and
// gets the run's replayed history (runReplayBuffer) on re-adopt. Here we assert the rendered steps directly.
test("cross-page: the inline sidebar renders the run's history (incl. pre-nav steps) on the destination page", async () => {
    await configureExtension(ext.sw, { debugMode: "overlay" });   // inline sidebar surface
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        { content: "The code is CROSSPAGE-9471." },
    ]);
    const before = fake.calls().length;
    await page.evaluate(() => { window.ml.agent("Go to step 2 and read the code shown there.", { env: false }); return true; });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/step2");   // it navigated
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);           // …and finished (3 turns)

    // The overlay sidebar iframe on the DESTINATION page. Its rendered steps must include the PRE-NAV navigate
    // step (emitted while on "/", replayed on re-adopt) AND the far-page findByText step — proving the fresh
    // sidebar rebuilt the whole run, not just what happened after the navigation.
    // Re-find the LIVE sidebar iframe each poll — a same-origin nav detaches the old origin's iframe, so a
    // fixed reference reads a stale/empty frame (the brittle `find()` that made this flake).
    const liveSidebar = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    // The run's session appears in the sidebar list — its history reached the FRESH page's sidebar (via the
    // replay-on-readopt, buffered until the iframe app handshakes; without that it showed "Sessions (0)").
    await expect.poll(async () => { const f = liveSidebar(); return f ? await f.locator(".row").count() : 0; }, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    // Open the collapsed overlay panel (its tab handle lives in the shell shadow root), then open the session
    // row from INSIDE the poll (the fresh iframe can miss an early click while it's still handshaking) → the
    // detail shows the STEPS, incl. the PRE-NAV navigate step (replayed) AND the far-page findByText step.
    await page.locator("#ml-sb-tab").click();
    await expect.poll(async () => {
        const f = liveSidebar();
        if (!f) return 0;
        try { const rows = f.locator(".row"); if (await rows.count()) await rows.first().click().catch(() => {}); return await f.locator(".astep").count(); }
        catch { return 0; }
    }, { timeout: 12000 }).toBeGreaterThanOrEqual(2);
    const detail = ((await liveSidebar().locator("body").textContent()) || "").toLowerCase();
    expect(detail).toContain("navigate");     // pre-nav step, replayed onto the destination page's sidebar
    expect(detail).toContain("findbytext");   // the far-page step

    await configureExtension(ext.sw, { debugMode: "off" });   // restore for any later run
    await page.close();
});

// Orient-on-nav: the `navigate` tool's RESULT carries the DESTINATION page's pageInfo, so the model's next
// turn already knows where it landed (no wasted look()/pageInfo turn). The fake sees every message, so we
// assert the navigate tool result the model receives is enriched with the new page's URL/title.
test("navigate verify:'text' folds the destination page's Markdown into the tool result (fetch_url's HTML→MD)", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step3", verify: "text" } },   // distil the destination to Markdown
        { content: "done" },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 3 and show me the page as text.", { env: false }); return true; });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/step3");
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);
    // The 2nd turn's history holds the navigate result WITH /step3 converted to Markdown (nav/chrome + <style> stripped).
    const msgs = fake.calls().at(-1).messages || [];
    const toolMsg = [...msgs].reverse().find((m) => m.role === "tool");
    const seen = toolMsg ? (typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content)) : "";
    expect(seen).toMatch(/Markdown/);            // the verify-text header
    expect(seen).toMatch(/CROSSPAGE-9471/);      // the destination page's actual content, converted
    expect(seen).not.toMatch(/<style|<h1/);      // it's Markdown, not raw HTML tags
    await page.close();
});

test("orient-on-nav: the navigate tool result carries the destination page's context to the model", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { content: "done" },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 2.", { env: false }); return true; });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/step2");
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);   // it navigated, then answered
    // The 2nd model turn's history holds the navigate tool result — enriched with /step2's pageInfo (URL/title).
    const joined = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(joined).toContain("You are now on the new page");   // the orient-on-nav preamble
    expect(joined).toMatch(/\/step2/);                          // pageContext's `URL:` line for the destination
    await page.close();
});

// The destination-page sidebar must reflect COMPLETION: when a background run finishes after a nav, the
// detail shows the ANSWER and clears the "running" footer. (Bug: after a cross-DOMAIN nav the run completed —
// the HUD card showed the answer — but the overlay detail on the new origin stayed "running · N steps" with
// no answer, i.e. agent-result never landed on the destination page's sidebar.)
test("cross-domain: the destination-origin sidebar shows the ANSWER and clears 'running' when the run completes", async () => {
    await configureExtension(ext.sw, { debugMode: "overlay" });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    fake.setScript([
        { tool: "navigate", args: { url: site.crossOrigin + "/" } },   // a DIFFERENT origin (different port)
        { tool: "findByText", args: { text: "XDOMAIN" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/XDOMAIN-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    const before = fake.calls().length;
    await page.evaluate((cross) => { window.ml.agent(`Go to ${cross} and read the code shown there.`, { env: false, crossOrigin: true, approvalRouting: "external" }); return true; }, site.crossOrigin);
    // Approve the cross-origin consent gate so it actually crosses.
    await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 15000 }).toBe(1);
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await expect.poll(() => new URL(page.url()).host, { timeout: 20000 }).toBe(new URL(site.crossOrigin).host);   // it crossed
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);                             // …and finished (3 turns)

    // The overlay sidebar iframe on the DESTINATION ORIGIN. After a cross-origin nav the old origin's iframe
    // detaches, so re-find the LIVE one each poll (a stale reference reads an empty body → false failures).
    const liveSidebar = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await page.locator("#ml-sb-tab").click();   // open the collapsed overlay panel
    // The finished run's ANSWER shows on the destination origin. Open the session row from INSIDE the poll: the
    // freshly-mounted cross-origin app can miss a single early click (it's still handshaking/replaying), so keep
    // clicking the row until the detail (with the answer) is up — idempotent once we're in the detail (no .row).
    await expect.poll(async () => {
        const f = liveSidebar();
        if (!f) return "";
        try {
            const rows = f.locator(".row");
            if (await rows.count()) await rows.first().click().catch(() => {});
            return (await f.locator("body").textContent()) || "";
        } catch { return ""; }
    }, { timeout: 15000 }).toContain("XDOMAIN-2025");
    // …and the "running" footer is gone (it completed, it isn't still working).
    expect(await liveSidebar().locator(".pending-note").count(), "no 'running' footer on a completed run").toBe(0);

    await configureExtension(ext.sw, { debugMode: "off" });
    await page.close();
});

// The composer's Stop button must CANCEL a background-hosted run cross-page. After a nav the run's page-side
// AgentHandle is dead (the run re-adopted as an agentRegistry entry keyed by hash), so a Stop that only
// consulted handleRegistry was inert — the run stayed stuck "waiting for your approval…" with no way out.
// The fix: with no local handle but a re-adopted background run present, relay CANCEL_RUN.
test("cross-page: the composer Stop cancels a background run blocked on an approval gate after a nav", async () => {
    await configureExtension(ext.sw, { debugMode: "overlay" });   // background-hosted + an in-page approval surface
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        // A WRITE (assignment) — NOT a read-only survey, so it can't auto-approve; it blocks the run on the gate.
        { tool: "exec", args: { js: "document.title = 'changed'; 1" } },
        { content: "should never be reached — the run is cancelled at the gate" },
    ]);
    const before = fake.calls().length;
    await page.evaluate(() => { window.ml.agent("Go to step 2, then run some code.", { env: false }); return true; });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/step2");   // it navigated
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(2);            // …and reached the exec turn, then blocked

    const sb = page.frames().find((f) => f.url().includes("sidebar.html"));
    expect(sb, "the overlay sidebar iframe is present on the destination page").toBeTruthy();
    await expect.poll(async () => await sb.locator(".row").count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    await page.locator("#ml-sb-tab").click();     // open the collapsed overlay panel
    // Blocked on the gate → the composer shows Stop (running + empty box). The freshly re-adopted destination
    // page can miss a single early .row click (still handshaking/replaying), so re-click INSIDE the poll until
    // the detail — and its Stop button — is up (idempotent once we're in the detail). Mirrors the XDOMAIN test.
    await expect.poll(async () => {
        try {
            const rows = sb.locator(".row");
            if (await rows.count()) await rows.first().click().catch(() => {});
            return await sb.locator(".cbtn.cstop").count();
        } catch { return 0; }   // app mid-remount → try again next poll
    }, { timeout: 15000 }).toBe(1);
    // …and the run says it's waiting.
    await expect.poll(async () => ((await sb.locator("body").textContent()) || "").toLowerCase(), { timeout: 10000 })
        .toContain("waiting for your approval");

    // Click Stop → __mlCancelSession → (fix) CANCEL_RUN → the background aborts the run's controller AND resolves
    // the open gate → the loop resolves { cancelled } and the destination-page sidebar clears to "cancelled".
    await sb.locator(".cbtn.cstop").click();
    await expect.poll(async () => ((await sb.locator("body").textContent()) || "").toLowerCase(), { timeout: 10000 })
        .toContain("cancelled");
    expect(((await sb.locator("body").textContent()) || "").toLowerCase()).not.toContain("waiting for your approval");
    expect(fake.calls().length - before, "the gated exec never ran, so no 3rd model turn fired").toBe(2);

    await configureExtension(ext.sw, { debugMode: "off" });   // restore for any later run
    await page.close();
});

// button #3 ("Approve + remember") end-to-end through the REAL overlay UI: an exec whose inline ml.fetch is a
// literal URL opens a gate that offers the extra button; clicking it must PERSIST that URL's consent for the
// session, so a LATER fetch_url of the same URL auto-approves (no second gate) and the run completes. This
// exercises the whole path — the rendered button, the unforgeable SET_APPROVAL(persist) forward, the
// background's static re-extraction + persistGrants, and the consent → auto-approve — in a real Chromium.
test("button #3 (overlay UI): clicking 'Approve + remember' persists the URL — a later fetch of it auto-approves", async () => {
    await configureExtension(ext.sw, { debugMode: "overlay" });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const raw = site.url + "/data.json";
    fake.setScript([
        // Turn 1: an exec that fetches the URL as a LITERAL — egress, so it can't auto-approve → the gate opens
        // with the "Approve + remember" control (button #3 extracted the literal background-side).
        { tool: "exec", args: { js: `const r = await ml.fetch(${JSON.stringify(raw)}); r.type` } },
        // Turn 2: a standalone fetch_url to the SAME url. If button #3 persisted it, this AUTO-approves (no gate).
        { tool: "fetch_url", args: { url: raw } },
        { content: "done — fetched twice" },
    ]);
    const before = fake.calls().length;
    await page.evaluate((t) => { window.ml.agent(t, { env: false }); return true; }, "Fetch the file, then fetch it again.");

    const sb = page.frames().find((f) => f.url().includes("sidebar.html"));
    expect(sb, "the overlay sidebar iframe is present").toBeTruthy();
    await expect.poll(async () => await sb.locator(".row").count(), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    await page.locator("#ml-sb-tab").click();     // open the collapsed overlay panel

    // Open the run's detail + wait for the button #3 control — clicking the row from INSIDE the poll, because
    // the freshly-mounted app can miss a single early click while it's still handshaking (same as the
    // cross-origin answer test). Idempotent once the detail is up (no more `.row`).
    const remember = sb.locator(".astep-approve .appr-btn.remember");
    await expect.poll(async () => {
        const rows = sb.locator(".row");
        if (await rows.count()) await rows.first().click().catch(() => {});
        return await remember.count();
    }, { timeout: 15000 }).toBe(1);
    // The collapsed grant card unfurls exactly the URL being remembered.
    await sb.locator(".astep-approve .appr-grant summary").click();
    await expect.poll(async () => (await sb.locator(".astep-approve .grant-url-list code").allTextContents()), { timeout: 5000 }).toContain(raw);

    await remember.click();   // Keep (approve + remember)

    // The run reaches the final answer: turn 2's fetch_url auto-approved off the persisted consent (had button
    // #3 not persisted, turn 2 would have opened a SECOND gate and the run would sit blocked at 2 calls).
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(3);
    await expect.poll(async () => ((await sb.locator("body").textContent()) || "").toLowerCase(), { timeout: 10000 }).toContain("fetched twice");
    expect(((await sb.locator("body").textContent()) || "").toLowerCase(), "no second gate — the repeat fetch auto-approved").not.toContain("waiting for your approval");

    await configureExtension(ext.sw, { debugMode: "off" });   // restore for later tests
    await page.close();
});

// Backend unreachable — a DEAD BOX must read at a glance in BOTH surfaces. Point the extension at a
// connection-refused URL, start a run (it fails on the first model call), and assert the offline treatment.
// (Skipped under a real backend, which by definition is reachable.)
test("backend offline (HUD card): a dead backend surfaces a 'Backend unreachable' card", async () => {
    test.skip(!!BACKEND, "real-backend mode: the backend is up, nothing is unreachable");
    const dead = await deadBackendUrl();
    await configureExtension(ext.sw, { chatUrl: dead, debugMode: "off" });   // off mode → the corner HUD card
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { window.ml.agent("Say hi.", { env: false }).catch(() => {}); return true; });

    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    // The dead box surfaces as the offline card ("Backend unreachable") or, while collapsed, the offline orb
    // ("Backend down") — either is the fix (vs the old silent "Starting…" that hung forever).
    await expect.poll(async () => { const f = card(); try { return f ? ((await f.locator("body").textContent()) || "") : ""; } catch { return ""; } }, { timeout: 25000 }).toMatch(/Backend (unreachable|down)/i);

    await configureExtension(ext.sw, { chatUrl: fake.url, debugMode: "off" });   // restore for later tests
    await page.close();
});

test("backend offline (overlay panel): a dead backend surfaces the top offline banner", async () => {
    test.skip(!!BACKEND, "real-backend mode: nothing is unreachable");
    const dead = await deadBackendUrl();
    await configureExtension(ext.sw, { chatUrl: dead, debugMode: "overlay" });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { window.ml.agent("Say hi.", { env: false }).catch(() => {}); return true; });

    const sb = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await page.locator("#ml-sb-tab").click();   // open the overlay panel (banner is in the app body regardless)
    await expect.poll(async () => { const f = sb(); try { return f ? await f.locator(".backend-offline").count() : 0; } catch { return 0; } }, { timeout: 25000 }).toBeGreaterThanOrEqual(1);
    await expect(sb().locator(".backend-offline")).toContainText("Backend unreachable");

    await configureExtension(ext.sw, { chatUrl: fake.url, debugMode: "off" });   // restore
    await page.close();
});

// The server dies MID-run: a step completes, THEN the box vanishes. The run must surface offline (not hang or
// vanish) and keep the completed step. Covers the "what if the server randomly dies during a run" case.
test("backend offline (mid-run): a server that dies after a step surfaces offline and keeps the progress", async () => {
    test.skip(!!BACKEND, "real-backend mode: the backend stays up");
    const dying = await startDyingBackend();
    await configureExtension(ext.sw, { chatUrl: dying.url, debugMode: "overlay" });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { window.ml.agent("Find the Step text, then summarise.", { env: false }).catch(() => {}); return true; });

    const sb = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    // The run started (a session materialised) and then the box died → the offline state surfaces instead of
    // the run hanging silently. (Step-level preservation is covered deterministically by the jsdom mid-run test.)
    await page.locator("#ml-sb-tab").click().catch(() => {});
    await expect.poll(async () => { const f = sb(); try { return f ? await f.locator(".row").count() : 0; } catch { return 0; } }, { timeout: 25000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => { const f = sb(); try { return f ? await f.locator(".backend-offline").count() : 0; } catch { return 0; } }, { timeout: 25000 }).toBeGreaterThanOrEqual(1);

    await dying.stop().catch(() => {});
    await configureExtension(ext.sw, { chatUrl: fake.url, debugMode: "off" });   // restore
    await page.close();
});

// answer → HUD: a designated element's SCREENSHOT renders in the "Task complete" card (the user-facing
// deliverable). off mode → the corner HUD card is that surface; the debug sidebar deliberately shows none of
// it. This proves the real capture → HUD-render pipeline end-to-end in a browser (single + MULTIPLE elements).
test("answer → HUD: designated elements' screenshots render in the completion card (multiple)", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/step3");   // a page with several visible <p> elements
    await waitForMl(page);
    fake.setScript([
        { tool: "answer", args: { selector: "p", note: "the paragraphs" } },   // a selector matching MULTIPLE → a gallery
        { content: "Returned the paragraphs." },
    ]);
    // A background-hosted run (off mode + the default toolset's exec ⚠) → the corner HUD card surfaces it.
    await page.evaluate(() => { window.ml.agent("Return the paragraphs as the answer.", { env: false }); return true; });

    // The HUD card iframe (sidebar.html) shows the answer-media gallery with REAL screenshot crops (data URLs).
    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? await f.locator(".card-answer-media img").count() : 0; } catch { return 0; } }, { timeout: 25000 }).toBeGreaterThanOrEqual(2);
    const imgs = card().locator(".card-answer-media img");
    const n = await imgs.count();
    expect(n, "the answer-media gallery is capped").toBeLessThanOrEqual(6);
    for (let i = 0; i < n; i++) expect(await imgs.nth(i).getAttribute("src"), "each is a real captured crop").toMatch(/^data:image\//);
    await page.close();
});

// HUD maximise (#2b): a button on the completion card grows it into a near-full-page CORNER WINDOW (a margin
// left so the page shows through — NOT a full-page override), and back. The button lives in the card iframe;
// the shell sizes the container (#ml-sb-card-wrap, in an OPEN shadow root Playwright pierces).
test("HUD maximise: the completion card grows to a near-full-page corner window and back", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/step3");
    await waitForMl(page);
    fake.setScript([{ content: "Done." }]);
    await page.evaluate(() => { window.ml.agent("Say done.", { env: false }); return true; });

    // The off-mode HUD card iframe. The Maximise button appears once the run is done + expanded.
    const card = () => page.frames().filter((f) => f.url().includes("sidebar.html") && !f.isDetached()).pop();
    await expect.poll(async () => { const f = card(); try { return f ? await f.locator('.card-icon[aria-label="Maximise"]').count() : 0; } catch { return 0; } }, { timeout: 20000 }).toBe(1);

    const wrap = page.locator("#ml-sb-card-wrap");
    await expect.poll(async () => await wrap.getAttribute("data-state"), { timeout: 5000 }).toBe("expanded");
    const vw = await page.evaluate(() => window.innerWidth);

    // Maximise → a corner window ~90% of the viewport width (wide, but a margin remains — not full-page).
    // Re-click INSIDE the poll (like the Minimise half below): a single click can race the card's re-render
    // (the Maximise↔Minimise button swaps just as the run settles), swallowing it and leaving it "expanded".
    await expect.poll(async () => {
        try {
            const f = card();
            if (f) await f.locator('.card-icon[aria-label="Maximise"]').click({ timeout: 500 }).catch(() => {});
            return await wrap.getAttribute("data-state");
        } catch { return null; }
    }, { timeout: 8000 }).toBe("maximized");
    await expect.poll(async () => await wrap.evaluate((el) => el.getBoundingClientRect().width), { timeout: 3000 }).toBeGreaterThan(vw * 0.8);
    const w = await wrap.evaluate((el) => el.getBoundingClientRect().width);
    expect(w, "a corner window, not a full-page override").toBeLessThan(vw);

    // Minimise → back to the compact expanded card. Re-click INSIDE the poll: a single click can race the
    // card's re-render (the Maximise↔Minimise button swaps), leaving it stuck "maximized" (a flaky red).
    await expect.poll(async () => {
        try {
            const f = card();
            if (f) await f.locator('.card-icon[aria-label="Minimise"]').click({ timeout: 500 }).catch(() => {});
            return await wrap.getAttribute("data-state");
        } catch { return null; }
    }, { timeout: 8000 }).toBe("expanded");
    await page.close();
});
