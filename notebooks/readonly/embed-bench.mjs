// embed-bench.mjs — times batched embedding through the OpenWebUI passthrough, for embed-cost.ipynb.
//
//     node notebooks/readonly/embed-bench.mjs > out.json
//
// Prints ONE JSON object { meta, rows } to stdout. Each row is one `/ollama/api/embed` call: the model, how many inputs,
// their characters, the tokens Ollama reports, and the wall time. The inputs are page-sized chunks (2,000 characters) of
// this repo's own specs, which is prose of the kind a PDF page holds. Placement is what the default config sends
// (`num_gpu: 0`, sw-llm.ts `embedTexts`); `keep_alive` is a few minutes rather than the config's -1, so the bench leaves
// nothing pinned on a shared box. Reads OPENWEBUI_URL and OPENWEBUI_KEY from .env and prints neither.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")
    .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const ORIGIN = new URL(env.OPENWEBUI_URL).origin;
const MODELS = (process.env.EMBED_MODELS ?? "embeddinggemma:300m,qwen3-embedding:0.6b").split(",");
const BATCHES = [1, 8, 32, 64];
const REPS = 3;
const CHUNK = 2000;

const specs = fs.readdirSync(path.join(ROOT, "docs/spec")).filter((f) => f.endsWith(".md")).sort();
const text = specs.map((f) => fs.readFileSync(path.join(ROOT, "docs/spec", f), "utf8")).join("\n\n");
const chunks = [];
for (let i = 0; i + CHUNK <= text.length && chunks.length < 64 * REPS; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));

async function embed(model, input) {
    const t = performance.now();
    const res = await fetch(`${ORIGIN}/ollama/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENWEBUI_KEY}` },
        body: JSON.stringify({ model, input, keep_alive: "3m", options: { num_gpu: 0 } }),
    });
    const ms = performance.now() - t;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.embeddings) || j.embeddings.length !== input.length) throw new Error("wrong embedding count");
    return { ms, tokens: j.prompt_eval_count ?? null, dims: j.embeddings[0]?.length ?? null, server_ms: j.total_duration ? j.total_duration / 1e6 : null };
}

const rows = [];
for (const model of MODELS) {
    try { await embed(model, ["warm up"]); } catch (e) { rows.push({ model, note: `warm-up failed: ${e.message}` }); continue; }
    let k = 0;
    for (const n of BATCHES) for (let r = 0; r < REPS; r++) {
        const input = Array.from({ length: n }, () => chunks[k++ % chunks.length]);
        const chars = input.reduce((s, x) => s + x.length, 0);
        try { rows.push({ model, batch: n, rep: r, chars, ...(await embed(model, input)) }); }
        catch (e) { rows.push({ model, batch: n, rep: r, chars, note: e.message }); }
    }
}
const meta = { date: new Date().toISOString(), node: process.version, chunk_chars: CHUNK, reps: REPS, placement: "num_gpu 0", corpus: "docs/spec/*.md" };
process.stdout.write(JSON.stringify({ meta, rows }, null, 1) + "\n");
