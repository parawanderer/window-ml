// regress.mjs — the regression suite's verdict: did a build make the suite's tasks harder for the models, read from the
// regression runs in scores.sqlite (`suite = 'regression'`, logged by `run.mjs --regression`).
//
// The model extends the scoreboard's Rasch fit (rasch.mjs) with a shift for the build under test:
//
//     P(pass) = σ(θ_m − b_t − δ_t·[build is the one under test])
//     δ_t ~ N(μ, τ²),   θ_m, b_t, μ ~ N(0, priorSd²)
//
// θ_m (a model's ability) and b_t (a task's difficulty) are fixed by every run, and do not vary by build: were θ fitted
// per build, a build that made every task harder would be absorbed into the abilities and never show. A model is its
// name and digest (`modelKey`), so an updated model is a new model rather than a regression of ours. The BASELINE is
// every regression run of an earlier build, pooled; comparing build by build would chain one noisy fit to the next.
//
// μ is the build-wide shift, the headline: a prompt change makes every task a little harder, which a prior centred on
// 0 would shrink back toward "nothing changed". δ_t is each task's own shift, pulled toward μ by how much the tasks'
// shifts spread (τ). The pull is a Student-t (ν = 4), not a normal: with a normal, one task that broke badly raised μ and
// dragged every unchanged task's δ above 0 with it (measured: about one false flag per run in a simulation of one broken
// task in five). τ is averaged over a grid, each weighted by the Laplace approximation to its marginal likelihood
// times a half-normal hyperprior; with a handful of tasks that likelihood is nearly flat and its maximum sits at the
// smallest τ, which smeared one task's regression over the whole build. Each reported probability is the Laplace
// posterior's, mixed over τ: P(δ_t > 0) = Σ w_τ Φ(δ̂_t / sd).
//
// Many tasks are read at once, so a task is FLAGGED by the Bayesian false discovery rate rather than one threshold
// each: the tasks most likely to have got harder, as many as keep the mean chance that a flagged one did NOT under q.
// The build is flagged when P(μ > 0) is at least `buildP`. A flagged task says which models' pass rates fell; a flag
// one model alone carries says so, since a cloud model can change behind the same name.
//
// An item is the task's id and its own hash (what it asks and how it is scored), never what the model was SHOWN: the
// prompt and tool descriptions belong to the build, and are what the suite exists to compare.

import { sigmoid, cholesky, spdInverse } from "./rasch.mjs";

/** The fit's settings, stated beside its numbers. `power` is the chance of seeing a shift of the detectable size. */
export const REGRESS_DEFAULTS = {
    priorSd: 2, z: 1.96, q: 0.1, buildP: 0.95, power: 0.8, alpha: 0.05,
    taus: Array.from({ length: 11 }, (_, k) => 0.05 * 1.5 ** k), tauSd: 1, nu: 4, minShift: 0.5, maxIter: 100, tol: 1e-9,
};

/** The suite's name in the runs table's `suite` column. */
export const REGRESSION_SUITE = "regression";

/** A regression item: the task and its own hash, not what it was shown (see the header). */
export const regressionItem = (r) => `${r.task}#${r.task_hash}`;

