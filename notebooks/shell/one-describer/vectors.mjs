// vectors.mjs — every shared vector row through the wasm and TS describers, each also against the recorded answer. usage: vectors.mjs [z|s|3]
import fs from "node:fs";
import path from "node:path";
import { OUT, vectorRows, loadWasm, wasmDescribe, tsDescribe, diffFields, canon, VECTOR_FIELDS, WASM } from "./lib.mjs";
const w = await loadWasm(WASM(process.argv[2] ?? "z"));
const rows = vectorRows(); let n = 0, diffs = [], recW = [], recT = [];
for (const r of rows) {
  n++;
  const a = wasmDescribe(w, r.program, r.argv, r.version, r.flavour);
  const b = tsDescribe(r.program, r.argv, r.version, r.flavour);
  const f = diffFields(a, b);
  if (a.error) f.push("WASM-ERROR");
  if (f.length) diffs.push({ r: { program: r.program, argv: r.argv, flavour: r.flavour, note: r.note }, fields: f, wasm: canon(a), ts: canon(b) });
  const want = canon({ ...r.want });
  for (const [who, d, acc] of [["wasm", a, recW], ["ts", b, recT]]) {
    const cd = canon(d); const bad = VECTOR_FIELDS.filter((k) => JSON.stringify(cd[k]) !== JSON.stringify(want[k]));
    if (bad.length) acc.push({ program: r.program, argv: r.argv, flavour: r.flavour, bad });
  }
}
const summary = { opt: process.argv[2] ?? "z", rows: n, plain: rows.filter(r=>r.kind==="plain").length, flavoured: rows.filter(r=>r.kind==="flavoured").length, wasmVsTsDiffs: diffs.length, wasmVsRecorded: recW.length, tsVsRecorded: recT.length };
fs.writeFileSync(path.join(OUT, `vectors-${summary.opt}.json`), JSON.stringify({ ...summary, diffs, wasmVsRecordedRows: recW, tsVsRecordedRows: recT }, null, 1));
console.log(JSON.stringify(summary, null, 1));
for (const d of diffs) console.log(JSON.stringify(d));
for (const d of recW) console.log("WASM≠recorded", JSON.stringify(d));
for (const d of recT) console.log("TS≠recorded", JSON.stringify(d));
