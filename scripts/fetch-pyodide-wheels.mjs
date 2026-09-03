// Fetch the numpy + Pillow WASM wheels for the offline `python_exec` sandbox. The npm
// `pyodide` package ships CORE ONLY (no package wheels), so we pull exactly the two we
// bundle from the Pyodide CDN — filenames + version keyed to the INSTALLED pyodide so
// they can't drift. Output dir is gitignored; run `npm run fetch-pyodide` once after
// clone (build.mjs copies these + the core into dist/pyodide/). No runtime network after.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const version = require("pyodide/package.json").version;                 // pins the CDN path
const lock = require("pyodide/pyodide-lock.json");
const pk = lock.packages;
const find = n => pk[n] || pk[Object.keys(pk).find(k => k.toLowerCase() === n.toLowerCase())];

// The top-level packages are the single source of truth in python-env.ts (PY_PACKAGES) —
// grep the `load:` values so this can't drift from what the sandbox actually loads. Their
// transitive deps are resolved from the lock below.
const envSrc = await readFile(new URL("../src/python-env.ts", import.meta.url), "utf8");
const seed = [...envSrc.matchAll(/load:\s*"([^"]+)"/g)].map(m => m[1]);
if (!seed.length) throw new Error("no `load:` packages found in python-env.ts");

const wheels = new Set(), queue = [...seed];
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
