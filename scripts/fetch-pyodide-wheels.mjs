// Fetch the numpy + Pillow WASM wheels for the offline `python_exec` sandbox. The npm
// `pyodide` package ships CORE ONLY (no package wheels), so we pull exactly the two we
// bundle from the Pyodide CDN — filenames + version keyed to the INSTALLED pyodide so
// they can't drift. Output dir is gitignored; run `npm run fetch-pyodide` once after
// clone (build.mjs copies these + the core into dist/pyodide/). No runtime network after.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const version = require("pyodide/package.json").version;                 // pins the CDN path
const lock = require("pyodide/pyodide-lock.json");
const pk = lock.packages;
const find = n => pk[n] || pk[Object.keys(pk).find(k => k.toLowerCase() === n.toLowerCase())];

// numpy + Pillow, plus any transitive deps declared in the lock (currently none).
const wheels = new Set(), queue = ["numpy", "pillow"];
while (queue.length) {
    const p = find(queue.pop());
    if (!p || wheels.has(p.file_name)) continue;
    wheels.add(p.file_name);
    for (const d of (p.depends || [])) queue.push(d);
}

const OUT = "pyodide-wheels";
await mkdir(OUT, { recursive: true });
console.log(`Fetching wheels for pyodide v${version} → ${OUT}/`);
for (const w of wheels) {
    const res = await fetch(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${w}`);
    if (!res.ok) throw new Error(`${w}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(`${OUT}/${w}`, buf);
    console.log(`  ${w.padEnd(56)} ${(buf.length / 1e6).toFixed(1)} MB`);
}
console.log("Done. (gitignored; build.mjs copies these + the pyodide core into dist/pyodide/.)");
