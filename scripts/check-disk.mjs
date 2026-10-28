#!/usr/bin/env node
// check-disk.mjs — WHEN THE DISK IS NEARLY FULL, SAY SO, AND SAY WHAT TO CLEAR. Run by the pre-commit hook, where it
// prints NOTHING unless free space is below the threshold, and never fails a commit. Working on this repo fills a disk
// in ways that are easy to forget: Playwright traces, several clones each with their own node_modules, Gradle and the
// Android emulator, Xcode's simulators and DerivedData, Python venvs, in-tree CPython builds and the Pyodide core's
// build. A full disk shows up as something else entirely (a build that dies half-written, an emulator that will not
// boot, a test timing out), so the warning comes before that.
//
//   node scripts/check-disk.mjs              # silent unless low (the hook's form)
//   node scripts/check-disk.mjs --report     # always: free space, and every candidate with its size
//   WML_DISK_WARN_GB=40 node scripts/check-disk.mjs   # the threshold, in GB (default 20)
//
// It never deletes anything. Each candidate comes with the command that clears it, and a note where clearing it has a
// cost (a re-download, a slower next build). Free space is read with `statfs`, which Node offers on macOS, Linux and
// Windows alike; folder sizes use `du` where it exists and are left out where it does not.

import { existsSync, readdirSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOME = os.homedir();
const MAIN = path.join(HOME, "git", "window-ml"); // where tools/build-pyodide-restricted.mjs keeps its work dir, from any clone
const WARN_GB = Number(process.env.WML_DISK_WARN_GB) || 20;
const report = process.argv.includes("--report");

/** Free bytes on the volume holding `dir`, or null where the platform cannot say. */
function freeBytes(dir) {
    try { const s = statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
const free = freeBytes(ROOT);
if (free == null) process.exit(0);
if (free >= WARN_GB * 1e9 && !report) process.exit(0);

/** A folder's size in bytes, by `du` (bounded to a few seconds), or null where it cannot be measured. */
function sizeOf(dir) {
    const r = spawnSync("du", ["-sk", dir], { encoding: "utf8", timeout: 8000 });
    const kb = r.status === 0 ? Number(r.stdout.split(/\s/)[0]) : NaN;
    return Number.isFinite(kb) ? kb * 1024 : null;
}

/** The sibling clones of this repo (`../window-ml*`), which each carry their own build output and test results. */
function clones() {
    const parent = path.dirname(ROOT);
    try {
        return readdirSync(parent, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name.startsWith("window-ml") && existsSync(path.join(parent, e.name, "package.json")))
            .map((e) => path.join(parent, e.name));
    } catch { return [ROOT]; }
}

/** Bytes of a git checkout's ignored files (`git clean -ndX`), which is its build output, or null where git cannot say. */
function ignoredBytes(dir) {
    const r = spawnSync("git", ["-C", dir, "clean", "-ndX"], { encoding: "utf8", timeout: 8000 });
    if (r.status !== 0) return null;
    const paths = r.stdout.split("\n").map((l) => l.replace(/^Would remove /, "")).filter(Boolean).map((p) => path.join(dir, p));
    if (!paths.length) return 0;
    const du = spawnSync("du", ["-sk", ...paths], { encoding: "utf8", timeout: 8000 });
    if (du.status !== 0 && !du.stdout) return null;
    return du.stdout.split("\n").reduce((n, l) => n + (Number(l.split(/\s/)[0]) || 0), 0) * 1024;
}

/** The sibling CPython checkouts (`../cpython*`: the restricted-mode fork and its experiments), each built in-tree. */
function cpythonBuilds() {
    const parent = path.dirname(ROOT);
    try {
        return readdirSync(parent, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name.startsWith("cpython") && existsSync(path.join(parent, e.name, "Makefile.pre.in")))
            .map((e) => {
                const dir = path.join(parent, e.name);
                return { dir, measure: () => ignoredBytes(dir), what: `${e.name}: the in-tree CPython build (objects, python.exe, its build/)`, clear: `make -C ${dir} clean`, cost: "the next build of that checkout is a full one (minutes); only for one no session is building in" };
            });
    } catch { return []; }
}

/**
 * Everything worth clearing: where it is, what it is, how to clear it, and what clearing costs. Paths that do not exist
 * on this machine are dropped, so a Linux box never hears about Xcode.
 */
function candidates() {
    const out = [];
    for (const c of clones()) {
        const name = path.basename(c);
        out.push(
            { dir: path.join(c, "test-results"), what: `${name}: Playwright output (traces, screenshots of failures)`, clear: `rm -rf ${path.join(c, "test-results")}` },
            { dir: path.join(c, "playwright-report"), what: `${name}: the Playwright HTML report`, clear: `rm -rf ${path.join(c, "playwright-report")}` },
            { dir: path.join(c, "coverage"), what: `${name}: coverage output`, clear: `rm -rf ${path.join(c, "coverage")}` },
            { dir: path.join(c, "android", "app", "build"), what: `${name}: the Android build`, clear: `rm -rf ${path.join(c, "android", "app", "build")}`, cost: "the next APK build is a full one" },
            { dir: path.join(c, "node_modules"), what: `${name}: node_modules`, clear: `rm -rf ${path.join(c, "node_modules")}`, cost: "`npm ci` before that clone works again; only for a clone you are not using" },
            { dir: path.join(c, "mobile", "ios", "build"), what: `${name}: the phone app's iOS build`, clear: `rm -rf ${path.join(c, "mobile", "ios", "build")}`, cost: "the next iOS build is a full one (many minutes)" },
            { dir: path.join(c, "mobile", "android", "app", "build"), what: `${name}: the phone app's Android build`, clear: `rm -rf ${path.join(c, "mobile", "android", "app", "build")}`, cost: "the next APK build is a full one" },
            { dir: path.join(c, "mobile", "node_modules"), what: `${name}: the phone app's node_modules`, clear: `rm -rf ${path.join(c, "mobile", "node_modules")}`, cost: "`npm ci` in mobile/ before the app builds again" },
            { dir: path.join(c, ".venv"), what: `${name}: the notebooks' Python venv`, clear: `rm -rf ${path.join(c, ".venv")}`, cost: "`node scripts/nb.mjs setup` before that clone runs a notebook again" },
            c === MAIN
                ? { dir: path.join(c, "tmp", "pyodide-build"), what: "the SHARED Pyodide core build (emsdk + Pyodide + CPython), kept in main so it outlives a clone", clear: `rm -rf ${path.join(c, "tmp", "pyodide-build")}`, cost: "the next core build (tools/build-pyodide-restricted.mjs) takes hours, not a CPython rebuild; keep it unless the disk is truly short" }
                : { dir: path.join(c, "tmp", "pyodide-build"), what: `${name}: a Pyodide core build left in a clone (the work dir is main's tmp/)`, clear: `rm -rf ${path.join(c, "tmp", "pyodide-build")}`, cost: `none once its tarball is released; if ${path.join(MAIN, "tmp", "pyodide-build")} does not exist, move it there instead` },
        );
    }
    const lib = path.join(HOME, "Library");
    out.push(
        { dir: path.join(HOME, ".gradle", "caches"), what: "Gradle's download and build cache", clear: `rm -rf ${path.join(HOME, ".gradle", "caches")}`, cost: "the next Android build downloads again" },
        { dir: path.join(HOME, ".npm", "_cacache"), what: "npm's download cache", clear: "npm cache clean --force", cost: "the next install downloads again" },
        { dir: path.join(HOME, ".cache", "uv"), what: "uv's download and wheel cache (the notebooks' venvs)", clear: "uv cache clean", cost: "the next `nb.mjs setup` downloads again" },
        { dir: path.join(lib, "Caches", "uv"), what: "uv's download and wheel cache (the notebooks' venvs)", clear: "uv cache clean", cost: "the next `nb.mjs setup` downloads again" },
        { dir: path.join(HOME, ".cache", "pip"), what: "pip's download cache", clear: "pip cache purge" },
        { dir: path.join(lib, "Caches", "pip"), what: "pip's download cache", clear: "pip cache purge" },
        ...cpythonBuilds(),
        { dir: path.join(lib, "Caches", "ms-playwright"), what: "Playwright's browsers (old versions pile up)", clear: "npx playwright uninstall && npx playwright install chromium", cost: "re-downloads the one browser the suite uses" },
        { dir: path.join(HOME, ".cache", "ms-playwright"), what: "Playwright's browsers (old versions pile up)", clear: "npx playwright uninstall && npx playwright install chromium", cost: "re-downloads the one browser the suite uses" },
        { dir: path.join(process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools", "system-images"), what: "Android system images (one per API level and ABI)", clear: "sdkmanager --list_installed, then sdkmanager --uninstall <image> for any the emulator does not use", cost: "re-downloaded by `node scripts/android.mjs setup` if it was the one in use" },
        { dir: path.join(HOME, ".android", "avd"), what: "Android emulators and their disk images", clear: "node scripts/android.mjs stop, then delete unused ones: avdmanager list avd / avdmanager delete avd -n <name>", cost: "`node scripts/android.mjs setup` recreates wml-phone" },
        { dir: path.join(lib, "Developer", "Xcode", "DerivedData"), what: "Xcode's build products", clear: `rm -rf ${path.join(lib, "Developer", "Xcode", "DerivedData")}`, cost: "the next iOS build is a full one" },
        { dir: path.join(lib, "Developer", "CoreSimulator"), what: "iOS simulators and their runtimes", clear: "xcrun simctl delete unavailable", cost: "none for unavailable ones; old runtimes: xcrun simctl runtime list" },
        { dir: path.join(lib, "Developer", "Xcode", "iOS DeviceSupport"), what: "debug symbols for every iPhone ever plugged in", clear: `rm -rf "${path.join(lib, "Developer", "Xcode", "iOS DeviceSupport")}"`, cost: "rebuilt the next time a device is plugged in" },
        { dir: path.join(HOME, ".maestro", "tests"), what: "Maestro's per-run logs and screenshots", clear: `rm -rf ${path.join(HOME, ".maestro", "tests")}` },
    );
    return out.filter((c) => existsSync(c.dir));
}

const found = candidates().map((c) => ({ ...c, size: c.measure ? c.measure() : sizeOf(c.dir) }))
    .filter((c) => report || c.size == null || c.size >= 200e6)
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

const head = free < WARN_GB * 1e9
    ? `⚠ disk: ${gb(free)} free, under the ${WARN_GB} GB this check warns at. A full disk fails builds, the emulator and tests in ways that do not say "disk".`
    : `disk: ${gb(free)} free (warns under ${WARN_GB} GB).`;
console.error(head);
if (!found.length) { console.error("  nothing this repo's tooling put on the disk is large enough to be worth clearing."); process.exit(0); }
console.error("  What this work leaves on the disk, largest first (nothing is deleted for you):");
for (const c of found) {
    console.error(`  ${c.size == null ? "   ?    " : gb(c.size).padStart(8)}  ${c.what}`);
    console.error(`            ${c.clear}${c.cost ? `   (cost: ${c.cost})` : ""}`);
}
process.exit(0);
