// live-spend.mjs — what a sweep has spent so far, priced as its runs' events arrive: each model call's usage is read off
// the run's live debug stream (a turn's `usage` on its agent-step, a tool's delegated calls in `subUsage.calls_`) and
// priced the way scores.md prices it on read (cost.mjs), against the price snapshot the call names. A snapshot body
// this process does not have yet is fetched from the price service once (`/raw/<sha256>`), checked against its hash,
// and kept in the scores log; until it arrives its calls count as pending, never as 0.
//
// It is a running view, not the record: the record is the `calls` table, written when a run ends (spend.mjs). A sweep's
// figure here and scores.md's can differ for a run that died before it was logged.

import { createHash } from "node:crypto";
import { priceBook, callCost, PRICE_CURRENCY } from "../../../src/spend/price-book.ts";
import { subcallUsage } from "./spend.mjs";

/** An empty tally: calls, what was computed and reported over how many, local ones, unpriced ones, and those waiting on a snapshot. */
const tally = () => ({ calls: 0, computed: 0, computedCalls: 0, reported: 0, reportedCalls: 0, local: 0, unpriced: 0, pending: 0 });

/** Add one priced call (`cost` from callCost, or null while its snapshot is fetched) to a tally. */
function count(t, cost) {
    t.calls++;
    if (!cost) { t.pending++; return; }
    if (cost.reported != null) { t.reported += cost.reported; t.reportedCalls++; }
    if (cost.computed != null) { t.computed += cost.computed; t.computedCalls++; }
    if (cost.local) t.local++;
    if (cost.reported == null && cost.computed == null && !cost.local) t.unpriced++;
}

/**
 * The model calls one live debug event carries: `{ key, model, usage }`, keyed so an event seen twice counts once. A
 * turn is the driver's (`driver`, since the stream does not name it); a delegated call names its own model.
 */
export function eventCalls(ev, driver) {
    if (ev?.kind !== "agent-step") return [];
    const out = [];
    if (ev.usage && !ev.pending) out.push({ key: `t:${ev.step}:${ev.seq ?? ""}`, model: driver ?? null, usage: ev.usage });
    (ev.subUsage?.calls_ ?? []).forEach((c, i) => out.push({ key: `s:${ev.step}:${ev.seq ?? ""}:${c.ts ?? ""}:${i}`, model: c.model ?? null, usage: subcallUsage(c) }));
    return out;
}

/**
 * A sweep's live spend. `bodyOf(hash)` gives a snapshot body this process already has (the scores log) or null;
 * `fetchBody(hash)` fetches one (resolving to bytes, or null), and `keep({ hash, kind, body })` stores a checked one;
 * `changed()` is called when a fetched body re-prices calls. `add(index, ev, driver)` takes a run's event and says whether
 * it carried a call; `summary(modelOf)` is the page's view: the total, and one tally per driver model (`modelOf(index)`),
 * with each run's own under `runs`.
 */
export function liveSpend({ bodyOf = () => null, fetchBody = null, keep = () => {}, changed = () => {} } = {}) {
    const calls = [];
    const seen = new Set();
    const bodies = new Map();      // hash → bytes, or null once nothing can bring it
    const inflight = new Set();
    const books = new Map();
    /** A snapshot body: bytes, null when it cannot be had, undefined while a fetch may still bring it. */
    const body = (hash) => {
        if (bodies.has(hash)) return bodies.get(hash);
        const b = bodyOf(hash);
        if (b != null) { bodies.set(hash, b); return b; }
        if (!fetchBody) { bodies.set(hash, null); return null; }
        if (!inflight.has(hash)) {
            inflight.add(hash);
            Promise.resolve().then(() => fetchBody(hash)).catch(() => null).then((bytes) => {
                const buf = bytes ? Buffer.from(bytes) : null;
                const ok = buf && createHash("sha256").update(buf).digest("hex") === hash;
                bodies.set(hash, ok ? buf : null);
                inflight.delete(hash);
                if (ok) {
                    const kind = calls.map((c) => Object.entries(c.usage.prices?.sources ?? {}).find(([, h]) => h === hash)?.[0]).find(Boolean) ?? "unknown";
                    try { keep({ hash, kind, body: buf }); } catch { /* the live view does not depend on the log */ }
                }
                changed();
            });
        }
        return undefined;
    };
    /** A call's price: its cost, or null while a snapshot it names is still coming. A source that cannot be had is
     *  priced without, as scores.md does. */
    const price = (c) => {
        const sources = c.usage.prices?.sources;
        if (!sources) return callCost(c.usage, c.model, null);
        const entries = Object.entries(sources).sort();
        const got = entries.map(([name, h]) => [name, body(h)]);
        if (got.some(([, b]) => b === undefined)) return null;
        const key = JSON.stringify(entries);
        if (!books.has(key)) books.set(key, priceBook(Object.fromEntries(got)));
        return callCost(c.usage, c.model, books.get(key));
    };
    return {
        add(index, ev, driver) {
            let n = 0;
            for (const c of eventCalls(ev, driver)) {
                const k = `${index}|${c.key}`;
                if (seen.has(k)) continue;
                seen.add(k);
                calls.push({ index, ...c });
                n++;
            }
            return n > 0;
        },
        summary(modelOf = () => null) {
            const total = tally(), models = new Map(), runs = new Map();
            for (const c of calls) {
                const cost = price(c);
                count(total, cost);
                const m = modelOf(c.index) ?? c.model ?? "?";
                count(models.get(m) ?? models.set(m, tally()).get(m), cost);
                count(runs.get(c.index) ?? runs.set(c.index, tally()).get(c.index), cost);
            }
            return calls.length ? { currency: PRICE_CURRENCY, total, models: Object.fromEntries(models), runs: Object.fromEntries(runs) } : null;
        },
    };
}

/** Fetch a snapshot body from the price service by its hash; null when it is unreachable or does not have it. */
export const fetchFromPriceService = (url) => async (hash) => {
    const res = await fetch(`${String(url).replace(/\/+$/, "")}/raw/${hash}`, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
};

/** A sweep's spend as one line for the terminal: what was computed and reported, over how many calls, and what neither priced. */
export function spendLine(spend) {
    const t = spend.total;
    const money = (x, n) => `${x.toFixed(4)} ${spend.currency} over ${n} call${n === 1 ? "" : "s"}`;
    return [`${t.calls} model call${t.calls === 1 ? "" : "s"}`,
        t.computedCalls ? `computed ${money(t.computed, t.computedCalls)}` : null,
        t.reportedCalls ? `reported by the provider ${money(t.reported, t.reportedCalls)}` : null,
        t.local ? `${t.local} local (electricity, not priced here)` : null,
        t.unpriced ? `${t.unpriced} unpriced` : null,
        t.pending ? `${t.pending} waiting on a price snapshot` : null].filter(Boolean).join("; ");
}
