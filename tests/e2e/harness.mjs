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

/**
 * OPEN THE SIDEBAR AND THE RUN INSIDE IT, and return the sidebar frame.
 *
 * The panel opens on the SESSIONS LIST, not on the run — so a demo or probe that slides the sidebar open and
 * then queries the transcript finds nothing, reads zero of everything, and reports that the feature does not
 * work. That is a mistake every demo here has made at least once, which is why it lives in the harness rather
 * than being written out again each time.
 *
 * @param {any} page      the page the run was started on
 * @param {object} [opts]
 * @param {number} [opts.width]  sidebar width in px (default: 55% of the viewport)
 * @param {string|RegExp} [opts.task]  pick the session by its task text (default: the first one)
 * @param {number} [opts.timeout]
 * @returns {Promise<any>} the sidebar iframe, showing the run's detail view
 */
export async function openRunInSidebar(page, { width, task, timeout = 20000 } = {}) {
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    await page.waitForFunction(
        () => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"),
        null, { timeout });
    await page.evaluate((/** @type {number|undefined} */ w) => {
        const root = /** @type {any} */ (document.getElementById("ml-sb-root")).shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = `${w || Math.round(window.innerWidth * 0.55)}px`;
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    }, width);
    const frame = await (async () => {
        for (let i = 0; i < Math.ceil(timeout / 100); i++) {
            const f = page.frames().find((/** @type {any} */ fr) => /sidebar\.html/.test(fr.url()));
            if (f) return f;
            await sleep(100);
        }
        throw new Error("the sidebar iframe never appeared");
    })();
    // THE CLICK that everyone forgets. A row appears as soon as the run starts, so this does not wait for the
    // run to finish — which is the point, since the interesting demos are about what happens while it runs.
    const rows = task ? frame.locator(".row", { hasText: task }) : frame.locator(".row");
    for (let i = 0; i < Math.ceil(timeout / 200); i++) {
        if (await rows.count()) break;
        await sleep(200);
    }
    if (!(await rows.count())) throw new Error(`no session row to open${task ? ` matching ${task}` : ""}`);
    await rows.first().click();
    // The detail view exists once it is showing the run's own content rather than the list.
    for (let i = 0; i < Math.ceil(timeout / 200); i++) {
        if (await frame.locator(".astep, .msg, .aturn-prose").count()) return frame;
        await sleep(200);
    }
    throw new Error("clicked the session row but the detail view never rendered");
}
