// scores.mjs — the bench's own model scoreboard: every real run a sweep makes is logged to one SQLite file, and the
// scoreboard fits a score per model from the runs whose task has a pass/fail predicate (rasch.mjs), plus how many tokens
// each model spends against the typical run of the same task.
//
//   node tests/e2e/bench/scores.mjs                 print the scoreboard; write scores.md, scores.json and scores.html
//   node tests/e2e/bench/scores.mjs --db <file>     another log
//
// Why our own: public indexes score full-precision models, and a bench runs 4-bit local copies beside cloud models.
// The log is the truth and the files are views of it (docs/dev/bench-design.md): a row is inserted once and never
// updated, and says who started the sweep and when. A model is its tag PLUS the digest the server reports, so a re-pull
// or another quantisation is a separate entry. A task is its id plus a hash of what it asks and how it is scored, so an
// edited task is a new one.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitRasch, sigmoid, RASCH_DEFAULTS } from "./rasch.mjs";
import { defaultBy } from "./mark.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
/** Where the bench keeps its scores: beside the sweeps, gitignored with them. */
export const SCORES_DIR = path.join(ROOT, "tests/e2e/artifacts/bench");
export const SCORES_DB = path.join(SCORES_DIR, "scores.sqlite");

/** A model needs this many scored runs before the scoreboard shows its score; below it, "too few runs". */
export const MIN_SCORED = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    run TEXT NOT NULL UNIQUE,          -- the agent run's session hash: the run.md it names
    at TEXT NOT NULL,                  -- when it was logged (ISO)
    by TEXT NOT NULL,                  -- who started the sweep (BENCH_BY)
    sweep TEXT NOT NULL,               -- the sweep's name
    spec TEXT, spec_hash TEXT,         -- the spec file and its text's hash (sweeps.jsonl)
    task TEXT NOT NULL,                -- the task's id
    task_hash TEXT NOT NULL,           -- what it asks and how it is scored, plus the spec's other dimensions
    task_text TEXT,
    variant TEXT NOT NULL,             -- the spec's dimensions other than the model, as JSON ("{}" for none)
    scored INTEGER NOT NULL,           -- 1 when the task has a pass/fail predicate
    model TEXT NOT NULL,               -- the driver model's tag or id
    digest TEXT, quant TEXT, params TEXT, local INTEGER,   -- as the server reports them; null when it does not
    vision TEXT, utility TEXT,         -- the other two roles' models
    backend TEXT,
    build TEXT NOT NULL, dirty INTEGER NOT NULL,
    passed INTEGER,                    -- the predicate's verdict; null when unscored
    error TEXT, hit_cap INTEGER NOT NULL,
    prompt_tokens INTEGER, completion_tokens INTEGER, sub_tokens INTEGER,
    tokens INTEGER,                    -- their sum; null when the backend reported no usage at all
    steps INTEGER NOT NULL, secs REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1');
