// spend.tsx — what a sweep's model calls have cost so far (live-spend.mjs): a badge in the header for the whole sweep,
// and a segment on each driver model's pill for its runs. The figure is the COMPUTED one (tokens at the rates of the
// snapshot each call ran under); what the provider reported is beside it in the tip, never instead of it.

import type { SpendTally, SweepSpend } from "./state";
import { fmtMoney } from "./format";

/** What one tally covers, said in full: the tip of every spend figure. */
export function spendTip(t: SpendTally, currency: string, whose: string): string {
    const n = (k: number, what: string) => `${k} call${k === 1 ? "" : "s"} ${what}`;
    return [
        `What ${whose} has cost so far, over ${t.calls} model call${t.calls === 1 ? "" : "s"} (the driver's turns and the calls its tools made).`,
        t.computedCalls ? `Computed: ${fmtMoney(t.computed, currency)} over ${n(t.computedCalls, "")}: each call's tokens at the rates of the price snapshot it ran under (uncached prompt, cache reads, cache writes and output apart).` : "Computed: none of the calls could be priced from a snapshot.",
        t.reportedCalls ? `Reported by the provider: ${fmtMoney(t.reported, currency)} over ${n(t.reportedCalls, "")}. Their ratio over the same calls measures the price table's error.` : null,
        t.local ? `${n(t.local, "served by a local model")}: their cost is electricity, not counted here.` : null,
        t.unpriced ? `${n(t.unpriced, "priced by neither")} (a model nothing prices, or no price service set).` : null,
        t.pending ? `${n(t.pending, "waiting")} for their price snapshot to arrive from the price service.` : null,
        "scores.md prices the logged calls the same way once each run ends.",
    ].filter(Boolean).join(" ");
}

/** The figure itself: computed when any call was, else reported, else how many calls are local or unpriced. */
function figure(t: SpendTally, currency: string) {
    if (t.computedCalls) return <b>{fmtMoney(t.computed, currency)}</b>;
    if (t.reportedCalls) return <b>{fmtMoney(t.reported, currency)} <span class="dim">reported</span></b>;
    if (t.pending) return <span class="dim">pricing…</span>;
    return <span class="dim">{t.local === t.calls ? "local" : "unpriced"}</span>;
}

/** The whole sweep's spend, in the header's counts. */
export function SpendBadge({ spend }: { spend?: SweepSpend | null }) {
    if (!spend) return null;
    const t = spend.total;
    const partial = t.unpriced || t.pending ? " partial" : "";
    return <span class={`badge spend tt${partial}`} data-tip={spendTip(t, spend.currency, "this sweep")}>spent {figure(t, spend.currency)}</span>;
}

/** One driver model's spend, as a segment of its pill. */
export function SpendRole({ spend, driver }: { spend?: SweepSpend | null; driver?: string | null }) {
    const t = driver ? spend?.models[driver] : null;
    if (!spend || !t) return null;
    return <span class="role spend tt" data-tip={spendTip(t, spend.currency, `${driver}'s runs in this sweep`)}><span class="rk">spent</span>{figure(t, spend.currency)}</span>;
}
