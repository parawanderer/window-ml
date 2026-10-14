// user-dynamics.ts — a person's input policy, factorised over the fields an event envelope leaves free:
// inter-key intervals, key holds, click placement, move trajectories and durations. Maximum-likelihood
// fit from their own trajectories; the likelihood is the escalation statistic. No dependencies.

/** One input event of a trajectory, times in milliseconds from the trajectory's start. */
export interface DynEvent {
    /** The event kind this factor conditions on: "down" / "up" / "move" / "click". */
    kind: "down" | "up" | "move" | "click";
    /** Key class for a press: letter, digit, space, shift, punct, named — or "" for a pointer event. */
    keyClass: string;
    /** Viewport coordinate of a pointer event; null on a key. */
    x: number | null;
    y: number | null;
    t: number;
    /** How long the key was held (down→up), ms; null on a pointer event. */
    hold: number | null;
}

/** A recorded trajectory: the state the person acted in (target centre and size in viewport units)
 *  and the events they produced. */
export interface Trajectory {
    /** Target centre the action was aimed at. */
    tx: number;
    ty: number;
    /** Target size, so click placement can be expressed in target-local units. */
    tw: number;
    th: number;
    events: DynEvent[];
}

interface Gaussian1 {
    n: number;
    mu: number;
    m2: number;
}

interface Gaussian2 {
    n: number;
    mux: number;
    muy: number;
    /** Unnormalised covariance accumulators (sum of centred products, Welford-style). */
    sxx: number;
    syy: number;
    sxy: number;
}

const g1 = (): Gaussian1 => ({ n: 0, mu: 0, m2: 0 });
const g2 = (): Gaussian2 => ({ n: 0, mux: 0, muy: 0, sxx: 0, syy: 0, sxy: 0 });

/** Welford update of a scalar mean/variance accumulator. Durations are pushed already logged. */
function push1(a: Gaussian1, x: number): void {
    a.n += 1;
    const d = x - a.mu;
    a.mu += d / a.n;
    a.m2 += d * (x - a.mu);
}

/** Welford update of a 2D mean/covariance accumulator. */
function push2(a: Gaussian2, x: number, y: number): void {
    a.n += 1;
    const dx = x - a.mux, dy = y - a.muy;
    a.mux += dx / a.n;
    a.muy += dy / a.n;
    a.sxx += dx * (x - a.mux);
    a.syy += dy * (y - a.muy);
    a.sxy += dx * (y - a.muy);
}

const var1 = (a: Gaussian1): number => (a.n > 1 ? a.m2 / (a.n - 1) : 0);
const var2 = (a: Gaussian2) => {
    const den = a.n > 1 ? a.n - 1 : 1;
    return { sxx: a.sxx / den, syy: a.syy / den, sxy: a.sxy / den };
};

/** The floor a duration's σ takes (in log space) so a single sample cannot make the density infinite. */
const SIGMA_FLOOR = 0.05;
/** The floor on a lognormal density, so one far-out sample cannot dominate a trajectory's likelihood. */
const DENSITY_FLOOR = 1e-6;

function logNormalLogPdf(x: number, mu: number, sigma: number): number {
    if (!(x > 0)) return Math.log(DENSITY_FLOOR);
    const s = Math.max(sigma, SIGMA_FLOOR);
    const z = (Math.log(x) - mu) / s;
    return -Math.log(x) - Math.log(s) - 0.5 * Math.log(2 * Math.PI) - 0.5 * z * z;
}

function gaussLogPdf(x: number, mu: number, sigma: number): number {
    const s = Math.max(sigma, SIGMA_FLOOR);
    const z = (x - mu) / s;
    return -Math.log(s) - 0.5 * Math.log(2 * Math.PI) - 0.5 * z * z;
}

/** The fit: per-key-class lognormals for interval and hold, a 2D Gaussian for click placement (in
 *  target-local units, x/w and y/h, so a big button and a small link share one distribution), a
 *  lognormal for move duration, and a linear move-duration model `log T = α + β log d` whose
 *  residual σ is the third number. */
