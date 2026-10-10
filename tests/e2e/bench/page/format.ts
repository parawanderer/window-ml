// format.ts — how the bench's pages write durations and times.

/** A duration as a lane tick or a bar's title reads it: `850ms`, `12.4s`, `3m05s`. */
export function fmtSpan(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Whole seconds as `42s` / `3m05s`, for the clocks a sweep shows (elapsed, per run, ETA); `–` when unknown. */
export function dur(ms: number | null | undefined): string {
    if (ms == null || !(ms >= 0)) return "–";
    const t = Math.round(ms / 1000);
    return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
}

/** An amount of money as the spend views write it: four decimals under one unit (a call costs fractions of a cent), two above. */
export function fmtMoney(x: number, currency: string): string {
    return `${x.toFixed(Math.abs(x) < 1 ? 4 : 2)} ${currency}`;
}
