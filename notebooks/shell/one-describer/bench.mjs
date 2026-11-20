// bench.mjs — compile and instantiate time of each wasm build, and per-call time of both describers over the vectors.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OUT, vectorRows, loadWasm, makeDescriber, wasmDescribe, tsDescribe, WASM } from "./lib.mjs";
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * .95)]; };
const out = {};
for (const o of ["z", "s", "3"]) {
  const bytes = fs.readFileSync(WASM(o)); const comp = [], inst = [], both = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now(); const mod = await WebAssembly.compile(bytes); const t1 = performance.now();
    await WebAssembly.instantiate(mod, {}); const t2 = performance.now();
    comp.push(t1 - t0); inst.push(t2 - t1); both.push(t2 - t0);
  }
  out[o] = { compileMs: med(comp), instantiateMs: med(inst), totalMs: med(both), compileMin: Math.min(...comp), compileMax: Math.max(...comp) };
}
const rows = vectorRows(); const lat = {};
for (const o of ["z", "s", "3"]) {
  const w = await loadWasm(WASM(o)); const t = [];
  for (let pass = 0; pass < 30; pass++) for (const r of rows) { const a = process.hrtime.bigint(); wasmDescribe(w, r.program, r.argv, r.version, r.flavour); const b = process.hrtime.bigint(); if (pass >= 5) t.push(Number(b - a) / 1e3); }
  lat["wasm-" + o] = { medianUs: med(t), p95Us: p95(t), n: t.length };
}
{ const t = []; for (let pass = 0; pass < 30; pass++) for (const r of rows) { const a = process.hrtime.bigint(); tsDescribe(r.program, r.argv, r.version, r.flavour); const b = process.hrtime.bigint(); if (pass >= 5) t.push(Number(b - a) / 1e3); } lat.ts = { medianUs: med(t), p95Us: p95(t), n: t.length }; }
// TS without hardenArgv/effectKey normalisation is not separated; also a raw describeCall-only number:
const { describeCall, manifests } = await import("./lib.mjs");
{ const t = []; for (let pass = 0; pass < 30; pass++) for (const r of rows) { const a = process.hrtime.bigint(); describeCall(r.argv, manifests[r.program], { version: r.version, flavour: r.flavour }); const b = process.hrtime.bigint(); if (pass >= 5) t.push(Number(b - a) / 1e3); } lat["ts-describeCall-only"] = { medianUs: med(t), p95Us: p95(t), n: t.length }; }
const res = { node: process.version, platform: `${process.platform} ${process.arch}`, loadavg: os.loadavg(), instantiate: out, latency: lat };
fs.writeFileSync(path.join(OUT, "bench.json"), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
