// spend.mjs — what each model call of a bench run spent, kept RAW beside the scoreboard (scores.sqlite): one row per
// call with the usage the extension recorded for it (the server's own usage block, the price snapshot it ran under, the
// electricity price), and each price snapshot's body once, by its sha256. Nothing is priced here: a cost is computed
// when it is read, from these rows, so a better reading of an old snapshot needs no re-run and no migration.
//
// Where a run's calls are (run.json, docs/spec/export.schema.json): the driver's calls are `steps[].usage`, one per model
// turn, on the step that holds the turn's thought; the calls a run made on its own behalf (a delegated look, locate or
// verify) are `steps[].subUsage.calls_`, which carry counts, and since #554 raw, prices and electricity as well. A step does not name its model. A
// run's `gen` events do, with the same token counts, but a real run's session keeps few of them (one for a whole run is
// usual), so a turn's model is the matching event's when there is one, else the driver's: a turn IS the driver's call.
// Rows logged before that have no model on most turns; `spendReport` reads those as the run's driver.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { priceCalls, spendByModel } from "./cost.mjs";
import { runEnergy, energyByModel, BASIS_WORDS } from "./electricity.mjs";
import { PRICE_CURRENCY } from "../../../src/spend/price-book.ts";

export const SPEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY,
    run TEXT NOT NULL,                 -- runs.run: the session hash; who and when are on that row
    call INTEGER NOT NULL,             -- order within the run, from 0
    at TEXT,                           -- when the call finished (ISO); null when the export did not say
    kind TEXT NOT NULL,                -- "turn" (the driver's own) or "sub" (a delegated call)
    step INTEGER,                      -- the step it belongs to
    model TEXT,                        -- the model that served it; null when the run did not say which
    usage TEXT NOT NULL,               -- the usage as recorded, JSON: counts, raw (the server's block), prices, electricity
    UNIQUE (run, call)
);
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,         -- sha256 of body, checked on insert
    kind TEXT NOT NULL,                -- the source's name in the price service (as a call's usage.prices names it)
    at TEXT NOT NULL,                  -- when it was stored here
    body BLOB NOT NULL                 -- the bytes as the service sent them
);
`;

/** The calls table's columns, in the order a row is written (the store's Parquet files carry the same). */
export const CALL_COLS = ["run", "call", "at", "kind", "step", "model", "usage"];

/** A usage without what is about time rather than spend (the phase marks, which can be long). */
const keptUsage = ({ genPhases: _p, ...u }) => u;

/** Each gen event's model, consumed in order by the step whose counts match it. */
function modelReader(session) {
    const gens = (session.events ?? []).filter((e) => e.kind === "gen" && e.cost).map((e) => ({ ...e, used: false }));
    return (u) => {
        const g = gens.find((e) => !e.used && e.cost.inTokens === u.promptTokens && e.cost.outTokens === u.completionTokens);
        if (!g) return null;
        g.used = true;
        return g.model ?? null;
    };
}

/** A delegated call's record (`subUsage.calls_[]`) as a turn's usage: its counts, and what it recorded beyond them once
 *  the extension keeps it (#554: raw, prices, electricity), as recorded. */
export const subcallUsage = (c) => ({ promptTokens: c.prompt, completionTokens: c.completion, totalTokens: (c.prompt ?? 0) + (c.completion ?? 0), genMs: c.ms,
    ...(c.raw ? { raw: c.raw } : {}), ...(c.prices ? { prices: c.prices } : {}), ...(c.electricity ? { electricity: c.electricity } : {}) });

/**
 * The model calls of one exported session (run.json's `session`), oldest first: the driver's turns, each followed by
 * the delegated calls made during its step. Calls with no usage recorded are not calls this can say anything about,
 * so they are left out, and a run with none gives [] ("no per-call data", never zero spend). `driver` is the model the
 * run was measured on; `seedThrough` the last step of a seeded run's scripted first turn (run-once's `seedBoundaryStep`),
 * whose calls went to the fake LLM and are left out: nobody paid for them.
 */
export function callsOf(session, { run = session?.hash, driver = null, seedThrough = -1 } = {}) {
    if (!session || !run) return [];
    const modelOf = modelReader(session);
    const steps = [...(session.steps ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).filter((s) => !(seedThrough >= 0 && (s.step ?? Infinity) <= seedThrough));
    const out = [];
    for (const s of steps) {
        if (s.usage) {
            out.push({ run, call: out.length, at: s.at ?? null, kind: "turn", step: s.step ?? null, model: modelOf(s.usage) ?? driver, usage: JSON.stringify(keptUsage(s.usage)) });
        }
        for (const c of s.subUsage?.calls_ ?? []) {
            out.push({ run, call: out.length, at: Number.isFinite(c.ts) ? new Date(c.ts).toISOString() : null, kind: "sub", step: s.step ?? null,
                model: c.model ?? null, usage: JSON.stringify(subcallUsage(c)) });
        }
    }
    return out;
}

/** Every price snapshot hash a session's calls name, with the source's name: `Map<sha256, kind>`. */
export function priceHashes(session) {
    const out = new Map();
    for (const s of session?.steps ?? []) {
        for (const u of [s.usage, ...(s.subUsage?.calls_ ?? [])]) {
            for (const [kind, hash] of Object.entries(u?.prices?.sources ?? {})) if (typeof hash === "string") out.set(hash, kind);
        }
    }
    return out;
}

/** Add the spend tables to an open scores log (a log made before them gains them, empty). */
export function openSpend(db) {
    db.exec(SPEND_SCHEMA);
    return db;
}

/** Insert call rows; one already logged (the same run and call) is left as it is. Returns how many were new. */
export function logCalls(db, rows) {
    const ins = db.prepare(`INSERT OR IGNORE INTO calls (${CALL_COLS.join(", ")}) VALUES (${CALL_COLS.map(() => "?").join(", ")})`);
    let added = 0;
    for (const r of rows) added += Number(ins.run(...CALL_COLS.map((c) => r[c] ?? null)).changes);
    return added;
}

/**
 * The calls of runs logged before calls were (#555), read back from each run's run.json where its sweep directory still
 * holds it, so an old run is priced from its own calls, cached tokens apart, rather than from its token totals. Only runs
 * the log has and has no calls for; a seeded run is skipped (where its scripted turn ends was not kept, and its fake
 * calls nobody paid for). Returns `{ runs, calls, seeded, noFile }`; running it again adds nothing.
 */
export async function backfillCalls(db, sweepDirs) {
    const { cellsOnDisk, historyRuns } = await import("./sweeps.mjs");
    const missing = new Set(db.prepare("SELECT run FROM runs WHERE run NOT IN (SELECT DISTINCT run FROM calls)").all().map((r) => r.run));
    const got = { runs: 0, calls: 0, seeded: 0, noFile: 0 };
    for (const dir of sweepDirs) {
        const cells = [...await cellsOnDisk(dir)];
        for (const h of await historyRuns(dir)) {
            try { cells.push({ rel: h.rel, saved: JSON.parse(await readFile(path.join(dir, h.rel, "cell.json"), "utf8")) }); } catch { /* never finished */ }
        }
        for (const { rel, saved } of cells) {
            if (!saved?.hash || !missing.has(saved.hash)) continue;
            missing.delete(saved.hash);
            if (saved.measurement?.seeded) { got.seeded++; continue; }
            let session;
            try { session = JSON.parse(await readFile(path.join(dir, rel, "run.json"), "utf8")).session; } catch { got.noFile++; continue; }
            const added = logCalls(db, callsOf(session, { run: saved.hash, driver: saved.models?.driver ?? null }));
            if (added) { got.runs++; got.calls += added; }
        }
    }
    return got;
}

/** The hashes of `wanted` the log has no body for yet. */
export function missingSnapshots(db, wanted) {
    const has = db.prepare("SELECT 1 FROM snapshots WHERE hash = ?");
    return [...wanted].filter((h) => !has.get(h));
}

/**
 * Store a snapshot body, once per hash. The body must hash to `hash`: a mismatch is refused (returns null) rather than
 * stored under a name it does not have. Otherwise true when a row was added, false when the log had it.
 */
export function logSnapshot(db, { hash, kind, body, at = new Date().toISOString() }) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return null;
    return Number(db.prepare("INSERT OR IGNORE INTO snapshots (hash, kind, at, body) VALUES (?, ?, ?, ?)").run(hash, kind, at, bytes).changes) > 0;
}

/** Every call row, oldest first, with `usage` parsed. */
export const readCalls = (db) => db.prepare("SELECT * FROM calls ORDER BY id").all().map((r) => ({ ...r, usage: JSON.parse(r.usage) }));

/**
 * Spend per driver model over every logged call, priced on read (cost.mjs), for scores.md and scores.json. `rows` are
 * the runs (readRuns) and `keyOf(row)` the scoreboard's model key. Runs logged before calls were have none and are
 * counted apart: "no per-call data", never zero. Null when no run has calls.
 *
 * With the box log (`box`, box.sqlite), each model also gets `energy` (electricity.mjs): what the box drew for its runs,
 * priced at the electricity price each run's calls recorded; null for a model the box never generated for.
 */
export function spendReport(db, rows, keyOf, { box = null } = {}) {
    const calls = readCalls(db);
    if (!calls.length) return null;
    const body = db.prepare("SELECT body FROM snapshots WHERE hash = ?");
    const driverOf = new Map(rows.map((r) => [r.run, r.model]));
    // A turn logged without its model (before callsOf named the driver) was the driver's.
    const priced = priceCalls(calls.map((c) => (c.model == null && c.kind === "turn" ? { ...c, model: driverOf.get(c.run) ?? null } : c)), (h) => body.get(h)?.body ?? null);
    const byRun = new Map(rows.map((r) => [r.run, keyOf(r)]));
    const withCalls = new Set(calls.map((c) => c.run));
    const models = spendByModel(priced, (run) => byRun.get(run) ?? null);
    let energy = null;
    if (box) {
        // A run's electricity price is the one its calls recorded (each carries the whole tariff when there is one).
        const price = new Map();
        for (const c of calls) if (c.usage.electricity && !price.has(c.run)) price.set(c.run, c.usage.electricity);
        energy = energyByModel(runEnergy(box, rows.map((r) => ({ run: r.run, price: price.get(r.run) ?? null }))), (run) => byRun.get(run) ?? null);
        for (const m of models) m.energy = energy.get(m.model) ?? null;
    }
    return {
        currency: PRICE_CURRENCY,
        calls: calls.length,
        runsWithCalls: withCalls.size,
        runsWithout: rows.filter((r) => !withCalls.has(r.run)).length,
        models,
        ...(energy ? { energyBases: [...new Set([...energy.values()].flatMap((e) => e.basis.split(" / ")))].sort() } : {}),
        about: { ...SPEND_ABOUT, ...(energy ? ENERGY_ABOUT : {}) },
    };
}

/** What the electricity columns mean. */
export const ENERGY_ABOUT = {
    energy: "What the box drew for the model's runs (box.sqlite): everything while it generated for them, plus its draw above rest in the 30 s after each generation, as the GPUs clock down; a stranger's generation at the same moment takes its share. \"Above rest\" takes off what the box draws with nothing generating, which is paid either way. Loading a model and keeping it resident are not counted.",
    electricity: "That energy at the electricity price each run's calls recorded, each moment at its own rate (a two-rate tariff's off-peak hours on the tariff's clock). A run with no price set shows energy only: set the average price per kWh in DevTools Settings > Spend.",
};

/** What each spend column means: scores.md's notes. */
export const SPEND_ABOUT = {
    computed: "The calls' tokens priced from the price snapshot each call ran under (uncached prompt, cache reads, cache writes and output at their own per-token rates, a long-context tier when the prompt is past it), joined to a price through the box's model list. A call whose model nothing prices, or whose token class has no rate, is left out of this sum and counted as unpriced.",
    reported: "What the provider itself said the calls cost (`cost` in its usage block), summed over the calls that carried it. Beside computed, never instead: their ratio over the same calls measures the price table's error.",
    local: "Calls served by a local model: their cost is electricity, not tokens, and is not in either sum.",
    unpriced: "Calls neither figure covers, with the most common reason.",
};

/** The spend section of scores.md. */
export function spendText(spend) {
    if (!spend) return [];
    const money = (x, n) => (n ? `${x.toFixed(4)} ${spend.currency} (${n})` : "");
    const energy = spend.models.some((m) => m.energy);
    const wh = (e) => (e ? `${e.Wh.toFixed(2)} (${e.runs})${e.aboveWh != null ? `, ${e.aboveWh.toFixed(2)} above rest` : ""}` : "");
    const power = (e) => (!e ? "" : [e.cost != null ? `${e.cost.toFixed(4)} ${e.currency}${e.costAbove != null ? ` (${e.costAbove.toFixed(4)} above rest)` : ""}` : null,
        e.unpriced ? `⚠ ${e.unpriced} run${e.unpriced === 1 ? "" : "s"} with no electricity price` : null].filter(Boolean).join("; "));
    const out = ["## Spend", "", `${spend.calls} model call${spend.calls === 1 ? "" : "s"} over ${spend.runsWithCalls} run${spend.runsWithCalls === 1 ? "" : "s"}, from the \`calls\` table, priced when this was written.${spend.runsWithout ? ` ${spend.runsWithout} run${spend.runsWithout === 1 ? "" : "s"} logged before calls were recorded ha${spend.runsWithout === 1 ? "s" : "ve"} no per-call data and ${spend.runsWithout === 1 ? "is" : "are"} not here.` : ""}`, "",
        `| model | runs | calls | computed (calls) | reported (calls) | local | unpriced | why |${energy ? " energy, Wh (runs) | electricity |" : ""}`,
        `| --- | --- | --- | --- | --- | --- | --- | --- |${energy ? " --- | --- |" : ""}`];
    for (const m of spend.models) out.push(`| ${m.model} | ${m.runs} | ${m.calls} | ${money(m.computed, m.computedCalls)} | ${money(m.reported, m.reportedCalls)} | ${m.local || ""} | ${m.unpriced || ""} | ${m.unpriced ? m.why : ""} |${energy ? ` ${wh(m.energy)} | ${power(m.energy)} |` : ""}`);
    out.push("");
    if (energy) out.push(`Energy measured as: ${spend.energyBases.map((b) => BASIS_WORDS[b] ?? b).join("; ")}.`, "");
    for (const [k, v] of Object.entries(spend.about ?? SPEND_ABOUT)) out.push(`- **${k}**: ${v}`);
    return out.concat([""]);
}