/** Φ(x), the standard normal CDF (Abramowitz and Stegun 7.1.26 through erf; error under 1.5e-7). */
export function normalCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** log Γ(x) for x > 0 (Lanczos, g = 7). */
function lgamma(x) {
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Φ⁻¹(p), by bisection on `normalCdf` (only ever asked for a handful of quantiles). */
const normalQuantile = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (normalCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };

/**
 * One MAP fit at a given τ. `obs` are `{ model, task, passed, now }` (`now`: the run is of the build under test);
 * `shifted` the tasks that get a δ (those with runs on both sides).
 * @returns {{ x: number[], cov: number[][], logMarginal: number, index: { model: Map, task: Map, mu: number, delta: Map }, converged: boolean }}
 */
function fitAt(obs, models, tasks, shifted, tau, { priorSd, nu, maxIter, tol }) {
    const M = models.length, T = tasks.length;
    const model = new Map(models.map((m, i) => [m, i]));
    const task = new Map(tasks.map((t, i) => [t, M + i]));
    const mu = M + T;
    const delta = new Map(shifted.map((t, i) => [t, mu + 1 + i]));
    const n = mu + 1 + shifted.length;
    const rows = obs.map((o) => [model.get(o.model), task.get(o.task), o.now && delta.has(o.task) ? delta.get(o.task) : -1, o.passed ? 1 : 0]);
    const p0 = 1 / (priorSd * priorSd);
    // Each δ's precision about μ: 1/τ² scaled by its weight λ (the Student-t as a scale mixture of normals, below).
    const lam = new Map(shifted.map((t) => [delta.get(t), 1]));
    const pt = (d) => lam.get(d) / (tau * tau);
    const x = new Array(n).fill(0);
    const eta = (m, t, d) => x[m] - x[t] - (d >= 0 ? x[d] : 0);
    const curvature = () => {
        const h = Array.from({ length: n }, () => new Array(n).fill(0));
        const g = new Array(n).fill(0);
        for (let i = 0; i <= mu; i++) { g[i] -= x[i] * p0; h[i][i] += p0; }
        for (const [, d] of delta) {
            const r = x[d] - x[mu], q = pt(d);
            g[d] -= r * q; g[mu] += r * q;
            h[d][d] += q; h[mu][mu] += q; h[d][mu] -= q; h[mu][d] -= q;
        }
        for (const [m, t, d, y] of rows) {
            const p = sigmoid(eta(m, t, d)), w = p * (1 - p);
            // ∂η: +1 on θ, −1 on b and δ.
            const c = d >= 0 ? [[m, 1], [t, -1], [d, -1]] : [[m, 1], [t, -1]];
            for (const [i, ci] of c) { g[i] += (y - p) * ci; for (const [j, cj] of c) h[i][j] += w * ci * cj; }
        }
        return { h, g };
    };
    const newton = () => {
        let it = 0, done = false;
        while (!done && it++ < maxIter) {
            const { h, g } = curvature();
            const inv = spdInverse(h);
            let step = 0;
            for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += inv[i][j] * g[j]; x[i] += s; step = Math.max(step, Math.abs(s)); }
            done = step < tol;
        }
        return done;
    };
    // δ_t − μ is Student-t (ν degrees of freedom, scale τ), fitted by EM over its scale-mixture weights: a task far from
    // the rest gets a small λ and a loose prior, so one broken task neither moves μ nor drags the others along with it.
    let converged = newton();
    for (let em = 0; em < 30; em++) {
        const cov = spdInverse(curvature().h);
        let moved = 0;
        for (const [, d] of delta) {
            const e = x[d] - x[mu], v = cov[d][d] + cov[mu][mu] - 2 * cov[d][mu];
            const next = (nu + 1) / (nu + (e * e + v) / (tau * tau));
            moved = Math.max(moved, Math.abs(next - lam.get(d)));
            lam.set(d, next);
        }
        converged = newton();
        if (moved < 1e-4) break;
    }
    // The log joint at the optimum, normalising constants included (τ's comparison depends on them), then Laplace.
    const logN = (v, m, prec) => 0.5 * Math.log(prec / (2 * Math.PI)) - 0.5 * prec * (v - m) ** 2;
    let lj = 0;
    for (const [m, t, d, y] of rows) { const p = sigmoid(eta(m, t, d)); lj += y ? Math.log(p) : Math.log(1 - p); }
    for (let i = 0; i <= mu; i++) lj += logN(x[i], 0, p0);
    // The Student-t density of each shift about μ, not the normal at its EM weight, so τ is compared under the real prior.
    const logT = (e) => lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI * tau * tau) - ((nu + 1) / 2) * Math.log(1 + (e * e) / (nu * tau * tau));
    for (const [, d] of delta) lj += logT(x[d] - x[mu]);
    const { h } = curvature();
    const logMarginal = lj + (n / 2) * Math.log(2 * Math.PI) - 0.5 * cholesky(h).logDet;
    return { x, cov: spdInverse(h), logMarginal, index: { model, task, mu, delta }, converged };
}

/**
 * The verdict on one build against every regression run of the builds before it.
 *
 * @param {object[]} rows the runs table's rows (scores.mjs `readRuns`); only `suite = 'regression'`, scored, error-free ones count
 * @param {{ build?: string, modelKey: (r: object) => string } & Partial<typeof REGRESS_DEFAULTS>} opts `build`: the build
 *   under test, by default the newest (by its first run)
 * @returns {object | null} null when there is no regression run, or no earlier build to compare with
 */
