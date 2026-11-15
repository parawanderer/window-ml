// frame-runs.mjs — reading a per-frame series of heights as runs of change, for the specs that sample the calm chat.

/**
 * Change runs in a series of heights: each maximal stretch of frames in which the height keeps changing, with how much it
 * changed, how long it took and its biggest single-frame step. A one-frame change is a run of duration 0.
 */
export function runsOf(series, minDelta = 1) {
    const runs = [];
    let cur = null;
    for (let i = 1; i < series.length; i++) {
        const d = series[i].v - series[i - 1].v;
        if (Math.abs(d) >= minDelta) {
            // A new run when the gap is long OR the direction turns: a rise and a fall are two changes, not one of their difference.
            if (!cur || series[i].t - cur.lastT > 60 || Math.sign(d) !== cur.dir) { cur = { from: series[i - 1].v, to: series[i].v, startT: series[i - 1].t, lastT: series[i].t, maxStep: Math.abs(d), dir: Math.sign(d) }; runs.push(cur); }
            else { cur.to = series[i].v; cur.lastT = series[i].t; cur.maxStep = Math.max(cur.maxStep, Math.abs(d)); }
        }
    }
    return runs.map((r) => ({ ...r, total: Math.abs(r.to - r.from), duration: r.lastT - r.startT }));
}
