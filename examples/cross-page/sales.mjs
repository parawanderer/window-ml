// sales.mjs — a deterministic 3,000-row CSV for the fixture site's /sales.csv, and its exact column total.

const REGIONS = ["north", "south", "east", "west"];
const PRODUCTS = ["widget", "gadget", "sprocket", "gizmo", "doohickey"];

/** The rows, the same on every call: a small LCG instead of Math.random, so the total is known in advance. */
function rows(n = 3000) {
    let x = 20261009;
    const next = () => (x = (x * 1103515245 + 12345) % 2147483648);
    return Array.from({ length: n }, (_, i) => {
        const units = 1 + (next() % 40), cents = 99 + (next() % 9900);
        return { id: i + 1, region: REGIONS[next() % 4], product: PRODUCTS[next() % 5], units, amount: (units * cents) / 100 };
    });
}

/** The CSV body served at /sales.csv. */
export function salesCsv() {
    return ["id,region,product,units,amount", ...rows().map((r) => `${r.id},${r.region},${r.product},${r.units},${r.amount.toFixed(2)}`)].join("\n") + "\n";
}

/** The exact total of the `amount` column, summed in cents so no float rounding creeps in. */
export const SALES_TOTAL = (rows().reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100).toFixed(2);
