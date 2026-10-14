// spend-predict.mjs — what a sweep will cost before it runs, and what is left as it runs: each cell's cost is the mean
// of its model's recent past runs of the same item (task and its hash), their logged calls (spend.mjs) priced at TODAY's
// rates (the price service's newest snapshot, cost.mjs's join), so a price change since is in it and a prompt change is
// not. With no past run of the item it falls back to the model's runs of the same task under any wording, then to the
// model's runs of any task, then to "no estimate", never 0. A local model's cell is electricity, not priced here.
//
// The history is the local scores log plus the pooled one when `sync.mjs pull` has fetched it (every clone's runs), each
// run counted once. As the sweep runs, a finished cell's estimate is replaced by what it really spent (live-spend.mjs)
// and a running one's by the larger of the two, so the figure narrows to the spend.
//
// Electricity is estimated the same way, in Wh: the mean of the model's recent past runs the box log has energy for
// (electricity.mjs), at the same fallbacks, and priced at the rate the coming runs will record. A cloud model whose runs
// never drew on the box is estimated to draw nothing; a local model with no energy on record has no estimate.

import { existsSync } from "node:fs";
import { priceBook, callCost, PRICE_CURRENCY } from "../../../src/spend/price-book.ts";
import { readCalls } from "./spend.mjs";
import { rateAt } from "./electricity.mjs";

/** How many of a model's most recent past runs of an item an estimate averages: recent, because prompts shrink. */
export const RECENT = 20;

/** Where an estimate came from, nearest first. */
export const BASIS = { item: "past runs of the same task", task: "past runs of the task under another wording", model: "the model's runs of other tasks" };

/**
 * Every logged run with its calls, from one or more scores logs (the local one first; a run in two is counted once):
 * `{ run, model, task, taskHash, at, calls: [{ model, usage }], approx }`. A turn logged without its model was the
 * driver's. A run logged before calls were (#555) has only its token totals: it becomes ONE driver call of them,
 * `approx`, with no cached tokens apart, so it prices at the full input rate and estimates high; `nearest` takes it only
 * where no run with its calls is.
 */
export function pastRuns(dbs) {
    const runs = new Map();
    for (const db of dbs.filter(Boolean)) {
        let rows, calls;
        try { rows = db.prepare("SELECT run, model, task, task_hash, at, prompt_tokens, completion_tokens FROM runs").all(); calls = readCalls(db); } catch { continue; }
        const mine = new Map();
        for (const r of rows) if (!runs.has(r.run)) mine.set(r.run, { run: r.run, model: r.model, task: r.task, taskHash: r.task_hash, at: r.at, calls: [], approx: false, totals: r });
        for (const c of calls) mine.get(c.run)?.calls.push({ model: c.model ?? (c.kind === "turn" ? mine.get(c.run).model : null), usage: c.usage });
        for (const [k, { totals, ...v }] of mine) {
            if (!v.calls.length && totals.prompt_tokens != null) {
                v.calls.push({ model: v.model, usage: { promptTokens: totals.prompt_tokens, completionTokens: totals.completion_tokens ?? 0 } });
                v.approx = true;
            }
            if (v.calls.length) runs.set(k, v);
        }
    }
    return [...runs.values()];
}

/** One past run's calls at today's prices: `{ cost, tokens, local, why }`, cost null when a call nothing prices. */
export function repriced(run, priceOf) {
    let cost = 0, tokens = 0, local = true, why = null;
    for (const c of run.calls) {
        tokens += (c.usage.promptTokens ?? 0) + (c.usage.completionTokens ?? 0);
        const p = callCost(c.usage, c.model, priceOf);
        if (p.local) continue;
        local = false;
        if (p.computed == null) why ??= p.why;
        else cost += p.computed;
    }
    return { cost: local || why ? null : cost, tokens, local, why };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A model's past runs nearest a cell: of the same item, else the task under any wording, else any task (`[basis, runs]`). */
function nearest(history, { model, task, taskHash }) {
    const own = history.filter((r) => r.model === model);
    const exact = (rs) => (rs.some((r) => !r.approx) ? rs.filter((r) => !r.approx) : rs);   // a run's own calls over its token totals
    const levels = [["item", own.filter((r) => r.task === task && r.taskHash === taskHash)], ["task", own.filter((r) => r.task === task)], ["model", own]];
    const [basis, rs] = levels.find(([, rs]) => rs.length) ?? [null, []];
    return [basis, exact(rs)];
}

/** The `n` most recent of some runs. */
const newest = (runs, n) => [...runs].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, n);

