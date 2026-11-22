// electricity.mjs — what a run drew from the box while the box generated for it, read from the box log (box.sqlite,
// box-stream.mjs): a run's share is summed over the generations its session made (`hint.session` is `wml-` + the run's
// hash), and sums per model and per sweep for the bench's pages and status files. The attribution itself (readings,
// intervals, the split among generations, pricing) is src/spend/energy.ts, which the extension's worker shares.

import { genSpan, intervals, reading, attribute, priceShare, BASIS_WORDS } from "../../../src/spend/energy.ts";

/** Readings this far either side of a run's generations bound the stretch read for it (and find the box at rest). */
const PAD_MS = 5 * 60_000;
/** Generations further apart than this are read as separate stretches (and each has its own idle draw). */
const SPLIT_MS = 10 * 60_000;

/** Group spans into stretches: a gap longer than SPLIT_MS starts a new one. */
function stretches(spans) {
    const out = [];
    for (const s of [...spans].sort((a, b) => a.from - b.from)) {
        const last = out.at(-1);
        if (last && s.from - last.to <= SPLIT_MS) last.to = Math.max(last.to, s.to);
        else out.push({ from: s.from, to: s.to });
    }
    return out;
}

/**
 * Each run's electricity from the box log (`db`, box.sqlite opened by `openBoxLog`): `runs` are `{ run, price }`, the
 * run's hash and the electricity price its calls recorded (`usage.electricity`, or null). Returns a Map of run →
 * `{ Wh, aboveWh, tailWh, scopes: { gpu?: Wh, ... }, basis, ms, restW, cost, costAbove, currency }`, holding only the
 * runs the box generated for (a run on an external model with no local call is not in it). A stretch with no rest in
 * reach takes the box's rest over its whole log (from `since`, when given: a sweep reads only its own time).
 */
export function runEnergy(db, runs, { since = null } = {}) {
    const out = new Map();
    if (!db || !runs.length) return out;
    const want = new Map(runs.map((r) => [`wml-${r.run}`, r]));
    const gens = db.prepare(`SELECT box, at, json_extract(frame, '$.hint.session') AS session, json_extract(frame, '$.model') AS model,
        json_extract(frame, '$.timings.prompt_ms') AS promptMs, json_extract(frame, '$.timings.eval_ms') AS evalMs FROM frames WHERE kind = 'gen.end' AND at >= ?`).all(since ?? -Number.MAX_VALUE);
    const byBox = new Map();
    for (const g of gens) {
        const s = genSpan(g);
        if (s) (byBox.get(g.box) ?? byBox.set(g.box, []).get(g.box)).push(s);
    }
    const samples = db.prepare(`SELECT at, json_extract(frame, '$.info.compute') AS compute, json_extract(frame, '$.ps.models') AS models FROM frames
        WHERE box = ? AND kind = 'sample' AND at BETWEEN ? AND ? AND json_extract(frame, '$.info.compute') IS NOT NULL ORDER BY at`);
    const read = (box, from, to) => intervals(samples.all(box, from, to).map((r) => reading(r.at, JSON.parse(r.compute), r.models ? JSON.parse(r.models) : null)));
    for (const [box, spans] of byBox) {
        const ours = spans.filter((s) => want.has(s.session));
        let boxRest;
        const restOfBox = () => (boxRest ??= attribute(read(box, since ?? -Number.MAX_VALUE, Number.MAX_VALUE), spans).restBy);
        for (const { from, to } of stretches(ours)) {
            const ivs = read(box, from - PAD_MS, to + PAD_MS);
            const near = spans.filter((s) => s.to >= from - PAD_MS && s.from <= to + PAD_MS);
            let got = attribute(ivs, near);
            if (Object.values(got.restBy).some((x) => x == null) || !Object.keys(got.restBy).length) got = attribute(ivs, near, { restBy: restOfBox() });
            for (const [session, share] of got.sessions) {
                const r = want.get(session);
                if (!r) continue;
                const prev = out.get(r.run);
                out.set(r.run, prev ? merge(prev, share) : { ...share, restW: got.restW });
            }
        }
    }
    return new Map([...out].map(([run, s]) => {
        const { cost, costAbove, currency } = priceShare(s, want.get(`wml-${run}`).price);
        const bases = [...s.bases].sort();
        return [run, { Wh: s.J / 3600, aboveWh: s.aboveJ == null ? null : Math.max(0, s.aboveJ) / 3600, tailWh: s.tailJ / 3600,
            scopes: Object.fromEntries(Object.entries(s.scopes).map(([k, v]) => [k, v / 3600])),
            basis: bases.join(" / "), ms: Math.round(s.ms), restW: s.restW, cost, costAbove, currency }];
    }));
}

