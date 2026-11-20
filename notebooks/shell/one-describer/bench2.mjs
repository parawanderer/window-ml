// bench2.mjs — where a wasm call's time goes: per program, and with the manifest JSON pre-serialised.
import fs from "node:fs";
import path from "node:path";
import { OUT, vectorRows, loadWasm, manifests, WASM, PROGRAMS, tsDescribe } from "./lib.mjs";
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * .95)]; };
const w = await loadWasm(WASM("s")); const rows = vectorRows();
const ex = w.mod; const inst = await WebAssembly.instantiate(w.mod, {}); const e = inst.exports; const enc = new TextEncoder(), dec = new TextDecoder();
const mjson = Object.fromEntries(PROGRAMS.map((p) => [p, JSON.stringify(manifests[p])]));
function call(r, pre) {
  const body = pre ? `{"manifest":${mjson[r.program]},"argv":${JSON.stringify(r.argv)},"version":${JSON.stringify(r.version ?? null)},"envSet":[],"flavour":${JSON.stringify(r.flavour ?? null)}}`
    : JSON.stringify({ argv: r.argv, manifest: manifests[r.program], version: r.version, envSet: [], flavour: r.flavour });
  const b = enc.encode(body); const p = e.alloc(b.length); new Uint8Array(e.memory.buffer, p, b.length).set(b);
  const o = e.describe(p, b.length); const len = new DataView(e.memory.buffer).getUint32(o, true);
  const s = dec.decode(new Uint8Array(e.memory.buffer, o + 4, len)); e.dealloc(p, b.length); e.dealloc(o, 4 + len); return JSON.parse(s);
}
const res = {};
for (const pre of [false, true]) for (const p of PROGRAMS) {
  const t = []; const rs = rows.filter((r) => r.program === p);
  for (let pass = 0; pass < 30; pass++) for (const r of rs) { const a = process.hrtime.bigint(); call(r, pre); const b = process.hrtime.bigint(); if (pass >= 5) t.push(Number(b - a) / 1e3); }
  (res[p] ??= {})[pre ? "preSerialised" : "stringifyEachCall"] = { medianUs: +med(t).toFixed(1), p95Us: +p95(t).toFixed(1) };
  const tt = []; for (let pass = 0; pass < 30; pass++) for (const r of rs) { const a = process.hrtime.bigint(); tsDescribe(r.program, r.argv, r.version, r.flavour); const b = process.hrtime.bigint(); if (pass >= 5) tt.push(Number(b - a) / 1e3); }
  res[p].ts = { medianUs: +med(tt).toFixed(1), p95Us: +p95(tt).toFixed(1) }; res[p].manifestJsonBytes = mjson[p].length;
}
const byProgram = res;
{ const all = {}; for (const pre of [false, true]) { const t = []; for (let pass = 0; pass < 30; pass++) for (const r of rows) { const a = process.hrtime.bigint(); call(r, pre); const b = process.hrtime.bigint(); if (pass >= 5) t.push(Number(b - a) / 1e3); } all[pre ? "pre" : "each"] = { med: +med(t).toFixed(1), p95: +p95(t).toFixed(1) }; } fs.writeFileSync(path.join(OUT, "bench-by-program.json"), JSON.stringify({ byProgram, all }, null, 1)); console.log(JSON.stringify({ byProgram, all }, null, 1)); }
