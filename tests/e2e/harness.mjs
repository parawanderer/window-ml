// harness.mjs — load the UNPACKED extension in a real Chromium and reach its pieces.
//
// This is the heavy, browser-lifecycle layer that jsdom can't represent (full navigations, content-script
// re-injection, the MV3 service worker). Keep E2E rare — only for behaviour that genuinely needs a real
// browser (see CLAUDE.md "End-to-end tests"). Everything else stays in the fast node:test/jsdom suite.
//
// An MV3 extension only loads with a PERSISTENT context + --load-extension (and needs a headful or
// new-headless Chromium — the CI job runs it under xvfb). `dist/` must be built first (pretest:e2e).

import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");

/** Launch Chromium with the built extension. Returns { context, sw, extensionId, close }. */
export async function launchExtension() {
    const context = await chromium.launchPersistentContext("", {
        // Headful by default — an MV3 extension's service worker does NOT register under headless Chromium
        // (verified). CI runs this under xvfb; locally it opens a real window. Opt into headless (e.g. to
        // check the failure) with E2E_HEADLESS=1.
        headless: process.env.E2E_HEADLESS === "1",
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
export async function configureExtension(sw, config) {
    await sw.evaluate((cfg) => new Promise((r) => chrome.storage.sync.set(cfg, r)), config);
}

/** Resolve when `window.ml` is live in the page's MAIN world (injected.js has fired ml:ready). */
export async function waitForMl(page) {
    await page.waitForFunction(() => !!(window.ml && window.ml.ready), null, { timeout: 15000 });
}
