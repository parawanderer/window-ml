// panel.mjs — one INTERVIEW put to several real models at once, each in its own converse session, so a change to the
// API, the prompt or the tools is judged by how models in general read it rather than by the one model at hand.
//
//   USE_ENV=1 node --import tsx tests/e2e/panel.mjs tests/e2e/panel/bloat.json \
//       --models deepseek.deepseek-v4-pro,litellm.google/gemini-flash-latest,openrouter.anthropic/claude-sonnet-5.5
//
// An interview file (tests/e2e/panel/*.json) is { task, asks?: string[], surface?, sharedWatches?, watchNotes? }: the
// first message, then each follow-up, sent once the turn before it has ended. Before anything starts every model is
// PROBED with one tool call through the configured backend, and one that cannot make it is reported and skipped (a
// misconfigured connection otherwise looks like a model that ignored the task). The result is <out>/summary.md: per
// model, the calls each turn took and how it ended, then every answer side by side, turn by turn. Each model's whole
// session is in <out>/<model>/ (run.md, run.json, outbox/) exactly as converse writes it.
//
// Options: --models a,b,c (or PANEL_MODELS), --out <dir> (default tests/e2e/artifacts/panel-<name>-<time>),
// --surface hud|console (overrides the file; hud is a run started as from the UI), --turn-minutes N (default 15).
// See .claude/skills/panel/SKILL.md for reading the results.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBackendFromEnv } from "./run-once.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The command line: the interview file, then `--name value` options. */
function parseArgs(argv) {
    const opts = { file: null, models: (process.env.PANEL_MODELS || "").split(","), out: null, surface: null, turnMinutes: 15 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--models") opts.models = argv[++i].split(",");
        else if (a === "--out") opts.out = argv[++i];
        else if (a === "--surface") opts.surface = argv[++i];
        else if (a === "--turn-minutes") opts.turnMinutes = Number(argv[++i]);
        else if (!opts.file) opts.file = a;
        else throw new Error(`panel: unexpected argument ${a}`);
    }
    opts.models = opts.models.map((m) => m.trim()).filter(Boolean);
    if (!opts.file || !opts.models.length) throw new Error("usage: panel.mjs <interview.json> --models a,b,c [--out dir] [--surface hud|console]");
    return opts;
}

/** A model id as a directory name. */
const slug = (model) => model.replace(/[^\w.-]+/g, "_");

/**
 * Can this model make a tool call through the configured backend? One small request, so a broken connection or a
 * model without tool support is named up front instead of read later as a model that ignored the task.
 * @returns {Promise<string | null>} null when it can, else why not
 */
async function probe(backend, model) {
    try {
        const r = await fetch(backend.chatUrl, {
            method: "POST",
            headers: { "content-type": "application/json", ...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Call the exec tool with js set to 1+1." }],
                tools: [{ type: "function", function: { name: "exec", description: "run JS", parameters: { type: "object", properties: { js: { type: "string" } }, required: ["js"] } } }] }),
            signal: AbortSignal.timeout(120_000),
        });
        const text = await r.text();
        let d; try { d = JSON.parse(text); } catch { return `HTTP ${r.status}, not JSON: ${text.slice(0, 120)}`; }
        if (!r.ok || !d.choices) return `HTTP ${r.status}: ${JSON.stringify(d).slice(0, 160)}`;
        return d.choices[0]?.message?.tool_calls?.length ? null : "answered without a tool call";
    } catch (e) { return String(e?.message || e); }
}

/** What one turn of a converse session did, read from its outbox file. */
function readTurn(dir, n) {
    const p = path.join(dir, "outbox", `turn-${n}.md`);
    if (!fs.existsSync(p)) return null;
    const md = fs.readFileSync(p, "utf8");
    const answer = (md.split("## Answer")[1] ?? "").split("\n## Steps")[0].trim();
    const tools = [...md.matchAll(/^- \*\*([a-z_]+)\*\*/gm)].map((m) => m[1]);
    return { answer, tools, capped: /Stopped at the \d+-step cap/.test(answer) };
}

/** Wait for a session's `status` to say turn `n` ended (or the session did), up to `ms`. */
async function waitTurn(dir, n, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        let s = "";
        try { s = fs.readFileSync(path.join(dir, "status"), "utf8"); } catch { /* not written yet */ }
        if (new RegExp(`turn ${n} done|^done|^gate`, "m").test(s)) return s.trim();
        await sleep(2000);
    }
    return "timed out";
}

