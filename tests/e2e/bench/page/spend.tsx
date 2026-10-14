// spend.tsx — what a sweep's model calls have cost so far (live-spend.mjs): a badge in the header for the whole sweep,
// and a segment on each driver model's pill for its runs. The figure is the COMPUTED one (tokens at the rates of the
// snapshot each call ran under); what the provider reported is beside it in the tip, never instead of it. A local
// model's cost is the box's electricity (electricity.mjs), its own segment: energy, and its cost when a price was set.

import type { EnergyForecast, EnergyForecastTally, EnergyTally, ForecastTally, SpendForecast, SpendTally, SweepEnergy, SweepSpend } from "./state";
import { fmtMoney } from "./format";
import { IconWarn } from "../../../../src/sidebar/icons";
import { BASIS_WORDS } from "../electricity.mjs";
import { estimateLine } from "../estimate-line.mjs";

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

/**
 * How an estimate reads: "est. ≥ X" when some runs left have no estimate, so the figure leaves them out and the end
 * will be more; "est. X" when every run left is in it.
 */
const estWords = (unknown: number) => (unknown ? "est. ≥ " : "est. ");

/** An estimate's tip under the whole sweep's estimate in one line (`estimateLine`), when the badge has one to lead with. */
const withLead = (lead: string | null | undefined, tip: string) => (lead ? `**${lead[0].toUpperCase()}${lead.slice(1)}.** ${tip}` : tip);