export interface DynamicsFit {
    /** key class → lognormal of the interval BEFORE a key of that class. */
    interval: Map<string, { mu: number; sigma: number; n: number }>;
    /** key class → lognormal of how long that class is held. */
    hold: Map<string, { mu: number; sigma: number; n: number }>;
    /** Click placement in target-local units. */
    place: { mux: number; muy: number; sxx: number; syy: number; sxy: number; n: number };
    /** log T = alpha + beta log d + ε, ε ~ N(0, moveSigma²). */
    move: { alpha: number; beta: number; sigma: number; n: number };
}

/** Accumulators the fit is grown through, so a session can keep folding trajectories in. */
export class DynamicsModel {
    private interval = new Map<string, Gaussian1>();
    private hold = new Map<string, Gaussian1>();
    private place = g2();
    /** Move duration against distance: enough statistics for the line and its residual. */
    private moveN = 0;
    private moveSx = 0; private moveSy = 0;
    private moveSxx = 0; private moveSxy = 0;
    private moveSyy = 0;
    private lastT = new Map<string, number>();
    private priorN = 2;

    /** The prior a class starts from: one second between keys, 80 ms hold, both with wide σ. */
    private classAcc(c: string): Gaussian1 {
        let a = this.interval.get(c);
        if (!a) { a = g1(); this.interval.set(c, a); }
        return a;
    }

    /** Mean and variance are over `log` durations, so `mu` is the lognormal's μ. */

    private holdAcc(c: string): Gaussian1 {
        let a = this.hold.get(c);
        if (!a) { a = g1(); this.hold.set(c, a); }
        return a;
    }

