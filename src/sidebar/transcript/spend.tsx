// spend.tsx — what a session's model calls cost in money: a chip beside the context gauge, priced on READ by the host
// (`services().priceCalls`) against the price snapshot each call ran under (src/spend/price-book.ts). Nothing here keeps
// a price. A local model is paid in electricity, which the extension does not meter yet: its calls are counted, and when
// spend is on without an electricity price the chip is a warning that opens that setting.

import { signal } from "@preact/signals";
import type { CallCost, CallToPrice } from "../../spend/price-book";
import { PRICE_CURRENCY } from "../../spend/price-book";
import { config, rev } from "../store";
import type { Session } from "../store";
import { shownModel } from "../model";
import { services } from "../services";
import { IconWarn } from "../icons";
import { usageSamples } from "./usage";

/** Every model call a session made, to price: its own calls (each step's or turn's usage, served by the session's
 *  model) and the sub-calls its tools made, which the latest step carrying them lists in full (the list is per session,
 *  so it only grows). */
export function sessionCalls(s: Session): CallToPrice[] {
    const model = shownModel(s);
    const own = usageSamples(s).map((usage) => ({ usage, model }));
    const withSubs = (s.steps || []).filter((st) => st.subUsage?.calls_?.length);
    const subs = withSubs.length ? withSubs[withSubs.length - 1].subUsage!.calls_! : [];
    return [...own, ...subs.map((c) => ({ usage: { promptTokens: c.prompt, completionTokens: c.completion, raw: c.raw, prices: c.prices }, model: c.model }))];
}

/** A session's spend, summed from its priced calls. */
export interface SpendSummary {
    /** money spent, in {@link PRICE_CURRENCY}: each call's provider-reported cost, else the computed one */
    money: number;
    /** calls the provider reported a cost for */
    reported: number;
    /** calls priced from their snapshot (and not reported) */
    computed: number;
    /** calls on a local model, paid in electricity */
    local: number;
    /** calls neither could price */
    unpriced: number;
    /** the most common reason a call went unpriced */
    why: string | null;
}

/** Sum priced calls. A call with neither a reported nor a computed cost is counted as unpriced, never as 0. */
export function summarize(costs: readonly CallCost[]): SpendSummary {
    const out: SpendSummary = { money: 0, reported: 0, computed: 0, local: 0, unpriced: 0, why: null };
    const why = new Map<string, number>();
    for (const c of costs) {
        if (c.reported != null) { out.money += c.reported; out.reported++; }
        else if (c.computed != null) { out.money += c.computed; out.computed++; }
        else if (c.local) out.local++;
        else { out.unpriced++; if (c.why) why.set(c.why, (why.get(c.why) ?? 0) + 1); }
    }
    out.why = [...why].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return out;
}

/** An amount of money, short: two decimals from a cent up, two significant digits below it. */
export function fmtMoney(v: number, currency = PRICE_CURRENCY): string {
    const sym = currency === "USD" ? "$" : `${currency} `;
    if (v === 0) return `${sym}0`;
    return sym + (v >= 0.01 ? v.toFixed(2) : Number(v.toPrecision(2)).toString());
}

// state: cache (each session's priced calls, by session key; repriced when its call count changes)
const priced = new Map<string, { n: number; costs: CallCost[] | null }>();
// state: ui (bumped when an answer lands, so a chip reading it draws again)
const pricedRev = signal(0);

/** The session's priced calls: null when the host cannot price them, undefined while they are being priced. */
function costsFor(s: Session, calls: CallToPrice[]): CallCost[] | null | undefined {
    void pricedRev.value;
    const price = services().priceCalls;
    if (!price) return null;
    const have = priced.get(s.hash);
    if (have && have.n === calls.length) return have.costs;
    priced.set(s.hash, { n: calls.length, costs: have?.costs ?? null });
    const n = calls.length;
    // An answer for an older call count never replaces a newer one.
    void price(calls).then((costs) => { if ((priced.get(s.hash)?.n ?? n) === n) { priced.set(s.hash, { n, costs }); pricedRev.value++; } }, () => {});
    return have?.costs ?? undefined;
}

/** What the session has spent, beside the gauge. Draws nothing where the host cannot price calls, or where there is
 *  nothing to say: no priced call, and no local call missing an electricity price. */
export function SpendChip({ s }: { s: Session }) {
    // The session is mutated in place, so its props never change; reading signals (the priced answer, the config)
    // makes this component skip a re-render with unchanged props, and it froze on the first call. `rev` is bumped
    // on every change to a session, so reading it brings each new call through (store.ts).
    void rev.value;
    const calls = sessionCalls(s);
    if (!calls.length) return null;
    const costs = costsFor(s, calls);
    if (!costs) return null;
    const sum = summarize(costs);
    const c = config.value;
    const spendOn = !!String(c.priceSnapshotUrl || "").trim() || c.electricityPerKwh > 0;
    const noPower = spendOn && sum.local > 0 && !(c.electricityPerKwh > 0);
    const money = sum.reported + sum.computed > 0;
    if (!money && !noPower) return null;
    const find = services().findSetting;
    const lines = [
        money ? `Spent ${fmtMoney(sum.money)} on ${sum.reported + sum.computed} model call${sum.reported + sum.computed === 1 ? "" : "s"}` +
            (sum.reported && sum.computed ? ` (${sum.reported} as the provider reported, ${sum.computed} from the price snapshot each ran under).`
                : sum.reported ? ", as the provider reported." : ", priced from the snapshot each ran under.") : null,
        sum.local ? `${sum.local} call${sum.local === 1 ? "" : "s"} on a local model: paid in electricity, which the extension does not measure yet.` : null,
        sum.unpriced ? `${sum.unpriced} call${sum.unpriced === 1 ? "" : "s"} not priced${sum.why ? `: ${sum.why}` : ""}.` : null,
        noPower ? "No electricity price is set, so a local model's energy cannot be costed." : null,
    ].filter(Boolean);
    const tip = <span class="tt-pop wrap above" role="tooltip">{lines.map((l) => <span class="spend-line">{l}</span>)}</span>;
    return (
        <span class="tt usage-spend">
            {money ? fmtMoney(sum.money) : null}
            {noPower ? (find
                ? <button type="button" class="spend-warn" aria-label="Set an electricity price" onClick={() => find("Electricity price")}><IconWarn /></button>
                : <span class="spend-warn" aria-hidden="true"><IconWarn /></span>) : null}
            {tip}
        </span>
    );
}