`;

/**
 * Open (creating if need be) the scores log. Null when this Node has no `node:sqlite` (before 22.13 without a flag):
 * a sweep then runs as before and says the runs were not logged.
 */
export async function openScores(file = SCORES_DB) {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return null; }
    await mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    return db;
}

/** The spec's dimensions other than the model, as stable JSON: what makes the same task a different item. */
export const variantOf = (combo = {}) => JSON.stringify(Object.fromEntries(Object.entries(combo).filter(([k]) => k !== "model").sort(([a], [b]) => a.localeCompare(b))));

/**
 * A task as an item of the fit: its id, what it asks, how it starts, its tools, and its predicate's source, plus the
 * variant. Any edit to these makes a new item, since a reworded task or a changed predicate is a different question.
 */
export function taskHash(task, combo = {}) {
    const material = JSON.stringify({
        id: task.id, task: task.task, followup: task.followup ?? "", asks: task.asks ?? null, start: task.start ?? null,
        tools: task.tools ?? null, python: !!task.python, toolTokens: !!task.toolTokens,
        seed: task.seed ? String(task.seed.task) : null,
        succeeded: typeof task.succeeded === "function" ? String(task.succeeded) : null,
        variant: variantOf(combo),
    });
    return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/**
 * What the server says about each model: the digest, quantisation and size for a local (Ollama) one, nothing for a
 * cloud one. Read once per sweep from the list route the extension reads (OpenWebUI `/api/models`, which carries
 * Ollama's entry for a local model, else Ollama's `/api/tags`). Best effort: an empty map when neither answers.
 *
 * @returns {Promise<Map<string, {digest: string|null, quant: string|null, params: string|null, local: boolean|null}>>}
 */
export async function modelInfo(backend, fetchImpl = fetch) {
    const out = new Map();
    if (!backend?.chatUrl) return out;
    const origin = new URL(backend.chatUrl).origin;
    const headers = backend.key ? { authorization: `Bearer ${backend.key}` } : {};
    for (const route of ["/api/models", "/api/tags"]) {
        try {
            const res = await fetchImpl(origin + route, { headers, signal: AbortSignal.timeout(5000) });
            if (!res.ok) continue;
            const data = await res.json();
            const list = data.data || data.models;
            if (!Array.isArray(list)) continue;
            for (const m of list) {
                const o = route === "/api/tags" ? m : m.ollama;
                const id = m.id || m.name || m.model;
                if (!id) continue;
                out.set(id, {
                    digest: o?.digest ?? null,
                    quant: o?.details?.quantization_level ?? null,
                    params: o?.details?.parameter_size ?? null,
                    local: route === "/api/tags" ? true : m.owned_by ? m.owned_by === "ollama" : null,
                });
            }
            if (out.size) return out;
        } catch { /* not this route */ }
    }
    return out;
}

/**
 * One finished cell as a row of the log, or null when it is not a run of a real model worth logging: a cached cell (an
 * earlier sweep logged it), one with no session hash (it never started), or one against the fake model.
 *
 * @param {object} saved the cell as run.mjs saves it (`measurement`, `hash`, `models`, `combo`, `fromCache`)
 * @param {object} task the spec's task
 * @param {object} sweep `{ name, spec, specHash, fingerprint, dirty, backend, info, by, at }`
 */
export function runRow(saved, task, sweep) {
    if (!sweep.backend || saved.fromCache || !saved.hash || !saved.models?.driver) return null;
    const m = saved.measurement;
    const info = sweep.info?.get(saved.models.driver) ?? {};
    const t = m.tokens || {};
    const scored = typeof task.succeeded === "function";
    return {
        run: saved.hash, at: sweep.at ?? new Date().toISOString(), by: sweep.by ?? defaultBy(),
        sweep: sweep.name, spec: sweep.spec ?? null, spec_hash: sweep.specHash ?? null,
        task: task.id, task_hash: taskHash(task, saved.combo), task_text: String(task.task ?? ""),
        variant: variantOf(saved.combo), scored: scored ? 1 : 0,
        model: saved.models.driver, digest: info.digest ?? null, quant: info.quant ?? null, params: info.params ?? null,
        local: info.local == null ? null : info.local ? 1 : 0,
        vision: saved.models.vision ?? null, utility: saved.models.utility ?? null,
        backend: new URL(sweep.backend.chatUrl).origin,
        build: sweep.fingerprint, dirty: sweep.dirty ? 1 : 0,
        passed: scored && m.succeeded != null ? (m.succeeded ? 1 : 0) : null,
        error: m.error ? String(m.error).slice(0, 500) : null, hit_cap: m.hitCap ? 1 : 0,
        // tokenCost adds 0 for a step with no usage, so a run whose backend reported none sums to 0: that is unknown.
        prompt_tokens: t.total ? t.prompt : null, completion_tokens: t.total ? t.completion : null,
        sub_tokens: t.total ? t.sub : null, tokens: t.total || null,
        steps: m.steps, secs: m.runMs / 1000,
    };
}

/** The runs table's columns, in the order a row is written (the store's Parquet files carry the same). */
export const COLS = ["run", "at", "by", "sweep", "spec", "spec_hash", "task", "task_hash", "task_text", "variant", "scored", "model", "digest", "quant", "params", "local", "vision", "utility", "backend", "build", "dirty", "passed", "error", "hit_cap", "prompt_tokens", "completion_tokens", "sub_tokens", "tokens", "steps", "secs"];

/** Insert rows; one already logged (the same run hash) is left as it is. Returns how many were new. */
export function logRuns(db, rows) {
    const ins = db.prepare(`INSERT OR IGNORE INTO runs (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")})`);
    let added = 0;
    for (const r of rows) added += Number(ins.run(...COLS.map((c) => r[c] ?? null)).changes);
    return added;
}

/** Every logged run, oldest first. */
export const readRuns = (db) => db.prepare("SELECT * FROM runs ORDER BY id").all().map((r) => ({ ...r }));