export function regressionVerdict(rows, opts) {
    const o = { ...REGRESS_DEFAULTS, ...opts };
    const runs = rows.filter((r) => r.suite === REGRESSION_SUITE && r.scored && !r.error && r.passed != null);
    const builds = buildOrder(runs);
    const build = o.build ?? builds.at(-1)?.build;
    const at = builds.findIndex((b) => b.build === build);
    if (at < 1) return null;
    const before = new Set(builds.slice(0, at).map((b) => b.build));
    const obs = runs.filter((r) => r.build === build || before.has(r.build))
        .map((r) => ({ model: o.modelKey(r), task: regressionItem(r), passed: !!r.passed, now: r.build === build, r }));
    const sides = new Map();
    for (const x of obs) { const s = sides.get(x.task) ?? { base: 0, now: 0 }; s[x.now ? "now" : "base"]++; sides.set(x.task, s); }
    const shifted = [...sides].filter(([, s]) => s.base && s.now).map(([t]) => t);
    if (!shifted.length) return null;
    const models = [...new Set(obs.map((x) => x.model))], tasks = [...sides.keys()];
    // τ by the marginal likelihood (empirical Bayes), then everything read at that τ.
    // Each τ on the grid weighted by its marginal likelihood times the hyperprior (half-normal, scale `tauSd`), the grid
    // being even in log τ; every number is then the mixture over τ. The marginal likelihood alone is nearly flat in τ
    // with a handful of tasks, and its maximum often sits at the smallest τ, which would smear one task's regression
    // over the whole build.
    const fits = o.taus.map((tau) => ({ tau, ...fitAt(obs, models, tasks, shifted, tau, o) }));
    const lw = fits.map((f) => f.logMarginal - (f.tau * f.tau) / (2 * o.tauSd * o.tauSd) + Math.log(f.tau));
    const top = Math.max(...lw);
    const w = lw.map((l) => Math.exp(l - top)), wSum = w.reduce((a, b) => a + b, 0);
    fits.forEach((f, k) => { f.weight = w[k] / wSum; });
    const best = fits.reduce((a, b) => (b.weight > a.weight ? b : a));
    const post = (i) => {
        let v = 0, second = 0, pUp = 0, pReal = 0;
        const above = (m, sd, at) => (sd ? normalCdf((m - at) / sd) : m > at ? 1 : 0);
        for (const f of fits) {
            const m = f.x[i], sd = Math.sqrt(Math.max(0, f.cov[i][i]));
            v += f.weight * m; second += f.weight * (sd * sd + m * m);
            pUp += f.weight * above(m, sd, 0);
            pReal += f.weight * above(m, sd, o.minShift);
        }
        const sd = Math.sqrt(Math.max(0, second - v * v));
        return { v, sd, lo: v - o.z * sd, hi: v + o.z * sd, pUp, pReal };
    };
    // The smallest shift this design would see with probability `power` at one-sided level `alpha`: from the
    // information the build's own runs carry about δ_t (no pooling), at the fitted pass chances.
    const zSum = normalQuantile(1 - o.alpha) + normalQuantile(o.power);
    const { model: mIdx, task: tIdx } = best.index;
    const taskRows = shifted.map((t) => {
        const own = obs.filter((x) => x.task === t);
        let info = 0;
        for (const x of own) if (x.now) { const p = sigmoid(best.x[mIdx.get(x.model)] - best.x[tIdx.get(t)]); info += p * (1 - p); }
        const byModel = new Map();
        for (const x of own) {
            const e = byModel.get(x.model) ?? { model: x.model, base: { passed: 0, runs: 0 }, now: { passed: 0, runs: 0 } };
            const side = x.now ? e.now : e.base;
            side.runs++; if (x.passed) side.passed++;
            byModel.set(x.model, e);
        }
        const perModel = [...byModel.values()];
        const fell = perModel.filter((e) => e.base.runs && e.now.runs && e.now.passed / e.now.runs < e.base.passed / e.base.runs).map((e) => e.model);
        const r0 = own[0].r;
        return { key: t, task: r0.task, taskHash: r0.task_hash, text: r0.task_text, delta: post(best.index.delta.get(t)), detectable: info ? zSum / Math.sqrt(info) : null, models: perModel, fell, flagged: false, oneModel: false };
    });
    // Bayesian FDR: most likely first, as many as keep the mean P(not harder) of the flagged set at or under q.
    const order = taskRows.slice().sort((a, b) => b.delta.pReal - a.delta.pReal || b.delta.pUp - a.delta.pUp);
    let k = 0, miss = 0;
    for (let i = 0; i < order.length; i++) { miss += 1 - order[i].delta.pReal; if (miss / (i + 1) <= o.q) k = i + 1; }
    for (const t of order.slice(0, k)) { t.flagged = true; t.oneModel = t.fell.length === 1; }
    const mu = post(best.index.mu);
    return {
        build, baseline: [...before], builds: builds.map((b) => b.build),
        mu, flagged: mu.pUp >= o.buildP,
        tasks: order,
        unmatched: [...sides].filter(([, s]) => !(s.base && s.now)).map(([t, s]) => ({ key: t, side: s.now ? "now" : "base" })),
        runs: { now: obs.filter((x) => x.now).length, base: obs.filter((x) => !x.now).length },
        method: { minShift: o.minShift, tau: fits.reduce((a, f) => a + f.weight * f.tau, 0), tauSd: o.tauSd, taus: o.taus, priorSd: o.priorSd, z: o.z, q: o.q, buildP: o.buildP, power: o.power, alpha: o.alpha, converged: best.converged },
    };
}

