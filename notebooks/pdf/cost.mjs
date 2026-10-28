// cost.mjs — what labelling the PDF pages cost, per model, for the threshold notebook: a cloud model's calls priced by
// the bench's own pricer (cost.mjs over src/spend/price-book.ts) at the snapshot each call ran under, and a local
// model's electricity read from the box log by the bench's own reader (electricity.mjs), never re-implemented here.
//
//   node --import tsx notebooks/pdf/cost.mjs      → data/cost.json
//
// Reads every `data/labels-*.jsonl`, the snapshot bodies from the price service (PRICE_SNAPSHOT_URL in .env, `/raw/<hash>`)
// and `<cache>/box.sqlite`, which label-pages.mjs recorded while it ran.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { priceCalls } from "../../tests/e2e/bench/cost.mjs";
import { runEnergy } from "../../tests/e2e/bench/electricity.mjs";
import { openBoxLog } from "../../tests/e2e/bench/box-stream.mjs";
import { resolveBackendFromEnv } from "../../tests/e2e/run-once.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "..", "..", "tests", "e2e", "artifacts", "pdf-corpus");
const DATA = join(HERE, "data");

/**
 * Fetch each snapshot body the calls name, by its hash, from the price service.
 * @param {string|undefined} base the service's URL
 * @param {Set<string>} hashes
 * @returns {Promise<Map<string, Uint8Array>>}
 */
async function bodies(base, hashes) {
    const out = new Map();
    if (!base) return out;
    for (const h of hashes) {
        const res = await fetch(`${base.replace(/\/$/, "")}/raw/${h}`);
        if (res.ok) out.set(h, new Uint8Array(await res.arrayBuffer()));
    }
    return out;
}

const backend = await resolveBackendFromEnv({ ...process.env, USE_ENV: "1" });
const files = readdirSync(DATA).filter((f) => /^labels-.*\.jsonl$/.test(f));
const rows = files.flatMap((f) => readFileSync(join(DATA, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.usage);
const hashes = new Set(rows.flatMap((r) => Object.values(r.usage.prices?.sources ?? {})));
const got = await bodies(backend?.priceSnapshotUrl, hashes);
const priced = priceCalls(rows.map((r) => ({ ...r, run: r.session, call: `${r.id}#${r.n}` })), (h) => got.get(h) ?? null);

const db = await openBoxLog(join(CACHE, "box.sqlite"));
const out = {};
for (const model of new Set(priced.map((c) => c.model))) {
    const calls = priced.filter((c) => c.model === model);
    const sum = (f) => calls.reduce((a, c) => a + (f(c) ?? 0), 0);
    const m = {
        calls: calls.length,
        promptTokens: sum((c) => c.usage.promptTokens), completionTokens: sum((c) => c.usage.completionTokens),
        genMs: sum((c) => c.usage.genMs), wallMs: sum((c) => c.ms),
        local: calls.some((c) => c.cost.local),
        usd: { computed: sum((c) => c.cost.computed), reported: sum((c) => c.cost.reported), priced: calls.filter((c) => c.cost.computed != null).length,
            why: [...new Set(calls.map((c) => c.cost.why).filter(Boolean))] },
    };
    if (m.local && db) {
        // One session per labelling run: the box names each of its generations `wml-<run>`.
        const runs = [...new Set(calls.map((c) => c.session))].map((s) => ({ run: s.replace(/^wml-/, ""), price: calls.find((c) => c.session === s).usage.electricity ?? null }));
        const e = [...runEnergy(db, runs).values()];
        m.energy = e.length ? {
            Wh: e.reduce((a, x) => a + x.Wh, 0), aboveWh: e.reduce((a, x) => a + x.aboveWh, 0), cost: e.reduce((a, x) => a + (x.cost ?? 0), 0),
            costAbove: e.reduce((a, x) => a + (x.costAbove ?? 0), 0), currency: e[0].currency ?? null, basis: [...new Set(e.map((x) => x.basis))], restW: e.map((x) => x.restW),
        } : null;
    }
    out[model] = m;
}
writeFileSync(join(DATA, "cost.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
