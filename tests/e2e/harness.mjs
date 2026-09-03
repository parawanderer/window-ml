// harness.mjs — load the UNPACKED extension in a real Chromium and reach its pieces.
//
// This is the heavy, browser-lifecycle layer that jsdom can't represent (full navigations, content-script
// re-injection, the MV3 service worker). Keep E2E rare — only for behaviour that genuinely needs a real
// browser (see CLAUDE.md "End-to-end tests"). Everything else stays in the fast node:test/jsdom suite.
//
// An MV3 extension only loads with a PERSISTENT context + --load-extension (and needs the FULL browser, not
// the headless shell — see launchExtension). `dist/` must be built first (pretest:e2e).

import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");

/**
 * Launch Chromium with the built extension. Returns { context, sw, extensionId, close }.
 *
 * `dist` loads a DIFFERENT build directory than `dist/` — how the bench runs an experimental variant
 * (an esbuild `--define`d build in its own outdir) without the experiment ever becoming a product flag.
 */
export async function launchExtension(/** @type {{ headful?: boolean, dist?: string }} */ { dist, headful } = {}) {
    const DIST = dist ? path.resolve(dist) : DEFAULT_DIST;
    const context = await chromium.launchPersistentContext("", {
        // HEADLESS by default, via `channel: "chromium"`.
        //
        // This used to be headful, on the finding that an MV3 service worker does not register under
        // headless Chromium. That finding was real but narrower than it read: `headless: true` alone runs
        // the headless SHELL, a separate stripped binary with no extension support at all. `channel:
        // "chromium"` runs the FULL browser in --headless=new, where the worker registers fine — measured
        // at ~0.5s, and the whole e2e suite passes. A headful window steals focus and the mouse on every
        // launch, which for a suite that launches one per spec makes the machine unusable while it runs.
        //
        // Headful on request: `headful: true` from a caller that exists to be WATCHED (observe's WATCH,
        // the narrated demos), or E2E_HEADFUL=1 for a one-off look at a test.
        headless: !(headful || process.env.E2E_HEADFUL === "1"),
        channel: "chromium",
        args: [
            `--disable-extensions-except=${DIST}`,
            `--load-extension=${DIST}`,
            "--no-first-run",
            "--no-default-browser-check",
        ],
    });
    // The background service worker registers on load; wait for it if it hasn't appeared yet.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    return { context, sw, extensionId, close: () => context.close() };
}

/** Write the extension's non-secret config (chatUrl / apiFormat / model / debugMode …) via the SW. */
export async function configureExtension(/** @type {any} */ sw, /** @type {Record<string, unknown>} */ config) {
    await sw.evaluate((/** @type {any} */ cfg) => new Promise((r) => chrome.storage.sync.set(cfg, () => r(undefined))), config);
}

/** Resolve when `window.ml` is live in the page's MAIN world (injected.js has fired ml:ready). */
export async function waitForMl(/** @type {any} */ page) {
    // Cast, because this function is SERIALIZED and evaluated in the page: `window.ml` is installed there
    // by injected.js at runtime, and no ambient declaration in this project covers it (the extension's own
    // types describe the API's shape, not its presence on a page's window). A type here would be a claim
    // about another realm either way.
    await page.waitForFunction(() => { const w = /** @type {any} */ (window); return !!(w.ml && w.ml.ready); }, null, { timeout: 15000 });
}
