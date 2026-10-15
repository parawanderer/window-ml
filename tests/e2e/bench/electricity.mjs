// electricity.mjs — what a run drew from the box while the box generated for it, read from the box log (box.sqlite,
// box-stream.mjs): the box's power readings integrated between consecutive samples, each interval's energy split among
// the generations running in it, a run's share summed over the generations its session made (`hint.session` is
// `wml-` + the run's hash), and priced at the electricity rate of each interval's own moment (a two-rate tariff's
// off-peak hours on the tariff's clock). A local model's cost is this, not tokens.
//
// Measured layers, each absent when the box does not report it, never 0: GPU board power (`supported_gpus[].power`,
// sampled watts, integrated by trapezoid) and the box's power sources (`compute.power_sources`: an energy counter is
// integrated by its DIFFERENCES, with a decrease read as a wrap at `energy_wrap_mj`, unless it is COARSER than the
// readings: a wall plug's counter moves in 0.001 kWh steps, so it stands still for seconds while the plug's watts say it
// draws, and that source is integrated from its watts instead). Scopes nest (a wall reading
// contains the CPU and GPUs), so they are never added across: an interval counts the wall when it has one, else a
// whole-system reading, else GPU + CPU, and says which.
//
// A run's draw is everything the box drew while generating for it, plus what it drew above rest in the half minute
// after (the GPUs clock down over seconds); "above idle" takes the box at rest off that, the part a run adds, since
// the rest draw is paid either way. Loading a model and keeping it resident are not any run's.
//
// WHICH GPU: each GPU's energy goes only to generations of models resident on it (`ps.models[].gpus`, by the share of
// the model's VRAM there), so two models on two GPUs each pay their own card's draw, and a model split across both pays
// each in proportion. On one GPU, concurrent generations time-share it, so they split it by overlap. What is not a GPU
// (the CPU package, or the wall less the GPUs once the box reports one) is the box's, split among everything generating.
// Each of these channels has its own rest draw and its own tail.

import { isOffPeak } from "../../../src/spend/price-book.ts";
import { normModel } from "../../../src/resource/resource-model.ts";

/** A longer gap between two readings is not integrated: its energy is unmeasured, not zero. The box samples every 15 s
 *  when idle (every 250 ms busy), and an idle gap lands just past it: 372 of 415 idle gaps in this clone's box log were
 *  15.0-15.5 s (2026-10-15). At 15 s every one of them was dropped, and with them most of the readings rest is found
 *  from. 20 s keeps the idle cadence and still drops a missed sample. */
export const MAX_GAP_MS = 20_000;
/** Readings this far either side of a run's generations bound the stretch read for it (and find the box at rest). */
const PAD_MS = 5 * 60_000;
/** How long after a generation the box's draw above rest is still that generation's. */
export const TAIL_MS = 30_000;
/** How long after the last generation the box counts as at rest. */
export const REST_MS = 30_000;
/** Generations further apart than this are read as separate stretches (and each has its own idle draw). */
const SPLIT_MS = 10 * 60_000;
/** An energy counter rising faster than this is a reset, not a reading (10 kW). */
const MAX_W = 10_000;
/** A counter standing still while its source reports more than this (W) is coarser than the readings (see `coarse`). */
const COARSE_W = 1;
const SCOPES = ["wall", "system", "gpu", "cpu"];
const J_PER_KWH = 3.6e6;

/**
 * One power reading from a sample frame's `info.compute`, at `t` (ms): each GPU's board power in watts by its `gpu_id`
 * (`gpuBy`) and their sum (`gpuW`), both null unless every GPU reports one; each power source as an energy counter (mJ,
 * with its wrap, and its watts when the source reports them too) or, without a counter, as watts; and where each resident model sits (`place`, from the frame's
 * `ps.models` when given). A source reporting an error, or a scope this does not know, is left out.
 */
export function reading(t, compute, models = null) {
    const gpus = compute?.supported_gpus;
    const gpuBy = Array.isArray(gpus) && gpus.length && gpus.every((g) => Number.isFinite(g?.power?.draw_mw))
        ? Object.fromEntries(gpus.map((g, i) => [String(g.gpu_id ?? i), g.power.draw_mw / 1000])) : null;
    const gpuW = gpuBy ? Object.values(gpuBy).reduce((a, w) => a + w, 0) : null;
    const counters = {}, watts = {};
    for (const s of Array.isArray(compute?.power_sources) ? compute.power_sources : []) {
        if (!s || s.error || !SCOPES.includes(s.scope)) continue;
        const key = `${s.provider}:${s.name ?? s.scope}`;
        if (Number.isFinite(s.energy_mj)) counters[key] = { scope: s.scope, mj: s.energy_mj, wrap: Number.isFinite(s.energy_wrap_mj) ? s.energy_wrap_mj : null, w: Number.isFinite(s.power_mw) ? s.power_mw / 1000 : null };
        else if (Number.isFinite(s.power_mw)) watts[key] = { scope: s.scope, w: s.power_mw / 1000 };
    }
    return { t, gpuW, gpuBy, place: models ? placement(models) : null, counters, watts };
}

