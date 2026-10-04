#!/usr/bin/env node
// check-dist-fresh.mjs — REFUSE TO RUN A BROWSER TEST AGAINST A BUNDLE OLDER THAN ITS SOURCE.
//
// Every Playwright spec hands a BUILT directory to a real browser, so a source edit without a rebuild is invisible:
// the suite runs the previous bundle and passes or fails for the wrong reason. There is nothing to notice — the test
// output looks exactly like a real result, which is what makes it expensive. It has cost this repo whole debugging
// sessions, and AGENTS.md carried it as a trap to remember rather than something checked.
//
// It REPORTS rather than rebuilds, deliberately. A rebuild here would clobber `dist/` while it is loaded in a window
// someone is using — which is the hazard `E2E_DIST` exists to avoid — and would do it from inside a test runner,
// where nobody is watching for it. So this says which directory is behind and the one command that fixes it.
//
//   node scripts/check-dist-fresh.mjs            # exit 1 and say so when anything is stale
//   node scripts/check-dist-fresh.mjs --quiet    # say nothing when everything is fresh
//
// It also runs as the Playwright suite's `globalSetup` (playwright.config.mjs), which is the one place every spec
// passes through. `E2E_DIST` skips it (that bundle was built elsewhere on purpose) and `E2E_STALE_OK=1` overrides it.

import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** What the bundles are built FROM. A change to any of it dates every one of them. */
const SOURCES = ["src", "manifest.json", "build.mjs", "scripts/build-web.mjs"];

/** Stamped BY a build rather than read by one, so their mtime says nothing about whether a bundle is current.
 *  `build-info.gen.ts` carries a `buildTime` and the working tree's dirty file list, so it differs on every single
 *  run and after every commit — counting it would make this fire constantly, which is how a check stops being read. */
const NOT_SOURCES = new Set(["build-info.gen.ts", "build-diff.gen.ts"]);

/** Each built directory a spec may hand to a browser, and the command that rebuilds it. `dist-app` and `dist-native`
 *  are left out on purpose: both build commands write them, so whichever you ran, they are current. */
const BUNDLES = [
    { dir: "dist", cmd: "node build.mjs", what: "the extension" },
    { dir: "dist-web", cmd: "node scripts/build-web.mjs", what: "the chat page's web build" },
];

/** The newest mtime anywhere under `p`, in ms. A missing path is 0, so it can never make something look fresh. */
function newest(p) {
    const full = path.join(ROOT, p);
    if (!existsSync(full)) return 0;
    const st = statSync(full);
    if (!st.isDirectory()) return st.mtimeMs;
    let max = 0;
    for (const e of readdirSync(full, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".") || NOT_SOURCES.has(e.name)) continue;
        max = Math.max(max, newest(path.join(p, e.name)));
    }
    return max;
}

/** Which bundles are older than the source they were built from, with the command that would fix each. */
export function staleBundles() {
    const src = Math.max(...SOURCES.map(newest));
    return BUNDLES.flatMap((b) => {
        const built = newest(b.dir);
        if (built === 0) return [{ ...b, reason: "has never been built" }];
        // A whole second of slack: a build writes its files over a short span, and a source touched within the same
        // tick as the write is not a real edit. Anything genuinely newer is a real one.
        if (src > built + 1000) return [{ ...b, reason: `is older than src/ (built ${ago(built)}, source changed ${ago(src)})` }];
        return [];
    });
}

/** "3m ago" — enough to see at a glance which side is behind, without a date library. */
function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

/** The message, or null when everything is current. Separate from printing it, so `globalSetup` can throw it. */
export function stalenessReport() {
    if (process.env.E2E_DIST || process.env.E2E_STALE_OK) return null;
    const stale = staleBundles();
    if (!stale.length) return null;
    const lines = stale.map((b) => `  ${b.dir}/ (${b.what}) ${b.reason}\n    fix: ${b.cmd}`);
    return [
        "A browser test would run against a STALE BUNDLE, so its result would describe the previous build.",
        ...lines,
        "",
        "Run the command(s) above, then the tests again. E2E_STALE_OK=1 skips this check; E2E_DIST=<dir> skips it too,",
        "since that bundle is built elsewhere on purpose.",
    ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const report = stalenessReport();
    if (report) { console.error(report); process.exit(1); }
    if (!process.argv.includes("--quiet")) console.log("dist-fresh: every bundle is newer than the source it was built from.");
}
