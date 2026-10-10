// rasch.mjs — the scoreboard's fit: one ability per model and one difficulty per task from pass/fail runs, so models that
// ran different tasks can still be compared (scores.mjs feeds it the runs logged in scores.sqlite).
//
// The model is the Rasch (one-parameter logistic) model of item response theory: a run of model m on task t passes with
//
//     P(pass) = σ(θ_m − b_t),   σ(x) = 1 / (1 + e^−x)
//
// θ_m is the model's ability and b_t the task's difficulty, both on the log-odds scale: a model one unit above a task's
// difficulty passes it e times as often as it fails it. A pass rate alone confuses the two (a model that only ran easy
// tasks looks strong); the fit separates them, since every task is shared by the models that ran it.
//
// The estimate is the MAXIMUM A POSTERIORI with a normal prior N(0, priorSd²) on every θ and every b. The prior is what
// keeps the estimate finite for a model that passed (or failed) everything it ran, and what fixes the scale's zero (only
// differences θ − b are in the data). It is found by Newton's method on all parameters at once; the log posterior is
// strictly concave, so it converges from zero.
//
// Only differences are identified, so every number is REPORTED relative to the average difficulty b̄ of the tasks in the
// fit: a model's score is θ_m − b̄ (0 means even odds on a task of average difficulty) and a task's is b_t − b̄. Each
// standard error is that contrast's, cᵀ Σ c, with Σ the inverse of the negative Hessian at the optimum (the Laplace
// approximation). The raw θ's own variance would include the shift of the whole scale, which the data say nothing
// about and which no comparison between models depends on. The interval is the estimate ± z standard errors.

/** σ(x), without overflow for large |x|. */
export const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

/** The Cholesky factor L (A = L Lᵀ) of a symmetric positive definite matrix (row arrays), and log det A. */
export function cholesky(a) {
    const n = a.length;
    const l = a.map(() => new Array(n).fill(0));
    let logDet = 0;
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = a[i][j];
            for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
            l[i][j] = i === j ? Math.sqrt(s) : s / l[j][j];
        }
        logDet += 2 * Math.log(l[i][i]);
    }
    return { l, logDet };
}

/** The inverse of a symmetric positive definite matrix (row arrays), by Cholesky. */
export function spdInverse(a) {
    const n = a.length;
    const { l } = cholesky(a);
    // L⁻¹ by forward substitution, then A⁻¹ = L⁻ᵀ L⁻¹.
    const li = l.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        li[i][i] = 1 / l[i][i];
        for (let j = 0; j < i; j++) {
            let s = 0;
            for (let k = j; k < i; k++) s += l[i][k] * li[k][j];
            li[i][j] = -s / l[i][i];
        }
    }
    const inv = a.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
        let s = 0;
        for (let k = i; k < n; k++) s += li[k][i] * li[k][j];
        inv[i][j] = inv[j][i] = s;
    }
    return inv;
}

/** The fit's settings, which the scoreboard states beside its numbers. */
export const RASCH_DEFAULTS = { priorSd: 2, z: 1.96, maxIter: 100, tol: 1e-9 };

/**
 * Fit θ per model and b per task from pass/fail observations.
 *
 * @param {{model: string, task: string, passed: boolean}[]} obs one per scored run
 * @param {Partial<typeof RASCH_DEFAULTS>} [opts]
 * @returns {{models: Map<string, {theta: number, se: number, lo: number, hi: number}>, tasks: Map<string, {b: number, se: number, lo: number, hi: number}>, iterations: number, converged: boolean}}
 *   `theta` and `b` both relative to the mean task difficulty (see the header)
 */
export function fitRasch(obs, opts = {}) {
    const { priorSd, z, maxIter, tol } = { ...RASCH_DEFAULTS, ...opts };
    const models = [...new Set(obs.map((o) => o.model))];
    const tasks = [...new Set(obs.map((o) => o.task))];
    const M = models.length, n = M + tasks.length;
    const mi = new Map(models.map((m, i) => [m, i]));
    const ti = new Map(tasks.map((t, i) => [t, M + i]));
    const rows = obs.map((o) => [mi.get(o.model), ti.get(o.task), o.passed ? 1 : 0]);
    const x = new Array(n).fill(0);
    const prec = 1 / (priorSd * priorSd);

    // The negative Hessian and the gradient of the log posterior at x. θ enters η = θ − b with +1, b with −1.
    const curvature = () => {
        const h = Array.from({ length: n }, () => new Array(n).fill(0));
        const g = x.map((v) => -v * prec);
        for (let i = 0; i < n; i++) h[i][i] = prec;
        for (const [m, t, y] of rows) {
            const p = sigmoid(x[m] - x[t]);
            const w = p * (1 - p);
            g[m] += y - p;
            g[t] -= y - p;
            h[m][m] += w; h[t][t] += w;
            h[m][t] -= w; h[t][m] -= w;
        }
        return { h, g };
    };

    let iterations = 0, converged = n === 0;
    while (!converged && iterations < maxIter) {
        iterations++;
        const { h, g } = curvature();
        const inv = spdInverse(h);
        let step = 0;
        for (let i = 0; i < n; i++) {
            let d = 0;
            for (let j = 0; j < n; j++) d += inv[i][j] * g[j];
            x[i] += d;
            step = Math.max(step, Math.abs(d));
        }
        converged = step < tol;
    }
    const cov = n ? spdInverse(curvature().h) : [];
    const T = tasks.length;
    const bBar = tasks.reduce((a, _, j) => a + x[M + j], 0) / (T || 1);
    // Var(x_i − b̄) = Σ_ii − (2/T) Σ_j Σ_i,j + (1/T²) Σ_j,k Σ_j,k over the task indices j, k.
    let barVar = 0;
    for (let j = M; j < n; j++) for (let k = M; k < n; k++) barVar += cov[j][k];
    barVar /= T * T || 1;
    const centred = (i) => {
        const v = x[i] - bBar;
        let c = 0;
        for (let j = M; j < n; j++) c += cov[i][j];
        const se = Math.sqrt(Math.max(0, cov[i][i] - (2 * c) / T + barVar));
        return { v, se, lo: v - z * se, hi: v + z * se };
    };
    return {
        models: new Map(models.map((m, i) => { const { v, ...e } = centred(i); return [m, { theta: v, ...e }]; })),
        tasks: new Map(tasks.map((t, j) => { const { v, ...e } = centred(M + j); return [t, { b: v, ...e }]; })),
        iterations, converged,
    };
}