/** Where each resident model sits: its normalised name → `{ <gpu_id>: share of its VRAM on that GPU }`; a model the
 *  frame gives no per-GPU sizes for is left out (and counts as on every GPU). */
export function placement(models) {
    const out = {};
    for (const m of Array.isArray(models) ? models : []) {
        const name = m?.name ?? m?.model;
        const gpus = (Array.isArray(m?.gpus) ? m.gpus : []).filter((g) => g?.gpu_id != null && g.size_vram > 0);
        const total = gpus.reduce((a, g) => a + g.size_vram, 0);
        if (name && total > 0) out[normModel(name)] = Object.fromEntries(gpus.map((g) => [String(g.gpu_id), g.size_vram / total]));
    }
    return out;
}

/**
 * The power sources whose energy counter is COARSER than the readings: between two readings it stood still while the
 * source reported drawing more than COARSE_W at both ends. A wall plug's counter (Tasmota's Total) moves in 0.001 kWh =
 * 3.6 kJ steps, about one every 17 s at 200 W, so integrated by its differences each second reads 0 W or a 3.6 kW spike.
 * Such a source is integrated from its watts instead. A fine counter (RAPL's, in µJ) moves every reading and keeps its
 * differences, which are exact where sampled watts are not. Decided over all the readings, so one source is never
 * counted both ways.
 */
export function coarse(readings) {
    const out = new Set();
    for (let i = 1; i < readings.length; i++) {
        const a = readings[i - 1], b = readings[i], dt = b.t - a.t;
        if (!(dt > 0) || dt > MAX_GAP_MS) continue;
        for (const [k, c] of Object.entries(b.counters)) {
            const p = a.counters[k];
            if (p && c.mj === p.mj && c.w > COARSE_W && p.w > COARSE_W) out.add(k);
        }
    }
    return out;
}

/** The energy (J) between each two consecutive readings, per scope: `{ from, to, J: { gpu?, cpu?, system?, wall? },
 *  gpuBy, place }`, `gpuBy` each GPU's share of `J.gpu` (null when the GPUs were not read per card at both ends). */
export function intervals(readings) {
    const out = [];
    const byWatts = coarse(readings);
    for (let i = 1; i < readings.length; i++) {
        const a = readings[i - 1], b = readings[i], dt = b.t - a.t;
        if (!(dt > 0) || dt > MAX_GAP_MS) continue;
        const J = {};
        const add = (scope, j) => { J[scope] = (J[scope] ?? 0) + j; };
        let gpuBy = null;
        if (a.gpuW != null && b.gpuW != null) {
            add("gpu", ((a.gpuW + b.gpuW) / 2) * (dt / 1000));
            const ids = Object.keys(b.gpuBy);
            if (ids.length === Object.keys(a.gpuBy).length && ids.every((id) => a.gpuBy[id] != null)) gpuBy = Object.fromEntries(ids.map((id) => [id, ((a.gpuBy[id] + b.gpuBy[id]) / 2) * (dt / 1000)]));
        }
        for (const [k, c] of Object.entries(b.counters)) {
            const p = a.counters[k];
            if (!p) continue;
            if (byWatts.has(k)) {
                if (c.w != null && p.w != null) add(c.scope, ((p.w + c.w) / 2) * (dt / 1000));
                continue;
            }
            let d = c.mj - p.mj;
            if (d < 0 && c.wrap) d += c.wrap;
            // Still negative, or impossibly fast: the source restarted. That interval is unmeasured for it.
            if (d >= 0 && d / dt <= MAX_W) add(c.scope, d / 1000);
        }
        for (const [k, w] of Object.entries(b.watts)) {
            const p = a.watts[k];
            if (p) add(w.scope, ((p.w + w.w) / 2) * (dt / 1000));
        }
        if (Object.keys(J).length) out.push({ from: a.t, to: b.t, J, gpuBy, place: b.place ?? a.place ?? null });
    }
    return out;
}

