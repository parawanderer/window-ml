// price-calls.mjs — prices the bench store's calls for spend-to-date.ipynb with the bench's own pricer (cost.mjs over
// src/spend/price-book.ts), so the notebook never re-implements a price join.
//
//     npx tsx notebooks/bench/price-calls.mjs <in.json> <out.json>
//
// <in.json> is { calls: [{ run, call, kind, model, usage }], drivers: { run: model }, snapshots: { hash: base64 body } }, as
// the notebook reads them from the store's `calls`, `scores` and `price_snapshots` views. The store keeps each body
// base64 (a checkout's scores.sqlite keeps the raw bytes), so it is decoded here: priced as text, every call came out
// "the snapshot has no model list". <out.json> gets one row per call:
// { run, call, model, computed, reported, local, why }.

import { readFileSync, writeFileSync } from "node:fs";
import { priceCalls } from "../../tests/e2e/bench/cost.mjs";

const [inPath, outPath] = process.argv.slice(2);
const { calls, drivers, snapshots } = JSON.parse(readFileSync(inPath, "utf8"));
// A turn logged without its model (before callsOf named the driver) was the driver's, as spendReport reads it.
const rows = calls.map((c) => ({ ...c, usage: typeof c.usage === "string" ? JSON.parse(c.usage) : c.usage,
    model: c.model ?? (c.kind === "turn" ? drivers[c.run] ?? null : null) }));
const bodies = new Map(Object.entries(snapshots).map(([h, b64]) => [h, new Uint8Array(Buffer.from(b64, "base64"))]));
const priced = priceCalls(rows, (h) => bodies.get(h) ?? null);
writeFileSync(outPath, JSON.stringify(priced.map((c) => ({ run: c.run, call: c.call, model: c.model, computed: c.cost.computed ?? null,
    reported: c.cost.reported ?? null, local: !!c.cost.local, why: c.cost.why ?? null }))));
