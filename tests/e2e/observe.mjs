// observe.mjs — a standalone "let me watch a run end-to-end" harness so I (Claude) can debug the real
// extension in a real browser by reading ARTIFACTS: the extension's OWN markdown transcript (run.md, via
// serializeSession) + run.json (the machine-readable export) + a screenshot per step + the raw
// event stream. Not a test — a debug tool.
//
//   node --import tsx tests/e2e/observe.mjs                 # deterministic: scripted fake-LLM
//   E2E_BACKEND=<chatUrl> E2E_MODEL=<id> TASK="…" node --import tsx tests/e2e/observe.mjs   # real model
//   (with .env holding OPENWEBUI_URL/KEY/MODEL, pass USE_ENV=1 to use it as the backend)
//
// Writes tests/e2e/artifacts/: run.md (canonical), transcript.txt, events.json, step-<n>.png, final.png.

import "../stub-css.mjs";   // export.ts imports a bundled .css → stub it (both loader paths) before the import below
const { serializeSession } = await import("../../sidebar/export.ts");
const { serializeSessionJson } = await import("../../sidebar/export-json.ts");

import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One timestamped (or RUN_LABEL) subdir per run, so successive runs — e.g. before vs. after a fix — are
// kept side by side to diff, not overwritten. `artifacts/latest.txt` records the newest for convenience.
const RUN = process.env.RUN_LABEL || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ARTROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "artifacts");
const ART = path.join(ARTROOT, RUN);