/** One model's whole interview: start converse, send each follow-up as the turn before it ends, then end it. */
async function interview(model, iv, opts, outDir) {
    const dir = path.join(outDir, slug(model));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
    const env = { ...process.env, USE_ENV: "1", E2E_MODEL: model, CONVERSE_DIR: dir, TASK: iv.task,
        ...(iv.sharedWatches ? { SHARED_WATCHES: JSON.stringify(iv.sharedWatches) } : {}),
        ...(iv.watchNotes ? { WATCH_NOTES: JSON.stringify(iv.watchNotes) } : {}) };
    const surface = opts.surface ?? iv.surface ?? null;
    if (surface && surface !== "console") env.SURFACE = surface; else delete env.SURFACE;
    const log = fs.openSync(path.join(dir, "converse.log"), "w");
    const child = spawn(process.execPath, ["--import", "tsx", path.join(HERE, "converse.mjs")], { cwd: ROOT, env, stdio: ["ignore", log, log] });
    const exited = new Promise((r) => child.on("exit", r));
    const asks = iv.asks ?? [];
    const statuses = [];
    for (let t = 1; t <= asks.length + 1; t++) {
        const s = await waitTurn(dir, t, opts.turnMinutes * 60_000);
        statuses.push(s);
        if (!s.startsWith(`turn ${t} done`)) break;   // ended, timed out, or a gate nobody rules on
        fs.writeFileSync(path.join(dir, "inbox", `${String(t + 1).padStart(3, "0")}.txt`), t <= asks.length ? asks[t - 1] : "/end");
    }
    fs.writeFileSync(path.join(dir, "inbox", "999.txt"), "/end");
    await Promise.race([exited, sleep(60_000)]);
    if (child.exitCode == null) child.kill();
    const turns = [];
    for (let t = 1; t <= asks.length + 1; t++) { const r = readTurn(dir, t); if (!r) break; turns.push(r); }
    const runMd = fs.existsSync(path.join(dir, "run.md")) ? fs.readFileSync(path.join(dir, "run.md"), "utf8") : "";
    const prompt = /System prompt \(([\d,]+) chars/.exec(runMd)?.[1] ?? "?";
    return { model, dir, turns, statuses, prompt, expected: asks.length + 1 };
}

/** The summary: one line per model, then each turn's answers side by side. */
function summary(name, iv, results, skipped, surface) {
    const L = [`# Panel: ${name}`, "", ...(iv.about ? [iv.about, ""] : []), `${new Date().toISOString()} · surface: ${surface ?? "console"} · ${results.length} model(s)`, ""];
    if (skipped.length) { L.push("Skipped (failed the tool-call probe):", ""); for (const s of skipped) L.push(`- \`${s.model}\`: ${s.why}`); L.push(""); }
    L.push("| model | calls per turn | ended | prompt chars |", "| --- | --- | --- | --- |");
    for (const r of results) {
        const calls = r.turns.map((t) => `${t.tools.length}${t.capped ? " (cap)" : ""}`).join(" / ") || "none";
        const ended = r.turns.length === r.expected ? "all turns" : `after turn ${r.turns.length}: ${r.statuses.at(-1)}`;
        L.push(`| \`${r.model}\` | ${calls} | ${ended} | ${r.prompt} |`);
    }
    const asks = [iv.task, ...(iv.asks ?? [])];
    asks.forEach((q, i) => {
        L.push("", `## Turn ${i + 1}`, "", `> ${q.replace(/\n+/g, " ").slice(0, 400)}`, "");
        for (const r of results) {
            const t = r.turns[i];
            L.push(`### ${r.model}`, "", t ? `*${t.tools.length} call(s): ${t.tools.join(", ") || "none"}${t.capped ? ", stopped at the step cap" : ""}*` : "*no turn*", "");
            // Quoted, so a model's own headings stay inside its answer instead of joining the summary's outline.
            if (t) L.push((t.answer || "(no answer)").split("\n").map((l) => `> ${l}`).join("\n"), "");
        }
    });
    return L.join("\n") + "\n";
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const name = path.basename(opts.file).replace(/\.json$/, "");
    const iv = JSON.parse(fs.readFileSync(opts.file, "utf8"));
    if (typeof iv.task !== "string" || !iv.task.trim()) throw new Error(`panel: ${opts.file} has no "task"`);
    const outDir = path.resolve(opts.out || path.join(HERE, "artifacts", `panel-${name}-${Date.now()}`));
    fs.mkdirSync(outDir, { recursive: true });
    const backend = await resolveBackendFromEnv({ ...process.env, USE_ENV: process.env.E2E_BACKEND ? "" : "1" });
    if (!backend) throw new Error("panel: no backend (set USE_ENV=1 with .env, or E2E_BACKEND)");
    console.log(`panel ${name}: probing ${opts.models.length} model(s) for a tool call…`);
    const probed = await Promise.all(opts.models.map(async (model) => ({ model, why: await probe(backend, model) })));
    const skipped = probed.filter((p) => p.why);
    for (const s of skipped) console.log(`  ✗ ${s.model}: ${s.why}`);
    const ok = probed.filter((p) => !p.why).map((p) => p.model);
    console.log(`  running ${ok.length}: ${ok.join(", ")}  →  ${outDir}`);
    const results = await Promise.all(ok.map((m) => interview(m, iv, opts, outDir)));
    const surface = opts.surface ?? iv.surface ?? null;
    fs.writeFileSync(path.join(outDir, "summary.md"), summary(name, iv, results, skipped, surface));
    for (const r of results) console.log(`  ${r.model}: ${r.turns.map((t) => t.tools.length + (t.capped ? "(cap)" : "")).join(" / ")} calls`);
    console.log(`summary: ${path.join(outDir, "summary.md")}`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
