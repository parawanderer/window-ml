// reshape.mjs — the fixture site's /returns.csv, /targets.csv and /regions.csv beside /sales.csv, and the exact answer of
// the multi-cell reshaping task (tests/e2e/bench/specs/reshape.bench.ts): which region-and-product pair fell furthest
// short of its target after returns, relative to that target, by how much, and who manages its region.
//
// Every figure is in integer cents. A sale's amount is `units x unit price` with the unit price a whole number of cents
// (sales.mjs), and a return refunds `returned_units x unit price`, so every sale's net is a whole number of cents and
// a total is exact however it is summed: a float sum of 3,000 values of at most about 4,000 errs by far less than half
// a cent, so rounding it to cents gives the answer in any order. Targets are whole currency units.

import { rows as salesRows } from "./sales.mjs";

const REGIONS = ["north", "south", "east", "west"];
const PRODUCTS = ["widget", "gadget", "sprocket", "gizmo", "doohickey"];
/** Who manages each region: invented names. */
export const MANAGERS = { north: "Ines Okonjo", south: "Pavel Ruud", east: "Marta Lindqvist", west: "Tomas Achterberg" };
/** The pair planted to miss furthest: its target is 30% above its net, every other pair's at most 15% above it, so it
 *  misses by 23.1% of its target and the next by at most 13.0%: a margin of about ten points. */
const PLANTED = ["north", "sprocket"];
const PLANTED_OVER = 0.30;
/** The other pairs' target over their net, cycled: some beat their target (negative), none misses by more than 15%. */
const OTHER_OVER = [-0.08, 0.05, 0.12, -0.03, 0.15, 0.02, 0.09, -0.05, 0.11, 0.07];

/** Each sale with its unit price in cents (sales.mjs builds amount as units x cents / 100). */
const sales = () => salesRows().map((r) => ({ ...r, unitCents: Math.round((r.amount * 100) / r.units) }));

/** The returns, the same on every call: about one sale in five (611 of 3,000), each returning between one unit and all of them. */
export function returns() {
    let x = 20261119;
    const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
    const out = [];
    for (const s of sales()) if (next() % 10 === 0) out.push({ sale_id: s.id, returned_units: 1 + (next() % s.units) });
    return out;
}

/** Each pair's net in cents: its sales' amounts less what its returns refunded. */
export function netCents() {
    const back = new Map(returns().map((r) => [r.sale_id, r.returned_units]));
    const net = {};
    for (const s of sales()) {
        const k = `${s.region}/${s.product}`;
        net[k] = (net[k] ?? 0) + (s.units - (back.get(s.id) ?? 0)) * s.unitCents;
    }
    return net;
}

/** Each pair's target in whole currency units, for the pairs that have sales: sales.mjs's generator puts every sale in
 *  north or south (its low bits pick the region), so ten pairs, five of them with a handful of sales each. */
export function targets() {
    const net = netCents();
    let i = 0;
    return REGIONS.flatMap((region) => PRODUCTS.filter((product) => net[`${region}/${product}`] != null).map((product) => {
        const over = region === PLANTED[0] && product === PLANTED[1] ? PLANTED_OVER : OTHER_OVER[i++ % OTHER_OVER.length];
        return { region, product, target: Math.round((net[`${region}/${product}`] / 100) * (1 + over)) };
    }));
}

const csv = (cols, rows) => [cols.join(","), ...rows.map((r) => cols.map((c) => r[c]).join(","))].join("\n") + "\n";
/** The CSV bodies served at /returns.csv, /targets.csv and /regions.csv. */
export const returnsCsv = () => csv(["sale_id", "returned_units"], returns());
export const targetsCsv = () => csv(["region", "product", "target"], targets());
export const regionsCsv = () => csv(["region", "manager"], REGIONS.map((region) => ({ region, manager: MANAGERS[region] })));

/**
 * The answer, worked from the tables: every pair's shortfall relative to its target, the top one, and its margin over the
 * second (in percentage points of target). `cents` is target - net, the amount it missed by, in cents.
 */
export function reshapeAnswer() {
    const net = netCents();
    const ranked = targets().map((t) => {
        const missCents = t.target * 100 - net[`${t.region}/${t.product}`];
        return { ...t, missCents, share: missCents / (t.target * 100) };
    }).sort((a, b) => b.share - a.share);
    const [top, second] = ranked;
    return { region: top.region, product: top.product, manager: MANAGERS[top.region], cents: top.missCents,
        amount: (top.missCents / 100).toFixed(2), marginPoints: (top.share - second.share) * 100 };
}
