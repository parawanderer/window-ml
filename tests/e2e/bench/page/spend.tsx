// spend.tsx — what a sweep's model calls have cost so far (live-spend.mjs): a badge in the header for the whole sweep,
// and a segment on each driver model's pill for its runs. The figure is the COMPUTED one (tokens at the rates of the
// snapshot each call ran under); what the provider reported is beside it in the tip, never instead of it.

import type { ForecastTally, SpendForecast, SpendTally, SweepSpend } from "./state";
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

/** What a forecast says, in full: the tip of every estimate. */
export function forecastTip(f: ForecastTally, currency: string, prices: string | null, whose: string): string {
    const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
    const from = [f.basis.item ? `${f.basis.item} from past runs of the same task` : null, f.basis.task ? `${f.basis.task} from the task under another wording` : null,
        f.basis.model ? `${f.basis.model} from the model's runs of other tasks` : null].filter(Boolean).join(", ");
    return [
        `About ${fmtMoney(f.total, currency)} for ${whose} by its end: ${fmtMoney(f.spent, currency)} computed so far, and about ${fmtMoney(f.remaining, currency)} for the ${runs(f.left)} left.`,
        from ? `Each estimated run is the mean of its model's most recent past runs (${from}), their calls re-priced at the rates of ${prices ? `the snapshot of ${prices.replace("T", " ").slice(0, 16)} UTC` : "the newest snapshot"}.` : null,
        f.local ? `${runs(f.local)} on a local model: electricity, not priced here.` : null,
        f.unknown ? `${runs(f.unknown)} with no estimate (${f.why}), not in the figure.` : null,
        "An estimate: a changed prompt, retries and long-context surprises are not in it.",
    ].filter(Boolean).join(" ");
}

/** The estimate beside a spend figure, while there is something left to estimate. */
function Estimate({ f, currency, prices, whose }: { f?: ForecastTally | null; currency: string; prices: string | null; whose: string }) {
    if (!f || !f.left || f.remaining + f.spent === 0 && f.local + f.unknown === f.left) return null;
    return <span class="est tt" data-tip={forecastTip(f, currency, prices, whose)}> · est. <b>{fmtMoney(f.total, currency)}</b>{f.unknown ? "+" : ""}</span>;
}

/** The whole sweep's spend, in the header's counts, with the estimate for its end while cells are left. */
export function SpendBadge({ spend, forecast }: { spend?: SweepSpend | null; forecast?: SpendForecast | null }) {
    if (!spend && !forecast?.left) return null;
    const cur = spend?.currency ?? forecast!.currency;
    const est = <Estimate f={forecast} currency={cur} prices={forecast?.prices ?? null} whose="this sweep" />;
    if (!spend) return <span class="badge spend">{est}</span>;
    const t = spend.total;
    const partial = t.unpriced || t.pending ? " partial" : "";
    return <span class={`badge spend${partial}`}><span class="tt" data-tip={spendTip(t, spend.currency, "this sweep")}>spent {figure(t, spend.currency)}</span>{est}</span>;
}

/** One driver model's spend, as a segment of its pill. */
export function SpendRole({ spend, forecast, driver }: { spend?: SweepSpend | null; forecast?: SpendForecast | null; driver?: string | null }) {
    const t = driver ? spend?.models[driver] : null;
    const f = driver ? forecast?.models[driver] : null;
    if (!t && !f?.left) return null;
    const whose = `${driver}'s runs in this sweep`;
    const est = forecast && <Estimate f={f} currency={forecast.currency} prices={forecast.prices} whose={whose} />;
    if (!t) return <span class="role spend"><span class="rk">spend</span>{est}</span>;
    return <span class="role spend"><span class="tt" data-tip={spendTip(t, spend!.currency, whose)}><span class="rk">spent</span>{figure(t, spend!.currency)}</span>{est}</span>;
}
