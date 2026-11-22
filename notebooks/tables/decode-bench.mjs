// decode-bench.mjs — measures the worker's decode of a 64 MB stored CSV into Arrow columns, for decode-cache.ipynb.
//
//     node --import tsx notebooks/tables/decode-bench.mjs > out.json
//
// Prints ONE JSON object { meta, rows } to stdout. Each row is one table shape (mixed, numeric, text), decoded in its own
// child process so that process's peak RSS belongs to that decode alone: the CSV is generated (seeded, so every run reads
// the same bytes), the heap is collected, and then `cachedStoredColumns` (src/table/table-decode-cache.ts) reads one
// column, which decodes the whole body once. The row records the decode's wall time, the cache's charge for it
// (Arrow buffer bytes, plus the estimate for a column kept as cells), what the heap and array buffers hold after a
// collection with the decode kept, the peak RSS over the RSS just before the decode (when the decode set the peak), and a second read's time from the
// cache. This is Node's V8, not the extension's service worker: the same engine, a different embedder and version.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SIZE = 64_000_000;   // FETCH_TABLE_MAX, src/sw/sw-fetch.ts
const SHAPES = ["mixed", "numeric", "text"];

/** A deterministic generator (mulberry32), so the bytes are the same on every run. */
function rng(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A CSV of about `size` bytes in one of the shapes: header, then rows until the size is reached. */
function csv(shape, size) {
    const r = rng(42);
    const regions = ["north", "south", "east", "west", "central", "north-east", "south-west", "islands"];
    const word = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(r() * 26))).join("");
    const header = shape === "mixed" ? "id,price,qty,region,sku,date,flag,note"
        : shape === "numeric" ? "a,b,c,d,e,f,g,h"
        : "name,city,title,comment";
    const row = (i) => shape === "mixed"
        ? `${i},${(r() * 1000).toFixed(2)},${Math.floor(r() * 50)},${regions[Math.floor(r() * 8)]},SKU-${String(Math.floor(r() * 1e6)).padStart(6, "0")},2026-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")},${r() < 0.5},${r() < 0.8 ? "" : word(12)}`
        : shape === "numeric"
            ? Array.from({ length: 8 }, () => (r() * 1e4).toFixed(3)).join(",")
            : `${word(8)} ${word(10)},${word(9)},${word(6)} ${word(7)} ${word(5)},${word(30)}`;
    const parts = [header];
    let bytes = header.length + 1;
    for (let i = 0; bytes < size; i++) { const line = row(i); parts.push(line); bytes += line.length + 1; }
    return parts.join("\n") + "\n";
}

async function child(shape) {
    const { cachedStoredColumns, decodeCacheStats } = await import("../../src/table/table-decode-cache.ts");
    let text = csv(shape, SIZE);
    const buf = new TextEncoder().encode(text).buffer;
    const first = text.slice(0, text.indexOf(",")).trim();
    text = null;
    globalThis.gc();
    const before = process.memoryUsage();
    const rssBeforeKB = process.resourceUsage().maxRSS;
    const t0 = performance.now();
    const rows = (await cachedStoredColumns("bench", async () => buf, "csv", [first], {})).rowCount;
    const decodeMs = performance.now() - t0;
    const peakKB = process.resourceUsage().maxRSS;
    // One macrotask first: until the async frames of the read have unwound, they still hold its temporaries.
    await new Promise((r) => setTimeout(r, 50));
    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage();
    const t1 = performance.now();
    await cachedStoredColumns("bench", async () => { throw new Error("read the store again"); }, "csv", [first], {});
    const cachedMs = performance.now() - t1;
    const s = decodeCacheStats();
    return {
        shape, csv_bytes: buf.byteLength, rows, decode_ms: Math.round(decodeMs), cached_read_ms: Math.round(cachedMs),
        cache_bytes: s.bytes, kept: s.entries === 1, decodes: s.decodes,
        retained_heap_bytes: after.heapUsed - before.heapUsed, retained_array_buffer_bytes: after.arrayBuffers - before.arrayBuffers,
        rss_before_bytes: before.rss, peak_rss_bytes: peakKB * 1024,
        // null when generating the CSV peaked higher than the decode, so the decode's own peak is not visible.
        peak_rss_over_before_bytes: peakKB > rssBeforeKB ? peakKB * 1024 - before.rss : null,
    };
}

const arg = process.argv.indexOf("--child");
if (arg > 0) {
    process.stdout.write(JSON.stringify(await child(process.argv[arg + 1])));
} else {
    const self = fileURLToPath(import.meta.url);
    const rows = SHAPES.map((shape) => {
        const out = spawnSync(process.execPath, ["--import", "tsx", "--expose-gc", "--max-old-space-size=4096", self, "--child", shape], { encoding: "utf8", maxBuffer: 1 << 20 });
        if (out.status !== 0) return { shape, error: (out.stderr || "").slice(-500) };
        return JSON.parse(out.stdout);
    });
    process.stdout.write(JSON.stringify({ meta: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, size: SIZE, at: new Date().toISOString() }, rows }, null, 1) + "\n");
}