/** What an interval counts as the box's draw, scopes never added across: `{ J, basis }`, null when nothing measured it. */
export function measured(J) {
    if (J.wall != null) return { J: J.wall, basis: "wall" };
    if (J.system != null) return { J: J.system, basis: "system" };
    if (J.gpu != null && J.cpu != null) return { J: J.gpu + J.cpu, basis: "gpu+cpu" };
    if (J.gpu != null) return { J: J.gpu, basis: "gpu" };
    if (J.cpu != null) return { J: J.cpu, basis: "cpu" };
    return null;
}

/** What each basis means, in words.
 * @type {Record<string, string>} */
export const BASIS_WORDS = { wall: "at the wall", system: "the whole system", "gpu+cpu": "GPUs + CPU package (the rest of the box not measured)", gpu: "GPUs only", cpu: "CPU package only" };

/**
 * What an interval's measured energy is made of, for splitting: one channel per GPU when the GPUs were read per card
 * (`{ key: "gpu:<id>", gpu, J }`), and the rest of the box as one channel (`box`): the CPU package beside the GPUs, or
 * the wall or system reading less the GPUs. Without per-card readings, the whole measure is one `box` channel. Null
 * when nothing measured the interval.
 */
export function channels(iv) {
    const m = measured(iv.J);
    if (!m) return null;
    if (!iv.gpuBy || m.basis === "cpu") return { m, ch: [{ key: "box", J: m.J }] };
    const gpus = Object.entries(iv.gpuBy).map(([gpu, J]) => ({ key: `gpu:${gpu}`, gpu, J }));
    const rest = m.basis === "gpu" ? null : m.basis === "gpu+cpu" ? iv.J.cpu : Math.max(0, m.J - gpus.reduce((a, c) => a + c.J, 0));
    return { m, ch: rest == null ? gpus : [...gpus, { key: "box", J: rest }] };
}

/** How much of channel `ch` a generation of `model` can draw on: 1 for the box; on a GPU, the model's share of its VRAM
 *  there (0 when it is not on that card), or 1 when where it sits is not known. */
const presence = (ch, model, place) => {
    if (!ch.gpu) return 1;
    const at = model ? place?.[normModel(model)] : null;
    return at ? at[ch.gpu] ?? 0 : 1;
};

/** A generation's span from its gen.end: it ran backwards from the finish for its prompt and decode time. */
export function genSpan({ at, session = null, model = null, promptMs, evalMs }) {
    const ms = (Number(promptMs) || 0) + (Number(evalMs) || 0);
    return ms > 0 ? { from: at - ms, to: at, session, model } : null;
}

/** The electricity rate (per kWh) at moment `t` (ms) under a call's recorded price: the tariff's half for that moment. */
export function rateAt(price, t) {
    const tariff = price?.tariff;
    if (tariff) return isOffPeak(new Date(t), tariff.offPeakHours, tariff.offPeakWeekends, tariff.tz) ? tariff.offPeakPerKwh : tariff.normalPerKwh;
    return price?.perKwh ?? null;
}

const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Each session's share of the measured energy over `ivs` (intervals), against `spans` (every client's generations, so a
 * stranger's takes its share), channel by channel (`channels`: each GPU, and the rest of the box):
 *
 * - a channel in an interval a generation runs in goes, all of it, to the generations running in it that can draw on
 *   it (a GPU: those of models resident on that card, weighted by their share of it), by how much of the interval each
 *   covered; a GPU none of them sits on is drawing for nobody;
 * - in the TAIL_MS after a generation, with none running, a channel's draw above its rest goes to the generations that
 *   ended in that window and could draw on it, equally (the GPUs clock down over seconds, and the server's work around a
 *   generation is wider than its prompt and decode times);
 * - what is left is the box at rest, and nobody's.
 *
 * A channel's rest is its median draw over intervals at least REST_MS after any generation (`restBy[key]` when this
 * stretch has none); with a channel's rest unknown, its tails are not attributed and nothing is "above idle". Returns
 * `{ restW, restBy, sessions }`: the rest of the whole measure in watts, each channel's, and a Map of session →
 * `{ J, aboveJ, tailJ, scopes: { gpu?, cpu?, other? }, bases: Set, ms, at: [[t, J, aboveJ]] }`, `ms` the generation
 * time and `at` each piece's moment, for pricing.
 */