/** The estimate beside a spend figure, while some run left HAS an estimate: one of none would only repeat the spend. */
function Estimate({ f, currency, prices, whose, lead }: { f?: ForecastTally | null; currency: string; prices: string | null; whose: string; lead?: string | null }) {
    if (!f || !f.left || !(f.remaining > 0)) return null;
    return <><Sep /><span class="est tt" data-tip={withLead(lead, forecastTip(f, currency, prices, whose))}><span>{estWords(f.unknown)}<b>{fmtMoney(f.total, currency)}</b></span></span></>;
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

/** A separator between a spend segment's parts. Outside every `.tt`: a tip wrapper is an inline-flex box, which trims
 *  the spaces at the edges of its text (how "spent local" once read "spentlocal"). */
const Sep = ({ plus = false }: { plus?: boolean }) => <span class="sep">{plus ? "+" : "·"}</span>;

/** The box's electricity as a figure: its cost when priced (the energy beside it), else the energy, with the warning
 *  while some runs have no price. */
function Power({ t, whose }: { t: EnergyTally; whose: string }) {
    const tip = energyTip(t, whose);
    return <><span class="tt" data-tip={tip}><span>{t.cost != null ? <><b>{fmtMoney(t.cost, t.currency ?? "")}</b> <span class="wh">{t.Wh.toFixed(2)} Wh</span></> : <b>{t.Wh.toFixed(2)} Wh</b>}</span></span>
        {t.unpriced ? <span class="warn-price tt" data-tip={tip}><IconWarn /></span> : null}</>;
}

/** The electricity estimate beside the figure, while some run left has one. */
function PowerEstimate({ f, ef, whose, lead }: { f?: EnergyForecastTally | null; ef?: EnergyForecast | null; whose: string; lead?: string | null }) {
    if (!f || !f.left || !(f.remainingWh > 0)) return null;
    return <><Sep /><span class="est tt" data-tip={withLead(lead, energyForecastTip(f, ef?.currency ?? null, ef?.perKwh ?? null, whose))}><span>{estWords(f.unknown)}<b>{f.totalWh.toFixed(2)} Wh</b></span></span></>;
}

/**
 * One spend figure: what the calls cost in tokens and what the box's electricity cost, each with its estimate. A tally
 * whose every call was local has no token figure at all, only electricity; one with both shows them joined by "+".
 */
function SpendParts({ t, cur, e, f, fc, ef, efAll, whose, lead = null }: { t?: SpendTally | null; cur: string; e?: EnergyTally | null; f?: ForecastTally | null; fc?: SpendForecast | null; ef?: EnergyForecastTally | null; efAll?: EnergyForecast | null; whose: string; lead?: string | null }) {
    const allLocal = !!t && t.calls > 0 && t.local === t.calls;
    const money = t && !(allLocal && e) ? <span class="tt" data-tip={spendTip(t, cur, whose)}><span>{figure(t, cur)}</span></span> : null;
    const est = fc && !allLocal ? <Estimate f={f} currency={fc.currency} prices={fc.prices} whose={whose} lead={lead} /> : null;
    return <>{money}{est}{e ? <>{money ? <Sep plus /> : null}<Power t={e} whose={whose} /></> : null}<PowerEstimate f={ef} ef={efAll} whose={whose} lead={lead} /></>;
}

/**
 * The whole sweep's spend, in the header's counts, with the estimate for its end while cells are left.
 *
 *  @group bench page
 *  @gallery {"spend": {"currency": "USD", "total": {"calls": 40, "computed": 0.1234, "computedCalls": 18, "reported": 0, "reportedCalls": 0, "local": 22, "unpriced": 0, "pending": 0}, "models": {}, "runs": {}}, "energy": {"total": {"runs": 8, "Wh": 77.5, "aboveWh": 20.1, "cost": 0.0203, "costAbove": 0.0052, "currency": "EUR", "unpriced": 0, "basis": "gpu+cpu"}, "models": {}, "runs": {}}, "energyForecast": {"currency": "EUR", "perKwh": 0.26216, "spentWh": 23.02, "remainingWh": 18.4, "totalWh": 120.4, "left": 2, "unknown": 0, "remainingCost": 0.0048, "basis": {"item": 2, "task": 0, "model": 0, "none": 0}, "models": {}}}
 */
export function SpendBadge({ spend, forecast, energy, energyForecast }: { spend?: SweepSpend | null; forecast?: SpendForecast | null; energy?: SweepEnergy | null; energyForecast?: EnergyForecast | null }) {
    if (!spend && !forecast?.left && !energy && !energyForecast?.left) return null;
    const t = spend?.total;
    const partial = t && (t.unpriced || t.pending) ? " partial" : "";
    // The whole estimate in one line, cloud and local apart, heads the badge's tip: what status.md and the terminal say.
    const whole = estimateLine(forecast?.left ? forecast : null, energyForecast?.left ? energyForecast : null);
    return <span class={`badge spend${partial}`}><span class="rk">spent</span><SpendParts t={t} cur={spend?.currency ?? forecast?.currency ?? ""} e={energy?.total} f={forecast}
        fc={forecast} ef={energyForecast} efAll={energyForecast} whose="this sweep" lead={whole} /></span>;
}

/**
 * One driver model's spend, as a segment of its pill.
 *
 *  @group bench page
 *  @gallery all local {"driver": "glm-4.7-flash:latest", "spend": {"currency": "USD", "total": {"calls": 12, "computed": 0, "computedCalls": 0, "reported": 0, "reportedCalls": 0, "local": 12, "unpriced": 0, "pending": 0}, "models": {"glm-4.7-flash:latest": {"calls": 12, "computed": 0, "computedCalls": 0, "reported": 0, "reportedCalls": 0, "local": 12, "unpriced": 0, "pending": 0}}, "runs": {}}, "energy": {"total": {"runs": 3, "Wh": 23.02, "aboveWh": 20.1, "cost": 0.006, "costAbove": 0.0052, "currency": "EUR", "unpriced": 0, "basis": "gpu+cpu"}, "models": {"glm-4.7-flash:latest": {"runs": 3, "Wh": 23.02, "aboveWh": 20.1, "cost": 0.006, "costAbove": 0.0052, "currency": "EUR", "unpriced": 0, "basis": "gpu+cpu"}}, "runs": {}}, "energyForecast": {"currency": "EUR", "perKwh": 0.26216, "spentWh": 23.02, "remainingWh": 18.4, "totalWh": 41.42, "left": 2, "unknown": 0, "remainingCost": 0.0048, "basis": {"item": 2, "task": 0, "model": 0, "none": 0}, "models": {"glm-4.7-flash:latest": {"currency": "EUR", "perKwh": 0.26216, "spentWh": 23.02, "remainingWh": 18.4, "totalWh": 41.42, "left": 2, "unknown": 0, "remainingCost": 0.0048, "basis": {"item": 2, "task": 0, "model": 0, "none": 0}}}}}
 *  @gallery cloud, with local vision calls {"driver": "openrouter.minimax/minimax-m3", "spend": {"currency": "USD", "total": {"calls": 20, "computed": 0.1234, "computedCalls": 18, "reported": 0, "reportedCalls": 0, "local": 2, "unpriced": 0, "pending": 0}, "models": {"openrouter.minimax/minimax-m3": {"calls": 20, "computed": 0.1234, "computedCalls": 18, "reported": 0, "reportedCalls": 0, "local": 2, "unpriced": 0, "pending": 0}}, "runs": {}}, "energy": {"total": {"runs": 2, "Wh": 1.2, "aboveWh": 1.1, "cost": 0.0003, "costAbove": 0.0003, "currency": "EUR", "unpriced": 0, "basis": "gpu+cpu"}, "models": {"openrouter.minimax/minimax-m3": {"runs": 2, "Wh": 1.2, "aboveWh": 1.1, "cost": 0.0003, "costAbove": 0.0003, "currency": "EUR", "unpriced": 0, "basis": "gpu+cpu"}}, "runs": {}}}
 *  @gallery no electricity price {"driver": "qwen3.5:9b", "spend": {"currency": "USD", "total": {"calls": 8, "computed": 0, "computedCalls": 0, "reported": 0, "reportedCalls": 0, "local": 8, "unpriced": 0, "pending": 0}, "models": {"qwen3.5:9b": {"calls": 8, "computed": 0, "computedCalls": 0, "reported": 0, "reportedCalls": 0, "local": 8, "unpriced": 0, "pending": 0}}, "runs": {}}, "energy": {"total": {"runs": 3, "Wh": 23.02, "aboveWh": 20.1, "cost": null, "costAbove": null, "currency": null, "unpriced": 3, "basis": "gpu+cpu"}, "models": {"qwen3.5:9b": {"runs": 3, "Wh": 23.02, "aboveWh": 20.1, "cost": null, "costAbove": null, "currency": null, "unpriced": 3, "basis": "gpu+cpu"}}, "runs": {}}}
 */
export function SpendRole({ spend, forecast, energy, energyForecast, driver }: { spend?: SweepSpend | null; forecast?: SpendForecast | null; energy?: SweepEnergy | null; energyForecast?: EnergyForecast | null; driver?: string | null }) {
    const t = driver ? spend?.models[driver] : null;
    const f = driver ? forecast?.models[driver] : null;
    const e = driver ? energy?.models[driver] : null;
    const ef = driver ? energyForecast?.models[driver] : null;
    if (!t && !f?.left && !e && !(ef?.left && ef.totalWh > 0)) return null;
    return <span class="role spend"><span class="rk">{t || e ? "spent" : "spend"}</span><SpendParts t={t} cur={spend?.currency ?? ""} e={e} f={f} fc={forecast}
        ef={ef} efAll={energyForecast} whose={`${driver}'s runs in this sweep`} /></span>;
}
