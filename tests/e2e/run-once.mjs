// run-once.mjs — drive ONE agent run in a real Chromium and RETURN its artifacts.
//
// This is the run-driving core, extracted from observe.mjs so two CLIs can share it:
//   observe.mjs — one run, for a human watching (prints, opens the sidebar, can hold the browser open)
//   bench/      — a matrix of runs, for a machine measuring (collects, compares, never prints per-event)
//
// The split is deliberate: the core returns `{ events, session, runMd, … }` rather than only writing
// files, so a caller that wants to MEASURE a run doesn't have to re-read what it just wrote. Everything
// derives from the extension's own `__mlDebug` stream — the bench never adds instrumentation to the
// product (see docs/POINTER-IDENTIFIERS.md §6, rule 1).
//
// RE-ENTRANT by construction: every piece of run state (the dump chain, the approval log, the step
// counter) is a local, never a module global, because `--jobs N` calls this concurrently. Each call
// owns its own browser, page server and fake-LLM, so two runs cannot see each other's state.

import "../stub-css.mjs";   // export.ts imports a bundled .css → stub it (both loader paths) before the import below
const { serializeSession } = await import("../../sidebar/export.ts");

import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/** The default fake-LLM script: read the code off the page, then answer with it. */
export const DEFAULT_SCRIPT = [
    { tool: "findByText", args: { text: "CROSSPAGE" } },
    (req) => {
        const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
        const m = seen.match(/CROSSPAGE-\d+/);
        return { content: m ? `The code is ${m[0]}.` : "I couldn't find a code on this page." };
    },
];

export const DEFAULT_TASK = "What code is shown on this page? Use findByText to locate it, then answer with just the code.";

/**
 * Resolve the backend from the environment: E2E_BACKEND (an explicit chatUrl) or USE_ENV=1 (read
 * OPENWEBUI_* out of .env). Returns null when neither is set, meaning "use the fake-LLM".
 * @returns {Promise<{chatUrl: string, model: string, key: string, utilityModel?: string, visionModel?: string} | null>}
 */