    /** Fold one trajectory in. The inter-key interval is measured down→down (the standard IKI) and
     *  attributed to the LATTER key's class; holds are the paired down→up span. */
    add(τ: Trajectory): void {
        const evs = [...τ.events].sort((a, b) => a.t - b.t);
        let prevDown: DynEvent | null = null;
        let openDown: DynEvent | null = null;
        for (const e of evs) {
            if (e.kind === "down") {
                if (prevDown && e.t > prevDown.t) push1(this.classAcc(e.keyClass || "down"), Math.log(e.t - prevDown.t));
                prevDown = e;
                openDown = e;
            }
            if (e.kind === "up") {
                if (openDown && e.t > openDown.t && openDown.keyClass) push1(this.holdAcc(openDown.keyClass), Math.log(e.t - openDown.t));
                openDown = null;
            }
            if ((e.kind === "click" || e.kind === "up") && e.x != null && e.y != null && τ.tw > 0 && τ.th > 0) {
                push2(this.place, (e.x - τ.tx) / τ.tw, (e.y - τ.ty) / τ.th);
            }
        }
        // Move hops: consecutive move/click points, distance against elapsed time.
        const pts = evs.filter((e) => e.x != null && e.y != null);
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const d = Math.hypot((b.x as number) - (a.x as number), (b.y as number) - (a.y as number));
            const dt = b.t - a.t;
            if (d > 1 && dt > 1) {
                const lx = Math.log(d), ly = Math.log(dt);
                this.moveN += 1;
                this.moveSx += lx; this.moveSy += ly;
                this.moveSxx += lx * lx; this.moveSxy += lx * ly; this.moveSyy += ly * ly;
            }
        }
    }

    /** The current fit. Classes never seen fall back to the prior, so `logLik` is always finite. */
    fit(): DynamicsFit {
        const one = (a: Gaussian1) => {
            const n = a.n;
            // Shrink toward the prior (1000 ms / 80 ms) so a single sample is not a certainty.
            const priorMu = Math.log(1000);
            const priorVar = 1;
            const v = n > 1 ? var1(a) : 0;
            const postVar = n > 0 ? 1 / (1 / priorVar + n / Math.max(v, SIGMA_FLOOR ** 2)) : priorVar;
            const postMu = n > 0 ? postVar * (priorMu / priorVar + a.n * a.mu / Math.max(v, SIGMA_FLOOR ** 2)) : priorMu;
            return { mu: postMu, sigma: Math.sqrt(Math.max(postVar, SIGMA_FLOOR ** 2)), n };
        };
        const interval = new Map<string, { mu: number; sigma: number; n: number }>();
        const hold = new Map<string, { mu: number; sigma: number; n: number }>();
        for (const [c, a] of this.interval) interval.set(c, one(a));
        for (const [c, a] of this.hold) {
            const n = a.n;
            const v = n > 1 ? var1(a) : 0;
            const priorMu = Math.log(80), priorVar = 1;
            const postVar = n > 0 ? 1 / (1 / priorVar + n / Math.max(v, SIGMA_FLOOR ** 2)) : priorVar;
            const postMu = n > 0 ? postVar * (priorMu / priorVar + n * a.mu / Math.max(v, SIGMA_FLOOR ** 2)) : priorMu;
            hold.set(c, { mu: postMu, sigma: Math.sqrt(Math.max(postVar, SIGMA_FLOOR ** 2)), n });
        }
        const p = var2(this.place);
        let alpha = 4.5, beta = 0.4, sigma = 0.35;   // ~e^4.5 ≈ 90 ms at 1 px, mild distance law
        if (this.moveN > 2) {
            const n = this.moveN;
            const den = n * this.moveSxx - this.moveSx * this.moveSx;
            if (Math.abs(den) > 1e-9) {
                beta = (n * this.moveSxy - this.moveSx * this.moveSy) / den;
                alpha = (this.moveSy - beta * this.moveSx) / n;
                const ss = this.moveSyy - alpha * this.moveSy - beta * this.moveSxy;
                sigma = Math.max(SIGMA_FLOOR, Math.sqrt(Math.max(0, ss) / n));
            }
        }
        return {
            interval,
            hold,
            place: { mux: this.place.mux, muy: this.place.muy, sxx: p.sxx, syy: p.syy, sxy: p.sxy, n: this.place.n },
            move: { alpha, beta, sigma, n: this.moveN },
        };
    }

    /** Mean negative log-likelihood of a trajectory under `fit` — the escalation statistic. Lower is
     *  more like the person. Averaged per event so a long trajectory is not punished for being long. */
    logLik(τ: Trajectory, fit = this.fit()): number {
        const evs = [...τ.events].sort((a, b) => a.t - b.t);
        let acc = 0, terms = 0;
        let prevDown: DynEvent | null = null;
        let openDown: DynEvent | null = null;
        for (const e of evs) {
            if (e.kind === "down") {
                if (prevDown && e.t > prevDown.t) {
                    const c = e.keyClass || "down";
                    const m = fit.interval.get(c) ?? { mu: Math.log(1000), sigma: 1, n: 0 };
                    acc += logNormalLogPdf(e.t - prevDown.t, m.mu, m.sigma);
                    terms += 1;
                }
                prevDown = e;
                openDown = e;
            }
            if (e.kind === "up") {
                if (openDown && e.t > openDown.t && openDown.keyClass) {
                    const m = fit.hold.get(openDown.keyClass) ?? { mu: Math.log(80), sigma: 1, n: 0 };
                    acc += logNormalLogPdf(e.t - openDown.t, m.mu, m.sigma);
                    terms += 1;
                }
                openDown = null;
            }
            if ((e.kind === "click" || e.kind === "up") && e.x != null && e.y != null && τ.tw > 0 && τ.th > 0) {
                acc += placeLogPdf((e.x - τ.tx) / τ.tw, (e.y - τ.ty) / τ.th, fit.place);
                terms += 1;
            }
        }
        return terms ? -acc / terms : 0;
    }
}

/** Log-density of a 2D Gaussian, with a σ floor on both axes so a degenerate fit stays finite. */
function placeLogPdf(x: number, y: number, p: DynamicsFit["place"]): number {
    const sx = Math.sqrt(Math.max(p.sxx, SIGMA_FLOOR ** 2));
    const sy = Math.sqrt(Math.max(p.syy, SIGMA_FLOOR ** 2));
    return gaussLogPdf(x, p.mux, sx) + gaussLogPdf(y, p.muy, sy);
}

/** The class a key falls in, for the interval/hold conditionals. */
export function keyClassOf(key: string): string {
    if (key === " " || key === "Spacebar") return "space";
    if (key === "Shift" || key === "ShiftLeft" || key === "ShiftRight") return "shift";
    if (key === "Enter" || key === "Tab" || key === "Backspace" || key === "Escape") return "named";
    if (/^[0-9]$/.test(key)) return "digit";
    if (/^[a-zA-Z]$/.test(key)) return "letter";
    return "punct";
}