/**
 * Each cell's estimate (`cells`: `{ model, task, taskHash }`): `{ cost, tokens, local, basis, n, why }`. `basis` names
 * the level it came from (BASIS), `n` how many past runs it averages; `cost` is null for a local cell and for one with no
 * estimate, which says why.
 */
export function predictCells(cells, history, priceOf, { recent = RECENT } = {}) {
    const memo = new Map();
    return cells.map(({ model, task, taskHash }) => {
        const key = `${model}|${task}|${taskHash}`;
        if (memo.has(key)) return memo.get(key);
        const [basis, runs] = nearest(history, { model, task, taskHash });
        const p = priceOf(model);
        let out;
        if (!runs.length) out = { cost: null, tokens: null, local: !!p.local, basis: null, n: 0, why: p.local ? null : `no past run of ${model}` };
        else {
            const priced = newest(runs, recent).map((r) => repriced(r, priceOf));
            const tokens = Math.round(mean(priced.map((r) => r.tokens)));
            const known = priced.filter((r) => r.cost != null);
            if (priced.every((r) => r.local)) out = { cost: null, tokens, local: true, basis, n: priced.length, why: null };
            else if (!known.length) out = { cost: null, tokens, local: false, basis, n: priced.length, why: priced.find((r) => r.why)?.why ?? "unpriced" };
            else out = { cost: mean(known.map((r) => r.cost)), tokens, local: false, basis, n: known.length, why: null };
        }
        memo.set(key, out);
        return out;
    });
}

/**
 * The sweep's forecast now: what it has spent (each finished or running cell's computed spend, `spentOf(i)` a live-spend
 * tally) and what its unfinished cells are estimated to add (`pred` from predictCells), in total and per driver model
 * (`modelOf(i)`). `stateOf(i)` is the cell's state ("pending", "running", "done"); a cell from the cache (`cachedOf(i)`)
 * cost this sweep nothing. `prices` names the snapshot the estimate used.
 */
export function forecast(pred, { stateOf, spentOf = () => null, modelOf, cachedOf = () => false, prices = null }) {
    const blank = () => ({ spent: 0, remaining: 0, left: 0, local: 0, unknown: 0, why: null, basis: { item: 0, task: 0, model: 0 } });
    const total = blank(), models = new Map();
    pred.forEach((p, i) => {
        if (cachedOf(i)) return;
        const m = modelOf(i) ?? "?";
        const t = models.get(m) ?? models.set(m, blank()).get(m);
        const state = stateOf(i);
        const spent = spentOf(i)?.computed ?? 0;
        for (const x of [total, t]) {
            x.spent += spent;
            if (state === "done") continue;
            x.left++;
            if (p.local) x.local++;
            else if (p.cost == null) { x.unknown++; x.why ??= p.why; }
            else { x.remaining += Math.max(0, p.cost - spent); x.basis[p.basis]++; }
        }
    });
    const done = (x) => ({ ...x, total: x.spent + x.remaining });
    return { currency: PRICE_CURRENCY, prices, ...done(total), models: Object.fromEntries([...models].map(([k, v]) => [k, done(v)])) };
}

const money = (x, cur) => `${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)} ${cur}`;
const runsN = (n) => `${n} run${n === 1 ? "" : "s"}`;

/** Where a set of estimates came from, in a few words. */
const whence = (b) => Object.entries(b).filter(([, n]) => n).map(([k, n]) => `${n} from ${BASIS[k]}`).join(", ");

