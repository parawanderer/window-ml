// The reshaping bench's fixture (examples/cross-page/reshape.mjs) and its checker (tests/e2e/bench/specs/reshape.bench.ts):
// the answer has one top pair well clear of the next, worked again from the four CSVs the site serves it comes out the
// same to the cent in any summation order, and the checker accepts it and refuses a near miss.
import { test } from "node:test";
import assert from "node:assert/strict";
import { salesCsv } from "../examples/cross-page/sales.mjs";
import { returnsCsv, targetsCsv, regionsCsv, reshapeAnswer, MANAGERS } from "../examples/cross-page/reshape.mjs";
import { reshapeRight, WORDINGS, HINT, ARMS } from "./e2e/bench/specs/reshape.bench.ts";

/** A served CSV as objects, numbers parsed the way a dataframe reader would (floats). */
const parse = (body) => {
    const [head, ...lines] = body.trim().split("\n");
    const cols = head.split(",");
    return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
};

/** A deterministic shuffle, so the summation order differs from the generator's. */
const shuffled = (xs, seed) => {
    const out = [...xs];
    let x = seed;
    for (let i = out.length - 1; i > 0; i--) {
        x = (x * 1103515245 + 12345) % 2147483648;
        const j = x % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

/** The answer worked from the served tables in floats, as a model's cells would: net per sale after returns (refund
 *  at the sale's own unit price), totals per pair, shortfall relative to target, the top pair and its manager. */
const fromCsvs = (seed) => {
    const back = new Map(parse(returnsCsv()).map((r) => [r.sale_id, r.returned_units]));
    const net = {};
    for (const s of shuffled(parse(salesCsv()), seed)) {
        const k = `${s.region}/${s.product}`;
        net[k] = (net[k] ?? 0) + s.amount - (back.get(s.id) ?? 0) * (s.amount / s.units);
    }
    const managers = Object.fromEntries(parse(regionsCsv()).map((r) => [r.region, r.manager]));
    const [top] = parse(targetsCsv()).map((t) => ({ ...t, miss: t.target - net[`${t.region}/${t.product}`] }))
        .sort((a, b) => b.miss / b.target - a.miss / a.target);
    return { region: top.region, product: top.product, manager: managers[top.region], amount: top.miss.toFixed(2) };
};

// --- the answer ---

test("reshapeAnswer: north/sprocket, about ten points of target clear of the next pair", () => {
    const a = reshapeAnswer();
    assert.deepEqual([a.region, a.product, a.manager], ["north", "sprocket", MANAGERS.north]);
    assert.ok(a.marginPoints >= 9, `margin ${a.marginPoints} points`);
    assert.ok(Number.isInteger(a.cents) && a.cents > 0);
    assert.equal(a.amount, (a.cents / 100).toFixed(2));
});

test("every target is a pair that has sales, and each pair appears once", () => {
    const pairs = parse(targetsCsv()).map((t) => `${t.region}/${t.product}`);
    const sold = new Set(parse(salesCsv()).map((s) => `${s.region}/${s.product}`));
    assert.equal(new Set(pairs).size, pairs.length);
    assert.deepEqual(new Set(pairs), sold);
});

test("every return names a real sale and returns between one unit and all of them", () => {
    const sales = new Map(parse(salesCsv()).map((s) => [s.id, s]));
    const rs = parse(returnsCsv());
    assert.ok(rs.length > 100);
    assert.equal(new Set(rs.map((r) => r.sale_id)).size, rs.length, "at most one return per sale");
    for (const r of rs) assert.ok(r.returned_units >= 1 && r.returned_units <= sales.get(r.sale_id).units, JSON.stringify(r));
});

test("the answer worked from the served CSVs in floats is the same to the cent in any summation order", () => {
    const want = reshapeAnswer();
    for (const seed of [1, 2, 3, 20261119, 99991]) {
        assert.deepEqual(fromCsvs(seed), { region: want.region, product: want.product, manager: want.manager, amount: want.amount }, `seed ${seed}`);
    }
});

// --- the checker ---

test("reshapeRight: the amount with any grouping or currency mark and the manager in any case", () => {
    const { amount, manager } = reshapeAnswer();
    const grouped = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 });
    assert.ok(reshapeRight(`${manager}'s north sprocket missed by ${amount}.`));
    assert.ok(reshapeRight(`It missed by $${grouped}; the manager is ${manager.toUpperCase()}.`));
    assert.ok(reshapeRight(`EUR ${grouped} short, managed by ${manager}`));
});

test("reshapeRight: refuses a cent off, a rounded amount, an extra digit either side, another manager, or either half alone", () => {
    const { cents, amount, manager } = reshapeAnswer();
    assert.ok(!reshapeRight(`${manager} missed by ${((cents + 1) / 100).toFixed(2)}`), "a cent over");
    assert.ok(!reshapeRight(`${manager} missed by ${((cents - 1) / 100).toFixed(2)}`), "a cent under");
    assert.ok(!reshapeRight(`${manager} missed by ${Math.round(cents / 100)}`), "rounded to whole units");
    const grouped = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 });
    assert.ok(!reshapeRight(`${manager} missed by 1,${grouped}`), "a leading extra digit");
    assert.ok(!reshapeRight(`${manager} missed by 1${amount}`), "a leading extra digit, ungrouped");
    assert.ok(!reshapeRight(`${manager} missed by ${amount}1`), "a trailing extra digit");
    assert.ok(!reshapeRight(`${MANAGERS.south} missed by ${amount}`), "the other region's manager");
    assert.ok(!reshapeRight(`missed by ${amount}`) && !reshapeRight(manager));
});

test("the two wordings name all four tables", () => {
    for (const [name, text] of Object.entries(WORDINGS)) {
        for (const t of ["/sales.csv", "/returns.csv", "/targets.csv", "/regions.csv"]) assert.ok(text.includes(t), `${name}: ${t}`);
    }
});

test("the arms: each wording with the same hint appended, and neutral without it", () => {
    assert.deepEqual(Object.keys(ARMS).sort(), ["neutral", "neutral-hint", "staged-hint"]);
    assert.equal(ARMS["neutral-hint"], `${WORDINGS.neutral} ${HINT}`);
    assert.equal(ARMS["staged-hint"], `${WORDINGS.staged} ${HINT}`);
    assert.equal(ARMS.neutral, WORDINGS.neutral);
    assert.ok(!ARMS.neutral.includes("tables"));
});