/** A model as the scoreboard names it: its tag, plus the first 12 of its digest when the server reported one. */
export const modelKey = (r) => (r.digest ? `${r.model}@${String(r.digest).replace(/^sha256:/, "").slice(0, 12)}` : r.model);
/** A task as an item of the fit. */
const itemKey = (r) => `${r.task}#${r.task_hash}`;

/** The median, rounded to a whole token. */
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * The scoreboard: per model, its score and the runs behind it; per task, its difficulty; and what was left out and why.
 * Pure, from the rows alone, so the CLI, the files and both pages show the same numbers.
 *
 * - **score**: θ from the Rasch fit over every SCORED run (the task has a predicate) that did not error, relative to the
 *   mean task difficulty; withheld below `MIN_SCORED` such runs. An errored run (backend down, timeout, crash) is left
 *   out because the error need not be the model's; a run that hit the step cap is counted, as the predicate scored it.
 * - **chance**: σ(score), the fitted chance of passing a task of average difficulty.
 * - **bloat**: per run, its tokens over the median tokens of every run of the same task (any model, scored or not);
 *   per model, the geometric mean of those ratios. Only tasks at least two models ran count, since a task one model
 *   ran alone compares it with itself.
 */
export function scoreboard(rows, { db = SCORES_DB, minScored = MIN_SCORED, ...fitOpts } = {}) {
    const fitRows = rows.filter((r) => r.scored && r.passed != null && !r.error);
    const fit = fitRasch(fitRows.map((r) => ({ model: modelKey(r), task: itemKey(r), passed: !!r.passed })), fitOpts);

    // Token bloat: each task's median over every run that reported tokens, and the models that ran it.
    const byItem = new Map();
    for (const r of rows) {
        const k = itemKey(r);
        if (!byItem.has(k)) byItem.set(k, { rows: [], models: new Set() });
        byItem.get(k).rows.push(r);
        byItem.get(k).models.add(modelKey(r));
    }
    const itemMedian = new Map([...byItem].map(([k, v]) => [k, median(v.rows.filter((r) => r.tokens > 0).map((r) => r.tokens))]));

    const byModel = new Map();
    for (const r of rows) {
        const k = modelKey(r);
        if (!byModel.has(k)) byModel.set(k, []);
        byModel.get(k).push(r);
    }
    const models = [...byModel].map(([key, rs]) => {
        const last = rs[rs.length - 1];
        const scoredRuns = rs.filter((r) => r.scored && r.passed != null && !r.error);
        const f = fit.models.get(key);
        const shown = f && scoredRuns.length >= minScored;
        const ratios = rs.flatMap((r) => {
            const it = byItem.get(itemKey(r)), med = itemMedian.get(itemKey(r));
            return r.tokens > 0 && med > 0 && it.models.size >= 2 ? [r.tokens / med] : [];
        });
        const tokens = rs.filter((r) => r.tokens > 0).map((r) => r.tokens);
        return {
            key, model: last.model, digest: last.digest, quant: last.quant, params: last.params, local: last.local == null ? null : !!last.local,
            runs: rs.length, scored: scoredRuns.length, passed: scoredRuns.filter((r) => r.passed).length,
            errored: rs.filter((r) => r.error).length, unscored: rs.filter((r) => !r.scored).length,
            tasks: new Set(scoredRuns.map(itemKey)).size,
            score: shown ? { theta: f.theta, se: f.se, lo: f.lo, hi: f.hi, chance: sigmoid(f.theta), chanceLo: sigmoid(f.lo), chanceHi: sigmoid(f.hi) } : null,
            bloat: ratios.length ? { ratio: Math.exp(ratios.reduce((a, x) => a + Math.log(x), 0) / ratios.length), runs: ratios.length } : null,
            medianTokens: median(tokens),
            first: rs[0].at, last: last.at,
        };
    }).sort((a, b) => (b.score?.theta ?? -Infinity) - (a.score?.theta ?? -Infinity) || b.runs - a.runs || a.key.localeCompare(b.key));

    const tasks = [...byItem].map(([key, { rows: rs, models: ms }]) => {
        const r0 = rs[rs.length - 1];
        const scoredRuns = rs.filter((r) => r.scored && r.passed != null && !r.error);
        const f = fit.tasks.get(key);
        return {
            key, task: r0.task, taskHash: r0.task_hash, text: r0.task_text, variant: r0.variant, scored: !!r0.scored,
            runs: rs.length, models: ms.size, passed: scoredRuns.filter((r) => r.passed).length, scoredRuns: scoredRuns.length,
            difficulty: f ? { b: f.b, se: f.se, lo: f.lo, hi: f.hi } : null,
            medianTokens: itemMedian.get(key),
        };
    }).sort((a, b) => (b.difficulty?.b ?? -Infinity) - (a.difficulty?.b ?? -Infinity) || a.key.localeCompare(b.key));

    const method = { priorSd: fitOpts.priorSd ?? RASCH_DEFAULTS.priorSd, z: fitOpts.z ?? RASCH_DEFAULTS.z, minScored, converged: fit.converged, iterations: fit.iterations };
    return {
        db: db.startsWith(ROOT + path.sep) ? path.relative(ROOT, db) : db, generated: new Date().toISOString(),
        totals: {
            runs: rows.length, fitted: fitRows.length, models: models.length, tasks: tasks.length,
            unscored: rows.filter((r) => !r.scored).length, errored: rows.filter((r) => r.scored && r.error).length,
            scoredTasks: tasks.filter((t) => t.scored).length,
        },
        method,
        // What each number is, resolved for these settings: the page's tooltips and scores.md's notes are these strings.
        about: Object.fromEntries(Object.entries(SCORE_ABOUT).map(([k, v]) => [k, typeof v === "function" ? v(method) : v])),
        models, tasks,
    };
}