/** The forecast as lines for the terminal: the total, then one line per driver model. */
export function forecastText(f, { start = false } = {}) {
    const priced = f.left - f.local - f.unknown;
    const apart = [f.local ? `${f.local} local` : null, f.unknown ? `${f.unknown} with no estimate` : null].filter(Boolean).join(", ");
    const when = f.prices ? ` (prices of ${f.prices.replace("T", " ").slice(0, 16)} UTC)` : "";
    const head = start
        ? (priced ? `spend estimate${when}: about ${money(f.remaining, f.currency)} for the ${runsN(f.left)} to run${apart ? ` (${apart}, not in it)` : ""}`
            : `spend estimate${when}: none in money for the ${runsN(f.left)} to run (${apart})`)
        : `spend so far ${money(f.spent, f.currency)}; ${priced ? `about ${money(f.total, f.currency)} by the end` : "no estimate for the rest"} (${runsN(f.left)} left${apart ? `: ${apart}` : ""})`;
    const rows = Object.entries(f.models).filter(([, t]) => t.left || t.spent).map(([m, t]) => {
        const bits = [t.remaining || t.left - t.local - t.unknown ? `about ${money(t.remaining, f.currency)} (${whence(t.basis)})` : null,
            t.local ? `${runsN(t.local)} local: electricity, not priced here` : null,
            t.unknown ? `${runsN(t.unknown)} with no estimate: ${t.why}` : null].filter(Boolean);
        return `    ${m.padEnd(36)} ${bits.join("; ")}`;
    });
    return [`  ${head}`, ...rows, `    An estimate: each model's ${RECENT} most recent past runs of the task, re-priced at these rates. A changed prompt, retries and long-context surprises are not in it.`];
}