export function attribute(ivs, spans, { restBy = {} } = {}) {
    const sorted = spans.filter(Boolean).sort((a, b) => a.from - b.from);
    const byEnd = [...sorted].sort((a, b) => a.to - b.to);
    const pieces = [], rest = {};
    let first = 0, e0 = 0, e1 = 0;
    for (const iv of ivs) {
        const c = channels(iv);
        if (!c) continue;
        const dt = iv.to - iv.from;
        // Spans are in start order; one that ended before this interval is skipped once it heads the list.
        while (first < sorted.length && sorted[first].to <= iv.from) first++;
        const on = [];
        for (let k = first; k < sorted.length && sorted[k].from < iv.to; k++) {
            const o = Math.min(iv.to, sorted[k].to) - Math.max(iv.from, sorted[k].from);
            if (o > 0) on.push([sorted[k], o]);
        }
        if (on.length) { pieces.push({ iv, c, dt, on }); continue; }
        // The generations that ended in the TAIL_MS before this interval.
        while (e1 < byEnd.length && byEnd[e1].to <= iv.from) e1++;
        while (e0 < e1 && byEnd[e0].to <= iv.from - TAIL_MS) e0++;
        // With no generation before it, quiet is only known once the readings themselves go back REST_MS: one may have
        // ended just before the stretch read.
        const lastEnd = e1 ? byEnd[e1 - 1].to : ivs[0].from;
        if (iv.from - lastEnd >= REST_MS) for (const ch of c.ch) (rest[ch.key] ??= []).push(ch.J / (dt / 1000));
        if (e1 > e0) pieces.push({ iv, c, dt, after: byEnd.slice(e0, e1) });
    }
    const keys = new Set([...Object.keys(rest), ...Object.keys(restBy)]);
    const R = Object.fromEntries([...keys].map((k) => [k, median(rest[k] ?? []) ?? restBy[k] ?? null]));
    const sessions = new Map();
    const shareOf = (session) => sessions.get(session) ?? sessions.set(session, { J: 0, aboveJ: 0, tailJ: 0, scopes: {}, bases: new Set(), ms: 0, at: [] }).get(session);
    const scopeOf = (ch, m) => (ch.gpu ? "gpu" : m.basis === "gpu+cpu" || m.basis === "cpu" ? "cpu" : ch.key === "box" && m.basis === "gpu" ? "gpu" : "other");
    const add = (share, ch, m, t, J, above, tail = false) => {
        share.J += J;
        if (tail) share.tailJ += J;
        share.aboveJ = share.aboveJ == null || above == null ? null : share.aboveJ + above;
        share.bases.add(m.basis);
        const k = scopeOf(ch, m);
        share.scopes[k] = (share.scopes[k] ?? 0) + J;
        share.at.push([t, J, above]);
    };
    for (const { iv, c, dt, on, after } of pieces) {
        const t = (iv.from + iv.to) / 2;
        for (const ch of c.ch) {
            const Rk = R[ch.key] ?? null;
            if (on) {
                const w = on.map(([s, o]) => presence(ch, s.model, iv.place) * o);
                const W = w.reduce((a, x) => a + x, 0);
                if (!(W > 0)) continue;
                on.forEach(([s], i) => {
                    if (!s.session || !w[i]) return;
                    const f = w[i] / W, J = ch.J * f;
                    add(shareOf(s.session), ch, c.m, t, J, Rk == null ? null : J - Rk * ((dt * f) / 1000));
                });
                continue;
            }
            if (Rk == null) continue;
            const excess = ch.J - Rk * (dt / 1000);
            const to = after.filter((s) => presence(ch, s.model, iv.place) > 0);
            if (!(excess > 0) || !to.length) continue;
            for (const s of to) if (s.session) add(shareOf(s.session), ch, c.m, t, excess / to.length, excess / to.length, true);
        }
        // Generation time, once per interval whatever the channels: how long each span ran in it.
        if (on) for (const [s, o] of on) if (s.session) shareOf(s.session).ms += o;
    }
    const known = Object.values(R).filter((x) => x != null);
    return { restW: known.length && known.length === keys.size ? known.reduce((a, x) => a + x, 0) : null, restBy: R, sessions };
}

/** A share priced at each piece's own rate: `{ cost, costAbove, currency }`, both null without a price. */
export function priceShare(share, price) {
    const none = { cost: null, costAbove: null, currency: null };
    if (!price) return none;
    let cost = 0, costAbove = share.aboveJ == null ? null : 0;
    for (const [t, J, above] of share.at) {
        const r = rateAt(price, t);
        if (!(r > 0)) return none;
        cost += (J / J_PER_KWH) * r;
        if (costAbove != null) costAbove += (Math.max(0, above) / J_PER_KWH) * r;
    }
    return { cost, costAbove, currency: price.currency || null };
}

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
