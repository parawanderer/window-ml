// converse.mjs — talk to a model running in the real extension, one turn at a time, through files: so an agent
// (or a person) can answer what the model asks, steer it, and rule on its approval gates as the run goes, where
// observe.mjs fixes the task and one follow-up up front. Built to interview models about the tooling they run in.
//
//   CONVERSE_DIR=tests/e2e/artifacts/talk USE_ENV=1 E2E_MODEL=gemma4:31b TASK="…" node --import tsx tests/e2e/converse.mjs
//
// The directory is the whole interface (see .claude/skills/converse/SKILL.md):
//   inbox/<anything>.txt   the next message; files are taken in name order, each deleted once read. `/end` ends.
//   outbox/turn-<n>.md     what turn n did: the model's answer, then each step (tool, arguments, result, approval)
//   run.md                 the whole session so far, as observe writes it (runOnce rewrites it on every event)
//   gate.json              an approval gate waiting for a ruling (only with APPROVE=ask): write `decision` with
//                          `approve` or `deny`; both files are then removed
//   status                 one line: what the driver is doing now (waiting for inbox, running turn n, gate, done)
// Everything else is observe's: the same env vars (START, TOOLS, PYTHON, TOOLTOKENS, SHARED_WATCHES, WATCH…), and
// the same runOnce() core (run-once.mjs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, resolveBackendFromEnv } from "./run-once.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.env.CONVERSE_DIR || path.join(HERE, "artifacts", `converse-${Date.now()}`));
const INBOX = path.join(DIR, "inbox"), OUTBOX = path.join(DIR, "outbox");
for (const d of [DIR, INBOX, OUTBOX]) fs.mkdirSync(d, { recursive: true });
const status = (s) => { fs.writeFileSync(path.join(DIR, "status"), s + "\n"); console.log(`  [converse] ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a turn may wait for its next message before the session ends on its own. */
const IDLE_MS = Number(process.env.CONVERSE_IDLE_MS || 30 * 60_000);

/** The next inbox message, waiting for one; null on `/end` or when nothing arrives for IDLE_MS. */
async function nextMessage() {
    const until = Date.now() + IDLE_MS;
    while (Date.now() < until) {
        const files = fs.readdirSync(INBOX).filter((f) => !f.startsWith(".")).sort();
        if (files.length) {
            const p = path.join(INBOX, files[0]);
            const text = fs.readFileSync(p, "utf8").trim();
            fs.rmSync(p);
            if (!text) continue;
            return text === "/end" ? null : text;
        }
        await sleep(500);
    }
    return null;
}

/** One turn's steps, as text an agent reads: what was called, with what, what came back, and who approved it. */
function turnReport(n, events, fromTs, result) {
    // By time, not `seq`: a reasoning step carries none.
    const steps = events.filter((e) => e.kind === "agent-step" && !e.pending && (e.ts ?? 0) > fromTs);
    const clip = (v, n) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + " …" : s; };
    const lines = [`# Turn ${n}`, "", "## Answer", "", result?.summary ?? "(no answer: the turn did not finish)", "", "## Steps", ""];
    for (const s of steps) {
        if (!s.tool) { const t = s.thought || s.reasoning; if (t) lines.push(`- thought: ${clip(t, 600)}`); continue; }
        lines.push(`- **${s.tool}**${s.approval ? ` (${s.approval})` : ""} ${clip(s.arguments, 800)}`, `  → ${clip(s.result, 1200)}`);
    }
    return lines.join("\n") + "\n";
}

const task = process.env.TASK || await (async () => { status("waiting for the first message in inbox/"); return nextMessage(); })();
if (!task) { status("done: no first message"); process.exit(0); }
const askGates = (process.env.APPROVE || "").toLowerCase() === "ask";
let turn = 0, lastTs = 0;

status(`running turn 1: ${task.slice(0, 80)}`);
const r = await runOnce({
    task,
    start: process.env.START || "/step3",
    tools: process.env.TOOLS ? process.env.TOOLS.split(",").map((s) => s.trim()).filter(Boolean) : null,
    python: !!process.env.PYTHON,
    toolTokens: !!process.env.TOOLTOKENS,
    sharedWatches: process.env.SHARED_WATCHES ? JSON.parse(process.env.SHARED_WATCHES) : [],
    // WATCH_NOTES='{\"ml.current.run.step\":\"is it moving?\"}' → the person's note on a shared watch, by expression.
    watchNotes: process.env.WATCH_NOTES ? JSON.parse(process.env.WATCH_NOTES) : {},
    // SURFACE=hud|overlay|chat → a run started as a person does from that UI (click, type, python_exec), not a console ml.agent.
    surface: process.env.SURFACE || null,
    backend: await resolveBackendFromEnv(),
    warm: process.env.WARM !== "0",
    artDir: DIR,
    approve: askGates ? "auto" : (process.env.APPROVE || "auto").toLowerCase(),
    ...(askGates ? { decide: async (g) => {
        const gate = path.join(DIR, "gate.json"), decision = path.join(DIR, "decision");
        fs.writeFileSync(gate, JSON.stringify({ step: g.step, tool: g.tool, arguments: g.arguments }, null, 2));
        status(`gate: ${g.tool} at step ${g.step} waits for decision (approve | deny)`);
        while (!fs.existsSync(decision)) await sleep(400);
        const ok = /^\s*approve/i.test(fs.readFileSync(decision, "utf8"));
        fs.rmSync(decision); fs.rmSync(gate, { force: true });
        status(`gate ${ok ? "approved" : "denied"}; running turn ${turn + 1}`);
        return ok;
    } } : {}),
    nextTurn: async ({ turn: done, result, events }) => {
        turn = done;
        fs.writeFileSync(path.join(OUTBOX, `turn-${done}.md`), turnReport(done, events, lastTs, result));
        lastTs = Math.max(lastTs, ...events.map((e) => e.ts ?? 0));
        status(`turn ${done} done (outbox/turn-${done}.md); waiting for inbox`);
        const next = await nextMessage();
        if (next) status(`running turn ${done + 1}: ${next.slice(0, 80)}`);
        return next;
    },
    focusSidebar: true,
    hold: !!process.env.WATCH && process.env.WATCH !== "0",
    synthetic: process.env.SYNTHETIC !== "0",
    headful: !!process.env.HEADFUL && process.env.HEADFUL !== "0",
    log: (s) => console.log(s),
});
status(`done after ${turn} turn(s)${r?.error ? `: ${r.error}` : ""}`);