/** The scoreboard's explanations, one per number: the page's tooltips and the text file's notes are these strings. */
export const SCORE_ABOUT = {
    model: "The driver model: its tag, and the start of the digest the server reported for it. A re-pull or another quantisation has another digest, so it is scored separately. Cloud models have no digest.",
    score: (m) => `The model's ability θ from a Rasch (one-parameter logistic) fit over every scored run in the log: P(pass) = σ(θ − b), with b the task's difficulty. 0 means even odds on a task of average difficulty; +1 means e (2.7) times the odds. The bracket is the ${pct(m.z)} interval: θ ± ${m.z} standard errors. Fitted with a normal prior N(0, ${m.priorSd}²) on every θ and b, which keeps a model that passed everything finite. Shown from ${m.minScored} scored runs.`,
    chance: "σ(θ): the fitted chance of passing a task of average difficulty among the tasks in the log, with the interval carried over from θ. It moves when new tasks are logged, since the average does.",
    scored: "Runs that count toward the score: the task has a pass/fail predicate (`succeeded` in the spec) and the run did not error. An errored run (backend down, timeout, crash) is left out, as the error need not be the model's; a run that hit the step cap counts as the predicate scored it.",
    passed: "How many of the scored runs the predicate called right. A raw rate depends on which tasks were run; the score does not.",
    tasks: "Distinct scored tasks the model ran. A task edited in the spec (its text or its predicate) is a new task.",
    bloat: "Tokens spent against the typical run of the same task: each run's prompt + completion + sub-call tokens divided by the median of every run of that task (any model), then the geometric mean over the model's runs. ×1.0 is typical, ×2.0 twice the tokens. Only tasks at least two models ran count.",
    medianTokens: "The median of the model's runs' total tokens (prompt + completion + sub-calls), as the backend reported them. Runs whose backend reported no usage are left out.",
    runs: "Every logged run of the model, scored or not.",
    last: "When the model's latest run was logged.",
    difficulty: "The task's difficulty b from the same fit, relative to the average task (0). Higher is harder: a model with θ equal to b passes it half the time.",
    taskRuns: "Runs of this task in the log, by every model.",
    taskModels: "Distinct models that ran it.",
    taskPassed: "Scored runs the predicate called right, out of the scored runs.",
};
const pct = (z) => (z === 1.96 ? "95%" : "approximate");

const num = (x, d = 2) => (x == null ? "" : (x >= 0 ? "+" : "") + x.toFixed(d));

