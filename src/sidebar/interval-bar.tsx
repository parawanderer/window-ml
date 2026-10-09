// interval-bar.tsx — an estimate with its uncertainty, drawn: a dot on its interval on a fixed axis, so a column of them
// compares at a glance. The bench's scoreboard draws its model scores and task difficulties with it.

/** A signed number, as a scale centred on zero reads: +0.83, −1.20. */
export const signed = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;

/** Where `x` sits on an axis from −span to +span, as a CSS percentage; clamped at the ends. */
const at = (x: number, span: number) => `${(Math.max(-span, Math.min(span, x)) + span) / (2 * span) * 100}%`;

/**
 * An estimate `v` with its interval [lo, hi], as a dot on a bar on an axis from −span to +span with zero marked, then
 * the number. Every row given the same `span` shares one axis. `tip` says in words what the numbers are (the tooltip
 * layer's `data-tip`, plain text).
 */
export function Interval({ lo, hi, v, tip, span = 4 }: { lo: number; hi: number; v: number; tip: string; span?: number }) {
    return (
        <span class="ival tt" data-tip={tip}>
            <span class="iaxis"><i class="izero" /><i class="ispan" style={{ left: at(lo, span), width: `calc(${at(hi, span)} - ${at(lo, span)})` }} /><i class="idot" style={{ left: at(v, span) }} /></span>
            <b>{signed(v)}</b>
        </span>
    );
}
