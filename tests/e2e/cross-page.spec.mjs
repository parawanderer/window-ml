// cross-page.spec.mjs — end-to-end (real Chromium + the built extension) tests for cross-page agent
// persistence. Deterministic by default: a scripted fake-LLM stands in for the model, so the REAL pipeline
// (background loop → tool delegation → page) runs with no Ollama. Point at a real backend with:
//     E2E_BACKEND=http://localhost:3000/api/chat/completions  E2E_MODEL=qwen3:32b  npm run test:e2e
// (then the scripted turns are ignored and the real model drives — slower, non-deterministic).

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

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
    await sb.locator(".row").first().click();     // open the run's detail
    // Blocked on the gate → the composer shows Stop (running + empty box), and the run says it's waiting.
    await expect.poll(async () => await sb.locator(".cbtn.cstop").count(), { timeout: 10000 }).toBe(1);
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
    await card().locator('.card-icon[aria-label="Maximise"]').click();
    await expect.poll(async () => await wrap.getAttribute("data-state"), { timeout: 5000 }).toBe("maximized");
    await expect.poll(async () => await wrap.evaluate((el) => el.getBoundingClientRect().width), { timeout: 3000 }).toBeGreaterThan(vw * 0.8);
    const w = await wrap.evaluate((el) => el.getBoundingClientRect().width);
    expect(w, "a corner window, not a full-page override").toBeLessThan(vw);

    // Minimise → back to the compact expanded card.
    await card().locator('.card-icon[aria-label="Minimise"]').click();
    await expect.poll(async () => await wrap.getAttribute("data-state"), { timeout: 5000 }).toBe("expanded");
    await page.close();
});
