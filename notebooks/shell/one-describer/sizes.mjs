// sizes.mjs — raw, gzip -9 and brotli q11 bytes of each wasm build and of the TS describer bundled with esbuild.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { DIR, OUT, TS, WASM } from "./lib.mjs";
const measure = (b) => ({ raw: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length, brotli: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
const out = {};
for (const o of ["z", "s", "3"]) out[`wasm-${o}`] = measure(fs.readFileSync(WASM(o)));
const entry = path.join(DIR, "build", "entry.ts"), bundle = path.join(DIR, "build", "ts-describer.min.js");
fs.writeFileSync(entry, `export { describeCall } from ${JSON.stringify(path.join(TS, "src/shell/program-manifest.ts"))};\n`);
execFileSync(path.join(TS, "node_modules/.bin/esbuild"), [entry, "--bundle", "--minify", "--format=esm", `--outfile=${bundle}`], { stdio: "ignore" });
out["ts-describeCall"] = measure(fs.readFileSync(bundle));
fs.writeFileSync(path.join(OUT, "sizes.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
