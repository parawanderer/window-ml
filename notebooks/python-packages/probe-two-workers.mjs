// probe-two-workers.mjs — slice 4's condition (docs/plan/repl/PACKAGES_INSTALL.md, the RULED block of 2026-11-13): can a
// run's live readonly worker and an install's candidate run at once in a real browser? For each load, a fresh headless
// Chromium with the built extension: a live readonly worker boots and holds <load> MB in its run namespace, a candidate
// readonly worker boots beside it, then both are asked a cell. Reports which answered, what died and how, and the
// browser's memory (RSS) after each step. Nothing is fetched: the workers load the extension's own dist/pyodide.
//
//   node notebooks/python-packages/probe-two-workers.mjs [dist] [loads MB, comma-separated]

import path from "node:path";
import { execFileSync } from "node:child_process";
import { launchExtension } from "../../tests/e2e/harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.resolve(process.argv[2] ?? path.join(ROOT, "dist"));
const LOADS = (process.argv[3] ?? "0,1024,2048,3072").split(",").map(Number);

/** RSS of this probe's browser, in MB: every process launched from Playwright's Chromium, and the largest of them. */
function browserRss() {
    const rows = execFileSync("ps", ["-A", "-o", "rss=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes("ms-playwright") && !l.includes("node "));
    const kb = rows.map((l) => Number(l.trim().split(/\s+/)[0]) || 0);
    return { total: Math.round(kb.reduce((a, b) => a + b, 0) / 1024), largest: Math.round(Math.max(0, ...kb) / 1024) };
}

/** Installed in the extension page: spawn a python worker, and run one cell on it; a worker that dies answers `died`.
 *  A cell's answer is the message with `ok`: the worker posts `{ id, started }` first. */
function pageHelpers() {
    const workers = [];
    let next = 1;
    globalThis.__spawn = (name) => {
        const w = new Worker("python-worker.js", { name });
        const entry = { w, dead: null, waiting: new Map() };
        w.addEventListener("error", (e) => { entry.dead = `error: ${e.message || "no message"}`; for (const r of entry.waiting.values()) r({ died: entry.dead }); entry.waiting.clear(); });
        w.addEventListener("message", (e) => { const r = entry.waiting.get(e.data?.id); if (r && "ok" in e.data) { entry.waiting.delete(e.data.id); r(e.data); } });
        workers.push(entry);
        return workers.length - 1;
    };
    globalThis.__cell = (i, code, run, ms) => new Promise((resolve) => {
        const entry = workers[i];
        if (entry.dead) return resolve({ died: entry.dead });
        const id = next++;
        const t0 = performance.now();
        const timer = setTimeout(() => { entry.waiting.delete(id); resolve({ timeout: ms }); }, ms);
        entry.waiting.set(id, (r) => { clearTimeout(timer); resolve({ ...r, ms: Math.round(performance.now() - t0) }); });
        entry.w.postMessage({ id, code, image: null, hardened: true, tables: null, run });
    });
}

/** What a cell's answer says, in one line. */
const said = (r) => process.env.RAW ? JSON.stringify(r).slice(0, 400) : r.died ? `DIED (${r.died})` : r.timeout ? `no answer in ${r.timeout} ms` : r.ok ? `ok ${String(r.value ?? "").slice(0, 60)} in ${r.ms} ms` : `error ${String(r.error ?? "").split("\n").filter(Boolean).pop()?.slice(0, 160)}`;

for (const load of LOADS) {
    const ext = await launchExtension({ dist: DIST });
    try {
        const page = await ext.context.newPage();
        await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);
        await page.evaluate(pageHelpers);
        console.log(`\n== live worker holding ${load} MB`);
        console.log("  start:", JSON.stringify(browserRss()));
        await page.evaluate(() => globalThis.__spawn("readonly"));
        console.log("  live boot:", said(await page.evaluate(() => globalThis.__cell(0, "1", "live", 120000))), JSON.stringify(browserRss()));
        // In 512 MB arrays (on wasm32 numpy refuses one array of 2 GB or more) of random floats, which the OS cannot
        // compress out of the RSS figure as it does an array of ones.
        const hold = `import numpy as np\n_hold = [np.random.default_rng(m).random(m * 2**17) for m in [512] * (${load} // 512) + ([${load} % 512] if ${load} % 512 else [])]\nsum(a.nbytes for a in _hold) // 2**20`;
        console.log(`  live holds ${load} MB:`, said(await page.evaluate((c) => globalThis.__cell(0, c, "live", 120000), hold)), JSON.stringify(browserRss()));
        await page.evaluate(() => globalThis.__spawn("readonly"));
        console.log("  candidate boot beside it:", said(await page.evaluate(() => globalThis.__cell(1, "import numpy\n1", "candidate", 120000))), JSON.stringify(browserRss()));
        console.log("  live still answers:", said(await page.evaluate(() => globalThis.__cell(0, "sum(a.nbytes for a in _hold) // 2**20", "live", 60000))));
        console.log("  candidate allocates 512 MB:", said(await page.evaluate(() => globalThis.__cell(1, "import numpy as np\n_c = np.random.default_rng(1).random(512 * 2**17)\n_c.nbytes // 2**20", "candidate", 60000))), JSON.stringify(browserRss()));
        console.log("  live still answers:", said(await page.evaluate(() => globalThis.__cell(0, "sum(a.nbytes for a in _hold) // 2**20", "live", 60000))));
    } catch (e) {
        console.log("  probe stopped:", String(e?.message ?? e).split("\n")[0]);
    } finally {
        await ext.close();
    }
}
