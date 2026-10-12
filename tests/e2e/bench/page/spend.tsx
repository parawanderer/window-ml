// spend.tsx — what a sweep's model calls have cost so far (live-spend.mjs): a badge in the header for the whole sweep,
// and a segment on each driver model's pill for its runs. The figure is the COMPUTED one (tokens at the rates of the
// snapshot each call ran under); what the provider reported is beside it in the tip, never instead of it. A local
// model's cost is the box's electricity (electricity.mjs), its own segment: energy, and its cost when a price was set.

import type { EnergyForecast, EnergyForecastTally, EnergyTally, ForecastTally, SpendForecast, SpendTally, SweepEnergy, SweepSpend } from "./state";
import { fmtMoney } from "./format";
import { IconWarn } from "../../../../src/sidebar/icons";
import { BASIS_WORDS } from "../electricity.mjs";

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

/** What an energy tally covers, said in full: the tip of every electricity figure. */
export function energyTip(t: EnergyTally, whose: string): string {
    const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
    return [
        `What the box drew for ${whose} so far: ${t.Wh.toFixed(2)} Wh over ${runs(t.runs)} it generated for, everything while it generated for them plus its draw above rest in the 30 s after each generation.`,
        t.aboveWh != null ? `${t.aboveWh.toFixed(2)} Wh of it above what the box draws at rest, which is paid either way.` : "No rest reading yet, so nothing is said above rest.",
        `Measured as: ${t.basis.split(" / ").map((b) => BASIS_WORDS[b] ?? b).join("; ")}.`,
        t.cost != null ? `At the electricity price the runs' calls recorded, each moment at its own rate: ${fmtMoney(t.cost, t.currency ?? "")}${t.costAbove != null ? ` (${fmtMoney(t.costAbove, t.currency ?? "")} above rest)` : ""}.` : null,
        t.unpriced ? `${runs(t.unpriced)} had no electricity price, so their energy is shown but not costed. Set the average price per kWh in DevTools Settings > Spend.` : null,
    ].filter(Boolean).join(" ");
}

/** What an electricity forecast says, in full. */
export function energyForecastTip(f: EnergyForecastTally, currency: string | null, perKwh: number | null, whose: string): string {
    const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
    const from = [f.basis.item ? `${f.basis.item} from past runs of the same task` : null, f.basis.task ? `${f.basis.task} from the task under another wording` : null,
        f.basis.model ? `${f.basis.model} from the model's runs of other tasks` : null, f.basis.none ? `${f.basis.none} on a model whose runs never drew on the box` : null].filter(Boolean).join(", ");
    return [
        `About ${f.totalWh.toFixed(2)} Wh for ${whose} by its end: ${f.spentWh.toFixed(2)} Wh measured so far, and about ${f.remainingWh.toFixed(2)} Wh for the ${runs(f.left)} left${f.remainingCost != null && currency ? `, about ${fmtMoney(f.remainingCost, currency)} at ${perKwh} ${currency}/kWh` : ""}.`,
        from ? `Each estimated run is the mean energy of its model's most recent past runs (${from}).` : null,
        f.unknown ? `${runs(f.unknown)} on a local model with no energy on record, not in the figure.` : null,
    ].filter(Boolean).join(" ");
}

/** The electricity segment: energy, its cost when priced, a warning while some runs have no price, and the estimate. */
function Power({ t, f, ef, whose }: { t?: EnergyTally | null; f?: EnergyForecastTally | null; ef?: EnergyForecast | null; whose: string }) {
    const est = f && f.left && f.totalWh > 0
        ? <span class="tt" data-tip={energyForecastTip(f, ef?.currency ?? null, ef?.perKwh ?? null, whose)}> · est. <b>{f.totalWh.toFixed(2)} Wh</b>{f.unknown ? "+" : ""}</span> : null;
    if (!t) return est ? <span class="power"> · power{est}</span> : null;
    return <span class="power"><span class="tt" data-tip={energyTip(t, whose)}> · power <b>{t.Wh.toFixed(2)} Wh</b>{t.cost != null ? <> {fmtMoney(t.cost, t.currency ?? "")}</> : null}</span>{t.unpriced ? <span class="warn-price tt" data-tip={energyTip(t, whose)}><IconWarn /></span> : null}{est}</span>;
}

/** The whole sweep's spend, in the header's counts, with the estimate for its end while cells are left. */
export function SpendBadge({ spend, forecast, energy, energyForecast }: { spend?: SweepSpend | null; forecast?: SpendForecast | null; energy?: SweepEnergy | null; energyForecast?: EnergyForecast | null }) {
    if (!spend && !forecast?.left && !energy && !energyForecast?.left) return null;
    const cur = spend?.currency ?? forecast?.currency ?? "";
    const est = <Estimate f={forecast} currency={cur} prices={forecast?.prices ?? null} whose="this sweep" />;
    const power = <Power t={energy?.total} f={energyForecast} ef={energyForecast} whose="this sweep" />;
    if (!spend) return <span class="badge spend">{est}{power}</span>;
    const t = spend.total;
    const partial = t.unpriced || t.pending ? " partial" : "";
    return <span class={`badge spend${partial}`}><span class="tt" data-tip={spendTip(t, spend.currency, "this sweep")}>spent {figure(t, spend.currency)}</span>{est}{power}</span>;
}

/** One driver model's spend, as a segment of its pill. */
export function SpendRole({ spend, forecast, energy, energyForecast, driver }: { spend?: SweepSpend | null; forecast?: SpendForecast | null; energy?: SweepEnergy | null; energyForecast?: EnergyForecast | null; driver?: string | null }) {
    const t = driver ? spend?.models[driver] : null;
    const f = driver ? forecast?.models[driver] : null;
    const e = driver ? energy?.models[driver] : null;
    const ef = driver ? energyForecast?.models[driver] : null;
    if (!t && !f?.left && !e && !(ef?.left && ef.totalWh > 0)) return null;
    const whose = `${driver}'s runs in this sweep`;
    const est = forecast && <Estimate f={f} currency={forecast.currency} prices={forecast.prices} whose={whose} />;
    const power = <Power t={e} f={ef} ef={energyForecast} whose={whose} />;
    if (!t) return <span class="role spend"><span class="rk">spend</span>{est}{power}</span>;
    return <span class="role spend"><span class="tt" data-tip={spendTip(t, spend!.currency, whose)}><span class="rk">spent</span>{figure(t, spend!.currency)}</span>{est}{power}</span>;
}