const merge = (a, b) => ({ J: a.J + b.J, aboveJ: a.aboveJ == null || b.aboveJ == null ? null : a.aboveJ + b.aboveJ, tailJ: a.tailJ + b.tailJ,
    scopes: Object.fromEntries([...new Set([...Object.keys(a.scopes), ...Object.keys(b.scopes)])].map((k) => [k, (a.scopes[k] ?? 0) + (b.scopes[k] ?? 0)])),
    bases: new Set([...a.bases, ...b.bases]), ms: a.ms + b.ms, at: [...a.at, ...b.at], restW: a.restW });

/**
 * Runs' energy summed per model (`keyOf(run)`, the scoreboard's model key): `{ runs, Wh, aboveWh, cost, costAbove,
 * currency, unpriced, basis }`. Cost is null when no run had a price; `unpriced` counts the runs without one (shown as
 * energy only), and runs priced in another currency than the first are counted there too.
 */
export function energyByModel(energy, keyOf) {
    const by = new Map();
    for (const [run, e] of energy) {
        const k = keyOf(run);
        if (!k) continue;
        const m = by.get(k) ?? by.set(k, { runs: 0, Wh: 0, aboveWh: 0, cost: null, costAbove: 0, aboveUnknown: false, currency: null, unpriced: 0, bases: new Set() }).get(k);
        m.runs++; m.Wh += e.Wh; m.bases.add(e.basis);
        m.aboveWh = m.aboveWh == null || e.aboveWh == null ? null : m.aboveWh + e.aboveWh;
        if (e.cost == null || (m.currency && e.currency !== m.currency)) { m.unpriced++; continue; }
        m.currency ??= e.currency;
        m.cost = (m.cost ?? 0) + e.cost;
        if (e.costAbove == null) m.aboveUnknown = true;
        else m.costAbove += e.costAbove;
    }
    return new Map([...by].map(([k, { bases, aboveUnknown, ...m }]) => [k, { ...m, costAbove: m.cost == null || aboveUnknown ? null : m.costAbove, basis: [...bases].sort().join(" / ") }]));
}

/**
 * A sweep's electricity so far, for its page and status files: `runs` are `{ index, run, price }` (the cell's index, its
 * run hash, the electricity price its calls recorded), `modelOf(index)` the driver. Returns `{ total, models, runs }` of
 * energyByModel tallies (`runs` keyed by index), or null when the box generated for none of them. `since` bounds the
 * box log read to the sweep's own time.
 */
export function sweepEnergy(db, runs, modelOf, { since = null } = {}) {
    const e = runEnergy(db, runs.map(({ run, price }) => ({ run, price })), { since });
    if (!e.size) return null;
    const indexOf = new Map(runs.map((r) => [r.run, r.index]));
    const by = (keyOf) => Object.fromEntries(energyByModel(e, keyOf));
    return { total: by(() => "all").all, models: by((run) => modelOf(indexOf.get(run)) ?? "?"), runs: by((run) => String(indexOf.get(run))) };
}

/** An energy tally as words for the terminal and status.md: Wh, above rest, the cost, and the runs with no price. */
export function energyLine(t) {
    if (!t) return null;
    return [`${t.Wh.toFixed(2)} Wh over ${t.runs} run${t.runs === 1 ? "" : "s"}${t.aboveWh != null ? ` (${t.aboveWh.toFixed(2)} above rest)` : ""}`,
        t.cost != null ? `${t.cost.toFixed(4)} ${t.currency}` : null,
        t.unpriced ? `${t.unpriced} run${t.unpriced === 1 ? "" : "s"} with no electricity price (energy only; set one in DevTools Settings > Spend)` : null,
        `measured as ${t.basis.split(" / ").map((b) => BASIS_WORDS[b] ?? b).join("; ")}`].filter(Boolean).join("; ");
}
