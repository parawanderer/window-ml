// clean-browser-orphans.test.mjs — the detection spec's browser (tests/e2e/fixtures/detect/clean-browser.mjs) dies with
// the process that launched it, and the dirs a dead run left are swept.
//
// The browser is spawned directly, not by Playwright, so nothing else cleans it up: a runner that was killed used to
// leave Chrome (and its $TMPDIR/wml-detect-* user-data dir) running under launchd for hours. Each test starts a child
// runner that calls launchClean, kills it, and looks for the browser by its --user-data-dir. Self-skips when the
// Playwright Chromium binary is not installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "e2e/fixtures/detect/clean-browser.mjs");
const { chromium } = await import("@playwright/test");
const HAVE_BROWSER = fs.existsSync(chromium.executablePath());

/** Command lines of every process, one per line. */
const psCommands = () => execFileSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 1 << 26 });
/** @param {string} dir */
const browserRunning = (dir) => psCommands().includes(`--user-data-dir=${dir}`);

/** Wait until `fn()` is true, up to `ms`. */
async function until(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return fn();
}

/** Start a runner that launches the clean browser, print its dir, and stay alive. */
async function startRunner() {
    const code = `const { launchClean } = await import(${JSON.stringify(pathToFileURL(FIXTURE).href)});
const b = await launchClean({ extension: false });
const t = await b.open("about:blank");
console.log("READY " + process.env.WML_PROBE);
setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"], cwd: path.resolve(path.dirname(FIXTURE), "../../../..") });
    await new Promise((resolve, reject) => {
        child.stdout.on("data", (c) => { if (String(c).includes("READY")) resolve(undefined); });
        child.on("exit", (c) => reject(new Error(`runner exited early (${c})`)));
        setTimeout(() => reject(new Error("runner never became ready")), 30000);
    });
    // The dir is the newest wml-detect-* one with a live browser.
    const dirs = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("wml-detect-")).map((n) => path.join(os.tmpdir(), n))
        .filter((d) => { try { return fs.statSync(d).isDirectory() && browserRunning(d); } catch { return false; } });
    assert.equal(dirs.length >= 1, true, "the runner's browser is running");
    const owner = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, "wml-owner.json"), "utf8")).runner; } catch { return null; } };
    const dir = dirs.find((d) => owner(d) === child.pid) ?? dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    return { child, dir };
}

// --- a killed runner leaves no browser and no user-data dir ---

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"]) {
    test(`runner killed by ${sig}: the browser and its dir are gone`, { skip: !HAVE_BROWSER && "Playwright Chromium not installed", timeout: 60000 }, async () => {
        const { child, dir } = await startRunner();
        const exited = new Promise((r) => child.on("exit", r));
        child.kill(sig);
        await exited;
        assert.equal(await until(() => !browserRunning(dir)), true, `no browser left for ${dir}`);
        assert.equal(await until(() => !fs.existsSync(dir)), true, `${dir} removed`);
    });
}

// --- stale dirs from earlier crashes are swept, live ones are not ---

test("sweepStaleDetectDirs removes a dir whose owner is dead and spares one whose owner is alive", async () => {
    const { sweepStaleDetectDirs } = await import(pathToFileURL(FIXTURE).href);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wml-sweep-test-"));
    try {
        const mk = (name, owner) => { const d = path.join(tmp, name); fs.mkdirSync(d); if (owner) fs.writeFileSync(path.join(d, "wml-owner.json"), JSON.stringify(owner)); return d; };
        const dead = mk("wml-detect-dead", { runner: 2 ** 22 + 12345, browser: 2 ** 22 + 12346 });
        const live = mk("wml-detect-live", { runner: process.pid, browser: 2 ** 22 + 12346 });
        const fresh = mk("wml-detect-fresh", null);
        const old = mk("wml-detect-old", null);
        fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
        const other = mk("unrelated", { runner: 2 ** 22 + 12345 });
        sweepStaleDetectDirs(tmp);
        assert.equal(fs.existsSync(dead), false, "dead owner swept");
        assert.equal(fs.existsSync(old), false, "old ownerless dir swept");
        assert.equal(fs.existsSync(live), true, "live runner spared");
        assert.equal(fs.existsSync(fresh), true, "a dir still being set up is spared");
        assert.equal(fs.existsSync(other), true, "only wml-detect-* is touched");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