/** The builds the regression runs came from, oldest first (by each build's first run). */
export function buildOrder(runs) {
    const first = new Map();
    for (const r of runs) if (!first.has(r.build) || r.at < first.get(r.build)) first.set(r.build, r.at);
    return [...first].map(([build, at]) => ({ build, at })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The verdict for every build that has an earlier one, oldest first: the history the page draws (μ and each task's δ
 * per build). The last entry is `regressionVerdict` for the newest build.
 */
export function regressionHistory(rows, opts) {
    const runs = rows.filter((r) => r.suite === REGRESSION_SUITE && r.scored && !r.error && r.passed != null);
    return buildOrder(runs).slice(1).map(({ build }) => regressionVerdict(runs, { ...opts, build })).filter(Boolean);
}

/**
 * Before a suite run: the smallest shift each task could show, for a planned model list and repeat count, at the chances
 * the earlier regression runs fitted (θ per model, b per task, from a fit with no shift). A model with no earlier run is
 * taken at the average ability. Printed at the start of `run.mjs --regression`, so a run too small to see anything says so.
 * @returns {{ task: string, detectable: number | null }[]}
 */
export function plannedPower(rows, { models, repeats, modelKey, fitRasch, ...rest }) {
    const o = { ...REGRESS_DEFAULTS, ...rest };
    const runs = rows.filter((r) => r.suite === REGRESSION_SUITE && r.scored && !r.error && r.passed != null);
    if (!runs.length) return [];
    const fit = fitRasch(runs.map((r) => ({ model: modelKey(r), task: regressionItem(r), passed: !!r.passed })), { priorSd: o.priorSd });
    const zSum = normalQuantile(1 - o.alpha) + normalQuantile(o.power);
    // A planned model is matched by name: its digest is not known before it runs.
    const theta = (name) => [...fit.models].find(([k]) => k === name || k.startsWith(`${name}@`))?.[1].theta ?? 0;
    return [...fit.tasks].map(([task, t]) => {
        const info = models.reduce((a, m) => { const p = sigmoid(theta(m) - t.b); return a + repeats * p * (1 - p); }, 0);
        return { task, detectable: info ? zSum / Math.sqrt(info) : null };
    });
}

/**
 * The regression suite on the scoreboard: the newest build's verdict, and μ for every build that had an earlier one (the
 * history the page draws). Null without regression runs of at least two builds.
 */
export function regressionReport(rows, opts) {
    const history = regressionHistory(rows, opts);
    if (!history.length) return null;
    const runs = rows.filter((r) => r.suite === REGRESSION_SUITE && r.scored && !r.error && r.passed != null);
    const at = new Map(buildOrder(runs).map((b) => [b.build, b.at]));
    return {
        verdict: history.at(-1),
        history: history.map((v) => ({ build: v.build, at: at.get(v.build), mu: v.mu, flagged: v.flagged, tasks: v.tasks.map((t) => ({ key: t.key, task: t.task, delta: t.delta, flagged: t.flagged })) })),
    };
}

const sgn = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
const pc = (p) => `${Math.round(p * 100)}%`;
const shortBuild = (b) => String(b).slice(0, 12);

/** What each number of the regression report is: scores.md's notes and the page's tooltips. */
export const regressionAbout = (m) => ({
    mu: `μ: how much harder this build made the suite's tasks on the whole, in log-odds (+1 is e times the odds of failing), against every regression run of the builds before it. The model is P(pass) = σ(θ − b − δ), with θ per model and b per task fixed across builds, and each task's shift δ drawn from a Student-t (ν = 4) around μ. The build is flagged when P(μ > 0) is at least ${pc(m.buildP)}.`,
    delta: `δ: how much harder this build made one task, in log-odds, pulled toward μ by how much the tasks' shifts spread (τ ≈ ${m.tau.toFixed(2)}, averaged over a grid under a half-normal hyperprior). A task is flagged by the Bayesian false discovery rate at ${pc(m.q)} on P(δ > ${m.minShift}): the tasks most likely to have got at least ${m.minShift} harder, as many as keep the expected share of wrong flags under ${pc(m.q)}.`,
    detectable: `The smallest δ this build's runs of the task would show ${pc(m.power)} of the time (one-sided, ${pc(m.alpha)}), from the information its runs carry at the fitted chances. More repeats or more models make it smaller.`,
    models: "Each model's passes on the task, before (the earlier builds' regression runs) and now. A flag only one model's drop carries is marked: a cloud model can change behind the same name.",
});

/** The regression report as markdown, for scores.md. */
export function regressionText(report) {
    if (!report) return [];
    const v = report.verdict, about = regressionAbout(v.method);
    const out = ["## Regression suite", ""];
    out.push(`Build \`${shortBuild(v.build)}\` against ${v.baseline.length} earlier build${v.baseline.length === 1 ? "" : "s"} (${v.runs.now} runs now, ${v.runs.base} before). ${v.flagged ? "**The build is flagged.**" : "The build is not flagged."}`, "");
    out.push(`μ = ${sgn(v.mu.v)} [${sgn(v.mu.lo)}, ${sgn(v.mu.hi)}], P(harder) = ${pc(v.mu.pUp)}.`, "");
    out.push("| task | δ [interval] | P(δ > 0) | P(δ > " + v.method.minShift + ") | flagged | detectable | passes by model, before → now |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const t of v.tasks) {
        const by = t.models.map((m) => `${m.model} ${m.base.passed}/${m.base.runs} → ${m.now.passed}/${m.now.runs}`).join("; ");
        out.push(`| ${t.task} | ${sgn(t.delta.v)} [${sgn(t.delta.lo)}, ${sgn(t.delta.hi)}] | ${pc(t.delta.pUp)} | ${pc(t.delta.pReal)} | ${t.flagged ? (t.oneModel ? "yes, one model" : "yes") : ""} | ${t.detectable == null ? "" : t.detectable.toFixed(1)} | ${by} |`);
    }
    if (v.unmatched.length) out.push("", `Not compared (runs on one side only): ${v.unmatched.map((u) => `${u.key} (${u.side === "now" ? "new" : "not run now"})`).join(", ")}.`);
    if (report.history.length > 1) {
        out.push("", "| build | first run | μ [interval] | flagged tasks |", "| --- | --- | --- | --- |");
        for (const h of report.history) out.push(`| \`${shortBuild(h.build)}\` | ${String(h.at).slice(0, 16).replace("T", " ")} | ${sgn(h.mu.v)} [${sgn(h.mu.lo)}, ${sgn(h.mu.hi)}]${h.flagged ? " (flagged)" : ""} | ${h.tasks.filter((t) => t.flagged).map((t) => t.task).join(", ")} |`);
    }
    out.push("");
    for (const [k, s] of Object.entries(about)) out.push(`- **${k}**: ${s}`);
    out.push("");
    return out;
}
