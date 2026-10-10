// cost.mjs — what a model call cost, worked out when it is READ from the raw rows spend.mjs keeps: the provider's own
// figure when its usage carried one (`reported`), and the call's tokens priced from the price snapshot it ran under
// (`computed`). No price is kept by hand: a model is joined to a price through the box's own model list and the price
// sources, and a model nothing prices says why instead of costing 0.
//
// Pricing one call (the join from a model to its price, and the token classes) is src/spend/price-book.ts, shared with
// the extension's own spend view; this file prices a run's calls and sums them per model.

import { priceBook, callCost } from "../../../src/spend/price-book.ts";

/**
 * Every call priced (`readCalls` rows), each against its own snapshot: `bodyOf(hash)` gives a stored body or null. Books
 * are built once per snapshot set. Returns the calls with `cost` added.
 */
export function priceCalls(calls, bodyOf) {
    const books = new Map();
    return calls.map((c) => {
        const sources = c.usage.prices?.sources;
        let priceOf = null;
        if (sources) {
            const key = JSON.stringify(Object.entries(sources).sort());
            if (!books.has(key)) books.set(key, priceBook(Object.fromEntries(Object.entries(sources).map(([name, h]) => [name, bodyOf(h)]))));
            priceOf = books.get(key);
        }
        return { ...c, cost: callCost(c.usage, c.model, priceOf) };
    });
}

/**
 * Spend per driver model (the `runs` row's model) over priced calls: how many calls, how much the provider reported and
 * over how many calls, how much was computed and over how many, and the calls neither could price with the most common
 * reason. `runModel(run)` maps a call's run to its row's model. Sorted by computed spend, highest first.
 */
export function spendByModel(priced, runModel) {
    const by = new Map();
    for (const c of priced) {
        const model = runModel(c.run);
        if (!model) continue;
        const s = by.get(model) ?? by.set(model, { model, calls: 0, runs: new Set(), reported: 0, reportedCalls: 0, computed: 0, computedCalls: 0, local: 0, unpriced: 0, why: new Map() }).get(model);
        s.calls++; s.runs.add(c.run);
        if (c.cost.reported != null) { s.reported += c.cost.reported; s.reportedCalls++; }
        if (c.cost.computed != null) { s.computed += c.cost.computed; s.computedCalls++; }
        if (c.cost.local) s.local++;
        if (c.cost.reported == null && c.cost.computed == null && !c.cost.local) { s.unpriced++; s.why.set(c.cost.why, (s.why.get(c.cost.why) ?? 0) + 1); }
    }
    return [...by.values()].map((s) => ({ ...s, runs: s.runs.size, why: [...s.why].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }))
        .sort((a, b) => b.computed - a.computed || b.reported - a.reported);
}