export async function resolveBackendFromEnv(env = process.env) {
    if (env.E2E_BACKEND) return { chatUrl: env.E2E_BACKEND, model: env.E2E_MODEL || "", key: env.E2E_KEY || "" };
    if (env.USE_ENV) {
        const dotenv = Object.fromEntries((await readFile(path.resolve(".env"), "utf8")).split("\n")
            .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
        const base = (dotenv.OPENWEBUI_URL || "").replace(/\/$/, "");
        return {
            chatUrl: `${base}/api/chat/completions`, model: env.E2E_MODEL || dotenv.OPENWEBUI_MODEL || "", key: dotenv.OPENWEBUI_KEY || "",
            utilityModel: dotenv.OPENWEBUI_UTILITY_MODEL || "", visionModel: dotenv.OPENWEBUI_VISION_MODEL || "",
        };
    }
    return null;   // → fake-LLM
}

/**
 * Warm the model(s) into VRAM BEFORE the timed run, so timings measure inference and not the cold
 * ~20GB load. A single 1-token completion forces the load. Only meaningful for a real backend.
 */
export async function warmUp(chatUrl, key, models, log = () => {}) {
    const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    for (const m of models.filter(Boolean)) {
        const t0 = Date.now();
        try {
            const res = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ok" }], max_tokens: 1, stream: false }) });
            await res.text();
            log(`  warmed ${m} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) { log(`  warm ${m} failed: ${String(e).slice(0, 80)}`); }
    }
}

/**
 * Rebuild a sidebar Session from the raw debug events (the agent branches of app.tsx onDebug), so
 * serializeSession produces the exact markdown the "Export log" button would.
 */
export function buildSession(events) {
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

/**
 * Serialize the events to the canonical markdown + its image sidecars. Never throws — a mid-run
 * session may be partial, and a partial transcript is the whole point of dumping incrementally.
 */
export function renderRun(events) {
    const session = buildSession(events);
    if (!session) return { session: null, md: "_(no agent events yet — is debugMode emitting?)_\n", images: [] };
    try {
        const { md, images } = serializeSession(session);
        return { session, md, images };
    } catch (e) { return { session, md: `_(serializeSession failed mid-run: ${e})_\n`, images: [] }; }
}

/** A per-call artifact writer: chained so concurrent events can't interleave writes, and never throws. */
function makeDumper(artDir) {
    if (!artDir) return { dump: () => Promise.resolve(), settle: () => Promise.resolve() };
    let chain = Promise.resolve();
    const dump = (events) => {
        const snap = events.slice();   // freeze this tick's events so a later push can't mutate mid-write
        chain = chain.then(async () => {
            try {
                await writeFile(path.join(artDir, "events.json"), JSON.stringify(snap, null, 2));
                const { md, images } = renderRun(snap);
                await writeFile(path.join(artDir, "run.md"), md);
                for (const img of images) {
                    await mkdir(path.dirname(path.join(artDir, img.name)), { recursive: true });
                    await writeFile(path.join(artDir, img.name), img.bytes);
                }
            } catch { /* disk gone — a dump must never fail the run */ }
        });
        return chain;
    };
    return { dump, settle: () => chain };
}

/**
 * WATCH/focus: slide the overlay sidebar open, size it to HALF the viewport, and click into the session
 * that was just launched — so a human sees the run in the real extension UI without clicking. The shell
 * mounts an OPEN shadow root (#ml-sb-root), so the top frame can reach the panel + iframe; the app inside
 * the iframe is a normal Playwright frame, so its session row (button.row) is clickable.
 */
export async function openSidebarAndFocus(page, artDir, log = () => {}) {
    const shot = (name) => (artDir ? page.screenshot({ path: path.join(artDir, name) }).catch(() => {}) : Promise.resolve());
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 10000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
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
    // detail view shows, for up to ~12s.
    const agentRow = frame.locator("button.row:has(.agent-badge)").first();
    const anyRow = frame.locator("button.row").first();
    // The "Back to sessions" nav button renders only in the DETAIL view (never the list) → a reliable signal
    // we actually navigated INTO the run, not just that the list is showing.
    const inDetail = async () => (await frame.locator('button.nav[aria-label="Back to sessions"]').count()) > 0;
    await shot("watch-1-list.png");
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
    await shot("watch-2-detail.png");
    log(focused ? "  sidebar: opened at half width, focused on the session."
        : "  sidebar: opened, but no session row appeared to focus (run may not have started yet).");
    return focused;
}

/**
 * The approval policy. A background-hosted run BLOCKS on a privileged gate (a mutating exec, a
 * python_exec `full` run, an external fetch/sheet); without a decision the run hangs silently.
 *   auto (default) approve everything · deny  deny everything · readonly  approve exec + readonly
 *   python, deny the rest · hold  LOG but DON'T resolve (leave it for a manual click).
 */
export function decideApproval(policy, gate) {
    if (policy === "deny") return false;
    if (policy === "readonly") return gate.tool === "exec" || (gate.tool === "python_exec" && gate.arguments?.mode !== "full");
    return true;   // auto
}

/**
 * Drive one agent run end to end and return everything it produced.
 *
 * @param {object} cfg
 * @param {string} [cfg.task] the agent task
 * @param {string} [cfg.followup] a SECOND turn in the SAME session (createAgent + two run()s)
 * @param {string} [cfg.start] start route on the test site (e.g. "/spreadsheet")
 * @param {string[]|null} [cfg.tools] limit to this subset of domTools (smaller prompt), or null for the full kit
 * @param {boolean} [cfg.python] wire python_exec as an extraTool
 * @param {boolean} [cfg.toolTokens] enable tool tokens (pointers)
 * @param {object} [cfg.agentOptions] extra ml.agent options, merged last (the bench's dimension knob)
 * @param {{task: string, script: Array}|null} [cfg.seed] SEED A HISTORY before the measured turn. Turn 1 runs
 *   against the scripted fake-LLM (so it can be made to corrupt a pointer, fail a call, or capture data),
 *   then the backend is swapped to `cfg.backend` and `cfg.task` runs as a FOLLOW-UP in the same session —
 *   so a real model inherits a real history containing exactly the situation under test. Nothing is
 *   fabricated: the fault is real because the real loop produced it. `seedBoundarySeq` in the result marks
 *   where the seed ends, so metrics can score the measured turn alone.
 * @param {object|null} [cfg.backend] a real backend, or null for the scripted fake-LLM
 * @param {Array} [cfg.script] fake-LLM script (ignored with a real backend)
 * @param {string|null} [cfg.dist] a variant build directory to load instead of dist/
 * @param {string|null} [cfg.artDir] write artifacts here, incrementally; null writes nothing
 * @param {string} [cfg.approve] approval policy: auto | deny | readonly | hold
 * @param {boolean} [cfg.focusSidebar] open + focus the overlay sidebar (a human watching)
 * @param {boolean} [cfg.hold] hold the browser open at the end until the window closes
 * @param {number} [cfg.timeoutMs] how long to wait for the terminal agent-result
 * @param {(s: string) => void} [cfg.log] where progress lines go
 * @param {(ev: object) => void} [cfg.onEvent] called with every debug event as it arrives
 * @returns {Promise<{events, session, runMd, images, result, error, runMs, stepCount, approvals, transcript, finalUrl, startUrl, backendLabel, seedBoundarySeq}>}
 */
export async function runOnce(cfg = {}) {
    const {
        task = DEFAULT_TASK, followup = "", start = "/step3", tools = null,
        python = false, toolTokens = false, agentOptions = {},
        backend = null, script = DEFAULT_SCRIPT, warm = true, warmAll = false,
        dist = null, artDir = null, approve = "auto",
        focusSidebar = true, hold = false,
        timeoutMs = followup ? 240000 : 120000,
        log = () => {}, onEvent = null,
    } = cfg;

    if (artDir) await mkdir(artDir, { recursive: true });
    const { dump, settle } = makeDumper(artDir);

    // A seeded run needs the fake even WITH a real backend: turn 1 is scripted, turn 2 is the real model.
    const fake = (backend && !cfg.seed) ? null : await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension({ dist });
    let approvalLoopOn = true;
    const approvals = [];
    const transcript = [];
    const events = [];
    let stepCount = 0;

    try {
        const seed = cfg.seed || null;
        // The measured backend. While a seed turn runs we point the extension at the fake instead, and swap
        // to this one between the turns (config is just chrome.storage.sync — the session is untouched).
        const realCfg = {
            chatUrl: backend ? backend.chatUrl : fake.url,
            apiKey: backend?.key || "",
            model: backend ? backend.model : "fake-model",
        };
        const seedCfg = { chatUrl: fake.url, apiKey: "", model: "fake-model" };
        await configureExtension(ext.sw, {
            ...(seed ? seedCfg : realCfg),
            apiFormat: "openai",
            utilityModel: backend?.utilityModel || "",
            ocrModel: backend?.visionModel || "",
            modelFilter: "",
            autoApprovePython: true,   // wire python_exec (auto-approve readonly) so a DataFrame/table probe can run
            debugMode: "overlay",   // so injected emitDebug posts the event stream to the page window
        });
        if (fake) fake.setScript(seed ? seed.script : script);

        // Warm the model(s) into VRAM before timing. Only meaningful for a real backend; the fake needs none.
        // (Ollama's keep-alive TTL means successive runs within the window are already warm.)
        if (backend && warm) {
            const list = [backend.model];
            if (warmAll) list.push(backend.utilityModel, backend.visionModel);
            log("  warming up…");
            await warmUp(backend.chatUrl, backend.key, list, log);
        }

        const page = await ext.context.newPage();
        page.on("console", (m) => { transcript.push({ kind: "console", type: m.type(), text: m.text() }); if (m.type() === "error") log(`  [page console.error] ${m.text().slice(0, 300)}`); });
        page.on("pageerror", (e) => { transcript.push({ kind: "pageerror", text: String(e) }); log(`  [pageerror] ${String(e).slice(0, 300)}`); });

        // Collect the extension's debug event stream NODE-side, via a bridge re-attached on EVERY document
        // (addInitScript) so it survives a cross-page navigation — a page-context array would be wiped each
        // reload, losing every event after the first nav. Dump on EVERY event so a hung/interrupted run still
        // leaves a readable partial transcript.
        await page.exposeFunction("__obsEvent", (ev) => { events.push(ev); onEvent?.(ev); dump(events); });
        await page.addInitScript(() => {
            // TOP frame only: addInitScript runs in EVERY frame, and the overlay's sidebar iframe ALSO receives
            // __mlDebug messages — capturing there too would double every event (same seq twice).
            if (window.top !== window) return;
            window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__obsEvent(e.data.__mlDebug); });
        });

        await page.exposeFunction("__obsStep", async (step) => {
            stepCount += 1;
            const url = page.url();
            transcript.push({ kind: "step", n: stepCount, url, ...step });
            if (artDir) { try { await page.screenshot({ path: path.join(artDir, `step-${stepCount}.png`) }); } catch { /* mid-nav */ } }
            log(`  step ${stepCount}: ${step.tool ? `tool ${step.tool}` : "thought"}${step.result ? ` → ${String(step.result).slice(0, 70)}` : ""}  @ ${url}`);
        });

        const startUrl = site.url + start;
        const backendLabel = backend ? `${backend.chatUrl} (model ${backend.model})` : "fake-LLM";
        await page.goto(startUrl);
        await waitForMl(page);

        // Watch for + resolve approval gates the whole time the run is in flight (a gate can appear at any step).
        const approvalTask = (async () => {
            const seen = new Set();
            while (approvalLoopOn) {
                let gates = [];
                try { gates = await ext.sw.evaluate(() => globalThis.__mlApprovals?.list?.() ?? []); } catch { /* SW asleep / navigating */ }
                for (const g of gates) {
                    if (seen.has(g.key)) continue;
                    seen.add(g.key);
                    const argstr = JSON.stringify(g.arguments ?? {}).slice(0, 200);
                    if (approve === "hold") { log(`  ⏸ APPROVAL GATE (step ${g.step}) — ${g.tool}(${argstr})  [APPROVE=hold → left for a manual click]`); approvals.push({ tool: g.tool, arguments: g.arguments, decision: "held", step: g.step }); continue; }
                    const decision = decideApproval(approve, g);
                    log(`  ⏸ APPROVAL GATE (step ${g.step}) — ${g.tool}(${argstr}) → ${decision ? "APPROVE" : "DENY"}  [APPROVE=${approve}]`);
                    approvals.push({ tool: g.tool, arguments: g.arguments, decision: decision ? "approved" : "denied", step: g.step });
                    try { await ext.sw.evaluate(({ key, d }) => globalThis.__mlApprovals.resolve(key, d), { key: g.key, d: decision }); }
                    catch (e) { log(`  (approval resolve failed: ${String(e).slice(0, 80)})`); }
                }
                await new Promise((r) => setTimeout(r, 350));
            }
        })();

        let result = null, error = null;
        let seedBoundarySeq = -1;
        // A seeded or multi-turn run is driven from NODE, one turn at a time, so the backend can be swapped
        // between turns and the seed boundary recorded. A plain single-turn run still goes through
        // ml.agent() exactly as before — the path observe.mjs exercises stays untouched.
        const needsHandle = !!(seed || followup);
        const t0 = Date.now();
        try {
            await page.evaluate(({ task, needsHandle, toolNames, toolTokens, python, extra }) => {
                const opts = {
                    toolTokens,
                    approvalRouting: "both",   // gates show in the UI AND are resolvable via the __mlApprovals channel
                    onStep: (s) => window.__obsStep({
                        tool: s.tool || null, thought: s.thought || null,
                        args: s.arguments ? JSON.parse(JSON.stringify(s.arguments)) : null,
                        result: typeof s.result === "string" ? s.result : (s.result != null ? JSON.stringify(s.result) : null),
                        approval: s.approval || null,
                    }),
                };
                // A tools subset shrinks the system prompt + schemas (far fewer tokens/turn, so a rate-limited
                // free tier fits). vision:false stops look/locate from auto-wiring back in.
                if (toolNames && toolNames.length) {
                    opts.tools = (window.ml.domTools || []).filter((t) => toolNames.includes(t.name));
                    opts.vision = false;
                }
                // python_exec is an extraTool, so it survives the tools subset filter above.
                if (python) opts.extraTools = [window.ml.pythonTool()];
                Object.assign(opts, extra);   // caller-supplied options win (the bench's dimension knob)
                // ALWAYS fire a turn NON-blocking — stash the promise, return immediately — so the caller can
                // open the sidebar and click into the live session WHILE it runs. The result is picked up from
                // the event stream, so nothing is lost by not awaiting here.
                if (needsHandle) {
                    // One handle, many turns, ONE session (createAgent persists the run hash across run()s).
                    window.__mlAgent = window.ml.createAgent(opts);
                } else {
                    window.__mlObsRun = window.ml.agent(task, opts);
                }
                return null;
            }, { task, needsHandle, toolNames: tools, toolTokens, python, extra: agentOptions });
        } catch (e) { error = String(e); }
        if (error) log(`  [launch error] ${error.slice(0, 400)}`);

        const results = () => events.filter((e) => e.kind === "agent-result").length;
        const maxSeq = () => Math.max(-1, ...events.filter((e) => e.seq != null).map((e) => e.seq));
        /** Fire one turn on the stashed handle, without awaiting it. */
        const startTurn = (t) => page.evaluate((t) => {
            window.__mlObsRun = window.__mlAgent.run(t).catch((e) => { window.__obsErr = String((e && e.stack) || e); });
            return null;
        }, t).catch((e) => { error = error || String(e); });
        /** Wait until `n` turns have reported a terminal agent-result, or the deadline passes. */
        const awaitResults = async (n, deadline) => {
            while (Date.now() < deadline && results() < n) await new Promise((r) => setTimeout(r, 250));
            return results() >= n;
        };

        const deadline = Date.now() + timeoutMs;
        if (needsHandle) {
            let turnsDone = 0;
            if (seed) {
                // Turn 1 against the SCRIPTED fake: whatever history the experiment needs — a corrupted
                // pointer, a failed call, a captured table — produced by the real loop, so it is a real
                // history and not a guess at the wire format.
                log(`  seeding history: "${String(seed.task).slice(0, 80)}"`);
                await startTurn(seed.task);
                await awaitResults(++turnsDone, deadline);
                seedBoundarySeq = maxSeq();
                // Swap to the MEASURED backend mid-session. Config is chrome.storage.sync — the run's history,
                // its pointer store and its session hash are all untouched by the change.
                await configureExtension(ext.sw, { ...realCfg, apiFormat: "openai" });
                if (fake) fake.setScript(script);
                log(`  seeded through seq ${seedBoundarySeq}; measuring on ${backendLabel}`);
            }
            await startTurn(task);
            await awaitResults(++turnsDone, deadline);
            if (followup) { await startTurn(followup); await awaitResults(++turnsDone, deadline); }
        }

        if (focusSidebar) await openSidebarAndFocus(page, artDir, log).catch((e) => log(`  (sidebar focus: ${e})`));
        const obsErr = await page.evaluate(() => window.__obsErr || null).catch(() => null);
        if (obsErr) log(`  ⚠ run threw: ${obsErr.slice(0, 400)}`);

        // A cross-page / background run's ml.agent() promise dies with the navigated-away page context (that's
        // the caught error), but the run carries on in the BACKGROUND. Wait for its terminal agent-result event
        // (via the init-script bridge, which re-attaches each document) before we snapshot final state.
        const need = (seed ? 1 : 0) + 1 + (followup ? 1 : 0);   // every turn emits its own agent-result
        const hasResult = () => events.filter((e) => e.kind === "agent-result").length >= need;
        if (!hasResult()) {
            while (Date.now() < deadline && !hasResult()) await new Promise((r) => setTimeout(r, 500));
        }
        const timedOut = !hasResult();
        approvalLoopOn = false; await approvalTask.catch(() => {});   // stop watching for gates
        const runMs = Date.now() - t0;   // wall time of the agent run only (warm-up excluded)

        // The expected nav teardown of the caller's context isn't a failure once the run finished — surface the
        // model's summary (from the terminal event) instead of the "context destroyed" noise.
        const done = [...events].reverse().find((e) => e.kind === "agent-result");   // the LAST turn's result
        if (done && error && /context was destroyed|Execution context/i.test(error)) error = null;
        if (result == null && done) result = { summary: done.summary, steps: done.steps, cancelled: done.cancelled };
        if (timedOut && !error) error = `timed out after ${timeoutMs}ms with no agent-result`;

        const finalUrl = page.url();
        if (artDir) { try { await page.screenshot({ path: path.join(artDir, "final.png") }); } catch { /* */ } }
        await dump(events);
        await settle();
        const { session, md, images } = renderRun(events);

        transcript.push({ kind: "result", task, finalUrl, steps: stepCount, runMs, error: error || null, result: result ?? null });
        if (artDir) {
            await writeFile(path.join(artDir, "transcript.txt"),
                transcript.map((t) => t.kind === "step" ? `STEP ${t.n} @ ${t.url}\n  ${t.tool ? `tool ${t.tool}(${JSON.stringify(t.args)})` : `thought: ${t.thought}`}${t.result ? `\n  → ${t.result}` : ""}`
                    : t.kind === "result" ? `\nRESULT (${t.steps} steps, final ${t.finalUrl})\n  ${t.error ? `ERROR: ${t.error}` : JSON.stringify(t.result)}`
                        : `[${t.kind}${t.type ? ":" + t.type : ""}] ${t.text}`).join("\n"));
        }

        if (hold) {
            log(`\n  WATCH: browser is open — inspect the run in the sidebar. Close the window (or Ctrl+C) to exit.\n`);
            await new Promise((resolve) => { ext.context.on("close", resolve); process.on("SIGINT", resolve); });
        }

        return { events, session, runMd: md, images, result, error, runMs, stepCount, approvals, transcript, finalUrl, startUrl, backendLabel, seedBoundarySeq };
    } finally {
        approvalLoopOn = false;
        await ext.close().catch(() => {});
        await fake?.stop().catch(() => {});
        await site.stop().catch(() => {});
    }
}
