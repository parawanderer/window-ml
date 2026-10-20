// Fetch what the offline `python_exec` sandbox needs besides the npm devDep: (1) the Pyodide CORE built from the
// restricted-mode CPython fork (tools/build-pyodide-restricted.mjs) into pyodide-core/, and (2) the WASM wheels.
// The npm `pyodide` package ships CORE ONLY (no package wheels), so the wheels come from the Pyodide CDN. The
// version of both is tools/pyodide-dist.json's `pyodide`, the one place it is pinned; the wheels are stock because
// the fork changes no ABI. `--core <tarball>` installs a locally built tarball instead of downloading
// `artefact.url`. An artefact with no sha256 yet is skipped (build.mjs then falls back to the stock npm core). Output dir is gitignored; run `npm run fetch-pyodide` once after
// clone (build.mjs copies these + the core into dist/pyodide/). No runtime network after.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const dist = JSON.parse(await readFile(new URL("../tools/pyodide-dist.json", import.meta.url), "utf8"));
const version = dist.pyodide;                                           // pins the CDN path and the core
const stock = require("pyodide/package.json").version;
if (stock !== version) console.warn(`⚠ npm pyodide is ${stock} but tools/pyodide-dist.json pins ${version} — the stock-core fallback and the lock come from ${stock}.`);
const lock = require("pyodide/pyodide-lock.json");
const pk = lock.packages;
const find = n => pk[n] || pk[Object.keys(pk).find(k => k.toLowerCase() === n.toLowerCase())];

// The top-level packages are the single source of truth in python-env.ts (PY_PACKAGES) —
// grep the `load:` values so this can't drift from what the sandbox actually loads. Their
// transitive deps are resolved from the lock below.
const envSrc = await readFile(new URL("../src/python/python-env.ts", import.meta.url), "utf8");
const seed = [...envSrc.matchAll(/load:\s*"([^"]+)"/g)].map(m => m[1]);
if (!seed.length) throw new Error("no `load:` packages found in python-env.ts");

const wheels = new Set(), queue = [...seed];
while (queue.length) {
    const p = find(queue.pop());
    if (!p || wheels.has(p.file_name)) continue;
    wheels.add(p.file_name);
    for (const d of (p.depends || [])) queue.push(d);
}

// --- the core, built from the fork ---
const CORE_OUT = "pyodide-core";
const coreArg = process.argv.indexOf("--core");
const art = dist.artefact;
if (coreArg > 0 || art.sha256) {
    const buf = coreArg > 0 ? await readFile(process.argv[coreArg + 1]) : Buffer.from(await (async () => {
        const r = await fetch(art.url);
        if (!r.ok) throw new Error(`${art.url}: HTTP ${r.status}`);
        return r.arrayBuffer();
    })());
    const sha = createHash("sha256").update(buf).digest("hex");
    if (art.sha256 && sha !== art.sha256) throw new Error(`core tarball sha256 ${sha} ≠ pinned ${art.sha256}`);
    await rm(CORE_OUT, { recursive: true, force: true });
    await mkdir(CORE_OUT, { recursive: true });
    await writeFile(`${CORE_OUT}/.tarball.tgz`, buf);
    execFileSync("tar", ["-xzf", `${CORE_OUT}/.tarball.tgz`, "-C", CORE_OUT]);
    await rm(`${CORE_OUT}/.tarball.tgz`);
    await writeFile(`${CORE_OUT}/.pin`, `${art.name} ${sha}\n`);
    console.log(`Core ${art.name} (${(buf.length / 1e6).toFixed(1)} MB, sha256 ${sha.slice(0, 12)}…) → ${CORE_OUT}/`);
} else {
    console.warn(`⚠ no artefact.sha256 in tools/pyodide-dist.json yet — skipping the restricted core; build.mjs uses the stock npm core.`);
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
