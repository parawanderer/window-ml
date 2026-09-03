// observe.mjs — a standalone "let me watch a run end-to-end" harness so I (Claude) can debug the real
// extension in a real browser by reading ARTIFACTS: the extension's OWN markdown transcript (run.md, via
// serializeSession) + a screenshot per step + the raw event stream. Not a test — a debug tool.
//
//   node --import tsx tests/e2e/observe.mjs                 # deterministic: scripted fake-LLM
//   E2E_BACKEND=<chatUrl> E2E_MODEL=<id> TASK="…" node --import tsx tests/e2e/observe.mjs   # real model
//   (with .env holding OPENWEBUI_URL/KEY/MODEL, pass USE_ENV=1 to use it as the backend)
//
// Writes tests/e2e/artifacts/: run.md (canonical), transcript.txt, events.json, step-<n>.png, final.png.
//
// This file is a THIN CLI: env vars in, one `runOnce()` call, a summary out. The run-driving core lives in
// run-once.mjs, shared with the bench — one function, two CLIs, so the core never learns what a benchmark
// is (see docs/POINTER-IDENTIFIERS.md §6).

import { runOnce, resolveBackendFromEnv, DEFAULT_TASK } from "./run-once.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One timestamped (or RUN_LABEL) subdir per run, so successive runs — e.g. before vs. after a fix — are
// kept side by side to diff, not overwritten. `artifacts/latest.txt` records the newest for convenience.
const RUN = process.env.RUN_LABEL || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ARTROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "artifacts");
const ART = path.join(ARTROOT, RUN);

const main = async () => {
    await mkdir(ART, { recursive: true });   // never rm the root — keep prior runs to diff

    const backend = await resolveBackendFromEnv();
    const task = process.env.TASK || DEFAULT_TASK;
    // FOLLOWUP="…" → a SECOND turn in the SAME session (createAgent + two run()s, so both turns share the run
    // hash). Reproduces multi-turn behaviour a single ml.agent() call can't — e.g. the cross-turn token-id
    // collision (turn 1 computes uncited; the follow-up asks to "show the work" and cites it).
    const followup = process.env.FOLLOWUP || "";
    // The start route on the test site. Besides the cross-page chain (/, /step2, /step3) and the /slow, /lazy,
    // /table … fixtures, EVERY real example page is served (START=/spreadsheet, /find-waldo, /canvas-input, … —
    // see GET /examples for the list), so a probe can drive the exact page a human uses.
    const start = process.env.START || "/step3";
    // TOOLS=findByText,answer → run the agent with only that subset of the default domTools (shrinks the
    // system prompt + schemas; useful under a tight free-tier token/min limit). Unset → the full default kit.
    const tools = process.env.TOOLS ? process.env.TOOLS.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const approve = (process.env.APPROVE || "auto").toLowerCase();

    console.log(`\n  observing: "${task}"\n  start: ${start}   backend: ${backend ? backend.chatUrl + ` (model ${backend.model})` : "fake-LLM"}   approvals: ${approve}\n`);

    const r = await runOnce({
        task, followup, start, tools, approve,
        python: !!process.env.PYTHON,
        toolTokens: !!process.env.TOOLTOKENS,
        backend,
        warm: process.env.WARM !== "0",
        warmAll: !!process.env.WARM_ALL,
        artDir: ART,
        // Sidebar focus is the DEFAULT: a human watching should never have to click. WATCH=1 additionally
        // HOLDS the browser open at the end so a finished run can be inspected.
        focusSidebar: true,
        hold: !!process.env.WATCH,
        log: (s) => console.log(s),
    });

    await writeFile(path.join(ARTROOT, "latest.txt"), RUN);   // pointer to the newest run dir
    console.log(`\n  → ${r.error ? `ERROR: ${r.error}` : "done"} in ${(r.runMs / 1000).toFixed(1)}s (run only). final url: ${r.finalUrl}, ${r.stepCount} steps, ${r.events.length} events.`);
    if (r.approvals.length) {
        const by = r.approvals.reduce((m, a) => ((m[a.decision] = (m[a.decision] || 0) + 1), m), {});
        console.log(`  approvals: ${r.approvals.length} gate(s) — ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")} (policy: ${approve})`);
    }
    console.log(`  artifacts: ${path.relative(process.cwd(), ART)}/  (run.md, transcript.txt, events.json, step-*.png)\n`);
};

main().catch((e) => { console.error(e); process.exit(1); });
