// spend.mjs — what each model call of a bench run spent, kept RAW beside the scoreboard (scores.sqlite): one row per
// call with the usage the extension recorded for it (the server's own usage block, the price snapshot it ran under, the
// electricity price), and each price snapshot's body once, by its sha256. Nothing is priced here: a cost is computed
// when it is read, from these rows, so a better reading of an old snapshot needs no re-run and no migration.
//
// Where a run's calls are (run.json, docs/spec/export.schema.json): the driver's calls are `steps[].usage`, one per model
// turn, on the step that holds the turn's thought; the calls a run made on its own behalf (a delegated look, locate or
// verify) are `steps[].subUsage.calls_`, which carry counts, and since #554 raw, prices and electricity as well. A step does not name its model; the run's `gen`
// events do, with the same token counts, so the model is read from the matching event, and is null when none matches.

import { createHash } from "node:crypto";
import { priceCalls, spendByModel, PRICE_CURRENCY } from "./cost.mjs";

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
 * so they are left out, and a run with none gives [] ("no per-call data", never zero spend).
 */
export function callsOf(session, run = session?.hash) {
    if (!session || !run) return [];
    const modelOf = modelReader(session);
    const steps = [...(session.steps ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const out = [];
    for (const s of steps) {
        if (s.usage) {
            out.push({ run, call: out.length, at: s.at ?? null, kind: "turn", step: s.step ?? null, model: modelOf(s.usage), usage: JSON.stringify(keptUsage(s.usage)) });
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
 */
export function spendReport(db, rows, keyOf) {
    const calls = readCalls(db);
    if (!calls.length) return null;
    const body = db.prepare("SELECT body FROM snapshots WHERE hash = ?");
    const priced = priceCalls(calls, (h) => body.get(h)?.body ?? null);
    const byRun = new Map(rows.map((r) => [r.run, keyOf(r)]));
    const withCalls = new Set(calls.map((c) => c.run));
    return {
        currency: PRICE_CURRENCY,
        calls: calls.length,
        runsWithCalls: withCalls.size,
        runsWithout: rows.filter((r) => !withCalls.has(r.run)).length,
        models: spendByModel(priced, (run) => byRun.get(run) ?? null),
        about: SPEND_ABOUT,
    };
}

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
    const out = ["## Spend", "", `${spend.calls} model call${spend.calls === 1 ? "" : "s"} over ${spend.runsWithCalls} run${spend.runsWithCalls === 1 ? "" : "s"}, from the \`calls\` table, priced when this was written.${spend.runsWithout ? ` ${spend.runsWithout} run${spend.runsWithout === 1 ? "" : "s"} logged before calls were recorded ha${spend.runsWithout === 1 ? "s" : "ve"} no per-call data and ${spend.runsWithout === 1 ? "is" : "are"} not here.` : ""}`, "",
        "| model | runs | calls | computed (calls) | reported (calls) | local | unpriced | why |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
    for (const m of spend.models) out.push(`| ${m.model} | ${m.runs} | ${m.calls} | ${money(m.computed, m.computedCalls)} | ${money(m.reported, m.reportedCalls)} | ${m.local || ""} | ${m.unpriced || ""} | ${m.unpriced ? m.why : ""} |`);
    out.push("");
    for (const [k, v] of Object.entries(SPEND_ABOUT)) out.push(`- **${k}**: ${v}`);
    return out.concat([""]);
}