/** The price service's newest snapshot as a price book: `{ priceOf, at }`, or null when it is unreachable. */
export async function latestPrices(url, fetchImpl = fetch) {
    try {
        const res = await fetchImpl(`${String(url).replace(/\/+(latest)?\/*$/, "")}/latest`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return null;
        const j = await res.json();
        const bodies = Object.fromEntries(Object.entries(j.sources ?? {}).map(([k, s]) => [k, s?.body ?? null]));
        return { priceOf: priceBook(bodies), at: j.fetched_at ?? null };
    } catch { return null; }
}

/** The newest snapshot a scores log holds (the one its latest priced call ran under), as a price book; null when none. */
export function newestLoggedPrices(db) {
    if (!db) return null;
    const row = db.prepare("SELECT usage FROM calls WHERE json_extract(usage, '$.prices.sources') IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    if (!row) return null;
    const { sources, fetchedAt } = JSON.parse(row.usage).prices;
    const body = db.prepare("SELECT body FROM snapshots WHERE hash = ?");
    return { priceOf: priceBook(Object.fromEntries(Object.entries(sources).map(([k, h]) => [k, body.get(h)?.body ?? null]))), at: fetchedAt ?? null };
}

/** The pooled scores log `sync.mjs pull` writes, opened read-only; null when it has not been pulled. */
export async function openPool(file) {
    if (!existsSync(file)) return null;
    try { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

/** At the end: what the start estimate said beside what the sweep computed, so the estimate's error is seen every sweep. */
export function estimateCheck(start, end) {
    const cur = start.currency;
    const left = end?.left ? `; ${runsN(end.left)} did not run (about ${money(end.remaining, cur)} of the estimate)` : "";
    return `spend estimate at the start: about ${money(start.remaining, cur)} for ${runsN(start.left)}; computed spend ${money(end?.spent ?? 0, cur)}${left}${start.unknown ? `; ${runsN(start.unknown)} had no estimate` : ""}`;
}

/**
 * Each cell's electricity estimate (`cells` as predictCells takes them): `{ Wh, basis, n }` from the mean of its model's
 * most recent past runs the box log has energy for (`energyOf`, run → `{ Wh }`, runEnergy's Map), at the same fallbacks.
 * A model none of whose past runs drew on the box is estimated at 0 Wh unless `localOf(model)` says it is local, which
 * makes it null: no estimate, never 0.
 */
export function predictEnergy(cells, history, energyOf, localOf = () => false, { recent = RECENT } = {}) {
    const drew = history.filter((r) => energyOf.has(r.run));
    return cells.map(({ model, task, taskHash }) => {
        const [basis, runs] = nearest(drew, { model, task, taskHash });
        if (runs.length) {
            const last = newest(runs, recent);
            return { Wh: mean(last.map((r) => energyOf.get(r.run).Wh)), basis, n: last.length };
        }
        return !localOf(model) && history.some((r) => r.model === model) ? { Wh: 0, basis: "none", n: 0 } : null;
    });
}

/**
 * The sweep's electricity forecast now: the Wh measured so far (`spentOf(i)`, a live energy tally) and what each unfinished
 * cell is estimated to add (`pred` from predictEnergy), in total and per driver model, with the rest priced at `price`'s
 * rate at `now` (an ElectricityPrice from the runner's settings; null: Wh only).
 */
export function energyForecast(pred, { stateOf, spentOf = () => null, modelOf, cachedOf = () => false, price = null, now = Date.now() }) {
    const rate = price ? rateAt(price, now) : null;
    const blank = () => ({ spentWh: 0, remainingWh: 0, left: 0, unknown: 0, basis: { item: 0, task: 0, model: 0, none: 0 } });
    const total = blank(), models = new Map();
    pred.forEach((p, i) => {
        if (cachedOf(i)) return;
        const m = modelOf(i) ?? "?";
        const t = models.get(m) ?? models.set(m, blank()).get(m);
        const spent = spentOf(i)?.Wh ?? 0;
        for (const x of [total, t]) {
            x.spentWh += spent;
            if (stateOf(i) === "done") continue;
            x.left++;
            if (!p) x.unknown++;
            else { x.remainingWh += Math.max(0, p.Wh - spent); x.basis[p.basis]++; }
        }
    });
    const done = (x) => ({ ...x, totalWh: x.spentWh + x.remainingWh, remainingCost: rate > 0 ? (x.remainingWh / 1000) * rate : null });
    return { currency: price?.currency ?? null, perKwh: rate > 0 ? rate : null, ...done(total), models: Object.fromEntries([...models].map(([k, v]) => [k, done(v)])) };
}

/** The electricity forecast as one line for the terminal and status.md. */
export function energyForecastText(f, { start = false } = {}) {
    const runs = (n) => `${n} run${n === 1 ? "" : "s"}`;
    const cost = f.remainingCost != null ? `, about ${money(f.remainingCost, f.currency)} at ${f.perKwh} ${f.currency}/kWh` : " (no electricity price set: energy only)";
    const apart = f.unknown ? `; ${runs(f.unknown)} on a local model with no energy on record, not in it` : "";
    return start
        ? `electricity estimate: about ${f.remainingWh.toFixed(2)} Wh for the ${runs(f.left)} to run${cost}${apart}`
        : `electricity ${f.spentWh.toFixed(2)} Wh so far; about ${f.totalWh.toFixed(2)} Wh by the end (${runs(f.left)} left${f.remainingCost != null ? `, about ${money(f.remainingCost, f.currency)} for them at ${f.perKwh} ${f.currency}/kWh` : "; no electricity price set: energy only"})${apart}`;
}

/** The electricity price the runner's settings give the coming runs (run-once's spendFromEnv keys), as calls record it. */
export function priceFromSettings(b) {
    if (!(b?.electricityPerKwh > 0)) return null;
    const currency = b.electricityCurrency || "EUR";
    if (!(b.electricityOffPeakPerKwh > 0)) return { perKwh: b.electricityPerKwh, currency };
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
    return { perKwh: b.electricityPerKwh, currency, tariff: { normalPerKwh: b.electricityPerKwh, offPeakPerKwh: b.electricityOffPeakPerKwh,
        offPeakHours: b.electricityOffPeakHours ?? "", offPeakWeekends: b.electricityOffPeakWeekends !== false, tz } };
}