// Backend: E2E_BACKEND (explicit chatUrl) or USE_ENV=1 (read OPENWEBUI_* from .env), else the fake-LLM.
async function resolveBackend() {
    if (process.env.E2E_BACKEND) return { chatUrl: process.env.E2E_BACKEND, model: process.env.E2E_MODEL || "", key: process.env.E2E_KEY || "" };
    if (process.env.USE_ENV) {
        const env = Object.fromEntries((await readFile(path.resolve(".env"), "utf8")).split("\n")
            .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
        const base = (env.OPENWEBUI_URL || "").replace(/\/$/, "");
        return { chatUrl: `${base}/api/chat/completions`, model: process.env.E2E_MODEL || env.OPENWEBUI_MODEL || "", key: env.OPENWEBUI_KEY || "",
            utilityModel: env.OPENWEBUI_UTILITY_MODEL || "", visionModel: env.OPENWEBUI_VISION_MODEL || "" };
    }
    return null;   // → fake-LLM
}

const TASK = process.env.TASK || "What code is shown on this page? Use findByText to locate it, then answer with just the code.";
// FOLLOWUP="…" → a SECOND turn in the SAME session (createAgent + two run()s, so both turns share the run
// hash). Reproduces multi-turn behaviour a single ml.agent() call can't — e.g. the cross-turn token-id
// collision (turn 1 computes uncited; the follow-up asks to "show the work" and cites it).
const FOLLOWUP = process.env.FOLLOWUP || "";
// The start route on the test site. Besides the cross-page chain (/, /step2, /step3) and the /slow, /lazy,
// /table … fixtures, EVERY real example page is served (START=/spreadsheet, /find-waldo, /canvas-input, … —
// see GET /examples for the list), so a probe can drive the exact page a human uses.
const START = process.env.START || "/step3";
// TOOLS=findByText,answer → run the agent with only that subset of the default domTools (shrinks the
// system prompt + schemas; useful under a tight free-tier token/min limit). Unset → the full default kit.
const TOOLS = process.env.TOOLS ? process.env.TOOLS.split(",").map((s) => s.trim()).filter(Boolean) : null;

// Warm the model(s) into VRAM BEFORE the timed run, so timings measure inference, not the cold ~20GB load.
// A single 1-token completion forces the load; we report how long it took. Skip with WARM=0. By default we
// warm only the MAIN model (multiple large models rarely co-resident — warming all would just thrash the
// last one out on the first real call); WARM_ALL=1 also warms utility + vision (for a run that uses them).
async function warmUp(chatUrl, key, models) {
    const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    for (const m of models.filter(Boolean)) {
        const t0 = Date.now();
        try {
            const res = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ok" }], max_tokens: 1, stream: false }) });
            await res.text();
            console.log(`  warmed ${m} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) { console.log(`  warm ${m} failed: ${String(e).slice(0, 80)}`); }
    }
}

// Scripted turns for the fake-LLM (ignored with a real backend): read the code, then answer it.
const SCRIPT = [
    { tool: "findByText", args: { text: "CROSSPAGE" } },
    (req) => {
        const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
        const m = seen.match(/CROSSPAGE-\d+/);
        return { content: m ? `The code is ${m[0]}.` : "I couldn't find a code on this page." };
    },
];

// Rebuild a sidebar Session from the raw debug events (the agent branches of app.tsx onDebug), so
// serializeSession produces the exact markdown the "Export log" button would.
function buildSession(events) {
    const map = new Map();
    const maxStep = (s) => Math.max(0, ...(s.steps || []).map((x) => x.step || 0));
    for (const ev of events) {
        const s = map.get(ev.session?.hash);
        if (ev.kind === "agent") {
            map.set(ev.session.hash, {
                hash: ev.session.hash, model: ev.model, tag: "session", kind: "agent",
                createdTs: ev.ts, lastTs: ev.ts, status: "pending", turns: [], steps: [], task: ev.task,
                taskImages: ev.images, maxSteps: ev.maxSteps, agentConfig: ev.config,
                config: { system: null, model: ev.model, think: null, schema: false, toolIds: null, maxTokens: null, save: false },
            });
        } else if (ev.kind === "agent-step" && s) {
            const step = { step: ev.step, localStep: ev.localStep, seq: ev.seq, pending: ev.pending, awaitingApproval: ev.awaitingApproval, thought: ev.thought, reasoning: ev.reasoning, tool: ev.tool, arguments: ev.arguments, result: ev.result, modelResult: ev.modelResult, token: ev.token, elements: ev.elements, renderIn: ev.renderIn, renderOut: ev.renderOut, feedback: ev.feedback, argIssues: ev.argIssues, approval: ev.approval, usage: ev.usage, subUsage: ev.subUsage };
            const steps = s.steps || [];
            const i = ev.seq != null ? steps.findIndex((x) => x.seq === ev.seq) : -1;
            const merged = i >= 0 ? { ...step, renderIn: step.renderIn ?? steps[i].renderIn, renderOut: step.renderOut ?? steps[i].renderOut } : step;
            s.steps = i >= 0 ? steps.map((x, k) => (k === i ? merged : x)) : [...steps, step];
            if (!s.ended || (ev.step || 0) > (s.endedStep ?? -1)) { s.status = "pending"; s.ended = false; }
            s.lastTs = ev.ts;
        } else if (ev.kind === "agent-result" && s) {
            const status = (ev.error || ev.hitCap || ev.cancelled) ? "err" : "ok";
            s.answers = [...(s.answers || []), { text: ev.summary, ts: ev.ts, atStep: maxStep(s), status, hitCap: ev.hitCap, cancelled: !!ev.cancelled, error: ev.error || undefined }];
            s.summary = ev.summary; s.hitCap = ev.hitCap; s.error = ev.error || undefined; s.cancelled = !!ev.cancelled; s.status = status; s.lastTs = ev.ts; s.ended = true; s.endedStep = maxStep(s);
            s.answer = ev.answer || undefined; s.answerMedia = (ev.answerMedia && ev.answerMedia.length) ? ev.answerMedia : undefined;   // the bottom-of-answer Result block + card media
        } else if (ev.kind === "agent-say" && s) {
            s.says = [...(s.says || []), { text: ev.text, ts: ev.ts, atStep: maxStep(s), images: ev.images }]; s.status = "pending"; s.ended = false; s.lastTs = ev.ts;
        } else if (ev.kind === "agent-cap" && s) {
            s.maxSteps = ev.maxSteps; s.lastTs = ev.ts;
        }
    }
    return [...map.values()].find((s) => s.kind === "agent") || null;
}

// Write events.json + the canonical run.md (+ its image sidecars), OVERWRITING, from the events so far.
// Called INCREMENTALLY on every event (chained so writes can't interleave) so a run that HANGS or DIES —
// or one you interrupt — still leaves a readable partial transcript to debug, not an empty dir. Never throws
// (a mid-run session may be partial). serializeSession is exactly the sidebar "Export log → Markdown" output.
let dumpChain = Promise.resolve();
function dumpArtifacts(events) {
    const snap = events.slice();   // freeze this tick's events so a later push can't mutate mid-write
    dumpChain = dumpChain.then(async () => {
        try {
            await writeFile(path.join(ART, "events.json"), JSON.stringify(snap, null, 2));
            const session = buildSession(snap);
            if (!session) { await writeFile(path.join(ART, "run.md"), "_(no agent events yet — is debugMode emitting?)_\n"); return; }
            const { md, images } = serializeSession(session);
            await writeFile(path.join(ART, "run.md"), md);
            // The machine-readable twin: same Session, no markdown in the way. This is the
            // format to diff two runs with — see docs/spec/PROGRAMMATIC_EXPORT.md.
            await writeFile(path.join(ART, "run.json"), serializeSessionJson(session));
            for (const img of images) {
                await mkdir(path.dirname(path.join(ART, img.name)), { recursive: true });
                await writeFile(path.join(ART, img.name), img.bytes);
            }
        } catch (e) { try { await writeFile(path.join(ART, "run.md"), `_(serializeSession failed mid-run: ${e})_\n`); } catch { /* disk gone */ } }
    });
    return dumpChain;
}

// WATCH mode: slide the overlay sidebar open, size it to HALF the viewport, and click into the session that
// was just launched — so you can watch the run in the real extension UI. The shell mounts an OPEN shadow root
// (#ml-sb-root), so the top frame can reach the panel (#ml-sb-host) + iframe (#ml-sb-frame); the app inside the
// iframe is a normal Playwright frame, so its session row (button.row) is clickable.
async function openSidebarAndFocus(page) {
    // 1. Open the panel + set width to half the page, and tell the iframe app it's open (it gates polling on that).
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 10000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    // 2. Click into the run's session row inside the app iframe (poll until the agent event has rendered it).
    const frame = await (async () => {
        for (let i = 0; i < 40 && !page.isClosed(); i++) {
            const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
            if (f) return f;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("sidebar iframe never appeared");
    })();
    // Prefer the AGENT session row (it carries the `.agent-badge`); fall back to the first row. POLL until a row
    // actually renders — the run's `agent` start event has to reach the app first, so a single early click would
    // miss it and leave the sidebar open but the run UNFOCUSED (the observed flake). Retry the click until the
    // detail view shows (a `.detail`/`.card-app` mounts), for up to ~12s.
    const agentRow = frame.locator("button.row:has(.agent-badge)").first();
    const anyRow = frame.locator("button.row").first();
    // The "Back to sessions" nav button renders only in the DETAIL view (never the list) → a reliable signal
    // we actually navigated INTO the run, not just that the list is showing.
    const inDetail = async () => (await frame.locator('button.nav[aria-label="Back to sessions"]').count()) > 0;
    await page.screenshot({ path: path.join(ART, "watch-1-list.png") }).catch(() => {});
    let focused = false;
    for (let i = 0; i < 60 && !page.isClosed() && !focused; i++) {
        const row = (await agentRow.count()) ? agentRow : ((await anyRow.count()) ? anyRow : null);
        if (row) {
            await row.click({ timeout: 2000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 250));
            if (await inDetail().catch(() => false)) { focused = true; break; }
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 400));   // let the detail view paint
    await page.screenshot({ path: path.join(ART, "watch-2-detail.png") }).catch(() => {});
    console.log(focused ? "  sidebar: opened at half width, focused on the session."
        : "  sidebar: opened, but no session row appeared to focus (run may not have started yet).");
}

// Approval handling. A background-hosted run BLOCKS on a privileged gate (a mutating/non-readonly exec, a
// python_exec `full` run, an external fetch/sheet). The harness would otherwise hang there silently (the
// "did not complete" bug). So it watches the SW-only `__mlApprovals` channel (the same door approval.spec.mjs
// drives), LOGS every gate the moment a run halts on one, and resolves it per the APPROVE policy:
//   APPROVE=auto (default) approve everything · deny  deny everything · readonly  approve exec + readonly
//   python, deny the rest · hold  LOG but DON'T resolve (leave it for a manual click — WATCH mode review).
// Gates are only visible/resolvable because the run opts in with approvalRouting:"both" (below).
const APPROVE = (process.env.APPROVE || "auto").toLowerCase();
const approvalLog = [];
let approvalLoopOn = true;
function decideApproval(d) {
    if (APPROVE === "deny") return false;
    if (APPROVE === "readonly") return d.tool === "exec" || (d.tool === "python_exec" && d.arguments?.mode !== "full");
    return true;   // auto
}
async function runApprovalLoop(sw) {
    const seen = new Set();
    while (approvalLoopOn) {
        let gates = [];
        try { gates = await sw.evaluate(() => globalThis.__mlApprovals?.list?.() ?? []); } catch { /* SW asleep / navigating */ }
        for (const g of gates) {
            if (seen.has(g.key)) continue;
            seen.add(g.key);
            const argstr = JSON.stringify(g.arguments ?? {}).slice(0, 200);
            if (APPROVE === "hold") { console.log(`  ⏸ APPROVAL GATE (step ${g.step}) — ${g.tool}(${argstr})  [APPROVE=hold → left for a manual click]`); approvalLog.push({ tool: g.tool, arguments: g.arguments, decision: "held", step: g.step }); continue; }
            const decision = decideApproval(g);
            console.log(`  ⏸ APPROVAL GATE (step ${g.step}) — ${g.tool}(${argstr}) → ${decision ? "APPROVE" : "DENY"}  [APPROVE=${APPROVE}]`);
            approvalLog.push({ tool: g.tool, arguments: g.arguments, decision: decision ? "approved" : "denied", step: g.step });
            try { await sw.evaluate(({ key, d }) => globalThis.__mlApprovals.resolve(key, d), { key: g.key, d: decision }); }
            catch (e) { console.log(`  (approval resolve failed: ${String(e).slice(0, 80)})`); }
        }
        await new Promise((r) => setTimeout(r, 350));
    }
}

const main = async () => {
    await mkdir(ART, { recursive: true });   // never rm the root — keep prior runs to diff

    const backend = await resolveBackend();
    const fake = backend ? null : await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: backend ? backend.chatUrl : fake.url,
        apiKey: backend?.key || "",
        apiFormat: "openai",
        model: backend ? backend.model : "fake-model",
        utilityModel: backend?.utilityModel || "",
        ocrModel: backend?.visionModel || "",
        modelFilter: "",
        autoApprovePython: true,   // wire python_exec (auto-approve readonly) so a DataFrame/table probe can run
        debugMode: "overlay",   // so injected emitDebug posts the event stream to the page window
    });
    if (fake) fake.setScript(SCRIPT);

    // Warm the model(s) into VRAM before timing, so the slow one-time ~20GB load doesn't pollute the run
    // measurement. Only meaningful for a real backend; the fake needs none. (Ollama's keep-alive TTL means
    // successive runs within the window are already warm — only the first after an eviction pays the load.)
    if (backend && process.env.WARM !== "0") {
        const warm = [backend.model];
        if (process.env.WARM_ALL) warm.push(backend.utilityModel, backend.visionModel);
        console.log("  warming up…");
        await warmUp(backend.chatUrl, backend.key, warm);
    }

    const page = await ext.context.newPage();
    const transcript = [];
    page.on("console", (m) => { transcript.push({ kind: "console", type: m.type(), text: m.text() }); if (m.type() === "error") console.log(`  [page console.error] ${m.text().slice(0, 300)}`); });
    page.on("pageerror", (e) => { transcript.push({ kind: "pageerror", text: String(e) }); console.log(`  [pageerror] ${String(e).slice(0, 300)}`); });

    // Collect the extension's debug event stream NODE-side, via a bridge re-attached on EVERY document
    // (addInitScript) so it survives a cross-page navigation — a page-context array would be wiped each
    // reload, losing every event after the first nav.
    const collected = [];
    // Push + re-dump run.md/events.json on EVERY event, so an interrupted/hung/dead run still leaves a
    // readable partial transcript (this was the gap: artifacts only wrote at the very end).
    await page.exposeFunction("__obsEvent", (ev) => { collected.push(ev); dumpArtifacts(collected); });
    await page.addInitScript(() => {
        // TOP frame only: addInitScript runs in EVERY frame, and the overlay's sidebar iframe ALSO receives
        // __mlDebug messages — capturing there too would double every event (same seq twice).
        if (window.top !== window) return;
        window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__obsEvent(e.data.__mlDebug); });
    });

    let n = 0;
    await page.exposeFunction("__obsStep", async (step) => {
        n += 1;
        const url = page.url();
        transcript.push({ kind: "step", n, url, ...step });
        try { await page.screenshot({ path: path.join(ART, `step-${n}.png`) }); } catch { /* mid-nav */ }
        console.log(`  step ${n}: ${step.tool ? `tool ${step.tool}` : "thought"}${step.result ? ` → ${String(step.result).slice(0, 70)}` : ""}  @ ${url}`);
    });

    console.log(`\n  observing: "${TASK}"\n  start: ${site.url}${START}   backend: ${backend ? backend.chatUrl + ` (model ${backend.model})` : "fake-LLM"}   approvals: ${APPROVE}\n`);
    await page.goto(site.url + START);
    await waitForMl(page);

    // Watch for + resolve approval gates the whole time the run is in flight (a gate can appear at any step).
    const approvalTask = runApprovalLoop(ext.sw);

    let result, error;
    const t0 = Date.now();
    try {
        result = await page.evaluate(({ task, followup, toolNames, toolTokens, python }) => {
            const opts = {
                toolTokens,
                approvalRouting: "both",   // gates show in the UI AND are resolvable via the __mlApprovals channel (the harness's approval poller)
                onStep: (s) => window.__obsStep({
                    tool: s.tool || null, thought: s.thought || null,
                    args: s.arguments ? JSON.parse(JSON.stringify(s.arguments)) : null,
                    result: typeof s.result === "string" ? s.result : (s.result != null ? JSON.stringify(s.result) : null),
                    approval: s.approval || null,
                }),
            };
            // TOOLS=findByText,answer → limit to a subset of the default domTools (a smaller system prompt +
            // fewer schemas = far fewer tokens/turn, so a rate-limited free tier fits). vision:false stops
            // look/locate from auto-wiring back in.
            if (toolNames && toolNames.length) {
                opts.tools = (window.ml.domTools || []).filter((t) => toolNames.includes(t.name));
                opts.vision = false;
            }
            // PYTHON=1 → add python_exec (for a `{ tables }` → DataFrame probe on e.g. /spreadsheet). It's an
            // extraTool, so it survives the TOOLS subset filter above.
            if (python) opts.extraTools = [window.ml.pythonTool()];
            // ALWAYS fire the run NON-blocking — stash the promise, return immediately — so the harness can open
            // the sidebar and click into the live session WHILE it runs (the default; a human watching never has
            // to click). The result is picked up from the event stream (hasResult), so nothing is lost by not
            // awaiting here.
            if (followup) {
                // Two turns in ONE session (same run hash: createAgent persists the handle across run()s) — turn 1,
                // then the follow-up as a continuation. This is how a multi-turn "…now show the work" run behaves.
                const a = window.ml.createAgent(opts);
                window.__mlObsRun = (async () => { await a.run(task); return a.run(followup); })()
                    .catch((e) => { window.__obsErr = String((e && e.stack) || e); });
            } else {
                window.__mlObsRun = window.ml.agent(task, opts);
            }
            return null;
        }, { task: TASK, followup: FOLLOWUP, toolNames: TOOLS, toolTokens: !!process.env.TOOLTOKENS, python: !!process.env.PYTHON });
    } catch (e) { error = String(e); }
    if (error) console.log(`  [launch error] ${error.slice(0, 400)}`);

    // DEFAULT: open the overlay sidebar at HALF the page width and click into the just-launched session, so the
    // run is always focused in the real UI without a manual click. (WATCH=1 additionally HOLDS the browser open
    // at the end; see below.) Best-effort — a failure here never fails the run.
    await openSidebarAndFocus(page).catch((e) => console.log(`  (sidebar focus: ${e})`));
    const obsErr = await page.evaluate(() => window.__obsErr || null).catch(() => null);
    if (obsErr) console.log(`  ⚠ run threw: ${obsErr.slice(0, 400)}`);

    // A cross-page / background run's ml.agent() promise dies with the navigated-away page context (that's
    // the caught error), but the run carries on in the BACKGROUND. Wait for its terminal agent-result event
    // (via the init-script bridge, which re-attaches each document) before we snapshot final state.
    const need = FOLLOWUP ? 2 : 1;   // a follow-up run emits a SECOND agent-result — wait for both turns
    const hasResult = () => collected.filter((e) => e.kind === "agent-result").length >= need;
    if (!hasResult()) {
        const deadline = Date.now() + (FOLLOWUP ? 240000 : 120000);
        while (Date.now() < deadline && !hasResult()) await new Promise((r) => setTimeout(r, 500));
    }
    approvalLoopOn = false; await approvalTask.catch(() => {});   // stop watching for gates
    const runMs = Date.now() - t0;   // wall time of the agent run only (warm-up excluded)
    // The expected nav teardown of the caller's context isn't a failure once the run finished — surface the
    // model's summary (from the terminal event) instead of the "context destroyed" noise.
    const done = [...collected].reverse().find((e) => e.kind === "agent-result");   // the LAST turn's result (→ the follow-up's, when present)
    if (done && error && /context was destroyed|Execution context/i.test(error)) error = null;
    if (result == null && done) result = { summary: done.summary, steps: done.steps, cancelled: done.cancelled };

    try { await page.screenshot({ path: path.join(ART, "final.png") }); } catch { /* */ }
    const events = collected;
    // Final canonical write (the same incremental dump the collector ran on each event — the "Export log →
    // Markdown" output). Awaited so the artifacts are on disk before we finish.
    await dumpArtifacts(events);

    transcript.push({ kind: "result", task: TASK, finalUrl: page.url(), steps: n, runMs, error: error || null, result: result ?? null });
    await writeFile(path.join(ART, "transcript.txt"),
        transcript.map((t) => t.kind === "step" ? `STEP ${t.n} @ ${t.url}\n  ${t.tool ? `tool ${t.tool}(${JSON.stringify(t.args)})` : `thought: ${t.thought}`}${t.result ? `\n  → ${t.result}` : ""}`
            : t.kind === "result" ? `\nRESULT (${t.steps} steps, final ${t.finalUrl})\n  ${t.error ? `ERROR: ${t.error}` : JSON.stringify(t.result)}`
                : `[${t.kind}${t.type ? ":" + t.type : ""}] ${t.text}`).join("\n"));

    await writeFile(path.join(ARTROOT, "latest.txt"), RUN);   // pointer to the newest run dir
    console.log(`\n  → ${error ? `ERROR: ${error}` : "done"} in ${(runMs / 1000).toFixed(1)}s (run only). final url: ${page.url()}, ${n} steps, ${events.length} events.`);
    if (approvalLog.length) {
        const by = approvalLog.reduce((m, a) => ((m[a.decision] = (m[a.decision] || 0) + 1), m), {});
        console.log(`  approvals: ${approvalLog.length} gate(s) — ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")} (policy: ${APPROVE})`);
    }
    console.log(`  artifacts: ${path.relative(process.cwd(), ART)}/  (run.md, transcript.txt, events.json, step-*.png)\n`);

    // WATCH=1 → leave the browser + servers UP so you can inspect the session in the sidebar. Hold until the
    // window is closed (or Ctrl+C). Otherwise tear everything down as usual.
    if (process.env.WATCH && process.env.WATCH !== "0") {
        console.log(`\n  WATCH: browser is open — inspect the run in the sidebar. Close the window (or Ctrl+C) to exit.\n`);
        await new Promise((resolve) => { ext.context.on("close", resolve); process.on("SIGINT", resolve); });
    }
    await ext.close(); await fake?.stop(); await site.stop();
};

main().catch((e) => { console.error(e); process.exit(1); });