/** The scoreboard as markdown: scores.md, and what the CLI prints. */
export function scoresText(board) {
    const out = [`# Model scoreboard`, "", `From ${board.totals.runs} logged run${board.totals.runs === 1 ? "" : "s"} in \`${board.db}\` (SQLite, table \`runs\`; one row per run, never updated). Generated ${board.generated}.`, ""];
    if (!board.totals.runs) return out.concat(["Nothing logged yet: a sweep against a real model logs every run it makes."]).join("\n") + "\n";
    out.push(`${board.totals.fitted} scored run${board.totals.fitted === 1 ? "" : "s"} over ${board.tasks.filter((t) => t.difficulty).length} task${board.tasks.length === 1 ? "" : "s"} went into the fit. Left out: ${board.totals.unscored} run${board.totals.unscored === 1 ? "" : "s"} of tasks with no predicate (they still count for tokens), ${board.totals.errored} that errored.`, "");
    out.push("## Models", "", "| model | quant | score θ [interval] | chance on an average task | scored | passed | tasks | bloat | median tokens | runs | last |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const m of board.models) {
        const s = m.score ? `${num(m.score.theta)} [${num(m.score.lo)}, ${num(m.score.hi)}]` : `too few runs (${m.scored}/${board.method.minScored})`;
        const c = m.score ? `${Math.round(m.score.chance * 100)}% [${Math.round(m.score.chanceLo * 100)}, ${Math.round(m.score.chanceHi * 100)}]` : "";
        out.push(`| ${m.key} | ${m.quant ?? (m.local === false ? "cloud" : "")} | ${s} | ${c} | ${m.scored} | ${m.passed} | ${m.tasks} | ${m.bloat ? `×${m.bloat.ratio.toFixed(2)}` : ""} | ${m.medianTokens ?? ""} | ${m.runs} | ${m.last.slice(0, 16).replace("T", " ")} |`);
    }
    out.push("", "## Tasks", "", "| task | hash | variant | difficulty b [interval] | passed | runs | models | median tokens |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const t of board.tasks) {
        const d = t.difficulty ? `${num(t.difficulty.b)} [${num(t.difficulty.lo)}, ${num(t.difficulty.hi)}]` : t.scored ? "" : "no predicate";
        out.push(`| ${t.task} | ${t.taskHash} | ${t.variant === "{}" ? "" : t.variant} | ${d} | ${t.scored ? `${t.passed}/${t.scoredRuns}` : ""} | ${t.runs} | ${t.models} | ${t.medianTokens ?? ""} |`);
    }
    out.push("", "## How these numbers are computed", "");
    for (const [k, v] of Object.entries(board.about)) out.push(`- **${k}**: ${v}`);
    out.push("", `The raw data is the \`runs\` table of \`${board.db}\`. For example: \`sqlite3 ${board.db} "SELECT model, task, passed, tokens FROM runs ORDER BY at DESC LIMIT 20"\`.`);
    return out.join("\n") + "\n";
}

/**
 * The sweep page's view of the board: the line of each driver model the sweep ran, matched on tag AND digest (a model
 * re-pulled since has another line), the explanations, and where the scoreboard is (`href`).
 */
export function sweepScores(board, drivers, info, href) {
    const models = {};
    for (const tag of new Set(drivers.filter(Boolean))) {
        const digest = info?.get(tag)?.digest ?? null;
        const line = board.models.find((m) => m.model === tag && (m.digest ?? null) === digest);
        if (line) models[tag] = line;
    }
    return { href, about: board.about, minScored: board.method.minScored, models };
}

/** The tasks of a spec with no pass/fail predicate, whose runs therefore count for tokens but not for a score. */
export const unscoredTasks = (spec) => spec.tasks.filter((t) => typeof t.succeeded !== "function" && !(t.asks?.length || t.followUps?.length || t.expect)).map((t) => t.id);

/** Write scores.md, scores.json and scores.html beside the log; returns the board. */
export async function writeScoreFiles(db, { dir = SCORES_DIR, dbFile = SCORES_DB } = {}) {
    const board = scoreboard(readRuns(db), { db: dbFile });
    const { scoresPage } = await import("./serve.mjs");
    await writeFile(path.join(dir, "scores.md"), scoresText(board));
    await writeFile(path.join(dir, "scores.json"), JSON.stringify(board, null, 2));
    await writeFile(path.join(dir, "scores.html"), await scoresPage(board));
    return board;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf("--db");
    const file = i > 0 ? path.resolve(process.argv[i + 1]) : SCORES_DB;
    const db = await openScores(file);
    if (!db) { console.error("this Node has no node:sqlite (22.13 or later has it)"); process.exit(2); }
    const board = await writeScoreFiles(db, { dir: path.dirname(file), dbFile: file });
    process.stdout.write(scoresText(board));
    console.log(`\n  ${path.relative(ROOT, path.dirname(file))}/\n    scores.md    this table\n    scores.json  the same, as JSON\n    scores.html  the same, for a person (opens from disk)\n    ${path.basename(file).padEnd(12)} the raw log (SQLite, table runs)\n`);
}
